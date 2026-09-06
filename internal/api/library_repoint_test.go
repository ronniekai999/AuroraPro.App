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
// Repointing the ORIGINAL library instead keeps those ids. The first attempt
// did that by changing libraries.paths and letting the rescan rediscover the
// files, trusting UpsertMediaItem to land on the same row — which review
// disproved against a real database, because that key is parsed from the
// filename while the stored row carries whatever TMDB enrichment last wrote.
// The rows are now moved WITH the library instead, so there is no re-match to
// get wrong. These tests pin the validation, the moved/not-moved decision, and
// the rewrite plan.

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

// ── Moving the file rows with the library ─────────────────────────

// planPathRewrites is what replaced "repoint and let the rescan rediscover
// it". That design assumed UpsertMediaItem would land on the SAME media_items
// row after the move; it does not, because its key is parsed from the filename
// while the stored row carries whatever TMDB enrichment last wrote. A row
// saying title="Seven", year=1995 whose folder reads "Se7en (1995)" re-keys to
// a NEW item, and the old one is swept as empty — taking the watch progress,
// ratings, feedback, taste seeds and embedding with it. Moving the rows means
// there is no re-match to get wrong.

func alwaysExists(string) bool { return true }
func neverExists(string) bool  { return false }

func TestPlanPathRewritesMovesEveryRowUnderTheOldRoot(t *testing.T) {
	recorded := map[string]int64{
		"/home/u/media/movies/Se7en (1995)/Se7en (1995).mkv": 11,
		"/home/u/media/movies/Heat (1995)/Heat (1995).mkv":   12,
	}
	got := planPathRewrites(
		[]string{"/home/u/media/movies"}, []string{"/srv/storage/media/movies"},
		recorded, alwaysExists)

	want := map[int64]string{
		11: "/srv/storage/media/movies/Se7en (1995)/Se7en (1995).mkv",
		12: "/srv/storage/media/movies/Heat (1995)/Heat (1995).mkv",
	}
	if len(got) != len(want) {
		t.Fatalf("want %d moves, got %d: %v", len(want), len(got), got)
	}
	for id, p := range want {
		if got[id] != p {
			t.Errorf("row %d: want %q, got %q", id, p, got[id])
		}
	}
}

// A row is moved only if something is actually THERE. A partial move — or a
// repoint saved before the copy finished — must leave the rest pointing where
// they still are, rather than at a tidy path with nothing at it.
func TestPlanPathRewritesSkipsTargetsThatDoNotExist(t *testing.T) {
	recorded := map[string]int64{
		"/home/u/media/movies/Moved.mkv":  1,
		"/home/u/media/movies/Stayed.mkv": 2,
	}
	exists := func(p string) bool { return strings.HasSuffix(p, "Moved.mkv") }

	got := planPathRewrites([]string{"/home/u/media/movies"}, []string{"/srv/media/movies"}, recorded, exists)
	if len(got) != 1 || got[1] != "/srv/media/movies/Moved.mkv" {
		t.Fatalf("only the file present at the new location may be moved, got %v", got)
	}
	if _, moved := got[2]; moved {
		t.Error("a row whose target is absent must be left alone")
	}
}

// Roots map positionally, so an ambiguous change (a root added or removed)
// declines entirely rather than guessing which new root a row belongs under.
func TestPlanPathRewritesDeclinesWhenRootCountsDiffer(t *testing.T) {
	recorded := map[string]int64{"/mnt/a/x.mkv": 1}
	if got := planPathRewrites([]string{"/mnt/a"}, []string{"/mnt/b", "/mnt/c"}, recorded, alwaysExists); got != nil {
		t.Fatalf("adding a root is not an unambiguous relocation, got %v", got)
	}
	if got := planPathRewrites([]string{"/mnt/a", "/mnt/b"}, []string{"/mnt/c"}, recorded, alwaysExists); got != nil {
		t.Fatalf("removing a root is not an unambiguous relocation, got %v", got)
	}
}

func TestPlanPathRewritesMapsMultipleRootsPositionally(t *testing.T) {
	recorded := map[string]int64{
		"/mnt/a/one.mkv": 1,
		"/mnt/b/two.mkv": 2,
	}
	got := planPathRewrites([]string{"/mnt/a", "/mnt/b"}, []string{"/srv/x", "/srv/y"}, recorded, alwaysExists)
	if got[1] != "/srv/x/one.mkv" {
		t.Errorf("first root: got %q", got[1])
	}
	if got[2] != "/srv/y/two.mkv" {
		t.Errorf("second root: got %q", got[2])
	}
}

// Path-boundary matching: /media/Show 2 does not live under /media/Show, and
// rewriting it as though it did would point the row at a path built from the
// wrong prefix.
func TestPlanPathRewritesComparesOnPathBoundaries(t *testing.T) {
	recorded := map[string]int64{"/srv/media-old/x.mkv": 1}
	if got := planPathRewrites([]string{"/srv/media"}, []string{"/srv/new"}, recorded, alwaysExists); got != nil {
		t.Fatalf("/srv/media-old must not be treated as living under /srv/media, got %v", got)
	}
}

func TestPlanPathRewritesReturnsNilWhenThereIsNothingToDo(t *testing.T) {
	recorded := map[string]int64{"/home/u/media/x.mkv": 1}
	if got := planPathRewrites(nil, nil, recorded, alwaysExists); got != nil {
		t.Error("no roots means no plan")
	}
	if got := planPathRewrites([]string{"/home/u/media"}, []string{"/srv/media"}, nil, alwaysExists); got != nil {
		t.Error("no recorded rows means no plan")
	}
	// Nothing present at the new location: nil, not an empty map, so the
	// caller's `len(moves) > 0` reporting stays honest.
	if got := planPathRewrites([]string{"/home/u/media"}, []string{"/srv/media"}, recorded, neverExists); got != nil {
		t.Errorf("no reachable targets means no plan, got %v", got)
	}
}

// A row that is not under any of the OLD roots is none of this operation's
// business — it belongs to a root that did not change.
func TestPlanPathRewritesLeavesRowsOutsideTheOldRoots(t *testing.T) {
	recorded := map[string]int64{
		"/mnt/unchanged/x.mkv": 1,
		"/mnt/moving/y.mkv":    2,
	}
	got := planPathRewrites([]string{"/mnt/moving"}, []string{"/srv/moved"}, recorded, alwaysExists)
	if len(got) != 1 || got[2] != "/srv/moved/y.mkv" {
		t.Fatalf("only rows under the changed root may move, got %v", got)
	}
}
