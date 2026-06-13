package db

// Integration coverage for catalog deletion: DeleteEmptyMediaItems (the
// scanner's automatic "no files available" ghost sweep) and DeleteMediaItem
// (the admin manual remove). Both must (a) remove exactly the right rows and
// (b) leave titles that still have files untouched — the load-bearing safety
// property, since a too-aggressive sweep would wipe a live catalog.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.
// Shares the harness (requireIntegrationDB / seedTestUser / seedTestLibrary /
// randomSuffix) with queries_jsonb_integration_test.go. Everything is created
// under a temporary library whose t.Cleanup cascade-reaps any leftovers.

import (
	"context"
	"testing"
)

func TestDeleteEmptyMediaItems(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, owner)

	insertItem := func(typ, title string) int64 {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title)
			 VALUES ($1, $2, $3, $3) RETURNING id`,
			libID, typ, title).Scan(&id); err != nil {
			t.Fatalf("insert %s item: %v", typ, err)
		}
		return id
	}
	addSeasonEpisode := func(itemID int64) int64 {
		var seasonID, epID int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1, 1) RETURNING id`,
			itemID).Scan(&seasonID); err != nil {
			t.Fatalf("insert season: %v", err)
		}
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1, $2, 1) RETURNING id`,
			seasonID, itemID).Scan(&epID); err != nil {
			t.Fatalf("insert episode: %v", err)
		}
		return epID
	}

	// Movie WITH a file → must survive.
	movieKeep := insertItem("movie", "Keep Movie "+randomSuffix(t))
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO media_files (media_item_id, path, file_hash) VALUES ($1, $2, 'h')`,
		movieKeep, "/tmp/keep-"+randomSuffix(t)+".mkv"); err != nil {
		t.Fatalf("insert media_file: %v", err)
	}
	// Movie with no file at all → ghost, must be removed.
	movieGhost := insertItem("movie", "Ghost Movie "+randomSuffix(t))

	// Show with an episode file → must survive.
	showKeep := insertItem("show", "Keep Show "+randomSuffix(t))
	epKeep := addSeasonEpisode(showKeep)
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO episode_files (episode_id, path, file_hash) VALUES ($1, $2, 'h')`,
		epKeep, "/tmp/keep-ep-"+randomSuffix(t)+".mkv"); err != nil {
		t.Fatalf("insert episode_file: %v", err)
	}
	// Show whose episodes lost every file (season+episode rows remain, but no
	// episode_file) → ghost, must be removed. This is the exact shape the file
	// prune leaves behind once a show is deleted from disk.
	showGhost := insertItem("show", "Ghost Show "+randomSuffix(t))
	addSeasonEpisode(showGhost)

	removed, err := q.DeleteEmptyMediaItems(ctx, libID)
	if err != nil {
		t.Fatalf("DeleteEmptyMediaItems: %v", err)
	}
	removedSet := make(map[int64]bool, len(removed))
	for _, d := range removed {
		removedSet[d.ID] = true
	}

	if !removedSet[movieGhost] {
		t.Errorf("fileless movie %d should have been removed", movieGhost)
	}
	if !removedSet[showGhost] {
		t.Errorf("fileless show %d should have been removed", showGhost)
	}
	if removedSet[movieKeep] {
		t.Errorf("movie with a file %d must NOT be removed", movieKeep)
	}
	if removedSet[showKeep] {
		t.Errorf("show with an episode file %d must NOT be removed", showKeep)
	}

	exists := func(id int64) bool {
		var n int
		if err := q.pool.QueryRow(ctx, `SELECT count(*) FROM media_items WHERE id = $1`, id).Scan(&n); err != nil {
			t.Fatalf("existence check for %d: %v", id, err)
		}
		return n > 0
	}
	if !exists(movieKeep) || !exists(showKeep) {
		t.Error("titles with files were deleted from the catalog")
	}
	if exists(movieGhost) || exists(showGhost) {
		t.Error("ghost titles still present after sweep")
	}
}

func TestDeleteMediaItemCascades(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, owner)

	var showID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title)
		 VALUES ($1, 'show', $2, $2) RETURNING id`,
		libID, "Delete Me "+randomSuffix(t)).Scan(&showID); err != nil {
		t.Fatalf("insert item: %v", err)
	}
	var seasonID, epID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_seasons (media_item_id, season_number) VALUES ($1, 1) RETURNING id`,
		showID).Scan(&seasonID); err != nil {
		t.Fatalf("insert season: %v", err)
	}
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_episodes (season_id, media_item_id, episode_number) VALUES ($1, $2, 1) RETURNING id`,
		seasonID, showID).Scan(&epID); err != nil {
		t.Fatalf("insert episode: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO episode_files (episode_id, path, file_hash) VALUES ($1, $2, 'h')`,
		epID, "/tmp/del-"+randomSuffix(t)+".mkv"); err != nil {
		t.Fatalf("insert episode_file: %v", err)
	}

	ok, err := q.DeleteMediaItem(ctx, showID)
	if err != nil {
		t.Fatalf("DeleteMediaItem: %v", err)
	}
	if !ok {
		t.Fatal("expected deleted=true for an existing item")
	}

	// Children must be gone via ON DELETE CASCADE.
	count := func(query string, arg int64) int {
		var n int
		if err := q.pool.QueryRow(ctx, query, arg).Scan(&n); err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}
	if n := count(`SELECT count(*) FROM tv_seasons WHERE media_item_id = $1`, showID); n != 0 {
		t.Errorf("expected seasons cascaded away, found %d", n)
	}
	if n := count(`SELECT count(*) FROM episode_files WHERE episode_id = $1`, epID); n != 0 {
		t.Errorf("expected episode_files cascaded away, found %d", n)
	}

	// Deleting an already-removed id reports false (not an error).
	ok2, err := q.DeleteMediaItem(ctx, showID)
	if err != nil {
		t.Fatalf("second DeleteMediaItem: %v", err)
	}
	if ok2 {
		t.Error("expected deleted=false for an already-removed item")
	}
}
