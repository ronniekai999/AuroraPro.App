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
	"net/http"
	"net/http/httptest"
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
	lib := &models.Library{Name: "rc_lib_" + suffix, Type: models.LibraryType("movie"), Paths: []string{"/tmp/rc_" + suffix}, ScanInterval: 60, OwnerID: userID}
	if err := q.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("create library: %v", err)
	}
	t.Cleanup(func() { _, _ = q.DeleteLibrary(ctx, lib.ID) })

	movie := &models.MediaItem{LibraryID: lib.ID, Type: models.MediaMovie, Title: "RC Movie " + suffix, SortTitle: "rc movie", ContentRating: "R"}
	if err := q.UpsertMediaItem(ctx, movie); err != nil {
		t.Fatalf("seed movie: %v", err)
	}
	movieFile := &models.MediaFile{MediaItemID: movie.ID, Path: "/tmp/rc_" + suffix + "/movie.mp4", FileHash: "h", Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"}
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
	episodeFile := &models.EpisodeFile{EpisodeID: episodeID, Path: "/tmp/rc_" + suffix + "/e1.mp4", FileHash: "h", Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"}
	if err := q.UpsertEpisodeFile(ctx, episodeFile); err != nil {
		t.Fatalf("seed episode file: %v", err)
	}

	return &rcFixture{
		q: q, userID: userID,
		restrictedRefreshID: restrictedRT, unrestrictedRefreshID: unrestrictedRT,
		movieID: movie.ID, movieFileID: movieFile.ID,
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
// discovery step in between. The block must fire before any filesystem or
// transcode-manager access (StreamHandler is built with nil transcode/hub —
// a passing blocked assertion here proves the check runs first).
func TestStreamMediaFile_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewStreamHandler(f.q, nil, nil, "", nil, nil, nil)

	r := rcRouteReq(http.MethodGet, "/api/stream/media/x", map[string]string{"fileID": i64(f.movieFileID)})
	r = rcClaimsCtx(r, f.userID, f.restrictedRefreshID)
	rr := httptest.NewRecorder()
	h.StreamMediaFile(rr, r)
	if rr.Code != http.StatusNotFound {
		t.Errorf("restricted profile: StreamMediaFile status = %d, want 404 (R movie exceeds PG ceiling)", rr.Code)
	}
}

func TestStreamEpisodeFile_RatingCeiling(t *testing.T) {
	f := newRCFixture(t)
	h := NewStreamHandler(f.q, nil, nil, "", nil, nil, nil)

	r := rcRouteReq(http.MethodGet, "/api/stream/episode/x", map[string]string{"fileID": i64(f.episodeFileID)})
	r = rcClaimsCtx(r, f.userID, f.restrictedRefreshID)
	rr := httptest.NewRecorder()
	h.StreamEpisodeFile(rr, r)
	if rr.Code != http.StatusNotFound {
		t.Errorf("restricted profile: StreamEpisodeFile status = %d, want 404 (TV-MA episode exceeds PG ceiling)", rr.Code)
	}
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
