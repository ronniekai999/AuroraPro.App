package library

// The defect round three found, pinned so it cannot come back.
//
// A library row whose stored title/year came from TMDB enrichment does NOT
// re-key to itself when the scanner re-parses the filename: media_items is
// upserted on (library_id, type, title, year) taken from the FILENAME, so a
// row saying title="Seven", year=1995 whose folder reads "Se7en (1995)"
// produces a NEW item. Under the previous design the old item was then left
// with no files and the empty-item sweep cascaded away its watch progress.
//
// Moving the rows with the library removes the re-match from the picture
// entirely. This test drives the real scanner over the real schema and asserts
// the enriched item — and its watch progress — comes through intact.

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRepointSurvivesATitleTheRescanWouldReKey(t *testing.T) {
	pool, queries := repointTestPool(t)
	ctx := context.Background()

	newRoot := t.TempDir()
	// The folder parses to "Se7en"/1995; the stored row says "Seven"/1995,
	// which is what TMDB enrichment would have written.
	dir := filepath.Join(newRoot, "Se7en (1995)")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(dir, "Se7en (1995).mkv")
	if err := os.WriteFile(newPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldPath := "/nonexistent/old/Se7en (1995)/Se7en (1995).mkv"

	ownerID, profileID := seedOwner(t, ctx, pool, "rekey")

	lib := &models.Library{
		Name: "ReKey Test", Type: models.LibraryMovies,
		Paths: []string{"/nonexistent/old"}, ScanInterval: 360, OwnerID: ownerID,
	}
	if err := queries.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("create library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id=$1`, lib.ID) })

	// The enriched title — deliberately NOT what the filename parses to.
	var itemID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, year)
		 VALUES ($1, 'movie', 'Seven', 'seven', 1995) RETURNING id`, lib.ID).Scan(&itemID); err != nil {
		t.Fatalf("seed item: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO media_files (media_item_id, path, file_hash, container, size_bytes,
		                          video_codec, audio_codec, resolution, bitrate, duration_ms)
		 VALUES ($1, $2, 'h', 'mkv', 1, 'h264', 'aac', '1080p', 5000000, 7200000)`,
		itemID, oldPath); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed)
		 VALUES ($1, $2, $3, 4242, 7200000, FALSE)`, ownerID, profileID, itemID); err != nil {
		t.Fatalf("seed progress: %v", err)
	}

	// Repoint, moving the row with the library.
	updated, err := queries.RepointLibrary(ctx, lib.ID, lib.Name, []string{newRoot},
		map[int64]string{mustFileID(t, pool, oldPath): newPath}, nil)
	if err != nil {
		t.Fatalf("repoint: %v", err)
	}

	s := NewScanner(config.ScannerConfig{Workers: 2}, queries)
	if err := s.ScanLibrary(ctx, updated, nil); err != nil {
		t.Fatalf("scan: %v", err)
	}

	var alive bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_items WHERE id=$1)`, itemID).Scan(&alive); err != nil {
		t.Fatal(err)
	}
	if !alive {
		t.Fatal("the enriched item was swept — this is the round-three defect, back again")
	}
	var pos int64
	if err := pool.QueryRow(ctx,
		`SELECT position_ms FROM watch_progress WHERE media_item_id=$1`, itemID).Scan(&pos); err != nil {
		t.Fatalf("watch progress was cascaded away: %v", err)
	}
	if pos != 4242 {
		t.Errorf("position changed: got %d, want 4242", pos)
	}
}

func mustFileID(t *testing.T, pool *pgxpool.Pool, path string) int64 {
	t.Helper()
	var id int64
	if err := pool.QueryRow(context.Background(), `SELECT id FROM media_files WHERE path=$1`, path).Scan(&id); err != nil {
		t.Fatalf("file id for %s: %v", path, err)
	}
	return id
}

// The UNSUPPORTED path: something changed libraries.paths without moving the
// file rows — a bare psql UPDATE, or a restored database. Nobody told the
// scanner, so only the data-derived check stands between it and the catalog.
//
// The requirement here is NOT that it recovers. It is that it deletes nothing.
// An earlier design pruned the stale rows once phase 2 had attached the new
// ones, which cascaded the history away for every title the rescan re-keyed.
// The library is now left stuck-but-intact, and the log says how to finish.
func TestBarePathEditDeletesNothing(t *testing.T) {
	pool, queries := repointTestPool(t)
	ctx := context.Background()

	newRoot := t.TempDir()
	dir := filepath.Join(newRoot, "Se7en (1995)")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Se7en (1995).mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldPath := "/nonexistent/bare/Se7en (1995)/Se7en (1995).mkv"

	ownerID, profileID := seedOwner(t, ctx, pool, "bare")

	lib := &models.Library{
		Name: "Bare Edit", Type: models.LibraryMovies,
		Paths: []string{"/nonexistent/bare"}, ScanInterval: 360, OwnerID: ownerID,
	}
	if err := queries.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("create library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id=$1`, lib.ID) })

	var itemID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, year)
		 VALUES ($1, 'movie', 'Seven', 'seven', 1995) RETURNING id`, lib.ID).Scan(&itemID); err != nil {
		t.Fatalf("seed item: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO media_files (media_item_id, path, file_hash, container, size_bytes,
		                          video_codec, audio_codec, resolution, bitrate, duration_ms)
		 VALUES ($1, $2, 'h', 'mkv', 1, 'h264', 'aac', '1080p', 5000000, 7200000)`,
		itemID, oldPath); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed)
		 VALUES ($1, $2, $3, 777, 7200000, FALSE)`, ownerID, profileID, itemID); err != nil {
		t.Fatalf("seed progress: %v", err)
	}

	// The bare edit — paths only, rows untouched. This is what the runbook's
	// old SQL did, and what a restored database looks like.
	if _, err := pool.Exec(ctx, `UPDATE libraries SET paths = $2 WHERE id = $1`, lib.ID, []string{newRoot}); err != nil {
		t.Fatalf("bare path edit: %v", err)
	}
	lib.Paths = []string{newRoot}

	s := NewScanner(config.ScannerConfig{Workers: 2}, queries)
	// Twice: the loss the old design produced arrived on the first or second
	// scan depending on the route, so one pass is not enough to prove safety.
	for i := 0; i < 2; i++ {
		if err := s.ScanLibrary(ctx, lib, nil); err != nil {
			t.Fatalf("scan %d: %v", i+1, err)
		}
	}

	var alive bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_items WHERE id=$1)`, itemID).Scan(&alive); err != nil {
		t.Fatal(err)
	}
	if !alive {
		t.Fatal("a bare libraries.paths edit deleted the media item — nothing may be deleted on a relocation the scanner did not do itself")
	}
	var pos int64
	if err := pool.QueryRow(ctx, `SELECT position_ms FROM watch_progress WHERE media_item_id=$1`, itemID).Scan(&pos); err != nil {
		t.Fatalf("watch progress was cascaded away by a bare path edit: %v", err)
	}
	if pos != 777 {
		t.Errorf("position changed: got %d, want 777", pos)
	}
	// The old row is still there — that is the "stuck" state, and it is the
	// correct outcome for a move nobody finished. Losing it would mean the
	// prune ran on evidence it did not have.
	var stale int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM media_files WHERE path=$1`, oldPath).Scan(&stale); err != nil {
		t.Fatal(err)
	}
	if stale != 1 {
		t.Errorf("the stale row was pruned (%d left) — a relocation must delete nothing", stale)
	}
}
