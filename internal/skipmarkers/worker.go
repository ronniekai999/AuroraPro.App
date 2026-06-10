package skipmarkers

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// Detector versions the analysis algorithm. Bumping it makes every
// skip_marker_analysis ledger row stale, so the next sweep reprocesses
// the whole library with the new algorithm — the same reprocess-on-
// upgrade pattern as embedding.CurrentVersion. 'manual' rows (admin
// corrections) are never touched by reprocessing.
//
// Version history:
//   - xcorr-v1: Haitsma–Kalker spectral hash + cross-correlation
//     intro/recap detection; blackdetect/silencedetect credits onset.
const Detector = "xcorr-v1"

const (
	// Periodic sweep cadence. Sweeps are also triggered by scan
	// completion, so this only catches stragglers (e.g. files that
	// failed transiently, or a box whose scans never run).
	sweepInterval = 6 * time.Hour

	// Batch sizes per fetch round. Small enough that a cancel or
	// restart loses little work; the loop refetches until drained.
	seasonBatch = 4
	movieBatch  = 32

	// Pause between consecutive FFmpeg invocations so a multi-hundred-
	// episode backlog trickles instead of monopolizing I/O.
	filePacing = 250 * time.Millisecond
)

// settingKey disables the subsystem when the server setting is the
// string "false" (admin-settable via PUT /api/admin/settings; default
// enabled, matching filesystem_watch_enabled's convention).
const settingKey = "skip_markers_enabled"

// Status is a point-in-time snapshot of the worker for the admin
// status endpoint.
type Status struct {
	Running       bool      `json:"running"`
	LastSweepAt   time.Time `json:"last_sweep_at,omitzero"`
	LastError     string    `json:"last_error,omitempty"`
	SweepAnalyzed int64     `json:"sweep_analyzed"` // files processed by the current/last sweep
}

// Worker owns the background analysis loop. Construct with NewWorker,
// start with Run (one goroutine), nudge with TriggerSweep.
type Worker struct {
	q       *db.Queries
	trigger chan struct{}

	mu     sync.Mutex
	status Status
}

func NewWorker(q *db.Queries) *Worker {
	return &Worker{
		q:       q,
		trigger: make(chan struct{}, 1),
	}
}

// TriggerSweep nudges the worker to sweep soon. Non-blocking and
// coalescing: triggers during a running sweep queue at most one
// follow-up. Safe from any goroutine.
func (w *Worker) TriggerSweep() {
	select {
	case w.trigger <- struct{}{}:
	default:
	}
}

// Status returns a snapshot for the admin endpoint.
func (w *Worker) Status() Status {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.status
}

// Run is the worker loop: sweep, then wait for a trigger or the
// periodic tick. Returns when ctx is cancelled (server shutdown).
func (w *Worker) Run(ctx context.Context) {
	for {
		w.sweep(ctx)
		select {
		case <-ctx.Done():
			return
		case <-w.trigger:
		case <-time.After(sweepInterval):
		}
	}
}

// Enabled reports whether the subsystem can run right now: FFmpeg on
// PATH and the skip_markers_enabled server setting not "false". Also
// used by the admin status endpoint.
func (w *Worker) Enabled(ctx context.Context) bool {
	if !ffmpegAvailable() {
		return false
	}
	if v, err := w.q.GetSetting(ctx, settingKey); err == nil && v == "false" {
		return false
	}
	return true
}

// sweep drains the pending backlog: TV seasons first (intro/recap +
// credits), then movie files (credits only). Strictly sequential —
// one FFmpeg at a time, niced, paced.
func (w *Worker) sweep(ctx context.Context) {
	if ctx.Err() != nil || !w.Enabled(ctx) {
		return
	}
	w.mu.Lock()
	w.status.Running = true
	w.status.SweepAnalyzed = 0
	w.status.LastError = ""
	w.mu.Unlock()

	start := time.Now()
	var analyzed int64
	defer func() {
		w.mu.Lock()
		w.status.Running = false
		w.status.LastSweepAt = time.Now()
		w.mu.Unlock()
		if analyzed > 0 {
			slog.Info("skip-marker sweep complete",
				"files", analyzed, "elapsed", time.Since(start).Round(time.Second))
		}
	}()

	// Seasons. Cursor-paged in ascending season-ID order so a season
	// whose files persistently fail to ledger (recurring DB error,
	// undecodable media) can't pin the fetch window and starve the
	// rest of the backlog; failures are retried on the NEXT sweep,
	// when the cursor restarts from zero.
	var seasonCursor int64
	for ctx.Err() == nil {
		ids, err := w.q.FetchPendingSkipSeasons(ctx, Detector, seasonCursor, seasonBatch)
		if err != nil {
			w.setErr("fetch pending seasons: " + err.Error())
			return
		}
		if len(ids) == 0 {
			break
		}
		for _, seasonID := range ids {
			if ctx.Err() != nil {
				return
			}
			if seasonID > seasonCursor {
				seasonCursor = seasonID
			}
			analyzed += w.analyzeSeason(ctx, seasonID)
			w.mu.Lock()
			w.status.SweepAnalyzed = analyzed
			w.mu.Unlock()
		}
	}

	// Movies (credits only). Same cursor pattern.
	var movieCursor int64
	for ctx.Err() == nil {
		files, err := w.q.FetchPendingSkipMovieFiles(ctx, Detector, movieCursor, movieBatch)
		if err != nil {
			w.setErr("fetch pending movies: " + err.Error())
			return
		}
		if len(files) == 0 {
			break
		}
		for _, f := range files {
			if ctx.Err() != nil {
				return
			}
			if f.FileID > movieCursor {
				movieCursor = f.FileID
			}

			var markers []models.SkipMarker
			m, found, err := w.detectCredits(ctx, f.Path, f.DurationMs)
			if err != nil {
				// Transient failure (FFmpeg error/timeout, dead mount):
				// do NOT ledger — the next sweep retries this file.
				// detectCredits already logged the cause.
				continue
			}
			if found {
				markers = append(markers, m)
			}
			if err := w.q.ReplaceAutoSkipMarkers(ctx, f.FileID, false, markers, Detector); err != nil {
				slog.Warn("skipmarkers: store movie markers failed", "file_id", f.FileID, "error", err)
				continue
			}
			analyzed++
			w.mu.Lock()
			w.status.SweepAnalyzed = analyzed
			w.mu.Unlock()
		}
	}
}

func (w *Worker) setErr(msg string) {
	slog.Warn("skip-marker sweep error", "error", msg)
	w.mu.Lock()
	w.status.LastError = msg
	w.mu.Unlock()
}

// analyzeSeason processes one season end-to-end and returns how many
// pending files got their analysis recorded.
//
// Two classes of file get opener (recap/intro) detection:
//   - Pending files (no ledger row for the current detector): full
//     treatment — openers + credits + ledger.
//   - Ledgered files WITHOUT any opener row: opener re-detection
//     only, written when something was found. This is the airing-
//     season path — episodes ledgered before the season had enough
//     pairs to validate pick up their intro retroactively the next
//     time a new episode triggers a season re-analysis. Their
//     credits markers and ledger rows are left untouched.
func (w *Worker) analyzeSeason(ctx context.Context, seasonID int64) int64 {
	files, err := w.q.GetSeasonSkipAnalysisFiles(ctx, seasonID, Detector)
	if err != nil {
		w.setErr("fetch season files: " + err.Error())
		return 0
	}
	seasonFiles := make([]SeasonFile, 0, len(files))
	for _, f := range files {
		seasonFiles = append(seasonFiles, SeasonFile{
			FileID:        f.FileID,
			EpisodeNumber: f.EpisodeNumber,
			Path:          f.Path,
			DurationMs:    f.DurationMs,
			// The analyzer computes windows for every "Pending" file;
			// opener-less ledgered files ride along for re-detection.
			Pending: f.Pending || !f.HasOpener,
		})
	}

	introMarkers, decodeFailed := analyzeSeasonIntros(ctx, seasonFiles, func(ctx context.Context, f SeasonFile) ([]uint32, error) {
		pace(ctx) // pace immediately before each FFmpeg spawn
		pcm, err := decodeIntroPCM(ctx, f.Path)
		if err != nil {
			return nil, err
		}
		return ComputeSignature(pcm), nil
	})
	if ctx.Err() != nil {
		// Cancelled mid-season: don't ledger half-analyzed files; the
		// next sweep redoes this season from scratch.
		return 0
	}

	var done, retro int64
	for _, f := range files {
		if ctx.Err() != nil {
			break
		}
		// A file whose own audio decode failed is skipped entirely —
		// no ledger row, so the next sweep retries it instead of the
		// transient failure becoming a sticky "nothing found".
		if decodeFailed[f.FileID] {
			continue
		}
		openers := introMarkers[f.FileID]

		if !f.Pending {
			// Retroactive opener pass for a ledgered, opener-less
			// file. Improvement-only: nothing found → leave as-is.
			if !f.HasOpener && len(openers) > 0 {
				if err := w.q.ReplaceAutoOpenerMarkers(ctx, f.FileID, true, openers); err != nil {
					slog.Warn("skipmarkers: store retroactive openers failed", "file_id", f.FileID, "error", err)
					continue
				}
				retro++
			}
			continue
		}

		markers := openers
		credits, found, cErr := w.detectCredits(ctx, f.Path, f.DurationMs)
		if cErr != nil {
			// Credits pass failed (likely transient): keep any openers
			// we computed, but DON'T ledger — the next sweep retries
			// the whole file.
			if len(openers) > 0 {
				if err := w.q.ReplaceAutoOpenerMarkers(ctx, f.FileID, true, openers); err != nil {
					slog.Warn("skipmarkers: store openers failed", "file_id", f.FileID, "error", err)
				}
			}
			continue
		}
		if found {
			markers = append(markers, credits)
		}
		if err := w.q.ReplaceAutoSkipMarkers(ctx, f.FileID, true, markers, Detector); err != nil {
			slog.Warn("skipmarkers: store episode markers failed", "file_id", f.FileID, "error", err)
			continue
		}
		done++
	}
	if done > 0 || retro > 0 {
		slog.Info("skip-marker season analyzed", "season_id", seasonID, "files", done, "retro_openers", retro)
	}
	return done
}

// detectCredits runs the tail blackdetect/silencedetect pass for one
// file. found=false with a nil error means "analyzed, nothing credible"
// (a valid, sticky result); a non-nil error means the pass itself
// failed (FFmpeg error/timeout) and the caller must treat the file as
// not-yet-analyzed so it gets retried.
func (w *Worker) detectCredits(ctx context.Context, path string, durationMs int64) (m models.SkipMarker, found bool, err error) {
	durationSec := float64(durationMs) / 1000.0
	tail := creditsTailSec(durationSec)
	if tail <= 0 {
		return models.SkipMarker{}, false, nil
	}
	pace(ctx) // pace immediately before each FFmpeg spawn
	black, silence, err := runCreditsDetect(ctx, path, durationSec-tail)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("skipmarkers: credits detect failed", "path", path, "error", err)
		}
		return models.SkipMarker{}, false, err
	}
	onset, conf, ok := creditsOnsetFromRanges(black, silence, durationSec)
	if !ok {
		return models.SkipMarker{}, false, nil
	}
	return models.SkipMarker{
		Kind:       "credits",
		StartMs:    int64(onset * 1000),
		EndMs:      durationMs,
		Confidence: conf,
		Detector:   Detector,
	}, true, nil
}

// pace sleeps the inter-file gap, returning early on cancellation.
func pace(ctx context.Context) {
	select {
	case <-ctx.Done():
	case <-time.After(filePacing):
	}
}
