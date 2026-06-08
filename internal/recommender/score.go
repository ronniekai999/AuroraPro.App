// Aurora Score — a proprietary 0..100 "feature-worthiness" score for media
// items, computed from signals AuroraPro actually owns rather than a rescaled
// TMDB rating.
//
// The score is a weighted blend of independent sub-signals (Phase 1 ships two;
// Phase 2 adds local engagement), standardized against the library's own
// distribution and squashed through a logistic so the displayed numbers spread
// across the full range instead of pinning in the 80s–90s.
//
// Two ideas do the heavy lifting:
//
//  1. Bayesian shrinkage (IMDb's weighted-rating formula). A raw 9.1 from 12
//     votes shouldn't outrank an 8.4 from 40k. Each rating is pulled toward the
//     library mean in proportion to how few votes back it, so low-confidence
//     ratings stop dominating.
//
//  2. z-score → logistic calibration. The old code clamped a single signal into
//     a flattering [82,98] band, which is why every hero read the same. Here the
//     composite is standardized against the eligible library (mean/σ) and mapped
//     through a logistic: the library median reads ~50, clearly-good titles
//     ~70, elite ~90, weak ~30. Spread is produced by construction, and a 94
//     means "top of THIS library", not "TMDB ≥ 9".
//
// All functions here are pure (time is passed in, never read) so the math is
// unit-testable; the DB plumbing and caching live in hero.go.
package recommender

import (
	"math"
	"time"

	"github.com/aurora-media/aurora/internal/db"
)

// scoreWeights controls the Aurora Score blend. Phase 1 uses quality +
// freshness; Phase 2 wires in heat / affinity / completion. Weights need NOT
// sum to 1: the composite is z-scored against the library before display, so
// only the RELATIVE sizes matter (they set how much each signal drives the
// spread). Quality is intentionally dominant.
type scoreWeights struct {
	quality    float64
	freshness  float64
	heat       float64 // Phase 2
	affinity   float64 // Phase 2
	completion float64 // Phase 2
}

// defaultWeights is the live blend. Phase 1: quality-dominant with a freshness
// nudge so just-released / just-added titles don't read identically to decade-
// old catalog. The Phase 2 weights are 0 until their signals are wired so the
// composite is well-defined at every phase.
var defaultWeights = scoreWeights{
	quality:   0.75,
	freshness: 0.25,
}

const (
	// bayesPriorVotes (m) is the shrinkage strength: an item needs ~this many
	// TMDB votes before its own rating outweighs the library mean. 250 keeps
	// obscure-but-highly-rated titles (a 9.2 from 30 votes) from leapfrogging
	// well-established ones while letting anything with real vote volume keep
	// its rating.
	bayesPriorVotes = 250.0

	// freshnessReleaseScaleYears is the e-folding time for release recency: a
	// brand-new title scores ~1.0, an 8-year-old one ~0.37, a 16-year-old one
	// ~0.13. Catalog depth still scores (never 0) so freshness nudges rather
	// than dominates.
	freshnessReleaseScaleYears = 8.0

	// freshnessAddedScaleDays is the e-folding time for "new to THIS library":
	// just-scanned titles read ~1.0 and decay to ~0.37 over ~6 weeks. This is
	// what surfaces a freshly-added film in the hero before it's buried.
	freshnessAddedScaleDays = 45.0

	// auroraLogisticK sets how steeply the standardized composite maps to the
	// 0..100 display. With k=0.9: median (z=0)→50, +1σ→71, +2σ→86, +3σ→94,
	// −1σ→29. Bigger k = more contrast (top items pushed toward 100); smaller
	// k = flatter. This is the single spread-tuning knob.
	auroraLogisticK = 0.9

	// neutralRatingMean is the Bayesian prior used only when the library stats
	// can't be computed yet (empty/error). 7.0 mirrors TMDB's global mean so a
	// cold deployment still produces sane shrinkage.
	neutralRatingMean = 7.0
)

// bayesianQuality shrinks a raw rating toward `mean` by vote count — IMDb's
// weighted-rating formula WR = (v·R + m·C)/(v + m). Result stays on the input's
// 0..10 scale. votes<0 is treated as 0; m<=0 disables shrinkage (returns R).
func bayesianQuality(rating float64, votes int, mean, m float64) float64 {
	if m <= 0 {
		return rating
	}
	v := float64(votes)
	if v < 0 {
		v = 0
	}
	return (v*rating + m*mean) / (v + m)
}

// decay returns exp(-age/scale): 1.0 at age 0, ~0.37 at age==scale, asymptotic
// to 0. Negative ages clamp to 0 (full freshness); scale<=0 disables (returns
// 0) so a misconfigured constant can't divide by zero.
func decay(age, scale float64) float64 {
	if scale <= 0 {
		return 0
	}
	if age < 0 {
		age = 0
	}
	return math.Exp(-age / scale)
}

// freshness is a 0..1 recency signal: the stronger of "recently released" and
// "recently added to the library". Either input may be absent (year==0 /
// zero time) and contributes 0; if both are absent the item reads 0 (no
// freshness boost, not a penalty — the z-score handles the baseline).
func freshness(releaseYear int, addedAt, now time.Time) float64 {
	var rel, add float64
	if releaseYear > 0 {
		rel = decay(float64(now.Year()-releaseYear), freshnessReleaseScaleYears)
	}
	if !addedAt.IsZero() {
		add = decay(now.Sub(addedAt).Hours()/24, freshnessAddedScaleDays)
	}
	return math.Max(rel, add)
}

// coreScore is the raw (pre-display) Aurora composite for one item. Takes
// primitives so it's testable without DB types. quality is the Bayesian-shrunk
// rating normalized to 0..1; freshness is 0..1. The result is an unbounded-ish
// weighted sum that only becomes a 0..100 number after standardization in
// auroraDisplay.
func coreScore(rating float64, votes, releaseYear int, addedAt, now time.Time, ratingMean float64, w scoreWeights) float64 {
	q := bayesianQuality(rating, votes, ratingMean, bayesPriorVotes) / 10.0
	f := freshness(releaseYear, addedAt, now)
	return w.quality*q + w.freshness*f
}

// auroraDisplay maps a raw composite to the 0..100 ring value by standardizing
// against the library distribution (z-score) then squashing through a logistic.
// This is what produces real spread. A degenerate library (σ≈0, every item
// identical) returns 50 rather than dividing by zero. Output is clamped to
// [1,100] so a real score is never 0 (which the frontend reads as "no score").
func auroraDisplay(core, mean, std float64) int {
	if std <= 1e-9 {
		return 50
	}
	z := (core - mean) / std
	p := 1.0 / (1.0 + math.Exp(-auroraLogisticK*z))
	return clampInt(int(math.Round(p*100)), 1, 100)
}

// libraryScoreStats is the per-deployment calibration for the Aurora Score: the
// mean rating used as the Bayesian prior, and the mean/σ of the raw composite
// used to z-score it for display. Global (identical for every profile), so it's
// computed once and cached on a TTL rather than per hero build.
type libraryScoreStats struct {
	ratingMean float64 // C — Bayesian prior (mean rating over eligible items)
	coreMean   float64 // μ of the composite
	coreStd    float64 // σ of the composite
	n          int     // eligible item count (0 ⇒ neutral fallback in use)
	builtAt    time.Time
}

// neutralScoreStats is used when the eligible-rows query fails or the library
// is empty: a prior-only calibration where σ=1 so auroraDisplay still returns
// finite values (everything reads near 50 until real stats land).
func neutralScoreStats(now time.Time) libraryScoreStats {
	return libraryScoreStats{ratingMean: neutralRatingMean, coreMean: 0, coreStd: 1, n: 0, builtAt: now}
}

// computeLibraryScoreStats derives the calibration from the eligible library
// rows. Two passes: first the mean rating (the Bayesian prior C), then the
// mean/σ of every item's composite computed against that prior. `now` is passed
// so freshness is evaluated at a single consistent instant.
func computeLibraryScoreStats(rows []db.ScoreRow, now time.Time, w scoreWeights) libraryScoreStats {
	n := len(rows)
	if n == 0 {
		return neutralScoreStats(now)
	}
	var sumR float64
	for _, r := range rows {
		sumR += r.Rating
	}
	c := sumR / float64(n)

	cores := make([]float64, n)
	var sumC float64
	for i, r := range rows {
		cores[i] = coreScore(r.Rating, r.VoteCount, r.ReleaseYear, r.AddedAt, now, c, w)
		sumC += cores[i]
	}
	mu := sumC / float64(n)

	var ss float64
	for _, v := range cores {
		d := v - mu
		ss += d * d
	}
	std := math.Sqrt(ss / float64(n))

	return libraryScoreStats{ratingMean: c, coreMean: mu, coreStd: std, n: n, builtAt: now}
}

// clampInt bounds v to [lo,hi].
func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
