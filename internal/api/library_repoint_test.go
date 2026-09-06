package api

// Tests for repointing a library at new paths — the supported way to handle
// media that moved on disk.
//
// Why this exists: a production box moved its media from
// /home/<user>/media/* to /srv/storage/media/*. Because UpdateLibraryRequest
// carried only a name, there was no way to tell Aurora the files had moved,
// so the operator did the only thing the UI allowed and created four NEW
// libraries at the new roots. media_items is keyed on (library_id, type,
// title, year), so that produced a second, parallel catalog with fresh ids —
// and every row that hangs off media_item_id (watch progress, ratings, item
// feedback, taste seeds, collections, the embedding column) stayed welded to
// the old ids. Recommendations went cold overnight.
//
// Repointing the ORIGINAL library instead makes the rescan upsert onto the
// existing rows, so none of that moves. These tests pin the validation and
// the moved/not-moved decision that gate it.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateLibraryPathsResolvesAndAccepts(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "movies")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	got, msg := validateLibraryPaths([]string{sub})
	if msg != "" {
		t.Fatalf("expected a valid directory to pass, got %q", msg)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 resolved path, got %d: %v", len(got), got)
	}
	// EvalSymlinks may canonicalize the temp dir itself (macOS /var →
	// /private/var), so compare against the resolved form rather than the
	// literal input.
	want, err := filepath.EvalSymlinks(sub)
	if err != nil {
		t.Fatal(err)
	}
	if got[0] != want {
		t.Errorf("want resolved path %q, got %q", want, got[0])
	}
}

// The stored value must be the SYMLINK-RESOLVED path, not what the admin
// typed. Storing the link would let a later re-point of the link move the
// library without Aurora ever revalidating it against the blocklist.
func TestValidateLibraryPathsStoresTheResolvedTarget(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real-media")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link-to-media")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}

	got, msg := validateLibraryPaths([]string{link})
	if msg != "" {
		t.Fatalf("expected the symlink to resolve and pass, got %q", msg)
	}
	wantReal, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatal(err)
	}
	if got[0] != wantReal {
		t.Errorf("want the resolved target %q stored, got %q", wantReal, got[0])
	}
}

// The blocklist is applied AFTER resolution, so a symlink pointing into a
// blocked prefix is refused. This is the whole reason resolution happens
// first, and it now has two call sites (Create and Update) reaching one
// helper rather than two copies, only one of which would keep the check.
func TestValidateLibraryPathsRefusesSymlinkIntoBlockedPrefix(t *testing.T) {
	dir := t.TempDir()
	link := filepath.Join(dir, "sneaky")
	if err := os.Symlink("/etc", link); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}

	if _, msg := validateLibraryPaths([]string{link}); msg == "" {
		t.Fatal("a symlink to /etc must be refused, not accepted")
	} else if !strings.Contains(msg, "not allowed") {
		t.Errorf("want a 'not allowed' refusal, got %q", msg)
	}
}

func TestValidateLibraryPathsRefusesBlockedPrefixes(t *testing.T) {
	// Aurora's own state dir is on the list because a library pointed at it
	// would expose the source mirror and update state via direct-play
	// streaming (2026-05-19 audit, API-H6).
	for _, p := range []string{"/etc", "/proc", "/var/lib/aurora"} {
		if _, err := os.Stat(p); err != nil {
			continue // not present in this environment; nothing to assert
		}
		if _, msg := validateLibraryPaths([]string{p}); msg == "" {
			t.Errorf("%s must be refused as a library path", p)
		}
	}
}

func TestValidateLibraryPathsRefusesAFile(t *testing.T) {
	f := filepath.Join(t.TempDir(), "movie.mkv")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, msg := validateLibraryPaths([]string{f})
	if !strings.Contains(msg, "not a directory") {
		t.Errorf("want a 'not a directory' refusal for %s, got %q", f, msg)
	}
}

func TestValidateLibraryPathsRefusesAMissingPath(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "definitely", "absent")
	_, msg := validateLibraryPaths([]string{missing})
	if msg == "" {
		t.Fatal("a missing path must be refused")
	}
	// The message is what the admin sees in the alert dialog, and the
	// permission-vs-absent distinction is the one that matters (see
	// pathAccessError) — assert we route through it rather than inventing a
	// second, less useful wording.
	if !strings.Contains(msg, "does not exist on the server") {
		t.Errorf("want pathAccessError's wording, got %q", msg)
	}
}

// One bad path fails the whole set. A partially-applied repoint would leave
// the library scanning a mixture of old and new roots, which is how a prune
// gets a non-empty file list for a root that has actually moved.
func TestValidateLibraryPathsIsAllOrNothing(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good")
	if err := os.Mkdir(good, 0o755); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "gone")

	got, msg := validateLibraryPaths([]string{good, missing})
	if msg == "" {
		t.Fatal("a set containing a bad path must be refused entirely")
	}
	if got != nil {
		t.Errorf("a refused set must return no paths, got %v", got)
	}
}

// samePaths decides whether a save triggers a watcher re-attach and a rescan.
// Getting "unchanged" wrong in the permissive direction rescans a large
// library for nothing; getting it wrong in the other direction leaves
// fsnotify watching a directory tree that no longer holds the media.
func TestSamePaths(t *testing.T) {
	cases := []struct {
		name string
		a, b []string
		want bool
	}{
		{"identical single", []string{"/srv/media/movies"}, []string{"/srv/media/movies"}, true},
		{"identical multi", []string{"/a", "/b"}, []string{"/a", "/b"}, true},
		{"moved", []string{"/home/u/media/movies"}, []string{"/srv/storage/media/movies"}, false},
		{"added", []string{"/a"}, []string{"/a", "/b"}, false},
		{"removed", []string{"/a", "/b"}, []string{"/a"}, false},
		// A reorder reads as a change. The comparison is element-wise, so
		// this costs one redundant rescan that finds nothing — pinned here
		// so the behaviour is a decision rather than a surprise.
		{"reordered", []string{"/a", "/b"}, []string{"/b", "/a"}, false},
		{"both empty", nil, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := samePaths(tc.a, tc.b); got != tc.want {
				t.Errorf("samePaths(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}
