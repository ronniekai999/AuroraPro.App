package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/notify"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/gorilla/websocket"
)

// fakeSessions is a sessionStore answering with a fixed acting profile. The
// account has an unrestricted profile unless noneUnrestricted is set.
type fakeSessions struct {
	acting           *models.UserProfile
	err              error
	gone             bool
	liveErr          error
	noneUnrestricted bool
	unrestrictedErr  error
}

func (f fakeSessions) HasUnrestrictedProfile(context.Context, int64) (bool, error) {
	return !f.noneUnrestricted, f.unrestrictedErr
}

func (f fakeSessions) ResolveActingProfile(context.Context, int64, int64) (*models.UserProfile, error) {
	return f.acting, f.err
}

func (f fakeSessions) SessionLive(context.Context, int64, int64) (bool, error) {
	return !f.gone, f.liveErr
}

func TestAdminPowersNeedAnUnrestrictedSession(t *testing.T) {
	ctx := context.Background()
	admin := &auth.JWTClaims{UserID: 1, Role: "admin", RefreshTokenID: 2}
	free := &models.UserProfile{ID: 1}
	kid := &models.UserProfile{ID: 2, MaxAgeRating: "PG"}
	cases := []struct {
		name   string
		claims *auth.JWTClaims
		store  fakeSessions
		want   bool
	}{
		{"an unrestricted admin", admin, fakeSessions{acting: free}, true},
		{"a restricted admin", admin, fakeSessions{acting: kid}, false},
		// A whitespace-only ceiling (hand-written; boot rewrites it), a tab
		// included, reads as none, as the ladder enforces it and
		// HasUnrestrictedProfile reads it.
		{"an admin on a whitespace-only ceiling", admin, fakeSessions{acting: &models.UserProfile{ID: 3, MaxAgeRating: "  "}}, true},
		{"an admin on a tab for a ceiling", admin, fakeSessions{acting: &models.UserProfile{ID: 3, MaxAgeRating: "\t"}}, true},
		// An unknown value restricts to the all-ages tier.
		{"an admin on an unknown ceiling", admin, fakeSessions{acting: &models.UserProfile{ID: 3, MaxAgeRating: "XYZ"}}, false},
		// With no unrestricted profile on the account, nothing else could use
		// the admin powers, so a restricted session keeps them.
		{"a restricted admin on an account with no unrestricted profile", admin, fakeSessions{acting: kid, noneUnrestricted: true}, true},
		{"a failed check for an unrestricted profile", admin, fakeSessions{acting: kid, noneUnrestricted: true, unrestrictedErr: errors.New("down")}, false},
		{"a resolve error", admin, fakeSessions{err: errors.New("down")}, false},
		{"no acting profile", admin, fakeSessions{}, false},
		{"a session whose row is gone", admin, fakeSessions{acting: free, gone: true}, false},
		{"a session check that fails", admin, fakeSessions{acting: free, liveErr: errors.New("down")}, false},
		// A cast token copies its minter's role and names no session, so it
		// would resolve to the account default.
		{"a cast token", &auth.JWTClaims{UserID: 1, Role: "admin", Scope: auth.ScopeCast, SessionID: "s"}, fakeSessions{acting: free}, false},
		{"a user", &auth.JWTClaims{UserID: 1, Role: "user", RefreshTokenID: 2}, fakeSessions{acting: free}, false},
		{"no claims", nil, fakeSessions{acting: free}, false},
	}
	for _, c := range cases {
		if got := adminPowers(ctx, c.store, c.claims); got != c.want {
			t.Errorf("%s: adminPowers = %v, want %v", c.name, got, c.want)
		}
	}
	if adminPowers(ctx, nil, admin) {
		t.Error("no store: adminPowers = true, want false")
	}
}

// TestTheAdminRefusalFailsClosed: the admin routes' guard lets through only a
// live session known to act as an unrestricted profile.
func TestTheAdminRefusalFailsClosed(t *testing.T) {
	admin := &auth.JWTClaims{UserID: 1, Role: "admin", RefreshTokenID: 2}
	free := &models.UserProfile{ID: 1}
	cases := []struct {
		name       string
		store      fakeSessions
		wantCode   int
		wantReason string
	}{
		{"an unrestricted session", fakeSessions{acting: free}, http.StatusOK, ""},
		{"a restricted session", fakeSessions{acting: &models.UserProfile{ID: 2, MaxAgeRating: "PG"}}, http.StatusForbidden, "profile_restricted"},
		{"a whitespace-only ceiling", fakeSessions{acting: &models.UserProfile{ID: 3, MaxAgeRating: "  "}}, http.StatusOK, ""},
		// Read as the ladder does: a tab is none, and an unknown value
		// restricts to the all-ages tier.
		{"a tab for a ceiling", fakeSessions{acting: &models.UserProfile{ID: 3, MaxAgeRating: "\t"}}, http.StatusOK, ""},
		{"an unknown ceiling", fakeSessions{acting: &models.UserProfile{ID: 3, MaxAgeRating: "XYZ"}}, http.StatusForbidden, "profile_restricted"},
		{"a restricted session with no unrestricted profile on the account", fakeSessions{acting: &models.UserProfile{ID: 2, MaxAgeRating: "PG"}, noneUnrestricted: true}, http.StatusOK, ""},
		{"a failed check for an unrestricted profile", fakeSessions{acting: &models.UserProfile{ID: 2, MaxAgeRating: "PG"}, noneUnrestricted: true, unrestrictedErr: errors.New("down")}, http.StatusInternalServerError, ""},
		{"an ended session", fakeSessions{acting: free, gone: true}, http.StatusUnauthorized, "session_ended"},
		{"a session check that fails", fakeSessions{acting: free, liveErr: errors.New("down")}, http.StatusInternalServerError, ""},
		{"a resolve error", fakeSessions{err: errors.New("down")}, http.StatusInternalServerError, ""},
		{"no acting profile", fakeSessions{}, http.StatusInternalServerError, ""},
	}
	for _, c := range cases {
		reached := false
		guard := refuseRestrictedAdmin(c.store)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			reached = true
			w.WriteHeader(http.StatusOK)
		}))
		req := httptest.NewRequest(http.MethodGet, "/api/users", nil)
		req = req.WithContext(context.WithValue(req.Context(), auth.ClaimsContextKey, admin))
		rr := httptest.NewRecorder()
		guard.ServeHTTP(rr, req)
		if rr.Code != c.wantCode || errorReasonOf(rr) != c.wantReason {
			t.Errorf("%s: %d %q, want %d %q", c.name, rr.Code, errorReasonOf(rr), c.wantCode, c.wantReason)
		}
		if reached != (c.wantCode == http.StatusOK) {
			t.Errorf("%s: the handler ran = %v", c.name, reached)
		}
	}
	// A non-admin is refused here too, not only by auth.RequireAdmin ahead of it.
	user := &auth.JWTClaims{UserID: 1, Role: "user", RefreshTokenID: 2}
	userReached := false
	userGuard := refuseRestrictedAdmin(fakeSessions{acting: free})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { userReached = true }))
	userReq := httptest.NewRequest(http.MethodGet, "/api/users", nil)
	userRR := httptest.NewRecorder()
	userGuard.ServeHTTP(userRR, userReq.WithContext(context.WithValue(userReq.Context(), auth.ClaimsContextKey, user)))
	if userRR.Code != http.StatusForbidden || userReached {
		t.Errorf("a non-admin: %d, the handler ran = %v; want 403 and not run", userRR.Code, userReached)
	}
	// A cast token copies its minter's role but names no session.
	reached := false
	guard := refuseRestrictedAdmin(fakeSessions{acting: free})(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached = true }))
	cast := &auth.JWTClaims{UserID: 1, Role: "admin", Scope: auth.ScopeCast, SessionID: "s"}
	req := httptest.NewRequest(http.MethodGet, "/api/users", nil)
	rr := httptest.NewRecorder()
	guard.ServeHTTP(rr, req.WithContext(context.WithValue(req.Context(), auth.ClaimsContextKey, cast)))
	if rr.Code != http.StatusForbidden || reached {
		t.Errorf("a cast token: %d, the handler ran = %v; want 403 and not run", rr.Code, reached)
	}
}

// TestAdminRoutesRefuseARestrictedSession: the admin role belongs to the
// account, so a kid's profile on an admin account kept every admin route.
// Each route guard is driven through the real router.
func TestAdminRoutesRefuseARestrictedSession(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, f.userID); err != nil {
		t.Fatalf("make the user an admin: %v", err)
	}
	u, err := f.q.GetUserByID(ctx, f.userID)
	if err != nil {
		t.Fatalf("read the user: %v", err)
	}
	svc := healthTestService()
	router := NewRouter(RouterDeps{Cfg: &config.Config{}, AuthSvc: svc, Queries: f.q, StartTime: time.Now()})
	role := "admin"
	token := func(rt int64) string {
		tok, _, err := svc.GenerateAccessToken(f.userID, u.Username, role, u.TokenVersion, rt)
		if err != nil {
			t.Fatalf("mint a token: %v", err)
		}
		return tok
	}
	do := func(method, path string, rt int64) (int, string) {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+token(rt))
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr.Code, errorReasonOf(rr)
	}
	// One route per guard in the router. The ids are ones no row has and the
	// POSTs carry no body, so if a guard regresses the handlers behind them
	// find nothing to change, except the invite, which defaults its body and
	// inserts a code; that row goes with the fixture's user.
	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/users"},
		{http.MethodPost, "/api/users/invite"},
		{http.MethodPost, "/api/libraries"},
		{http.MethodPost, "/api/media/999999999999/refresh-metadata"},
		{http.MethodPost, "/api/media/999999999999/match"},
		{http.MethodDelete, "/api/media/999999999999"},
		{http.MethodGet, "/api/tmdb/search?q=x"},
		{http.MethodGet, "/api/stream/sessions"},
		{http.MethodGet, "/api/admin/dashboard"},
		{http.MethodGet, "/api/admin/backup"},
		{http.MethodPost, "/api/admin/restore"},
	}
	// A user's token is refused every one of them, unrestricted session or not.
	role = "user"
	for _, rt := range routes {
		if code, _ := do(rt.method, rt.path, f.parentRT); code != http.StatusForbidden {
			t.Errorf("%s %s as a user: %d, want 403", rt.method, rt.path, code)
		}
	}
	role = "admin"
	for _, rt := range routes {
		if code, reason := do(rt.method, rt.path, f.kidRT); code != http.StatusForbidden || reason != "profile_restricted" {
			t.Errorf("%s %s as the kid: %d %q, want 403 profile_restricted", rt.method, rt.path, code, reason)
		}
	}
	// The parent's session, unrestricted, is let through.
	if code, reason := do(http.MethodGet, "/api/users", f.parentRT); code != http.StatusOK {
		t.Errorf("GET /api/users as the parent: %d %q, want 200", code, reason)
	}
	// With no unrestricted profile left on the account (data from before the
	// rule, a restore, hand-written SQL), the restricted session is all it
	// has, and keeps the admin powers.
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE user_profiles SET max_age_rating = 'PG' WHERE user_id = $1`, f.userID); err != nil {
		t.Fatalf("restrict every profile: %v", err)
	}
	if code, reason := do(http.MethodGet, "/api/users", f.kidRT); code != http.StatusOK {
		t.Errorf("GET /api/users as the kid with no unrestricted profile left: %d %q, want 200", code, reason)
	}
}

// TestARestrictedAdminSeesOnlyItsOwnCollections: outside the admin routes the
// role lets an admin read every member's private collections; a restricted
// session is not an admin there either.
func TestARestrictedAdminSeesOnlyItsOwnCollections(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, f.userID); err != nil {
		t.Fatalf("make the user an admin: %v", err)
	}
	other := seedReqUser(t, f.q)
	private := &models.Collection{OwnerUserID: other, Name: "someone else's", Kind: "manual"}
	if err := f.q.CreateCollection(ctx, private); err != nil {
		t.Fatalf("seed a private collection: %v", err)
	}
	t.Cleanup(func() {
		_, _ = lockTestPool(t).Exec(context.Background(), `DELETE FROM collections WHERE id = $1`, private.ID)
	})
	h := NewCollectionsHandler(f.q)
	lists := func(rt int64) bool {
		r := httptest.NewRequest(http.MethodGet, "/api/collections", nil)
		r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey,
			&auth.JWTClaims{UserID: f.userID, Username: "u", Role: "admin", RefreshTokenID: rt}))
		rr := httptest.NewRecorder()
		h.List(rr, r)
		if rr.Code != http.StatusOK {
			t.Fatalf("list collections: %d %s", rr.Code, rr.Body)
		}
		var out []models.Collection
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v (%s)", err, rr.Body)
		}
		for _, c := range out {
			if c.ID == private.ID {
				return true
			}
		}
		return false
	}
	if !lists(f.parentRT) {
		t.Fatal("precondition: an unrestricted admin session should list another member's private collection")
	}
	if lists(f.kidRT) {
		t.Error("a restricted admin session listed another member's private collection")
	}
}

// TestTheEventSocketGivesARestrictedSessionTheUsersEvents: the hub sends
// admin-role sockets the admin-only events (who is playing what, server-wide)
// for the connection's life, so a restricted session connects as a user.
func TestTheEventSocketGivesARestrictedSessionTheUsersEvents(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, f.userID); err != nil {
		t.Fatalf("make the user an admin: %v", err)
	}
	u, err := f.q.GetUserByID(ctx, f.userID)
	if err != nil {
		t.Fatalf("read the user: %v", err)
	}
	svc := healthTestService()
	hub := ws.NewHub(nil)
	server := httptest.NewServer(NewRouter(RouterDeps{Cfg: &config.Config{}, AuthSvc: svc, Queries: f.q, Hub: hub, StartTime: time.Now()}))
	t.Cleanup(server.Close)
	dial := func(rt int64) *websocket.Conn {
		tok, _, err := svc.GenerateAccessToken(f.userID, u.Username, "admin", u.TokenVersion, rt)
		if err != nil {
			t.Fatalf("mint a token: %v", err)
		}
		conn, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws?token="+tok, nil)
		if err != nil {
			t.Fatalf("dial /ws: %v (%v)", err, resp)
		}
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	parent, kid := dial(f.parentRT), dial(f.kidRT)
	for deadline := time.Now().Add(5 * time.Second); hub.ClientCount() < 2; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the hub registered %d of 2 sockets", hub.ClientCount())
		}
	}
	// Each socket's queue is FIFO, so the first event a socket reads says
	// whether the admin-only one reached it.
	hub.BroadcastToAdmins("admin_only", nil)
	hub.BroadcastToUser(f.userID, "marker", nil)
	first := func(conn *websocket.Conn) string {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		var ev struct {
			Type string `json:"type"`
		}
		if err := conn.ReadJSON(&ev); err != nil {
			t.Fatalf("read an event: %v", err)
		}
		return ev.Type
	}
	if got := first(parent); got != "admin_only" {
		t.Errorf("the parent's socket read %q first, want the admin-only event", got)
	}
	if got := first(kid); got != "marker" {
		t.Errorf("the kid's socket read %q first, want the marker: it received the admin-only event", got)
	}
}

// TestARestrictedAdminSessionIsNotShownTheAdminAlerts: the admin alerts (a
// member's new request, with its title, and scan results) go to the admin
// account, so the notification list, its unread count and mark-read leave
// them out for a session acting as a restricted profile. Driven through the
// router.
func TestARestrictedAdminSessionIsNotShownTheAdminAlerts(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, f.userID); err != nil {
		t.Fatalf("make the user an admin: %v", err)
	}
	u, err := f.q.GetUserByID(ctx, f.userID)
	if err != nil {
		t.Fatalf("read the user: %v", err)
	}
	seed := func(typ string, rid *int64) int64 {
		n := &models.Notification{UserID: f.userID, Type: typ, Title: typ, RequestID: rid}
		if created, err := f.q.CreateNotification(ctx, n); err != nil || !created {
			t.Fatalf("seed %s: created=%v err=%v", typ, created, err)
		}
		return n.ID
	}
	r1, r2 := int64(8101), int64(8102)
	request := seed(models.NotificationAdminNewRequest, &r1)
	seed(models.NotificationScanComplete, nil)
	seed(models.NotificationRequestAvailable, &r2)

	svc := healthTestService()
	router := NewRouter(RouterDeps{Cfg: &config.Config{}, AuthSvc: svc, Queries: f.q, StartTime: time.Now()})
	do := func(method, path string, rt int64) *httptest.ResponseRecorder {
		tok, _, err := svc.GenerateAccessToken(f.userID, u.Username, "admin", u.TokenVersion, rt)
		if err != nil {
			t.Fatalf("mint a token: %v", err)
		}
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s %s: %d %s", method, path, rr.Code, rr.Body)
		}
		return rr
	}
	list := func(rt int64) (types []string, unread int) {
		var out struct {
			Notifications []models.Notification `json:"notifications"`
			Unread        int                   `json:"unread"`
		}
		rr := do(http.MethodGet, "/api/me/notifications", rt)
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v (%s)", err, rr.Body)
		}
		for _, n := range out.Notifications {
			types = append(types, n.Type)
		}
		return types, out.Unread
	}

	if types, unread := list(f.parentRT); len(types) != 3 || unread != 3 {
		t.Fatalf("the parent's session: %v, %d unread; want all 3, unread", types, unread)
	}
	if types, unread := list(f.kidRT); len(types) != 1 || types[0] != models.NotificationRequestAvailable || unread != 1 {
		t.Errorf("the kid's session: %v, %d unread; want only the account's own notification, unread", types, unread)
	}

	// The kid's mark-read, by id or all, does not reach the alerts it is not
	// shown: the parent still has them to read.
	do(http.MethodPost, "/api/me/notifications/"+strconv.FormatInt(request, 10)+"/read", f.kidRT)
	do(http.MethodPost, "/api/me/notifications/read-all", f.kidRT)
	if _, unread := list(f.kidRT); unread != 0 {
		t.Errorf("the kid's session after mark-all-read: %d unread, want 0", unread)
	}
	if _, unread := list(f.parentRT); unread != 2 {
		t.Errorf("the parent's session after the kid's mark-all-read: %d unread, want the 2 admin alerts", unread)
	}

	// With no unrestricted profile on the account the restricted session
	// keeps the admin powers (adminPowers' exception), and is shown them.
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE user_profiles SET max_age_rating = 'PG' WHERE user_id = $1`, f.userID); err != nil {
		t.Fatalf("restrict every profile: %v", err)
	}
	if types, _ := list(f.kidRT); len(types) != 3 {
		t.Errorf("the kid's session with no unrestricted profile left: %v, want all 3", types)
	}
}

// TestTheEventSocketSendsTheAdminAlertsOnlyToAdminRoleSockets: the
// dispatcher's live leg sends an admin alert to the account's admin-role
// sockets only, and `/ws` connects a restricted session as a user, so its
// socket gets the account's other notifications but not the alert.
func TestTheEventSocketSendsTheAdminAlertsOnlyToAdminRoleSockets(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, f.userID); err != nil {
		t.Fatalf("make the user an admin: %v", err)
	}
	u, err := f.q.GetUserByID(ctx, f.userID)
	if err != nil {
		t.Fatalf("read the user: %v", err)
	}
	svc := healthTestService()
	hub := ws.NewHub(nil)
	server := httptest.NewServer(NewRouter(RouterDeps{Cfg: &config.Config{}, AuthSvc: svc, Queries: f.q, Hub: hub, StartTime: time.Now()}))
	t.Cleanup(server.Close)
	dial := func(rt int64) *websocket.Conn {
		tok, _, err := svc.GenerateAccessToken(f.userID, u.Username, "admin", u.TokenVersion, rt)
		if err != nil {
			t.Fatalf("mint a token: %v", err)
		}
		conn, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws?token="+tok, nil)
		if err != nil {
			t.Fatalf("dial /ws: %v (%v)", err, resp)
		}
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	parent, kid := dial(f.parentRT), dial(f.kidRT)
	for deadline := time.Now().Add(5 * time.Second); hub.ClientCount() < 2; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the hub registered %d of 2 sockets", hub.ClientCount())
		}
	}
	// The real dispatcher persists each row (the fixture's user takes them
	// with it) and broadcasts it. Each socket's queue is FIFO, so the first
	// notification a socket reads says whether the alert reached it.
	d := notify.NewDispatcher(f.q, hub, nil, nil)
	rid := int64(8201)
	d.Notify(ctx, &models.Notification{UserID: f.userID, Type: models.NotificationAdminNewRequest, Title: "a member's request", RequestID: &rid})
	d.Notify(ctx, &models.Notification{UserID: f.userID, Type: models.NotificationScanComplete, Title: "Movies: 2 new items"})
	d.Notify(ctx, &models.Notification{UserID: f.userID, Type: models.NotificationPartyInvite, Title: "a party"})
	next := func(conn *websocket.Conn) string {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		var ev struct {
			Type string `json:"type"`
			Data struct {
				Type string `json:"type"`
			} `json:"data"`
		}
		if err := conn.ReadJSON(&ev); err != nil {
			t.Fatalf("read an event: %v", err)
		}
		if ev.Type != ws.EventNotification {
			t.Fatalf("read a %q event, want a notification", ev.Type)
		}
		return ev.Data.Type
	}
	for _, want := range []string{models.NotificationAdminNewRequest, models.NotificationScanComplete, models.NotificationPartyInvite} {
		if got := next(parent); got != want {
			t.Errorf("the parent's socket read %q, want %q", got, want)
		}
	}
	if got := next(kid); got != models.NotificationPartyInvite {
		t.Errorf("the kid's socket read %q first, want the party invite: it received an admin alert", got)
	}
}

// TestTheFeedbackTokenHealthIsForAdminPowersOnly: the bug-report config shows
// admins the GitHub token's health; a restricted admin session is not one.
func TestTheFeedbackTokenHealthIsForAdminPowersOnly(t *testing.T) {
	h := &FeedbackHandler{cfg: config.BugReportConfig{Enabled: true}}
	h.tokenHealth.Store(&patHealth{Healthy: false, Reason: "token expired", CheckedAt: time.Now()})
	admin := &auth.JWTClaims{UserID: 1, Role: "admin", RefreshTokenID: 2}
	shown := func(sessions sessionStore) bool {
		h.sessions = sessions
		req := httptest.NewRequest(http.MethodGet, "/api/feedback/config", nil)
		req = req.WithContext(context.WithValue(req.Context(), auth.ClaimsContextKey, admin))
		rr := httptest.NewRecorder()
		h.GetConfig(rr, req)
		var resp FeedbackConfigResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v (%s)", err, rr.Body)
		}
		return resp.TokenHealthy != nil || resp.TokenHealthReason != ""
	}
	if !shown(fakeSessions{acting: &models.UserProfile{ID: 1}}) {
		t.Fatal("precondition: an unrestricted admin session should see the token's health")
	}
	if shown(fakeSessions{acting: &models.UserProfile{ID: 2, MaxAgeRating: "PG"}}) {
		t.Error("a restricted admin session saw the token's health")
	}
}

// plainSessions is a sessionStore without HasUnrestrictedProfile.
type plainSessions struct{ acting *models.UserProfile }

func (p plainSessions) ResolveActingProfile(context.Context, int64, int64) (*models.UserProfile, error) {
	return p.acting, nil
}
func (plainSessions) SessionLive(context.Context, int64, int64) (bool, error) { return true, nil }

// TestTheAdminExceptionNeedsAnAccountWithNoUnrestrictedProfile: a restricted
// session keeps the admin powers only on an account none of whose profiles is
// free of a ceiling, as stored (” and whitespace read as none), and a store
// that cannot say grants nothing. An account's first profile cannot carry a
// ceiling, so profile writes cannot produce that state.
func TestTheAdminExceptionNeedsAnAccountWithNoUnrestrictedProfile(t *testing.T) {
	admin := &auth.JWTClaims{UserID: 1, Role: "admin", RefreshTokenID: 2}
	if adminPowers(context.Background(), plainSessions{acting: &models.UserProfile{ID: 2, MaxAgeRating: "PG"}}, admin) {
		t.Error("a store without HasUnrestrictedProfile granted a restricted session the admin powers")
	}

	f := newLockFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	has := func() bool {
		t.Helper()
		ok, err := f.q.HasUnrestrictedProfile(ctx, f.userID)
		if err != nil {
			t.Fatalf("HasUnrestrictedProfile: %v", err)
		}
		return ok
	}
	if !has() {
		t.Fatal("the fixture's parent has no ceiling, but the account read as having no unrestricted profile")
	}
	for _, stored := range []string{"", "  "} {
		if _, err := pool.Exec(ctx, `UPDATE user_profiles SET max_age_rating = $2 WHERE id = $1`, f.parent.ID, stored); err != nil {
			t.Fatalf("store %q: %v", stored, err)
		}
		if !has() {
			t.Errorf("a stored ceiling of %q read as a ceiling", stored)
		}
	}
	// A tab is no ceiling to the ladder, so a parent stored with one is
	// unrestricted and the kid gets no exception. (SQL's btrim strips spaces
	// only; read there, the tab was a ceiling and the kid kept the admin
	// powers.) A concurrent boot canonicalization in another package rewrites
	// it to NULL, which reads the same.
	if _, err := pool.Exec(ctx, `UPDATE user_profiles SET max_age_rating = E'\t' WHERE id = $1`, f.parent.ID); err != nil {
		t.Fatalf("store a tab: %v", err)
	}
	if !has() {
		t.Error("a stored ceiling of a tab read as a ceiling, though the ladder reads it as none")
	}
	if hasCeiling("\t") {
		t.Error("hasCeiling read a tab as a ceiling, though the ladder reads it as none")
	}
	// An unknown value restricts to the all-ages tier, so it is a ceiling;
	// canonicalization rewrites it to that tier, which reads the same.
	if _, err := pool.Exec(ctx, `UPDATE user_profiles SET max_age_rating = 'XYZ' WHERE id = $1`, f.parent.ID); err != nil {
		t.Fatalf("store an unknown ceiling: %v", err)
	}
	if has() {
		t.Error("a stored ceiling the ladder does not know read as none")
	}
	if _, err := pool.Exec(ctx, `UPDATE user_profiles SET max_age_rating = 'PG' WHERE user_id = $1`, f.userID); err != nil {
		t.Fatalf("restrict every profile: %v", err)
	}
	if has() {
		t.Error("an account whose every profile is restricted read as having an unrestricted one")
	}

	// An account with no profile at all: its first profile cannot carry one.
	bare := seedReqUser(t, f.q)
	first := &models.UserProfile{UserID: bare, Name: "kid", MaxAgeRating: "PG", Language: "en", SubtitleMode: "off"}
	if err := f.q.CreateProfileFor(ctx, first, nil); !errors.Is(err, db.ErrLastUnrestrictedProfile) {
		t.Errorf("a ceilinged first profile: %v, want ErrLastUnrestrictedProfile", err)
	}
	free := &models.UserProfile{UserID: bare, Name: "parent", Language: "en", SubtitleMode: "off"}
	if err := f.q.CreateProfileFor(ctx, free, nil); err != nil {
		t.Fatalf("an unrestricted first profile: %v", err)
	}
	if err := f.q.CreateProfileFor(ctx, first, nil); err != nil {
		t.Errorf("a ceilinged profile beside an unrestricted one: %v", err)
	}
}

// TestEveryAdminRouteGoesThroughTheRestrictedSessionGuard: the router wraps
// auth.RequireAdmin as requireAdmin, which adds refuseRestrictedAdmin, and the
// route test drives today's routes. A route added later with auth.RequireAdmin
// directly would reopen every admin power to a restricted session with no
// test noticing, so the router may name it only inside that wrapper.
func TestEveryAdminRouteGoesThroughTheRestrictedSessionGuard(t *testing.T) {
	src, err := os.ReadFile("router.go")
	if err != nil {
		t.Fatalf("read router.go: %v", err)
	}
	if n := strings.Count(string(src), "auth.RequireAdmin"); n != 1 {
		t.Errorf("router.go names auth.RequireAdmin %d times; want once, inside requireAdmin, so every admin route also refuses a restricted session", n)
	}
	if !strings.Contains(string(src), "return auth.RequireAdmin(refuseRestricted(next))") {
		t.Error("requireAdmin no longer wraps refuseRestrictedAdmin")
	}
}
