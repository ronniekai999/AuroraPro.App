// Aurora Score — a proprietary 0..100 "feature-worthiness" score for media
// items, computed from signals AuroraPro actually owns rather than a rescaled
// TMDB rating.
//
// The score is a weighted blend of independent sub-signals, standardized
// against the library's own distribution and squashed through a logistic so the
// displayed numbers spread across the full range instead of pinning in the
// 80s–90s.
//
// Signals:
//
//   - quality    — Bayesian-shrunk TMDB rating (IMDb's weighted-rating formula):
//     a 9.1 from 12 votes is pulled toward the library mean so it can't outrank
//     an 8.4 from 40k.
//   - freshness  — release recency + "new to this library" (added_at).
//   - heat       — time-decayed sum of local watch events. The signal nobody
//     else has: what THIS server's viewers are actually watching, now.
//   - affinity   — how many viewers favourited it / how many collections it's in.
//   - completion — Wilson lower bound on finishes/starts: do people who start it
//     actually finish it? Separates "binge-y" from "looked good, everyone bailed".
//
// Two ideas do the heavy lifting:
//
//  1. Bayesian shrinkage + Wilson lower bound stop low-sample signals (few
//     votes, few starts) from dominating with noisy extremes.
//
//  2. z-score → logistic calibration. The old code clamped a single signal into
//     a flattering [82,98] band, which is why every hero read the same. Here the
//     composite is standardized against the eligible library (mean/σ) and mapped
//     through a logistic: median ~50, clearly-good ~70, elite ~90, weak ~30.
//     This also gives graceful degradation for free — on a small/new library the
//     engagement signals are ~constant (≈0 heat, neutral completion) across every
//     item, so they contribute no variance and quality+freshness drive the
//     spread; as real viewing accrues, heat/affinity/completion start to vary and
//     pull their weight.
//
// All functions here are pure (time is passed in, never read) so the math is
// unit-testable; the DB plumbing and caching live in hero.go.
package recommender

import (
	"math"
	"time"

	"github.com/aurora-media/aurora/internal/db"
)

// scoreWeights controls the Aurora Score blend. Weights need NOT sum to 1: the
// composite is z-scored against the library before display, so only the
// RELATIVE sizes matter (they set how much each signal drives the spread).
type scoreWeights struct {
	quality    float64
	freshness  float64
	heat       float64
	affinity   float64
	completion float64
}

// defaultWeights is the live blend. Quality and local engagement (heat +
// completion) lead; freshness and affinity nudge. Tunable — these are the
// single policy knob, and because the composite is z-scored only their ratios
// matter, not their absolute scale.
var defaultWeights = scoreWeights{
	quality:    0.30,
	freshness:  0.10,
	heat:       0.28,
	affinity:   0.14,
	completion: 0.18,
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
	// just-scanned titles read ~1.0 and decay to ~0.37 over ~6 weeks.
	freshnessAddedScaleDays = 45.0

	// heatDecayDays is the e-folding recency of a single watch event in the
	// local-heat signal: a completion today counts ~1.0, one ~30 days ago ~0.37.
	// Passed into the SQL aggregate so the knob lives here, not in the query.
	heatDecayDays = 30.0

	// heatSatScale shapes how decayed heat saturates onto 0..1 (see saturate):
	// heat == heatSatScale → ~0.63. ~6 weighted recent completions reads "hot".
	heatSatScale = 6.0

	// affinitySatScale shapes how favourites+collections saturate onto 0..1.
	affinitySatScale = 4.0

	// collectionAffinityWeight discounts collection membership relative to an
	// explicit favourite — a favourite is a stronger, individual signal than
	// being swept into an admin/AI-built collection.
	collectionAffinityWeight = 0.5

	// wilsonZ is the z-score for the Wilson lower bound (~95% one-sided).
	wilsonZ = 1.96

	// minStartsForCompletion gates the completion-quality signal: below this
	// many starts the finish ratio is too noisy to trust, so we return neutral.
	minStartsForCompletion = 5

	// completionNeutral is the completion-quality value used when starts are
	// below minStartsForCompletion — "no opinion", neither rewarded nor punished.
	completionNeutral = 0.5

	// auroraLogisticK sets how steeply the standardized composite maps to the
	// 0..100 display. With k=0.9: median (z=0)→50, +1σ→71, +2σ→86, +3σ→94,
	// −1σ→29. Bigger k = more contrast. This is the spread-tuning knob.
	auroraLogisticK = 0.9

	// Match v2 bootstrap manifest. Unlike the old pool-relative z-score, this
	// mapping is absolute: identical profile evidence + cosine produces the same
	// value regardless of which other candidates happened to be recalled.
	// These constants are deliberately versioned together (see matchModelVersion)
	// so later outcome-calibrated manifests can replace them atomically.
	matchSemanticSlope    = 11.0
	matchSemanticMidpoint = 0.72
	matchPriorProbability = 0.50
	matchPriorSupport     = 5.0
	matchProbabilityFloor = 0.05
	matchProbabilityCeil  = 0.95

	// neutralRatingMean is the Bayesian prior used only when the library stats
	// can't be computed yet (empty/error). 7.0 mirrors TMDB's global mean.
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
// "recently added to the library". Either input may be absent (year==0 / zero
// time) and contributes 0; if both are absent the item reads 0 (no boost, not a
// penalty — the z-score handles the baseline).
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

// saturate folds a non-negative magnitude onto 0..1 via 1-exp(-x/scale): 0 at
// 0, ~0.63 at x==scale, asymptotic to 1. Used to put unbounded engagement
// counts (heat, favourites) on a comparable scale before blending. x<=0 or
// scale<=0 returns 0.
func saturate(x, scale float64) float64 {
	if scale <= 0 || x <= 0 {
		return 0
	}
	return 1 - math.Exp(-x/scale)
}

// wilsonLower is the lower bound of the Wilson score interval for a binomial
// proportion pos/n at confidence set by z. It answers "given the finishes I've
// observed, what's a conservative estimate of the true finish rate?" so a 2/2
// can't outrank a 180/200. n<=0 returns 0; pos is clamped to [0,n].
func wilsonLower(pos, n int, z float64) float64 {
	if n <= 0 {
		return 0
	}
	if pos < 0 {
		pos = 0
	}
	if pos > n {
		pos = n
	}
	nf := float64(n)
	phat := float64(pos) / nf
	z2 := z * z
	denom := 1 + z2/nf
	centre := phat + z2/(2*nf)
	margin := z * math.Sqrt((phat*(1-phat)+z2/(4*nf))/nf)
	return (centre - margin) / denom
}

// completionQuality is the 0..1 "do people finish it?" signal: the Wilson lower
// bound of finishes/starts, or a neutral 0.5 when starts are too few to trust.
func completionQuality(finishes, starts int) float64 {
	if starts < minStartsForCompletion {
		return completionNeutral
	}
	return wilsonLower(finishes, starts, wilsonZ)
}

// coreScore is the raw (pre-display) Aurora composite for one item: each
// sub-signal folded onto 0..1, then weighted. The result only becomes a 0..100
// number after standardization in auroraDisplay.
func coreScore(r db.ScoreRow, now time.Time, ratingMean float64, w scoreWeights) float64 {
	q := bayesianQuality(r.Rating, r.VoteCount, ratingMean, bayesPriorVotes) / 10.0
	f := freshness(r.ReleaseYear, r.AddedAt, now)
	h := saturate(r.Heat, heatSatScale)
	a := saturate(float64(r.FavCount)+collectionAffinityWeight*float64(r.CollectionCount), affinitySatScale)
	c := completionQuality(r.Finishes, r.Starts)
	return w.quality*q + w.freshness*f + w.heat*h + w.affinity*a + w.completion*c
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

// matchModelVersion identifies the calibration manifest AND the evidence
// definition behind a displayed Match. bootstrap-2 changed the evidence term
// from the capped top-20 taste slice to db.MatchEvidenceCount (uncapped,
// DISTINCT titles), which moves displayed values for evidence-rich profiles —
// so the generation is bumped rather than silently mixing two populations in
// the calibration report.
const matchModelVersion = "match-v2-bootstrap-2"

// personalMatchV2 maps absolute taste-vector similarity plus the amount of
// independent profile evidence to a conservative [0,1] estimate. The semantic
// curve is shrunk toward an uninformative 0.5 prior by rho=n/(n+k): three setup
// picks cannot produce the same confidence as a mature profile. This is the
// checked-in bootstrap manifest, not a claim of empirical calibration; the
// version and evidence strength are exposed/logged so future outcome fitting can
// be evaluated without confusing model generations.
//
// `evidence` MUST be db.MatchEvidenceCount — distinct supporting titles, with
// no cap. rho is the whole conservatism mechanism, so an evidence term that
// saturates makes the floor/ceiling constants dead code and caps what any
// profile can ever be told.
func personalMatchV2(sim float64, evidence int) (probability, confidence float64) {
	if sim <= 0 || evidence <= 0 || math.IsNaN(sim) {
		return 0, 0
	}
	if sim > 1 {
		sim = 1
	}
	semantic := 1 / (1 + math.Exp(-matchSemanticSlope*(sim-matchSemanticMidpoint)))
	confidence = float64(evidence) / (float64(evidence) + matchPriorSupport)
	probability = matchPriorProbability + confidence*(semantic-matchPriorProbability)
	probability = math.Max(matchProbabilityFloor, math.Min(matchProbabilityCeil, probability))
	return probability, confidence
}

// matchPercent maps a Match probability to the displayed integer percent. The
// ONE place that conversion happens: p==0 means "no personal estimate" and must
// stay 0 (the frontend then shows the global Aurora Score), while any real
// estimate floors at 1 so a genuine match never reads as "no score".
func matchPercent(p float64) int {
	if p == 0 {
		return 0
	}
	return clampInt(int(math.Round(p*100)), 1, 100)
}

// matchDisplayV2 is the full similarity+evidence → displayed-percent path,
// exercised directly by tests; applyPersonalMatch runs the same two steps and
// additionally keeps the confidence/audit metadata.
func matchDisplayV2(sim float64, evidence int) int {
	p, _ := personalMatchV2(sim, evidence)
	return matchPercent(p)
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
// rows. Two passes: first the mean rating (the Bayesian prior), then the mean/σ
// of every item's composite computed against that prior. `now` is passed so
// freshness and heat are evaluated at a single consistent instant.
func computeLibraryScoreStats(rows []db.ScoreRow, now time.Time, w scoreWeights) libraryScoreStats {
	n := len(rows)
	if n == 0 {
		return neutralScoreStats(now)
	}
	var sumR float64
	for _, r := range rows {
		sumR += r.Rating
	}
	ratingMean := sumR / float64(n)

	cores := make([]float64, n)
	var sumC float64
	for i, r := range rows {
		cores[i] = coreScore(r, now, ratingMean, w)
		sumC += cores[i]
	}
	mu := sumC / float64(n)

	var ss float64
	for _, v := range cores {
		d := v - mu
		ss += d * d
	}
	std := math.Sqrt(ss / float64(n))

	return libraryScoreStats{ratingMean: ratingMean, coreMean: mu, coreStd: std, n: n, builtAt: now}
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
