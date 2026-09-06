package library

// scripts/check-library-paths.sh predicts what a scan will prune. It can only
// do that if it models the scanner's two load-bearing behaviours exactly, and
// both are easy to get subtly wrong — the script's first draft got the second
// one wrong and reported a catalog-destroying state as clean.
//
// These pin the behaviours the script depends on. If either changes, the
// script silently starts lying, and the failure mode is an operator being told
// it is safe to start the server.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The scanner does not descend into a directory symlink, so files beneath one
// are invisible to it and their recorded rows are pruned. `find` without -L
// behaves the same way, which is why the script uses it.
func TestWalkDoesNotDescendIntoDirectorySymlinks(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(real, "Hidden.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Seen.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	found, _, err := collectVideoFiles(root)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	var sawHidden, sawSeen bool
	for _, p := range found {
		if strings.HasSuffix(p, "Hidden.mkv") {
			sawHidden = true
		}
		if strings.HasSuffix(p, "Seen.mkv") {
			sawSeen = true
		}
	}
	if !sawSeen {
		t.Error("the ordinary file was not discovered")
	}
	if sawHidden {
		t.Error("the walk descended into a directory symlink — check-library-paths.sh uses `find` without -L on the assumption that it does not, and would now under-report what a scan will prune")
	}
}

// The walk builds every child with filepath.Join, which CLEANS. So a recorded
// path that is merely spelled differently — a doubled slash, a "/./" — can
// never equal what the walk produces, and its row is pruned. The script must
// therefore compare the RAW recorded string, not a normalised one; normalising
// both sides hides exactly this.
func TestWalkOutputIsAlwaysLexicallyClean(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "Show")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "E01.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Walk from a deliberately non-canonical spelling of the same directory.
	found, _, err := collectVideoFiles(root + "//./")
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(found) != 1 {
		t.Fatalf("want 1 file, got %d: %v", len(found), found)
	}
	if got := found[0]; got != filepath.Clean(got) {
		t.Errorf("walk emitted a non-canonical path %q — the script canonicalises the ROOT on the assumption that children come back clean", got)
	}
	// And the un-cleaned spelling a careless UPDATE would have written is NOT
	// what the walk produces, which is the whole hazard.
	dirty := root + "//Show/E01.mkv"
	if found[0] == dirty {
		t.Error("a doubled-slash path matched the walk output; the prune's exact-string comparison would then be harmless, and the script's raw comparison too strict")
	}
}
