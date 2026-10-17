package api

// Handler-level regression tests for issue #462: parental rating ceilings
// were enforced on discovery but not on the read/playback path, and the
// discovery filter itself trusted a client-supplied max_rating query param.
// These tests reproduce the exact bypass — a restricted profile reaching
// content directly by id/file id, or by editing the query string — and pin
// that it's now denied (404, so a restricted profile can't distinguish
// "exceeds your ceiling" from "doesn't exist").
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run, same harness as the
// other integration tests in this package (see request_approval_test.go).

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
)

// seedRCRefreshToken mirrors internal/db's seedRefreshToken (unexported,
// different package) — inserts a minimal refresh_tokens row and returns its
// id so a test can bind an acting profile to it.
func seedRCRefreshToken(t *testing.T, q *db.Queries, userID int64) int64 {
	t.Helper()
	rt := &models.RefreshToken{
		UserID:    userID,
		Token:     "rating-ceiling-handler-test-" + reqTestSuffix(t),
		ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := q.CreateRefreshToken(context.Background(), rt); err != nil {
		t.Fatalf("seed refresh token: %v", err)
	}
	return rt.ID
}

// rcClaimsCtx builds claims bound to a live refresh-token session, so
// ResolveActingProfile can look up whatever profile the test activated on
// it. A refreshTokenID of 0 exercises the "no session" fallback to default.
func rcClaimsCtx(r *http.Request, userID, refreshTokenID int64) *http.Request {
	claims := &auth.JWTClaims{UserID: userID, Username: "u", Role: "user", RefreshTokenID: refreshTokenID}
	return r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
}

func rcRouteReq(method, path string, urlParams map[string]string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	rctx := chi.NewRouteContext()
	for k, v := range urlParams {
		rctx.URLParams.Add(k, v)
	}
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// rcFixture seeds a user, a restricted ("PG") non-default profile bound to
// its own refresh-token session, an R-rated movie, and a TV-MA show with one
// episode/file — the exact shape issue #462's bypass needs: content whose
// rating exceeds the acting profile's ceiling, reachable only by id.
type rcFixture struct {
	q                     *db.Queries
	userID                int64
	restrictedRefreshID   int64 // bound to the PG profile
	unrestrictedRefreshID int64 // bound to the unrestricted default profile
	libraryID             int64
	movieID               int64
	movieFileID           int64
	showID                int64
	episodeFileID         int64
}

func newRCFixture(t *testing.T) *rcFixture {
	t.Helper()
	q := requireRequestTestDB(t)
	userID := seedReqUser(t, q)
	ctx := context.Background()

	// Default profile stays unrestricted (MaxAgeRating "") so it can act as
	// the "allowed" control case.
	defaultProfile, err := q.CreateDefaultProfileForUser(ctx, userID, "default")
	if err != nil {
		t.Fatalf("seed default profile: %v", err)
	}

	restricted := &models.UserProfile{UserID: userID, Name: "kid", MaxAgeRating: "PG", Language: "en", SubtitleMode: "off"}
	if err := q.CreateProfile(ctx, restricted); err != nil {
		t.Fatalf("seed restricted profile: %v", err)
	}

	restrictedRT := seedRCRefreshToken(t, q, userID)
	if ok, err := q.SetActiveProfileForToken(ctx, restrictedRT, userID, restricted.ID); err != nil || !ok {
		t.Fatalf("bind restricted profile: ok=%v err=%v", ok, err)
	}
	unrestrictedRT := seedRCRefreshToken(t, q, userID)
	if ok, err := q.SetActiveProfileForToken(ctx, unrestrictedRT, userID, defaultProfile.ID); err != nil || !ok {
		t.Fatalf("bind default profile: ok=%v err=%v", ok, err)
	}

	suffix := reqTestSuffix(t)
	// A real directory with real bytes on disk — not just DB rows — so the
	// "unrestricted profile" control case in the streaming tests can
	// actually exercise streaming.ServeFile end to end (200 + body) rather
	// than coincidentally 404ing the same way a blocked request would (a
	// missing file and a rating-blocked file are NOT distinguishable by
	// status code alone, so a control case that never reads real bytes
	// wouldn't prove the check runs first).
	mediaDir := t.TempDir()
	lib := &models.Library{Name: "rc_lib_" + suffix, Type: models.LibraryType("movie"), Paths: []string{mediaDir}, ScanInterval: 60, OwnerID: userID}
	if err := q.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("create library: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteLibrary(ctx, lib.ID) })

	writeMediaFile := func(name string) string {
		p := filepath.Join(mediaDir, name)
		if err := os.WriteFile(p, []byte("not a real video, just needs to exist"), 0o644); err != nil {
			t.Fatalf("write fixture file %s: %v", name, err)
		}
		return p
	}

	movie := &models.MediaItem{LibraryID: lib.ID, Type: models.MediaMovie, Title: "RC Movie " + suffix, SortTitle: "rc movie", ContentRating: "R"}
	if err := q.UpsertMediaItem(ctx, movie); err != nil {
		t.Fatalf("seed movie: %v", err)
	}
	movieFile := &models.MediaFile{MediaItemID: movie.ID, Path: writeMediaFile("movie.mp4"), FileHash: "h", Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"}
	if err := q.UpsertMediaFile(ctx, movieFile); err != nil {
		t.Fatalf("seed movie file: %v", err)
	}

	show := &models.MediaItem{LibraryID: lib.ID, Type: models.MediaShow, Title: "RC Show " + suffix, SortTitle: "rc show", ContentRating: "TV-MA"}
	if err := q.UpsertMediaItem(ctx, show); err != nil {
		t.Fatalf("seed show: %v", err)
	}
	seasonID, err := q.UpsertSeason(ctx, show.ID, 1)
	if err != nil {
		t.Fatalf("seed season: %v", err)
	}
	episodeID, err := q.UpsertEpisode(ctx, seasonID, show.ID, 1)
	if err != nil {
		t.Fatalf("seed episode: %v", err)
	}
	episodeFile := &models.EpisodeFile{EpisodeID: episodeID, Path: writeMediaFile("e1.mp4"), FileHash: "h", Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"}
	if err := q.UpsertEpisodeFile(ctx, episodeFile); err != nil {
		t.Fatalf("seed episode file: %v", err)
	}

	return &rcFixture{
		q: q, userID: userID,
		restrictedRefreshID: restrictedRT, unrestrictedRefreshID: unrestrictedRT,
		libraryID: lib.ID, movieID: movie.ID, movieFileID: movieFile.ID,
		showID: show.ID, episodeFileID: episodeFile.ID,
	}
}

func i64(v int64) string { return strconv.FormatInt(v, 10) }

func TestGetSeasons_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewTVHandler(f.q)

	req := func(refreshID int64) *http.Request {
		r := rcRouteReq(http.MethodGet, "/api/tv/x/seasons", map[string]string{"id": i64(f.showID)})
		return rcClaimsCtx(r, f.userID, refreshID)
	}

	rr := httptest.NewRecorder()
	h.GetSeasons(rr, req(f.restrictedRefreshID))
	if rr.Code != http.StatusNotFound {
		t.Errorf("restricted profile: GetSeasons status = %d, want 404 (TV-MA show exceeds PG ceiling)", rr.Code)
	}

	rr = httptest.NewRecorder()
	h.GetSeasons(rr, req(f.unrestrictedRefreshID))
	if rr.Code != http.StatusOK {
		t.Errorf("unrestricted profile: GetSeasons status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}
}

func TestGetEnriched_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewMetadataHandler(f.q, nil, nil)

	req := func(refreshID int64) *http.Request {
		r := rcRouteReq(http.MethodGet, "/api/media/x", map[string]string{"id": i64(f.movieID)})
		return rcClaimsCtx(r, f.userID, refreshID)
	}

	rr := httptest.NewRecorder()
	h.GetEnriched(rr, req(f.restrictedRefreshID))
	if rr.Code != http.StatusNotFound {
		t.Errorf("restricted profile: GetEnriched status = %d, want 404 (R movie exceeds PG ceiling)", rr.Code)
	}

	rr = httptest.NewRecorder()
	h.GetEnriched(rr, req(f.unrestrictedRefreshID))
	if rr.Code != http.StatusOK {
		t.Errorf("unrestricted profile: GetEnriched status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}
}

// TestStreamMediaFile_RatingCeiling pins the actual playback-bypass the
// issue reported: hitting the stream route directly by file id, with no
// discovery step in between. Both the blocked AND the allowed case must be
// asserted — a missing/unreadable file also 404s (streaming.ServeFile),
// so a blocked-only assertion can't distinguish "the ceiling check fired"
// from "the fixture's file doesn't exist"; the fixture writes a real file
// to disk specifically so the unrestricted-profile case can prove it
// actually served bytes (200 + body), not just "didn't 404 either".
func TestStreamMediaFile_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewStreamHandler(f.q, nil, nil, "", nil, nil, nil)

	req := func(refreshID int64) *http.Request {
		r := rcRouteReq(http.MethodGet, "/api/stream/media/x", map[string]string{"fileID": i64(f.movieFileID)})
		return rcClaimsCtx(r, f.userID, refreshID)
	}

	rr := httptest.NewRecorder()
	h.StreamMediaFile(rr, req(f.restrictedRefreshID))
	if rr.Code != http.StatusNotFound {
		t.Errorf("restricted profile: StreamMediaFile status = %d, want 404 (R movie exceeds PG ceiling)", rr.Code)
	}

	rr = httptest.NewRecorder()
	h.StreamMediaFile(rr, req(f.unrestrictedRefreshID))
	if rr.Code != http.StatusOK {
		t.Fatalf("unrestricted profile: StreamMediaFile status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}
	if rr.Body.Len() == 0 {
		t.Error("unrestricted profile: StreamMediaFile returned 200 with an empty body — control case didn't actually serve the file")
	}
}

func TestStreamEpisodeFile_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewStreamHandler(f.q, nil, nil, "", nil, nil, nil)

	req := func(refreshID int64) *http.Request {
		r := rcRouteReq(http.MethodGet, "/api/stream/episode/x", map[string]string{"fileID": i64(f.episodeFileID)})
		return rcClaimsCtx(r, f.userID, refreshID)
	}

	rr := httptest.NewRecorder()
	h.StreamEpisodeFile(rr, req(f.restrictedRefreshID))
	if rr.Code != http.StatusNotFound {
		t.Errorf("restricted profile: StreamEpisodeFile status = %d, want 404 (TV-MA episode exceeds PG ceiling)", rr.Code)
	}

	rr = httptest.NewRecorder()
	h.StreamEpisodeFile(rr, req(f.unrestrictedRefreshID))
	if rr.Code != http.StatusOK {
		t.Fatalf("unrestricted profile: StreamEpisodeFile status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}
	if rr.Body.Len() == 0 {
		t.Error("unrestricted profile: StreamEpisodeFile returned 200 with an empty body — control case didn't actually serve the file")
	}
}

// TestServeDirectFile_RatingCeiling covers the shared serveDirectFile core
// via its RequireAuth entry point (ServeDirectFile) — ServeDirectCastFile is
// the same core reached via a cast token instead, already covered indirectly
// by the trust-boundary reasoning around CreateDirectCastToken.
func TestServeDirectFile_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewStreamHandler(f.q, nil, nil, "", nil, nil, nil)

	req := func(refreshID int64) *http.Request {
		r := rcRouteReq(http.MethodGet, "/api/stream/x/direct?type=media", map[string]string{"fileID": i64(f.movieFileID)})
		return rcClaimsCtx(r, f.userID, refreshID)
	}

	rr := httptest.NewRecorder()
	h.ServeDirectFile(rr, req(f.restrictedRefreshID))
	if rr.Code != http.StatusNotFound {
		t.Errorf("restricted profile: ServeDirectFile status = %d, want 404 (R movie exceeds PG ceiling)", rr.Code)
	}

	rr = httptest.NewRecorder()
	h.ServeDirectFile(rr, req(f.unrestrictedRefreshID))
	if rr.Code != http.StatusOK {
		t.Fatalf("unrestricted profile: ServeDirectFile status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}
	if rr.Body.Len() == 0 {
		t.Error("unrestricted profile: ServeDirectFile returned 200 with an empty body")
	}
}

// TestSubtitleEndpoints_RatingCeiling pins the fix for a gap the initial
// #462 patch missed: subtitle tracks carry the full dialogue of a title, so
// they need the same read-path gate as the video/audio itself.
func TestSubtitleEndpoints_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewStreamHandler(f.q, nil, nil, t.TempDir(), nil, nil, nil)

	t.Run("GetSubtitles", func(t *testing.T) {
		req := func(refreshID int64) *http.Request {
			r := rcRouteReq(http.MethodGet, "/api/stream/x/subtitles?type=media", map[string]string{"fileID": i64(f.movieFileID)})
			return rcClaimsCtx(r, f.userID, refreshID)
		}
		rr := httptest.NewRecorder()
		h.GetSubtitles(rr, req(f.restrictedRefreshID))
		if rr.Code != http.StatusNotFound {
			t.Errorf("restricted profile: GetSubtitles status = %d, want 404", rr.Code)
		}
		rr = httptest.NewRecorder()
		h.GetSubtitles(rr, req(f.unrestrictedRefreshID))
		if rr.Code != http.StatusOK {
			t.Errorf("unrestricted profile: GetSubtitles status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
		}
	})

	t.Run("ServeSubtitle", func(t *testing.T) {
		req := func(refreshID int64) *http.Request {
			r := rcRouteReq(http.MethodGet, "/api/stream/x/subtitles/0?type=media", map[string]string{"fileID": i64(f.movieFileID), "trackIdx": "0"})
			return rcClaimsCtx(r, f.userID, refreshID)
		}
		rr := httptest.NewRecorder()
		h.ServeSubtitle(rr, req(f.restrictedRefreshID))
		if rr.Code != http.StatusNotFound {
			t.Errorf("restricted profile: ServeSubtitle status = %d, want 404", rr.Code)
		}
		// Not asserting the unrestricted-profile case here: past the ceiling
		// check, ServeSubtitle shells out to ffprobe/ffmpeg to extract track
		// 0 from a fixture file that isn't a real video, which fails for
		// reasons unrelated to this fix. The blocked assertion above is what
		// pins the security property; GetSubtitles' control case already
		// proves the same ceiling helper allows an in-range profile through.
	})
}

// TestCreateSession_RatingCeiling pins the transcode-session mint point:
// a session (and the HLS playlist URL it hands back) must never be issued
// for over-ceiling content, regardless of file type.
func TestCreateSession_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewStreamHandler(f.q, nil, nil, "", nil, nil, nil)

	for _, tc := range []struct {
		name     string
		fileID   int64
		fileType string
	}{
		{"movie", f.movieFileID, "media"},
		{"episode", f.episodeFileID, "episode"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"file_id":` + i64(tc.fileID) + `,"file_type":"` + tc.fileType + `"}`
			r := httptest.NewRequest(http.MethodPost, "/api/stream/sessions", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			r = rcClaimsCtx(r, f.userID, f.restrictedRefreshID)
			rr := httptest.NewRecorder()
			h.CreateSession(rr, r)
			if rr.Code != http.StatusNotFound {
				t.Errorf("restricted profile: CreateSession(%s) status = %d, want 404", tc.name, rr.Code)
			}
		})
	}
}

func TestCreateDirectCastToken_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewStreamHandler(f.q, nil, nil, "", nil, nil, healthTestService())

	r := rcRouteReq(http.MethodPost, "/api/stream/x/cast-token?type=media", map[string]string{"fileID": i64(f.movieFileID)})
	r = rcClaimsCtx(r, f.userID, f.restrictedRefreshID)
	rr := httptest.NewRecorder()
	h.CreateDirectCastToken(rr, r)
	if rr.Code != http.StatusNotFound {
		t.Errorf("restricted profile: CreateDirectCastToken status = %d, want 404 (mint-time check must deny)", rr.Code)
	}
}

// TestMediaList_ServerDerivedCeiling pins the discovery-filter half of the
// fix: media_handlers.go used to trust a client-supplied max_rating query
// param outright. A restricted profile requesting max_rating=NC-17 (i.e.
// trying to self-serve an unfiltered feed) must still only see items within
// its OWN server-resolved ceiling.
func TestMediaList_ServerDerivedCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewMediaHandler(f.q, nil)

	r := httptest.NewRequest(http.MethodGet, "/api/media?max_rating=NC-17", nil)
	r = rcClaimsCtx(r, f.userID, f.restrictedRefreshID)
	rr := httptest.NewRecorder()
	h.List(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("List status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
	}
	var resp models.PaginatedResponse
	resp.Data = &[]*models.MediaItem{}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	items := *(resp.Data.(*[]*models.MediaItem))
	for _, it := range items {
		if it.ID == f.movieID {
			t.Errorf("restricted profile requesting max_rating=NC-17 still saw the R-rated movie (id=%d) — discovery filter is client-elective again", it.ID)
		}
	}
}

// TestMediaRecent_ServerDerivedCeiling pins "Recently added" to the same
// server-resolved ceiling as browse. The handler used to call GetRecentMedia
// with no profile at all, so a restricted profile's Home rail (and the web and
// TV heroes that fall back to its first item) listed every recent title. The
// TV also sends ?profile_id=; neither it nor max_rating may pick a looser
// ceiling, so the restricted request names the unrestricted default profile
// and asks for NC-17.
func TestMediaRecent_ServerDerivedCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewMediaHandler(f.q, nil)
	ctx := context.Background()

	// An in-ceiling title, so the restricted case proves filtering rather than
	// an empty response. The fixture's movie (R) and show (TV-MA) exceed PG.
	allowed := &models.MediaItem{LibraryID: f.libraryID, Type: models.MediaMovie, Title: "RC Allowed " + reqTestSuffix(t),
		SortTitle: "rc allowed", ContentRating: "PG"}
	if err := f.q.UpsertMediaItem(ctx, allowed); err != nil {
		t.Fatalf("seed allowed movie: %v", err)
	}
	defaultProfile, err := f.q.GetDefaultProfile(ctx, f.userID)
	if err != nil || defaultProfile == nil {
		t.Fatalf("load default profile: %v", err)
	}

	recent := func(refreshTokenID int64) []*models.MediaItem {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api/media/recent?limit=50&max_rating=NC-17&profile_id="+i64(defaultProfile.ID), nil)
		r = rcClaimsCtx(r, f.userID, refreshTokenID)
		rr := httptest.NewRecorder()
		h.Recent(rr, r)
		if rr.Code != http.StatusOK {
			t.Fatalf("Recent status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
		}
		var items []*models.MediaItem
		if err := json.Unmarshal(rr.Body.Bytes(), &items); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return items
	}
	idSet := func(items []*models.MediaItem) map[int64]bool {
		ids := map[int64]bool{}
		for _, it := range items {
			ids[it.ID] = true
		}
		return ids
	}

	// The ceiling check covers every returned row, whatever else is in the
	// shared catalog. The id checks rely on this fixture's rows being among the
	// 50 newest, which holds unless something seeds 50+ newer rows concurrently.
	restrictedItems := recent(f.restrictedRefreshID)
	for _, it := range restrictedItems {
		if !db.RatingAllowed("PG", it.ContentRating) {
			t.Errorf("restricted (PG) session got item %d rated %q from Recently added", it.ID, it.ContentRating)
		}
	}
	restricted := idSet(restrictedItems)
	if restricted[f.movieID] || restricted[f.showID] {
		t.Errorf("restricted (PG) session saw over-ceiling titles in Recently added: movie=%v show=%v",
			restricted[f.movieID], restricted[f.showID])
	}
	if !restricted[allowed.ID] {
		t.Errorf("restricted (PG) session lost the PG title %d from Recently added", allowed.ID)
	}

	open := idSet(recent(f.unrestrictedRefreshID))
	if !open[f.movieID] || !open[allowed.ID] {
		t.Errorf("unrestricted session must still see every recent title: R movie=%v PG movie=%v",
			open[f.movieID], open[allowed.ID])
	}
}

// TestMediaSearch_ServerDerivedCeiling pins library search to the same
// server-resolved ceiling as browse. Search used to apply no ceiling at all,
// so a restricted profile could type the title of anything in the library and
// get its poster, overview and id back. As with Recently added, the request
// names the unrestricted default profile and asks for NC-17, and neither may
// loosen the session's ceiling.
func TestMediaSearch_ServerDerivedCeiling(t *testing.T) {
	f := newRCFixture(t)
	ctx := context.Background()
	defaultProfile, err := f.q.GetDefaultProfile(ctx, f.userID)
	if err != nil || defaultProfile == nil {
		t.Fatalf("load default profile: %v", err)
	}

	// Every title carries a token no other row can contain, so the literal
	// query matches exactly these four, whatever else is in the catalog.
	token := "rcsearch" + reqTestSuffix(t)
	seed := func(typ models.MediaType, rating, name string) int64 {
		t.Helper()
		it := &models.MediaItem{LibraryID: f.libraryID, Type: typ, Title: token + " " + name, SortTitle: token + " " + name, ContentRating: rating}
		if err := f.q.UpsertMediaItem(ctx, it); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
		return it.ID
	}
	allowed := seed(models.MediaMovie, "PG", "allowed")
	overR := seed(models.MediaMovie, "R", "restricted movie")
	overTVMA := seed(models.MediaShow, "TV-MA", "mature show")
	unrated := seed(models.MediaMovie, "", "unrated")

	// search returns the served ids and the X-Search-Mode the handler reported.
	search := func(refreshTokenID int64, fake *fakeSemantic, mode string) (map[int64]bool, string) {
		t.Helper()
		h := NewMediaHandler(f.q, nil)
		if fake != nil {
			h.SetSemanticSearcher(fake)
		}
		r := httptest.NewRequest(http.MethodGet, "/api/media/search?q="+token+"&mode="+mode+
			"&max_rating=NC-17&profile_id="+i64(defaultProfile.ID), nil)
		r = rcClaimsCtx(r, f.userID, refreshTokenID)
		rr := httptest.NewRecorder()
		h.Search(rr, r)
		if rr.Code != http.StatusOK {
			t.Fatalf("Search status = %d, want 200 (body %q)", rr.Code, rr.Body.String())
		}
		var items []*models.MediaItem
		if err := json.Unmarshal(rr.Body.Bytes(), &items); err != nil {
			t.Fatalf("decode: %v", err)
		}
		ids := map[int64]bool{}
		for _, it := range items {
			ids[it.ID] = true
		}
		return ids, rr.Header().Get("X-Search-Mode")
	}

	t.Run("literal", func(t *testing.T) {
		got, _ := search(f.restrictedRefreshID, nil, "literal")
		if got[overR] || got[overTVMA] {
			t.Errorf("restricted (PG) session found over-ceiling titles by searching: R movie=%v TV-MA show=%v", got[overR], got[overTVMA])
		}
		if got[unrated] {
			t.Errorf("restricted (PG) session found the unrated title %d; unrated titles are excluded under a restriction", unrated)
		}
		if !got[allowed] {
			t.Errorf("restricted (PG) session lost the PG title %d from search", allowed)
		}

		open, _ := search(f.unrestrictedRefreshID, nil, "literal")
		for name, id := range map[string]int64{"PG": allowed, "R": overR, "TV-MA": overTVMA, "unrated": unrated} {
			if !open[id] {
				t.Errorf("unrestricted session lost the %s title %d from search", name, id)
			}
		}
	})

	// The semantic searcher is handed the ceiling rather than trusted to find
	// one, so what it receives is the contract. The fake also returns an R hit
	// regardless, standing in for a searcher that ignores its argument: the
	// handler re-checks the rows it serves, and must still serve the PG hit
	// beside it. The mode header proves the semantic path served it; an empty
	// semantic answer would fall back to trigram, which also finds that row.
	t.Run("semantic", func(t *testing.T) {
		rItem, err := f.q.GetMediaItem(ctx, overR)
		if err != nil || rItem == nil {
			t.Fatalf("load R item: %v", err)
		}
		pgItem, err := f.q.GetMediaItem(ctx, allowed)
		if err != nil || pgItem == nil {
			t.Fatalf("load PG item: %v", err)
		}
		fake := &fakeSemantic{hits: []SemanticHit{{Item: rItem}, {Item: pgItem}}}
		got, mode := search(f.restrictedRefreshID, fake, "semantic")
		if !fake.called {
			t.Fatal("mode=semantic did not invoke the semantic searcher")
		}
		if want := db.AllowedRatingsForMax("PG"); !sameRatings(fake.allowedRatings, want) {
			t.Errorf("restricted (PG) session passed allowedRatings %v to the semantic searcher, want %v", fake.allowedRatings, want)
		}
		if got[overR] {
			t.Errorf("restricted (PG) session was served the R hit %d the semantic searcher returned", overR)
		}
		if !got[allowed] || mode != "semantic" {
			t.Errorf("restricted (PG) session: PG hit %d served=%v with X-Search-Mode %q, want served by the semantic path",
				allowed, got[allowed], mode)
		}

		fake = &fakeSemantic{hits: []SemanticHit{{Item: rItem}}}
		open, _ := search(f.unrestrictedRefreshID, fake, "semantic")
		if fake.allowedRatings != nil {
			t.Errorf("unrestricted session passed allowedRatings %v to the semantic searcher, want nil", fake.allowedRatings)
		}
		if !open[overR] {
			t.Errorf("unrestricted session lost the R hit %d", overR)
		}
	})
}

// TestAICollectionSeed_ServerDerivedCeiling: an AI collection is seeded by a
// library search run as its creator, so a restricted profile prompting one
// must hand the searcher its own ceiling, or the collection becomes a way to
// read back any title the search would have hidden. The fake also returns an
// R hit regardless, standing in for a searcher that ignores its argument: the
// seed must not save it for the restricted profile, and must still save the PG
// hit beside it.
func TestAICollectionSeed_ServerDerivedCeiling(t *testing.T) {
	f := newRCFixture(t)
	ctx := context.Background()
	rItem, err := f.q.GetMediaItem(ctx, f.movieID)
	if err != nil || rItem == nil {
		t.Fatalf("load R item: %v", err)
	}
	pgItem := &models.MediaItem{LibraryID: f.libraryID, Type: models.MediaMovie, Title: "RC Seed PG " + reqTestSuffix(t),
		SortTitle: "rc seed pg", ContentRating: "PG"}
	if err := f.q.UpsertMediaItem(ctx, pgItem); err != nil {
		t.Fatalf("seed PG movie: %v", err)
	}
	for _, tc := range []struct {
		name      string
		refreshID int64
		want      []string
		wantSaved bool
	}{
		{"restricted", f.restrictedRefreshID, db.AllowedRatingsForMax("PG"), false},
		{"unrestricted", f.unrestrictedRefreshID, nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeSemantic{hits: []SemanticHit{{Item: rItem}, {Item: pgItem}}}
			h := NewCollectionsHandler(f.q)
			h.SetSemanticSearcher(fake)
			r := httptest.NewRequest(http.MethodPost, "/api/collections",
				strings.NewReader(`{"name":"rc ai `+reqTestSuffix(t)+`","kind":"ai","prompt":"grim war films"}`))
			r = rcClaimsCtx(r, f.userID, tc.refreshID)
			rr := httptest.NewRecorder()
			h.Create(rr, r)
			if rr.Code != http.StatusCreated {
				t.Fatalf("Create status = %d, want 201 (body %q)", rr.Code, rr.Body.String())
			}
			var c models.Collection
			if err := json.Unmarshal(rr.Body.Bytes(), &c); err != nil || c.ID == 0 {
				t.Fatalf("decode created collection: %v (body %q)", err, rr.Body.String())
			}
			t.Cleanup(func() { _ = f.q.DeleteCollection(context.Background(), c.ID) })
			if !fake.called {
				t.Fatal("AI collection creation did not run the semantic search")
			}
			if !sameRatings(fake.allowedRatings, tc.want) {
				t.Errorf("AI collection seed passed allowedRatings %v, want %v", fake.allowedRatings, tc.want)
			}
			items, err := f.q.ListCollectionItems(context.Background(), c.ID)
			if err != nil {
				t.Fatalf("list collection items: %v", err)
			}
			saved, savedPG := false, false
			for _, it := range items {
				saved = saved || it.ID == rItem.ID
				savedPG = savedPG || it.ID == pgItem.ID
			}
			if saved != tc.wantSaved {
				t.Errorf("R hit saved into the collection = %v, want %v", saved, tc.wantSaved)
			}
			if !savedPG {
				t.Errorf("the PG hit %d was not saved into the collection", pgItem.ID)
			}
		})
	}
}

// TestAICollectionSeed_ResolveErrorSkipsSeed pins the deliberate difference
// from search: a seed is saved, and collection contents are read back without
// a ceiling, so a failed profile lookup must not seed unrestricted.
func TestAICollectionSeed_ResolveErrorSkipsSeed(t *testing.T) {
	f := newRCFixture(t)
	rItem, err := f.q.GetMediaItem(context.Background(), f.movieID)
	if err != nil || rItem == nil {
		t.Fatalf("load R item: %v", err)
	}
	fake := &fakeSemantic{hits: []SemanticHit{{Item: rItem}}}
	h := NewCollectionsHandler(f.q)
	h.SetSemanticSearcher(fake)
	h.resolveProfile = func(context.Context, int64, int64) (*models.UserProfile, error) {
		return nil, errors.New("transient profile lookup failure")
	}

	r := httptest.NewRequest(http.MethodPost, "/api/collections",
		strings.NewReader(`{"name":"rc ai `+reqTestSuffix(t)+`","kind":"ai","prompt":"grim war films"}`))
	r = rcClaimsCtx(r, f.userID, f.restrictedRefreshID)
	rr := httptest.NewRecorder()
	h.Create(rr, r)
	if rr.Code != http.StatusCreated {
		t.Fatalf("Create status = %d, want 201 with an empty collection (body %q)", rr.Code, rr.Body.String())
	}
	var c models.Collection
	if err := json.Unmarshal(rr.Body.Bytes(), &c); err != nil || c.ID == 0 {
		t.Fatalf("decode created collection: %v (body %q)", err, rr.Body.String())
	}
	t.Cleanup(func() { _ = f.q.DeleteCollection(context.Background(), c.ID) })
	if fake.called {
		t.Error("a failed profile lookup still ran the seed search")
	}
	items, err := f.q.ListCollectionItems(context.Background(), c.ID)
	if err != nil {
		t.Fatalf("list collection items: %v", err)
	}
	if len(items) != 0 {
		t.Errorf("a failed profile lookup seeded %d items, want none", len(items))
	}
}

// sameRatings reports whether two rating lists hold the same set; the ladder
// is a map, so AllowedRatingsForMax's order is not stable between calls.
func sameRatings(a, b []string) bool {
	if (a == nil) != (b == nil) || len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, r := range a {
		seen[r]++
	}
	for _, r := range b {
		if seen[r] == 0 {
			return false
		}
		seen[r]--
	}
	return true
}

func TestActivateProfile_OwnershipEnforced(t *testing.T) {
	f := newRCFixture(t)
	h := NewProfileHandler(f.q)

	otherUser := seedReqUser(t, f.q)
	otherProfile, err := f.q.CreateDefaultProfileForUser(context.Background(), otherUser, "other")
	if err != nil {
		t.Fatalf("seed other user's profile: %v", err)
	}

	r := rcRouteReq(http.MethodPost, "/api/profiles/x/activate", map[string]string{"id": i64(otherProfile.ID)})
	r = rcClaimsCtx(r, f.userID, f.restrictedRefreshID)
	rr := httptest.NewRecorder()
	h.ActivateProfile(rr, r)
	if rr.Code != http.StatusForbidden {
		t.Errorf("activating another account's profile: status = %d, want 403", rr.Code)
	}

	// Confirm it wasn't silently bound despite the 403.
	bound, err := f.q.ResolveActingProfile(context.Background(), f.userID, f.restrictedRefreshID)
	if err != nil {
		t.Fatalf("resolve after rejected activate: %v", err)
	}
	if bound == nil || bound.ID == otherProfile.ID {
		t.Errorf("resolved profile = %+v; the rejected cross-account activate must not have taken effect", bound)
	}
}
