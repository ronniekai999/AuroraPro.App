package db

// Integration tests for Phase D steerable thumbs (item_feedback, migration 039).
// Opt-in via TEST_DATABASE_URL (skipped otherwise). Cover the three load-bearing
// behaviors: upsert-replaces / delete-clears, 👎 excludes from recall, and 👍
// feeds (and can bootstrap) the taste vector.

import (
	"context"
	"testing"
)

func TestRecordItemFeedbackUpsertAndClear(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	item := seedTestMediaItem(t, q, libID)
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM item_feedback WHERE profile_id=$1`, profileID) })

	read := func() string {
		var fb string
		_ = q.pool.QueryRow(ctx,
			`SELECT COALESCE(MAX(feedback),'') FROM item_feedback WHERE profile_id=$1 AND media_item_id=$2`,
			profileID, item).Scan(&fb)
		return fb
	}

	if err := q.RecordItemFeedback(ctx, profileID, item, "sideways"); err == nil {
		t.Errorf("invalid direction should error")
	}
	if err := q.RecordItemFeedback(ctx, profileID, item, "up"); err != nil {
		t.Fatal(err)
	}
	if read() != "up" {
		t.Errorf("want up, got %q", read())
	}
	// Re-thumbing replaces (PK collision upserts) — one verdict per (profile,item).
	if err := q.RecordItemFeedback(ctx, profileID, item, "down"); err != nil {
		t.Fatal(err)
	}
	if read() != "down" {
		t.Errorf("re-thumb should replace: want down, got %q", read())
	}
	if err := q.DeleteItemFeedback(ctx, profileID, item); err != nil {
		t.Fatal(err)
	}
	if read() != "" {
		t.Errorf("clear should delete, got %q", read())
	}
}

func TestThumbsDownExcludesFromRecall(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM item_feedback WHERE profile_id=$1`, profileID) })

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
	if err := q.RecordItemFeedback(ctx, profileID, a, "down"); err != nil {
		t.Fatal(err)
	}
	got := recall()
	if got[a] {
		t.Errorf("👎'd item must be excluded from NearestUnwatched")
	}
	if !got[b] {
		t.Errorf("a non-disliked item should remain")
	}
}

func TestThumbsUpFeedsTasteVector(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM item_feedback WHERE profile_id=$1`, profileID) })

	// No history → insufficient.
	if _, err := q.BuildProfileVector(ctx, profileID); err == nil {
		t.Fatalf("expected ErrInsufficientHistory with no history")
	}
	// 👍 three embedded items → the centroid now builds (👍 counts like a seed,
	// satisfying the min-history gate and pulling "more like this").
	for i := 0; i < 3; i++ {
		item := seedEmbeddedItem(t, q, libID, i)
		if err := q.RecordItemFeedback(ctx, profileID, item, "up"); err != nil {
			t.Fatal(err)
		}
	}
	vec, err := q.BuildProfileVector(ctx, profileID)
	if err != nil {
		t.Fatalf("👍 items should satisfy the taste-vector min-history gate: %v", err)
	}
	if vec == "" {
		t.Errorf("expected a non-empty centroid")
	}
}
