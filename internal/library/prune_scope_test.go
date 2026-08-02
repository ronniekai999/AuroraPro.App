package library

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Scoping the prune around unreadable subtrees.
//
// Before: ONE unreadable directory disabled the deleted-file prune for the
// ENTIRE library. In production a single permission-denied folder
// (/home/rontavious999/media/tvshows/CSI - Miami) kept every deleted TV
// episode row alive for three days across 197 scans, with a log line as the
// only evidence.
//
// After: rows under the unreadable subtree are shielded (their files may well
// still exist — we simply could not look), and everything else, which walked
// cleanly, prunes normally.

func TestUnderAnyPrefix(t *testing.T) {
	unreadable := []string{"/media/tvshows/CSI - Miami"}

	tests := []struct {
		name   string
		path   string
		expect bool
	}{
		{"file directly inside", "/media/tvshows/CSI - Miami/S01/e01.mkv", true},
		{"the directory itself", "/media/tvshows/CSI - Miami", true},
		{"deeply nested", "/media/tvshows/CSI - Miami/a/b/c/d.mkv", true},
		{"sibling show", "/media/tvshows/CSI - Vegas/S01/e01.mkv", false},
		{"parent directory", "/media/tvshows/other.mkv", false},
		// The bug a naive strings.HasPrefix would introduce: a DIFFERENT show
		// whose name merely starts with the unreadable one would be shielded
		// forever, silently disabling its pruning.
		{"name-prefix sibling must NOT be shielded", "/media/tvshows/CSI - Miami 2/S01/e01.mkv", false},
		{"name-prefix sibling file", "/media/tvshows/CSI - Miami Reboot.mkv", false},
		{"unrelated root", "/other/place/x.mkv", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := underAnyPrefix(tc.path, unreadable); got != tc.expect {
				t.Fatalf("underAnyPrefix(%q) = %v, want %v", tc.path, got, tc.expect)
			}
		})
	}
}

func TestUnderAnyPrefix_EmptyPrefixesShieldNothing(t *testing.T) {
	// A clean walk must shield nothing, or pruning would stop entirely.
	if underAnyPrefix("/media/tvshows/anything.mkv", nil) {
		t.Fatal("no unreadable paths means nothing is shielded")
	}
	if underAnyPrefix("/media/x.mkv", []string{}) {
		t.Fatal("empty slice must shield nothing")
	}
}

func TestUnderAnyPrefix_NormalizesPaths(t *testing.T) {
	// Prefixes come from filepath.Clean at collection time; the DB path may
	// not be clean. Both sides must normalize or the shield silently misses.
	if !underAnyPrefix("/media/tvshows/CSI - Miami/./S01/e01.mkv",
		[]string{"/media/tvshows/CSI - Miami"}) {
		t.Fatal("unclean path should still be recognised as inside the subtree")
	}
}

func TestBoundedPaths(t *testing.T) {
	in := []string{"a", "b", "c", "d", "e"}
	if got := boundedPaths(in, 3); len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	if got := boundedPaths(in, 10); len(got) != 5 {
		t.Fatalf("len = %d, want all 5 when under the bound", len(got))
	}
	if got := boundedPaths(nil, 5); got != nil {
		t.Fatalf("nil in, want nil out, got %v", got)
	}
}

// TestCollectVideoFiles_UnreadableDirIsRecordedAndScannable is the end-to-end
// shape of the CSI - Miami case: an unreadable directory alongside readable
// ones. The readable files must still be discovered (so they are not pruned)
// AND the unreadable directory must be reported (so its rows are shielded).
func TestCollectVideoFiles_UnreadableDirIsRecordedAndScannable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: chmod 000 does not produce EACCES")
	}
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permissions")
	}

	root := t.TempDir()
	good := filepath.Join(root, "CSI - Vegas", "Season 1")
	if err := os.MkdirAll(good, 0o755); err != nil {
		t.Fatal(err)
	}
	goodFile := filepath.Join(good, "e01.mkv")
	if err := os.WriteFile(goodFile, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	bad := filepath.Join(root, "CSI - Miami")
	if err := os.MkdirAll(filepath.Join(bad, "Season 1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(bad, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(bad, 0o755) })

	files, unreadable, err := collectVideoFiles(root)
	if err != nil {
		t.Fatalf("collectVideoFiles: %v", err)
	}

	// The readable half of the library must still be discovered — otherwise
	// its rows would look deleted and get pruned.
	if len(files) != 1 || files[0] != goodFile {
		t.Fatalf("readable files should still be discovered, got %v", files)
	}

	if len(unreadable) == 0 {
		t.Fatal("the unreadable directory must be reported so its rows are shielded")
	}
	if !underAnyPrefix(filepath.Join(bad, "Season 1", "e01.mkv"), unreadable) {
		t.Fatalf("a file under the unreadable dir must be shielded; unreadable=%v", unreadable)
	}
	// ...and the readable sibling must NOT be shielded, or we would have
	// traded a total prune outage for a partial one.
	if underAnyPrefix(goodFile, unreadable) {
		t.Fatalf("readable sibling must not be shielded; unreadable=%v", unreadable)
	}
}
