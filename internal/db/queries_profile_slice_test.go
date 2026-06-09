package db

// Integration test for ProfileEmbeddingSlice (Phase E1 multi-centroid taste) —
// the un-averaged twin of BuildProfileVector. Opt-in via TEST_DATABASE_URL.

import (
	"context"
	"strings"
	"testing"
)

func TestProfileEmbeddingSlice(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM item_feedback WHERE profile_id=$1`, profileID) })

	// Drive the slice through Phase D 👍 feedback (one branch of the shared CTE).
	a := seedEmbeddedItem(t, q, libID, 0)
	b := seedEmbeddedItem(t, q, libID, 1)
	if err := q.RecordItemFeedback(ctx, profileID, a, "up"); err != nil {
		t.Fatal(err)
	}
	if err := q.RecordItemFeedback(ctx, profileID, b, "up"); err != nil {
		t.Fatal(err)
	}

	// Below minHistoryItems (3) → ErrInsufficientHistory, same contract as
	// BuildProfileVector (so callers fall back identically).
	if _, err := q.ProfileEmbeddingSlice(ctx, profileID); err != ErrInsufficientHistory {
		t.Fatalf("with 2 items want ErrInsufficientHistory, got %v", err)
	}
	if _, err := q.BuildProfileVector(ctx, profileID); err != ErrInsufficientHistory {
		t.Fatalf("BuildProfileVector should also be insufficient at 2 items, got %v", err)
	}

	// Third item clears the gate: the slice returns one pgvector literal PER item
	// (un-averaged), where BuildProfileVector returns a single average.
	c := seedEmbeddedItem(t, q, libID, 2)
	if err := q.RecordItemFeedback(ctx, profileID, c, "up"); err != nil {
		t.Fatal(err)
	}
	rows, err := q.ProfileEmbeddingSlice(ctx, profileID)
	if err != nil {
		t.Fatalf("slice: %v", err)
	}
	if len(rows) != 3 {
		t.Errorf("want 3 embedding literals, got %d", len(rows))
	}
	for i, r := range rows {
		if !strings.HasPrefix(strings.TrimSpace(r), "[") {
			t.Errorf("row %d is not a pgvector literal: %q", i, r)
		}
	}
	if _, err := q.BuildProfileVector(ctx, profileID); err != nil {
		t.Errorf("BuildProfileVector should now succeed: %v", err)
	}
}
