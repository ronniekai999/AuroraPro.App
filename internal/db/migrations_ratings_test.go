package db

import (
	"context"
	"sort"
	"testing"
)

// TestAllAgesCeilingMatchesUnknownCeiling pins the rewrite's premise: a stored
// value the ladder doesn't know already enforces the tier allAgesCeiling names,
// so rewriting it changes what the API reports, never what is allowed.
func TestAllAgesCeilingMatchesUnknownCeiling(t *testing.T) {
	sorted := func(s []string) []string {
		out := append([]string(nil), s...)
		sort.Strings(out)
		return out
	}
	want := sorted(AllowedRatingsForMax("BOGUS"))
	got := sorted(AllowedRatingsForMax(allAgesCeiling))
	if len(got) == 0 || len(got) != len(want) {
		t.Fatalf("allAgesCeiling %q allows %v, an unknown ceiling allows %v", allAgesCeiling, got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("allAgesCeiling %q allows %v, an unknown ceiling allows %v", allAgesCeiling, got, want)
		}
	}
}

// TestCanonicalizeProfileRatings: stored ceilings written before validation
// are rewritten to what they already meant, and canonical ones are left alone.
// Opt-in via TEST_DATABASE_URL. Only this test's own rows are asserted on; the
// rewrite is table-wide, as at boot.
func TestCanonicalizeProfileRatings(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)

	cases := []struct {
		stored *string
		want   *string
	}{
		{ratingPtr("pg"), ratingPtr("PG")},
		{ratingPtr(" tv-14 "), ratingPtr("TV-14")},
		{ratingPtr("BOGUS"), ratingPtr(allAgesCeiling)},
		{ratingPtr("PG13"), ratingPtr(allAgesCeiling)},
		{ratingPtr("   "), nil},
		{ratingPtr(""), ratingPtr("")}, // left alone: readers treat it as NULL already
		{ratingPtr("NC-17"), ratingPtr("NC-17")},
		{nil, nil},
	}
	ids := make([]int64, len(cases))
	for i, c := range cases {
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO user_profiles (user_id, name, is_default, max_age_rating, language, subtitle_mode)
			 VALUES ($1, $2, FALSE, $3, 'en', 'off') RETURNING id`,
			userID, "p"+randomSuffix(t)[:8], c.stored).Scan(&ids[i]); err != nil {
			t.Fatalf("seed profile: %v", err)
		}
	}

	for run := 1; run <= 2; run++ { // the second run proves it idempotent
		if err := canonicalizeProfileRatings(ctx, q); err != nil {
			t.Fatalf("run %d: canonicalizeProfileRatings: %v", run, err)
		}
		for i, c := range cases {
			var got *string
			if err := q.pool.QueryRow(ctx, `SELECT max_age_rating FROM user_profiles WHERE id = $1`, ids[i]).Scan(&got); err != nil {
				t.Fatalf("reload profile: %v", err)
			}
			show := func(s *string) string {
				if s == nil {
					return "NULL"
				}
				return "\"" + *s + "\""
			}
			if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
				t.Errorf("run %d: stored %s became %s, want %s", run, show(c.stored), show(got), show(c.want))
			}
		}
	}
}
