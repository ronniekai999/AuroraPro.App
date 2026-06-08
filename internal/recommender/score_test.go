package recommender

import (
	"math"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
)

func approx(a, b, eps float64) bool { return math.Abs(a-b) <= eps }

func TestBayesianQuality(t *testing.T) {
	const mean, m = 7.0, 250.0
	// Zero votes → fully shrunk to the library mean.
	if got := bayesianQuality(9.5, 0, mean, m); !approx(got, mean, 1e-9) {
		t.Errorf("0 votes: got %v, want %v", got, mean)
	}
	// Huge vote count → essentially the item's own rating.
	if got := bayesianQuality(9.0, 1_000_000, mean, m); !approx(got, 9.0, 1e-3) {
		t.Errorf("many votes: got %v, want ~9.0", got)
	}
	// The whole point: a 9.2 from 30 votes should rank BELOW an 8.2 from 5000.
	obscure := bayesianQuality(9.2, 30, mean, m)
	established := bayesianQuality(8.2, 5000, mean, m)
	if !(obscure < established) {
		t.Errorf("shrunk obscure (%.3f) should rank below established (%.3f)", obscure, established)
	}
	// m<=0 disables shrinkage.
	if got := bayesianQuality(9.5, 0, mean, 0); got != 9.5 {
		t.Errorf("m=0 should return raw rating, got %v", got)
	}
}

func TestDecay(t *testing.T) {
	if got := decay(0, 10); !approx(got, 1, 1e-9) {
		t.Errorf("age 0 should be 1, got %v", got)
	}
	if got := decay(10, 10); !approx(got, math.Exp(-1), 1e-9) {
		t.Errorf("age==scale should be e^-1, got %v", got)
	}
	if got := decay(-5, 10); got != 1 {
		t.Errorf("negative age clamps to full freshness, got %v", got)
	}
	if got := decay(5, 0); got != 0 {
		t.Errorf("scale<=0 disabled, got %v", got)
	}
}

func TestFreshness(t *testing.T) {
	now := time.Date(2026, 6, 7, 0, 0, 0, 0, time.UTC)
	justAdded := now.AddDate(0, 0, -1)
	// Just released and just added → ~1.
	if got := freshness(2026, justAdded, now); got < 0.9 {
		t.Errorf("new title should be fresh, got %v", got)
	}
	// Old release, old add → low.
	old := now.AddDate(-3, 0, 0)
	if got := freshness(2000, old, now); got > 0.2 {
		t.Errorf("old title should be stale, got %v", got)
	}
	// Old release but freshly added → lifted by add-recency (max of the two).
	if !(freshness(2000, justAdded, now) > freshness(2000, old, now)) {
		t.Error("a recent add should lift freshness above an old add")
	}
	// Absent inputs → 0, no panic.
	if got := freshness(0, time.Time{}, now); got != 0 {
		t.Errorf("absent inputs should be 0, got %v", got)
	}
}

func TestAuroraDisplay(t *testing.T) {
	const mean, std = 1.0, 0.2
	// Median (z=0) → 50.
	if got := auroraDisplay(mean, mean, std); got != 50 {
		t.Errorf("z=0 should be 50, got %d", got)
	}
	// +2σ → ~86, −2σ → ~14 (well-spread, not pinned high).
	if hi := auroraDisplay(mean+2*std, mean, std); hi < 80 || hi > 92 {
		t.Errorf("+2σ expected ~86, got %d", hi)
	}
	if lo := auroraDisplay(mean-2*std, mean, std); lo > 20 {
		t.Errorf("−2σ expected ~14, got %d", lo)
	}
	// Monotonic in the composite.
	if !(auroraDisplay(0.5, mean, std) < auroraDisplay(1.0, mean, std) &&
		auroraDisplay(1.0, mean, std) < auroraDisplay(1.5, mean, std)) {
		t.Error("auroraDisplay should be monotonic in core")
	}
	// Degenerate σ → neutral 50, no divide-by-zero.
	if got := auroraDisplay(5, 5, 0); got != 50 {
		t.Errorf("σ=0 should be neutral 50, got %d", got)
	}
}

// TestComputeLibraryScoreStats_ProducesSpread is the regression guard for the
// original bug: a library whose ratings cluster in a narrow band (exactly what
// made the old score read "all 80s–90s") must still yield Aurora Scores that
// spread across the range after z-score calibration.
func TestComputeLibraryScoreStats_ProducesSpread(t *testing.T) {
	now := time.Date(2026, 6, 7, 0, 0, 0, 0, time.UTC)
	rows := make([]db.ScoreRow, 0, 60)
	for i := 0; i < 60; i++ {
		rows = append(rows, db.ScoreRow{
			ID:          int64(i + 1),
			Rating:      6.5 + float64(i%21)*0.1, // clustered 6.5 .. 8.5
			VoteCount:   50 + (i*37)%6000,
			ReleaseYear: 1990 + (i % 36),
			AddedAt:     now.AddDate(0, 0, -(i % 400)),
		})
	}
	stats := computeLibraryScoreStats(rows, now, defaultWeights)
	if stats.n != len(rows) {
		t.Fatalf("n: got %d want %d", stats.n, len(rows))
	}
	if stats.coreStd <= 0 {
		t.Fatalf("expected positive σ, got %v", stats.coreStd)
	}

	lo, hi, inOldBand := 101, -1, 0
	for _, r := range rows {
		core := coreScore(r, now, stats.ratingMean, defaultWeights)
		s := auroraDisplay(core, stats.coreMean, stats.coreStd)
		if s < lo {
			lo = s
		}
		if s > hi {
			hi = s
		}
		if s >= 82 && s <= 98 {
			inOldBand++
		}
	}
	if hi-lo < 40 {
		t.Errorf("expected wide score spread (>40), got min=%d max=%d", lo, hi)
	}
	if inOldBand == len(rows) {
		t.Error("every score landed in the old 82–98 band — the clustering bug is back")
	}
}

func TestComputeLibraryScoreStats_Empty(t *testing.T) {
	now := time.Date(2026, 6, 7, 0, 0, 0, 0, time.UTC)
	stats := computeLibraryScoreStats(nil, now, defaultWeights)
	if stats.n != 0 || stats.coreStd != 1 || stats.ratingMean != neutralRatingMean {
		t.Errorf("empty library should yield neutral stats, got %+v", stats)
	}
}

func TestSaturate(t *testing.T) {
	if got := saturate(0, 5); got != 0 {
		t.Errorf("saturate(0) should be 0, got %v", got)
	}
	if got := saturate(-3, 5); got != 0 {
		t.Errorf("negative input should be 0, got %v", got)
	}
	if got := saturate(5, 5); !approx(got, 1-math.Exp(-1), 1e-9) {
		t.Errorf("x==scale should be ~0.632, got %v", got)
	}
	if got := saturate(100, 5); got < 0.99 {
		t.Errorf("large x should saturate toward 1, got %v", got)
	}
	if got := saturate(5, 0); got != 0 {
		t.Errorf("scale<=0 disabled, got %v", got)
	}
}

func TestWilsonLower(t *testing.T) {
	// The canonical example: 2/2 must NOT outrank 180/200.
	small := wilsonLower(2, 2, wilsonZ)
	big := wilsonLower(180, 200, wilsonZ)
	if !(small < big) {
		t.Errorf("2/2 (%.3f) should rank below 180/200 (%.3f)", small, big)
	}
	// n=0 → 0.
	if got := wilsonLower(0, 0, wilsonZ); got != 0 {
		t.Errorf("n=0 should be 0, got %v", got)
	}
	// Lower bound sits below the point estimate.
	if wb := wilsonLower(90, 100, wilsonZ); !(wb < 0.9) {
		t.Errorf("lower bound should be below p̂=0.9, got %v", wb)
	}
	// Same rate, more evidence → tighter (higher) lower bound.
	if !(wilsonLower(9, 10, wilsonZ) < wilsonLower(900, 1000, wilsonZ)) {
		t.Error("same rate with more samples should raise the lower bound")
	}
	// pos clamped to n — no NaN / out-of-range.
	if got := wilsonLower(5, 3, wilsonZ); got <= 0 || got > 1 {
		t.Errorf("clamped pos should yield a valid proportion, got %v", got)
	}
}

func TestCompletionQuality(t *testing.T) {
	// Below the minimum starts → neutral, neither rewarded nor punished.
	if got := completionQuality(3, 3); got != completionNeutral {
		t.Errorf("sparse starts should be neutral %v, got %v", completionNeutral, got)
	}
	// Plenty of starts: mostly-finished reads high, mostly-abandoned reads low.
	bingey := completionQuality(170, 200)
	bouncy := completionQuality(30, 200)
	if !(bingey > 0.6 && bouncy < 0.4 && bingey > bouncy) {
		t.Errorf("expected binge>0.6 (got %.3f) and bounce<0.4 (got %.3f)", bingey, bouncy)
	}
}

// TestCoreScore_EngagementLiftsScore verifies the proprietary engagement
// signals actually move the score: an item your viewers are watching,
// finishing, and favouriting outscores an identical title with no local
// engagement.
func TestCoreScore_EngagementLiftsScore(t *testing.T) {
	now := time.Date(2026, 6, 7, 0, 0, 0, 0, time.UTC)
	base := db.ScoreRow{Rating: 7.5, VoteCount: 1000, ReleaseYear: 2015, AddedAt: now.AddDate(-1, 0, 0)}
	hot := base
	hot.Heat, hot.Starts, hot.Finishes, hot.FavCount, hot.CollectionCount = 12, 200, 180, 8, 3
	if !(coreScore(hot, now, 7.0, defaultWeights) > coreScore(base, now, 7.0, defaultWeights)) {
		t.Error("strong local engagement should outscore an identical item without it")
	}
}
