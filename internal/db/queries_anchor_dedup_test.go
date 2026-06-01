package db

// Integration test for the duplicate-"Because you watched X" rail fix.
//
// watch_progress holds one row PER EPISODE, so a binged show has many rows
// all pointing at the same media_items row. RecentAnchorsWithEmbeddings
// previously JOINed without collapsing them, returning the same title once
// per watched episode — and AnchorRailsFor built one rail per anchor, so a
// show watched across N episodes produced N identical rails. The query now
// DISTINCT ON (m.id) collapses to one anchor per title.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run. Skipped otherwise
// (reuses requireIntegrationDB / seedTestUser / seedTestLibrary /
// seedTestMediaItem / seedDefaultProfile from the other integration tests).

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// seedShowWithEpisodes inserts a tv_seasons row + `n` tv_episodes under the
// given media item and returns the episode ids. Satisfies the
// watch_progress.episode_id FK so we can record per-episode progress.
func seedShowWithEpisodes(t *testing.T, q *Queries, mediaItemID int64, n int) []int64 {
	t.Helper()
	var seasonID int64
	if err := q.pool.QueryRow(context.Background(),
		`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1, 1) RETURNING id`,
		mediaItemID,
	).Scan(&seasonID); err != nil {
		t.Fatalf("seed season: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM tv_seasons WHERE id = $1`, seasonID)
	})
	ids := make([]int64, 0, n)
	for i := 1; i <= n; i++ {
		var epID int64
		if err := q.pool.QueryRow(context.Background(),
			`INSERT INTO tv_episodes (media_item_id, season_id, episode_number, title)
			 VALUES ($1, $2, $3, $4) RETURNING id`,
			mediaItemID, seasonID, i, fmt.Sprintf("Episode %d", i),
		).Scan(&epID); err != nil {
			t.Fatalf("seed episode %d: %v", i, err)
		}
		ids = append(ids, epID)
	}
	return ids
}

// setEmbedding gives a media item a non-null 384-dim embedding so it
// qualifies as an anchor (RecentAnchorsWithEmbeddings filters on
// embedding IS NOT NULL). The exact values don't matter for the dedup
// query — only that the column is well-formed and non-null — so we use a
// constant unit-ish vector ([1,0,0,…]).
func setEmbedding(t *testing.T, q *Queries, mediaItemID int64) {
	t.Helper()
	parts := make([]string, 384)
	for i := range parts {
		parts[i] = "0"
	}
	parts[0] = "1"
	lit := "[" + strings.Join(parts, ",") + "]"
	if _, err := q.pool.Exec(context.Background(),
		`UPDATE media_items SET embedding = $1::vector WHERE id = $2`, lit, mediaItemID); err != nil {
		t.Fatalf("set embedding: %v", err)
	}
}

// TestRecentAnchorsWithEmbeddings_DedupesPerShow pins the fix: a show with
// progress on several episodes contributes ONE anchor, not one per episode.
func TestRecentAnchorsWithEmbeddings_DedupesPerShow(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libraryID := seedTestLibrary(t, q, userID)

	// A binged show: one media item, three watched episodes.
	showID := seedTestMediaItem(t, q, libraryID)
	setEmbedding(t, q, showID)
	epIDs := seedShowWithEpisodes(t, q, showID, 3)
	for _, epID := range epIDs {
		ep := epID
		if _, err := q.pool.Exec(context.Background(),
			`INSERT INTO watch_progress (user_id, profile_id, media_item_id, episode_id, position_ms, duration_ms, completed)
			 VALUES ($1, $2, $3, $4, 1000, 1000, true)`,
			userID, profileID, showID, ep); err != nil {
			t.Fatalf("seed watch_progress ep %d: %v", ep, err)
		}
	}

	// A second, distinct title (movie) watched once — should appear as its
	// own single anchor, proving we dedupe per-title, not collapse to one.
	movieID := seedTestMediaItem(t, q, libraryID)
	setEmbedding(t, q, movieID)
	if _, err := q.pool.Exec(context.Background(),
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed)
		 VALUES ($1, $2, $3, 1000, 1000, true)`,
		userID, profileID, movieID); err != nil {
		t.Fatalf("seed movie watch_progress: %v", err)
	}

	anchors, err := q.RecentAnchorsWithEmbeddings(context.Background(), profileID, 10)
	if err != nil {
		t.Fatalf("RecentAnchorsWithEmbeddings: %v", err)
	}

	counts := map[int64]int{}
	for _, a := range anchors {
		counts[a.MediaItemID]++
	}
	if counts[showID] != 1 {
		t.Errorf("binged show appeared %d times, want exactly 1 (the duplicate-rail bug)", counts[showID])
	}
	if counts[movieID] != 1 {
		t.Errorf("movie appeared %d times, want 1", counts[movieID])
	}
	if len(anchors) != 2 {
		t.Errorf("got %d anchors, want 2 (one per distinct title)", len(anchors))
	}
}
