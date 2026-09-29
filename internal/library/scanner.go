package library

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

const batchFlushSize = 100

// requeueUnattemptedLimit caps how many never-attempted shows one scan re-queues
// for a full enrichment pass, and requeueSweepInterval caps how often a library is
// swept at all. Both bound the same hazard, from different directions.
//
// The sweep selects shows with no metadata PROGRESS, and the attempt stamp is
// gated on the provider having ANSWERED (see Enricher.EnrichMediaItem — stamping a
// failure would let one TMDB outage defer the whole catalog by a refresh
// interval). So a show whose enrichment reliably ERRORS never acquires progress
// and stays eligible for ever. With an absent or invalid TMDB key that is EVERY
// show in the library. Each eligible show costs up to a TMDB search plus a
// year-less retry — those with tmdb.go's 4 attempts and ~7s of backoff on
// network errors, 429 and 5xx — a TVDB search where TVDB is enabled, and an
// unconditional embed, because cmd/aurora's OnNewItem calls embedItem whether or
// not enrichment errored. The invalid-key headline is the CHEAPEST member of the
// class, not the worst: a 401 returns at once and enrichShow gives up on the
// first search error, so neither the year-less retry nor the TVDB fallback runs
// and the embed is the expensive half. The unreachable-provider and sustained-429
// cases are where the retries and backoff actually land. The watcher fires on fsnotify
// with a 30-second dedup window, so an *arr-fed library can scan every ~30s: left
// unbounded this re-searched and re-embedded a whole library, continuously. That
// is precisely the cost the per-file latch's own comment gives as the reason to
// read PROGRESS rather than STORED, so handing it back here would have undone the
// thing it was added to protect.
//
// 100 matches GetStaleMetadataItems' window, and clears the 80-show library that
// produced #510 in a single sweep.
const (
	requeueUnattemptedLimit = 100
	requeueSweepInterval    = time.Hour
)

type pendingEnrichItem struct {
	item     *models.MediaItem
	filePath string
	// episodeBackfillOnly marks a show whose canonical row already existed AND
	// had already been enriched or attempted (so full enrichment is skipped) but
	// which gained new episode files this scan. Only the episode-level metadata
	// pass runs for these — otherwise episodes added to an already-enriched show
	// stay bare forever.
	episodeBackfillOnly bool
	// season is the season number of the new episode file (backfill entries
	// only). Collected per show so the backfill fetches just the touched
	// seasons instead of every season of the show.
	season int
}

// episodeBackfillEntry aggregates a scan's new episode files per show: one
// entry per media item, with the union of touched season numbers. Built via
// addPendingBackfill so a 400-file season-pack import queues one entry, not
// 400.
type episodeBackfillEntry struct {
	item    *models.MediaItem
	seasons map[int]struct{}
}

// addPendingBackfill merges a backfill signal into the per-show map. Caller
// holds the map's lock.
func addPendingBackfill(m map[int64]*episodeBackfillEntry, item *models.MediaItem, season int) {
	e := m[item.ID]
	if e == nil {
		e = &episodeBackfillEntry{item: item, seasons: make(map[int]struct{})}
		m[item.ID] = e
	}
	if season > 0 {
		e.seasons[season] = struct{}{}
	}
}

// addPendingFull appends a full-enrichment signal, at most once per show.
// Returns the (possibly unchanged) slice. Caller holds the map's lock.
//
// Deduping here mirrors addPendingBackfill, and became necessary when the
// enrichment latch moved from "does this row exist" to "has this row made
// metadata progress": a show not yet attempted now takes the full-enrichment
// branch for EVERY one of its new files, where previously only the file that
// created the row could. enrichNewItem would dedup them anyway via
// s.enrichedItems, but the slice would otherwise grow one entry per file
// (thousands on a large library) and the "enriching TV shows full=N" log would
// count files rather than shows.
//
// Keeping the FIRST entry per show is deliberate, not incidental: enrichNewItem
// reads that entry's filePath to find a sibling .nfo (FindNFO), so first-wins
// preserves the pre-change behaviour of consulting the .nfo beside the file that
// created the row.
func addPendingFull(seen map[int64]struct{}, pending []*pendingEnrichItem, p *pendingEnrichItem) []*pendingEnrichItem {
	if _, dup := seen[p.item.ID]; dup {
		return pending
	}
	seen[p.item.ID] = struct{}{}
	return append(pending, p)
}

// sortedSeasons returns the entry's touched seasons in ascending order.
func (e *episodeBackfillEntry) sortedSeasons() []int {
	out := make([]int, 0, len(e.seasons))
	for sn := range e.seasons {
		out = append(out, sn)
	}
	sort.Ints(out)
	return out
}

type Scanner struct {
	cfg     config.ScannerConfig
	queries *db.Queries

	mu       sync.RWMutex
	progress map[int64]*models.ScanProgress

	// Batch collectors for file inserts (protected by batchMu)
	batchMu        sync.Mutex
	movieFileBuf   []*models.MediaFile
	episodeFileBuf []*models.EpisodeFile

	// enrichedItems tracks media item IDs already enriched during the current scan
	// to prevent redundant TMDB/TVDB API calls (e.g., 100 episodes of the same show).
	// Stored as an atomic pointer so that resetting between scans is safe even when
	// a concurrent scan of a different library has workers still reading the old map.
	enrichedItems atomic.Pointer[sync.Map]

	// requeueSweptAt records when each library was last swept for shows whose
	// enrichment never ran, so the sweep is rate-limited rather than run on every
	// scan (see requeueSweepInterval). Process-local by design: it is a recovery
	// sweep, and a restart re-arming it is the behaviour a restart should have,
	// since an interrupted scan is exactly what a restart causes.
	requeueSweptAt sync.Map // map[int64]time.Time

	// requeueSweepEvery is requeueSweepInterval, overridable in tests.
	requeueSweepEvery time.Duration

	// testHookInRequeueClaim, when non-nil, runs inside dueForRequeueSweep's
	// critical section, between reading the previous sweep time and writing the
	// new one. Nil in production; one nil-compare per sweep.
	//
	// It is a FIELD, not a package variable, because dueForRequeueSweep is a
	// method and the test drives one Scanner: as a global it fired for every
	// Scanner in the process, and a review showed that a `t.Parallel()` on any
	// other test in this package turned the exclusivity test into a FALSE FAILURE
	// — the second "caller" in its claim window was an unrelated ScanLibrary,
	// which then blocked holding requeueMu. Scoping it removes that, and removes a
	// mutable global from a production file.
	//
	// The seam exists because this property cannot be tested by racing goroutines
	// and hoping. A review deleted the mutex and ran a 16-goroutine, 200-round
	// stress test: it passed every run at GOMAXPROCS=1 with and without -race (the
	// race detector is right to stay quiet — sync.Map is race-safe and this is a
	// logical check-then-set, not a data race), and still passed a substantial
	// fraction of runs on four cores. Rates vary by machine; the load-bearing part
	// is that a guard can survive its own mutation entirely on a single-CPU runner.
	// The hook lets the test interleave two callers deterministically instead, the
	// way tmdb.baseURL lets the enricher test drive a fake provider.
	testHookInRequeueClaim func()

	// requeueMu makes dueForRequeueSweep's check-and-claim atomic. sync.Map has no
	// compare-and-swap for this shape, and ScanLibrary does not itself enforce
	// TryStartScan, so two scans of one library could otherwise both claim the
	// slot and both sweep. Every call site today DOES take TryStartScan first
	// (cmd/aurora, the two media handlers and the request handler — the watcher
	// reaches ScanLibrary through cmd/aurora's onChange closure, not directly), so
	// this is a defensive leaf lock rather than a fix for a live race. An earlier
	// version of this comment claimed the watcher called ScanLibrary directly; it
	// does not, and a wrong reachability claim in a comment is the thing this
	// repo's ledger warns about, not the lock.
	requeueMu sync.Mutex

	// showLocks provides per-show serialization during scanning.
	// Key: "libraryID:showTitle" (lowercased).
	// Purpose: Enrichment can mutate the media_items unique key (e.g., setting the
	// year from TMDB), causing subsequent UpsertMediaItem calls to create a duplicate
	// row instead of hitting the ON CONFLICT path. When the enricher detects the
	// duplicate and merges (deletes) it, goroutines that already resolved the
	// now-deleted ID get FK violations on tv_seasons/tv_episodes inserts.
	// Holding a per-show lock through the entire upsert+season+episode+enrichment
	// flow prevents this race.
	showLocks sync.Map // map[string]*sync.Mutex

	// OnNewItem is called after a new media item is upserted during scan.
	// The enricher hooks into this to trigger TMDB lookups inline.
	OnNewItem func(ctx context.Context, item *models.MediaItem)

	// OnNewItemByID is called when an .nfo file provides an explicit TMDB ID,
	// bypassing the search/match pipeline entirely.
	OnNewItemByID func(ctx context.Context, item *models.MediaItem, tmdbID int)

	// OnNewItemByTVDBID is called when an .nfo file provides a TVDB ID (but no TMDB ID).
	OnNewItemByTVDBID func(ctx context.Context, item *models.MediaItem, tvdbID int)

	// OnEpisodeBackfill is called for shows whose canonical row already
	// existed when a scan added new episode files. The enricher hooks into
	// this to populate episode-level TMDB metadata for the new rows without
	// re-running the full show match. seasons lists the season numbers the
	// scan touched (empty ⇒ refresh all seasons).
	OnEpisodeBackfill func(ctx context.Context, item *models.MediaItem, seasons []int)

	// OnScanComplete fires once per ScanLibrary call after the scan
	// finished SUCCESSFULLY (not on failure), regardless of which
	// entry point started it (API handler, watcher, periodic timer).
	// The Smart Skip worker hooks this to sweep for unanalyzed files.
	// Must be cheap/non-blocking — it runs on the scan goroutine.
	OnScanComplete func(lib *models.Library)
}

func NewScanner(cfg config.ScannerConfig, queries *db.Queries) *Scanner {
	s := &Scanner{
		cfg:               cfg,
		queries:           queries,
		progress:          make(map[int64]*models.ScanProgress),
		requeueSweepEvery: requeueSweepInterval,
	}
	s.enrichedItems.Store(&sync.Map{})
	return s
}

func (s *Scanner) GetProgress(libraryID int64) *models.ScanProgress {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if p, ok := s.progress[libraryID]; ok {
		cp := *p
		return &cp
	}
	return &models.ScanProgress{LibraryID: libraryID, Status: models.ScanIdle}
}

// TryStartScan atomically checks if a scan is already running for the library
// and marks it as running if not. Returns false if a scan is already in progress.
func (s *Scanner) TryStartScan(libraryID int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.progress[libraryID]; ok && p.Status == models.ScanRunning {
		return false
	}
	now := time.Now()
	s.progress[libraryID] = &models.ScanProgress{
		LibraryID: libraryID,
		Status:    models.ScanRunning,
		StartedAt: &now,
	}
	return true
}

// ReleaseScanSlot gives back a slot claimed by TryStartScan when the work it was
// claimed for never started. Without it a caller that claims the slot and then
// fails (a refused retype, a transaction rollback) leaves the library reading as
// ScanRunning for the life of the process — no scan would start, and the health
// report would treat it as busy and stay silent about it.
//
// Idempotent, and deliberately a no-op when a scan is actually running: this
// releases an UNUSED claim, it does not cancel work.
func (s *Scanner) ReleaseScanSlot(libraryID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.progress[libraryID]; ok && p.Status == models.ScanRunning && p.ScannedFiles == 0 && p.TotalFiles == 0 {
		p.Status = models.ScanIdle
	}
}

func (s *Scanner) ScanLibrary(ctx context.Context, lib *models.Library, progressCb func(*models.ScanProgress)) error {
	now := time.Now()

	// Retrieve the progress entry, or create one. Every caller today takes
	// TryStartScan first (cmd/aurora — including the watcher's onChange closure —
	// the two media handlers and the request handler), so the fallback is
	// defensive. This comment used to name the watcher as a direct caller, which
	// it is not; the requeueMu note above retracts the same claim.
	s.mu.Lock()
	progress, exists := s.progress[lib.ID]
	if !exists || progress.Status != models.ScanRunning {
		progress = &models.ScanProgress{
			LibraryID: lib.ID,
			Status:    models.ScanRunning,
			StartedAt: &now,
		}
		s.progress[lib.ID] = progress
	}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		if progress.Error != "" {
			progress.Status = models.ScanFailed
		} else {
			progress.Status = models.ScanComplete
		}
		completed := progress.Status == models.ScanComplete
		s.mu.Unlock()
		if progressCb != nil {
			progressCb(progress)
		}
		if completed && s.OnScanComplete != nil {
			s.OnScanComplete(lib)
		}
	}()

	notify := func() {
		if progressCb != nil {
			s.mu.RLock()
			cp := *progress
			s.mu.RUnlock()
			progressCb(&cp)
		}
	}

	// Reset per-scan dedup tracker so each scan starts fresh.
	//
	// The atomic pointer swap keeps this memory-safe under a concurrent scan, but
	// it does NOT isolate the two: enrichNewItem and backfillEpisodeMetadata
	// Load() on every call, so a scan of another library starting here wipes the
	// dedup map a scan already running is still reading. The consequence is a
	// redundant enrichment, not lost data. Pre-existing — but the deferred pass is
	// longer now that the recovery sweep feeds it, so the window is wider.
	s.enrichedItems.Store(&sync.Map{})

	slog.Info("scan started", "library", lib.Name, "id", lib.ID, "paths", lib.Paths)

	// Phase 1: Walk all paths and collect video files
	var allFiles []string
	var unreadablePaths []string
	walkFailed := false
	for _, rootPath := range lib.Paths {
		files, unreadable, err := collectVideoFiles(rootPath)
		if err != nil {
			// The ROOT itself is unwalkable (unmounted share, removed drive).
			// Nothing under it can be reasoned about, so the prune stays off
			// for the whole library — this is the catastrophic case the H9
			// guard was written for and it is unchanged.
			slog.Error("walk path failed", "path", rootPath, "error", err)
			walkFailed = true
			continue
		}
		// A walk that "succeeded" but skipped unreadable entries still has an
		// incomplete file list. Previously that disabled the prune for the
		// ENTIRE library: one permission-denied folder
		// (/media/tvshows/CSI - Miami) left every deleted TV episode in the
		// database for three days, with a log line as the only evidence.
		//
		// Now the unreadable subtrees are carried into the prune and excluded
		// there, so the rest of the library — which walked cleanly — is
		// pruned normally.
		if len(unreadable) > 0 {
			// Bounded: this fires on EVERY scan (~200/day) for a persistently
			// unreadable folder, and an unbounded list would put up to 1000
			// paths on each line.
			slog.Warn("walk incomplete: unreadable entries — prune scoped around them",
				"path", rootPath, "unreadable", len(unreadable),
				"paths", boundedPaths(unreadable, 5))
			unreadablePaths = append(unreadablePaths, unreadable...)
		}
		allFiles = append(allFiles, files...)
	}
	// Too many unreadable entries to scope around: at this scale the
	// "everything else walked cleanly" assumption no longer holds, so fall
	// back to the old all-or-nothing behaviour.
	if len(unreadablePaths) >= maxTrackedUnreadable {
		slog.Warn("walk incomplete: too many unreadable entries to scope the prune — skipping it entirely",
			"library", lib.Name, "unreadable", len(unreadablePaths))
		walkFailed = true
	}

	s.mu.Lock()
	progress.TotalFiles = len(allFiles)
	// Surface incomplete walks on the status API. Note these two fields are
	// now INDEPENDENT: unreadable entries (root-owned lost+found, NAS
	// .snapshots, a permission-denied show folder) no longer disable the
	// prune — it is scoped around them — so WalkErrors > 0 with
	// PruneSkipped false is the normal, healthy case. PruneSkipped means the
	// prune was abandoned wholesale: an unwalkable root, or so many unreadable
	// entries that scoping stopped being trustworthy.
	progress.WalkErrors = len(unreadablePaths)
	progress.PruneSkipped = walkFailed
	// ...and WHICH paths, bounded for display. A log line being the only
	// evidence is how one folder went unnoticed for three days.
	progress.UnreadablePaths = boundedPaths(unreadablePaths, 10)
	s.mu.Unlock()
	notify()

	slog.Info("files discovered", "library", lib.Name, "count", len(allFiles))

	// Phase 1b: Prune files that exist in the DB but are no longer on disk.
	// This handles the case where a user deletes a file between scans —
	// without this step, the stale DB row would persist indefinitely.
	//
	// deep-debug H9 — only prune when EVERY path walked cleanly. A transient
	// mount/permission failure (NFS/SMB unmounted, removable drive absent)
	// makes collectVideoFiles error for that path, leaving allFiles missing
	// its entries; pruning then would delete every DB file row under it. Skip
	// pruning entirely on any walk error rather than risk wiping the catalog.
	if walkFailed {
		slog.Warn("skipping prune: one or more library paths failed to walk (transient mount/permission issue?) — leaving DB file rows intact",
			"library", lib.Name)
	} else {
		pruned, pruneErr := s.pruneDeletedFiles(ctx, lib, allFiles, unreadablePaths)
		if pruneErr != nil {
			slog.Error("prune deleted files failed", "library", lib.Name, "error", pruneErr)
		} else if pruned > 0 {
			slog.Info("pruned deleted files", "library", lib.Name, "count", pruned)
		}

		// Phase 1c: Sweep away catalog entries whose last file just
		// disappeared. After the file prune above, a movie/show with zero
		// remaining files is the "no files available" ghost the UI would
		// otherwise show indefinitely (the user deleted the title from disk,
		// but its metadata shell lingers). Remove the shell too.
		//
		// Gated by the SAME safety conditions as the prune: we're already in
		// the !walkFailed branch, and we additionally require a non-empty walk
		// (len(allFiles) > 0) — mirroring pruneDeletedFiles' zero-discovered
		// guard — so a transient empty mount can never trigger a catalog wipe.
		if len(allFiles) > 0 {
			removed, cleanErr := s.queries.DeleteEmptyMediaItems(ctx, lib.ID)
			if cleanErr != nil {
				slog.Error("prune empty media items failed", "library", lib.Name, "error", cleanErr)
			} else if len(removed) > 0 {
				for _, it := range removed {
					slog.Info("removed media item with no remaining files",
						"id", it.ID, "title", it.Title, "library", lib.Name)
				}
				slog.Info("pruned empty media items", "library", lib.Name, "count", len(removed))
			}
		}
	}

	// Phase 2: Process files concurrently with bounded goroutines.
	//
	// MED (med-integration #1) — clamp the worker count to a sane minimum.
	// A zero-capacity semaphore (Workers==0) deadlocks: `sem <- struct{}{}`
	// blocks waiting for a receiver, but the receiving goroutine only runs
	// after the send completes, so the first file hangs the scan forever. A
	// negative Workers value panics in make(). Default to 1 (serial) when the
	// configured value is non-positive so the scan always makes progress.
	workers := s.cfg.Workers
	if workers <= 0 {
		slog.Warn("scanner workers misconfigured (<=0); defaulting to 1", "configured", s.cfg.Workers)
		workers = 1
	}
	sem := make(chan struct{}, workers)
	var scannedCount atomic.Int64
	var newCount atomic.Int64
	var wg sync.WaitGroup

	// Local per-scan collections for deferred TV enrichment.
	// TV show enrichment is deferred until all files are processed so that
	// all season/episode rows exist when enrichSeasons() runs. Full
	// enrichments (shows not yet enriched or attempted — a new show, or one
	// whose earlier scan was interrupted before this pass) and episode
	// backfills (already-dealt-with shows that gained files) are kept apart:
	// both dedup per show at enqueue, and running the fulls first is
	// structural, not an ordering pass.
	var pendingMu sync.Mutex
	var pendingTVEnrich []*pendingEnrichItem
	pendingFullSeen := make(map[int64]struct{})
	pendingBackfill := make(map[int64]*episodeBackfillEntry)

	for _, fp := range allFiles {
		if ctx.Err() != nil {
			s.mu.Lock()
			progress.Error = "scan cancelled"
			s.mu.Unlock()
			return ctx.Err()
		}

		wg.Add(1)
		sem <- struct{}{}

		go func(filePath string) {
			defer wg.Done()
			defer func() { <-sem }()

			isNew, pending, err := s.processFile(ctx, lib, filePath)
			if err != nil {
				slog.Error("process file failed", "path", filePath, "error", err)
			}
			if pending != nil {
				pendingMu.Lock()
				if pending.episodeBackfillOnly {
					addPendingBackfill(pendingBackfill, pending.item, pending.season)
				} else {
					pendingTVEnrich = addPendingFull(pendingFullSeen, pendingTVEnrich, pending)
				}
				pendingMu.Unlock()
			}

			count := scannedCount.Add(1)
			if isNew {
				newCount.Add(1)
			}

			if count%10 == 0 || int(count) == len(allFiles) {
				s.mu.Lock()
				progress.ScannedFiles = int(count)
				progress.NewFiles = int(newCount.Load())
				progress.CurrentFile = filepath.Base(filePath)
				s.mu.Unlock()
				notify()
			}
		}(fp)
	}

	wg.Wait()

	// Clear per-show locks for this library to prevent unbounded growth.
	// All workers are done, so no goroutine holds these locks anymore.
	prefix := fmt.Sprintf("%d:", lib.ID)
	s.showLocks.Range(func(key, _ interface{}) bool {
		if k, ok := key.(string); ok && strings.HasPrefix(k, prefix) {
			s.showLocks.Delete(key)
		}
		return true
	})

	// Flush remaining batched files
	s.flushBatches(ctx)

	// Shows that have never been ATTEMPTED are re-queued here, not just from
	// processFile.
	//
	// This is load-bearing, not a belt-and-braces extra. processFile returns early
	// when a file's hash is unchanged, BEFORE it consults FindMediaItemByTitle — and
	// the #510 state is precisely "every episode file was recorded and flushed, then
	// the deferred pass below was cancelled", because files flush per file while the
	// pass runs after wg.Wait(). So on the next scan every file is unchanged, the
	// enrichment latch is never evaluated, and the per-file path cannot recover the
	// very state it was written for unless the show happens to gain a new or modified
	// file. A review caught that after the latch had already been through three
	// rounds; asking the question once per scan is what makes the scanner's half of
	// the recovery real rather than conditional.
	//
	// Skipped when the walk found nothing: that is the transient-mount shape
	// pruneDeletedFiles refuses to act on, and it is no better a moment to spend
	// provider calls.
	//
	// BOUNDED twice over — see requeueUnattemptedLimit and requeueSweepInterval.
	//
	// It is also kept in its OWN slice rather than appended to pendingTVEnrich,
	// because it is the one part of the deferred pass that is not derived from
	// this scan's delta. Queued ahead of the backfills it would spend the scan's
	// remaining window on recovery work and, on a cancellation, take every
	// episode backfill down with it — and a backfill is only ever signalled in the
	// scan that FIRST sees the file, so a dropped one is not merely delayed. The
	// rotation is only a PARTIAL safety net here: RefreshStaleMetadata's smart
	// diffing skips a show outright when it has a last_metadata AND a tmdb_id AND
	// HasTVChanged reports no upstream change, and a locally added episode file is
	// not an upstream change. That is the MATCHED class — the common one, and the
	// one whose episodes would stay bare permanently. It is not every
	// backfill-eligible show: eligibility is `Attempted`, which is either progress
	// column, so a show asked-and-unmatched has last_metadata and tmdb_id NULL and
	// the rotation does re-enrich it. An earlier version of this comment said the
	// first two hold "by definition", which is the wrong half of that
	// distinction. A review found the ordering; a later one found that this is
	// what it costs. The sweep runs LAST for the same reason it is capped.
	var sweptTVEnrich []*pendingEnrichItem
	if lib.Type == models.LibraryShows && len(allFiles) > 0 && ctx.Err() == nil && s.dueForRequeueSweep(lib.ID) {
		unattempted, err := s.queries.GetUnattemptedShowsForLibrary(ctx, lib.ID, requeueUnattemptedLimit)
		if err != nil {
			slog.Warn("could not list shows awaiting enrichment", "library", lib.Name, "error", err)
		} else if len(unattempted) > 0 {
			// The same seen-set as the per-file fulls, so a show this scan already
			// queued is not enriched twice — and so the sweep cannot displace a
			// scan-derived entry, which carries the .nfo-bearing file path.
			pendingMu.Lock()
			for _, u := range unattempted {
				sweptTVEnrich = addPendingFull(pendingFullSeen, sweptTVEnrich,
					&pendingEnrichItem{item: u.Item, filePath: u.FilePath})
			}
			pendingMu.Unlock()
			if len(sweptTVEnrich) > 0 {
				slog.Info("re-queued shows whose enrichment never ran",
					"library", lib.Name, "shows", len(sweptTVEnrich),
					"capped_at", requeueUnattemptedLimit)
			}
		}
	}

	// Enrich TV shows after all files are processed.
	// All season/episode rows now exist in the DB, so enrichSeasons() can
	// populate every episode with TMDB metadata (titles, overviews, stills).
	if len(pendingTVEnrich) > 0 || len(pendingBackfill) > 0 || len(sweptTVEnrich) > 0 {
		slog.Info("enriching TV shows",
			"full", len(pendingTVEnrich), "episode_backfills", len(pendingBackfill),
			"recovery_sweep", len(sweptTVEnrich))
		// Fulls run before backfills: a full enrichment covers the
		// backfill's work and marks the show in the shared per-scan dedup
		// map, so backfillEpisodeMetadata skips shows enriched this scan.
		//
		// A show getting BOTH kinds of entry used to be the normal case (its
		// first file created the row, later files found it existing). Since the
		// latch reads metadata PROGRESS, files behind the one that created the
		// row see a row with both columns still NULL and take the full branch
		// too, where they are deduped — so "both kinds" now needs progress to
		// appear mid-scan, i.e. the background RefreshStaleMetadata goroutine or
		// an admin manual match landing between two of this scan's files. Rare,
		// still reachable, and the ordering is what keeps it from costing a
		// redundant backfill.
		interrupted := false
		for i, p := range pendingTVEnrich {
			if ctx.Err() != nil {
				slog.Warn("TV enrichment interrupted by context cancellation",
					"completed", i,
					"remaining", len(pendingTVEnrich)-i+len(pendingBackfill)+len(sweptTVEnrich))
				interrupted = true
				break
			}
			s.enrichNewItem(ctx, p.item, p.filePath)
		}
		if !interrupted {
			done := 0
			for _, b := range pendingBackfill {
				if ctx.Err() != nil {
					slog.Warn("episode backfill interrupted by context cancellation",
						"completed", done, "remaining", len(pendingBackfill)-done)
					break
				}
				s.backfillEpisodeMetadata(ctx, b.item, b.sortedSeasons())
				done++
			}
		}
		// The recovery sweep goes last: everything above is work this scan's own
		// files asked for, and recovering a show that has been stuck since some
		// earlier scan must not be what stops that work from happening. The
		// sweep's shows cannot also hold a backfill entry — a backfill needs the
		// row to have been ATTEMPTED and the sweep selects rows that have not,
		// and progress only moves forwards — so ordering them after costs no
		// redundant pass.
		for i, p := range sweptTVEnrich {
			if ctx.Err() != nil {
				slog.Warn("enrichment recovery sweep interrupted by context cancellation",
					"completed", i, "remaining", len(sweptTVEnrich)-i)
				break
			}
			s.enrichNewItem(ctx, p.item, p.filePath)
		}
	}

	s.mu.Lock()
	progress.ScannedFiles = len(allFiles)
	progress.NewFiles = int(newCount.Load())
	progress.CurrentFile = ""
	s.mu.Unlock()

	elapsed := time.Since(now)
	slog.Info("scan complete",
		"library", lib.Name,
		"total_files", len(allFiles),
		"new_files", newCount.Load(),
		"duration", elapsed.Round(time.Millisecond),
	)

	return nil
}

// dueForRequeueSweep reports whether this library's never-attempted shows may be
// swept now, and claims the slot if so.
//
// Claiming BEFORE the query, and regardless of what it returns, is deliberate: the
// cost being rate-limited is the enrichment the sweep queues, and a sweep that
// errored or found nothing must not leave the next scan a free pass. The trade is
// that a #510 state arising just after a sweep waits up to requeueSweepInterval for
// the scanner's half; RefreshStaleMetadata's rotation covers it in the meantime,
// and never-attempted rows sort to the head of that queue.
//
// A zero requeueSweepEvery disables the rate limit (tests).
func (s *Scanner) dueForRequeueSweep(libraryID int64) bool {
	if s.requeueSweepEvery <= 0 {
		return true
	}
	s.requeueMu.Lock()
	defer s.requeueMu.Unlock()
	now := time.Now()
	if prev, ok := s.requeueSweptAt.Load(libraryID); ok {
		if at, ok := prev.(time.Time); ok && now.Sub(at) < s.requeueSweepEvery {
			return false
		}
	}
	if s.testHookInRequeueClaim != nil {
		s.testHookInRequeueClaim()
	}
	s.requeueSweptAt.Store(libraryID, now)
	return true
}

// showLockKey returns the per-show lock for a given library+title combination.
// The lock serializes all operations on the same show: UpsertMediaItem, UpsertSeason,
// UpsertEpisode, and enrichment. This prevents the race where enrichment mutates
// the media_items unique key (year), causing concurrent goroutines to create duplicate
// rows that are subsequently merged (deleted), producing FK violations.
func (s *Scanner) showLock(libraryID int64, title string) *sync.Mutex {
	key := fmt.Sprintf("%d:%s", libraryID, strings.ToLower(title))
	actual, _ := s.showLocks.LoadOrStore(key, &sync.Mutex{})
	return actual.(*sync.Mutex)
}

func (s *Scanner) processFile(ctx context.Context, lib *models.Library, filePath string) (bool, *pendingEnrichItem, error) {
	fileHash, fileSize, err := generateFileHash(filePath)
	if err != nil {
		return false, nil, fmt.Errorf("hash file: %w", err)
	}

	isTV := lib.Type == models.LibraryShows

	// Check if file already exists and is unchanged
	var existingHash string
	if isTV {
		existing, err := s.queries.GetEpisodeFileByPath(ctx, filePath)
		if err != nil {
			return false, nil, fmt.Errorf("check existing: %w", err)
		}
		if existing != nil {
			existingHash = existing.FileHash
		}
	} else {
		existing, err := s.queries.GetMediaFileByPath(ctx, filePath)
		if err != nil {
			return false, nil, fmt.Errorf("check existing: %w", err)
		}
		if existing != nil {
			existingHash = existing.FileHash
		}
	}
	if existingHash == fileHash {
		return false, nil, nil
	}
	isNew := existingHash == ""

	// Parse filename to extract metadata
	var parsed ParsedFile
	if isTV {
		parsed = ParseTVPath(filePath)
	} else {
		parsed = ParseMoviePath(filePath)
	}

	if parsed.Title == "" {
		parsed.Title = strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))
	}

	mediaType := models.MediaMovie
	if isTV {
		mediaType = models.MediaShow
	}

	// For TV shows, serialize all operations on the same show title within a library.
	// This prevents a race condition where:
	//  1. Goroutine A upserts media_item (year=nil, parsed from folder) -> ID 178
	//  2. Goroutine A's enrichment sets year=2016 from TMDB on row 178
	//  3. Goroutine B upserts media_item (year=nil) -> no conflict (178 now has year=2016) -> creates ID 194
	//  4. Goroutine B's enrichment detects tmdb_id collision, merges 194 into 178 (deletes 194)
	//  5. Goroutine C already resolved ID 194, tries UpsertSeason(194,...) -> FK violation
	// The per-show lock ensures only one goroutine at a time runs the full
	// upsert+season+episode+enrichment pipeline for a given show.
	if isTV {
		mu := s.showLock(lib.ID, parsed.Title)
		mu.Lock()
		defer mu.Unlock()
	}

	item := &models.MediaItem{
		LibraryID: lib.ID,
		Type:      mediaType,
		Title:     parsed.Title,
		SortTitle: GenerateSortTitle(parsed.Title),
		Year:      parsed.Year,
	}

	// needsEnrichment tracks whether this media item needs TMDB enrichment.
	// Separate from isNew (which tracks whether the episode FILE is new for
	// progress counting). We skip enrichment when we resolve to an existing
	// canonical item that was already enriched by a prior goroutine.
	needsEnrichment := isNew

	// For TV shows under the per-show lock: check if a canonical row already
	// exists for this (library, type, title) regardless of year. This handles the
	// case where a previous goroutine's enrichment changed the year on the
	// canonical row, which breaks UpsertMediaItem's ON CONFLICT path (it includes
	// COALESCE(year, 0) in the unique key, so year=NULL no longer matches
	// year=2021). Without this check, every episode would create a duplicate row,
	// trigger enrichment, detect the tmdb_id collision, and merge — all wasteful
	// and potentially causing FK violations if the lock isn't held.
	if isTV {
		existing, findErr := s.queries.FindMediaItemByTitle(ctx, lib.ID, string(mediaType), parsed.Title)
		if findErr != nil {
			slog.Warn("find canonical item failed, falling back to upsert", "title", parsed.Title, "error", findErr)
		}
		if existing != nil {
			// Canonical row found — reuse it. Skip UpsertMediaItem entirely to
			// avoid creating a duplicate row that would need to be merged.
			item.ID = existing.ID
			item.AddedAt = existing.AddedAt
			item.UpdatedAt = existing.UpdatedAt
			// Latch off enrichment when this row has already been DEALT WITH,
			// not merely when it exists.
			//
			// "Exists ⇒ dealt with" holds for movies, which enrich inline in
			// this same function, so a movie row cannot outlive its enrichment
			// call. It does NOT hold for TV: the enrichment is deferred to the
			// pass after wg.Wait(), and that pass abandons everything still
			// queued the moment ctx is cancelled. Since scanContext() is the
			// SERVER lifecycle context, any restart mid-scan — and this box
			// auto-deploys on a 5-minute timer — leaves shows whose row was
			// created but whose enrichment never ran.
			//
			// Treating those as done made the damage permanent: no later rescan
			// could ever re-queue them for a full pass, so they kept NULL
			// tmdb_id/genres/content_rating for ever and could only pick up
			// episodeBackfillOnly, which touches episode rows and not the
			// show's own metadata. Issue #510.
			//
			// Note this branch is only REACHED for a new or changed file —
			// processFile returns early above on an unchanged hash — so it is not
			// by itself enough to recover the #510 state, where every file is
			// already recorded. ScanLibrary asks the same question once per scan
			// for exactly that reason; see the re-queue block after wg.Wait().
			//
			// "Dealt with" is metadata PROGRESS (stored OR attempted), not
			// stored metadata. Stored-only would re-queue a full search for
			// every show no provider has an entry for, on every scan that
			// brings one of its files: a TMDB search plus a year-less retry, a
			// TVDB search where TVDB is enabled, and an unconditional embed
			// (embedItem has no already-embedded guard). Those shows are the
			// refresh queue's job — it now rotates them rather than re-reading
			// them for ever — and this branch's job is only the never-attempted
			// ones, which is exactly the interrupted-scan state since it leaves
			// BOTH columns NULL.
			//
			// Note what this does NOT avoid, since an earlier draft claimed it:
			// an LLM re-match is enqueued only for a score at or above the
			// review threshold, and if the detail fetch then fails the helper
			// returns a non-nil error, so no attempt is stamped and this latch
			// does not hold the row back either. That case costs the same under
			// both latches.
			needsEnrichment = !existing.Attempted
		}
	}

	if item.ID == 0 {
		if err := s.queries.UpsertMediaItem(ctx, item); err != nil {
			return false, nil, fmt.Errorf("upsert media item: %w", err)
		}
	}

	// Probe file for codec info
	probeResult, probeErr := Probe(ctx, s.cfg.FFprobePath, filePath)
	if probeErr != nil {
		slog.Debug("ffprobe unavailable", "file", filepath.Base(filePath))
	}

	if isTV {
		// TV: create season → episode → episode_file chain
		seasonNum := parsed.Season
		if seasonNum <= 0 {
			seasonNum = 1 // Default to season 1 if parser couldn't determine
		}
		episodeNum := parsed.Episode
		if episodeNum <= 0 {
			episodeNum = 1
		}

		seasonID, err := s.queries.UpsertSeason(ctx, item.ID, seasonNum)
		if err != nil {
			return false, nil, fmt.Errorf("upsert season: %w", err)
		}

		episodeID, err := s.queries.UpsertEpisode(ctx, seasonID, item.ID, episodeNum)
		if err != nil {
			return false, nil, fmt.Errorf("upsert episode: %w", err)
		}

		ef := &models.EpisodeFile{
			EpisodeID: episodeID,
			Path:      filePath,
			SizeBytes: fileSize,
			FileHash:  fileHash,
			Container: containerFromExt(filePath),
		}
		if probeResult != nil {
			ef.Container = probeResult.Container
			ef.VideoCodec = probeResult.VideoCodec
			ef.AudioCodec = probeResult.AudioCodec
			ef.Resolution = probeResult.Resolution
			ef.Bitrate = probeResult.Bitrate
			ef.DurationMs = probeResult.DurationMs
			ef.AudioTracks = probeResult.AudioTracks
			ef.SubtitleTracks = probeResult.SubtitleTracks
			ef.VideoProfile = probeResult.VideoProfile
			ef.VideoPixFmt = probeResult.VideoPixFmt
			ef.ColorTransfer = probeResult.ColorTransfer
			ef.ColorPrimaries = probeResult.ColorPrimaries
			ef.VideoFPS = probeResult.VideoFPS
		} else if parsed.Resolution != "" {
			ef.Resolution = parsed.Resolution
		}
		ef.VersionTag = ClassifyVersion(ef.Resolution, ef.VideoCodec)

		s.addEpisodeFileBatch(ctx, ef)

		// Flush episode files BEFORE enrichment. Enrichment can trigger a
		// TMDB duplicate merge that deletes this item.ID. If the file is
		// still in the batch buffer when that happens, the deferred flush
		// would try to insert with a deleted episode_id → FK violation.
		s.flushEpisodeFiles(ctx)

		// Defer TV enrichment until after all files are processed.
		// At this point only this episode's season/episode rows exist.
		// enrichSeasons() needs ALL episode rows to populate TMDB metadata
		// for every episode. The deferred pass runs after wg.Wait().
		if needsEnrichment {
			return isNew, &pendingEnrichItem{item: item, filePath: filePath}, nil
		}
		// Canonical show already existed (needsEnrichment=false), but this
		// scan added a NEW episode file. The full-enrichment path won't run
		// for this show, so queue an episode-level backfill or the new
		// episode rows never receive TMDB titles/overviews/stills.
		if isNew {
			return isNew, &pendingEnrichItem{item: item, filePath: filePath, episodeBackfillOnly: true, season: seasonNum}, nil
		}
	} else {
		// Movie: create media_file
		mf := &models.MediaFile{
			MediaItemID: item.ID,
			Path:        filePath,
			SizeBytes:   fileSize,
			FileHash:    fileHash,
			Container:   containerFromExt(filePath),
		}
		if probeResult != nil {
			mf.Container = probeResult.Container
			mf.VideoCodec = probeResult.VideoCodec
			mf.AudioCodec = probeResult.AudioCodec
			mf.Resolution = probeResult.Resolution
			mf.Bitrate = probeResult.Bitrate
			mf.DurationMs = probeResult.DurationMs
			mf.AudioTracks = probeResult.AudioTracks
			mf.SubtitleTracks = probeResult.SubtitleTracks
			mf.VideoProfile = probeResult.VideoProfile
			mf.VideoPixFmt = probeResult.VideoPixFmt
			mf.ColorTransfer = probeResult.ColorTransfer
			mf.ColorPrimaries = probeResult.ColorPrimaries
			mf.VideoFPS = probeResult.VideoFPS
		} else if parsed.Resolution != "" {
			mf.Resolution = parsed.Resolution
		}
		mf.VersionTag = ClassifyVersion(mf.Resolution, mf.VideoCodec)

		s.addMovieFileBatch(ctx, mf)

		// Flush movie files BEFORE enrichment. Enrichment can trigger a
		// TMDB duplicate merge that deletes this item.ID. If the file is
		// still in the batch buffer when that happens, the deferred flush
		// would try to insert with a deleted media_item_id → FK violation.
		s.flushMovieFiles(ctx)

		// Trigger metadata enrichment for new movie items.
		if isNew {
			s.enrichNewItem(ctx, item, filePath)
		}
	}

	return isNew, nil, nil
}

// enrichNewItem triggers metadata enrichment for a newly discovered media item.
// Dedup: skips if this media item was already enriched during the current scan
// (e.g., multiple episodes of the same TV show share one media_item ID).
func (s *Scanner) enrichNewItem(ctx context.Context, item *models.MediaItem, filePath string) {
	if _, alreadyEnriched := s.enrichedItems.Load().LoadOrStore(item.ID, true); alreadyEnriched {
		slog.Debug("skipping duplicate enrichment", "item_id", item.ID, "title", item.Title, "file", filepath.Base(filePath))
		return
	}

	// Check for .nfo file with explicit external IDs (skip search-based matching)
	if nfoPath := FindNFO(filePath); nfoPath != "" {
		if nfo, err := ParseNFO(nfoPath); err == nil && nfo.HasExternalID() {
			if nfo.TMDBID > 0 {
				slog.Debug("nfo provided tmdb id", "file", filepath.Base(filePath), "tmdb_id", nfo.TMDBID)
				if s.OnNewItemByID != nil {
					s.OnNewItemByID(ctx, item, nfo.TMDBID)
				}
				return
			}
			if nfo.TVDBID > 0 {
				slog.Debug("nfo provided tvdb id", "file", filepath.Base(filePath), "tvdb_id", nfo.TVDBID)
				if s.OnNewItemByTVDBID != nil {
					s.OnNewItemByTVDBID(ctx, item, nfo.TVDBID)
				}
				return
			}
		}
	}
	// No NFO with usable ID — fall through to search-based enrichment
	if s.OnNewItem != nil {
		s.OnNewItem(ctx, item)
	}
}

// backfillEpisodeMetadata triggers the episode-level metadata pass for a show
// that already had a canonical row when this scan added new episode files.
// Shares the per-scan dedup map with enrichNewItem so a show fully enriched
// this scan (which already covered its episodes) is skipped.
func (s *Scanner) backfillEpisodeMetadata(ctx context.Context, item *models.MediaItem, seasons []int) {
	if _, alreadyEnriched := s.enrichedItems.Load().LoadOrStore(item.ID, true); alreadyEnriched {
		slog.Debug("skipping duplicate episode backfill", "item_id", item.ID, "title", item.Title)
		return
	}
	if s.OnEpisodeBackfill != nil {
		s.OnEpisodeBackfill(ctx, item, seasons)
	}
}

// boundedPaths returns at most n entries, for surfacing on the status API
// without letting a pathological mount blow up the JSON payload.
func boundedPaths(paths []string, n int) []string {
	if len(paths) <= n {
		return paths
	}
	return paths[:n]
}

// pruneDeletedFiles removes DB rows for files no longer on disk.
//
// unreadablePaths lists subtrees the walk could not read. Rows under those
// paths are SKIPPED rather than pruned: their files may well still exist, we
// simply could not see them, and deleting them would be data loss driven by a
// permission error. Everything outside those subtrees walked cleanly and is
// pruned normally — which is the difference between one bad folder disabling
// cleanup for a whole library and it disabling cleanup only for itself.
func (s *Scanner) pruneDeletedFiles(ctx context.Context, lib *models.Library, discoveredFiles []string, unreadablePaths []string) (int64, error) {
	// deep-debug H9 — refuse to prune when zero files were discovered. The
	// canonical NFS/SMB failure leaves the mountpoint present-but-EMPTY, so
	// collectVideoFiles returns ([], nil) — no error, so the walkFailed guard
	// in ScanLibrary does NOT trip — and pruning against an empty set would
	// delete every file row for the library. Treat zero-discovered as suspect,
	// not authoritative: bail and keep the rows. A genuinely-emptied library
	// just carries stale rows until a scan finds files again (or the operator
	// removes it) — acceptable versus catastrophic, unattended data loss.
	if len(discoveredFiles) == 0 {
		slog.Warn("prune skipped: zero files discovered for library — refusing to delete all file rows (transient mount failure?)", "library", lib.Name)
		return 0, nil
	}
	// Build a set of discovered paths for O(1) lookup
	discovered := make(map[string]struct{}, len(discoveredFiles))
	for _, fp := range discoveredFiles {
		discovered[fp] = struct{}{}
	}

	isTV := lib.Type == models.LibraryShows
	var pruned int64

	if isTV {
		dbPaths, err := s.queries.GetEpisodeFilePathsForLibrary(ctx, lib.ID)
		if err != nil {
			return 0, err
		}
		var staleIDs []int64
		shielded := 0
		for path, id := range dbPaths {
			if _, exists := discovered[path]; exists {
				continue
			}
			if underAnyPrefix(path, unreadablePaths) {
				// Absent from the walk only because we could not read its
				// directory — not evidence the file is gone.
				shielded++
				continue
			}
			staleIDs = append(staleIDs, id)
			slog.Info("pruning deleted episode file", "path", path)
		}
		if shielded > 0 {
			slog.Warn("prune: kept rows under unreadable paths", "library", lib.Name,
				"kept", shielded, "unreadable", boundedPaths(unreadablePaths, 5))
		}
		if len(staleIDs) > 0 {
			n, err := s.queries.DeleteEpisodeFilesByIDs(ctx, staleIDs)
			if err != nil {
				return 0, err
			}
			pruned = n
		}
	} else {
		dbPaths, err := s.queries.GetMediaFilePathsForLibrary(ctx, lib.ID)
		if err != nil {
			return 0, err
		}
		var staleIDs []int64
		shielded := 0
		for path, id := range dbPaths {
			if _, exists := discovered[path]; exists {
				continue
			}
			if underAnyPrefix(path, unreadablePaths) {
				shielded++
				continue
			}
			staleIDs = append(staleIDs, id)
			slog.Info("pruning deleted media file", "path", path)
		}
		if shielded > 0 {
			slog.Warn("prune: kept rows under unreadable paths", "library", lib.Name,
				"kept", shielded, "unreadable", boundedPaths(unreadablePaths, 5))
		}
		if len(staleIDs) > 0 {
			n, err := s.queries.DeleteMediaFilesByIDs(ctx, staleIDs)
			if err != nil {
				return 0, err
			}
			pruned = n
		}
	}

	return pruned, nil
}

// maxTrackedUnreadable bounds how many unreadable paths we remember for
// prune-scoping. Beyond this the caller falls back to skipping the prune for
// the whole library: a mount that fails wholesale should not be handled by
// accumulating a million paths, and at that scale the "everything else walked
// cleanly" assumption the scoping rests on no longer holds.
const maxTrackedUnreadable = 1000

// collectVideoFiles walks root and returns the video files it found plus the
// paths it could NOT read (permission errors, I/O failures, a subtree whose
// mount dropped mid-walk). A non-empty unreadable list means the file list is
// INCOMPLETE for those subtrees — which is what lets the caller prune the rest
// of the library safely instead of skipping the prune wholesale. See
// pruneDeletedFiles.
func collectVideoFiles(root string) ([]string, []string, error) {
	// 2026-05-19 audit (BE-H3) — defend against symlinked files that
	// escape the library root. filepath.WalkDir (Go 1.21+) does NOT
	// follow directory symlinks, but it DOES traverse FILE-level
	// symlinks normally — if a file under root is a symlink to
	// /etc/passwd or anywhere outside root, IsVideoFile() decides
	// based on the symlink name's extension and we'd hash+scan the
	// target. Resolve each candidate and require it to live under
	// the root we were asked to scan; reject otherwise.
	//
	// EvalSymlinks on the root itself ensures the comparison uses the
	// resolved, canonical form (the LibraryHandler already did this on
	// path creation, but defensively re-resolve here so this helper
	// is self-contained).
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, nil, fmt.Errorf("resolve root: %w", err)
	}
	resolvedRoot = filepath.Clean(resolvedRoot)
	var files []string
	var unreadable []string
	noteUnreadable := func(path string) {
		if len(unreadable) < maxTrackedUnreadable {
			unreadable = append(unreadable, filepath.Clean(path))
		}
	}
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// deep-debug H9 addendum — count the failure instead of silently
			// absorbing it. Returning nil keeps the walk going (we still want
			// to scan every readable file), but the caller must know the file
			// list is incomplete: pruning against a partial list would delete
			// the DB rows for everything under an unreadable subtree.
			// Record WHICH path failed, not just that one did: everything
			// under an unreadable subtree is unknown to the prune, but the
			// rest of the library walked cleanly and is still safe to prune.
			noteUnreadable(path)
			slog.Warn("walk error", "path", path, "error", err)
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !IsVideoFile(path) {
			return nil
		}
		// Resolve the file's path to catch symlink-escapes. A file
		// that's a symlink to something outside the library root
		// must not be processed.
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			// Distinguish "genuinely gone" from "can't verify". A dangling
			// symlink (or a file deleted mid-walk) is safe for the prune to
			// treat as absent. Any other failure (EACCES, EIO) means the
			// file may well still exist — count it so the prune is skipped,
			// otherwise this skip silently shrinks the discovered list and
			// the prune deletes the row of a file that is still on disk.
			if !errors.Is(err, fs.ErrNotExist) {
				noteUnreadable(path)
			}
			slog.Warn("skip: resolve symlink failed", "path", path, "error", err)
			return nil
		}
		resolved = filepath.Clean(resolved)
		if !strings.HasPrefix(resolved, resolvedRoot+string(filepath.Separator)) && resolved != resolvedRoot {
			slog.Warn("skip: symlink escapes library root", "path", path, "resolved", resolved, "root", resolvedRoot)
			return nil
		}
		files = append(files, path)
		return nil
	})
	return files, unreadable, walkErr
}

// underAnyPrefix reports whether path lives at or beneath one of prefixes.
// Compares on path boundaries so "/media/CSI - Miami" does not shield
// "/media/CSI - Miami 2".
func underAnyPrefix(path string, prefixes []string) bool {
	if len(prefixes) == 0 {
		return false
	}
	clean := filepath.Clean(path)
	for _, p := range prefixes {
		if clean == p || strings.HasPrefix(clean, p+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func generateFileHash(path string) (string, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", 0, err
	}
	data := fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
	hash := sha256.Sum256([]byte(data))
	return fmt.Sprintf("%x", hash[:16]), info.Size(), nil
}

func (s *Scanner) addMovieFileBatch(ctx context.Context, mf *models.MediaFile) {
	s.batchMu.Lock()
	s.movieFileBuf = append(s.movieFileBuf, mf)
	needFlush := len(s.movieFileBuf) >= batchFlushSize
	s.batchMu.Unlock()
	if needFlush {
		s.flushMovieFiles(ctx)
	}
}

func (s *Scanner) addEpisodeFileBatch(ctx context.Context, ef *models.EpisodeFile) {
	s.batchMu.Lock()
	s.episodeFileBuf = append(s.episodeFileBuf, ef)
	needFlush := len(s.episodeFileBuf) >= batchFlushSize
	s.batchMu.Unlock()
	if needFlush {
		s.flushEpisodeFiles(ctx)
	}
}

func (s *Scanner) flushBatches(ctx context.Context) {
	s.flushMovieFiles(ctx)
	s.flushEpisodeFiles(ctx)
}

func (s *Scanner) flushMovieFiles(ctx context.Context) {
	s.batchMu.Lock()
	files := s.movieFileBuf
	s.movieFileBuf = nil
	s.batchMu.Unlock()
	if len(files) == 0 {
		return
	}
	if err := s.queries.BatchInsertMediaFiles(ctx, files); err != nil {
		slog.Error("batch insert media files failed", "count", len(files), "error", err)
	}
}

func (s *Scanner) flushEpisodeFiles(ctx context.Context) {
	s.batchMu.Lock()
	files := s.episodeFileBuf
	s.episodeFileBuf = nil
	s.batchMu.Unlock()
	if len(files) == 0 {
		return
	}
	if err := s.queries.BatchInsertEpisodeFiles(ctx, files); err != nil {
		slog.Error("batch insert episode files failed", "count", len(files), "error", err)
	}
}

// ClassifyVersion determines the quality tier tag for a media file based on
// its resolution string (from ffprobe or parser) and optional video codec.
// Returns one of: "4K", "1080p", "720p", "SD", or "" if unknown.
func ClassifyVersion(resolution, videoCodec string) string {
	if resolution == "" {
		return ""
	}

	res := strings.ToLower(resolution)

	// Check ffprobe format "WIDTHxHEIGHT"
	if parts := strings.SplitN(res, "x", 2); len(parts) == 2 {
		w, errW := strconv.Atoi(parts[0])
		h, errH := strconv.Atoi(parts[1])
		if errW == nil && errH == nil {
			if w >= 3840 || h >= 2160 {
				return "4K"
			}
			if w >= 1920 || h >= 1080 {
				return "1080p"
			}
			if w >= 1280 || h >= 720 {
				return "720p"
			}
			return "SD"
		}
	}

	// Check parser format: "2160p", "4k", "1080p", "720p", etc.
	if strings.Contains(res, "2160") || strings.Contains(res, "4k") {
		return "4K"
	}
	if strings.Contains(res, "1080") {
		return "1080p"
	}
	if strings.Contains(res, "720") {
		return "720p"
	}
	if strings.Contains(res, "480") || strings.Contains(res, "576") || strings.Contains(res, "360") {
		return "SD"
	}

	return ""
}

func containerFromExt(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	if len(ext) > 0 {
		return ext[1:]
	}
	return ""
}
