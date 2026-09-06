package library

// The relocation guards.
//
// ScanLibrary prunes deleted files and sweeps media items left with no files.
// Run before phase 2 attaches what the walk found, on a library whose media
// just moved, that deletes every media item moments before the same titles are
// recreated under new ids — cascading away the watch progress, ratings, item
// feedback, taste seeds and embeddings that repointing exists to preserve.
//
// Two guards prevent it, and the split matters:
//
//   - allPathsOutsideRoots is derived from the DATA and re-derived every scan.
//     It is the one that holds when nobody told us anything: a psql edit of
//     libraries.paths, a restored database, or a marker lost to the restart
//     that deploys.
//   - the repoint marker is set by the API handler and covers the partial move
//     (one root of several changed) that the data check cannot see.
//
// Either one defers the prune to after phase 2 rather than skipping it, so the
// stale rows still go — in the same scan, before anyone tries to play a title
// whose only recorded path is dead.

import (
	"context"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

func repointScanner() *Scanner {
	return &Scanner{progress: make(map[int64]*models.ScanProgress)}
}

func libAt(id int64, paths ...string) *models.Library {
	return &models.Library{ID: id, Name: "Movies", Type: models.LibraryMovies, Paths: paths}
}

// ── The data-derived guard ────────────────────────────────────────

func TestAllPathsOutsideRootsDetectsAWholeLibraryMove(t *testing.T) {
	// Every row still describes /home; the library now points at /srv.
	rows := map[string]int64{
		"/home/u/media/movies/A (2001)/A (2001).mkv": 1,
		"/home/u/media/movies/B (2002)/B (2002).mkv": 2,
	}
	if !allPathsOutsideRoots(rows, []string{"/srv/storage/media/movies"}) {
		t.Fatal("a library whose every row is outside its roots must read as relocated")
	}
}

func TestAllPathsOutsideRootsIgnoresAnOrdinaryDeletion(t *testing.T) {
	// The normal case the prune exists for: files under the root, some gone
	// from disk. Reporting a relocation here would disable the prune for good.
	rows := map[string]int64{
		"/srv/storage/media/movies/A (2001)/A (2001).mkv": 1,
		"/srv/storage/media/movies/B (2002)/B (2002).mkv": 2,
	}
	if allPathsOutsideRoots(rows, []string{"/srv/storage/media/movies"}) {
		t.Fatal("rows under the library's own root must not read as relocated")
	}
}

// ONE row still under a root is enough to show the roots are where this
// library's files live. Deliberately all-or-nothing: a partial overlap is a
// deletion story, and the marker covers the partial-move story instead.
func TestAllPathsOutsideRootsRequiresEveryRowToBeOutside(t *testing.T) {
	rows := map[string]int64{
		"/home/u/media/movies/A (2001)/A (2001).mkv":      1,
		"/srv/storage/media/movies/B (2002)/B (2002).mkv": 2,
	}
	if allPathsOutsideRoots(rows, []string{"/srv/storage/media/movies"}) {
		t.Fatal("one row under a root means the roots are live — must not read as relocated")
	}
}

func TestAllPathsOutsideRootsHandlesMultipleRoots(t *testing.T) {
	rows := map[string]int64{"/mnt/b/x.mkv": 1}
	if allPathsOutsideRoots(rows, []string{"/mnt/a", "/mnt/b"}) {
		t.Fatal("a row under the SECOND root must not read as relocated")
	}
	if !allPathsOutsideRoots(rows, []string{"/mnt/a", "/mnt/c"}) {
		t.Fatal("a row under neither root must read as relocated")
	}
}

// Prefix comparison is on path boundaries — otherwise "/media/Show 2" reads as
// living under "/media/Show" and a real move goes undetected.
func TestAllPathsOutsideRootsComparesOnPathBoundaries(t *testing.T) {
	rows := map[string]int64{"/srv/media-old/movies/A.mkv": 1}
	if !allPathsOutsideRoots(rows, []string{"/srv/media"}) {
		t.Fatal("/srv/media-old must not count as living under /srv/media")
	}
}

// Nothing recorded means nothing to prune and nothing to infer. Returning true
// here would make an empty library defer its prune forever.
func TestAllPathsOutsideRootsIsFalseWhenThereIsNothingToJudge(t *testing.T) {
	if allPathsOutsideRoots(map[string]int64{}, []string{"/srv/media"}) {
		t.Error("no rows must not read as relocated")
	}
	if allPathsOutsideRoots(map[string]int64{"/a/x.mkv": 1}, nil) {
		t.Error("no roots must not read as relocated")
	}
}

// ── The handler's marker ──────────────────────────────────────────

func TestIsRepointedIsFalseWithoutAMarker(t *testing.T) {
	s := repointScanner()
	if s.isRepointed(libAt(1, "/srv/media/movies")) {
		t.Fatal("a library nobody repointed must prune normally")
	}
}

// The marker must SURVIVE the scan that reads it. Consuming it at the top of
// the scan spends it before the deferred prune has run, so a walk that finds
// nothing, a cancelled scan, or an error in phase 2 would all burn it and hand
// the next scan an unguarded shot at the catalog.
func TestIsRepointedSurvivesUntilExplicitlyCleared(t *testing.T) {
	s := repointScanner()
	lib := libAt(1, "/srv/storage/media/movies")
	s.NoteRepointed(lib.ID, lib.Paths)

	for i := 0; i < 3; i++ {
		if !s.isRepointed(lib) {
			t.Fatalf("marker gone after %d peek(s) — it must not be consumed by reading", i)
		}
	}
	s.clearRepoint(lib.ID)
	if s.isRepointed(lib) {
		t.Fatal("marker must be gone once the deferred prune has run")
	}
}

// The race the paths key exists for: a periodic scan can start between the
// admin's save and the handler's own rescan, and it is still on the OLD paths.
func TestIsRepointedIgnoresAScanStillOnTheOldPaths(t *testing.T) {
	s := repointScanner()
	const id = 1
	old := libAt(id, "/home/u/media/movies")
	moved := libAt(id, "/srv/storage/media/movies")

	s.NoteRepointed(id, moved.Paths)

	if s.isRepointed(old) {
		t.Fatal("a scan on the old paths must not match the marker")
	}
	if !s.isRepointed(moved) {
		t.Fatal("the marker must still be there for the scan that actually moved")
	}
}

func TestIsRepointedIsPerLibrary(t *testing.T) {
	s := repointScanner()
	s.NoteRepointed(7, []string{"/srv/storage/media/movies"})

	if s.isRepointed(libAt(8, "/srv/storage/media/movies")) {
		t.Fatal("a different library must not match another's marker, same paths or not")
	}
	if !s.isRepointed(libAt(7, "/srv/storage/media/movies")) {
		t.Fatal("library 7's own marker must survive library 8's scan")
	}
}

func TestIsRepointedRequiresEveryPathToMatch(t *testing.T) {
	s := repointScanner()
	const id = 3
	s.NoteRepointed(id, []string{"/srv/a", "/srv/b"})

	if s.isRepointed(libAt(id, "/srv/a")) {
		t.Fatal("a subset of the recorded paths must not match")
	}
	if s.isRepointed(libAt(id, "/srv/a", "/srv/c")) {
		t.Fatal("a differing path must not match")
	}
	if !s.isRepointed(libAt(id, "/srv/a", "/srv/b")) {
		t.Fatal("the exact recorded paths must match")
	}
}

// NoteRepointed must copy: the handler passes the same slice it hands to the
// UPDATE and then to the rescan goroutine.
func TestNoteRepointedCopiesThePaths(t *testing.T) {
	s := repointScanner()
	paths := []string{"/srv/storage/media/movies"}
	s.NoteRepointed(1, paths)
	paths[0] = "/somewhere/else"

	if !s.isRepointed(libAt(1, "/srv/storage/media/movies")) {
		t.Fatal("the marker must hold its own copy of the paths")
	}
}

func TestForgetRepointClearsAPendingMarker(t *testing.T) {
	s := repointScanner()
	s.NoteRepointed(1, []string{"/srv/storage/media/movies"})
	s.ForgetRepoint(1)

	if s.isRepointed(libAt(1, "/srv/storage/media/movies")) {
		t.Fatal("a forgotten marker must not match")
	}
	// Forgetting one nobody set, or one already cleared, is a no-op rather
	// than a panic — Delete calls it unconditionally.
	s.ForgetRepoint(99)
	s.clearRepoint(99)
}

// The marker is read and cleared from the scan goroutine while the API
// handler writes it. CI runs `go test` WITHOUT -race, so what this relies on
// there is Go's built-in concurrent-map-access detector, which fires on an
// unguarded map either way; run it with -race locally for the stronger check.
func TestRepointMarkerIsConcurrencySafe(t *testing.T) {
	s := repointScanner()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 500; i++ {
			s.NoteRepointed(int64(i%8), []string{"/srv/media"})
		}
	}()
	for i := 0; i < 500; i++ {
		lib := libAt(int64(i%8), "/srv/media")
		_ = s.isRepointed(lib)
		s.clearRepoint(lib.ID)
	}
	<-done
}

// ── The decision ScanLibrary makes ────────────────────────────────

// planPrune is the real branch ScanLibrary runs, not a mirror of it — a
// mirror drifts silently, and this decision is the single thing standing
// between a relocation and the empty-item sweep. ScanLibrary itself needs a
// live Postgres and a real directory tree to exercise, which is why the
// decision was extracted rather than tested through it.
func TestPlanPruneTable(t *testing.T) {
	cases := []struct {
		name            string
		walkFailed      bool
		markedRepointed bool
		want            prunePlan
	}{
		{"ordinary scan", false, false, prunePlanNow},
		// An unwalkable root says nothing about any row under it; this
		// predates the relocation work (deep-debug H9) and outranks it.
		{"walk failed", true, false, prunePlanSkip},
		{"walk failed outranks the marker", true, true, prunePlanSkip},
		// The handler told us. Covers the partial move the data check
		// cannot see.
		{"marked by the handler", false, true, prunePlanDeferred},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := planPrune(tc.walkFailed, tc.markedRepointed)
			if got != tc.want {
				t.Errorf("planPrune(walkFailed=%v, marked=%v) = %v, want %v",
					tc.walkFailed, tc.markedRepointed, got, tc.want)
			}
		})
	}
}

// A relocation must DEFER, never SKIP. Skipping leaves every title in the
// library holding a dead path that sorts first in GetMediaFiles (lower id,
// same version_tag), so nothing plays until the next scan — and an operator
// seeing that reasonably deletes and recreates the library, which is the
// data-loss path all of this exists to prevent.
func TestMarkedRelocationDefersRatherThanSkipping(t *testing.T) {
	if got := planPrune(false, true); got != prunePlanDeferred {
		t.Fatalf("a marked relocation must defer, got %v", got)
	}
}

// The data-derived half of the decision lives inside pruneDeletedFiles (it
// needs the recorded paths, which only that function fetches), so what pins
// it is allPathsOutsideRoots above plus TestZeroDiscoveredStillBails below.
// Its effect on a populated library — that (0, true, nil) makes the caller
// defer instead of sweeping — is NOT covered here: it needs a live Postgres.
// Stated rather than faked with a tautology.

// The zero-discovered guard (deep-debug H9) is separate from, and not
// weakened by, the relocation guards: it still returns before touching the DB,
// and it does not claim a relocation.
func TestZeroDiscoveredStillBailsBeforeTouchingTheDatabase(t *testing.T) {
	s := &Scanner{} // nil queries: the guard must return before they are used
	lib := libAt(1, "/srv/storage/media/movies")

	pruned, relocated, err := s.pruneDeletedFiles(context.Background(), lib, nil, nil, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pruned != 0 {
		t.Fatalf("want 0 pruned, got %d", pruned)
	}
	if relocated {
		t.Fatal("an empty walk is not a relocation")
	}
}

// ── The deferred prune's fully-attached precondition ──────────────

// unattachedCount is what makes the DEFERRAL safe. Deferring without it is
// strictly more destructive than the skip it replaced: media_files.path is
// globally UNIQUE and GetMediaFileByPath is not library-scoped, so when a
// DUPLICATE library already owns the new paths, phase 2 attaches nothing for
// the files it owns — and a single file the duplicate happens not to own is
// enough to make allPathsOutsideRoots false, at which point the prune would
// delete every old row in the repointed library and the sweep would cascade
// its whole history.
func TestUnattachedCountSeesFilesPhase2DidNotAttach(t *testing.T) {
	discovered := map[string]struct{}{
		"/srv/media/movies/A.mkv": {},
		"/srv/media/movies/B.mkv": {},
		"/srv/media/movies/C.mkv": {},
	}
	// A duplicate library owns A and B, so only C landed in this library —
	// alongside the old-location rows that are still all A and B have.
	rows := map[string]int64{
		"/srv/media/movies/C.mkv":    3,
		"/home/u/media/movies/A.mkv": 1,
		"/home/u/media/movies/B.mkv": 2,
	}
	if got := unattachedCount(discovered, rows); got != 2 {
		t.Fatalf("want 2 unattached, got %d — a nonzero count is what refuses the prune", got)
	}
}

func TestUnattachedCountIsZeroWhenPhase2AttachedEverything(t *testing.T) {
	discovered := map[string]struct{}{
		"/srv/media/movies/A.mkv": {},
		"/srv/media/movies/B.mkv": {},
	}
	// The healthy relocation: both new rows exist beside the two old ones,
	// which is exactly what the deferred prune is there to delete.
	rows := map[string]int64{
		"/srv/media/movies/A.mkv":    3,
		"/srv/media/movies/B.mkv":    4,
		"/home/u/media/movies/A.mkv": 1,
		"/home/u/media/movies/B.mkv": 2,
	}
	if got := unattachedCount(discovered, rows); got != 0 {
		t.Fatalf("want 0 unattached on a complete phase 2, got %d — a false positive blocks the prune forever", got)
	}
}

// One unattached file refuses the WHOLE prune, not just that file's row.
// Pruning "just the attached ones" needs the unattached titles to be exactly
// the ones left alone, which is the bookkeeping the check exists to avoid
// having to trust.
func TestUnattachedCountRefusesOnASingleGap(t *testing.T) {
	discovered := map[string]struct{}{}
	rows := map[string]int64{}
	for _, n := range []string{"A", "B", "C", "D", "E"} {
		discovered["/srv/media/movies/"+n+".mkv"] = struct{}{}
		if n != "E" {
			rows["/srv/media/movies/"+n+".mkv"] = int64(len(rows) + 1)
		}
	}
	if got := unattachedCount(discovered, rows); got != 1 {
		t.Fatalf("want 1 unattached, got %d", got)
	}
}

// A root stored with a trailing slash — reachable through the psql edit the
// runbook documents, where nothing normalizes what the operator typed — must
// not make every row read as outside, which would disable that library's
// prune permanently and silently.
func TestAllPathsOutsideRootsNormalizesTrailingSlashes(t *testing.T) {
	rows := map[string]int64{"/srv/storage/media/movies/A.mkv": 1}
	if allPathsOutsideRoots(rows, []string{"/srv/storage/media/movies/"}) {
		t.Fatal("a trailing slash on the root must not make its own rows read as relocated")
	}
	if allPathsOutsideRoots(rows, []string{"/srv/storage/media/movies//"}) {
		t.Fatal("a doubled slash must not either")
	}
	// An empty root is not a root; it must not silently match everything.
	if !allPathsOutsideRoots(rows, []string{"", "/mnt/elsewhere"}) {
		t.Fatal("an empty root entry must be ignored, leaving the real one to decide")
	}
}
