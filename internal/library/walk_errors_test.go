package library

import (
	"os"
	"path/filepath"
	"testing"
)

// deep-debug H9 addendum — collectVideoFiles now reports the number of
// directory entries the walk could not read, so Scan can skip the prune when
// the file list is incomplete. A clean tree must report zero walk errors
// (anything else would permanently disable pruning), and the returned list
// must still contain exactly the video files.
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

	files, walkErrs, err := collectVideoFiles(root)
	if err != nil {
		t.Fatalf("collectVideoFiles: %v", err)
	}
	if walkErrs != 0 {
		t.Fatalf("expected 0 walk errors on a clean tree, got %d", walkErrs)
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
// without counting a walk error, or one stale symlink would disable the
// deleted-file prune for the whole library forever. (Unreadable-but-present
// files, by contrast, do count — but EACCES can't be simulated when the test
// runs as root, so only the not-exist branch is covered here.)
func TestCollectVideoFilesDanglingSymlinkDoesNotCountAsWalkError(t *testing.T) {
	root := t.TempDir()
	if err := os.Symlink(filepath.Join(root, "gone.mkv"), filepath.Join(root, "dangling.mkv")); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(root, "real.mkv")
	if err := os.WriteFile(real, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	files, walkErrs, err := collectVideoFiles(root)
	if err != nil {
		t.Fatalf("collectVideoFiles: %v", err)
	}
	if walkErrs != 0 {
		t.Fatalf("dangling symlink must not count as a walk error, got %d", walkErrs)
	}
	if len(files) != 1 || files[0] != real {
		t.Fatalf("expected exactly [%s], got %v", real, files)
	}
}
