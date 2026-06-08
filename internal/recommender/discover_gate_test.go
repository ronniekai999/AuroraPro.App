package recommender

import "testing"

// TestShouldUseStructuredV1 pins the shared hero+Discover regression guard: the
// /v1 path is taken ONLY when structured outputs is on AND a reasoning_effort is
// set. The dangerous cell is {structured, ""} — routing there with no effort
// risks a reasoning runaway (empty content / 24-40s) that's strictly worse than
// the native path. It must resolve to native.
func TestShouldUseStructuredV1(t *testing.T) {
	cases := []struct {
		name       string
		structured bool
		effort     string
		want       bool
	}{
		{"structured + low effort → v1", true, "low", true},
		{"structured + high effort → v1", true, "high", true},
		{"structured + none (explicit) → v1", true, "none", true},
		{"structured + UNSET effort → native (the guard)", true, "", false},
		{"effort set but structured off → native", false, "low", false},
		{"neither → native", false, "", false},
	}
	for _, tc := range cases {
		if got := shouldUseStructuredV1(tc.structured, tc.effort); got != tc.want {
			t.Errorf("%s: shouldUseStructuredV1(%v, %q) = %v, want %v",
				tc.name, tc.structured, tc.effort, got, tc.want)
		}
	}
}
