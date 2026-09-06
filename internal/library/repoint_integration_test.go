package library

// End-to-end repoint against a real database (TEST_DATABASE_URL opt-in; CI
// runs a pgvector Postgres and exports it).
//
// This is the test the whole change exists for, and its absence is where both
// rounds of adversarial review found their real defects: the guards
// themselves were pinned by tables, but nothing exercised ScanLibrary's
// wiring — the deferred call after phase 2, its preconditions, and the
// clear that follows.
//
// It asserts the promise the runbook makes to operators: move the files,
// repoint the library, and your watch history is still attached afterwards.

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5/pgxpool"
)

func repointTestPool(t *testing.T) (*pgxpool.Pool, *db.Queries) {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping repoint integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, db.NewQueries(pool)
}

// seedOwner creates a user + default profile for one test.
//
// The username is randomised and the failure is FATAL, both deliberately. A
// fixed name plus t.Skipf meant a row left behind by an aborted run — a CI
// cancellation, a -timeout kill, two concurrent runs against one
// TEST_DATABASE_URL — turned the only end-to-end coverage of this feature into
// a silent skip that still reported ok.
func seedOwner(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tag string) (userID, profileID int64) {
	t.Helper()
	name := fmt.Sprintf("%s_%d", tag, rand.Int63())
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash, role)
		 VALUES ($1, $2, 'x', 'admin') RETURNING id`, name, name+"@test.local").Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID) })

	if err := pool.QueryRow(ctx,
		`SELECT id FROM user_profiles WHERE user_id=$1 ORDER BY is_default DESC, id ASC LIMIT 1`,
		userID).Scan(&profileID); err != nil {
		if err := pool.QueryRow(ctx,
			`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
			 VALUES ($1, $2, TRUE, 'en', 'off') RETURNING id`, userID, name).Scan(&profileID); err != nil {
			t.Fatalf("seed profile: %v", err)
		}
	}
	return userID, profileID
}

// seedMovie writes a media_item + media_file directly, standing in for a scan
// that ran before the move.
func seedMovie(t *testing.T, ctx context.Context, pool *pgxpool.Pool, libID int64, title string, path string) int64 {
	t.Helper()
	var itemID int64
	err := pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, year)
		 VALUES ($1, 'movie', $2, $2, 2011) RETURNING id`, libID, title).Scan(&itemID)
	if err != nil {
		t.Fatalf("seed media_item: %v", err)
	}
	// Every column GetMediaFileByPath scans into a non-nullable Go type must
	// be present, or processFile fails with "cannot scan NULL into *string",
	// ScanLibrary logs and swallows it, and the whole of phase 2 silently does
	// nothing — which is exactly how these tests used to pass.
	_, err = pool.Exec(ctx,
		`INSERT INTO media_files (media_item_id, path, file_hash, container, size_bytes,
		                          video_codec, audio_codec, resolution, bitrate, duration_ms)
		 VALUES ($1, $2, 'seedhash', 'mkv', 1, 'h264', 'aac', '1080p', 5000000, 7200000)`, itemID, path)
	if err != nil {
		t.Fatalf("seed media_file: %v", err)
	}
	return itemID
}

// TestRepointPreservesWatchHistory is acceptance criterion 2 and 3, end to
// end: a library whose files moved on disk, scanned once at its new paths,
// must come out the other side with the SAME media_items rows and therefore
// the same watch_progress — and with the dead old-location rows gone, so the
// title is playable (criterion 4) rather than left pointing at a path that no
// longer exists.
func TestRepointPreservesWatchHistoryAndClearsTheOldRows(t *testing.T) {
	pool, queries := repointTestPool(t)
	ctx := context.Background()

	// A real directory holding the "moved" file, and an old path that does
	// not exist any more.
	newRoot := t.TempDir()
	movieDir := filepath.Join(newRoot, "Some Film (2011)")
	if err := os.MkdirAll(movieDir, 0o755); err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(movieDir, "Some Film (2011).mkv")
	if err := os.WriteFile(newPath, []byte("not really a video"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldPath := "/nonexistent/old-root/Some Film (2011)/Some Film (2011).mkv"

	// Owner + library.
	ownerID, profileID := seedOwner(t, ctx, pool, "repoint")

	lib := &models.Library{
		Name: "Repoint Test", Type: models.LibraryMovies,
		Paths: []string{"/nonexistent/old-root"}, ScanInterval: 360, OwnerID: ownerID,
	}
	if err := queries.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("create library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id=$1`, lib.ID) })

	itemID := seedMovie(t, ctx, pool, lib.ID, "Some Film", oldPath)

	// The thing that must survive.
	if _, err := pool.Exec(ctx,
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed)
		 VALUES ($1, $2, $3, 1234567, 7200000, FALSE)`, ownerID, profileID, itemID); err != nil {
		t.Fatalf("seed watch_progress: %v", err)
	}

	// ── The repoint ───────────────────────────────────────────────
	// The supported path: move the recorded rows WITH the library, in one
	// transaction. Not UpdateLibrary + rescan — that relies on the rescan
	// re-matching each file to the same media_items row, which it does not do
	// when enrichment has rewritten the stored title or year.
	recorded, err := queries.GetMediaFilePathsForLibrary(ctx, lib.ID)
	if err != nil {
		t.Fatalf("read recorded paths: %v", err)
	}
	moves := map[int64]string{}
	for p, id := range recorded {
		if p == oldPath {
			moves[id] = newPath
		}
	}
	if len(moves) != 1 {
		t.Fatalf("expected exactly the seeded row to move, got %v", moves)
	}
	updated, err := queries.RepointLibrary(ctx, lib.ID, lib.Name, []string{newRoot}, moves, nil)
	if err != nil {
		t.Fatalf("repoint: %v", err)
	}
	if len(updated.Paths) != 1 || updated.Paths[0] != newRoot {
		t.Fatalf("paths not persisted: %v", updated.Paths)
	}

	// The scan afterwards must find nothing to do: the rows and the walk
	// already agree. This is the property the whole design now rests on.
	s := NewScanner(config.ScannerConfig{Workers: 2}, queries)
	if err := s.ScanLibrary(ctx, updated, nil); err != nil {
		t.Fatalf("scan: %v", err)
	}

	// ── The promise ───────────────────────────────────────────────
	var itemStillThere bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_items WHERE id=$1)`, itemID).Scan(&itemStillThere); err != nil {
		t.Fatal(err)
	}
	if !itemStillThere {
		t.Fatal("the media item was deleted by the repoint scan — the empty-item sweep cascaded it, which is the exact loss this change exists to prevent")
	}

	var progressMs int64
	if err := pool.QueryRow(ctx,
		`SELECT position_ms FROM watch_progress WHERE media_item_id=$1 AND user_id=$2`,
		itemID, ownerID).Scan(&progressMs); err != nil {
		t.Fatalf("watch progress did not survive the repoint: %v", err)
	}
	if progressMs != 1234567 {
		t.Errorf("watch position changed: got %d, want 1234567", progressMs)
	}

	// The new file must be attached to the SAME item — that is what makes the
	// history still mean something.
	var attachedTo int64
	if err := pool.QueryRow(ctx, `SELECT media_item_id FROM media_files WHERE path=$1`, newPath).Scan(&attachedTo); err != nil {
		t.Fatalf("the moved file was not attached: %v", err)
	}
	if attachedTo != itemID {
		t.Errorf("the moved file was attached to a NEW item %d, not the original %d — history is orphaned", attachedTo, itemID)
	}

	// And no dead row may remain, or nothing plays: GetMediaFiles orders by
	// id, so an older row pointing at the previous location would sort first
	// and be the one the player picks.
	var deadRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM media_files WHERE path=$1`, oldPath).Scan(&deadRows); err != nil {
		t.Fatal(err)
	}
	if deadRows != 0 {
		t.Errorf("a row still points at the old location (%d rows) — the title's first file is a dead path and will not play", deadRows)
	}
}

// The other half of the contract: an ordinary deletion must STILL be pruned.
// A guard that defers too eagerly is a prune that never runs, and the
// "no files available" ghost comes back.
func TestOrdinaryDeletionIsStillPrunedAfterTheRelocationGuards(t *testing.T) {
	pool, queries := repointTestPool(t)
	ctx := context.Background()

	root := t.TempDir()
	keepDir := filepath.Join(root, "Kept Film (2011)")
	if err := os.MkdirAll(keepDir, 0o755); err != nil {
		t.Fatal(err)
	}
	keptPath := filepath.Join(keepDir, "Kept Film (2011).mkv")
	if err := os.WriteFile(keptPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Under the SAME root, so allPathsOutsideRoots cannot fire — but absent
	// from disk, so it is a genuine deletion.
	gonePath := filepath.Join(root, "Gone Film (2011)", "Gone Film (2011).mkv")

	ownerID, _ := seedOwner(t, ctx, pool, "prune")

	lib := &models.Library{
		Name: "Prune Test", Type: models.LibraryMovies,
		Paths: []string{root}, ScanInterval: 360, OwnerID: ownerID,
	}
	if err := queries.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("create library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id=$1`, lib.ID) })

	goneItem := seedMovie(t, ctx, pool, lib.ID, "Gone Film", gonePath)

	s := NewScanner(config.ScannerConfig{Workers: 2}, queries)
	if err := s.ScanLibrary(ctx, lib, nil); err != nil {
		t.Fatalf("scan: %v", err)
	}

	var goneRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM media_files WHERE path=$1`, gonePath).Scan(&goneRows); err != nil {
		t.Fatal(err)
	}
	if goneRows != 0 {
		t.Error("a genuinely deleted file was not pruned — the relocation guards are too eager")
	}
	var ghostExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_items WHERE id=$1)`, goneItem).Scan(&ghostExists); err != nil {
		t.Fatal(err)
	}
	if ghostExists {
		t.Error("the emptied media item was not swept — the 'no files available' ghost is back")
	}
}
