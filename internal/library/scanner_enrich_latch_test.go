package library

// The scanner half of issue #510: a TV show whose media_items row exists but
// whose enrichment never ran must be re-queued for a FULL enrichment pass, not
// downgraded to an episode-only backfill.
//
// Why this needs a real database rather than a unit test: the decision is made
// inside processFile from what FindMediaItemByTitle reports about the stored
// row, and the whole defect was that "the row exists" was being read as "the row
// was enriched". A fake would have to encode the very distinction under test, so
// it would pass either way. Four of the five defects in the withdrawn
// library-repointing work were likewise found by running against Postgres rather
// than by reading.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

func latchTestQueries(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping scanner enrichment-latch integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping test db: %v", err)
	}
	t.Cleanup(pool.Close)
	return db.NewQueries(pool), pool
}

func latchSuffix(t *testing.T) string {
	t.Helper()
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

// seedShowLibrary creates a type='show' library and reaps it (and everything
// cascading off it) at test end.
func seedShowLibrary(t *testing.T, pool *pgxpool.Pool) *models.Library {
	t.Helper()
	ctx := context.Background()
	suffix := latchSuffix(t)
	var ownerID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING id`,
		"latch_"+suffix, "latch_"+suffix+"@example.com", "$2a$10$placeholder").Scan(&ownerID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, ownerID) })

	lib := &models.Library{Type: models.LibraryShows, Name: "latch_lib_" + suffix}
	if err := pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1,'show',$2,$3) RETURNING id`,
		lib.Name, []string{"/tmp/latch_" + suffix}, ownerID).Scan(&lib.ID); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM libraries WHERE id=$1`, lib.ID) })
	return lib
}

// writeEpisodeFile lays down a real file (generateFileHash reads bytes) in the
// layout ParseTVPath expects, and returns its path.
func writeEpisodeFile(t *testing.T, root, show string, season, episode int) string {
	t.Helper()
	dir := filepath.Join(root, show, "Season 01")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	name := fmt.Sprintf("%s - S%02dE%02d.mkv", show, season, episode)
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("not-really-a-video-"+name), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	return p
}

func TestProcessFileRequeuesFullEnrichmentWhenExistingShowWasNeverEnriched(t *testing.T) {
	queries, pool := latchTestQueries(t)
	ctx := context.Background()
	lib := seedShowLibrary(t, pool)
	// FFprobePath is deliberately bogus: Probe's failure is tolerated (logged at
	// debug) and skipping it keeps this hermetic and fast.
	s := NewScanner(config.ScannerConfig{FFprobePath: "/nonexistent/ffprobe", Workers: 1}, queries)

	root := t.TempDir()
	showName := "Latch Show " + latchSuffix(t)

	probePath := writeEpisodeFile(t, root, showName, 1, 1)
	parsedTitle := ParseTVPath(probePath).Title
	if parsedTitle == "" {
		t.Fatalf("parser produced no title for %s", probePath)
	}

	// Case A — no row at all: the show is new, so a full enrichment is queued.
	isNew, pending, err := s.processFile(ctx, lib, probePath)
	if err != nil {
		t.Fatalf("processFile (new show): %v", err)
	}
	if !isNew || pending == nil {
		t.Fatalf("new show: isNew=%v pending=%v, want a queued enrichment", isNew, pending)
	}
	if pending.episodeBackfillOnly {
		t.Error("new show queued as episode-backfill-only, want full enrichment")
	}
	itemID := pending.item.ID

	// The row's title must be what the parser derived: that title is the key
	// FindMediaItemByTitle looks the canonical row up by, so if the two ever
	// diverge the latch silently stops finding anything and every file creates a
	// duplicate show.
	var storedTitle string
	if err := pool.QueryRow(ctx, `SELECT title FROM media_items WHERE id=$1`, itemID).Scan(&storedTitle); err != nil {
		t.Fatalf("read title: %v", err)
	}
	if storedTitle != parsedTitle {
		t.Errorf("stored title %q != parsed title %q — FindMediaItemByTitle keys on the parsed title", storedTitle, parsedTitle)
	}

	// The row now exists but nothing has enriched it — exactly the state a scan
	// interrupted before its deferred TV pass leaves behind. (The pass runs after
	// wg.Wait() and abandons its queue on ctx cancellation; scanContext() is the
	// server lifecycle context, and this box auto-deploys on a 5-minute timer.)
	var lastMetadata *time.Time
	if err := pool.QueryRow(ctx, `SELECT last_metadata FROM media_items WHERE id=$1`, itemID).Scan(&lastMetadata); err != nil {
		t.Fatalf("read last_metadata: %v", err)
	}
	if lastMetadata != nil {
		t.Fatalf("precondition: expected an un-enriched row, but last_metadata is %v", lastMetadata)
	}

	// Case B — the fix. A NEW file for that un-enriched show must re-queue the
	// FULL pass. Before this change the row's mere existence latched enrichment
	// off for ever: the show could only ever get episodeBackfillOnly, which
	// touches episode rows and never the show's own tmdb_id/genres/content_rating.
	secondFile := writeEpisodeFile(t, root, showName, 1, 2)
	isNew, pending, err = s.processFile(ctx, lib, secondFile)
	if err != nil {
		t.Fatalf("processFile (unenriched existing show): %v", err)
	}
	if !isNew || pending == nil {
		t.Fatalf("unenriched existing show: isNew=%v pending=%v, want a queued enrichment", isNew, pending)
	}
	if pending.item.ID != itemID {
		t.Errorf("adopted item %d, want the existing canonical row %d", pending.item.ID, itemID)
	}
	if pending.episodeBackfillOnly {
		t.Error("un-enriched existing show queued as episode-backfill-only — its genres/tmdb_id/content_rating would stay empty for ever (#510)")
	}

	// Case C — a provider was ASKED and had no entry (last_metadata_attempt set,
	// last_metadata still NULL). This must NOT re-queue a full pass: otherwise
	// every scan that brings a file re-pays a TMDB search plus a year-less retry,
	// a TVDB search where TVDB is enabled, an unconditional embed, and an LLM
	// re-match when the score lands in 50..84 and the detail fetch then fails —
	// for a show that will never match. Those are the refresh rotation's job.
	if err := queries.TouchMetadataAttempt(ctx, itemID); err != nil {
		t.Fatalf("mark attempted: %v", err)
	}
	thirdFile := writeEpisodeFile(t, root, showName, 1, 3)
	isNew, pending, err = s.processFile(ctx, lib, thirdFile)
	if err != nil {
		t.Fatalf("processFile (attempted-but-unmatched show): %v", err)
	}
	if !isNew || pending == nil {
		t.Fatalf("attempted show: isNew=%v pending=%v, want a queued backfill", isNew, pending)
	}
	if !pending.episodeBackfillOnly {
		t.Error("a show already attempted and unmatched queued another full enrichment — it would re-pay a search, an embed and possibly an LLM call on every scan that adds a file")
	}

	// Case D — the behaviour that must NOT regress. Once the row really has been
	// enriched, a new file is an episode-level backfill and must not pay for a
	// redundant full show match.
	if err := queries.TouchLastMetadata(ctx, itemID); err != nil {
		t.Fatalf("mark enriched: %v", err)
	}
	fourthFile := writeEpisodeFile(t, root, showName, 1, 4)
	isNew, pending, err = s.processFile(ctx, lib, fourthFile)
	if err != nil {
		t.Fatalf("processFile (enriched existing show): %v", err)
	}
	if !isNew || pending == nil {
		t.Fatalf("enriched existing show: isNew=%v pending=%v, want a queued backfill", isNew, pending)
	}
	if !pending.episodeBackfillOnly {
		t.Error("enriched existing show queued a full enrichment — every rescan would re-run the show match")
	}

	// And an unchanged file stays silent on every path.
	isNew, pending, err = s.processFile(ctx, lib, fourthFile)
	if err != nil {
		t.Fatalf("processFile (unchanged file): %v", err)
	}
	if isNew || pending != nil {
		t.Errorf("unchanged file: isNew=%v pending=%v, want no work queued", isNew, pending)
	}
}
