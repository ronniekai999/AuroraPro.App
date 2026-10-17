package db

// Integration tests for the "Recently added" rating ceiling. GetRecentMedia
// used to take no rating filter at all, so a restricted (kid) profile's Home
// rail — and the web and TV heroes that fall back to its first item — showed
// every recent title regardless of the profile's ceiling. Opt-in via
// TEST_DATABASE_URL, same harness as the other db-package integration tests.

import (
	"context"
	"testing"
)

// recentCeilingItem is one fixture row for these tests. GetRecentMedia is
// catalog-wide, so rows are dated a few hours ahead to sort above rows other
// tests insert at NOW(); hours, not centuries, so a row leaked by a killed run
// drops out of the newest pages within a day instead of polluting them for
// good. Every unrelated scalar is the zero value rather than NULL, as in
// seedTypedMediaItem, so these rows are ordinary catalog rows to the
// concurrently running packages they briefly head.
type recentCeilingItem struct {
	rating *string // nil stores SQL NULL
	hours  int     // added_at offset; higher sorts as more recent
	tmdbID int
	rich   bool // overview and poster set, so it wins a dedup group
}

func seedRecentCeilingItem(t *testing.T, q *Queries, libID int64, token string, it recentCeilingItem) int64 {
	t.Helper()
	overview, poster := "", ""
	if it.rich {
		overview, poster = "A fixture overview.", "/fixture-poster.jpg"
	}
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO media_items
		   (library_id, type, title, sort_title, tmdb_id, year, overview, rating, runtime_minutes,
		    content_rating, poster_path, backdrop_path, added_at)
		 VALUES ($1, 'movie', $2, $2, $3, 0, $4, 0, 0, $5, $6, '', NOW() + make_interval(hours => $7))
		 RETURNING id`,
		libID, "RecentCeiling "+token+" "+randomSuffix(t), it.tmdbID, overview, it.rating, poster, it.hours,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed media item: %v", err)
	}
	return id
}

func ratingPtr(s string) *string { return &s }

// TestGetRecentMediaAppliesRatingCeilingBeforeLimit pins two things a later
// refactor could silently undo:
//   - the ceiling is applied in SQL, before LIMIT: five over-ceiling titles
//     newer than the allowed one must not crowd it out of a three-row page
//     (filtering in Go after LIMIT would return none of the fixture's rows);
//   - unrated titles (NULL or empty) are excluded under a restriction, matching
//     AllowedRatingsForMax's fail-closed contract and GetMediaItems.
//
// Assertions only consider this run's own ids, so rows left by another run
// on the same database cannot fail them.
func TestGetRecentMediaAppliesRatingCeilingBeforeLimit(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	libID := seedTypedLibrary(t, q, seedTestUser(t, q), "movie")
	token := randomSuffix(t)
	seed := func(rating *string, hours int) int64 {
		return seedRecentCeilingItem(t, q, libID, token, recentCeilingItem{rating: rating, hours: hours, tmdbID: uniqueTMDBID(t)})
	}

	allowed := seed(ratingPtr("G"), 1)
	unratedNull := seed(nil, 2)
	unratedEmpty := seed(ratingPtr(""), 3)
	overCeiling := map[int64]bool{}
	for i := 0; i < 5; i++ {
		overCeiling[seed(ratingPtr("R"), 10+i)] = true
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

	// Control: with no ceiling (nil) the newer R rows fill the three-row page,
	// so the G row's presence above came from filtering, not from the page.
	open, err := q.GetRecentMedia(ctx, 3, nil)
	if err != nil {
		t.Fatalf("GetRecentMedia (unrestricted): %v", err)
	}
	for _, it := range open {
		if it.ID == allowed || it.ID == unratedNull || it.ID == unratedEmpty {
			t.Errorf("unrestricted three-row page held older fixture row %d ahead of the five newer R-rated rows", it.ID)
		}
	}
}

// TestGetRecentMediaCeilingAppliesBeforeDedup pins the ceiling's position
// relative to cross-library dedup, matching GetMediaItems: a restricted
// profile must still see a title whose richer duplicate copy is over its
// ceiling. Filtering after dedup would let the richer R copy win the group
// and then drop it, hiding the PG copy from the PG profile, so Recently added
// and browse would disagree about the same title.
func TestGetRecentMediaCeilingAppliesBeforeDedup(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	ownerID := seedTestUser(t, q)
	libA := seedTypedLibrary(t, q, ownerID, "movie")
	libB := seedTypedLibrary(t, q, ownerID, "movie")
	token := randomSuffix(t)
	tmdbID := uniqueTMDBID(t)

	// Dated at NOW(), below the other test's G row, so this in-ceiling PG row
	// can never crowd that test's three-row restricted page.
	richR := seedRecentCeilingItem(t, q, libA, token, recentCeilingItem{rating: ratingPtr("R"), hours: 0, tmdbID: tmdbID, rich: true})
	plainPG := seedRecentCeilingItem(t, q, libB, token, recentCeilingItem{rating: ratingPtr("PG"), hours: 0, tmdbID: tmdbID})

	find := func(allowed []string) (sawR, sawPG bool) {
		t.Helper()
		items, err := q.GetRecentMedia(ctx, 50, allowed)
		if err != nil {
			t.Fatalf("GetRecentMedia: %v", err)
		}
		for _, it := range items {
			sawR = sawR || it.ID == richR
			sawPG = sawPG || it.ID == plainPG
		}
		return sawR, sawPG
	}

	if sawR, sawPG := find(nil); !sawR || sawPG {
		t.Fatalf("unrestricted: dedup should keep only the richer R copy, got R=%v PG=%v", sawR, sawPG)
	}
	if sawR, sawPG := find(AllowedRatingsForMax("PG")); sawR || !sawPG {
		t.Errorf("PG ceiling: want the PG copy of the shared title and not the R copy, got R=%v PG=%v — "+
			"the ceiling must be applied before dedup, as GetMediaItems does", sawR, sawPG)
	}
}
