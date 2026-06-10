package skipmarkers

import (
	"context"
	"log/slog"
	"sort"

	"github.com/aurora-media/aurora/internal/models"
)

// Season-level orchestration: decode → align consecutive episodes →
// validate the season actually HAS a recurring opener → emit per-file
// intro/recap markers. Credits are detected separately per file by the
// worker (they don't need cross-episode evidence).

const (
	// A season's intro is only trusted when at least this many episode
	// pairs found a shared window of consistent length ("Confirm
	// across >=2 pairs in the season to reject coincidences").
	minConfirmingPairs = 2

	// Tolerance when comparing a pair's window length to the season
	// median: within max(introLenSlackSec, introLenSlackFrac*median).
	introLenSlackSec  = 10.0
	introLenSlackFrac = 0.4

	// Windows whose gap is below this merge into one (v1 may merge a
	// recap into the intro when they're contiguous).
	mergeGapSec = 3.0

	// Confidence levels: corroborated by both adjacent episodes vs a
	// single pair within an already-validated season.
	confidenceCorroborated = 0.85
	confidenceSinglePair   = 0.65

	// endPadMs widens the marker tail by roughly one analysis frame so
	// the post-skip seek lands after the theme's final note instead of
	// on it.
	endPadMs = 250
)

// SeasonFile is the analyzer's view of one episode file.
type SeasonFile struct {
	FileID        int64
	EpisodeNumber int
	Path          string
	DurationMs    int64
	// Pending: this file still needs markers written. Non-pending
	// files participate as alignment material only.
	Pending bool
}

// signatureFn supplies the audio fingerprint for a file. Injected so
// the analyzer is testable without FFmpeg or real media.
type signatureFn func(ctx context.Context, f SeasonFile) ([]uint32, error)

// fileWindow is a candidate shared-audio window in one file's own
// signature-frame coordinates.
type fileWindow struct {
	start, end int
	score      float64
}

// analyzeSeasonIntros computes intro/recap markers for every PENDING
// file in the season. Returns a map keyed by file ID; pending files
// where nothing was detected are present with a nil slice so the
// caller can distinguish "analyzed, nothing found" from "not
// processed".
func analyzeSeasonIntros(ctx context.Context, files []SeasonFile, sigFor signatureFn) map[int64][]models.SkipMarker {
	out := make(map[int64][]models.SkipMarker)
	for _, f := range files {
		if f.Pending {
			out[f.FileID] = nil
		}
	}

	// Group files by episode; the first file of each episode is its
	// "primary" — the representative the neighbors align against.
	byEpisode := map[int][]SeasonFile{}
	var epNums []int
	for _, f := range files {
		if _, seen := byEpisode[f.EpisodeNumber]; !seen {
			epNums = append(epNums, f.EpisodeNumber)
		}
		byEpisode[f.EpisodeNumber] = append(byEpisode[f.EpisodeNumber], f)
	}
	sort.Ints(epNums)
	// Fewer than 3 episodes can't produce the 2 confirming pairs the
	// validation gate requires ("never guesses from one episode" — or
	// from a single pair).
	if len(epNums) < 3 {
		return out
	}

	// Lazy signature cache; failed decodes are cached too so a corrupt
	// file is decoded (and logged) once per sweep, not once per pair.
	sigs := map[int64][]uint32{}
	failed := map[int64]bool{}
	sig := func(f SeasonFile) []uint32 {
		if s, ok := sigs[f.FileID]; ok {
			return s
		}
		if failed[f.FileID] {
			return nil
		}
		s, err := sigFor(ctx, f)
		if err != nil {
			slog.Warn("skipmarkers: signature failed", "file_id", f.FileID, "path", f.Path, "error", err)
			failed[f.FileID] = true
			return nil
		}
		sigs[f.FileID] = s
		return s
	}
	primary := func(epNum int) SeasonFile { return byEpisode[epNum][0] }

	// Align consecutive primaries. pairWins[k] holds the shared
	// windows between primary(epNums[k]) and primary(epNums[k+1]).
	pairWins := make([][]sharedWindow, len(epNums)-1)
	for k := 0; k+1 < len(epNums); k++ {
		if ctx.Err() != nil {
			return out
		}
		a, b := sig(primary(epNums[k])), sig(primary(epNums[k+1]))
		if a == nil || b == nil {
			continue
		}
		pairWins[k] = matchWindows(a, b)
	}

	// Season validation: enough pairs must agree on a shared window of
	// consistent length before ANY marker is trusted.
	medianLen, confirming := validateSeason(pairWins)
	if confirming < minConfirmingPairs {
		slog.Debug("skipmarkers: season not validated",
			"episodes", len(epNums), "confirming_pairs", confirming)
		return out
	}

	// Emit markers for each pending file from its alignments with the
	// adjacent episodes' primaries.
	for k, epNum := range epNums {
		for fi, f := range byEpisode[epNum] {
			if !f.Pending {
				continue
			}
			if ctx.Err() != nil {
				return out
			}
			var fromPrev, fromNext []fileWindow
			isPrimary := fi == 0
			if isPrimary {
				// Reuse the primary-pair alignments computed above.
				if k > 0 {
					for _, w := range pairWins[k-1] {
						fromPrev = append(fromPrev, fileWindow{start: w.bStart, end: w.bEnd, score: w.score})
					}
				}
				if k < len(pairWins) {
					for _, w := range pairWins[k] {
						fromNext = append(fromNext, fileWindow{start: w.aStart, end: w.aEnd, score: w.score})
					}
				}
			} else {
				// Secondary version of the episode (4K + 1080p, etc.):
				// align it directly against the neighbor primaries so a
				// shifted cut (extended edition) still gets accurate
				// offsets in ITS OWN timeline.
				if sf := sig(f); sf != nil {
					if k > 0 {
						if sp := sig(primary(epNums[k-1])); sp != nil {
							for _, w := range matchWindows(sf, sp) {
								fromPrev = append(fromPrev, fileWindow{start: w.aStart, end: w.aEnd, score: w.score})
							}
						}
					}
					if k+1 < len(epNums) {
						if sp := sig(primary(epNums[k+1])); sp != nil {
							for _, w := range matchWindows(sf, sp) {
								fromNext = append(fromNext, fileWindow{start: w.aStart, end: w.aEnd, score: w.score})
							}
						}
					}
				}
			}
			out[f.FileID] = classifyWindows(fromPrev, fromNext, medianLen, f.DurationMs)
		}
	}
	return out
}

// validateSeason returns the median length (frames) of each pair's
// longest shared window and how many pairs corroborate that length.
func validateSeason(pairWins [][]sharedWindow) (medianLen int, confirming int) {
	var lens []int
	for _, wins := range pairWins {
		best := 0
		for _, w := range wins {
			if w.frames() > best {
				best = w.frames()
			}
		}
		if best > 0 {
			lens = append(lens, best)
		}
	}
	if len(lens) < minConfirmingPairs {
		return 0, len(lens)
	}
	sort.Ints(lens)
	medianLen = lens[len(lens)/2]
	slack := max(secToFrames(introLenSlackSec), int(introLenSlackFrac*float64(medianLen)))
	for _, l := range lens {
		if abs(l-medianLen) <= slack {
			confirming++
		}
	}
	return medianLen, confirming
}

// classifyWindows merges one file's candidate windows from its two
// neighbor alignments and labels them: the window closest to the
// season's intro length is the INTRO; an earlier distinct window is
// the RECAP. Windows are corroborated (higher confidence) when both
// neighbors found them.
func classifyWindows(fromPrev, fromNext []fileWindow, medianLen int, durationMs int64) []models.SkipMarker {
	merged := mergeCorroborated(fromPrev, fromNext)
	if len(merged) == 0 {
		return nil
	}

	// Pick the intro: window length closest to the season median,
	// within the same slack the validation gate used.
	slack := max(secToFrames(introLenSlackSec), int(introLenSlackFrac*float64(medianLen)))
	introIdx, bestDelta := -1, slack+1
	for i, w := range merged {
		delta := abs((w.win.end - w.win.start) - medianLen)
		if delta <= slack && delta < bestDelta {
			introIdx, bestDelta = i, delta
		}
	}
	if introIdx < 0 {
		return nil
	}
	intro := merged[introIdx]

	// Recap: the longest OTHER window that ends before the intro
	// starts. If it's contiguous with the intro, fold them together.
	recapIdx := -1
	for i, w := range merged {
		if i == introIdx || w.win.start >= intro.win.start {
			continue
		}
		if recapIdx < 0 || (w.win.end-w.win.start) > (merged[recapIdx].win.end-merged[recapIdx].win.start) {
			recapIdx = i
		}
	}

	var markers []models.SkipMarker
	mk := func(kind string, w fileWindow, corroborated bool) models.SkipMarker {
		conf := confidenceSinglePair
		if corroborated {
			conf = confidenceCorroborated
		}
		startMs := sigFrameToMs(w.start)
		endMs := sigFrameToMs(w.end) + endPadMs
		if durationMs > 0 && endMs > durationMs {
			endMs = durationMs
		}
		return models.SkipMarker{Kind: kind, StartMs: startMs, EndMs: endMs, Confidence: conf, Detector: Detector}
	}

	if recapIdx >= 0 {
		recap := merged[recapIdx]
		gap := intro.win.start - recap.win.end
		if gap <= secToFrames(mergeGapSec) {
			// Contiguous recap+intro: one combined intro marker.
			combined := fileWindow{start: recap.win.start, end: intro.win.end, score: intro.win.score}
			return []models.SkipMarker{mk("intro", combined, intro.corroborated && recap.corroborated)}
		}
		markers = append(markers, mk("recap", recap.win, recap.corroborated))
	}
	markers = append(markers, mk("intro", intro.win, intro.corroborated))
	return markers
}

type mergedWindow struct {
	win          fileWindow
	corroborated bool
}

// mergeCorroborated unions overlapping windows discovered from the two
// neighbor alignments, flagging windows both sides agree on.
func mergeCorroborated(fromPrev, fromNext []fileWindow) []mergedWindow {
	var all []mergedWindow
	for _, w := range fromPrev {
		all = append(all, mergedWindow{win: w})
	}
nextWin:
	for _, w := range fromNext {
		for i := range all {
			if overlapFrames(w.start, w.end, all[i].win.start, all[i].win.end) > 0 {
				// Union the spans; both neighbors saw this audio.
				all[i].win.start = min(all[i].win.start, w.start)
				all[i].win.end = max(all[i].win.end, w.end)
				if w.score > all[i].win.score {
					all[i].win.score = w.score
				}
				all[i].corroborated = true
				continue nextWin
			}
		}
		all = append(all, mergedWindow{win: w})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].win.start < all[j].win.start })
	return all
}
