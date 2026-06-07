package db

import "testing"

// TestAllowedRatingsForMax pins the parental-controls contract that the
// recommender age-filter (and browse, and onboarding) all rely on: a
// restricted/kid profile's allowed set must EXCLUDE the above-rating ratings.
// The candidate queries apply `content_rating = ANY(allowed)`, so anything not
// in this set is filtered out — making these exclusions the safety boundary.
func TestAllowedRatingsForMax(t *testing.T) {
	has := func(allowed []string, r string) bool {
		for _, a := range allowed {
			if a == r {
				return true
			}
		}
		return false
	}

	// Unrestricted / unknown → nil, which the query filters read as "no filter".
	if got := AllowedRatingsForMax(""); got != nil {
		t.Errorf(`AllowedRatingsForMax("") = %v, want nil (unrestricted = no filter)`, got)
	}
	if got := AllowedRatingsForMax("BOGUS"); got != nil {
		t.Errorf(`AllowedRatingsForMax("BOGUS") = %v, want nil`, got)
	}

	cases := []struct {
		max     string
		include []string
		exclude []string
	}{
		// PG-13 profile: no R/NC-17 (movies) or TV-14/TV-MA (TV).
		{"PG-13", []string{"G", "PG", "PG-13", "TV-PG"}, []string{"R", "NC-17", "TV-14", "TV-MA"}},
		// PG profile.
		{"PG", []string{"G", "PG", "TV-Y", "TV-Y7", "TV-G"}, []string{"PG-13", "R", "NC-17", "TV-PG", "TV-14", "TV-MA"}},
		// G profile: most restrictive.
		{"G", []string{"G", "TV-Y"}, []string{"PG", "PG-13", "R", "NC-17", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"}},
	}
	for _, tc := range cases {
		allowed := AllowedRatingsForMax(tc.max)
		if len(allowed) == 0 {
			t.Fatalf("AllowedRatingsForMax(%q) is empty; expected a restricted set", tc.max)
		}
		for _, r := range tc.include {
			if !has(allowed, r) {
				t.Errorf("AllowedRatingsForMax(%q) missing %q; got %v", tc.max, r, allowed)
			}
		}
		for _, r := range tc.exclude {
			if has(allowed, r) {
				t.Errorf("AllowedRatingsForMax(%q) must EXCLUDE %q (parental-controls hole); got %v", tc.max, r, allowed)
			}
		}
	}
}
