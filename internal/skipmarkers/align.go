package skipmarkers

import "sort"

// Alignment tuning. Frame counts derive from sigFramesPerSec (~15.6/s).
const (
	// A signature frame "matches" when at most this many of its 32
	// bits differ. Identical audio through different encoders lands
	// around 0–6 differing bits; unrelated audio averages 16.
	matchBitThreshold = 9

	// Shared windows shorter than this are noise, not intros/recaps.
	minSharedSec = 12.0
	// ... and longer than this are bulk-duplicate content (re-used
	// footage, duplicate files), not a skippable opener.
	maxSharedSec = 240.0

	// Runs may bridge brief mismatches (scene-change frames, encoder
	// hiccups) up to this long without splitting.
	maxRunGapSec = 1.5

	// Run EDGES must be dense: an edge match whose nearest neighbor is
	// further than this many frames away is a random coincidence
	// (P(frame match | unrelated audio) ≈ 1%) and gets trimmed, so a
	// lucky lone match can't stretch a marker past the real intro
	// boundary by up to maxRunGapSec.
	maxEdgeGapFrames = 2

	// Minimum fraction of matching frames within an accepted run.
	minRunDensity = 0.7

	// How many distinct lags to inspect per pair. The best lag finds
	// the intro; additional lags catch a recap that sits at a
	// different relative offset in the two episodes.
	maxLagsPerPair = 4
	// Candidate lags closer than this collapse into one — they
	// describe the same alignment, off by jitter. Real jitter is a
	// few frames; keep this tight so a recap whose lag sits near the
	// intro's (similar-length openers) isn't swallowed.
	lagCollapseSec = 2.0
)

func secToFrames(sec float64) int {
	return int(sec * sigFramesPerSec)
}

// sharedWindow is one stretch of (near-)identical audio found between
// two signatures, in signature-frame coordinates of each side.
// Half-open intervals: [aStart, aEnd) and [bStart, bEnd).
type sharedWindow struct {
	aStart, aEnd int
	bStart, bEnd int
	// score is the fraction of matching frames inside the run (0..1).
	score float64
}

func (w sharedWindow) frames() int { return w.aEnd - w.aStart }

// matchWindows cross-correlates two signatures and returns the shared
// audio windows (best first). Pure function — all the DSP heavy
// lifting happens here, on data, so it is directly unit-testable.
func matchWindows(a, b []uint32) []sharedWindow {
	minRun := secToFrames(minSharedSec)
	if len(a) < minRun || len(b) < minRun {
		return nil
	}

	// Pass 1 — score every lag by how many frames match along its
	// diagonal. lag L aligns a[i] with b[i-L].
	loLag := -(len(b) - minRun)
	hiLag := len(a) - minRun
	type lagScore struct {
		lag, matches int
	}
	scores := make([]lagScore, 0, hiLag-loLag+1)
	for lag := loLag; lag <= hiLag; lag++ {
		iStart := max(0, lag)
		iEnd := min(len(a), len(b)+lag)
		if iEnd-iStart < minRun {
			continue
		}
		matches := 0
		for i := iStart; i < iEnd; i++ {
			if hammingDist32(a[i], b[i-lag]) <= matchBitThreshold {
				matches++
			}
		}
		if matches >= minRun {
			scores = append(scores, lagScore{lag: lag, matches: matches})
		}
	}
	if len(scores) == 0 {
		return nil
	}
	sort.Slice(scores, func(i, j int) bool { return scores[i].matches > scores[j].matches })

	// Pass 2 — pick the top lags (separated by lagCollapseSec) and
	// extract contiguous match runs along each.
	collapse := secToFrames(lagCollapseSec)
	var picked []int
	for _, s := range scores {
		tooClose := false
		for _, p := range picked {
			if abs(s.lag-p) < collapse {
				tooClose = true
				break
			}
		}
		if tooClose {
			continue
		}
		picked = append(picked, s.lag)
		if len(picked) >= maxLagsPerPair {
			break
		}
	}

	var windows []sharedWindow
	for _, lag := range picked {
		windows = append(windows, extractRuns(a, b, lag)...)
	}

	// Drop windows that duplicate a better window's A-side span
	// (different lags can rediscover the same stretch).
	sort.Slice(windows, func(i, j int) bool {
		if windows[i].frames() != windows[j].frames() {
			return windows[i].frames() > windows[j].frames()
		}
		return windows[i].score > windows[j].score
	})
	var out []sharedWindow
	for _, w := range windows {
		dup := false
		for _, kept := range out {
			if overlapFrames(w.aStart, w.aEnd, kept.aStart, kept.aEnd) > w.frames()/2 {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, w)
		}
	}
	return out
}

// extractRuns walks one lag's diagonal and returns the qualifying
// match runs: gap-bridged, density-checked, edges trimmed to DENSE
// matching frames (isolated edge matches are coincidences).
func extractRuns(a, b []uint32, lag int) []sharedWindow {
	iStart := max(0, lag)
	iEnd := min(len(a), len(b)+lag)
	minRun := secToFrames(minSharedSec)
	maxRun := secToFrames(maxSharedSec)
	maxGap := secToFrames(maxRunGapSec)

	// Collect every matching frame position along the diagonal, then
	// segment into runs wherever the gap exceeds maxGap.
	var positions []int
	for i := iStart; i < iEnd; i++ {
		if hammingDist32(a[i], b[i-lag]) <= matchBitThreshold {
			positions = append(positions, i)
		}
	}

	var runs []sharedWindow
	flush := func(seg []int) {
		// Trim isolated edge matches: a boundary match further than
		// maxEdgeGapFrames from its neighbor is random noise, while
		// genuinely shared audio matches nearly every frame.
		for len(seg) >= 2 && seg[1]-seg[0] > maxEdgeGapFrames {
			seg = seg[1:]
		}
		for len(seg) >= 2 && seg[len(seg)-1]-seg[len(seg)-2] > maxEdgeGapFrames {
			seg = seg[:len(seg)-1]
		}
		if len(seg) == 0 {
			return
		}
		length := seg[len(seg)-1] - seg[0] + 1
		if length >= minRun && length <= maxRun &&
			float64(len(seg))/float64(length) >= minRunDensity {
			runs = append(runs, sharedWindow{
				aStart: seg[0], aEnd: seg[len(seg)-1] + 1,
				bStart: seg[0] - lag, bEnd: seg[len(seg)-1] + 1 - lag,
				score: float64(len(seg)) / float64(length),
			})
		}
	}
	segStart := 0
	for k := 1; k <= len(positions); k++ {
		if k == len(positions) || positions[k]-positions[k-1] > maxGap {
			flush(positions[segStart:k])
			segStart = k
		}
	}
	return runs
}

func overlapFrames(aLo, aHi, bLo, bHi int) int {
	lo := max(aLo, bLo)
	hi := min(aHi, bHi)
	if hi <= lo {
		return 0
	}
	return hi - lo
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
