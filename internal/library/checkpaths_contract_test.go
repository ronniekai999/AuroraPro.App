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
	"regexp"
	"strings"
	"testing"
)

// The scanner does not descend into a directory symlink, so files beneath one
// are invisible to it and their recorded rows are pruned. `find` without -L
// behaves the same way, which is why the script uses it.
func TestWalkDoesNotDescendIntoDirectorySymlinks(t *testing.T) {
	root := t.TempDir()
	// The target lives INSIDE the root. An earlier version of this test put it
	// in a separate TempDir, which meant the pre-existing symlink-escape guard
	// satisfied the assertion — so a walk that DID descend still passed, and
	// the property the script depends on was not pinned at all. Verified by
	// building a descending variant of collectVideoFiles: it passed the old
	// test and fails this one.
	target := filepath.Join(root, "actual")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "Hidden.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Seen.mkv"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "linked")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	found, _, err := collectVideoFiles(root)
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	var sawSeen bool
	for _, p := range found {
		if strings.Contains(p, string(filepath.Separator)+"linked"+string(filepath.Separator)) {
			t.Errorf("the walk descended into a directory symlink: %q — check-library-paths.sh uses `find` without -L on the assumption that it does not, and would now under-report what a scan will prune", p)
		}
		if strings.HasSuffix(p, "Seen.mkv") {
			sawSeen = true
		}
	}
	// The same file IS reachable by its real path, so this is about the
	// traversal, not about the file being excluded.
	var sawViaRealPath bool
	for _, p := range found {
		if strings.Contains(p, string(filepath.Separator)+"actual"+string(filepath.Separator)) {
			sawViaRealPath = true
		}
	}
	if !sawSeen {
		t.Error("the ordinary file was not discovered")
	}
	if !sawViaRealPath {
		t.Error("the file was not discovered by its real path either — this test is no longer isolating the symlink behaviour")
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

// The script's extension filter must be EXACTLY IsVideoFile's, not a superset.
// An extra entry there is a false all-clear: a recorded row the scanner will
// never rediscover, reported as "will be found" while the scan prunes it and
// the sweep takes its title with all of its history. The first draft carried
// four extras (vob, ogv, 3gp, mts) and did exactly that.
func TestCheckScriptExtensionsMatchIsVideoFile(t *testing.T) {
	raw, err := os.ReadFile("../../scripts/check-library-paths.sh")
	if err != nil {
		t.Fatalf("read script: %v", err)
	}
	m := regexp.MustCompile(`VIDEO_RE='\\\.\(([^)]*)\)\$'`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("could not find VIDEO_RE in scripts/check-library-paths.sh — if it was renamed, this pin is now inert")
	}
	inScript := map[string]bool{}
	for _, e := range strings.Split(string(m[1]), "|") {
		if e != "" {
			inScript["."+e] = true
		}
	}
	for ext := range videoExtensions {
		if !inScript[ext] {
			t.Errorf("%s is a video extension to the scanner but not to check-library-paths.sh — files with it read as 'not in the catalog yet' instead of being compared", ext)
		}
		delete(inScript, ext)
	}
	for ext := range inScript {
		t.Errorf("%s is matched by check-library-paths.sh but is NOT a video extension to the scanner — a recorded row with it would be reported as safe and then pruned", ext)
	}
}
