package db

import (
	"math"
	"testing"
)

// TestMatchFromDistance covers the pure cosine-distance → similarity mapping
// used by NearestUnwatched / NearestUnwatchedRich to populate
// MediaItem.MatchScore. No DB needed — runs unconditionally (the rest of the
// db package's tests are opt-in integration tests gated on TEST_DATABASE_URL).
//
// Embeddings are L2-normalized, so the pgvector `<=>` cosine distance is
// d = 1 - cos(θ) ∈ [0,2]; similarity = 1 - d, clamped to [0,1].
func TestMatchFromDistance(t *testing.T) {
	cases := []struct {
		name     string
		distance float64
		want     float64
	}{
		{"identical (d=0)", 0.0, 1.0},
		{"orthogonal (d=1)", 1.0, 0.0},
		{"close (d=0.12)", 0.12, 0.88},
		{"far (d=1.4)", 1.4, 0.0},    // negative similarity clamps to 0
		{"opposite (d=2)", 2.0, 0.0}, // -1 similarity clamps to 0
		{"tiny (d=0.001)", 0.001, 0.999},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := matchFromDistance(tc.distance)
			// Allow a hair of float slop on the non-clamped cases.
			if diff := got - tc.want; diff > 1e-9 || diff < -1e-9 {
				t.Errorf("matchFromDistance(%v) = %v, want %v", tc.distance, got, tc.want)
			}
			if got < 0 || got > 1 {
				t.Errorf("matchFromDistance(%v) = %v out of [0,1]", tc.distance, got)
			}
		})
	}

	// A NaN distance (degenerate/zero embedding) must clamp to 0, not propagate
	// to the user-facing match %.
	if got := matchFromDistance(math.NaN()); got != 0 {
		t.Errorf("matchFromDistance(NaN) = %v, want 0", got)
	}
}
