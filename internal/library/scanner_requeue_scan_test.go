package library

// The #510 recovery claim, end to end through ScanLibrary.
//
// Every other test in this package exercises processFile or a pure helper. That
// left the one piece of code the whole fix rests on — the once-per-scan re-queue
// after wg.Wait() — covered by reading alone, and a review proved it: deleting the
// entire block failed no test in internal/db, internal/library or
// internal/metadata. The block exists because the per-file latch is structurally
// UNREACHABLE in the state it was written for (processFile returns early on an
// unchanged hash, and the #510 state is "every file was recorded, then the
// deferred pass was cancelled"), and three review rounds went by with three
// separate comments claiming otherwise. A claim that specific needs a scan, not a
// unit test.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
)

// seedShowLibraryAt is seedShowLibrary with the library's paths pointed at a real
// directory, so ScanLibrary walks something.
func seedShowLibraryAt(t *testing.T, pool *pgxpool.Pool, root string) *models.Library {
	t.Helper()
	lib := seedShowLibrary(t, pool)
	if _, err := pool.Exec(context.Background(),
		`UPDATE libraries SET paths = $1 WHERE id = $2`, []string{root}, lib.ID); err != nil {
		t.Fatalf("point library at %s: %v", root, err)
	}
	lib.Paths = []string{root}
	return lib
}

func TestScanLibraryRequeuesAShowWhoseEnrichmentNeverRan(t *testing.T) {
	queries, pool := latchTestQueries(t)
	ctx := context.Background()
	root := t.TempDir()
	lib := seedShowLibraryAt(t, pool, root)
	showName := "Scan Requeue " + latchSuffix(t)
	writeEpisodeFile(t, root, showName, 1, 1)
	writeEpisodeFile(t, root, showName, 1, 2)

	s := NewScanner(config.ScannerConfig{FFprobePath: "/nonexistent/ffprobe", Workers: 1}, queries)
	// The rate limit is a separate property with its own test below; disabling it
	// here keeps this test about whether the sweep happens at all.
	s.requeueSweepEvery = 0

	var fullEnrichments []int64
	var backfills []int64
	s.OnNewItem = func(_ context.Context, item *models.MediaItem) {
		fullEnrichments = append(fullEnrichments, item.ID)
	}
	s.OnEpisodeBackfill = func(_ context.Context, item *models.MediaItem, _ []int) {
		backfills = append(backfills, item.ID)
	}

	// Scan 1 — the show is discovered and a full enrichment is asked for. The hook
	// stores nothing, which is what a cancelled deferred pass leaves behind.
	if err := s.ScanLibrary(ctx, lib, nil); err != nil {
		t.Fatalf("scan 1: %v", err)
	}
	if len(fullEnrichments) != 1 {
		t.Fatalf("scan 1 asked for %d full enrichments (%v), want exactly 1 — one per SHOW, not per file", len(fullEnrichments), fullEnrichments)
	}
	itemID := fullEnrichments[0]

	var progress *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT GREATEST(last_metadata, last_metadata_attempt) FROM media_items WHERE id = $1`,
		itemID).Scan(&progress); err != nil {
		t.Fatalf("read progress: %v", err)
	}
	if progress != nil {
		t.Fatalf("precondition: the row has metadata progress (%v); this test needs the never-attempted state", progress)
	}

	// Scan 2 — NOTHING on disk changed. Every file's hash is unchanged, so
	// processFile returns before it ever consults FindMediaItemByTitle and the
	// per-file latch is not evaluated. Only the once-per-scan sweep can recover
	// this, and without it the show stays un-enriched for ever.
	fullEnrichments = nil
	backfills = nil
	if err := s.ScanLibrary(ctx, lib, nil); err != nil {
		t.Fatalf("scan 2: %v", err)
	}
	if len(fullEnrichments) != 1 || fullEnrichments[0] != itemID {
		t.Errorf("scan 2 asked for full enrichments %v, want exactly [%d]: with no file changed, the per-file latch is never reached, so a show whose enrichment never ran is permanently stuck (#510)", fullEnrichments, itemID)
	}
	if len(backfills) != 0 {
		t.Errorf("scan 2 asked for episode backfills %v; a show that was never matched needs the FULL pass — a backfill touches episode rows and never the show's own tmdb_id, genres or content_rating", backfills)
	}

	// Scan 3 — the provider has now been asked and answered (no entry). That is
	// the refresh rotation's business, not the scanner's: re-queueing it would
	// re-pay a TMDB search, a year-less retry, a TVDB search where TVDB is
	// enabled, and an unconditional embed on every scan, for ever.
	if err := queries.TouchMetadataAttempt(ctx, itemID); err != nil {
		t.Fatalf("stamp attempt: %v", err)
	}
	fullEnrichments = nil
	backfills = nil
	if err := s.ScanLibrary(ctx, lib, nil); err != nil {
		t.Fatalf("scan 3: %v", err)
	}
	if len(fullEnrichments) != 0 {
		t.Errorf("scan 3 asked for full enrichments %v after the attempt was stamped; the sweep must select on metadata PROGRESS, not on whether the row matched", fullEnrichments)
	}
}

// The sweep's cost is bounded two ways and both are load-bearing, because the
// selection is "no metadata progress" while the attempt stamp is gated on the
// provider having ANSWERED — so a show whose enrichment reliably ERRORS is
// eligible for ever. This pins the rate limit; the query's LIMIT is pinned by
// TestGetUnattemptedShowsForLibrary.
func TestScanLibrarySweepIsRateLimited(t *testing.T) {
	queries, pool := latchTestQueries(t)
	ctx := context.Background()
	root := t.TempDir()
	lib := seedShowLibraryAt(t, pool, root)
	writeEpisodeFile(t, root, "Rate Limited "+latchSuffix(t), 1, 1)
	_ = pool

	s := NewScanner(config.ScannerConfig{FFprobePath: "/nonexistent/ffprobe", Workers: 1}, queries)
	if s.requeueSweepEvery != requeueSweepInterval {
		t.Fatalf("NewScanner left requeueSweepEvery at %v, want %v — an unset interval disables the rate limit", s.requeueSweepEvery, requeueSweepInterval)
	}
	// The other bound. GetUnattemptedShowsForLibrary refuses a non-positive
	// limit, so "no limit" cannot be expressed by passing 0 — but nothing
	// otherwise stops the constant being raised until it stops bounding anything,
	// and the cost it bounds is provider calls per sweep. A review raised it to a
	// million and the whole suite stayed green.
	if requeueUnattemptedLimit <= 0 || requeueUnattemptedLimit > 500 {
		t.Errorf("requeueUnattemptedLimit is %d; the sweep's whole cost argument rests on it staying in the same order as GetStaleMetadataItems' window (100). Raising it past a few hundred needs the reasoning in its doc comment revisited, not just the number changed.", requeueUnattemptedLimit)
	}

	var calls []int64
	s.OnNewItem = func(_ context.Context, item *models.MediaItem) {
		calls = append(calls, item.ID)
	}

	if err := s.ScanLibrary(ctx, lib, nil); err != nil {
		t.Fatalf("scan 1: %v", err)
	}
	if len(calls) != 1 {
		t.Fatalf("scan 1 asked for %d full enrichments, want 1", len(calls))
	}

	// Still never attempted, still eligible — but the sweep already ran for this
	// library. The watcher fires on fsnotify with a 30-second dedup window, so
	// without this an *arr-fed library re-searched and re-embedded every eligible
	// show every ~30 seconds.
	calls = nil
	if err := s.ScanLibrary(ctx, lib, nil); err != nil {
		t.Fatalf("scan 2: %v", err)
	}
	if len(calls) != 0 {
		t.Errorf("a second scan within requeueSweepInterval swept again (%v); the sweep is a recovery pass, not a per-scan duty", calls)
	}

	// The limit is PER LIBRARY. Keyed globally instead, one library's scan would
	// suppress every other library's sweep for a whole interval — a recovery
	// regression on any multi-library install, and one a single-library test
	// cannot see. Note the shape: a SECOND library's first scan queues its full
	// from processFile, not from the sweep, so merely counting calls there proves
	// nothing. The distinguishing move is to make the second library — and only
	// the second — due again, then scan it with nothing changed on disk.
	otherRoot := t.TempDir()
	otherLib := seedShowLibraryAt(t, pool, otherRoot)
	writeEpisodeFile(t, otherRoot, "Second Library "+latchSuffix(t), 1, 1)
	calls = nil
	if err := s.ScanLibrary(ctx, otherLib, nil); err != nil {
		t.Fatalf("scan of a second library: %v", err)
	}
	if len(calls) != 1 {
		t.Fatalf("a second library's first scan asked for %d full enrichments, want 1", len(calls))
	}
	s.requeueSweptAt.Store(otherLib.ID, time.Now().Add(-2*requeueSweepInterval))
	calls = nil
	if err := s.ScanLibrary(ctx, otherLib, nil); err != nil {
		t.Fatalf("second scan of the second library: %v", err)
	}
	if len(calls) != 1 {
		t.Errorf("the second library was due but swept %d shows, want 1 — the rate limit must be keyed per library, or one library's scan suppresses every other library's recovery", len(calls))
	}

	// And the limit is a real interval, not a once-per-process latch: a library
	// last swept longer ago than the interval is due again.
	s.requeueSweptAt.Store(lib.ID, time.Now().Add(-2*requeueSweepInterval))
	calls = nil
	if err := s.ScanLibrary(ctx, lib, nil); err != nil {
		t.Fatalf("scan 3: %v", err)
	}
	if len(calls) != 1 {
		t.Errorf("a scan after the interval elapsed asked for %d full enrichments, want 1 — the sweep must come back round, or a show stuck after the first scan of a long-lived process is never recovered by the scanner", len(calls))
	}

}
