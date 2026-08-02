package db

// Integration tests for the three taste-slice changes. Opt-in via
// TEST_DATABASE_URL, like the rest of internal/db.
//
// All three alter tasteRecentSliceCTE, which is shared verbatim by
// BuildProfileVector, ProfileEmbeddingSlice and PersonalizationHistoryCount —
// so a mistake here moves every profile's recommendations at once. These
// exercise the real SQL against a real pgvector, because the failure modes are
// SQL-shaped (a wrong join, a missing dedup) and invisible to a Go unit test.

import (
	"context"
	"testing"
)

// seedWatchlist creates a list of the given type for a profile and returns its
// id. Deliberately raw SQL rather than CreateWatchlist: the point is to pin the
// SCHEMA the CTE joins against, so a column move breaks the test rather than
// being papered over by a helper that moved with it.
func seedWatchlist(t *testing.T, q *Queries, profileID int64, listType string) int64 {
	t.Helper()
	var id int64
	if err := q.pool.QueryRow(context.Background(),
		`INSERT INTO watchlists (profile_id, name, list_type) VALUES ($1, $2, $3) RETURNING id`,
		profileID, listType+"-test", listType).Scan(&id); err != nil {
		t.Fatalf("seed watchlist %s: %v", listType, err)
	}
	return id
}

func addToList(t *testing.T, q *Queries, listID, mediaItemID int64) {
	t.Helper()
	if _, err := q.pool.Exec(context.Background(),
		`INSERT INTO watchlist_items (watchlist_id, media_item_id) VALUES ($1, $2)`,
		listID, mediaItemID); err != nil {
		t.Fatalf("add to watchlist: %v", err)
	}
}

// setProgress writes a watch_progress row with an explicit position/duration so
// the engagement threshold can be exercised at a known fraction.
func setProgress(t *testing.T, q *Queries, userID, profileID, mediaItemID, posMS, durMS int64, completed bool) {
	t.Helper()
	if _, err := q.pool.Exec(context.Background(),
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		userID, profileID, mediaItemID, posMS, durMS, completed); err != nil {
		t.Fatalf("seed watch progress: %v", err)
	}
}

// "Want to watch" is the purest statement of intent the UI collects, and it fed
// nothing before this branch. A profile whose ONLY signal is a watchlist must
// now clear the personalization gate — otherwise it falls back to the global
// popular pool, which is what this change exists to stop.
func TestTasteSlice_WantToWatchCounts(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	list := seedWatchlist(t, q, profileID, "want_to_watch")

	// Below minHistoryItems (3) the contract is unchanged.
	addToList(t, q, list, seedEmbeddedItem(t, q, libID, 0))
	addToList(t, q, list, seedEmbeddedItem(t, q, libID, 1))
	if _, err := q.ProfileEmbeddingSlice(ctx, profileID); err != ErrInsufficientHistory {
		t.Fatalf("2 watchlist items: want ErrInsufficientHistory, got %v", err)
	}

	addToList(t, q, list, seedEmbeddedItem(t, q, libID, 2))
	rows, err := q.ProfileEmbeddingSlice(ctx, profileID)
	if err != nil {
		t.Fatalf("3 watchlist items should clear the gate: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("slice has %d rows, want 3", len(rows))
	}
	if _, err := q.BuildProfileVector(ctx, profileID); err != nil {
		t.Fatalf("BuildProfileVector on a watchlist-only profile: %v", err)
	}
}

// Favourites counted only in the GLOBAL Aurora Score before this change, so
// marking one nudged the title for every profile on the server and did nothing
// for the person who marked it. This is the personal half.
func TestTasteSlice_FavoritesCountPersonally(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	favs := seedWatchlist(t, q, profileID, "favorites")
	for i := 0; i < 3; i++ {
		addToList(t, q, favs, seedEmbeddedItem(t, q, libID, i))
	}

	rows, err := q.ProfileEmbeddingSlice(ctx, profileID)
	if err != nil {
		t.Fatalf("favourites-only profile should be personalizable: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("slice has %d rows, want 3", len(rows))
	}
}

// The join that matters: profile_id lives on `watchlists`, NOT on
// `watchlist_items`. Filtering the items table by profile would blend every
// profile's lists into one taste model — a silent, cross-user data leak into
// recommendations that no unit test would catch.
func TestTasteSlice_AnotherProfilesListIsNotMine(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	mine := seedDefaultProfile(t, q, userID)
	theirs := seedExtraProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	theirList := seedWatchlist(t, q, theirs, "want_to_watch")
	for i := 0; i < 5; i++ {
		addToList(t, q, theirList, seedEmbeddedItem(t, q, libID, i))
	}

	if _, err := q.ProfileEmbeddingSlice(ctx, mine); err != ErrInsufficientHistory {
		t.Fatalf("another profile's watchlist leaked into mine: got %v, want ErrInsufficientHistory", err)
	}
}

// 'custom' lists are user-made collections ("Halloween night", "for the kids")
// and carry no taste verdict. Only the two semantic list types count.
func TestTasteSlice_CustomListsDoNotCount(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	custom := seedWatchlist(t, q, profileID, "custom")
	for i := 0; i < 5; i++ {
		addToList(t, q, custom, seedEmbeddedItem(t, q, libID, i))
	}

	if _, err := q.ProfileEmbeddingSlice(ctx, profileID); err != ErrInsufficientHistory {
		t.Fatalf("a custom list steered the centroid: got %v, want ErrInsufficientHistory", err)
	}
}

// One title on both lists is one opinion. Without the cross-dedup it would
// occupy two of the twenty slots and pull the centroid twice as hard.
func TestTasteSlice_SameTitleOnBothListsCountsOnce(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	want := seedWatchlist(t, q, profileID, "want_to_watch")
	favs := seedWatchlist(t, q, profileID, "favorites")

	both := seedEmbeddedItem(t, q, libID, 0)
	addToList(t, q, want, both)
	addToList(t, q, favs, both)
	addToList(t, q, want, seedEmbeddedItem(t, q, libID, 1))
	addToList(t, q, want, seedEmbeddedItem(t, q, libID, 2))

	rows, err := q.ProfileEmbeddingSlice(ctx, profileID)
	if err != nil {
		t.Fatalf("slice: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("double-counted the shared title: %d rows, want 3", len(rows))
	}
}

// A watchlist add for something already watched must not re-enter the slice —
// the watch row already carries it, with the stronger signal.
func TestTasteSlice_WatchlistDedupedAgainstStrongerSources(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	watched := seedEmbeddedItem(t, q, libID, 0)
	setProgress(t, q, userID, profileID, watched, 100, 100, true)

	rated := seedEmbeddedItem(t, q, libID, 1)
	if err := q.SetUserRating(ctx, profileID, rated, 5); err != nil {
		t.Fatalf("set rating: %v", err)
	}

	// Both also land on the watchlist. Neither should appear twice.
	want := seedWatchlist(t, q, profileID, "want_to_watch")
	addToList(t, q, want, watched)
	addToList(t, q, want, rated)
	addToList(t, q, want, seedEmbeddedItem(t, q, libID, 2))

	rows, err := q.ProfileEmbeddingSlice(ctx, profileID)
	if err != nil {
		t.Fatalf("slice: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("watchlist re-added titles already carried by stronger sources: %d rows, want 3", len(rows))
	}
}

// The engagement threshold. A title someone is genuinely part-way through must
// rank with the deliberate signals, not beneath them — that inversion is what
// pushed two live watches to rows 19-20 of a 20-row slice in production, one
// rating away from falling out entirely.
//
// It must ALSO stay tight enough that a bounce does not qualify: letting a
// 30-second sample outrank a rating would be a worse error than the one being
// fixed.
func TestTasteSlice_ProgressedWatchRanksWithDeliberateSignals(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	engaged := seedEmbeddedItem(t, q, libID, 0) // 50% in — real engagement
	bounced := seedEmbeddedItem(t, q, libID, 1) // 2% in — still deciding
	setProgress(t, q, userID, profileID, engaged, 50, 100, false)
	setProgress(t, q, userID, profileID, bounced, 2, 100, false)

	var engagedTier, bouncedTier bool
	if err := q.pool.QueryRow(ctx, `
		SELECT (wp.completed OR (wp.duration_ms > 0
		        AND wp.position_ms::float8 / wp.duration_ms::float8 >= `+engagedProgressFraction+`))
		FROM watch_progress wp WHERE wp.profile_id = $1 AND wp.media_item_id = $2`,
		profileID, engaged).Scan(&engagedTier); err != nil {
		t.Fatalf("engaged tier: %v", err)
	}
	if err := q.pool.QueryRow(ctx, `
		SELECT (wp.completed OR (wp.duration_ms > 0
		        AND wp.position_ms::float8 / wp.duration_ms::float8 >= `+engagedProgressFraction+`))
		FROM watch_progress wp WHERE wp.profile_id = $1 AND wp.media_item_id = $2`,
		profileID, bounced).Scan(&bouncedTier); err != nil {
		t.Fatalf("bounced tier: %v", err)
	}

	if !engagedTier {
		t.Fatal("a half-watched title did not reach the top tier")
	}
	if bouncedTier {
		t.Fatal("a 2%-watched bounce reached the top tier — the threshold is too loose")
	}
}

// duration_ms defaults to 0 and stays there until the player reports it. The
// guard must hold: division by zero would abort the whole slice query, taking
// every recommendation on the server with it.
func TestTasteSlice_ZeroDurationDoesNotDivideByZero(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	for i := 0; i < 3; i++ {
		item := seedEmbeddedItem(t, q, libID, i)
		setProgress(t, q, userID, profileID, item, 5000, 0, false) // duration unknown
	}

	rows, err := q.ProfileEmbeddingSlice(ctx, profileID)
	if err != nil {
		t.Fatalf("zero duration_ms broke the slice: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("slice has %d rows, want 3", len(rows))
	}
}

// Putting the watchlist into the centroid has a second-order effect that is
// easy to miss and ruins the surface: the added title now sits almost exactly
// ON the centroid, so recall hands it straight back as its own nearest
// neighbour. Measured before watchlistedNotExists existed, 5 of 8 recalled
// items were titles the profile had already saved — a discovery rail spending
// its slots repeating what the user told it.
func TestRecall_DoesNotReturnTitlesAlreadyOnTheWatchlist(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	// Saved titles occupy their own region of vector space, so if they were
	// recallable they would necessarily rank top — no tie-breaking to hide
	// behind.
	want := seedWatchlist(t, q, profileID, "want_to_watch")
	favs := seedWatchlist(t, q, profileID, "favorites")
	saved := map[int64]bool{}
	for i := 0; i < 4; i++ {
		it := seedEmbeddedItem(t, q, libID, i)
		addToList(t, q, want, it)
		saved[it] = true
	}
	favItem := seedEmbeddedItem(t, q, libID, 4)
	addToList(t, q, favs, favItem)
	saved[favItem] = true

	for i := 0; i < 30; i++ {
		seedEmbeddedItem(t, q, libID, 100+i)
	}

	vec, err := q.BuildProfileVector(ctx, profileID)
	if err != nil {
		t.Fatalf("vector: %v", err)
	}
	items, err := q.NearestUnwatched(ctx, profileID, vec, 10, nil, "", 0, true)
	if err != nil {
		t.Fatalf("recall: %v", err)
	}
	if len(items) == 0 {
		t.Fatal("recall returned nothing — the exclusion must not starve the pool")
	}
	for _, it := range items {
		if saved[it.ID] {
			t.Fatalf("recall returned item %d, which is already on this profile's watchlist", it.ID)
		}
	}
}

// The 1-2★ exclusion is applied to `src` as a whole, so it must reach the new
// branches too: panning something must stop it steering, however it entered.
func TestTasteSlice_LowRatingSuppressesAWatchlistAdd(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	want := seedWatchlist(t, q, profileID, "want_to_watch")
	panned := seedEmbeddedItem(t, q, libID, 0)
	addToList(t, q, want, panned)
	addToList(t, q, want, seedEmbeddedItem(t, q, libID, 1))
	addToList(t, q, want, seedEmbeddedItem(t, q, libID, 2))

	if err := q.SetUserRating(ctx, profileID, panned, 1); err != nil {
		t.Fatalf("set rating: %v", err)
	}

	if _, err := q.ProfileEmbeddingSlice(ctx, profileID); err != ErrInsufficientHistory {
		t.Fatalf("a 1★ title kept steering from the watchlist: got %v, want ErrInsufficientHistory", err)
	}
}
