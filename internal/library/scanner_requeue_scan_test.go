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
	"sync"
	"sync/atomic"
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

// TestScanLibraryRunsTheRecoverySweepAfterTheEpisodeBackfills pins the ORDER of
// the deferred pass, which is the part of it that is not obvious.
//
// Fulls before backfills is old and deliberate: a full covers the backfill's
// work and marks the show in the per-scan dedup map. The sweep is the new third
// phase and it goes last, because it is the only one not derived from this
// scan's own files. Queued ahead of the backfills — which is where it started —
// a cancellation partway through it took every backfill down with it, and a
// backfill is only ever signalled in the scan that FIRST sees the file. Nor is
// the refresh rotation a net for that: its smart diffing skips a show outright
// when it has a tmdb_id and TMDB reports no upstream change, and a locally added
// episode file is not an upstream change. So a dropped backfill can be
// permanent, not delayed.
//
// A review moved the loop back to the front and the whole suite stayed green,
// which by this file's own standard is the thing that needs a scan rather than
// an argument.
func TestScanLibraryRunsTheRecoverySweepAfterTheEpisodeBackfills(t *testing.T) {
	queries, pool := latchTestQueries(t)
	ctx := context.Background()
	root := t.TempDir()
	lib := seedShowLibraryAt(t, pool, root)
	sfx := latchSuffix(t)
	stuckName := "Stuck Show " + sfx
	growingName := "Growing Show " + sfx
	stuckFile := writeEpisodeFile(t, root, stuckName, 1, 1)
	growingFile := writeEpisodeFile(t, root, growingName, 1, 1)
	// Assert against the PARSED titles, never the names as written. latchSuffix is
	// 16 hex characters and parser.go's year regex has no word boundary, so a
	// suffix containing 19dd or 20dd anywhere past the first position is read as a
	// year and truncates the title there — "Growing Show 274a920755e36afe" parses
	// as "Growing Show 274a9", year 2075. A review measured the resulting flake at
	// ~3.6% of runs, and its message reads like an ordering failure, which is the
	// worst kind of red. The file already has the right idiom in idFor below.
	stuckTitle := ParseTVPath(stuckFile).Title
	growingTitle := ParseTVPath(growingFile).Title
	if stuckTitle == "" || growingTitle == "" || stuckTitle == growingTitle {
		t.Fatalf("parser produced unusable titles: stuck=%q growing=%q", stuckTitle, growingTitle)
	}

	s := NewScanner(config.ScannerConfig{FFprobePath: "/nonexistent/ffprobe", Workers: 1}, queries)
	s.requeueSweepEvery = 0

	// One log, both hooks, so the ORDER between them is what is recorded.
	type call struct {
		kind  string
		title string
	}
	var calls []call
	s.OnNewItem = func(_ context.Context, item *models.MediaItem) {
		calls = append(calls, call{"full", item.Title})
	}
	s.OnEpisodeBackfill = func(_ context.Context, item *models.MediaItem, _ []int) {
		calls = append(calls, call{"backfill", item.Title})
	}

	if err := s.ScanLibrary(ctx, lib, nil); err != nil {
		t.Fatalf("scan 1: %v", err)
	}
	if len(calls) != 2 {
		t.Fatalf("scan 1 produced %d calls (%v), want one full per show", len(calls), calls)
	}

	// The growing show has been asked and answered; the stuck one never was.
	// That is what puts one on the backfill path and the other in the sweep.
	idFor := func(title string) int64 {
		t.Helper()
		found, err := queries.FindMediaItemByTitle(ctx, lib.ID, "show", title)
		if err != nil || found == nil {
			t.Fatalf("look up %q: %v (found=%v)", title, err, found)
		}
		return found.ID
	}
	growingID := idFor(growingTitle)
	if err := queries.TouchMetadataAttempt(ctx, growingID); err != nil {
		t.Fatalf("stamp attempt: %v", err)
	}
	if idFor(stuckTitle) == growingID {
		t.Fatal("both files resolved to the same show row")
	}

	// A new episode file for the attempted show: that is a backfill signal, and
	// the only scan in which it is ever raised.
	writeEpisodeFile(t, root, growingName, 1, 2)

	calls = nil
	if err := s.ScanLibrary(ctx, lib, nil); err != nil {
		t.Fatalf("scan 2: %v", err)
	}
	if len(calls) != 2 {
		t.Fatalf("scan 2 produced %d calls (%v), want a backfill for the growing show and a swept full for the stuck one", len(calls), calls)
	}
	if calls[0].kind != "backfill" {
		t.Errorf("scan 2 ran %q first (%v); the episode backfill must precede the recovery sweep, or a cancellation partway through the sweep drops a signal that is never raised again", calls[0].kind, calls)
	}
	if calls[1].kind != "full" {
		t.Errorf("scan 2 ran %q second (%v), want the swept full last", calls[1].kind, calls)
	}
	if calls[0].title != growingTitle {
		t.Errorf("the backfill was for %q, want %q", calls[0].title, growingTitle)
	}
	if calls[1].title != stuckTitle {
		t.Errorf("the swept full was for %q, want %q", calls[1].title, stuckTitle)
	}
}

// TestRequeueSweepConstantsAreBounded needs no database, deliberately: it is a
// check on two constants, and living inside a TEST_DATABASE_URL-gated test left
// them unguarded on exactly the runs that have no Postgres.
//
// GetUnattemptedShowsForLibrary refuses a non-positive limit, so "no limit"
// cannot be expressed by passing 0 — but nothing otherwise stops the constant
// being raised until it stops bounding anything, and what it bounds is provider
// calls per sweep. A review raised it to a million and the whole suite stayed
// green.
func TestRequeueSweepConstantsAreBounded(t *testing.T) {
	if requeueUnattemptedLimit <= 0 || requeueUnattemptedLimit > 500 {
		t.Errorf("requeueUnattemptedLimit is %d; the sweep's cost argument rests on it staying in the same order as GetStaleMetadataItems' window (100). Raising it past a few hundred means revisiting the reasoning in its doc comment, not just the number.", requeueUnattemptedLimit)
	}
	if requeueSweepInterval <= 0 {
		t.Errorf("requeueSweepInterval is %v; a non-positive interval disables the rate limit entirely (see dueForRequeueSweep), so the sweep would run on every scan again", requeueSweepInterval)
	}
}

// TestDueForRequeueSweepClaimIsExclusive pins the mutex deterministically, on one
// CPU as well as sixteen, and needs no database.
//
// dueForRequeueSweep is a check-then-set over a sync.Map, which has no
// compare-and-swap for this shape, so without the lock two concurrent scans of one
// library both read a stale timestamp and both sweep — spending the provider calls
// the rate limit exists to bound.
//
// The obvious test for that is the stress test below, and it is not enough: with
// the mutex deleted, the 16-goroutine version passed EVERY run at GOMAXPROCS=1,
// with and without -race, and still passed a substantial fraction on four cores.
// (Rates vary by machine — two reviewers measured different figures above one
// CPU. The part that does not vary is the single-CPU result.) So this test holds
// the two callers inside the claim window instead, through the scanner's
// testHookInRequeueClaim. With the lock the second caller cannot enter while the
// first is there; without it, it walks straight in. Neither outcome depends on
// the scheduler.
func TestDueForRequeueSweepClaimIsExclusive(t *testing.T) {
	s := NewScanner(config.ScannerConfig{}, nil)

	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	s.testHookInRequeueClaim = func() {
		entered <- struct{}{}
		<-release
	}

	var claimed atomic.Int64
	var done sync.WaitGroup
	done.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer done.Done()
			if s.dueForRequeueSweep(1) {
				claimed.Add(1)
			}
		}()
	}

	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		close(release)
		done.Wait()
		t.Fatal("no caller reached the claim window")
	}
	// A second caller arriving while the first is still inside is the defect
	// itself: both have read the same stale timestamp and both will write.
	overlapped := false
	select {
	case <-entered:
		overlapped = true
	case <-time.After(250 * time.Millisecond):
	}
	close(release)
	done.Wait()

	if overlapped {
		t.Error("two callers were inside the claim window at once; the check and the claim must be one critical section, or one library is swept once per concurrent scan rather than once per interval")
	}
	if got := claimed.Load(); got != 1 {
		t.Errorf("%d of 2 callers claimed the sweep slot, want 1", got)
	}
}

// TestDueForRequeueSweepClaimsTheSlotOnce is the stress companion to the test
// above. It is deliberately kept even though it is PROBABILISTIC — it explores
// interleavings the deterministic seam does not reach — but do not read a pass
// here as evidence the lock is present: it survives its own mutation ENTIRELY on
// a single-CPU runner, and a machine-dependent fraction of runs above one.
func TestDueForRequeueSweepClaimsTheSlotOnce(t *testing.T) {
	s := NewScanner(config.ScannerConfig{}, nil)
	const goroutines = 16
	for round := 0; round < 200; round++ {
		s.requeueSweptAt.Delete(int64(1))
		var claimed atomic.Int64
		var start, done sync.WaitGroup
		start.Add(1)
		done.Add(goroutines)
		for i := 0; i < goroutines; i++ {
			go func() {
				defer done.Done()
				start.Wait()
				if s.dueForRequeueSweep(1) {
					claimed.Add(1)
				}
			}()
		}
		start.Done()
		done.Wait()
		if got := claimed.Load(); got != 1 {
			t.Fatalf("round %d: %d goroutines claimed the sweep slot, want 1 — the check-and-claim must be atomic, or one library is swept once per concurrent scan rather than once per interval", round, got)
		}
	}
}

// TestReleaseScanSlotFreesAnUnusedClaimButNeverCancelsWork pins the slot
// release the library-retype action depends on.
//
// Retype claims the scan slot before it touches anything, because a scan running
// through the purge would be writing rows into the library as they are deleted
// and would then keep walking it under the old parser. But the retype can be
// REFUSED after that claim — a stale count, a rolled-back transaction — and
// without a release the library reads as ScanRunning for the life of the
// process: no scan would ever start, and the #510 health report would treat it
// as busy and stay silent about it. A guard that jams the thing it guards.
func TestReleaseScanSlotFreesAnUnusedClaimButNeverCancelsWork(t *testing.T) {
	s := NewScanner(config.ScannerConfig{}, nil)

	if !s.TryStartScan(1) {
		t.Fatal("first claim refused")
	}
	if s.TryStartScan(1) {
		t.Fatal("the slot was claimable twice; it is not exclusive")
	}
	s.ReleaseScanSlot(1)
	if !s.TryStartScan(1) {
		t.Error("the slot was not released, so this library can never be scanned again in this process")
	}

	// Idempotent, and harmless on a library that was never claimed.
	s.ReleaseScanSlot(1)
	s.ReleaseScanSlot(999)
	if !s.TryStartScan(999) {
		t.Error("releasing an unclaimed library broke its slot")
	}

	// It releases an UNUSED claim; it does not cancel a scan that has started
	// doing work. Otherwise a retype refused after a concurrent scan began would
	// quietly hand that scan's slot away and let a second scan start beside it.
	s.ReleaseScanSlot(2)
	if !s.TryStartScan(2) {
		t.Fatal("claim refused")
	}
	s.mu.Lock()
	s.progress[2].TotalFiles = 120
	s.progress[2].ScannedFiles = 7
	s.mu.Unlock()
	s.ReleaseScanSlot(2)
	if s.TryStartScan(2) {
		t.Error("a scan that had already started walking files had its slot released; two scans of one library could then run at once")
	}
}

// TestWatchLibraryKeepsPeriodicScanningWhenFileWatchingFails pins the
// degradation path, because the alternative it replaced was worse than the
// documentation said.
//
// w.watching is not just the fsnotify registry — periodicScanLoop iterates it to
// decide which libraries get the periodic tick. So returning early when
// fsnotify.NewWatcher() fails dropped the library out of AUTOMATIC SCANNING
// ENTIRELY, not just out of file events. For the retype that made the choice
// "keep a stale snapshot that rescans under the wrong type" versus "never scan
// this library again", and a review measured the second half: after an unwatch,
// a 60ms periodic tick fired nothing for a second.
//
// installWatch is therefore what both paths go through, and this asserts a
// library registered without an fsnotify watcher is still visible to the tick.
func TestWatchLibraryKeepsPeriodicScanningWhenFileWatchingFails(t *testing.T) {
	w := NewWatcher(config.ScannerConfig{}, nil, func(*models.Library) {})
	t.Cleanup(w.StopAll)

	lib := &models.Library{ID: 77, Name: "degraded", Type: models.LibraryShows, Paths: []string{t.TempDir()}}
	w.installWatch(context.Background(), lib, nil)

	got := w.WatchedLibrary(77)
	if got == nil {
		t.Fatal("a library registered without file watching is invisible to the watcher, so periodicScanLoop will never scan it again")
	}
	if got.Type != models.LibraryShows {
		t.Errorf("registered value carries type %q, want %q", got.Type, models.LibraryShows)
	}

	// And the copy is a copy: Paths is a slice, so a shallow one would alias the
	// snapshot periodicScanLoop hands ScanLibrary.
	got.Paths[0] = "/mutated"
	if again := w.WatchedLibrary(77); again.Paths[0] == "/mutated" {
		t.Error("WatchedLibrary returned a shallow copy; a caller writing Paths[i] corrupts what the watcher scans")
	}
}
