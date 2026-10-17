package db

// Integration test for the "Recently added" rating ceiling. GetRecentMedia
// used to take no rating filter at all, so a restricted (kid) profile's Home
// rail — and the web and TV heroes that fall back to its first item — showed
// every recent title regardless of the profile's ceiling. Opt-in via
// TEST_DATABASE_URL, same harness as the other db-package integration tests.

import (
	"context"
	"testing"
)

// TestGetRecentMediaAppliesRatingCeilingBeforeLimit pins two things a later
// refactor could silently undo:
//   - the ceiling is applied in SQL, before LIMIT: five over-ceiling titles
//     newer than the allowed one must not crowd it out of a three-row page
//     (filtering in Go after LIMIT would return none of the fixture's rows);
//   - unrated titles (NULL or empty) are excluded under a restriction, matching
//     AllowedRatingsForMax's fail-closed contract and GetMediaItems.
//
// GetRecentMedia is catalog-wide, so the fixture's rows are dated centuries
// ahead to make them the newest rows in a shared test database (other tests
// insert at NOW()), and the assertions only consider the fixture's own ids.
func TestGetRecentMediaAppliesRatingCeilingBeforeLimit(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libID := seedTypedLibrary(t, q, ownerID, "movie")
	token := randomSuffix(t)

	// seed inserts a movie with the given rating (nil stores SQL NULL), dated
	// 500 years plus `hours` ahead so a higher `hours` sorts as more recent.
	seed := func(rating *string, hours int) int64 {
		t.Helper()
		var id int64
		err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, tmdb_id, content_rating, added_at)
			 VALUES ($1, 'movie', $2, $2, $3, $4, NOW() + make_interval(years => 500, hours => $5))
			 RETURNING id`,
			libID, "RecentCeiling "+token+" "+randomSuffix(t), uniqueTMDBID(t), rating, hours,
		).Scan(&id)
		if err != nil {
			t.Fatalf("seed media item: %v", err)
		}
		return id
	}
	str := func(s string) *string { return &s }

	allowed := seed(str("G"), 1)
	unratedNull := seed(nil, 2)
	unratedEmpty := seed(str(""), 3)
	overCeiling := map[int64]bool{}
	for i := 0; i < 5; i++ {
		overCeiling[seed(str("R"), 10+i)] = true
	}

	restricted, err := q.GetRecentMedia(ctx, 3, AllowedRatingsForMax("PG"))
	if err != nil {
		t.Fatalf("GetRecentMedia (restricted): %v", err)
	}
	sawAllowed := false
	for _, it := range restricted {
		switch {
		case it.ID == allowed:
			sawAllowed = true
		case overCeiling[it.ID]:
			t.Errorf("PG ceiling returned R-rated item %d", it.ID)
		case it.ID == unratedNull || it.ID == unratedEmpty:
			t.Errorf("PG ceiling returned unrated item %d; unrated titles must be excluded under a restriction", it.ID)
		}
	}
	if !sawAllowed {
		t.Errorf("PG ceiling with limit 3 omitted the G-rated item %d behind five newer R-rated items — "+
			"the ceiling must be applied before LIMIT, not after", allowed)
	}

	// Control: no ceiling (nil) is unrestricted, so the five newest fixture
	// rows (all R) fill a three-row page.
	open, err := q.GetRecentMedia(ctx, 3, nil)
	if err != nil {
		t.Fatalf("GetRecentMedia (unrestricted): %v", err)
	}
	var sawOver int
	for _, it := range open {
		if overCeiling[it.ID] {
			sawOver++
		}
	}
	if sawOver != 3 {
		t.Errorf("unrestricted page held %d of the fixture's newest R-rated items, want 3", sawOver)
	}
}
