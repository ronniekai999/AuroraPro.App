package db

import "testing"

// TestAllowedRatingsForMax pins the parental-controls contract that browse, the
// taste onboarding pool, and the recommender all rely on: a restricted/kid
// profile's allowed set must EXCLUDE above-rating ratings — including across the
// MPAA<->TV boundary. The candidate queries apply `content_rating = ANY(allowed)`,
// so anything not in this set is filtered out, making these exclusions the
// safety boundary. The TV-14 / TV-Y7 cases below guard the cross-system
// collisions that a coarse shared 1–5 scale used to leak (R via TV-14, PG via
// TV-Y7).
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
		// PG-13 (movie cap): no R/NC-17, and no TV-14/TV-MA on the TV side.
		{"PG-13", []string{"G", "PG", "PG-13", "TV-PG"}, []string{"R", "NC-17", "TV-14", "TV-MA"}},
		// PG (movie cap).
		{"PG", []string{"G", "PG", "TV-Y", "TV-Y7", "TV-G"}, []string{"PG-13", "TV-PG", "R", "NC-17", "TV-14", "TV-MA"}},
		// G (most restrictive): all-ages only — G, TV-Y, TV-G.
		{"G", []string{"G", "TV-Y", "TV-G"}, []string{"PG", "PG-13", "R", "NC-17", "TV-Y7", "TV-PG", "TV-14", "TV-MA"}},
		// TV-14 (TV cap) — the collision this fix closes: must NOT unlock R /
		// NC-17 / TV-MA, but PG-13 and below are fine.
		{"TV-14", []string{"G", "TV-Y7", "PG", "TV-PG", "PG-13", "TV-14"}, []string{"R", "NC-17", "TV-MA"}},
		// TV-Y7 (young-kids TV cap) — must NOT unlock PG (the other collision).
		{"TV-Y7", []string{"G", "TV-Y", "TV-G", "TV-Y7"}, []string{"PG", "TV-PG", "PG-13", "TV-14", "R", "TV-MA", "NC-17"}},
		// TV-MA (adult TV cap): allows R, still excludes NC-17.
		{"TV-MA", []string{"R", "TV-MA", "TV-14", "PG-13"}, []string{"NC-17"}},
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
