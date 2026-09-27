package db

// Cross-library sibling linking must match on (tmdb_id, TYPE), never on
// tmdb_id alone. TMDB's movie and TV id spaces are INDEPENDENT: movie 100 and
// tv 100 both exist and are unrelated titles. Every query in this area used to
// join on the id alone, so a movie and a show that happened to share a numeric
// id were treated as two copies of one title — collapsing into a single row in
// "Recently Added" and in search, lending each other quality badges, and
// attaching a movie's files to a show's detail page.
//
// migrations/011_cross_library_linking.up.sql ships
// idx_media_items_tmdb_type ON media_items(tmdb_id, type) and documents it as
// "given a tmdb_id AND type" — the index was built for a predicate none of
// these queries wrote.
//
// Opt-in integration: set TEST_DATABASE_URL=postgres://... to run. Skipped
// when unset (reuses requireIntegrationDB / randomSuffix / seedTestUser from
// queries_jsonb_integration_test.go), so the standalone unit suite stays
// DB-free.

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"sort"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// uniqueTMDBID returns a random tmdb_id in a high band. media_items.tmdb_id is
// INTEGER, so it must stay inside int32. Drawn randomly rather than from a
// sequence so the fixture cannot collide with real catalog rows in a shared
// test database, and so the test does not advance a production sequence.
func uniqueTMDBID(t *testing.T) int {
	t.Helper()
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	// 1_000_000 .. 2_000_999_999, which stays inside int32. This is NOT above
	// every real TMDB id (movie ids passed 1.2M years ago), so it is
	// collision-avoidance by width, not a guarantee of absence. Most assertions
	// here are immune to a catalog row sharing the drawn id — DeduplicateByTMDBID
	// only considers the slice it is passed, the file-level assertions are keyed
	// to the fixture's own row ids, and the GetMediaItems and rail/grid tests
	// scope their queries (title token / content_rating token). The exposed pair
	// is the two GetRecentMedia tests, whose query takes no filter at all: a
	// pre-existing row with the same tmdb_id and type could join their dedup
	// group and win it. At a ~1/2e9 draw that is a tolerated residual risk, not
	// something the range rules out, and it fails loudly rather than passing.
	return 1_000_000 + int(binary.BigEndian.Uint32(b[:])%2_000_000_000)
}

// collidingPair is the fixture every test here needs: one movie and one show
// in separate libraries sharing ONE numeric tmdb_id. Titles and paths are
// namespaced so parallel runs don't collide on the unique constraints.
type collidingPair struct {
	tmdbID     int
	movieID    int64
	showID     int64
	titleToken string
}

func seedTypedLibrary(t *testing.T, q *Queries, ownerID int64, libType string) int64 {
	t.Helper()
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO libraries (name, type, paths, owner_id)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		"xlib_type_test_"+randomSuffix(t), libType,
		[]string{"/tmp/xlib_type_test"}, ownerID,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed %s library: %v", libType, err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM libraries WHERE id = $1`, id)
	})
	return id
}

// seedTypedMediaItem mirrors what UpsertMediaItem actually writes: every
// nullable column gets a non-NULL zero value. That matters because the read
// paths under test scan year/overview/rating/runtime/content_rating into
// non-nullable Go types, so a fixture leaving them NULL fails on the scan
// rather than on the behaviour being tested.
func seedTypedMediaItem(t *testing.T, q *Queries, libraryID int64, itemType string, tmdbID int, titleToken string) int64 {
	t.Helper()
	// titleToken is shared by every row of one fixture, so a test can scope a
	// GLOBAL query to its own rows via MediaFilter.Query (title ILIKE). Without
	// that, GetMediaItems is catalog-wide and paginated, and rows seeded
	// concurrently by another test can push the fixture off the first page.
	title := "XLibType " + titleToken + " " + randomSuffix(t)
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO media_items
		   (library_id, type, title, sort_title, tmdb_id,
		    year, overview, rating, runtime_minutes, content_rating)
		 VALUES ($1, $2, $3, $3, $4, 0, '', 0, 0, '') RETURNING id`,
		libraryID, itemType, title, tmdbID,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed %s media item: %v", itemType, err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM media_items WHERE id = $1`, id)
	})
	return id
}

// resolutionFor keeps a fixture's resolution consistent with its version_tag.
// ClassifyVersion (internal/library/scanner.go) derives the tag FROM the
// resolution, so a '4K' tag beside a 1920x1080 resolution is a pair the scanner
// could never write. Nothing under test reads resolution, but a fixture that
// claims to mirror the scanner should not contradict it.
func resolutionFor(versionTag string) string {
	switch versionTag {
	case "4K":
		return "3840x2160"
	case "720p":
		return "1280x720"
	default:
		return "1920x1080"
	}
}

// seedQualityFile inserts one media_files row carrying a version_tag and/or a
// color_transfer, so the 4K / HDR badge queries have something to find.
func seedQualityFile(t *testing.T, q *Queries, mediaItemID int64, versionTag, colorTransfer string) int64 {
	t.Helper()
	suffix := randomSuffix(t)
	var id int64
	// As in seedTypedMediaItem: the scanner writes every column, and
	// GetCrossLibraryFiles scans container/codec/resolution into non-nullable
	// Go types, so the fixture must not leave them NULL.
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO media_files
		   (media_item_id, path, file_hash, version_tag, color_transfer,
		    size_bytes, container, video_codec, audio_codec, resolution,
		    bitrate, duration_ms)
		 VALUES ($1, $2, $3, $4, $5, 1, 'mkv', 'h264', 'aac', $6, 0, 0)
		 RETURNING id`,
		mediaItemID, "/tmp/xlib_type_test/"+suffix+".mkv", "hash_"+suffix,
		versionTag, colorTransfer, resolutionFor(versionTag),
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed media_file: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM media_files WHERE id = $1`, id)
	})
	return id
}

// newCollidingPair seeds a movie and a show sharing one tmdb_id. The tmdb_id is
// namespaced into a high range so it cannot collide with another test's
// fixtures or with real catalog rows in a shared test database.
func newCollidingPair(t *testing.T, q *Queries) collidingPair {
	t.Helper()
	ownerID := seedTestUser(t, q)
	movieLib := seedTypedLibrary(t, q, ownerID, "movie")
	showLib := seedTypedLibrary(t, q, ownerID, "show")

	// The movie library is seeded first so its item gets the lower
	// media_items.id — which is what the pre-fix dedup tie-break (richness,
	// then id ASC) selected as the winner, making the SHOW the row that
	// disappeared.
	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)

	return collidingPair{
		tmdbID:     tmdbID,
		titleToken: token,
		movieID:    seedTypedMediaItem(t, q, movieLib, "movie", tmdbID, token),
		showID:     seedTypedMediaItem(t, q, showLib, "show", tmdbID, token),
	}
}

// TestGetRecentMediaKeepsBothTypesOnATMDBIDCollision: GetRecentMedia's dedup
// CTE carries no WHERE clause at all, so nothing constrained it to one type.
// Pre-fix the show vanished from "Recently Added" entirely — the movie wins the
// richness/id tie-break because movie libraries are typically created first.
func TestGetRecentMediaKeepsBothTypesOnATMDBIDCollision(t *testing.T) {
	q := requireIntegrationDB(t)
	p := newCollidingPair(t, q)

	// A generous limit: this query is global (no library scoping), so a shared
	// test database may hold unrelated rows. We assert on OUR two ids rather
	// than on any total count.
	//
	// UNSCOPEABLE ASSUMPTION, stated rather than fixed: GetRecentMedia takes only
	// a limit — no filter struct, no allowedRatings — so unlike the GetMediaItems
	// and rail/grid tests, this one cannot narrow the query to its own rows. It
	// relies on the fixture's rows being among the 500 newest by added_at, which
	// holds because they were just inserted and real catalog rows are older. It
	// would break only if something seeded 500+ media_items concurrently, and it
	// would break loudly.
	items, err := q.GetRecentMedia(context.Background(), 500)
	if err != nil {
		t.Fatalf("GetRecentMedia: %v", err)
	}

	var sawMovie, sawShow bool
	for _, it := range items {
		switch it.ID {
		case p.movieID:
			sawMovie = true
		case p.showID:
			sawShow = true
		}
	}
	if !sawMovie {
		t.Errorf("movie %d (tmdb_id %d) missing from GetRecentMedia", p.movieID, p.tmdbID)
	}
	if !sawShow {
		t.Errorf("show %d (tmdb_id %d) missing from GetRecentMedia — a movie sharing that "+
			"numeric TMDB id collapsed it out of the dedup CTE; the dedup key must include m.type",
			p.showID, p.tmdbID)
	}
}

// TestGetRecentMediaStillCollapsesSameTypeSiblings is the counterpart the leak
// test above needs: without it the whole dedup key could be replaced by m.id
// — disabling cross-library dedup in "Recently Added", so the same movie in
// "Movies" and "4K Movies" shows twice — with the suite still green.
func TestGetRecentMediaStillCollapsesSameTypeSiblings(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	libA := seedTypedLibrary(t, q, ownerID, "movie")
	libB := seedTypedLibrary(t, q, ownerID, "movie")

	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)
	idA := seedTypedMediaItem(t, q, libA, "movie", tmdbID, token)
	idB := seedTypedMediaItem(t, q, libB, "movie", tmdbID, token)

	items, err := q.GetRecentMedia(context.Background(), 500)
	if err != nil {
		t.Fatalf("GetRecentMedia: %v", err)
	}
	var seen int
	for _, it := range items {
		if it.ID == idA || it.ID == idB {
			seen++
		}
	}
	if seen != 1 {
		t.Errorf("saw %d of the two same-tmdb_id movie copies in GetRecentMedia, want exactly 1 "+
			"— cross-library dedup must still collapse same-type siblings", seen)
	}
}

// TestGetMediaItemsUntypedKeepsBothTypesOnACollision covers the path the first
// version of this change wrongly assumed was safe. GetMediaItems only adds
// `m.type = $n` when filter.Type is non-empty (queries.go, `if filter.Type !=
// ""`), and GET /api/media with no type param is a real production call — the
// SPA's catalog-size count issues /api/media?per_page=1. So an untyped call
// reached the same unscoped dedup key, collapsing a colliding movie and show
// and undercounting total_items by one per collision.
func TestGetMediaItemsUntypedKeepsBothTypesOnACollision(t *testing.T) {
	q := requireIntegrationDB(t)
	p := newCollidingPair(t, q)

	// No Type on the filter: exactly what /api/media?per_page=1 produces.
	items, total, err := q.GetMediaItems(context.Background(),
		models.MediaFilter{Query: p.titleToken},
		models.PaginationParams{Page: 1, PerPage: 500},
	)
	if err != nil {
		t.Fatalf("GetMediaItems: %v", err)
	}

	var sawMovie, sawShow bool
	for _, it := range items {
		switch it.ID {
		case p.movieID:
			sawMovie = true
		case p.showID:
			sawShow = true
		}
	}
	if !sawMovie {
		t.Errorf("movie %d (tmdb_id %d) missing from an untyped GetMediaItems", p.movieID, p.tmdbID)
	}
	if !sawShow {
		t.Errorf("show %d (tmdb_id %d) missing from an untyped GetMediaItems — a movie sharing "+
			"that numeric TMDB id collapsed it out of the dedup CTE", p.showID, p.tmdbID)
	}
	// total_items reads the same CTE, so a collapsed collision undercounts it.
	// Scoped by titleToken, the fixture's exact expected count is 2.
	if total != 2 {
		t.Errorf("total_items = %d, want 2: the count reads the same dedup CTE, so a collapsed "+
			"collision undercounts the catalog", total)
	}
}

// TestGetMediaItemsTypedStillCollapsesSameTypeSiblings guards the typed path
// against over-narrowing: adding m.type to the key must not stop two copies of
// one movie collapsing into a single card.
func TestGetMediaItemsTypedStillCollapsesSameTypeSiblings(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	libA := seedTypedLibrary(t, q, ownerID, "movie")
	libB := seedTypedLibrary(t, q, ownerID, "movie")

	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)
	idA := seedTypedMediaItem(t, q, libA, "movie", tmdbID, token)
	idB := seedTypedMediaItem(t, q, libB, "movie", tmdbID, token)

	items, _, err := q.GetMediaItems(context.Background(),
		models.MediaFilter{Type: models.MediaMovie, Query: token},
		models.PaginationParams{Page: 1, PerPage: 500},
	)
	if err != nil {
		t.Fatalf("GetMediaItems: %v", err)
	}
	var seen int
	for _, it := range items {
		if it.ID == idA || it.ID == idB {
			seen++
		}
	}
	if seen != 1 {
		t.Errorf("saw %d of the two same-tmdb_id movie copies, want exactly 1 — cross-library "+
			"dedup must still collapse same-type siblings", seen)
	}
}

// TestDeduplicateByTMDBIDGroupsWithinAType covers the search path
// (/api/media/search and semantic search). Pre-fix the colliding movie and
// show were grouped together and one of them was unreachable from search.
func TestDeduplicateByTMDBIDGroupsWithinAType(t *testing.T) {
	q := requireIntegrationDB(t)
	p := newCollidingPair(t, q)

	in := []*models.MediaItem{
		{ID: p.movieID, Type: models.MediaMovie, Title: "colliding movie"},
		{ID: p.showID, Type: models.MediaShow, Title: "colliding show"},
	}
	out, err := q.DeduplicateByTMDBID(context.Background(), in)
	if err != nil {
		t.Fatalf("DeduplicateByTMDBID: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d items, want 2 — a movie and a show sharing one numeric TMDB id are "+
			"different titles and must not be deduplicated into each other (got %+v)", len(out), out)
	}

	seen := map[int64]bool{}
	for _, it := range out {
		seen[it.ID] = true
	}
	if !seen[p.movieID] || !seen[p.showID] {
		t.Errorf("both ids must survive dedup: movie %d present=%v, show %d present=%v",
			p.movieID, seen[p.movieID], p.showID, seen[p.showID])
	}
}

// TestDeduplicateByTMDBIDSlotReplacementIsTypeScoped reaches the second,
// subtler half of the same defect. The winner-replacement loop only runs for
// groups of two or more, so the plain colliding pair above never enters it: it
// needs a REAL same-type dedup group (two copies of one movie) plus a colliding
// show, with the show earlier in the slice. Matching the slot on the tmdb_id
// alone then overwrote the show's slot with the movie winner — dropping the
// show and leaving a movie duplicated.
func TestDeduplicateByTMDBIDSlotReplacementIsTypeScoped(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	movieLibA := seedTypedLibrary(t, q, ownerID, "movie")
	movieLibB := seedTypedLibrary(t, q, ownerID, "movie")
	showLib := seedTypedLibrary(t, q, ownerID, "show")

	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)
	movieA := seedTypedMediaItem(t, q, movieLibA, "movie", tmdbID, token)
	movieB := seedTypedMediaItem(t, q, movieLibB, "movie", tmdbID, token)
	showID := seedTypedMediaItem(t, q, showLib, "show", tmdbID, token)

	// The show is FIRST, so it occupies the result slot a tmdb_id-only match
	// would find before reaching either movie's slot.
	in := []*models.MediaItem{
		{ID: showID, Type: models.MediaShow, Title: "colliding show"},
		{ID: movieA, Type: models.MediaMovie, Title: "movie copy A"},
		{ID: movieB, Type: models.MediaMovie, Title: "movie copy B", Overview: "o", PosterPath: "p"},
	}
	out, err := q.DeduplicateByTMDBID(context.Background(), in)
	if err != nil {
		t.Fatalf("DeduplicateByTMDBID: %v", err)
	}

	// Expect exactly two survivors: the show, and the richer of the two movies.
	if len(out) != 2 {
		t.Fatalf("got %d items, want 2 (the show + one movie): %+v", len(out), out)
	}
	var sawShow, sawWinner bool
	for _, it := range out {
		if it.ID == showID {
			sawShow = true
		}
		if it.ID == movieB {
			sawWinner = true
		}
	}
	if !sawShow {
		t.Errorf("show %d was overwritten in the result by the movie group's winner — the slot "+
			"match must compare the full (tmdb_id, type) key, not the tmdb_id alone", showID)
	}
	if !sawWinner {
		t.Errorf("richer movie %d is not the surviving copy", movieB)
	}
}

// TestDeduplicateByTMDBIDStillCollapsesSameTypeSiblings is the other half of
// the contract: narrowing the key must NOT stop the dedup doing its actual job
// (the same movie in "Movies" and "4K Movies" is still one card).
func TestDeduplicateByTMDBIDStillCollapsesSameTypeSiblings(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	libA := seedTypedLibrary(t, q, ownerID, "movie")
	libB := seedTypedLibrary(t, q, ownerID, "movie")

	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)
	idA := seedTypedMediaItem(t, q, libA, "movie", tmdbID, token)
	idB := seedTypedMediaItem(t, q, libB, "movie", tmdbID, token)

	// idB carries richer metadata, so it must be the winner.
	in := []*models.MediaItem{
		{ID: idA, Type: models.MediaMovie, Title: "sparse copy"},
		{ID: idB, Type: models.MediaMovie, Title: "rich copy", Overview: "o", PosterPath: "p"},
	}
	out, err := q.DeduplicateByTMDBID(context.Background(), in)
	if err != nil {
		t.Fatalf("DeduplicateByTMDBID: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("got %d items, want 1 — two copies of the same movie across libraries must "+
			"still collapse (got %+v)", len(out), out)
	}
	if out[0].ID != idB {
		t.Errorf("dedup winner = %d, want %d (the richer copy)", out[0].ID, idB)
	}
}

// TestGetCrossLibraryFilesExcludesOtherTypes pins the sharpest edge: this is
// called for SHOW details from phase2_handlers.go, so pre-fix a colliding
// movie's media_files were presented as the show's own versions and the caller
// then derived has_4k from a movie's file.
func TestGetCrossLibraryFilesExcludesOtherTypes(t *testing.T) {
	q := requireIntegrationDB(t)
	p := newCollidingPair(t, q)

	// The movie has a file (entirely normal). The show is given one of its own so
	// this test cannot pass vacuously: asserting only "no movie file came back"
	// would also be satisfied by a mutation that made the function return
	// nothing at all.
	movieFileID := seedQualityFile(t, q, p.movieID, "4K", "smpte2084")
	showFileID := seedQualityFile(t, q, p.showID, "1080p", "")

	files, _, err := q.GetCrossLibraryFiles(context.Background(), p.showID)
	if err != nil {
		t.Fatalf("GetCrossLibraryFiles: %v", err)
	}
	var sawShowFile bool
	for _, f := range files {
		if f.MediaItemID == p.movieID || f.ID == movieFileID {
			t.Fatalf("GetCrossLibraryFiles(show %d) returned file %d belonging to movie %d "+
				"(tmdb_id %d) — sibling lookup must match on type as well as tmdb_id",
				p.showID, f.ID, p.movieID, p.tmdbID)
		}
		if f.ID == showFileID {
			sawShowFile = true
		}
	}
	if !sawShowFile {
		t.Errorf("the show's OWN file %d did not come back — the type predicate must exclude the "+
			"colliding movie without excluding the item itself", showFileID)
	}
}

// TestGetCrossLibraryFilesStillFindsSameTypeSiblings is the counterpart: the
// unified version selector across "Movies" and "4K Movies" must keep working.
func TestGetCrossLibraryFilesStillFindsSameTypeSiblings(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	libA := seedTypedLibrary(t, q, ownerID, "movie")
	libB := seedTypedLibrary(t, q, ownerID, "movie")

	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)
	idA := seedTypedMediaItem(t, q, libA, "movie", tmdbID, token)
	idB := seedTypedMediaItem(t, q, libB, "movie", tmdbID, token)
	seedQualityFile(t, q, idA, "1080p", "")
	siblingFile := seedQualityFile(t, q, idB, "4K", "")

	files, libNames, err := q.GetCrossLibraryFiles(context.Background(), idA)
	if err != nil {
		t.Fatalf("GetCrossLibraryFiles: %v", err)
	}
	var sawSibling bool
	for _, f := range files {
		if f.ID == siblingFile {
			sawSibling = true
		}
	}
	if !sawSibling {
		t.Errorf("cross-library sibling file %d missing for item %d — same-type linking regressed",
			siblingFile, idA)
	}
	if len(libNames) != len(files) {
		t.Errorf("library name annotation incomplete: %d names for %d files", len(libNames), len(files))
	}
}

// TestCrossLibraryBadgesDoNotLeakAcrossTypes covers the two badge-propagation
// queries, which are the most widely used of the set (browse, hero, discover,
// engagement and anchor rails all call the 4K one). A movie must not lend a
// colliding show its 4K or HDR badge.
func TestCrossLibraryBadgesDoNotLeakAcrossTypes(t *testing.T) {
	q := requireIntegrationDB(t)
	p := newCollidingPair(t, q)

	// The movie is 4K and HDR. The show has no files at all.
	seedQualityFile(t, q, p.movieID, "4K", "smpte2084")

	fourK, err := q.GetMediaItemsWith4KCrossLibrary(context.Background(), []int64{p.showID})
	if err != nil {
		t.Fatalf("GetMediaItemsWith4KCrossLibrary: %v", err)
	}
	if fourK[p.showID] {
		t.Errorf("show %d got has_4k from movie %d sharing tmdb_id %d — badge propagation must "+
			"match on type", p.showID, p.movieID, p.tmdbID)
	}

	hdr, err := q.GetMediaItemsWithHDRCrossLibrary(context.Background(), []int64{p.showID})
	if err != nil {
		t.Fatalf("GetMediaItemsWithHDRCrossLibrary: %v", err)
	}
	if hdr[p.showID] {
		t.Errorf("show %d got has_hdr from movie %d sharing tmdb_id %d — badge propagation must "+
			"match on type", p.showID, p.movieID, p.tmdbID)
	}
}

// TestCrossLibraryBadgesStillPropagateWithinAType is the counterpart, so the
// narrowing above cannot silently disable the feature: "Dune" in Movies with no
// 4K file must still show the badge when "Dune" in 4K Movies has one.
func TestCrossLibraryBadgesStillPropagateWithinAType(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	libA := seedTypedLibrary(t, q, ownerID, "movie")
	libB := seedTypedLibrary(t, q, ownerID, "movie")

	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)
	idA := seedTypedMediaItem(t, q, libA, "movie", tmdbID, token)
	idB := seedTypedMediaItem(t, q, libB, "movie", tmdbID, token)

	seedQualityFile(t, q, idA, "1080p", "")
	seedQualityFile(t, q, idB, "4K", "smpte2084")

	fourK, err := q.GetMediaItemsWith4KCrossLibrary(context.Background(), []int64{idA})
	if err != nil {
		t.Fatalf("GetMediaItemsWith4KCrossLibrary: %v", err)
	}
	if !fourK[idA] {
		t.Errorf("item %d lost its cross-library has_4k badge — same-type propagation regressed", idA)
	}

	hdr, err := q.GetMediaItemsWithHDRCrossLibrary(context.Background(), []int64{idA})
	if err != nil {
		t.Fatalf("GetMediaItemsWithHDRCrossLibrary: %v", err)
	}
	if !hdr[idA] {
		t.Errorf("item %d lost its cross-library has_hdr badge — same-type propagation regressed", idA)
	}
}

// ---------------------------------------------------------------------------
// The five remaining dedup keys: OnboardingGrid, OnboardingGridReactive,
// NearestUnwatched, NearestUnwatchedRich, PopularUnwatched.
//
// These share the same `DISTINCT ON (m.type, COALESCE(NULLIF(m.tmdb_id,0), -m.id))`
// key as the two above but need a richer fixture — a profile, plus rows that
// pass each query's eligibility filters (poster/backdrop, rating, embedding).
// Without these, reverting m.type out of queries_onboarding.go and
// queries_recommender.go left the whole suite green.
// ---------------------------------------------------------------------------

// seedTestProfile inserts a default sub-profile for a user. The recommender and
// onboarding queries are all profile-scoped, and a fresh profile has no
// watch_progress / taste_seeds / feedback / ratings / watchlist rows, which is
// exactly what their NOT EXISTS clauses require.
func seedTestProfile(t *testing.T, q *Queries, userID int64) int64 {
	t.Helper()
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO user_profiles (user_id, name, is_default)
		 VALUES ($1, $2, TRUE) RETURNING id`,
		userID, "xlib_prof_"+randomSuffix(t),
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM user_profiles WHERE id = $1`, id)
	})
	return id
}

// testVectorLit is a valid 768-dim pgvector literal. The queries under test
// order by cosine distance to it; the value only has to be non-degenerate (a
// zero vector makes cosine distance undefined), not meaningful.
func testVectorLit() string {
	parts := make([]string, 768)
	for i := range parts {
		parts[i] = "0.03125"
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// makeRailEligible gives a seeded item everything the onboarding and recommender
// queries filter on: a poster, a backdrop, a positive rating, and an embedding.
//
// ratingToken goes into content_rating so the caller can pass []string{token} as
// allowedRatings and scope an otherwise CATALOG-WIDE query to this fixture's own
// rows. That matters most for PopularUnwatched, whose only ordering key is the
// ascending dedup key (i.e. tmdb_id) with a LIMIT on top: uniqueTMDBID draws
// from a high band, so against a populated catalog the fixture sorts LAST and
// the LIMIT cuts it — a window the test does not own. All five queries share the
// same `($n::text[] IS NULL OR m.content_rating = ANY($n))` filter, so scoping
// this way tightens every one of them. content_rating is varchar(20) with no
// CHECK constraint and randomSuffix is 16 chars, so the token fits.
func makeRailEligible(t *testing.T, q *Queries, mediaItemID int64, ratingToken string) {
	t.Helper()
	_, err := q.pool.Exec(context.Background(),
		`UPDATE media_items
		    SET poster_path = '/p.jpg', backdrop_path = '/b.jpg',
		        rating = 7.5, popularity = 50, content_rating = $3,
		        embedding = $2::vector
		  WHERE id = $1`,
		mediaItemID, testVectorLit(), ratingToken,
	)
	if err != nil {
		t.Fatalf("make item %d rail-eligible: %v", mediaItemID, err)
	}
}

// railRunner names one of the five queries and returns the media_item ids it
// yields, so the leak and same-type assertions can be written once each.
type railRunner struct {
	name string
	run  func(t *testing.T, q *Queries, profileID int64, allowed []string) []int64
}

func railRunners() []railRunner {
	ids := func(items []*models.MediaItem) []int64 {
		out := make([]int64, 0, len(items))
		for _, it := range items {
			out = append(out, it.ID)
		}
		return out
	}
	return []railRunner{
		{"OnboardingGrid", func(t *testing.T, q *Queries, p int64, allowed []string) []int64 {
			got, err := q.OnboardingGrid(context.Background(), p, 500, 0, allowed)
			if err != nil {
				t.Fatalf("OnboardingGrid: %v", err)
			}
			return ids(got)
		}},
		{"OnboardingGridReactive", func(t *testing.T, q *Queries, p int64, allowed []string) []int64 {
			got, err := q.OnboardingGridReactive(context.Background(), p, testVectorLit(), 500, 0, allowed)
			if err != nil {
				t.Fatalf("OnboardingGridReactive: %v", err)
			}
			return ids(got)
		}},
		{"NearestUnwatched", func(t *testing.T, q *Queries, p int64, allowed []string) []int64 {
			got, err := q.NearestUnwatched(context.Background(), p, testVectorLit(), 500, allowed, "", 0, false)
			if err != nil {
				t.Fatalf("NearestUnwatched: %v", err)
			}
			return ids(got)
		}},
		{"NearestUnwatchedRich", func(t *testing.T, q *Queries, p int64, allowed []string) []int64 {
			got, err := q.NearestUnwatchedRich(context.Background(), p, testVectorLit(), 500, allowed)
			if err != nil {
				t.Fatalf("NearestUnwatchedRich: %v", err)
			}
			out := make([]int64, 0, len(got))
			for _, c := range got {
				if c.Item != nil {
					out = append(out, c.Item.ID)
				}
			}
			return out
		}},
		{"PopularUnwatched", func(t *testing.T, q *Queries, p int64, allowed []string) []int64 {
			got, err := q.PopularUnwatched(context.Background(), p, 500, allowed)
			if err != nil {
				t.Fatalf("PopularUnwatched: %v", err)
			}
			return ids(got)
		}},
	}
}

// TestRailQueriesKeepBothTypesOnATMDBIDCollision is the leak test for all five.
func TestRailQueriesKeepBothTypesOnATMDBIDCollision(t *testing.T) {
	q := requireIntegrationDB(t)
	p := newCollidingPair(t, q)
	profileID := seedTestProfile(t, q, seedTestUser(t, q))
	ratingToken := randomSuffix(t)
	makeRailEligible(t, q, p.movieID, ratingToken)
	makeRailEligible(t, q, p.showID, ratingToken)

	for _, r := range railRunners() {
		t.Run(r.name, func(t *testing.T) {
			got := r.run(t, q, profileID, []string{ratingToken})
			var sawMovie, sawShow bool
			for _, id := range got {
				switch id {
				case p.movieID:
					sawMovie = true
				case p.showID:
					sawShow = true
				}
			}
			if !sawMovie {
				t.Errorf("%s dropped movie %d (tmdb_id %d)", r.name, p.movieID, p.tmdbID)
			}
			if !sawShow {
				t.Errorf("%s dropped show %d (tmdb_id %d) — a movie sharing that numeric TMDB id "+
					"collapsed it out of the dedup key, which must include m.type",
					r.name, p.showID, p.tmdbID)
			}
		})
	}
}

// TestRailQueriesStillCollapseSameTypeSiblings is the counterpart: narrowing the
// key must not disable cross-library dedup for genuine same-type duplicates.
func TestRailQueriesStillCollapseSameTypeSiblings(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	profileID := seedTestProfile(t, q, ownerID)
	libA := seedTypedLibrary(t, q, ownerID, "movie")
	libB := seedTypedLibrary(t, q, ownerID, "movie")

	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)
	idA := seedTypedMediaItem(t, q, libA, "movie", tmdbID, token)
	idB := seedTypedMediaItem(t, q, libB, "movie", tmdbID, token)
	ratingToken := randomSuffix(t)
	makeRailEligible(t, q, idA, ratingToken)
	makeRailEligible(t, q, idB, ratingToken)

	for _, r := range railRunners() {
		t.Run(r.name, func(t *testing.T) {
			got := r.run(t, q, profileID, []string{ratingToken})
			var seen int
			for _, id := range got {
				if id == idA || id == idB {
					seen++
				}
			}
			if seen != 1 {
				t.Errorf("%s returned %d of two same-tmdb_id movie copies, want exactly 1 — "+
					"cross-library dedup must still collapse same-type siblings", r.name, seen)
			}
		})
	}
}

// TestPopularUnwatchedOrderingSurvivesTheCTERestructure pins the ordering
// contract of the one query whose STRUCTURE changed. Moving its dedup into a CTE
// meant re-establishing the ordering in an outer ORDER BY, and without this test
// that clause could be deleted outright — undoing the point of the restructure —
// with the suite still green.
//
// The fixture defeats every way this can silently go wrong. Each key of
// `ORDER BY dedup_key, rating DESC, id` is pinned by a case whose expected order
// differs from what dropping that key would produce:
//
//   - dedup_key: rows are seeded in DESCENDING key order, so media_items.id order
//     is the reverse of the expected order and `ORDER BY id` cannot pass.
//   - rating DESC: on the middle key, shared by a colliding movie/show pair, the
//     SHOW is rated higher. The CTE's inner ordering is `m.type, ...` so it emits
//     the movie first; ordering on dedup_key alone leaves the movie first.
//   - id: on the top key, a second colliding pair is rated EQUALLY, so only the
//     id tie-break separates them — and the show is seeded first, giving it the
//     lower id, against the inner ordering's movie-first. Round 2's finding was
//     exactly that which of a colliding pair survives the LIMIT must not be
//     plan-dependent; a pair tied on (dedup_key, rating) is where that recurs.
//
// The query is catalog-wide, so the fixture scopes it with a unique
// content_rating token and asserts on the relative order of its own rows.
func TestPopularUnwatchedOrderingSurvivesTheCTERestructure(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	profileID := seedTestProfile(t, q, ownerID)
	movieLib := seedTypedLibrary(t, q, ownerID, "movie")
	showLib := seedTypedLibrary(t, q, ownerID, "show")
	token := randomSuffix(t)
	ratingToken := randomSuffix(t)

	keys := []int{uniqueTMDBID(t), uniqueTMDBID(t), uniqueTMDBID(t)}
	sort.Ints(keys)
	lowKey, midKey, highKey := keys[0], keys[1], keys[2]

	// Seed order is deliberately the near-reverse of the expected order, and
	// within the top key the show comes first so it holds the lower id.
	equalShow := seedTypedMediaItem(t, q, showLib, "show", highKey, token)
	equalMovie := seedTypedMediaItem(t, q, movieLib, "movie", highKey, token)
	tiedMovie := seedTypedMediaItem(t, q, movieLib, "movie", midKey, token)
	tiedShow := seedTypedMediaItem(t, q, showLib, "show", midKey, token)
	first := seedTypedMediaItem(t, q, movieLib, "movie", lowKey, token)

	all := []int64{equalShow, equalMovie, tiedMovie, tiedShow, first}
	for _, id := range all {
		makeRailEligible(t, q, id, ratingToken)
	}
	// makeRailEligible sets 7.5 everywhere, so the top pair is already tied.
	// Split only the middle pair, with the SHOW ahead.
	for id, rating := range map[int64]string{tiedShow: "9.5", tiedMovie: "4.5"} {
		if _, err := q.pool.Exec(context.Background(),
			`UPDATE media_items SET rating = $2::numeric WHERE id = $1`, id, rating); err != nil {
			t.Fatalf("set rating on %d: %v", id, err)
		}
	}
	if equalShow >= equalMovie {
		t.Fatalf("fixture assumption broken: expected the show (%d) to hold a lower id than the "+
			"movie (%d) on the shared top key", equalShow, equalMovie)
	}

	got, err := q.PopularUnwatched(context.Background(), profileID, 500, []string{ratingToken})
	if err != nil {
		t.Fatalf("PopularUnwatched: %v", err)
	}

	mine := map[int64]bool{}
	for _, id := range all {
		mine[id] = true
	}
	var order []int64
	for _, it := range got {
		if mine[it.ID] {
			order = append(order, it.ID)
		}
	}
	want := []int64{first, tiedShow, tiedMovie, equalShow, equalMovie}
	if len(order) != len(want) {
		t.Fatalf("got %d of the fixture's %d rows (%v), want all of them — none should be "+
			"deduped away", len(order), len(want), order)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("relative order = %v, want %v.\n"+
				"  dedup_key ASC, then rating DESC (show %d @9.5 before movie %d @4.5), "+
				"then id ASC (show %d before movie %d, both @7.5 on one key).\n"+
				"  Seed order by id was %v — matching that instead means the outer ORDER BY was lost.",
				order, want, tiedShow, tiedMovie, equalShow, equalMovie, all)
		}
	}
}

// TestSameLibraryDuplicateCheckIsTypeScoped covers the one site in this change
// that is not a dedup key: the same-library TMDB duplicate check in
// UpdateMediaMetadata, whose result raises DuplicateMetadataError and so gates a
// catalog MERGE — the path CLAUDE.md calls the most dangerous code in this repo.
//
// The predicate is redundant in normal operation, because media_items.type is
// written once from the library's own type and never updated, so a single
// library cannot hold both a movie and a show. The fixture therefore constructs
// that state directly in SQL: it is the ONLY state in which the predicate can
// matter, and the point of the change is that nothing in the schema prevents it.
func TestSameLibraryDuplicateCheckIsTypeScoped(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	lib := seedTypedLibrary(t, q, ownerID, "movie")
	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)

	// Two rows in ONE library sharing a tmdb_id but of different types. Seeded
	// with the id already set, since the check reads the row's stored tmdb_id.
	movieID := seedTypedMediaItem(t, q, lib, "movie", tmdbID, token)
	showID := seedTypedMediaItem(t, q, lib, "show", tmdbID, token)

	// Re-running metadata for the movie must NOT report the show as its
	// duplicate: a shared numeric TMDB id across types is not the same title.
	err := q.UpdateMediaMetadata(context.Background(), &models.MetadataUpdate{
		MediaItemID: movieID,
		TMDBID:      &tmdbID,
	})
	var dup *DuplicateMetadataError
	if errors.As(err, &dup) {
		t.Fatalf("UpdateMediaMetadata(movie %d) reported show %d as a same-library duplicate "+
			"(constraint %q) — TMDB's movie and TV id spaces are independent, so this would "+
			"merge two unrelated titles", movieID, showID, dup.Constraint)
	}
	if err != nil {
		t.Fatalf("UpdateMediaMetadata: %v", err)
	}
}

// TestSameLibraryDuplicateCheckStillCatchesSameType is the counterpart: the
// added predicate must not stop the check doing its job, which is to catch two
// rows in one library that really are the same title (e.g. "The Avengers" and
// "Avengers" both resolving to one TMDB id).
func TestSameLibraryDuplicateCheckStillCatchesSameType(t *testing.T) {
	q := requireIntegrationDB(t)
	ownerID := seedTestUser(t, q)
	lib := seedTypedLibrary(t, q, ownerID, "movie")
	tmdbID := uniqueTMDBID(t)
	token := randomSuffix(t)

	canonical := seedTypedMediaItem(t, q, lib, "movie", tmdbID, token)
	duplicate := seedTypedMediaItem(t, q, lib, "movie", tmdbID, token)

	err := q.UpdateMediaMetadata(context.Background(), &models.MetadataUpdate{
		MediaItemID: duplicate,
		TMDBID:      &tmdbID,
	})
	var dup *DuplicateMetadataError
	if !errors.As(err, &dup) {
		t.Fatalf("UpdateMediaMetadata(movie %d) did not report same-library duplicate %d "+
			"(err = %v) — the type predicate must not disable same-type detection",
			duplicate, canonical, err)
	}
	if dup.CanonicalID != canonical {
		t.Errorf("canonical = %d, want %d (the lower id)", dup.CanonicalID, canonical)
	}
}
