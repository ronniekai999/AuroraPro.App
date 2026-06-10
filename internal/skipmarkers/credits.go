package skipmarkers

import (
	"bufio"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Credits detection: find where the end credits start by looking for
// the black-frame / silence character of a credit roll in the file's
// tail. Heuristic and conservative — the marker only powers an
// advisory button / next-up card, never a forced seek, so "no marker"
// is always an acceptable outcome.
const (
	// Analyze at most this much tail (and at least creditsTailMinSec,
	// duration permitting).
	creditsTailMaxSec = 600.0
	creditsTailMinSec = 120.0
	// Fraction of the duration the tail window covers when the file is
	// long enough for the fraction to exceed creditsTailMinSec.
	creditsTailFrac = 0.15

	// Files shorter than this skip credits detection entirely.
	creditsMinDurationSec = 300.0

	// Credits never start before this fraction of the runtime.
	creditsEarliestFrac = 0.60
	// Silence-only evidence (no black frame) is weaker, and a quiet
	// finale's long silent stretch could otherwise be mistaken for
	// credits as early as creditsEarliestFrac — with auto-advance,
	// that false positive skips a large chunk of the episode. Cap the
	// silence-only blast radius to the last quarter of the runtime.
	creditsSilenceEarliestFrac = 0.75

	// A credits onset must leave at least this much tail...
	creditsMinLenSec = 15.0

	// Acceptance: fraction of [onset, EOF] covered by black/silence.
	creditsBlackCoverage   = 0.35 // black onset (strong signal)
	creditsSilenceCoverage = 0.55 // silence-only fallback (weaker)
)

// timeRange is a [start, end) interval in seconds.
type timeRange struct{ start, end float64 }

// parseDetectOutput extracts blackdetect/silencedetect intervals from
// FFmpeg's stderr. Tolerates interleaved unrelated log lines; an
// unterminated final silence (file ends silent) is closed at +Inf and
// clamped by the caller.
//
// Line shapes (FFmpeg 4–7):
//
//	[blackdetect @ 0x...] black_start:123.456 black_end:130 black_duration:6.544
//	[silencedetect @ 0x...] silence_start: 123.456
//	[silencedetect @ 0x...] silence_end: 130.2 | silence_duration: 6.744
func parseDetectOutput(stderr string) (black, silence []timeRange) {
	var openSilence = math.NaN()
	sc := bufio.NewScanner(strings.NewReader(stderr))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.Contains(line, "black_start:"):
			s, okS := parseDetectField(line, "black_start:")
			e, okE := parseDetectField(line, "black_end:")
			if okS && okE && e > s {
				black = append(black, timeRange{s, e})
			}
		case strings.Contains(line, "silence_start:"):
			if s, ok := parseDetectField(line, "silence_start:"); ok {
				openSilence = s
			}
		case strings.Contains(line, "silence_end:"):
			if e, ok := parseDetectField(line, "silence_end:"); ok && !math.IsNaN(openSilence) && e > openSilence {
				silence = append(silence, timeRange{openSilence, e})
				openSilence = math.NaN()
			}
		}
	}
	if !math.IsNaN(openSilence) {
		silence = append(silence, timeRange{openSilence, math.Inf(1)})
	}
	return black, silence
}

// parseDetectField pulls the float that follows `key` in a detect log
// line. FFmpeg emits both "key:1.5" and "key: 1.5" depending on the
// filter, so whitespace after the key is skipped.
func parseDetectField(line, key string) (float64, bool) {
	idx := strings.Index(line, key)
	if idx < 0 {
		return 0, false
	}
	rest := strings.TrimSpace(line[idx+len(key):])
	end := 0
	for end < len(rest) {
		c := rest[end]
		if (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '+' {
			end++
			continue
		}
		break
	}
	v, err := strconv.ParseFloat(rest[:end], 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// creditsTailSec returns how much tail to analyze for a file of the
// given duration, or 0 when the file is too short to bother.
func creditsTailSec(durationSec float64) float64 {
	if durationSec < creditsMinDurationSec {
		return 0
	}
	tail := durationSec * creditsTailFrac
	if tail < creditsTailMinSec {
		tail = creditsTailMinSec
	}
	if tail > creditsTailMaxSec {
		tail = creditsTailMaxSec
	}
	if tail > durationSec {
		tail = durationSec
	}
	return tail
}

// creditsOnsetFromRanges picks the credits start from detected black /
// silence intervals (absolute seconds). Strategy: take the LATEST
// acceptable onset — conservative, marking less rather than more of
// the episode as credits. A black-frame onset is the strong signal;
// silence alone needs higher coverage to qualify.
//
// Returns (onsetSec, confidence, ok). Pure function for testability.
func creditsOnsetFromRanges(black, silence []timeRange, durationSec float64) (float64, float64, bool) {
	if durationSec <= 0 {
		return 0, 0, false
	}
	latest := durationSec - creditsMinLenSec

	combined := append(append([]timeRange(nil), black...), silence...)

	try := func(candidates []timeRange, ranges []timeRange, earliestFrac, needCoverage float64) (float64, float64, bool) {
		earliest := durationSec * earliestFrac
		onsets := make([]float64, 0, len(candidates))
		for _, r := range candidates {
			if r.start >= earliest && r.start <= latest {
				onsets = append(onsets, r.start)
			}
		}
		sort.Sort(sort.Reverse(sort.Float64Slice(onsets)))
		for _, onset := range onsets {
			cov := coverage(ranges, onset, durationSec)
			if cov >= needCoverage {
				conf := 0.4 + 0.5*cov
				if conf > 0.9 {
					conf = 0.9
				}
				return onset, conf, true
			}
		}
		return 0, 0, false
	}

	if onset, conf, ok := try(black, combined, creditsEarliestFrac, creditsBlackCoverage); ok {
		return onset, conf, ok
	}
	return try(silence, silence, creditsSilenceEarliestFrac, creditsSilenceCoverage)
}

// coverage computes what fraction of [from, until] the (possibly
// overlapping, unsorted) ranges cover. Open-ended ranges are clamped
// to `until`.
func coverage(ranges []timeRange, from, until float64) float64 {
	if until <= from {
		return 0
	}
	clamped := make([]timeRange, 0, len(ranges))
	for _, r := range ranges {
		s, e := math.Max(r.start, from), math.Min(r.end, until)
		if e > s {
			clamped = append(clamped, timeRange{s, e})
		}
	}
	sort.Slice(clamped, func(i, j int) bool { return clamped[i].start < clamped[j].start })
	var covered, cursor float64 = 0, from
	for _, r := range clamped {
		if r.end <= cursor {
			continue
		}
		if r.start > cursor {
			cursor = r.start
		}
		covered += r.end - cursor
		cursor = r.end
	}
	return covered / (until - from)
}
