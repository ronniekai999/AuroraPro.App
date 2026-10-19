package api

// Handler tests for resolveRequestProfile: the profile-keyed routes (the
// recommendation rails, onboarding, the follow feed, recaps, progress,
// watchlists and My Library) used to accept any owned ?profile_id=, and fall
// back to the account DEFAULT without one. A session acting as a kid profile
// could therefore read the parent profile's rails, history and recaps just by
// naming it, profile lock or not. Opt-in via TEST_DATABASE_URL.

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// rpReq builds a request as session rt, with an optional ?profile_id=
// and chi URL params.
func rpReq(f *lockFixture, method, path string, rt, profileID int64, urlParams map[string]string) *http.Request {
	if profileID != 0 {
		path += "?profile_id=" + strconv.FormatInt(profileID, 10)
	}
	r := httptest.NewRequest(method, path, nil)
	rctx := chi.NewRouteContext()
	for k, v := range urlParams {
		rctx.URLParams.Add(k, v)
	}
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	return rcClaimsCtx(r, f.userID, rt)
}

func errorReason(rr *httptest.ResponseRecorder) string {
	var env struct {
		Error struct {
			Reason string `json:"reason"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &env)
	return env.Error.Reason
}

// TestProfileKeyedRoutesScopeARestrictedSessionToItself runs every resolver
// the profile-keyed routes use. For each: the kid's session with no
// profile_id gets the kid (not the default parent), naming the parent is a
// 403 profile_restricted, and the parent's session may still name the kid.
func TestProfileKeyedRoutesScopeARestrictedSessionToItself(t *testing.T) {
	f := newLockFixture(t)
	other := seedReqUser(t, f.q)
	foreign, err := f.q.CreateDefaultProfileForUser(context.Background(), other, "someone else")
	if err != nil {
		t.Fatalf("seed another account's profile: %v", err)
	}

	type resolver func(w http.ResponseWriter, r *http.Request) (int64, bool)
	resolvers := map[string]resolver{
		"hero (rails, feedback, rating)": func(w http.ResponseWriter, r *http.Request) (int64, bool) {
			return NewHeroHandler(f.q).resolveProfileID(w, r, f.userID)
		},
		"recap": func(w http.ResponseWriter, r *http.Request) (int64, bool) {
			return (&RecapHandler{queries: f.q}).resolveProfileID(w, r, f.userID)
		},
		"onboarding": func(w http.ResponseWriter, r *http.Request) (int64, bool) {
			p, ok := NewOnboardingHandler(f.q).resolveProfile(w, r, f.userID)
			if !ok {
				return 0, false
			}
			return p.ID, true
		},
		"follow feed": func(w http.ResponseWriter, r *http.Request) (int64, bool) {
			p, ok := NewSocialHandler(f.q).resolveViewerProfile(w, r, f.userID)
			if !ok {
				return 0, false
			}
			return p.ID, true
		},
		"progress": func(w http.ResponseWriter, r *http.Request) (int64, bool) {
			var requested *int64
			if raw := r.URL.Query().Get("profile_id"); raw != "" {
				id, _ := strconv.ParseInt(raw, 10, 64)
				requested = &id
			}
			p, ok := NewProgressHandler(f.q, nil).resolveProgressProfile(w, r, f.userID, requested)
			if !ok {
				return 0, false
			}
			return p.ID, true
		},
		"watchlists and My Library": func(w http.ResponseWriter, r *http.Request) (int64, bool) {
			// {profileId} comes from the URL here, so a request "naming" a
			// profile carries it there instead; none means the acting one.
			rctx := chi.RouteContext(r.Context())
			pid := r.URL.Query().Get("profile_id")
			if pid == "" {
				claimsProfile, err := f.q.ResolveActingProfile(r.Context(), f.userID, rtFromRequest(r))
				if err != nil {
					t.Fatalf("resolve acting profile: %v", err)
				}
				pid = strconv.FormatInt(claimsProfile.ID, 10)
			}
			rctx.URLParams.Add("profileId", pid)
			return NewProfileHandler(f.q).requireProfileOwnership(w, r)
		},
	}

	for name, resolve := range resolvers {
		t.Run(name, func(t *testing.T) {
			run := func(rt, named int64) (int64, bool, *httptest.ResponseRecorder) {
				rr := httptest.NewRecorder()
				id, ok := resolve(rr, rpReq(f, http.MethodGet, "/x", rt, named, nil))
				return id, ok, rr
			}
			if id, ok, rr := run(f.kidRT, 0); !ok || id != f.kid.ID {
				t.Errorf("kid session, no profile_id: got %d ok=%v (status %d), want the kid profile %d", id, ok, rr.Code, f.kid.ID)
			}
			if id, ok, rr := run(f.kidRT, f.kid.ID); !ok || id != f.kid.ID {
				t.Errorf("kid session naming itself: got %d ok=%v (status %d), want %d", id, ok, rr.Code, f.kid.ID)
			}
			if _, ok, rr := run(f.kidRT, f.parent.ID); ok || rr.Code != http.StatusForbidden || errorReason(rr) != "profile_restricted" {
				t.Errorf("kid session naming the parent: ok=%v status %d reason %q, want 403 profile_restricted", ok, rr.Code, errorReason(rr))
			}
			if id, ok, rr := run(f.parentRT, f.kid.ID); !ok || id != f.kid.ID {
				t.Errorf("parent session naming the kid: got %d ok=%v (status %d), want %d", id, ok, rr.Code, f.kid.ID)
			}
			if id, ok, rr := run(f.parentRT, 0); !ok || id != f.parent.ID {
				t.Errorf("parent session, no profile_id: got %d ok=%v (status %d), want %d", id, ok, rr.Code, f.parent.ID)
			}
			if _, ok, rr := run(f.parentRT, foreign.ID); ok || rr.Code != http.StatusForbidden {
				t.Errorf("naming another account's profile: ok=%v status %d, want 403", ok, rr.Code)
			}
		})
	}
}

// rtFromRequest reads the refresh-token id the test's claims carry.
func rtFromRequest(r *http.Request) int64 {
	if c := auth.GetClaims(r.Context()); c != nil {
		return c.RefreshTokenID
	}
	return 0
}

// historyFixture adds titles and progress to a lockFixture: a PG title and
// an R title in progress on the kid profile (the R progress predates its
// ceiling, which nothing prevents), and an R and a G title the parent
// watched. The parent's G title passes the kid's ceiling, so only profile
// scoping keeps it out of the kid's history.
type historyFixture struct {
	*lockFixture
	kidPG, kidR, parentR, parentG int64
}

func newHistoryFixture(t *testing.T) *historyFixture {
	t.Helper()
	f := newLockFixture(t)
	ctx := context.Background()
	lib := &models.Library{Name: "history_" + reqTestSuffix(t), Type: models.LibraryType("movie"), Paths: []string{t.TempDir()},
		ScanInterval: 60, OwnerID: f.userID}
	if err := f.q.CreateLibrary(ctx, lib); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = f.q.DeleteLibrary(context.Background(), lib.ID) })
	seed := func(name, rating string) int64 {
		it := &models.MediaItem{LibraryID: lib.ID, Type: models.MediaMovie, Title: "History " + name + " " + reqTestSuffix(t),
			SortTitle: "history " + name, ContentRating: rating}
		if err := f.q.UpsertMediaItem(ctx, it); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
		return it.ID
	}
	h := &historyFixture{lockFixture: f, kidPG: seed("kid pg", "PG"), kidR: seed("kid r", "R"),
		parentR: seed("parent r", "R"), parentG: seed("parent g", "G")}

	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	// The over-ceiling rows are the most recent, so a ceiling applied after
	// LIMIT (in Go) would leave a one-row page empty.
	progress := func(profileID, mediaID int64, ago string) {
		if _, err := pool.Exec(ctx, `INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed, updated_at)
			VALUES ($1, $2, $3, 600000, 5400000, FALSE, NOW() - $4::interval)`, f.userID, profileID, mediaID, ago); err != nil {
			t.Fatalf("seed progress: %v", err)
		}
	}
	progress(f.kid.ID, h.kidPG, "2 minutes")
	progress(f.kid.ID, h.kidR, "1 minute")
	progress(f.parent.ID, h.parentR, "0 seconds")
	progress(f.parent.ID, h.parentG, "3 minutes")
	return h
}

func cwIDs(t *testing.T, rr *httptest.ResponseRecorder) map[int64]bool {
	t.Helper()
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	var items []models.ContinueWatchingItem
	if err := json.Unmarshal(rr.Body.Bytes(), &items); err != nil {
		var page struct {
			Data []models.ContinueWatchingItem `json:"data"`
		}
		if err2 := json.Unmarshal(rr.Body.Bytes(), &page); err2 != nil {
			t.Fatalf("decode: %v / %v", err, err2)
		}
		items = page.Data
	}
	ids := map[int64]bool{}
	for _, it := range items {
		ids[it.MediaItemID] = true
	}
	return ids
}

// TestContinueWatchingAppliesTheProfileCeiling: Continue Watching used to
// list a profile's progress with no ceiling, so progress recorded before a
// ceiling (or written through PUT /api/progress) kept an over-ceiling title
// on a kid's Home.
func TestContinueWatchingAppliesTheProfileCeiling(t *testing.T) {
	f := newHistoryFixture(t)
	h := NewProgressHandler(f.q, nil)
	get := func(rt, named int64) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		h.ContinueWatching(rr, rpReq(f.lockFixture, http.MethodGet, "/api/progress/continue", rt, named, nil))
		return rr
	}

	kid := cwIDs(t, get(f.kidRT, 0))
	if !kid[f.kidPG] || kid[f.kidR] {
		t.Errorf("kid session: PG title shown=%v, R title shown=%v; want the PG title only", kid[f.kidPG], kid[f.kidR])
	}
	rr := httptest.NewRecorder()
	h.ContinueWatching(rr, rpReq(f.lockFixture, http.MethodGet, "/api/progress/continue?limit=1", f.kidRT, 0, nil))
	if one := cwIDs(t, rr); !one[f.kidPG] {
		t.Errorf("kid session, limit=1: got %v, want the PG title; the ceiling must apply before LIMIT", one)
	}
	if rr := get(f.kidRT, f.parent.ID); rr.Code != http.StatusForbidden {
		t.Errorf("kid session naming the parent: status %d, want 403", rr.Code)
	}
	// The parent naming the kid gets the kid's rows under the kid's ceiling.
	viaParent := cwIDs(t, get(f.parentRT, f.kid.ID))
	if !viaParent[f.kidPG] || viaParent[f.kidR] {
		t.Errorf("parent naming the kid: PG shown=%v, R shown=%v; want the PG title only", viaParent[f.kidPG], viaParent[f.kidR])
	}
	parent := cwIDs(t, get(f.parentRT, 0))
	if !parent[f.parentR] {
		t.Errorf("parent session lost its own R title from Continue Watching")
	}
}

// TestAccountHistoryIsScopedForARestrictedSession: /api/progress/recent and
// /history are account-wide, so a kid's session listed every title the
// parents watched. A restricted session now sees only its own rows, under its
// ceiling; an unrestricted one still sees the whole account.
func TestAccountHistoryIsScopedForARestrictedSession(t *testing.T) {
	f := newHistoryFixture(t)
	h := NewProgressHandler(f.q, nil)
	for name, handler := range map[string]http.HandlerFunc{"recent": h.RecentlyWatched, "history": h.WatchHistory} {
		t.Run(name, func(t *testing.T) {
			get := func(rt int64) map[int64]bool {
				rr := httptest.NewRecorder()
				handler(rr, rpReq(f.lockFixture, http.MethodGet, "/api/progress/"+name, rt, 0, nil))
				return cwIDs(t, rr)
			}
			kid := get(f.kidRT)
			if kid[f.parentR] || kid[f.parentG] || kid[f.kidR] || !kid[f.kidPG] {
				t.Errorf("kid session: parent's R=%v, parent's G=%v, own R=%v, own PG=%v; want only its own PG title",
					kid[f.parentR], kid[f.parentG], kid[f.kidR], kid[f.kidPG])
			}
			// One row, behind two newer over-ceiling rows: the scope must
			// apply before LIMIT.
			rr := httptest.NewRecorder()
			handler(rr, rpReq(f.lockFixture, http.MethodGet, "/api/progress/"+name+"?limit=1&per_page=1", f.kidRT, 0, nil))
			if one := cwIDs(t, rr); !one[f.kidPG] {
				t.Errorf("kid session, one row: got %v, want its PG title; the scope must apply before LIMIT", one)
			}
			if name == "history" {
				var page struct {
					TotalItems int64 `json:"total_items"`
				}
				if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil || page.TotalItems != 1 {
					t.Errorf("kid session: history total %d (err %v), want 1; the count must be scoped too", page.TotalItems, err)
				}
			}
			parent := get(f.parentRT)
			if !parent[f.parentR] || !parent[f.parentG] || !parent[f.kidR] || !parent[f.kidPG] {
				t.Errorf("parent session: parent's R=%v, parent's G=%v, kid's R=%v, kid's PG=%v; want the whole account",
					parent[f.parentR], parent[f.parentG], parent[f.kidR], parent[f.kidPG])
			}
		})
	}
}

// failingProfileStore fails ResolveActingProfile.
type failingProfileStore struct{}

func (failingProfileStore) GetProfile(context.Context, int64) (*models.UserProfile, error) {
	return &models.UserProfile{ID: 1, UserID: 1}, nil
}
func (failingProfileStore) ResolveActingProfile(context.Context, int64, int64) (*models.UserProfile, error) {
	return nil, errors.New("database unavailable")
}

// TestResolveRequestProfileFailsClosed: an acting-profile resolve error is a
// 500, never a fallback to the named or the default profile.
func TestResolveRequestProfileFailsClosed(t *testing.T) {
	for _, named := range []int64{0, 1} {
		rr := httptest.NewRecorder()
		r := rcClaimsCtx(httptest.NewRequest(http.MethodGet, "/x", nil), 1, 7)
		if p, ok := resolveRequestProfile(rr, r, failingProfileStore{}, named); ok || p != nil {
			t.Errorf("named %d: resolved %+v on a resolve error, want a refusal", named, p)
		}
		if rr.Code != http.StatusInternalServerError {
			t.Errorf("named %d: status %d, want 500", named, rr.Code)
		}
	}
}

// TestProfileKeyedHandlersRefuseARestrictedSessionNamingAnother drives the
// read handlers themselves, not their resolvers, so a handler that stopped
// calling its resolver is caught; the next test does the writes.
func TestProfileKeyedHandlersRefuseARestrictedSessionNamingAnother(t *testing.T) {
	f := newLockFixture(t)
	hero := NewHeroHandler(f.q)
	hero.SetHeroProvider(&ratingFakeHero{})
	recaps := &RecapHandler{queries: f.q}
	progress := NewProgressHandler(f.q, nil)
	onboarding := NewOnboardingHandler(f.q)
	social := NewSocialHandler(f.q)
	media := map[string]string{"id": "1"}
	parentSegment := map[string]string{"profileId": strconv.FormatInt(f.parent.ID, 10)}
	for name, c := range map[string]struct {
		handler http.HandlerFunc
		params  map[string]string
		query   bool // the profile goes in ?profile_id=, else in params
	}{
		"hero":               {hero.Get, nil, true},
		"hero rail":          {hero.Rail, nil, true},
		"discover":           {hero.Discover, nil, true},
		"engagement rails":   {hero.EngagementRails, nil, true},
		"anchor rails":       {hero.AnchorRails, nil, true},
		"star rating":        {hero.GetRating, nil, true},
		"recap":              {recaps.Get, media, true},
		"recap status":       {recaps.Status, media, true},
		"recap conversation": {recaps.Conversation, media, true},
		"progress":           {progress.GetProgress, media, true},
		"continue watching":  {progress.ContinueWatching, nil, true},
		"onboarding status":  {onboarding.Status, nil, true},
		"onboarding grid":    {onboarding.Grid, nil, true},
		"onboarding preview": {onboarding.Preview, nil, true},
		"follow feed":        {social.FollowingRecent, nil, true},
		"watchlists":         {f.h.ListWatchlists, parentSegment, false},
		"watchlist items": {f.h.GetWatchlistItems,
			map[string]string{"profileId": strconv.FormatInt(f.parent.ID, 10), "listId": "1"}, false},
		"My Library": {f.h.GetLibrary, parentSegment, false},
	} {
		t.Run(name, func(t *testing.T) {
			named := int64(0)
			if c.query {
				named = f.parent.ID
			}
			rr := httptest.NewRecorder()
			c.handler(rr, rpReq(f, http.MethodGet, "/x", f.kidRT, named, c.params))
			if rr.Code != http.StatusForbidden || errorReason(rr) != "profile_restricted" {
				t.Errorf("kid session naming the parent: status %d reason %q (%s), want 403 profile_restricted",
					rr.Code, errorReason(rr), rr.Body.String())
			}
		})
	}
}

// TestProfileKeyedWritesRefuseARestrictedSessionNamingAnother is the same
// for the write handlers, each driven with the parent's profile where it
// reads one: ?profile_id=, a body profile_id, or the {profileId} segment.
func TestProfileKeyedWritesRefuseARestrictedSessionNamingAnother(t *testing.T) {
	f := newLockFixture(t)
	hero := NewHeroHandler(f.q)
	hero.SetHeroProvider(&ratingFakeHero{})
	recaps := &RecapHandler{queries: f.q}
	progress := NewProgressHandler(f.q, nil)
	onboarding := NewOnboardingHandler(f.q)
	parent := strconv.FormatInt(f.parent.ID, 10)
	media := map[string]string{"id": "1"}
	segment := map[string]string{"profileId": parent}
	for name, c := range map[string]struct {
		handler http.HandlerFunc
		method  string
		params  map[string]string
		query   bool // the profile goes in ?profile_id=, else in the body or params
		body    string
	}{
		"progress write":     {progress.UpdateProgress, http.MethodPut, media, false, `{"position_ms":1,"duration_ms":10,"profile_id":` + parent + `}`},
		"mark watched":       {progress.MarkWatched, http.MethodPost, media, false, `{"profile_id":` + parent + `}`},
		"clear progress":     {progress.DeleteProgress, http.MethodDelete, media, true, ""},
		"thumb":              {hero.Feedback, http.MethodPost, nil, true, `{"media_item_id":1,"direction":"up"}`},
		"star rating":        {hero.SetRating, http.MethodPost, nil, true, `{"media_item_id":1,"stars":4}`},
		"exposure":           {hero.Exposure, http.MethodPost, nil, true, `{}`},
		"recap question":     {recaps.AskTurn, http.MethodPost, media, true, `{}`},
		"recap clear":        {recaps.ClearConversation, http.MethodDelete, media, true, ""},
		"recap unsafe clear": {recaps.ClearUnsafeTurns, http.MethodDelete, media, true, ""},
		"onboarding seeds":   {onboarding.SaveSeeds, http.MethodPost, nil, true, `{"media_ids":[]}`},
		"onboarding skip":    {onboarding.Skip, http.MethodPost, nil, true, ""},
		"onboarding reset":   {onboarding.Reset, http.MethodDelete, nil, true, ""},
		"watchlist create":   {f.h.CreateWatchlist, http.MethodPost, segment, false, `{"name":"x"}`},
		"My Library add":     {f.h.AddToLibrary, http.MethodPost, segment, false, `{"media_item_id":1}`},
		"My Library remove": {f.h.RemoveFromLibrary, http.MethodDelete,
			map[string]string{"profileId": parent, "mediaItemId": "1"}, false, ""},
		"watchlist add": {f.h.AddToWatchlist, http.MethodPost,
			map[string]string{"profileId": parent, "listId": "1"}, false, `{"media_item_id":1}`},
		"watchlist remove": {f.h.RemoveFromWatchlist, http.MethodDelete,
			map[string]string{"profileId": parent, "listId": "1", "itemId": "1"}, false, ""},
		"watchlist delete": {f.h.DeleteWatchlist, http.MethodDelete,
			map[string]string{"profileId": parent, "listId": "1"}, false, ""},
	} {
		t.Run(name, func(t *testing.T) {
			target := "/x"
			if c.query {
				target += "?profile_id=" + parent
			}
			r := httptest.NewRequest(c.method, target, strings.NewReader(c.body))
			r.Header.Set("Content-Type", "application/json")
			rctx := chi.NewRouteContext()
			for k, v := range c.params {
				rctx.URLParams.Add(k, v)
			}
			r = rcClaimsCtx(r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx)), f.userID, f.kidRT)
			rr := httptest.NewRecorder()
			c.handler(rr, r)
			if rr.Code != http.StatusForbidden || errorReason(rr) != "profile_restricted" {
				t.Errorf("kid session naming the parent: status %d reason %q (%s), want 403 profile_restricted",
					rr.Code, errorReason(rr), rr.Body.String())
			}
		})
	}
}

// TestPlaybackTelemetryIsAttributedToTheActingProfile: the QoE beacons
// resolved their profile on their own, taking any owned profile_id and
// falling back to the account default, so a kid's session wrote (and spent
// the hourly budget of) the parent's telemetry.
func TestPlaybackTelemetryIsAttributedToTheActingProfile(t *testing.T) {
	f := newLockFixture(t)
	h := &PlaybackQoEHandler{queries: f.q}
	resolve := func(rt, named int64) (int64, bool) {
		return h.resolveProfile(rpReq(f, http.MethodPost, "/x", rt, 0, nil), f.userID, named)
	}
	if id, ok := resolve(f.kidRT, 0); !ok || id != f.kid.ID {
		t.Errorf("kid session naming nothing: got profile %d ok=%v, want the kid (%d)", id, ok, f.kid.ID)
	}
	if id, ok := resolve(f.kidRT, f.parent.ID); ok {
		t.Errorf("kid session naming the parent: attributed to profile %d, want a refusal", id)
	}
	if id, ok := resolve(f.parentRT, f.kid.ID); !ok || id != f.kid.ID {
		t.Errorf("parent session naming the kid: got profile %d ok=%v, want the kid (%d)", id, ok, f.kid.ID)
	}
}

// TestMemberPageHistoryFollowsTheViewingSession: a member page's watch strip
// is the subject's default-profile history. A kid's session opening its own
// account's page read the parent's whole history through it, and on another
// member's page it saw titles over its ceiling.
func TestMemberPageHistoryFollowsTheViewingSession(t *testing.T) {
	f := newHistoryFixture(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	// The parent, the account default, finished its R and G titles.
	exec(`UPDATE watch_progress SET completed = TRUE, completed_at = NOW() WHERE profile_id = $1`, f.parent.ID)
	// Another member shares a history of the same two titles.
	other := seedReqUser(t, f.q)
	otherDefault, err := f.q.CreateDefaultProfileForUser(ctx, other, "other")
	if err != nil {
		t.Fatalf("seed the other member's profile: %v", err)
	}
	for _, id := range []int64{f.parentR, f.parentG} {
		exec(`INSERT INTO watch_progress (user_id, profile_id, media_item_id, position_ms, duration_ms, completed, completed_at)
			VALUES ($1, $2, $3, 0, 0, TRUE, NOW())`, other, otherDefault.ID, id)
	}
	exec(`UPDATE users SET share_watch_history = TRUE WHERE id = $1`, other)
	username := func(id int64) string {
		u, err := f.q.GetUserByID(ctx, id)
		if err != nil || u == nil {
			t.Fatalf("read user %d: %v", id, err)
		}
		return u.Username
	}

	social := NewSocialHandler(f.q)
	page := func(rt int64, of string) memberProfileResponse {
		t.Helper()
		rr := httptest.NewRecorder()
		social.MemberProfile(rr, rpReq(f.lockFixture, http.MethodGet, "/x", rt, 0, map[string]string{"username": of}))
		if rr.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
		}
		var resp memberProfileResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return resp
	}
	shown := func(resp memberProfileResponse) map[int64]bool {
		ids := map[int64]bool{}
		for _, w := range resp.RecentWatches {
			ids[w.ID] = true
		}
		return ids
	}

	own := username(f.userID)
	if resp := page(f.kidRT, own); resp.HistoryVisible || len(resp.RecentWatches) != 0 {
		t.Errorf("kid session on its own account's page: history_visible=%v with %d titles; want no strip",
			resp.HistoryVisible, len(resp.RecentWatches))
	}
	if ids := shown(page(f.parentRT, own)); !ids[f.parentR] || !ids[f.parentG] {
		t.Errorf("parent session on its own page: R shown=%v, G shown=%v; want both", ids[f.parentR], ids[f.parentG])
	}
	theirs := username(other)
	if ids := shown(page(f.kidRT, theirs)); ids[f.parentR] || !ids[f.parentG] {
		t.Errorf("kid session on a sharing member's page: R shown=%v, G shown=%v; want only the G title", ids[f.parentR], ids[f.parentG])
	}
	if ids := shown(page(f.parentRT, theirs)); !ids[f.parentR] || !ids[f.parentG] {
		t.Errorf("parent session on a sharing member's page: R shown=%v, G shown=%v; want both", ids[f.parentR], ids[f.parentG])
	}
}

// TestARestrictedSessionCannotEditTheMemberProfile: the member profile is the
// account's public identity, and its share_watch_history switch publishes the
// default profile's history to every member.
func TestARestrictedSessionCannotEditTheMemberProfile(t *testing.T) {
	f := newLockFixture(t)
	social := NewSocialHandler(f.q)
	put := func(rt int64) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPut, "/api/me/profile", strings.NewReader(`{"share_watch_history":true}`))
		r.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		social.UpdateMyProfile(rr, rcClaimsCtx(r, f.userID, rt))
		return rr
	}
	if rr := put(f.kidRT); rr.Code != http.StatusForbidden || errorReason(rr) != "profile_restricted" {
		t.Errorf("kid session: status %d reason %q, want 403 profile_restricted", rr.Code, errorReason(rr))
	}
	p, err := f.q.GetMemberProfileByID(context.Background(), f.userID)
	if err != nil || p == nil || p.ShareWatchHistory {
		t.Fatalf("after the kid's refused edit: sharing=%v (err %v), want off", p != nil && p.ShareWatchHistory, err)
	}
	if rr := put(f.parentRT); rr.Code != http.StatusOK {
		t.Errorf("parent session: status %d (%s), want 200", rr.Code, rr.Body.String())
	}
}

// TestARestrictedDefaultProfileSeesItsOwnStrip: the strip is the default
// profile's history, so when the restricted profile IS the default, its own
// page shows its own titles, under its ceiling.
func TestARestrictedDefaultProfileSeesItsOwnStrip(t *testing.T) {
	f := newHistoryFixture(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	for _, step := range []struct {
		sql string
		id  int64
	}{
		{`UPDATE user_profiles SET is_default = FALSE WHERE id = $1`, f.parent.ID},
		{`UPDATE user_profiles SET is_default = TRUE WHERE id = $1`, f.kid.ID},
		{`UPDATE watch_progress SET completed = TRUE, completed_at = NOW() WHERE profile_id = $1`, f.kid.ID},
	} {
		if _, err := pool.Exec(ctx, step.sql, step.id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	u, err := f.q.GetUserByID(ctx, f.userID)
	if err != nil || u == nil {
		t.Fatalf("read user: %v", err)
	}
	rr := httptest.NewRecorder()
	NewSocialHandler(f.q).MemberProfile(rr, rpReq(f.lockFixture, http.MethodGet, "/x", f.kidRT, 0, map[string]string{"username": u.Username}))
	var resp memberProfileResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); rr.Code != http.StatusOK || err != nil {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	ids := map[int64]bool{}
	for _, w := range resp.RecentWatches {
		ids[w.ID] = true
	}
	if !resp.HistoryVisible || !ids[f.kidPG] || ids[f.kidR] {
		t.Errorf("restricted default on its own page: visible=%v PG=%v R=%v; want its own PG title only",
			resp.HistoryVisible, ids[f.kidPG], ids[f.kidR])
	}
}

// TestAWhitespaceCeilingStillHidesTheDefaultsStrip: the member page used a
// different test for "restricted" than the profile-keyed routes, and a
// stored whitespace-only ceiling passed one and failed the other, showing a
// non-default profile the default's history on its own page.
func TestAWhitespaceCeilingStillHidesTheDefaultsStrip(t *testing.T) {
	f := newHistoryFixture(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	for _, step := range []struct {
		sql string
		id  int64
	}{
		{`UPDATE user_profiles SET max_age_rating = '  ' WHERE id = $1`, f.kid.ID},
		{`UPDATE watch_progress SET completed = TRUE, completed_at = NOW() WHERE profile_id = $1`, f.parent.ID},
	} {
		if _, err := pool.Exec(ctx, step.sql, step.id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	u, err := f.q.GetUserByID(ctx, f.userID)
	if err != nil || u == nil {
		t.Fatalf("read user: %v", err)
	}
	rr := httptest.NewRecorder()
	NewSocialHandler(f.q).MemberProfile(rr, rpReq(f.lockFixture, http.MethodGet, "/x", f.kidRT, 0, map[string]string{"username": u.Username}))
	var resp memberProfileResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); rr.Code != http.StatusOK || err != nil {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}
	if resp.HistoryVisible || len(resp.RecentWatches) != 0 {
		t.Errorf("a non-default profile with a whitespace ceiling saw the default's strip: visible=%v, %d titles",
			resp.HistoryVisible, len(resp.RecentWatches))
	}
}

// TestPlaybackTelemetryHandlersUseTheActingProfile drives the start and
// finish beacons themselves: a kid's session naming the parent writes
// nothing to the parent's rows, and naming nothing writes to its own. The
// restamp beacon writes only for a live transcode session, which this test
// has none of, so its resolver call is pinned only through resolveProfile
// (the test above); it carries delivery facts, no title data.
func TestPlaybackTelemetryHandlersUseTheActingProfile(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	h := &PlaybackQoEHandler{queries: f.q}
	beacon := func(handler http.HandlerFunc, rt int64, body string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		handler(rr, rcClaimsCtx(r, f.userID, rt))
		if rr.Code != http.StatusNoContent {
			t.Fatalf("beacon: %d %s", rr.Code, rr.Body.String())
		}
	}
	row := func(token string) (profileID int64, terminal string, found bool) {
		t.Helper()
		err := pool.QueryRow(ctx, `SELECT profile_id, COALESCE(terminal, '') FROM playback_qoe_sessions WHERE session_token = $1`,
			token).Scan(&profileID, &terminal)
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, "", false
		}
		if err != nil {
			t.Fatalf("read row: %v", err)
		}
		return profileID, terminal, true
	}
	token := func() string {
		var b [16]byte
		if _, err := cryptorand.Read(b[:]); err != nil {
			t.Fatalf("rand: %v", err)
		}
		return hex.EncodeToString(b[:])
	}
	parent := strconv.FormatInt(f.parent.ID, 10)

	named, own := token(), token()
	beacon(h.RecordStart, f.kidRT, `{"session_token":"`+named+`","profile_id":`+parent+`,"decision":"direct"}`)
	if _, _, found := row(named); found {
		t.Error("a kid's start beacon naming the parent wrote a row")
	}
	beacon(h.RecordStart, f.kidRT, `{"session_token":"`+own+`","decision":"direct"}`)
	if id, _, found := row(own); !found || id != f.kid.ID {
		t.Errorf("a kid's start beacon naming nothing: row found %v for profile %d, want the kid (%d)", found, id, f.kid.ID)
	}

	// The parent's own viewing; the kid's session naming the parent must not
	// finish it.
	parents := token()
	beacon(h.RecordStart, f.parentRT, `{"session_token":"`+parents+`","decision":"direct"}`)
	beacon(h.RecordFinish, f.kidRT, `{"session_token":"`+parents+`","profile_id":`+parent+`,"terminal":"ended","watched_ms":1000}`)
	if id, terminal, found := row(parents); !found || id != f.parent.ID || terminal != "" {
		t.Errorf("the parent's row after the kid's beacons: found %v, profile %d, terminal %q; want it untouched", found, id, terminal)
	}
}

// TestTheMemberPageFailsClosedWhenTheViewerIsUnknown: the strip applies the
// viewer's ceiling, so a viewer that cannot be resolved gets a 500, not an
// unrestricted strip.
func TestTheMemberPageFailsClosedWhenTheViewerIsUnknown(t *testing.T) {
	f := newHistoryFixture(t)
	u, err := f.q.GetUserByID(context.Background(), f.userID)
	if err != nil || u == nil {
		t.Fatalf("read user: %v", err)
	}
	h := NewSocialHandler(f.q)
	h.resolveActing = failingActingResolver{}.ResolveActingProfile
	rr := httptest.NewRecorder()
	h.MemberProfile(rr, rpReq(f.lockFixture, http.MethodGet, "/x", f.kidRT, 0, map[string]string{"username": u.Username}))
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("own page with an unresolvable viewer: %d %s, want 500", rr.Code, rr.Body.String())
	}
}
