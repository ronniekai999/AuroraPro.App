package recommender

import "testing"

// TestShouldDiscoverUseV1 pins the regression guard from the #245 review: the
// schemaless /v1 path is taken ONLY when structured outputs is on AND a
// reasoning_effort is set. The dangerous cell is {structured, ""} — routing
// there with no effort risks gpt-oss runaway → empty content → uncached vector
// fallback, strictly worse than the native path. It must resolve to native.
func TestShouldDiscoverUseV1(t *testing.T) {
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
		if got := shouldDiscoverUseV1(tc.structured, tc.effort); got != tc.want {
			t.Errorf("%s: shouldDiscoverUseV1(%v, %q) = %v, want %v",
				tc.name, tc.structured, tc.effort, got, tc.want)
		}
	}
}
