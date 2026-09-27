package db

// Regression tests for the NULL-column scan defect class found while fixing
// issue #510.
//
// media_items, media_files, episode_files and requests all declare columns
// NULLABLE that the Go structs they are scanned into declare as plain
// int/string/float64 (models.MediaItem, models.MediaFile, models.EpisodeFile,
// models.ContinueWatchingItem, models.WatchlistItem, models.Request). pgx
// refuses that scan outright — "cannot scan NULL into *int" — and because the
// failure happens mid-iteration it fails the WHOLE query, not one row. A single
// NULL anywhere in the catalog therefore takes out an entire endpoint: one such
// row turned /api/media/recent into a 500 for every user, and made
// Enricher.RefreshStaleMetadata return an error having enriched nothing (its
// query sorts un-enriched rows first, so the state was self-sustaining and
// silently disabled metadata refresh for the whole catalog).
//
// No application write path produces these NULLs — UpsertMediaItem inserts the
// Go zero values and UpdateMediaMetadata only sets fields it has values for.
// They arrive via hand-written catalog SQL, which this repo's own runbooks
// prescribe (docs/moving-media-paths.md) and which is how #510 was remediated
// in production. So this is latent robustness with a real trigger.
//
// The fix is in the SQL, not the structs: COALESCE to the zero values the
// codebase already uses as "unknown" sentinels (`json:"...,omitempty"` on all
// five media_items columns, `nilIfZero` on the enricher's year write-back,
// "0 = unknown" / "Empty = unknown" on the MediaFile colour and fps fields).
// Making the struct fields pointers would touch a very large number of call
// sites for no gain.
//
// Opt-in integration: set TEST_DATABASE_URL=postgres://... to run. Reuses
// requireIntegrationDB / randomSuffix / seedTestUser from
// queries_jsonb_integration_test.go.
//
// !! A NULL ROW IN THIS SHARED DATABASE IS VISIBLE TO EVERY OTHER PACKAGE. !!
// `go test ./...` runs packages CONCURRENTLY against one database, and the
// queries under test here are catalog-wide (GetRecentMedia takes no library,
// type or file filter at all). A fixture that leaks a NULL row does not fail
// this package — it fails whichever unrelated package happens to read the
// catalog next, which is exactly how the GetRecentMedia instance was found.
// Every helper below therefore registers a t.Cleanup that deletes its own row,
// and insertShow/insertMovie NULL only the columns the test is about.

import (
	"context"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// nullProbeLibrary seeds a library to hang NULL-column fixtures off.
func nullProbeLibrary(t *testing.T, q *Queries, ownerID int64, libType string) int64 {
	t.Helper()
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO libraries (name, type, paths, owner_id)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		"nullcol_test_"+randomSuffix(t), libType,
		[]string{"/tmp/nullcol_test"}, ownerID,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed %s library: %v", libType, err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM libraries WHERE id = $1`, id)
	})
	return id
}

// insertShow inserts a media_items row with EVERY nullable column this defect
// class covers left NULL — the shape a hand-written catalog UPDATE/INSERT
// leaves behind, and the shape no application write path produces.
//
// It returns the new row's id and the unique title token, so a catalog-wide
// query can be scoped to this fixture rather than asserted against the whole
// database.
//
// The t.Cleanup delete is load-bearing, not tidiness: see the note at the top
// of this file. Leaving the row behind breaks OTHER packages, not this one.
func insertShow(t *testing.T, q *Queries, libraryID int64) (int64, string) {
	t.Helper()
	return insertNullColumnItem(t, q, libraryID, "show")
}

func insertMovie(t *testing.T, q *Queries, libraryID int64) (int64, string) {
	t.Helper()
	return insertNullColumnItem(t, q, libraryID, "movie")
}

func insertNullColumnItem(t *testing.T, q *Queries, libraryID int64, itemType string) (int64, string) {
	t.Helper()
	token := "NullProbe" + randomSuffix(t)
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO media_items
		   (library_id, type, title, sort_title,
		    year, overview, rating, runtime_minutes, content_rating)
		 VALUES ($1, $2, $3, $3, NULL, NULL, NULL, NULL, NULL) RETURNING id`,
		libraryID, itemType, token,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed all-NULL %s media item: %v", itemType, err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM media_items WHERE id = $1`, id)
	})
	return id, token
}

// assertUnknownSentinels pins the OTHER half of the contract: the fix must not
// merely stop erroring, it must produce the zero values the rest of the
// codebase already reads as "unknown". `omitempty` on all five JSON tags means
// these are the values that make the field vanish from the API response, which
// is what the SPA and the enricher's nilIfZero write-back both assume.
func assertUnknownSentinels(t *testing.T, where string, m *models.MediaItem) {
	t.Helper()
	if m.Year != 0 {
		t.Errorf("%s: Year = %d, want 0 (the unknown sentinel)", where, m.Year)
	}
	if m.Overview != "" {
		t.Errorf("%s: Overview = %q, want \"\"", where, m.Overview)
	}
	if m.Rating != 0 {
		t.Errorf("%s: Rating = %v, want 0", where, m.Rating)
	}
	if m.RuntimeMin != 0 {
		t.Errorf("%s: RuntimeMin = %d, want 0", where, m.RuntimeMin)
	}
	if m.ContentRating != "" {
		t.Errorf("%s: ContentRating = %q, want \"\"", where, m.ContentRating)
	}
}

// TestGetRecentMediaSurvivesNullColumns is the user-facing instance. The query
// reads every media_items row with no library, type or file filter and backs
// the "Recently Added" rail, so one NULL row anywhere in the catalog turned
// /api/media/recent into a 500 for every user.
func TestGetRecentMediaSurvivesNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	owner := seedTestUser(t, q)
	lib := nullProbeLibrary(t, q, owner, "show")
	id, _ := insertShow(t, q, lib)

	items, err := q.GetRecentMedia(context.Background(), 500)
	if err != nil {
		t.Fatalf("GetRecentMedia with a NULL-column row present: %v", err)
	}
	found := false
	for _, it := range items {
		if it.ID == id {
			found = true
			assertUnknownSentinels(t, "GetRecentMedia", it)
		}
	}
	if !found {
		// Not a pass: the row is the newest in the catalog and the limit is
		// generous, so its absence means the query silently dropped it.
		t.Errorf("the NULL-column row (id %d) is missing from GetRecentMedia's %d results", id, len(items))
	}
}

// TestGetStaleMetadataItemsSurvivesNullColumns is the enrichment instance. One
// NULL row made Enricher.RefreshStaleMetadata return an error having enriched
// NOTHING, and because un-enriched rows (last_metadata IS NULL) sort FIRST in
// this query, the row that broke it was always in the first page — so the
// state was self-sustaining.
func TestGetStaleMetadataItemsSurvivesNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	owner := seedTestUser(t, q)
	lib := nullProbeLibrary(t, q, owner, "show")
	id, _ := insertShow(t, q, lib)

	items, err := q.GetStaleMetadataItems(context.Background(), time.Nanosecond)
	if err != nil {
		t.Fatalf("GetStaleMetadataItems with a NULL-column row present: %v", err)
	}
	// Presence is asserted, not assumed. The query is LIMIT 100 over a catalog
	// shared with concurrently-running packages, and the fixture's NULL
	// last_metadata puts it in the NULLS FIRST group where ties break
	// arbitrarily — so on a populated database it CAN fall off the page, and
	// then both halves of this test are vacuous: the error half too, because
	// the query only fails if a NULL row is actually in the page. A skip that
	// looks like a pass is the failure mode this whole file exists to avoid,
	// so make it loud instead.
	for _, it := range items {
		if it.ID == id {
			assertUnknownSentinels(t, "GetStaleMetadataItems", &it.MediaItem)
			return
		}
	}
	t.Errorf("the NULL-column row (id %d) is missing from GetStaleMetadataItems' %d "+
		"results, so this case proved nothing; it sorts into the NULLS FIRST group "+
		"and was pushed off the LIMIT 100 page", id, len(items))
}

// TestGetMediaItemsSurvivesNullColumns covers the paginated catalog query
// behind GET /api/media. It is scoped to the fixture by title token, because
// the query is catalog-wide and paginated and a concurrently-seeded row could
// otherwise push the fixture off the first page.
func TestGetMediaItemsSurvivesNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	owner := seedTestUser(t, q)
	lib := nullProbeLibrary(t, q, owner, "movie")
	id, token := insertMovie(t, q, lib)

	items, total, err := q.GetMediaItems(context.Background(),
		models.MediaFilter{Query: token},
		models.PaginationParams{Page: 1, PerPage: 50},
	)
	if err != nil {
		t.Fatalf("GetMediaItems with a NULL-column row present: %v", err)
	}
	if total == 0 || len(items) == 0 {
		t.Fatalf("GetMediaItems returned nothing for token %q (total=%d)", token, total)
	}
	for _, it := range items {
		if it.ID == id {
			assertUnknownSentinels(t, "GetMediaItems", it)
			return
		}
	}
	t.Errorf("the NULL-column row (id %d) is missing from GetMediaItems' %d results", id, len(items))
}

// TestSingleItemReadsSurviveNullColumns covers the three single-row reads.
// FindMediaItemByTitle is called by the scanner's TV pre-check on every scan,
// so a NULL year there is not a read-path inconvenience: it makes the upsert
// re-key the item (see CLAUDE.md's withdrawn-repointing notes).
func TestSingleItemReadsSurviveNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	owner := seedTestUser(t, q)
	lib := nullProbeLibrary(t, q, owner, "movie")
	id, token := insertMovie(t, q, lib)
	ctx := context.Background()

	item, err := q.GetMediaItem(ctx, id)
	if err != nil {
		t.Fatalf("GetMediaItem: %v", err)
	}
	if item == nil {
		t.Fatal("GetMediaItem returned no row for the fixture")
	}
	assertUnknownSentinels(t, "GetMediaItem", item)

	byTitle, err := q.FindMediaItemByTitle(ctx, lib, "movie", token)
	if err != nil {
		t.Fatalf("FindMediaItemByTitle: %v", err)
	}
	if byTitle == nil {
		t.Fatal("FindMediaItemByTitle returned no row for the fixture")
	}
	assertUnknownSentinels(t, "FindMediaItemByTitle", byTitle)

	enriched, err := q.GetMediaItemEnriched(ctx, id)
	if err != nil {
		t.Fatalf("GetMediaItemEnriched: %v", err)
	}
	if enriched == nil || enriched.MediaItem == nil {
		t.Fatal("GetMediaItemEnriched returned no row for the fixture")
	}
	assertUnknownSentinels(t, "GetMediaItemEnriched", enriched.MediaItem)
}

// TestSearchMediaSurvivesNullColumns covers GET /api/media/search. The query's
// own WHERE clause reads `overview`, which made it look as though it excluded
// NULL rows — it does not: the title predicate alone matches them.
func TestSearchMediaSurvivesNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	owner := seedTestUser(t, q)
	lib := nullProbeLibrary(t, q, owner, "movie")
	id, token := insertMovie(t, q, lib)

	items, err := q.SearchMedia(context.Background(), token, 50)
	if err != nil {
		t.Fatalf("SearchMedia with a NULL-column row present: %v", err)
	}
	for _, it := range items {
		if it.ID == id {
			assertUnknownSentinels(t, "SearchMedia", it)
			return
		}
	}
	t.Errorf("the NULL-column row (id %d) is missing from SearchMedia's %d results for %q", id, len(items), token)
}

// TestGetItemsNeedingReviewSurvivesNullColumns covers the admin match-review
// queue. Its sibling GetFlaggedWithoutAISuggestion — same table, same
// match_status predicate — already COALESCEd; this one did not.
func TestGetItemsNeedingReviewSurvivesNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	owner := seedTestUser(t, q)
	lib := nullProbeLibrary(t, q, owner, "movie")
	id, _ := insertMovie(t, q, lib)
	if _, err := q.pool.Exec(context.Background(),
		`UPDATE media_items SET match_status = 'needs_review' WHERE id = $1`, id); err != nil {
		t.Fatalf("flag fixture for review: %v", err)
	}

	items, err := q.GetItemsNeedingReview(context.Background())
	if err != nil {
		t.Fatalf("GetItemsNeedingReview with a NULL-column row present: %v", err)
	}
	for _, it := range items {
		if it.ID == id {
			assertUnknownSentinels(t, "GetItemsNeedingReview", it)
			return
		}
	}
	t.Errorf("the flagged NULL-column row (id %d) is missing from GetItemsNeedingReview's %d results", id, len(items))
}

// seedNullProbeProfile returns a default sub-profile for the user.
func seedNullProbeProfile(t *testing.T, q *Queries, userID int64) int64 {
	t.Helper()
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO user_profiles (user_id, name, is_default)
		 VALUES ($1, $2, TRUE) RETURNING id`, userID, "nullcol_"+randomSuffix(t),
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM user_profiles WHERE id = $1`, id)
	})
	return id
}

// TestContinueWatchingSurvivesNullYear covers the four watch_progress read
// paths. All four already COALESCEd `rating` and left `mi.year` raw, and
// ContinueWatchingItem.Year is a plain int — so a NULL-year title in one
// viewer's history 500s their Continue Watching rail and their whole history
// page, while everyone else's works.
func TestContinueWatchingSurvivesNullYear(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	profile := seedNullProbeProfile(t, q, owner)
	lib := nullProbeLibrary(t, q, owner, "movie")
	itemID, _ := insertMovie(t, q, lib)

	if _, err := q.pool.Exec(ctx,
		`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed)
		 VALUES ($1, $2, $3, 1000, 5000, FALSE)`, owner, profile, itemID); err != nil {
		t.Fatalf("seed watch progress: %v", err)
	}

	check := func(name string, items []models.ContinueWatchingItem, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s with a NULL-year row present: %v", name, err)
		}
		for _, it := range items {
			if it.MediaItemID == itemID {
				if it.Year != 0 {
					t.Errorf("%s: Year = %d, want 0 (the unknown sentinel)", name, it.Year)
				}
				return
			}
		}
		t.Errorf("%s: the NULL-year row (media_item %d) is missing from %d results", name, itemID, len(items))
	}

	cw, err := q.GetContinueWatching(ctx, owner, 50)
	check("GetContinueWatching", cw, err)

	cwp, err := q.GetContinueWatchingByProfile(ctx, profile, 50)
	check("GetContinueWatchingByProfile", cwp, err)

	rw, err := q.GetRecentlyWatched(ctx, owner, 50)
	check("GetRecentlyWatched", rw, err)

	hist, _, err := q.GetWatchHistory(ctx, owner, models.PaginationParams{Page: 1, PerPage: 50})
	check("GetWatchHistory", hist, err)
}

// TestWatchlistItemsSurvivesNullYear covers the two watchlist reads, which
// scan mi.year raw into models.WatchlistItem.Year (a plain int).
func TestWatchlistItemsSurvivesNullYear(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	profile := seedNullProbeProfile(t, q, owner)
	lib := nullProbeLibrary(t, q, owner, "movie")
	itemID, _ := insertMovie(t, q, lib)

	var listID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO watchlists (profile_id, name) VALUES ($1, $2) RETURNING id`,
		profile, "nullcol_"+randomSuffix(t),
	).Scan(&listID); err != nil {
		t.Fatalf("seed watchlist: %v", err)
	}
	if _, err := q.pool.Exec(ctx,
		`INSERT INTO watchlist_items (watchlist_id, media_item_id) VALUES ($1, $2)`,
		listID, itemID); err != nil {
		t.Fatalf("seed watchlist item: %v", err)
	}

	check := func(name string, items []*models.WatchlistItem, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s with a NULL-year row present: %v", name, err)
		}
		for _, it := range items {
			if it.MediaItemID == itemID {
				if it.Year != 0 {
					t.Errorf("%s: Year = %d, want 0", name, it.Year)
				}
				return
			}
		}
		t.Errorf("%s: the NULL-year row (media_item %d) is missing from %d results", name, itemID, len(items))
	}

	all, err := q.GetAllWatchlistItems(ctx, listID)
	check("GetAllWatchlistItems", all, err)

	paged, _, err := q.GetWatchlistItems(ctx, listID, models.PaginationParams{Page: 1, PerPage: 50})
	check("GetWatchlistItems", paged, err)
}

// TestMediaFileReadsSurviveNullColumns covers the same defect on media_files.
// container/video_codec/audio_codec/resolution/bitrate/duration_ms are all
// nullable and all scanned into non-nullable models.MediaFile fields, whose own
// doc comments already name the zero values as the unknown sentinels.
//
// The fixture carries a tmdb_id because GetCrossLibraryFiles returns early
// when the item has none — without it that path reports a false pass, having
// never reached the scan.
func TestMediaFileReadsSurviveNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	lib := nullProbeLibrary(t, q, owner, "movie")
	itemID, token := insertMovie(t, q, lib)
	tmdbID := uniqueTMDBID(t)
	if _, err := q.pool.Exec(ctx,
		`UPDATE media_items SET tmdb_id = $2 WHERE id = $1`, itemID, tmdbID); err != nil {
		t.Fatalf("set fixture tmdb_id: %v", err)
	}

	path := "/tmp/nullcol_test/" + token + ".mkv"
	var fileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO media_files
		   (media_item_id, path, size_bytes, container, video_codec, audio_codec,
		    resolution, bitrate, duration_ms, file_hash)
		 VALUES ($1, $2, 1, NULL, NULL, NULL, NULL, NULL, NULL, $3) RETURNING id`,
		itemID, path, "nullcol"+randomSuffix(t),
	).Scan(&fileID); err != nil {
		t.Fatalf("seed all-NULL media file: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM media_files WHERE id = $1`, fileID)
	})

	assertFileSentinels := func(name string, f *models.MediaFile) {
		t.Helper()
		if f.Container != "" || f.VideoCodec != "" || f.AudioCodec != "" || f.Resolution != "" {
			t.Errorf("%s: want empty codec/container/resolution, got %q/%q/%q/%q",
				name, f.Container, f.VideoCodec, f.AudioCodec, f.Resolution)
		}
		if f.Bitrate != 0 || f.DurationMs != 0 {
			t.Errorf("%s: want 0 bitrate/duration, got %d/%d", name, f.Bitrate, f.DurationMs)
		}
	}

	files, err := q.GetMediaFiles(ctx, itemID)
	if err != nil {
		t.Fatalf("GetMediaFiles with a NULL-column file present: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("GetMediaFiles returned %d files, want 1", len(files))
	}
	assertFileSentinels("GetMediaFiles", files[0])

	byPath, err := q.GetMediaFileByPath(ctx, path)
	if err != nil {
		t.Fatalf("GetMediaFileByPath: %v", err)
	}
	if byPath == nil {
		t.Fatal("GetMediaFileByPath returned no row")
	}
	assertFileSentinels("GetMediaFileByPath", byPath)

	byID, err := q.GetMediaFileByID(ctx, fileID)
	if err != nil {
		t.Fatalf("GetMediaFileByID: %v", err)
	}
	if byID == nil {
		t.Fatal("GetMediaFileByID returned no row")
	}
	assertFileSentinels("GetMediaFileByID", byID)

	xlib, _, err := q.GetCrossLibraryFiles(ctx, itemID)
	if err != nil {
		t.Fatalf("GetCrossLibraryFiles: %v", err)
	}
	if len(xlib) == 0 {
		t.Fatal("GetCrossLibraryFiles returned nothing — the scan was never reached, " +
			"so this case proves nothing; check the fixture's tmdb_id")
	}
	foundFixture := false
	for _, f := range xlib {
		if f.ID == fileID {
			foundFixture = true
			assertFileSentinels("GetCrossLibraryFiles", f)
		}
	}
	if !foundFixture {
		t.Errorf("GetCrossLibraryFiles returned %d files but none was the fixture (id %d), "+
			"so the sentinel assertions never ran", len(xlib), fileID)
	}
}

// TestEpisodeFileReadsSurviveNullColumns is the episode_files counterpart.
func TestEpisodeFileReadsSurviveNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	lib := nullProbeLibrary(t, q, owner, "show")
	showID, token := insertShow(t, q, lib)
	tmdbID := uniqueTMDBID(t)
	if _, err := q.pool.Exec(ctx,
		`UPDATE media_items SET tmdb_id = $2 WHERE id = $1`, showID, tmdbID); err != nil {
		t.Fatalf("set fixture tmdb_id: %v", err)
	}

	var seasonID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_seasons (media_item_id, season_number, title, overview)
		 VALUES ($1, 1, NULL, NULL) RETURNING id`, showID).Scan(&seasonID); err != nil {
		t.Fatalf("seed season: %v", err)
	}
	var episodeID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO tv_episodes
		   (season_id, media_item_id, episode_number, title, overview, runtime_minutes,
		    air_date, tmdb_id, still_path, vote_average, vote_count)
		 VALUES ($1, $2, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL) RETURNING id`,
		seasonID, showID).Scan(&episodeID); err != nil {
		t.Fatalf("seed episode: %v", err)
	}

	path := "/tmp/nullcol_test/" + token + ".s01e01.mkv"
	var fileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO episode_files
		   (episode_id, path, size_bytes, container, video_codec, audio_codec,
		    resolution, bitrate, duration_ms, file_hash)
		 VALUES ($1, $2, 1, NULL, NULL, NULL, NULL, NULL, NULL, $3) RETURNING id`,
		episodeID, path, "nullcol"+randomSuffix(t),
	).Scan(&fileID); err != nil {
		t.Fatalf("seed all-NULL episode file: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM episode_files WHERE id = $1`, fileID)
	})

	assertFileSentinels := func(name string, f *models.EpisodeFile) {
		t.Helper()
		if f.Container != "" || f.VideoCodec != "" || f.AudioCodec != "" || f.Resolution != "" {
			t.Errorf("%s: want empty codec/container/resolution, got %q/%q/%q/%q",
				name, f.Container, f.VideoCodec, f.AudioCodec, f.Resolution)
		}
		if f.Bitrate != 0 || f.DurationMs != 0 {
			t.Errorf("%s: want 0 bitrate/duration, got %d/%d", name, f.Bitrate, f.DurationMs)
		}
	}

	// GetSeasons / GetEpisodes already COALESCEd their own nullable columns;
	// asserted here so the episode fixture's own NULLs stay covered too.
	if _, err := q.GetSeasons(ctx, showID); err != nil {
		t.Fatalf("GetSeasons with NULL season columns: %v", err)
	}
	if _, err := q.GetEpisodes(ctx, showID, 1); err != nil {
		t.Fatalf("GetEpisodes with NULL episode columns: %v", err)
	}

	files, err := q.GetEpisodeFiles(ctx, episodeID)
	if err != nil {
		t.Fatalf("GetEpisodeFiles with a NULL-column file present: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("GetEpisodeFiles returned %d files, want 1", len(files))
	}
	assertFileSentinels("GetEpisodeFiles", files[0])

	byPath, err := q.GetEpisodeFileByPath(ctx, path)
	if err != nil {
		t.Fatalf("GetEpisodeFileByPath: %v", err)
	}
	if byPath == nil {
		t.Fatal("GetEpisodeFileByPath returned no row")
	}
	assertFileSentinels("GetEpisodeFileByPath", byPath)

	byID, err := q.GetEpisodeFileByID(ctx, fileID)
	if err != nil {
		t.Fatalf("GetEpisodeFileByID: %v", err)
	}
	if byID == nil {
		t.Fatal("GetEpisodeFileByID returned no row")
	}
	assertFileSentinels("GetEpisodeFileByID", byID)

	xlib, _, err := q.GetCrossLibraryEpisodeFiles(ctx, episodeID, tmdbID)
	if err != nil {
		t.Fatalf("GetCrossLibraryEpisodeFiles: %v", err)
	}
	if len(xlib) == 0 {
		t.Fatal("GetCrossLibraryEpisodeFiles returned nothing — the scan was never " +
			"reached, so this case proves nothing")
	}
	foundFixture := false
	for _, f := range xlib {
		if f.ID == fileID {
			foundFixture = true
			assertFileSentinels("GetCrossLibraryEpisodeFiles", f)
		}
	}
	if !foundFixture {
		t.Errorf("GetCrossLibraryEpisodeFiles returned %d files but none was the fixture (id %d), "+
			"so the sentinel assertions never ran", len(xlib), fileID)
	}

	batch, _, err := q.GetCrossLibraryEpisodeFilesBatch(ctx, []int64{episodeID}, tmdbID)
	if err != nil {
		t.Fatalf("GetCrossLibraryEpisodeFilesBatch: %v", err)
	}
	if len(batch[episodeID]) == 0 {
		t.Fatal("GetCrossLibraryEpisodeFilesBatch returned nothing for the fixture " +
			"episode — the scan was never reached, so this case proves nothing")
	}
	foundInBatch := false
	for _, f := range batch[episodeID] {
		if f.ID == fileID {
			foundInBatch = true
			assertFileSentinels("GetCrossLibraryEpisodeFilesBatch", f)
		}
	}
	if !foundInBatch {
		t.Errorf("GetCrossLibraryEpisodeFilesBatch returned %d files for the fixture "+
			"episode but none was the fixture file (id %d), so the sentinel "+
			"assertions never ran", len(batch[episodeID]), fileID)
	}
}

// TestRequestReadsSurviveNullColumns covers the requests table, whose
// poster_path/overview/year/arr_job_ids/error_message are nullable (with
// non-NULL DEFAULTs, which is why no application write reaches this) and are
// scanned into non-nullable models.Request fields through ONE shared
// requestColumns projection — so all six request reads shared one defect and
// one fix.
func TestRequestReadsSurviveNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)

	// One fixture PER STATUS. The six reads filter on different statuses, and a
	// read that matches no row scans nothing — so a single 'pending_approval'
	// fixture left GetProcessingRequests and GetStalePendingRequests passing
	// identically against the un-COALESCEd projection. requested_at is backdated
	// so the 'pending' row is stale enough for GetStalePendingRequests' cutoff.
	seedNullRequest := func(status string) int64 {
		t.Helper()
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO requests
			   (user_id, media_type, tmdb_id, title, poster_path, overview, year,
			    status, arr_job_ids, error_message, requested_at)
			 VALUES ($1, 'movie', $2, 'NullProbe Request', NULL, NULL, NULL,
			         $3, NULL, NULL, NOW() - INTERVAL '1 day') RETURNING id`,
			owner, uniqueTMDBID(t), status,
		).Scan(&id); err != nil {
			t.Fatalf("seed all-NULL %s request: %v", status, err)
		}
		t.Cleanup(func() {
			_, _ = q.pool.Exec(context.Background(), `DELETE FROM requests WHERE id = $1`, id)
		})
		return id
	}
	reqID := seedNullRequest("pending_approval")
	seedNullRequest("processing")
	seedNullRequest("pending")

	assertRequestSentinels := func(name string, r *models.Request) {
		t.Helper()
		if r.PosterPath != "" || r.Overview != "" || r.ArrJobIDs != "" || r.ErrorMessage != "" {
			t.Errorf("%s: want empty strings, got %q/%q/%q/%q",
				name, r.PosterPath, r.Overview, r.ArrJobIDs, r.ErrorMessage)
		}
		if r.Year != 0 {
			t.Errorf("%s: Year = %d, want 0", name, r.Year)
		}
	}

	byID, err := q.GetRequestByID(ctx, reqID)
	if err != nil {
		t.Fatalf("GetRequestByID with a NULL-column request present: %v", err)
	}
	if byID == nil {
		t.Fatal("GetRequestByID returned no row")
	}
	assertRequestSentinels("GetRequestByID", byID)

	byUser, err := q.GetRequestsByUserID(ctx, owner)
	if err != nil {
		t.Fatalf("GetRequestsByUserID: %v", err)
	}
	// Three fixtures are seeded (one per status), so assert the one we hold an
	// id for is present rather than an exact count.
	foundByUser := false
	for i := range byUser {
		if byUser[i].ID == reqID {
			foundByUser = true
			assertRequestSentinels("GetRequestsByUserID", &byUser[i])
		}
	}
	if !foundByUser {
		t.Errorf("the NULL-column request (id %d) is missing from GetRequestsByUserID's "+
			"%d results", reqID, len(byUser))
	}

	// Each of these must scan at least one NULL row, or it proves nothing about
	// the shared projection. nonEmpty is what makes that explicit.
	nonEmpty := func(name string, n int, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s with a NULL-column request present: %v", name, err)
		}
		if n == 0 {
			t.Errorf("%s returned 0 rows, so it never reached the scan and this "+
				"case proves nothing", name)
		}
	}
	all, err := q.GetAllRequests(ctx)
	nonEmpty("GetAllRequests", len(all), err)

	approval, err := q.GetPendingApprovalRequests(ctx)
	nonEmpty("GetPendingApprovalRequests", len(approval), err)

	processing, err := q.GetProcessingRequests(ctx)
	nonEmpty("GetProcessingRequests", len(processing), err)

	stale, err := q.GetStalePendingRequests(ctx, time.Now())
	nonEmpty("GetStalePendingRequests", len(stale), err)
}

// TestProfileReadsSurviveNullColumns covers user_profiles.language and
// subtitle_mode — both nullable, both scanned into non-nullable
// models.UserProfile string fields, and both sitting in a select list that
// already COALESCEs avatar_url, max_age_rating and subtitle_lang three tokens
// away. That is the same "coalesced the sibling, missed this one" shape the four
// ContinueWatching queries had.
//
// Blast radius is narrower than the catalog-wide queries (one user, not
// everyone) but reachability is HIGHER: ResolveActingProfile funnels
// essentially every profile-scoped request through GetProfile /
// GetDefaultProfile, so one NULL on a user's default profile takes out that
// user's whole session rather than one field.
func TestProfileReadsSurviveNullColumns(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)

	var profileID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
		 VALUES ($1, $2, TRUE, NULL, NULL) RETURNING id`,
		owner, "nullcol_"+randomSuffix(t),
	).Scan(&profileID); err != nil {
		t.Fatalf("seed all-NULL profile: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM user_profiles WHERE id = $1`, profileID)
	})

	assertProfileSentinels := func(name string, p *models.UserProfile) {
		t.Helper()
		if p.Language != "" {
			t.Errorf("%s: Language = %q, want \"\"", name, p.Language)
		}
		if p.SubtitleMode != "" {
			t.Errorf("%s: SubtitleMode = %q, want \"\"", name, p.SubtitleMode)
		}
	}

	byID, err := q.GetProfile(ctx, profileID)
	if err != nil {
		t.Fatalf("GetProfile with a NULL-column profile present: %v", err)
	}
	if byID == nil {
		t.Fatal("GetProfile returned no row for the fixture")
	}
	assertProfileSentinels("GetProfile", byID)

	def, err := q.GetDefaultProfile(ctx, owner)
	if err != nil {
		t.Fatalf("GetDefaultProfile with a NULL-column profile present: %v", err)
	}
	if def == nil {
		t.Fatal("GetDefaultProfile returned no row for the fixture")
	}
	assertProfileSentinels("GetDefaultProfile", def)

	list, err := q.GetProfilesByUser(ctx, owner)
	if err != nil {
		t.Fatalf("GetProfilesByUser with a NULL-column profile present: %v", err)
	}
	found := false
	for _, p := range list {
		if p.ID == profileID {
			found = true
			assertProfileSentinels("GetProfilesByUser", p)
		}
	}
	if !found {
		t.Errorf("the NULL-column profile (id %d) is missing from GetProfilesByUser' "+
			"%d results", profileID, len(list))
	}

	// ResolveActingProfile is the funnel every profile-scoped request goes
	// through, so it is asserted separately rather than assumed from GetProfile.
	resolved, err := q.ResolveActingProfile(ctx, owner, 0)
	if err != nil {
		t.Fatalf("ResolveActingProfile with a NULL-column profile present: %v", err)
	}
	if resolved == nil {
		t.Fatal("ResolveActingProfile returned no profile")
	}
	assertProfileSentinels("ResolveActingProfile", resolved)
}

// TestGetArtworkSurvivesNullVoteAverage covers artwork.vote_average, nullable
// and scanned into models.Artwork.VoteAverage (a plain float64) beside
// COALESCEd local_path/width/height/lang/blurhash.
//
// GET /api/media/{id}/artwork surfaces the failure as a 500; the media-detail
// artwork block swallows the error, so there it degrades silently to
// "no artwork" — which is the worse of the two, being invisible.
func TestGetArtworkSurvivesNullVoteAverage(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	lib := nullProbeLibrary(t, q, owner, "movie")
	itemID, _ := insertMovie(t, q, lib)

	var artID int64
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO artwork
		   (media_item_id, art_type, source, remote_path, width, height, lang,
		    vote_average, is_primary, blurhash)
		 VALUES ($1, 'poster', 'tmdb', $2, NULL, NULL, NULL, NULL, TRUE, NULL)
		 RETURNING id`,
		itemID, "/nullcol_"+randomSuffix(t)+".jpg",
	).Scan(&artID); err != nil {
		t.Fatalf("seed all-NULL artwork: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM artwork WHERE id = $1`, artID)
	})

	art, err := q.GetArtwork(ctx, itemID)
	if err != nil {
		t.Fatalf("GetArtwork with a NULL vote_average present: %v", err)
	}
	found := false
	for _, a := range art {
		if a.ID == artID {
			found = true
			if a.VoteAverage != 0 {
				t.Errorf("GetArtwork: VoteAverage = %v, want 0", a.VoteAverage)
			}
		}
	}
	if !found {
		t.Errorf("the NULL-vote_average row (id %d) is missing from GetArtwork's %d "+
			"results, so the assertion never ran", artID, len(art))
	}
}
