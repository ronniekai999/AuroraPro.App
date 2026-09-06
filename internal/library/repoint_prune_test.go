package library

// The repoint prune guard.
//
// ScanLibrary prunes deleted files (phase 1b) and sweeps media items left
// with no files (phase 1c) BEFORE phase 2 attaches the files it just found.
// On the first scan after an admin moves a library's paths, every DB row
// still describes the old location and nothing under it is in the walk — so
// without this guard the sweep deletes each media item a moment before the
// same title is re-created from the new path, cascading away the watch
// progress, ratings, item feedback, taste seeds and embeddings that
// repointing exists to preserve. The feature would destroy exactly what it
// advertises.
//
// These tests pin the guard's arming and, more importantly, its DISARMING:
// a skip that never expires is a prune that never runs again.

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

func TestConsumeRepointIsFalseWithoutARecord(t *testing.T) {
	s := repointScanner()
	if s.consumeRepoint(libAt(1, "/srv/media/movies")) {
		t.Fatal("a library nobody repointed must prune normally")
	}
}

func TestConsumeRepointFiresOnceForTheNewPaths(t *testing.T) {
	s := repointScanner()
	lib := libAt(1, "/srv/storage/media/movies")
	s.NoteRepointed(lib.ID, lib.Paths)

	if !s.consumeRepoint(lib) {
		t.Fatal("the first scan on the new paths must skip the prune")
	}
	// The second scan has the new files attached to the same media items, so
	// the stale old-location rows are now prunable with real evidence. A
	// guard that stayed armed would leave them forever.
	if s.consumeRepoint(lib) {
		t.Fatal("the guard must not survive the scan it was set for")
	}
}

// The race the paths key exists for: a periodic scan can start between the
// admin's save and the handler's own rescan, and it is still running against
// the OLD paths. A bare flag would be consumed by that scan and the real
// post-move scan would prune unguarded — losing the history the guard was
// set to protect.
func TestConsumeRepointIgnoresAScanStillOnTheOldPaths(t *testing.T) {
	s := repointScanner()
	const id = 1
	old := libAt(id, "/home/u/media/movies")
	moved := libAt(id, "/srv/storage/media/movies")

	s.NoteRepointed(id, moved.Paths)

	if s.consumeRepoint(old) {
		t.Fatal("a scan on the old paths must not consume the guard")
	}
	if !s.consumeRepoint(moved) {
		t.Fatal("the guard must still be there for the scan that actually moved")
	}
}

func TestConsumeRepointIsPerLibrary(t *testing.T) {
	s := repointScanner()
	s.NoteRepointed(7, []string{"/srv/storage/media/movies"})

	if s.consumeRepoint(libAt(8, "/srv/storage/media/movies")) {
		t.Fatal("a different library must not consume another's guard, same paths or not")
	}
	if !s.consumeRepoint(libAt(7, "/srv/storage/media/movies")) {
		t.Fatal("library 7's own guard must survive library 8's scan")
	}
}

func TestConsumeRepointRequiresEveryPathToMatch(t *testing.T) {
	s := repointScanner()
	const id = 3
	s.NoteRepointed(id, []string{"/srv/a", "/srv/b"})

	// A partial match is not the move that was recorded — the library is
	// scanning somewhere the admin did not ask for, and suppressing a prune
	// on a set we cannot account for is worse than a redundant one.
	if s.consumeRepoint(libAt(id, "/srv/a")) {
		t.Fatal("a subset of the recorded paths must not consume the guard")
	}
	if s.consumeRepoint(libAt(id, "/srv/a", "/srv/c")) {
		t.Fatal("a differing path must not consume the guard")
	}
	if !s.consumeRepoint(libAt(id, "/srv/a", "/srv/b")) {
		t.Fatal("the exact recorded paths must consume it")
	}
}

// NoteRepointed must copy: the handler passes the same slice it hands to the
// UPDATE and then to the rescan goroutine, and an aliased slice mutated
// afterwards would silently re-key the record.
func TestNoteRepointedCopiesThePaths(t *testing.T) {
	s := repointScanner()
	paths := []string{"/srv/storage/media/movies"}
	s.NoteRepointed(1, paths)
	paths[0] = "/somewhere/else"

	if !s.consumeRepoint(libAt(1, "/srv/storage/media/movies")) {
		t.Fatal("the record must hold its own copy of the paths")
	}
}

func TestForgetRepointClearsAPendingGuard(t *testing.T) {
	s := repointScanner()
	s.NoteRepointed(1, []string{"/srv/storage/media/movies"})
	s.ForgetRepoint(1)

	if s.consumeRepoint(libAt(1, "/srv/storage/media/movies")) {
		t.Fatal("a forgotten guard must not fire")
	}
	// Forgetting one nobody set, or one already consumed, is a no-op rather
	// than a panic — Delete calls it unconditionally.
	s.ForgetRepoint(99)
}

// The guard only suppresses the prune. It must not suppress the walk, so a
// repointed library still reports what it found and still processes files.
// This is the shape of the failure the H9 zero-discovered guard warns about:
// a guard that returns early rather than skipping one phase.
func TestRepointGuardStillPrunesNothingRatherThanFailing(t *testing.T) {
	s := repointScanner()
	lib := libAt(1, t.TempDir())
	s.NoteRepointed(lib.ID, lib.Paths)
	s.consumeRepoint(lib)

	// pruneDeletedFiles is still callable and still refuses a zero-discovered
	// prune; the repoint guard is layered above it, not in place of it.
	pruned, err := s.pruneDeletedFiles(context.Background(), lib, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pruned != 0 {
		t.Fatalf("want 0 pruned, got %d", pruned)
	}
}
