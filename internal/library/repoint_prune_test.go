package library

// The relocation guards.
//
// ScanLibrary prunes deleted files and sweeps media items left with no files.
// Run before phase 2 attaches what the walk found, on a library whose media
// just moved, that deletes every media item moments before the same titles are
// recreated under new ids — cascading away the watch progress, ratings, item
// feedback, taste seeds and embeddings that repointing exists to preserve.
//
// One rule prevents it, applied per ROW rather than per scan: a recorded path
// that lies outside the library's current roots was never covered by the walk,
// so its absence from the results is not evidence of anything. After a move,
// every old row sits outside the roots and is simply not a candidate.
//
// Three earlier designs tried to DETECT a relocation and suppress the scan's
// prune — skip it, defer it, gate the deferral — and each lost data, the last
// by latching the suppression on forever so a repointed library never pruned
// or swept again. Detection is gone; there is nothing to arm and nothing to
// clear.

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

// planPrune is now only the walk-failure decision — relocation is handled per
// row inside pruneDeletedFiles, not as a whole-scan verdict. Pinned anyway,
// because the H9 guard it carries is the oldest thing standing between a
// dropped NFS mount and the catalog.
func TestPlanPruneTable(t *testing.T) {
	if got := planPrune(false); got != prunePlanNow {
		t.Errorf("an ordinary scan must prune, got %v", got)
	}
	// An unwalkable root says nothing about any row under it (deep-debug H9).
	if got := planPrune(true); got != prunePlanSkip {
		t.Errorf("an unwalkable root must skip the prune, got %v", got)
	}
}

// The relocation rule is per ROW, and it is the whole safety story now. A row
// under the library's roots is prunable; one outside never is, whoever moved
// the library and whether or not anything told the scanner about it.
func TestRelocationIsDecidedPerRowNotPerScan(t *testing.T) {
	roots := []string{"/srv/storage/media/movies"}
	if !underAnyPrefix("/srv/storage/media/movies/A.mkv", roots) {
		t.Error("a row under the root must be a prune candidate")
	}
	if underAnyPrefix("/home/u/media/movies/A.mkv", roots) {
		t.Error("a row outside the roots must never be a prune candidate")
	}
	// The partial move the deleted marker existed for: [A B] -> [A C]. Rows
	// under the surviving root stay prunable; rows under the dropped one do
	// not. A whole-scan verdict could not express this.
	partial := []string{"/mnt/a", "/mnt/c"}
	if !underAnyPrefix("/mnt/a/kept.mkv", partial) {
		t.Error("the unchanged root must still prune normally")
	}
	if underAnyPrefix("/mnt/b/moved.mkv", partial) {
		t.Error("the dropped root's rows must not be pruned")
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

	pruned, relocated, err := s.pruneDeletedFiles(context.Background(), lib, nil, nil)
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
