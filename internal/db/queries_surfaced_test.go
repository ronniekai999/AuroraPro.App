package db

// Integration tests for the recently-surfaced anti-repetition queries
// (migration 038). Opt-in: set TEST_DATABASE_URL=postgres://... to run (skipped
// otherwise), mirroring queries_notifications_test.go.
//
// Covers both sides: the stateful write path (RecordSurfaced — dedup, upsert,
// per-surface independence, prune) and the read path (NearestUnwatched demotion
// ORDER BY — surfaced items sink but never starve, surface="" is a no-op).

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestRecordSurfaced covers the load-bearing write behaviors: a duplicate id in
// one call doesn't trip ON CONFLICT, re-showing upserts (refreshes recency
// without adding a row), surfaces are independent, and the self-prune drops aged
// rows while keeping fresh ones.
func TestRecordSurfaced(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, userID)

	var profileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO user_profiles (user_id, name) VALUES ($1, $2) RETURNING id`,
		userID, "surf_test").Scan(&profileID); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM user_profiles WHERE id = $1`, profileID) })

	item1 := seedTestMediaItem(t, q, libID)
	item2 := seedTestMediaItem(t, q, libID)

	countWithin := func(surface string, within time.Duration) int {
		var n int
		_ = q.pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM recently_surfaced_items
			 WHERE profile_id=$1 AND surface=$2 AND surfaced_at > NOW() - INTERVAL '1 second' * $3`,
			profileID, surface, int64(within.Seconds())).Scan(&n)
		return n
	}

	// No-ops: empty surface / empty list must not error or write.
	if err := q.RecordSurfaced(ctx, profileID, "", []int64{item1}, time.Hour); err != nil {
		t.Fatalf("empty surface should no-op: %v", err)
	}
	if err := q.RecordSurfaced(ctx, profileID, "hero", nil, time.Hour); err != nil {
		t.Fatalf("empty ids should no-op: %v", err)
	}

	// Record two distinct items, with a duplicate id in the same call — must not
	// trip "ON CONFLICT cannot affect row a second time".
	if err := q.RecordSurfaced(ctx, profileID, "hero", []int64{item1, item2, item1}, 72*time.Hour); err != nil {
		t.Fatalf("record: %v", err)
	}
	if got := countWithin("hero", time.Hour); got != 2 {
		t.Fatalf("want 2 distinct hero rows, got %d", got)
	}
	// Per-surface independence: discover is untouched.
	if got := countWithin("discover", time.Hour); got != 0 {
		t.Errorf("discover surface should be independent/empty, got %d", got)
	}

	// Re-showing item1 upserts (refreshes recency), doesn't add a row.
	if err := q.RecordSurfaced(ctx, profileID, "hero", []int64{item1}, 72*time.Hour); err != nil {
		t.Fatalf("re-record: %v", err)
	}
	if got := countWithin("hero", time.Hour); got != 2 {
		t.Errorf("upsert must not add a row: want 2, got %d", got)
	}

	// Prune: backdate item2 beyond the prune horizon, then a record call with a
	// 24h horizon drops it while keeping the freshly-upserted item1.
	if _, err := q.pool.Exec(ctx,
		`UPDATE recently_surfaced_items SET surfaced_at = NOW() - INTERVAL '10 days'
		 WHERE profile_id=$1 AND media_item_id=$2 AND surface='hero'`,
		profileID, item2); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	if err := q.RecordSurfaced(ctx, profileID, "hero", []int64{item1}, 24*time.Hour); err != nil {
		t.Fatalf("record+prune: %v", err)
	}
	var total int
	_ = q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM recently_surfaced_items WHERE profile_id=$1 AND surface='hero'`,
		profileID).Scan(&total)
	if total != 1 {
		t.Errorf("prune should drop the 10-day-old row: want 1, got %d", total)
	}
}

// oneHotLit builds a 384-dim pgvector literal with a single 1 at idx (the same
// dimensionality setEmbedding uses), so two items get distinct cosine distances.
func oneHotLit(idx int) string {
	parts := make([]string, 384)
	for i := range parts {
		parts[i] = "0"
	}
	parts[idx] = "1"
	return "[" + strings.Join(parts, ",") + "]"
}

// seedEmbeddedItem seeds a media item with a one-hot embedding + a non-empty
// backdrop (NearestUnwatched requires both).
func seedEmbeddedItem(t *testing.T, q *Queries, libID int64, hotIdx int) int64 {
	t.Helper()
	id := seedTestMediaItem(t, q, libID)
	if _, err := q.pool.Exec(context.Background(),
		`UPDATE media_items SET embedding = $1::vector, backdrop_path = '/bd.jpg' WHERE id = $2`,
		oneHotLit(hotIdx), id); err != nil {
		t.Fatalf("seed embedded item: %v", err)
	}
	return id
}

// TestNearestUnwatchedDemotion pins the load-bearing ordering: a recently-shown
// item is DEMOTED below a fresher (farther) one, but never dropped (no
// starvation), and surface="" is a true no-op.
func TestNearestUnwatchedDemotion(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)

	closer := seedEmbeddedItem(t, q, libID, 0)  // distance 0 to query [1,0,...]
	farther := seedEmbeddedItem(t, q, libID, 1) // orthogonal → distance ~1
	queryVec := oneHotLit(0)

	order := func(surface string, within int64) []int64 {
		items, err := q.NearestUnwatched(ctx, profileID, queryVec, 10, nil, surface, within)
		if err != nil {
			t.Fatalf("nearest: %v", err)
		}
		ids := make([]int64, len(items))
		for i, it := range items {
			ids[i] = it.ID
		}
		return ids
	}
	contains := func(ids []int64, want int64) bool {
		for _, id := range ids {
			if id == want {
				return true
			}
		}
		return false
	}

	// Baseline (no anti-repetition): pure distance order, closer first.
	if base := order("", 0); len(base) < 2 || base[0] != closer {
		t.Fatalf("baseline should be closer-first: %v (closer=%d)", base, closer)
	}

	// Mark closer as surfaced on "hero" → it should sort BELOW farther even
	// though it's nearer.
	if err := q.RecordSurfaced(ctx, profileID, "hero", []int64{closer}, 72*time.Hour); err != nil {
		t.Fatalf("record: %v", err)
	}
	demoted := order("hero", int64((72 * time.Hour).Seconds()))
	if len(demoted) < 2 || demoted[0] != farther {
		t.Errorf("surfaced closer should demote below farther: %v (want farther=%d first)", demoted, farther)
	}
	if !contains(demoted, closer) {
		t.Errorf("demotion must keep the item (no starvation): %v missing closer=%d", demoted, closer)
	}

	// surface="" → no-op, closer first again despite the recorded row.
	if got := order("", 0); len(got) < 2 || got[0] != closer {
		t.Errorf("surface=\"\" must be a no-op: %v (want closer=%d first)", got, closer)
	}
}
