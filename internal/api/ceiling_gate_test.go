package api

// Handler tests for the by-id ceiling gate (ceiling_gate.go). Before it, a
// session acting as a restricted profile could name an over-ceiling title's
// id and get its files, artwork, cast, next episode, stream info and recap,
// and could file progress, thumbs, ratings and list entries on it, which
// history, anchor rails and its lists then read back. Opt-in via
// TEST_DATABASE_URL.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/recap"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// missingID names no row in any table these routes read.
const missingID = int64(1) << 60

// gateFixture adds a catalog to a lockFixture (an unrestricted parent and a
// PG kid, each with a bound session): an allowed and an over-ceiling movie
// with a file each, and an allowed and an over-ceiling show with one episode
// and episode file each.
type gateFixture struct {
	*lockFixture
	movieOK, movieR, fileOK, fileR int64
	showOK, showR, epOK, epR       int64
	epFileOK, epFileR              int64
}

func newGateFixture(t *testing.T) *gateFixture {
	t.Helper()
	f := newLockFixture(t)
	ctx := context.Background()
	dir := t.TempDir()
	lib := &models.Library{Name: "gate_" + reqTestSuffix(t), Type: models.LibraryType("movie"), Paths: []string{dir},
		ScanInterval: 60, OwnerID: f.userID}
	if err := f.q.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = f.q.DeleteLibrary(context.Background(), lib.ID) })

	item := func(name string, kind models.MediaType, rating string) int64 {
		it := &models.MediaItem{LibraryID: lib.ID, Type: kind, Title: "Gate " + name + " " + reqTestSuffix(t),
			SortTitle: "gate " + name, ContentRating: rating}
		if err := f.q.UpsertMediaItem(ctx, it); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
		return it.ID
	}
	path := func(name string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("not a real video"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		return p
	}
	movieFile := func(mediaID int64, name string) int64 {
		mf := &models.MediaFile{MediaItemID: mediaID, Path: path(name), FileHash: "h", Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"}
		if err := f.q.UpsertMediaFile(ctx, mf); err != nil {
			t.Fatalf("seed movie file: %v", err)
		}
		return mf.ID
	}
	episode := func(showID int64, name string) (int64, int64) {
		seasonID, err := f.q.UpsertSeason(ctx, showID, 1)
		if err != nil {
			t.Fatalf("seed season: %v", err)
		}
		epID, err := f.q.UpsertEpisode(ctx, seasonID, showID, 1)
		if err != nil {
			t.Fatalf("seed episode: %v", err)
		}
		ef := &models.EpisodeFile{EpisodeID: epID, Path: path(name), FileHash: "h", Container: "mp4", VideoCodec: "h264", AudioCodec: "aac"}
		if err := f.q.UpsertEpisodeFile(ctx, ef); err != nil {
			t.Fatalf("seed episode file: %v", err)
		}
		return epID, ef.ID
	}

	g := &gateFixture{lockFixture: f}
	g.movieOK = item("movie pg", models.MediaMovie, "PG")
	g.movieR = item("movie r", models.MediaMovie, "R")
	g.fileOK = movieFile(g.movieOK, "ok.mp4")
	g.fileR = movieFile(g.movieR, "r.mp4")
	g.showOK = item("show g", models.MediaShow, "G")
	g.showR = item("show ma", models.MediaShow, "TV-MA")
	g.epOK, g.epFileOK = episode(g.showOK, "ok-e1.mp4")
	g.epR, g.epFileR = episode(g.showR, "r-e1.mp4")
	return g
}

// gateCall runs handler as session rt with chi URL params, a raw query and an
// optional JSON body.
func gateCall(f *lockFixture, handler http.HandlerFunc, method string, rt int64, params map[string]string, query, body string) *httptest.ResponseRecorder {
	target := "/x"
	if query != "" {
		target += "?" + query
	}
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	rr := httptest.NewRecorder()
	handler(rr, rcClaimsCtx(r, f.userID, rt))
	return rr
}

// gateCase is one route under the gate. call runs it for a title id as a
// session.
type gateCase struct {
	name            string
	call            func(rt, id int64) *httptest.ResponseRecorder
	allowed, hidden int64
}

// checkGate pins the gate's contract on each case: the kid's session gets one
// 404 for an over-ceiling id and the same 404, byte for byte, for an id that
// does not exist, while the kid's allowed id and the parent's over-ceiling id
// get through.
func checkGate(t *testing.T, f *lockFixture, cases []gateCase) {
	t.Helper()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			denied := c.call(f.kidRT, c.hidden)
			if denied.Code != http.StatusNotFound {
				t.Fatalf("kid session, over-ceiling id: status %d (%s), want 404", denied.Code, denied.Body.String())
			}
			if missing := c.call(f.kidRT, missingID); missing.Code != denied.Code || !bytes.Equal(missing.Body.Bytes(), denied.Body.Bytes()) {
				t.Errorf("kid session: a missing id answers %d %s, an over-ceiling one %d %s; want the same answer",
					missing.Code, missing.Body.String(), denied.Code, denied.Body.String())
			}
			same := func(rr *httptest.ResponseRecorder) bool {
				return rr.Code == denied.Code && bytes.Equal(rr.Body.Bytes(), denied.Body.Bytes())
			}
			if rr := c.call(f.kidRT, c.allowed); same(rr) || rr.Code == http.StatusInternalServerError {
				t.Errorf("kid session, allowed id: %d %s; want neither the refusal nor a server error", rr.Code, rr.Body.String())
			}
			if rr := c.call(f.parentRT, c.hidden); same(rr) || rr.Code == http.StatusInternalServerError {
				t.Errorf("parent session, R/TV-MA id: %d %s; the parent has no ceiling", rr.Code, rr.Body.String())
			}
		})
	}
}

func idParam(name string, id int64) map[string]string {
	return map[string]string{name: strconv.FormatInt(id, 10)}
}

// TestByIDLookupsHideOverCeilingTitles: the lookups the detail page and the
// player make. Most answered for any id.
func TestByIDLookupsHideOverCeilingTitles(t *testing.T) {
	g := newGateFixture(t)
	media := NewMediaHandler(g.q, nil)
	tv := NewTVHandler(g.q)
	meta := NewMetadataHandler(g.q, nil, nil)
	stream := NewStreamHandler(g.q, nil, nil, "", nil, nil, nil)
	byID := func(handler http.HandlerFunc, param, query string) func(rt, id int64) *httptest.ResponseRecorder {
		return func(rt, id int64) *httptest.ResponseRecorder {
			return gateCall(g.lockFixture, handler, http.MethodGet, rt, idParam(param, id), query, "")
		}
	}
	seasonEpisodes := func(rt, id int64) *httptest.ResponseRecorder {
		return gateCall(g.lockFixture, tv.GetEpisodes, http.MethodGet, rt,
			map[string]string{"id": strconv.FormatInt(id, 10), "season": "1"}, "", "")
	}
	checkGate(t, g.lockFixture, []gateCase{
		// Gated before, but a missing id answered differently: a different
		// message on the detail route, 200 and an empty list on the others.
		{"detail", byID(meta.GetEnriched, "id", ""), g.movieOK, g.movieR},
		{"seasons", byID(tv.GetSeasons, "id", ""), g.showOK, g.showR},
		{"season episodes", seasonEpisodes, g.showOK, g.showR},

		{"media files", byID(media.GetFiles, "id", ""), g.movieOK, g.movieR},
		{"artwork", byID(meta.GetArtwork, "id", ""), g.movieOK, g.movieR},
		{"cast", byID(meta.GetCast, "id", ""), g.movieOK, g.movieR},
		{"next episode", byID(tv.GetNextEpisode, "id", ""), g.showOK, g.showR},
		{"episode files", byID(tv.GetEpisodeFiles, "episodeId", ""), g.epOK, g.epR},
		{"stream info, movie file", byID(stream.GetStreamInfo, "fileID", "type=media"), g.fileOK, g.fileR},
		{"stream info, episode file", byID(stream.GetStreamInfo, "fileID", "type=episode"), g.epFileOK, g.epFileR},
	})

	// An unrestricted session skips the gate's title lookup, so a missing id
	// answers as it always did: an empty list, not the gate's 404.
	for name, handler := range map[string]func(rt, id int64) *httptest.ResponseRecorder{
		"media files":   byID(media.GetFiles, "id", ""),
		"seasons":       byID(tv.GetSeasons, "id", ""),
		"episode files": byID(tv.GetEpisodeFiles, "episodeId", ""),
	} {
		if rr := handler(g.parentRT, missingID); rr.Code != http.StatusOK || strings.TrimSpace(rr.Body.String()) != "[]" {
			t.Errorf("parent session, %s for a missing id: %d %s; want 200 []", name, rr.Code, rr.Body.String())
		}
	}
}

// TestRecapRoutesHideOverCeilingTitles: a recap is built from a show's
// episode titles and overviews, and a profile's history on an over-ceiling
// show can predate its ceiling. Clearing stays open.
func TestRecapRoutesHideOverCeilingTitles(t *testing.T) {
	g := newGateFixture(t)
	h := &RecapHandler{queries: g.q, svc: recap.New(g.q, nil)}
	route := func(handler http.HandlerFunc, method, body string) func(rt, id int64) *httptest.ResponseRecorder {
		return func(rt, id int64) *httptest.ResponseRecorder {
			return gateCall(g.lockFixture, handler, method, rt, idParam("id", id), "", body)
		}
	}
	ask := `{"request_id":"00000000-0000-4000-8000-000000000001","question":"what happened?"}`
	checkGate(t, g.lockFixture, []gateCase{
		{"recap", route(h.Get, http.MethodGet, ""), g.showOK, g.showR},
		{"status", route(h.Status, http.MethodGet, ""), g.showOK, g.showR},
		{"conversation", route(h.Conversation, http.MethodGet, ""), g.showOK, g.showR},
		{"ask", route(h.AskTurn, http.MethodPost, ask), g.showOK, g.showR},
	})
	if rr := route(h.ClearConversation, http.MethodDelete, "")(g.kidRT, g.showR); rr.Code != http.StatusNoContent {
		t.Errorf("kid session clearing an over-ceiling show's conversation: status %d (%s), want 204", rr.Code, rr.Body.String())
	}
}

// progressRows counts profileID's progress rows on mediaID.
func progressRows(t *testing.T, profileID, mediaID int64) int {
	t.Helper()
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	var n int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM watch_progress WHERE profile_id = $1 AND media_item_id = $2`,
		profileID, mediaID).Scan(&n); err != nil {
		t.Fatalf("count progress: %v", err)
	}
	return n
}

// TestProgressHidesOverCeilingTitles: progress filed on any id came back as
// history and as an anchor rail's "Because you watched" title.
func TestProgressHidesOverCeilingTitles(t *testing.T) {
	g := newGateFixture(t)
	h := NewProgressHandler(g.q, nil)
	route := func(handler http.HandlerFunc, method, body string) func(rt, id int64) *httptest.ResponseRecorder {
		return func(rt, id int64) *httptest.ResponseRecorder {
			return gateCall(g.lockFixture, handler, method, rt, idParam("id", id), "", body)
		}
	}
	// The kid has progress on the R movie from before its ceiling, so an
	// ungated read would find it where a missing id finds nothing.
	ctx := context.Background()
	if _, err := g.q.UpsertWatchProgress(ctx, &models.WatchProgress{UserID: g.userID, ProfileID: g.kid.ID,
		MediaItemID: g.movieR, PositionMs: 5000, DurationMs: 600000}); err != nil {
		t.Fatalf("seed pre-ceiling progress: %v", err)
	}
	checkGate(t, g.lockFixture, []gateCase{
		{"update", route(h.UpdateProgress, http.MethodPut, `{"position_ms":1000,"duration_ms":600000}`), g.movieOK, g.movieR},
		{"mark watched", route(h.MarkWatched, http.MethodPost, `{}`), g.movieOK, g.movieR},
		{"read", route(h.GetProgress, http.MethodGet, ""), g.movieOK, g.movieR},
	})
	if wp, err := g.q.GetWatchProgressForProfile(ctx, g.userID, g.kid.ID, g.movieR, nil); err != nil || wp.PositionMs != 5000 || wp.Completed {
		t.Errorf("the kid's pre-ceiling progress on the R movie changed under the refused writes: %+v (err %v)", wp, err)
	}
	if n := progressRows(t, g.kid.ID, g.movieR); n != 1 {
		t.Errorf("kid profile has %d progress rows on the R movie, want the 1 seeded", n)
	}

	// An over-ceiling show's episode filed under an allowed show is judged on
	// its own show.
	body := `{"position_ms":1000,"duration_ms":600000,"episode_id":` + strconv.FormatInt(g.epR, 10) + `}`
	if rr := route(h.UpdateProgress, http.MethodPut, body)(g.kidRT, g.showOK); rr.Code != http.StatusNotFound {
		t.Errorf("kid session filing a TV-MA episode under a G show: status %d (%s), want 404", rr.Code, rr.Body.String())
	}
	if rr := route(h.MarkWatched, http.MethodPost, `{"episode_id":`+strconv.FormatInt(g.epR, 10)+`}`)(g.kidRT, g.showOK); rr.Code != http.StatusNotFound {
		t.Errorf("kid session marking a TV-MA episode watched under a G show: status %d (%s), want 404", rr.Code, rr.Body.String())
	}
	if rr := gateCall(g.lockFixture, h.GetProgress, http.MethodGet, g.kidRT, idParam("id", g.showOK),
		"episode_id="+strconv.FormatInt(g.epR, 10), ""); rr.Code != http.StatusNotFound || !strings.Contains(rr.Body.String(), "media not found") {
		t.Errorf("kid session reading a TV-MA episode's progress under a G show: %d %s, want the gate's 404", rr.Code, rr.Body.String())
	}
	body = `{"position_ms":1000,"duration_ms":600000,"episode_id":` + strconv.FormatInt(g.epOK, 10) + `}`
	if rr := route(h.UpdateProgress, http.MethodPut, body)(g.kidRT, g.showOK); rr.Code != http.StatusOK {
		t.Errorf("kid session filing the G show's own episode: status %d (%s), want 200", rr.Code, rr.Body.String())
	}

	// Deleting stays open, so a profile can clear what it can no longer see.
	if rr := gateCall(g.lockFixture, h.DeleteProgress, http.MethodDelete, g.kidRT, idParam("id", g.movieR), "", ""); rr.Code != http.StatusOK {
		t.Errorf("kid session deleting progress on the R movie: status %d (%s), want 200", rr.Code, rr.Body.String())
	}
}

// TestAParentNamingTheKidGetsTheKidsCeiling: a profile-keyed route takes
// the ceiling of the profile it acts on, not the session's. The parent naming
// the kid is refused an over-ceiling title, as the kid would be.
func TestAParentNamingTheKidGetsTheKidsCeiling(t *testing.T) {
	g := newGateFixture(t)
	hero := NewHeroHandler(g.q)
	hero.SetHeroProvider(&ratingFakeHero{})
	progress := NewProgressHandler(g.q, nil)
	recaps := &RecapHandler{queries: g.q, svc: recap.New(g.q, nil)}
	kid := "profile_id=" + strconv.FormatInt(g.kid.ID, 10)
	movieR := strconv.FormatInt(g.movieR, 10)
	kidList := &models.Watchlist{ProfileID: g.kid.ID, Name: "gate " + reqTestSuffix(t), ListType: "custom"}
	if err := g.q.CreateWatchlist(context.Background(), kidList); err != nil {
		t.Fatalf("seed the kid's watchlist: %v", err)
	}
	for name, rr := range map[string]*httptest.ResponseRecorder{
		"recap":         gateCall(g.lockFixture, recaps.Get, http.MethodGet, g.parentRT, idParam("id", g.showR), kid, ""),
		"progress read": gateCall(g.lockFixture, progress.GetProgress, http.MethodGet, g.parentRT, idParam("id", g.movieR), kid, ""),
		"progress write": gateCall(g.lockFixture, progress.UpdateProgress, http.MethodPut, g.parentRT, idParam("id", g.movieR), "",
			`{"position_ms":1000,"duration_ms":600000,"profile_id":`+strconv.FormatInt(g.kid.ID, 10)+`}`),
		"thumb":       gateCall(g.lockFixture, hero.Feedback, http.MethodPost, g.parentRT, nil, kid, `{"media_item_id":`+movieR+`,"direction":"up"}`),
		"star rating": gateCall(g.lockFixture, hero.SetRating, http.MethodPost, g.parentRT, nil, kid, `{"media_item_id":`+movieR+`,"stars":4}`),
		"watchlist add": gateCall(g.lockFixture, g.h.AddToWatchlist, http.MethodPost, g.parentRT,
			map[string]string{"profileId": strconv.FormatInt(g.kid.ID, 10), "listId": strconv.FormatInt(kidList.ID, 10)}, "",
			`{"media_item_id":`+movieR+`}`),
	} {
		if rr.Code != http.StatusNotFound || !strings.Contains(rr.Body.String(), "media not found") {
			t.Errorf("%s, parent naming the kid, over-ceiling title: %d %s; want the gate's 404", name, rr.Code, rr.Body.String())
		}
	}
}

// TestTheGateFailsClosedOnALookupError: a lookup that cannot answer hides
// the title.
func TestTheGateFailsClosedOnALookupError(t *testing.T) {
	q := requireRequestTestDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	restricted := &models.UserProfile{ID: 1, UserID: 1, MaxAgeRating: "PG"}
	claims := &auth.JWTClaims{UserID: 1, RefreshTokenID: 1}
	episode := int64(1)
	for name, check := range map[string]func() (bool, error){
		"media":          func() (bool, error) { return mediaHidden(ctx, q, restricted, 1) },
		"episode":        func() (bool, error) { return episodeHidden(ctx, q, restricted, 1) },
		"progress":       func() (bool, error) { return progressHidden(ctx, q, restricted, 1, &episode) },
		"acting media":   func() (bool, error) { return actingMediaHidden(ctx, q, claims, 1) },
		"acting episode": func() (bool, error) { return actingEpisodeHidden(ctx, q, claims, 1) },
	} {
		if hidden, err := check(); !hidden || err == nil {
			t.Errorf("%s: hidden=%v err=%v on a failed lookup; want hidden with the error", name, hidden, err)
		}
	}
}

// TestThumbsAndRatingsHideOverCeilingTitles: a thumb or a star rating on an
// over-ceiling id was stored, and answered 204 where a missing id got 404.
func TestThumbsAndRatingsHideOverCeilingTitles(t *testing.T) {
	g := newGateFixture(t)
	h := NewHeroHandler(g.q)
	h.SetHeroProvider(&ratingFakeHero{})
	route := func(handler http.HandlerFunc, field string) func(rt, id int64) *httptest.ResponseRecorder {
		return func(rt, id int64) *httptest.ResponseRecorder {
			body := `{"media_item_id":` + strconv.FormatInt(id, 10) + `,` + field + `}`
			return gateCall(g.lockFixture, handler, http.MethodPost, rt, nil, "", body)
		}
	}
	checkGate(t, g.lockFixture, []gateCase{
		{"thumb up", route(h.Feedback, `"direction":"up"`), g.movieOK, g.movieR},
		{"thumb down", route(h.Feedback, `"direction":"down"`), g.movieOK, g.movieR},
		{"star rating", route(h.SetRating, `"stars":4`), g.movieOK, g.movieR},
	})
	for name, rr := range map[string]*httptest.ResponseRecorder{
		"clear thumb":  route(h.Feedback, `"direction":"clear"`)(g.kidRT, g.movieR),
		"clear rating": route(h.SetRating, `"stars":0`)(g.kidRT, g.movieR),
	} {
		if rr.Code != http.StatusNoContent {
			t.Errorf("kid session, %s on the R movie: status %d (%s), want 204", name, rr.Code, rr.Body.String())
		}
	}
}

// listedIDs decodes a My Library array or a paginated watchlist page.
func listedIDs(t *testing.T, rr *httptest.ResponseRecorder) (map[int64]bool, int64) {
	t.Helper()
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var items []models.WatchlistItem
	total := int64(-1)
	if err := json.Unmarshal(rr.Body.Bytes(), &items); err != nil {
		var page struct {
			Data       []models.WatchlistItem `json:"data"`
			TotalItems int64                  `json:"total_items"`
		}
		if err2 := json.Unmarshal(rr.Body.Bytes(), &page); err2 != nil {
			t.Fatalf("decode: %v / %v", err, err2)
		}
		items, total = page.Data, page.TotalItems
	}
	ids := map[int64]bool{}
	for _, it := range items {
		ids[it.MediaItemID] = true
	}
	return ids, total
}

// TestListsHideOverCeilingTitles: watchlist and My Library writes took any
// id, and their reads listed whatever the list held, including titles saved
// before the profile had a ceiling. A list route uses the ceiling of the
// profile it names, so the parent naming the kid's lists gets the kid's.
func TestListsHideOverCeilingTitles(t *testing.T) {
	g := newGateFixture(t)
	ctx := context.Background()
	watchlist := func(profileID int64) int64 {
		wl := &models.Watchlist{ProfileID: profileID, Name: "gate " + reqTestSuffix(t), ListType: "custom"}
		if err := g.q.CreateWatchlist(ctx, wl); err != nil {
			t.Fatalf("seed watchlist: %v", err)
		}
		return wl.ID
	}
	library := func(profileID int64) int64 {
		wl, err := g.q.GetOrCreateLibraryWatchlist(ctx, profileID)
		if err != nil {
			t.Fatalf("seed My Library: %v", err)
		}
		return wl.ID
	}
	kidList, parentList := watchlist(g.kid.ID), watchlist(g.parent.ID)
	kidLibrary := library(g.kid.ID)

	// The R movie was saved to both of the kid's lists before the kid had a
	// ceiling. Saved first, it leads the watchlist's sort order, so a ceiling
	// applied after LIMIT would leave a one-row page empty.
	for _, list := range []int64{kidList, kidLibrary} {
		if err := g.q.AddToWatchlist(ctx, list, g.movieR); err != nil {
			t.Fatalf("seed a pre-ceiling save: %v", err)
		}
	}

	listParams := func(profileID, listID int64) map[string]string {
		return map[string]string{"profileId": strconv.FormatInt(profileID, 10), "listId": strconv.FormatInt(listID, 10)}
	}
	// Each session adds to its own profile's lists.
	own := func(rt int64, kid, parent map[string]string) map[string]string {
		if rt == g.kidRT {
			return kid
		}
		return parent
	}
	add := func(handler http.HandlerFunc, kid, parent map[string]string) func(rt, id int64) *httptest.ResponseRecorder {
		return func(rt, id int64) *httptest.ResponseRecorder {
			return gateCall(g.lockFixture, handler, http.MethodPost, rt, own(rt, kid, parent), "",
				`{"media_item_id":`+strconv.FormatInt(id, 10)+`}`)
		}
	}
	checkGate(t, g.lockFixture, []gateCase{
		{"watchlist add", add(g.h.AddToWatchlist, listParams(g.kid.ID, kidList), listParams(g.parent.ID, parentList)), g.movieOK, g.movieR},
		{"My Library add", add(g.h.AddToLibrary, idParam("profileId", g.kid.ID), idParam("profileId", g.parent.ID)), g.movieOK, g.movieR},
	})
	if rr := gateCall(g.lockFixture, g.h.AddToLibrary, http.MethodPost, g.parentRT, idParam("profileId", g.kid.ID), "",
		`{"media_item_id":`+strconv.FormatInt(g.showR, 10)+`}`); rr.Code != http.StatusNotFound {
		t.Errorf("parent session saving a TV-MA show to the kid's My Library: status %d (%s), want 404", rr.Code, rr.Body.String())
	}

	// The lists' own index counts only what the list shows.
	for _, s := range []struct {
		who string
		rt  int64
	}{{"kid session", g.kidRT}, {"parent session naming the kid", g.parentRT}} {
		rr := gateCall(g.lockFixture, g.h.ListWatchlists, http.MethodGet, s.rt, idParam("profileId", g.kid.ID), "", "")
		var lists []models.Watchlist
		if err := json.Unmarshal(rr.Body.Bytes(), &lists); rr.Code != http.StatusOK || err != nil {
			t.Fatalf("%s, list watchlists: %d %s", s.who, rr.Code, rr.Body.String())
		}
		for _, l := range lists {
			if l.ID == kidList && l.ItemCount != 1 {
				t.Errorf("%s: the kid's watchlist reports %d items, want 1 (the R movie is hidden)", s.who, l.ItemCount)
			}
		}
	}

	wl, _, err := g.q.GetWatchlistItems(ctx, kidList, models.PaginationParams{Page: 1, PerPage: 10}, nil)
	if err != nil || len(wl) != 2 || wl[0].MediaItemID != g.movieR || wl[1].MediaItemID != g.movieOK {
		t.Fatalf("precondition: the kid's watchlist should hold the R then the PG movie, got %d rows (err %v)", len(wl), err)
	}

	for _, s := range []struct {
		who string
		rt  int64
	}{{"kid session", g.kidRT}, {"parent session naming the kid", g.parentRT}} {
		ids, total := listedIDs(t, gateCall(g.lockFixture, g.h.GetWatchlistItems, http.MethodGet, s.rt,
			listParams(g.kid.ID, kidList), "per_page=1", ""))
		if !ids[g.movieOK] || ids[g.movieR] || total != 1 {
			t.Errorf("%s, watchlist page of one: PG listed=%v, R listed=%v, total %d; want the PG movie and a total of 1",
				s.who, ids[g.movieOK], ids[g.movieR], total)
		}
		ids, _ = listedIDs(t, gateCall(g.lockFixture, g.h.GetLibrary, http.MethodGet, s.rt,
			idParam("profileId", g.kid.ID), "", ""))
		if !ids[g.movieOK] || ids[g.movieR] {
			t.Errorf("%s, My Library: PG listed=%v, R listed=%v; want the PG movie only", s.who, ids[g.movieOK], ids[g.movieR])
		}
	}

	// The parent's own lists have no ceiling; checkGate saved the R movie to
	// both.
	if ids, _ := listedIDs(t, gateCall(g.lockFixture, g.h.GetLibrary, http.MethodGet, g.parentRT,
		idParam("profileId", g.parent.ID), "", "")); !ids[g.movieR] {
		t.Errorf("parent session lost the R movie from its own My Library")
	}
	if ids, _ := listedIDs(t, gateCall(g.lockFixture, g.h.GetWatchlistItems, http.MethodGet, g.parentRT,
		listParams(g.parent.ID, parentList), "", "")); !ids[g.movieR] {
		t.Errorf("parent session lost the R movie from its own watchlist")
	}
}

// onboardingFixture seeds embedded, postered titles in a random direction of
// a gateFixture's library: three PG picks, a PG and an R title near them, at
// a popularity no other fixture uses so they head the popularity grid.
type onboardingFixture struct {
	*gateFixture
	picks         []int64
	nearPG, nearR int64
}

func newOnboardingFixture(t *testing.T) *onboardingFixture {
	t.Helper()
	f := newGateFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	var libID int64
	if err := pool.QueryRow(ctx, `SELECT library_id FROM media_items WHERE id = $1`, f.movieOK).Scan(&libID); err != nil {
		t.Fatalf("read library: %v", err)
	}
	a, b := 400+int(time.Now().UnixNano()%90), 500+int(time.Now().UnixNano()/7%90)
	vec := func(offset float64) string {
		v := make([]string, 768)
		for i := range v {
			v[i] = "0"
		}
		v[a], v[b], v[595] = "1", "1", strconv.FormatFloat(offset, 'f', 4, 64)
		return "[" + strings.Join(v, ",") + "]"
	}
	item := func(name, rating string, offset float64) int64 {
		var id int64
		if err := pool.QueryRow(ctx, `
			INSERT INTO media_items (library_id, type, title, sort_title, year, overview, rating, runtime_minutes,
			                         content_rating, poster_path, backdrop_path, embedding, popularity, added_at, last_metadata_attempt)
			VALUES ($1, 'movie', $2, $2, 0, '', 0, 0, $3, '/p.jpg', '/b.jpg', $4::vector, 1e12, NOW() - interval '30 days', NOW())
			RETURNING id`, libID, "Onboarding "+name+" "+reqTestSuffix(t), rating, vec(offset)).Scan(&id); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
		return id
	}
	o := &onboardingFixture{gateFixture: f}
	for i := 0; i < 3; i++ {
		o.picks = append(o.picks, item(fmt.Sprintf("pick %d", i), "PG", 0.01*float64(i)))
	}
	o.nearPG, o.nearR = item("near pg", "PG", 0.05), item("near r", "R", 0.04)
	return o
}

func onboardingItemIDs(t *testing.T, rr *httptest.ResponseRecorder) map[int64]bool {
	t.Helper()
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var body struct {
		Items []struct {
			ID int64 `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	out := map[int64]bool{}
	for _, it := range body.Items {
		out[it.ID] = true
	}
	return out
}

// TestTheOnboardingGridAndPreviewApplyTheCeiling drives the two handlers, so
// a handler that stopped passing the profile's ceiling to its queries is
// caught; the queries themselves are pinned in the db package.
func TestTheOnboardingGridAndPreviewApplyTheCeiling(t *testing.T) {
	o := newOnboardingFixture(t)
	h := NewOnboardingHandler(o.q)
	selected := fmt.Sprintf("selected=%d,%d,%d", o.picks[0], o.picks[1], o.picks[2])
	for _, tc := range []struct {
		name string
		call func(rt int64) *httptest.ResponseRecorder
	}{
		{"grid", func(rt int64) *httptest.ResponseRecorder {
			return gateCall(o.lockFixture, h.Grid, http.MethodGet, rt, nil, "limit=100", "")
		}},
		{"preview", func(rt int64) *httptest.ResponseRecorder {
			return gateCall(o.lockFixture, h.Preview, http.MethodGet, rt, nil, selected, "")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			kid := onboardingItemIDs(t, tc.call(o.kidRT))
			if kid[o.nearR] || !kid[o.nearPG] {
				t.Errorf("the kid's %s: R title %v, PG title %v; want only the PG one", tc.name, kid[o.nearR], kid[o.nearPG])
			}
			if parent := onboardingItemIDs(t, tc.call(o.parentRT)); !parent[o.nearR] || !parent[o.nearPG] {
				t.Errorf("the parent's %s is missing a title: R %v, PG %v", tc.name, parent[o.nearR], parent[o.nearPG])
			}
		})
	}
}

// TestSavingSeedsDoesNotSayWhichIdsExist: the embedded count ran before the
// rating check and counted only existing rows, and a missing id that got past
// both failed the seeds' foreign key, so a restricted session's picks told an
// over-ceiling id (400) from a missing one (500), and with fewer picks the two
// refusals differed too.
func TestSavingSeedsDoesNotSayWhichIdsExist(t *testing.T) {
	o := newOnboardingFixture(t)
	h := NewOnboardingHandler(o.q)
	save := func(ids ...int64) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string][]int64{"media_ids": ids})
		return gateCall(o.lockFixture, h.SaveSeeds, http.MethodPost, o.kidRT, nil, "", string(body))
	}
	// Five picks pass the minimum; movieOK and showOK are allowed but have no
	// embedding.
	for _, picks := range [][]int64{
		{o.picks[0], o.picks[1], o.picks[2], o.nearPG}, // enough embedded picks either way
		{o.picks[0], o.picks[1], o.movieOK, o.showOK},  // one embedded pick short without the extra id
	} {
		over := save(append(append([]int64{}, picks...), o.nearR)...)
		missing := save(append(append([]int64{}, picks...), missingID)...)
		if over.Code != http.StatusBadRequest || over.Code != missing.Code || over.Body.String() != missing.Body.String() {
			t.Errorf("%d picks plus an over-ceiling id: %d %q; plus a missing id: %d %q; want one 400 for both",
				len(picks), over.Code, over.Body.String(), missing.Code, missing.Body.String())
		}
	}
}
