package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/gorilla/websocket"
)

// fakeSessions is a sessionStore answering with a fixed acting profile.
type fakeSessions struct {
	acting *models.UserProfile
	err    error
	gone   bool
}

func (f fakeSessions) ResolveActingProfile(context.Context, int64, int64) (*models.UserProfile, error) {
	return f.acting, f.err
}

func (f fakeSessions) SessionLive(context.Context, int64, int64) (bool, error) {
	return !f.gone, nil
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
		{"a resolve error", admin, fakeSessions{err: errors.New("down")}, false},
		{"no acting profile", admin, fakeSessions{}, false},
		{"a session whose row is gone", admin, fakeSessions{acting: free, gone: true}, false},
		{"a user", &auth.JWTClaims{UserID: 1, Role: "user", RefreshTokenID: 2}, fakeSessions{acting: free}, false},
		{"no claims", nil, fakeSessions{acting: free}, false},
	}
	for _, c := range cases {
		if got := adminPowers(ctx, c.store, c.claims); got != c.want {
			t.Errorf("%s: adminPowers = %v, want %v", c.name, got, c.want)
		}
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
	token := func(rt int64) string {
		tok, _, err := svc.GenerateAccessToken(f.userID, u.Username, "admin", u.TokenVersion, rt)
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
	// One route per guard in the router.
	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/users"},
		{http.MethodPost, "/api/users/invite"},
		{http.MethodPost, "/api/libraries"},
		{http.MethodPost, "/api/media/1/refresh-metadata"},
		{http.MethodPost, "/api/media/1/match"},
		{http.MethodDelete, "/api/media/1"},
		{http.MethodGet, "/api/tmdb/search?q=x"},
		{http.MethodGet, "/api/stream/sessions"},
		{http.MethodGet, "/api/admin/dashboard"},
		{http.MethodGet, "/api/admin/backup"},
		{http.MethodPost, "/api/admin/restore"},
	}
	for _, rt := range routes {
		if code, reason := do(rt.method, rt.path, f.kidRT); code != http.StatusForbidden || reason != "profile_restricted" {
			t.Errorf("%s %s as the kid: %d %q, want 403 profile_restricted", rt.method, rt.path, code, reason)
		}
	}
	// The parent's session, unrestricted, is let through.
	if code, reason := do(http.MethodGet, "/api/users", f.parentRT); code != http.StatusOK {
		t.Errorf("GET /api/users as the parent: %d %q, want 200", code, reason)
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
	t.Cleanup(func() { _, _ = lockTestPool(t).Exec(context.Background(), `DELETE FROM collections WHERE id = $1`, private.ID) })
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
