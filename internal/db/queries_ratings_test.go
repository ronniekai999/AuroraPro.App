package db

// Integration tests for star ratings (user_ratings, migration 048). Opt-in via
// TEST_DATABASE_URL (skipped otherwise). Cover the load-bearing behaviors:
// upsert-replaces / delete-clears, 1-2★ excludes from recall AND from the
// taste slice (the "watched 5 minutes, hated it" fix) AND from the anchor
// pool, 4-5★ feeds (and can bootstrap) the taste vector, and the
// positive/negative anchor split that drives the LLM prompts.

import (
	"context"
	"testing"
)

// seedRatingWatch inserts a bare watch_progress row (movie-shaped:
// episode_id NULL). Direct INSERT rather than UpsertWatchProgress so the
// tests don't depend on the completion-threshold setting.
func seedRatingWatch(t *testing.T, q *Queries, userID, profileID, mediaItemID int64, completed bool) {
	t.Helper()
	if _, err := q.pool.Exec(context.Background(),
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed)
		 VALUES ($1, $2, $3, 300000, 5400000, $4)`,
		userID, profileID, mediaItemID, completed); err != nil {
		t.Fatalf("seed watch: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(),
			`DELETE FROM watch_progress WHERE profile_id = $1 AND media_item_id = $2`, profileID, mediaItemID)
	})
}

func cleanupRatings(t *testing.T, q *Queries, profileID int64) {
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM user_ratings WHERE profile_id=$1`, profileID)
	})
}

func TestSetUserRatingUpsertAndClear(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	item := seedTestMediaItem(t, q, libID)
	cleanupRatings(t, q, profileID)

	read := func() int {
		stars, err := q.GetUserRating(ctx, profileID, item)
		if err != nil {
			t.Fatalf("get rating: %v", err)
		}
		return stars
	}

	for _, bad := range []int{0, 6, -1} {
		if err := q.SetUserRating(ctx, profileID, item, bad); err == nil {
			t.Errorf("stars=%d should error", bad)
		}
	}
	if read() != 0 {
		t.Fatalf("unrated item should read 0, got %d", read())
	}
	if err := q.SetUserRating(ctx, profileID, item, 4); err != nil {
		t.Fatal(err)
	}
	if read() != 4 {
		t.Errorf("want 4, got %d", read())
	}
	// Re-rating replaces (PK collision upserts) — one verdict per (profile, item).
	if err := q.SetUserRating(ctx, profileID, item, 1); err != nil {
		t.Fatal(err)
	}
	if read() != 1 {
		t.Errorf("re-rate should replace: want 1, got %d", read())
	}
	if err := q.DeleteUserRating(ctx, profileID, item); err != nil {
		t.Fatal(err)
	}
	if read() != 0 {
		t.Errorf("clear should delete, got %d", read())
	}
}

func TestLowStarsExcludeFromRecall(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	cleanupRatings(t, q, profileID)

	a := seedEmbeddedItem(t, q, libID, 0) // closest to query [1,0,…]
	b := seedEmbeddedItem(t, q, libID, 1)
	query := oneHotLit(0)

	recall := func() map[int64]bool {
		items, err := q.NearestUnwatched(ctx, profileID, query, 10, nil, "", 0, false)
		if err != nil {
			t.Fatalf("nearest: %v", err)
		}
		m := map[int64]bool{}
		for _, it := range items {
			m[it.ID] = true
		}
		return m
	}
	if base := recall(); !base[a] || !base[b] {
		t.Fatalf("baseline should include both a,b: %v", base)
	}
	// A NEUTRAL (3★) rating must not exclude.
	if err := q.SetUserRating(ctx, profileID, a, negativeStarsMax+1); err != nil {
		t.Fatal(err)
	}
	if got := recall(); !got[a] {
		t.Errorf("a 3★ title must still be recallable")
	}
	// 1-2★ excludes.
	if err := q.SetUserRating(ctx, profileID, a, negativeStarsMax); err != nil {
		t.Fatal(err)
	}
	got := recall()
	if got[a] {
		t.Errorf("a low-starred item must be excluded from NearestUnwatched")
	}
	if !got[b] {
		t.Errorf("a non-rated item should remain")
	}
}

func TestHighStarsFeedTasteVector(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	cleanupRatings(t, q, profileID)

	// No history → insufficient.
	if _, err := q.BuildProfileVector(ctx, profileID); err == nil {
		t.Fatalf("expected ErrInsufficientHistory with no history")
	}
	// 4-5★ three embedded items → the centroid now builds (a high rating
	// counts like a thumb/seed, satisfying the min-history gate).
	for i := 0; i < 3; i++ {
		item := seedEmbeddedItem(t, q, libID, i)
		if err := q.SetUserRating(ctx, profileID, item, positiveStarsMin); err != nil {
			t.Fatal(err)
		}
	}
	vec, err := q.BuildProfileVector(ctx, profileID)
	if err != nil {
		t.Fatalf("4★ items should satisfy the taste-vector min-history gate: %v", err)
	}
	if vec == "" {
		t.Errorf("expected a non-empty centroid")
	}
	// The cold-start hint must agree with the gate it explains: a profile
	// bootstrapped purely by ratings counts as personalized history
	// (adversarial-review M-finding — the old count ignored ratings and
	// thumbs, showing "0/3 so far" under fully personalized picks).
	if n, err := q.PersonalizationHistoryCount(ctx, profileID); err != nil || n != 3 {
		t.Errorf("history count should mirror the taste slice: want 3, got %d (err %v)", n, err)
	}
}

// TestLowStarsRemoveWatchFromTasteSlice pins the headline scenario: start a
// movie, bail after 5 minutes, 1-star it. The abandoned watch_progress row
// was feeding the taste slice (it doesn't filter on completed); the 1★ must
// evict it so the title stops pulling the centroid.
func TestLowStarsRemoveWatchFromTasteSlice(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	cleanupRatings(t, q, profileID)

	items := make([]int64, 4)
	for i := range items {
		items[i] = seedEmbeddedItem(t, q, libID, i)
		seedRatingWatch(t, q, userID, profileID, items[i], i > 0) // items[0] in-progress, rest completed
	}
	slice := func() int {
		rows, err := q.ProfileEmbeddingSlice(ctx, profileID)
		if err != nil {
			t.Fatalf("profile embedding slice: %v", err)
		}
		// The cold-start hint counts the same slice — they may never diverge.
		if n, cerr := q.PersonalizationHistoryCount(ctx, profileID); cerr != nil || n != len(rows) {
			t.Errorf("history count (%d, err %v) diverged from the taste slice (%d rows)", n, cerr, len(rows))
		}
		return len(rows)
	}
	if n := slice(); n != 4 {
		t.Fatalf("baseline slice should hold all 4 watches, got %d", n)
	}
	// 1★ the abandoned watch → its row leaves the slice.
	if err := q.SetUserRating(ctx, profileID, items[0], 1); err != nil {
		t.Fatal(err)
	}
	if n := slice(); n != 3 {
		t.Errorf("1★ should evict the watched row from the taste slice: want 3, got %d", n)
	}
	// A 4★ rating on an UNWATCHED title joins the slice (rating-only branch).
	extra := seedEmbeddedItem(t, q, libID, 4)
	if err := q.SetUserRating(ctx, profileID, extra, 5); err != nil {
		t.Fatal(err)
	}
	if n := slice(); n != 4 {
		t.Errorf("5★ on an unwatched title should join the slice: want 4, got %d", n)
	}
	// …but never double-weight: rating a WATCHED title adds no second row.
	if err := q.SetUserRating(ctx, profileID, items[1], 5); err != nil {
		t.Fatal(err)
	}
	if n := slice(); n != 4 {
		t.Errorf("rating a watched title must not double-weight it: want 4, got %d", n)
	}
}

// TestRatingAnchorSplit pins the positive/negative anchor separation that
// feeds the LLM prompts: RecentTasteAnchors carries stars and drops 1-2★
// titles; LowRatedAnchors returns exactly those.
func TestRatingAnchorSplit(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	cleanupRatings(t, q, profileID)

	loved := seedEmbeddedItem(t, q, libID, 0)
	panned := seedEmbeddedItem(t, q, libID, 1)
	seedRatingWatch(t, q, userID, profileID, loved, true)
	seedRatingWatch(t, q, userID, profileID, panned, false)

	if err := q.SetUserRating(ctx, profileID, loved, 5); err != nil {
		t.Fatal(err)
	}
	if err := q.SetUserRating(ctx, profileID, panned, 1); err != nil {
		t.Fatal(err)
	}

	anchors, err := q.RecentTasteAnchors(ctx, profileID, 5)
	if err != nil {
		t.Fatalf("taste anchors: %v", err)
	}
	for _, a := range anchors {
		if a.ID == panned {
			t.Errorf("1★ title must not appear as a positive taste anchor")
		}
		if a.ID == loved && a.Stars != 5 {
			t.Errorf("anchor should carry the profile's stars: want 5, got %d", a.Stars)
		}
	}

	low, err := q.LowRatedAnchors(ctx, profileID, 3)
	if err != nil {
		t.Fatalf("low rated anchors: %v", err)
	}
	if len(low) != 1 || low[0].ID != panned || low[0].Stars != 1 {
		t.Errorf("LowRatedAnchors should return exactly the panned title with its stars, got %+v", low)
	}

	// Neither a panned nor a 👎'd title may headline a "Because You Watched X"
	// rail (the thumbs half landed with this pass — review-flagged asymmetry).
	thumbed := seedEmbeddedItem(t, q, libID, 2)
	seedRatingWatch(t, q, userID, profileID, thumbed, true)
	if err := q.RecordItemFeedback(ctx, profileID, thumbed, "down"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM item_feedback WHERE profile_id=$1`, profileID)
	})
	railAnchors, err := q.RecentAnchorsWithEmbeddings(ctx, profileID, 10)
	if err != nil {
		t.Fatalf("anchor rails: %v", err)
	}
	for _, a := range railAnchors {
		if a.MediaItemID == panned {
			t.Errorf("1★ title must not be an anchor-rail anchor")
		}
		if a.MediaItemID == thumbed {
			t.Errorf("👎'd title must not be an anchor-rail anchor")
		}
	}
	if len(railAnchors) == 0 {
		t.Errorf("the loved title should still anchor a rail")
	}
}
