package library

import (
	"os"
	"path/filepath"
	"testing"
)

// deep-debug H9 addendum — collectVideoFiles reports WHICH directory entries
// the walk could not read, so the prune can be scoped around them. A clean
// tree must report none (anything else would needlessly shield rows from
// pruning), and the returned list must still contain exactly the video files.
func TestCollectVideoFilesCleanWalkReportsZeroErrors(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "Movies", "Inception (2010)")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	video := filepath.Join(sub, "Inception (2010).mkv")
	if err := os.WriteFile(video, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "poster.jpg"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	files, unreadable, err := collectVideoFiles(root)
	if err != nil {
		t.Fatalf("collectVideoFiles: %v", err)
	}
	if len(unreadable) != 0 {
		t.Fatalf("expected no unreadable paths on a clean tree, got %v", unreadable)
	}
	if len(files) != 1 || files[0] != video {
		t.Fatalf("expected exactly [%s], got %v", video, files)
	}
}

func TestCollectVideoFilesMissingRootReturnsError(t *testing.T) {
	if _, _, err := collectVideoFiles(filepath.Join(t.TempDir(), "does-not-exist")); err == nil {
		t.Fatal("expected an error for a nonexistent root (walkFailed guard depends on it)")
	}
}

// A dangling symlink is a file that is genuinely GONE — it must be skipped
// without being recorded as unreadable, or one stale symlink would shield its
// own row from pruning forever. (Unreadable-but-present files, by contrast,
// are recorded — but EACCES can't be simulated when the test runs as root, so
// only the not-exist branch is covered here.)
func TestCollectVideoFilesDanglingSymlinkDoesNotCountAsWalkError(t *testing.T) {
	root := t.TempDir()
	if err := os.Symlink(filepath.Join(root, "gone.mkv"), filepath.Join(root, "dangling.mkv")); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(root, "real.mkv")
	if err := os.WriteFile(real, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	files, unreadable, err := collectVideoFiles(root)
	if err != nil {
		t.Fatalf("collectVideoFiles: %v", err)
	}
	if len(unreadable) != 0 {
		t.Fatalf("dangling symlink must not be recorded as unreadable, got %v", unreadable)
	}
	if len(files) != 1 || files[0] != real {
		t.Fatalf("expected exactly [%s], got %v", real, files)
	}
}
