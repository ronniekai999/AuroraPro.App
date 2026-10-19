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

	// Only an empty ceiling is unrestricted → nil, which the query filters read
	// as "no filter".
	for _, unrestricted := range []string{"", "   "} {
		if got := AllowedRatingsForMax(unrestricted); got != nil {
			t.Errorf(`AllowedRatingsForMax(%q) = %v, want nil (unrestricted = no filter)`, unrestricted, got)
		}
	}
	// An unknown non-empty ceiling fails CLOSED to the all-ages tier. It used to
	// return nil, so a stored typo or foreign rating lifted every restriction.
	// It must be non-empty: callers read an empty slice as "no filter" too.
	for _, unknown := range []string{"BOGUS", "12A", "MA15+", "PG13"} {
		got := AllowedRatingsForMax(unknown)
		if len(got) == 0 {
			t.Errorf("AllowedRatingsForMax(%q) = %v; an unknown ceiling must restrict, not lift the filter", unknown, got)
		}
		for _, r := range []string{"PG", "TV-Y7", "PG-13", "R", "TV-MA", "NC-17"} {
			if has(got, r) {
				t.Errorf("AllowedRatingsForMax(%q) includes %q; an unknown ceiling must fail closed to all-ages", unknown, r)
			}
		}
		for _, r := range []string{"G", "TV-Y", "TV-G"} {
			if !has(got, r) {
				t.Errorf("AllowedRatingsForMax(%q) missing all-ages %q; got %v", unknown, r, got)
			}
		}
	}
	// Case and surrounding whitespace don't matter: a stored "pg" is PG, not
	// an unknown value. Compare as sets; map iteration order varies.
	for _, spelled := range []string{"pg", " PG ", "Pg"} {
		got := AllowedRatingsForMax(spelled)
		want := AllowedRatingsForMax("PG")
		if len(got) != len(want) {
			t.Errorf("AllowedRatingsForMax(%q) = %v, want the PG ladder %v", spelled, got, want)
		}
		for _, r := range want {
			if !has(got, r) {
				t.Errorf("AllowedRatingsForMax(%q) missing %q from the PG ladder", spelled, r)
			}
		}
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

// TestRatingAllowed pins issue #462's fail-closed contract for the
// single check every read/playback and discovery gate now shares:
// unrestricted profiles allow anything, restricted profiles allow only
// their ladder, and — the actual security property — an empty/unrated
// contentRating is EXCLUDED under any restriction, never treated as safe
// by default.
func TestRatingAllowed(t *testing.T) {
	if !RatingAllowed("", "NC-17") {
		t.Error(`RatingAllowed("", "NC-17") = false, want true (unrestricted profile)`)
	}
	if !RatingAllowed("", "") {
		t.Error(`RatingAllowed("", "") = false, want true (unrestricted profile, unrated title)`)
	}
	if !RatingAllowed("PG-13", "PG") {
		t.Error(`RatingAllowed("PG-13", "PG") = false, want true (within ceiling)`)
	}
	if RatingAllowed("PG-13", "R") {
		t.Error(`RatingAllowed("PG-13", "R") = true, want false (exceeds ceiling)`)
	}
	if RatingAllowed("G", "") {
		t.Error(`RatingAllowed("G", "") = true, want false — fail-closed: an unrated title must NOT be treated as safe for a restricted profile`)
	}
	if RatingAllowed("TV-Y7", "PG") {
		t.Error(`RatingAllowed("TV-Y7", "PG") = true, want false (cross-system collision guard)`)
	}
}

// TestRatingToneBuckets pins the ladder-derived tone buckets used by
// internal/reasonguard: mature = R/TV-MA level and above, kid = TV-Y7 level
// and below, everything else (teen middle, unknown, foreign, empty) in
// neither. Derived from ageRatingOrder so vetting can never disagree with
// the parental-controls ladder.
func TestRatingToneBuckets(t *testing.T) {
	mature := []string{"R", "TV-MA", "NC-17", " r ", "tv-ma"}
	for _, r := range mature {
		if !IsMatureRating(r) {
			t.Errorf("IsMatureRating(%q) = false, want true", r)
		}
		if IsKidRating(r) {
			t.Errorf("IsKidRating(%q) = true, want false", r)
		}
	}
	kid := []string{"G", "TV-Y", "TV-G", "TV-Y7", "g", " tv-y7 "}
	for _, r := range kid {
		if !IsKidRating(r) {
			t.Errorf("IsKidRating(%q) = false, want true", r)
		}
		if IsMatureRating(r) {
			t.Errorf("IsMatureRating(%q) = true, want false", r)
		}
	}
	neither := []string{"PG", "TV-PG", "PG-13", "TV-14", "", "BOGUS", "MA15+", "18"}
	for _, r := range neither {
		if IsMatureRating(r) || IsKidRating(r) {
			t.Errorf("rating %q must be in neither tone bucket (mature=%v kid=%v)",
				r, IsMatureRating(r), IsKidRating(r))
		}
	}
}

// TestCanonicalMaxRating pins write-time validation of a profile ceiling: the
// ladder's spelling is stored, "" means unrestricted, and anything the ladder
// doesn't know is rejected rather than stored.
func TestCanonicalMaxRating(t *testing.T) {
	for in, want := range map[string]string{
		"": "", "  ": "", "PG": "PG", "pg": "PG", " tv-14 ": "TV-14", "nc-17": "NC-17", "Tv-Ma": "TV-MA",
	} {
		got, ok := CanonicalMaxRating(in)
		if !ok || got != want {
			t.Errorf("CanonicalMaxRating(%q) = (%q, %v), want (%q, true)", in, got, ok, want)
		}
	}
	for _, in := range []string{"BOGUS", "12A", "PG13", "MA15+", "R18", "TV 14"} {
		if got, ok := CanonicalMaxRating(in); ok {
			t.Errorf("CanonicalMaxRating(%q) = (%q, true), want rejection", in, got)
		}
	}
	// Every listed choice must round-trip, and the list must cover the ladder.
	choices := MaxRatingChoices()
	if len(choices) != len(ageRatingOrder) {
		t.Fatalf("MaxRatingChoices() has %d entries, ladder has %d", len(choices), len(ageRatingOrder))
	}
	for i, c := range choices {
		if got, ok := CanonicalMaxRating(c); !ok || got != c {
			t.Errorf("choice %q does not round-trip: (%q, %v)", c, got, ok)
		}
		if i > 0 && ageRatingOrder[choices[i-1]] > ageRatingOrder[c] {
			t.Errorf("MaxRatingChoices() not ordered least to most mature at %q", c)
		}
	}
}

// TestHasCeiling pins the admin checks' reading of a stored ceiling to the
// ladder's: blank or any whitespace is none, and anything else is one, an
// unknown value included (it restricts to the all-ages tier).
func TestHasCeiling(t *testing.T) {
	for in, want := range map[string]bool{
		"": false, "  ": false, "\t": false, " \n\r\t ": false,
		"PG": true, " pg ": true, "\tTV-14": true, "XYZ": true,
	} {
		if got := HasCeiling(in); got != want {
			t.Errorf("HasCeiling(%q) = %v, want %v", in, got, want)
		}
		if got := AllowedRatingsForMax(in) != nil; got != want {
			t.Errorf("AllowedRatingsForMax(%q) restricts = %v, but HasCeiling should agree with %v", in, got, want)
		}
	}
}
