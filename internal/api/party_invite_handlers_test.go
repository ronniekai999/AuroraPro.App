package api

// Tests for the watch-party invite endpoints (migration 051). Split per
// house convention: pure input-validation cases run unconditionally against
// nil dependencies (every rejection must happen BEFORE the first manager or
// DB touch — the nils panic if that ordering regresses); the behavioral flow
// is opt-in via TEST_DATABASE_URL like the other API integration tests.
//
// The integration test drives the full loop the mockup promises: host sends
// a batch (one good invitee, one ceiling-restricted, one unknown, one self),
// delivery lands as a durable party_invite notification, the roster is
// member-visible with authorization enforced, RSVP flips pending→going and
// pings the host exactly once, and the invitee's feed shows the party.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/notify"
	"github.com/aurora-media/aurora/internal/watchparty"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ─── request builders ────────────────────────────────────────────────

func inviteClaimsCtx(r *http.Request, userID int64, username string) *http.Request {
	claims := &auth.JWTClaims{UserID: userID, Username: username, Role: "user"}
	return r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
}

func inviteReq(method, path, body string, params map[string]string, userID int64, username string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	return inviteClaimsCtx(r, userID, username)
}

func inviteDo(handler http.HandlerFunc, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	handler(w, r)
	return w
}

// ─── validation (no DB, no manager) ──────────────────────────────────

func TestPartyInvites_ValidationBeforeDependencies(t *testing.T) {
	h := NewPartyInviteHandler(nil, nil, nil) // nils panic if validation order regresses

	// Unauthenticated request → 401 before anything else.
	r := httptest.NewRequest(http.MethodPost, "/api/parties/ABC123/invites", strings.NewReader(`{}`))
	if w := inviteDo(h.SendInvites, r); w.Code != http.StatusUnauthorized {
		t.Errorf("no claims: code = %d; want 401", w.Code)
	}

	cases := []struct {
		name string
		run  func() *httptest.ResponseRecorder
	}{
		{"bad code", func() *httptest.ResponseRecorder {
			return inviteDo(h.SendInvites, inviteReq(http.MethodPost, "/api/parties/AB/invites",
				`{"usernames":["x"]}`, map[string]string{"code": "AB"}, 1, "u"))
		}},
		{"malformed body", func() *httptest.ResponseRecorder {
			return inviteDo(h.SendInvites, inviteReq(http.MethodPost, "/api/parties/ABC123/invites",
				`{"usernames":`, map[string]string{"code": "ABC123"}, 1, "u"))
		}},
		{"empty usernames", func() *httptest.ResponseRecorder {
			return inviteDo(h.SendInvites, inviteReq(http.MethodPost, "/api/parties/ABC123/invites",
				`{"usernames":["  ",""]}`, map[string]string{"code": "ABC123"}, 1, "u"))
		}},
		{"too many usernames", func() *httptest.ResponseRecorder {
			names := make([]string, 21)
			for i := range names {
				names[i] = fmt.Sprintf("user%d", i)
			}
			body, _ := json.Marshal(map[string]interface{}{"usernames": names})
			return inviteDo(h.SendInvites, inviteReq(http.MethodPost, "/api/parties/ABC123/invites",
				string(body), map[string]string{"code": "ABC123"}, 1, "u"))
		}},
		{"note too long", func() *httptest.ResponseRecorder {
			body, _ := json.Marshal(map[string]interface{}{
				"usernames": []string{"x"}, "note": strings.Repeat("n", 281),
			})
			return inviteDo(h.SendInvites, inviteReq(http.MethodPost, "/api/parties/ABC123/invites",
				string(body), map[string]string{"code": "ABC123"}, 1, "u"))
		}},
		{"rsvp bad id", func() *httptest.ResponseRecorder {
			return inviteDo(h.RSVP, inviteReq(http.MethodPost, "/api/party-invites/nope/rsvp",
				`{"rsvp":"going"}`, map[string]string{"id": "nope"}, 1, "u"))
		}},
		{"rsvp bad value", func() *httptest.ResponseRecorder {
			return inviteDo(h.RSVP, inviteReq(http.MethodPost, "/api/party-invites/5/rsvp",
				`{"rsvp":"pending"}`, map[string]string{"id": "5"}, 1, "u"))
		}},
		{"roster bad code", func() *httptest.ResponseRecorder {
			return inviteDo(h.Roster, inviteReq(http.MethodGet, "/api/parties/TOOLONG1/invites",
				"", map[string]string{"code": "TOOLONG1"}, 1, "u"))
		}},
	}
	for _, tc := range cases {
		if w := tc.run(); w.Code != http.StatusBadRequest {
			t.Errorf("%s: code = %d; want 400", tc.name, w.Code)
		}
	}
}

// ─── integration flow ────────────────────────────────────────────────

func requireInviteTestDB(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping invite integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	t.Cleanup(pool.Close)
	return db.NewQueries(pool), pool
}

// seedInviteUser inserts a user plus a default sub-profile with the given
// parental ceiling ("" = unrestricted). Returns (id, username).
func seedInviteUser(t *testing.T, pool *pgxpool.Pool, maxRating string) (int64, string) {
	t.Helper()
	username := "invite_t_" + socialTestSuffix(t)
	var id int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
		username, username+"@example.com", "$2a$10$placeholder",
	).Scan(&id); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	var maxRatingArg interface{}
	if maxRating != "" {
		maxRatingArg = maxRating
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO user_profiles (user_id, name, is_default, max_age_rating)
		 VALUES ($1, 'Main', TRUE, $2)`,
		id, maxRatingArg,
	); err != nil {
		t.Fatalf("seed default profile: %v", err)
	}
	return id, username
}

// TestPartyInvites_RosterHidesDeclined pins the "declining is silent"
// promise at the API layer (2026-08 review): the roster endpoint must not
// ship other members' declined state — hiding it only in the lobby UI
// left the raw JSON readable by the whole party.
func TestPartyInvites_RosterHidesDeclined(t *testing.T) {
	q, pool := requireInviteTestDB(t)
	ctx := context.Background()

	hostID, hostName := seedInviteUser(t, pool, "")
	_, goingName := seedInviteUser(t, pool, "")
	declID, declName := seedInviteUser(t, pool, "")

	var libID, mediaID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1, 'movie', $2, $3) RETURNING id`,
		"invite_lib_"+socialTestSuffix(t), []string{"/tmp/invite_test"}, hostID,
	).Scan(&libID); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM libraries WHERE id = $1`, libID) })
	if err := pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, content_rating,
		                          year, overview, rating, runtime_minutes)
		 VALUES ($1, 'movie', 'Halloweentown', 'ht', 'PG', 1998, '', 0, 84) RETURNING id`,
		libID,
	).Scan(&mediaID); err != nil {
		t.Fatalf("seed media: %v", err)
	}

	manager := watchparty.NewManager(q, nil)
	ps, err := manager.CreateParty(ctx, hostID, hostName, mediaID, nil, "P", "Halloweentown", "", 10,
		watchparty.PartySettings{AllowPause: true, AllowChat: true}, 0, nil)
	if err != nil {
		t.Fatalf("create party: %v", err)
	}
	code := ps.Code
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM watch_parties WHERE party_code = $1`, code) })

	h := NewPartyInviteHandler(manager, q, nil)
	body, _ := json.Marshal(map[string]interface{}{"usernames": []string{goingName, declName}})
	if w := inviteDo(h.SendInvites, inviteReq(http.MethodPost, "/api/parties/"+code+"/invites",
		string(body), map[string]string{"code": code}, hostID, hostName)); w.Code != http.StatusOK {
		t.Fatalf("send: %d %s", w.Code, w.Body.String())
	}

	// The decliner answers via the handler (ownership-scoped).
	var declInviteID int64
	if err := pool.QueryRow(ctx,
		`SELECT pi.id FROM party_invites pi JOIN watch_parties wp ON wp.id = pi.party_id
		 WHERE wp.party_code = $1 AND pi.invitee_user_id = $2`, code, declID,
	).Scan(&declInviteID); err != nil {
		t.Fatalf("resolve invite: %v", err)
	}
	if w := inviteDo(h.RSVP, inviteReq(http.MethodPost, fmt.Sprintf("/api/party-invites/%d/rsvp", declInviteID),
		`{"rsvp":"declined"}`, map[string]string{"id": fmt.Sprint(declInviteID)}, declID, declName)); w.Code != http.StatusOK {
		t.Fatalf("decline: %d", w.Code)
	}

	// Host reads the roster: the decliner must be absent, not shown as
	// declined.
	w := inviteDo(h.Roster, inviteReq(http.MethodGet, "/api/parties/"+code+"/invites",
		"", map[string]string{"code": code}, hostID, hostName))
	if w.Code != http.StatusOK {
		t.Fatalf("roster: %d", w.Code)
	}
	var resp struct {
		Invites []models.PartyInviteRosterEntry `json:"invites"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("roster resp: %v", err)
	}
	if len(resp.Invites) != 1 || resp.Invites[0].Username != goingName {
		t.Errorf("roster = %+v; want only %s (declined row filtered server-side)", resp.Invites, goingName)
	}

	// The decliner keeps read access (they can change their mind) — they
	// just don't appear.
	if w := inviteDo(h.Roster, inviteReq(http.MethodGet, "/api/parties/"+code+"/invites",
		"", map[string]string{"code": code}, declID, declName)); w.Code != http.StatusOK {
		t.Errorf("declined invitee lost roster access: %d", w.Code)
	}
}

func TestPartyInvites_FullFlow(t *testing.T) {
	q, pool := requireInviteTestDB(t)
	ctx := context.Background()

	hostID, hostName := seedInviteUser(t, pool, "")
	melID, melName := seedInviteUser(t, pool, "")
	_, kidName := seedInviteUser(t, pool, "PG")
	strangerID, strangerName := seedInviteUser(t, pool, "")

	// R-rated media behind the party (the kid's PG ceiling must reject it).
	var libID, mediaID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1, 'movie', $2, $3) RETURNING id`,
		"invite_lib_"+socialTestSuffix(t), []string{"/tmp/invite_test"}, hostID,
	).Scan(&libID); err != nil {
		t.Fatalf("seed library: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM libraries WHERE id = $1`, libID) })
	if err := pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, content_rating,
		                          year, overview, rating, runtime_minutes)
		 VALUES ($1, 'movie', 'The Shining', 'shining', 'R', 1980, '', 0, 146) RETURNING id`,
		libID,
	).Scan(&mediaID); err != nil {
		t.Fatalf("seed media: %v", err)
	}

	manager := watchparty.NewManager(q, nil)
	scheduledAt := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	ps, err := manager.CreateParty(ctx, hostID, hostName, mediaID, nil,
		hostName+"'s Party", "The Shining", "", 10,
		watchparty.PartySettings{AllowPause: true, AllowChat: true}, 0, &scheduledAt)
	if err != nil {
		t.Fatalf("create party: %v", err)
	}
	code := ps.Code
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM watch_parties WHERE party_code = $1`, code) })

	dispatcher := notify.NewDispatcher(q, nil, nil, nil)
	h := NewPartyInviteHandler(manager, q, dispatcher)

	// ── send: one good, one under a PG ceiling, one unknown, one self ──
	body, _ := json.Marshal(map[string]interface{}{
		"usernames": []string{melName, kidName, "ghost_nobody_x", hostName},
		"note":      "Costumes optional.",
	})
	w := inviteDo(h.SendInvites, inviteReq(http.MethodPost, "/api/parties/"+code+"/invites",
		string(body), map[string]string{"code": code}, hostID, hostName))
	if w.Code != http.StatusOK {
		t.Fatalf("send: code = %d body=%s", w.Code, w.Body.String())
	}
	var sendResp struct {
		Sent    []struct{ Username string }         `json:"sent"`
		Skipped []struct{ Username, Reason string } `json:"skipped"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &sendResp); err != nil {
		t.Fatalf("send resp: %v", err)
	}
	if len(sendResp.Sent) != 1 || sendResp.Sent[0].Username != melName {
		t.Errorf("sent = %+v; want exactly %s", sendResp.Sent, melName)
	}
	reasons := map[string]string{}
	for _, s := range sendResp.Skipped {
		reasons[s.Username] = s.Reason
	}
	if reasons[kidName] != "rating_restricted" {
		t.Errorf("kid skip reason = %q; want rating_restricted (R title vs PG ceiling)", reasons[kidName])
	}
	if reasons["ghost_nobody_x"] != "not_found" {
		t.Errorf("ghost skip reason = %q; want not_found", reasons["ghost_nobody_x"])
	}
	if reasons[hostName] != "self" {
		t.Errorf("self skip reason = %q; want self", reasons[hostName])
	}

	// Delivery: a durable party_invite notification with the deep link.
	var notifLink string
	if err := pool.QueryRow(ctx,
		`SELECT link FROM notifications WHERE user_id = $1 AND type = $2`,
		melID, models.NotificationPartyInvite,
	).Scan(&notifLink); err != nil {
		t.Fatalf("invite notification row: %v", err)
	}
	if notifLink != "/p/"+code {
		t.Errorf("notification link = %q; want /p/%s", notifLink, code)
	}

	// Non-host can't send.
	w = inviteDo(h.SendInvites, inviteReq(http.MethodPost, "/api/parties/"+code+"/invites",
		string(body), map[string]string{"code": code}, melID, melName))
	if w.Code != http.StatusForbidden {
		t.Errorf("non-host send: code = %d; want 403", w.Code)
	}

	// ── roster: invitee sees it, stranger doesn't ──
	w = inviteDo(h.Roster, inviteReq(http.MethodGet, "/api/parties/"+code+"/invites",
		"", map[string]string{"code": code}, melID, melName))
	if w.Code != http.StatusOK {
		t.Fatalf("roster as invitee: code = %d", w.Code)
	}
	var rosterResp struct {
		Invites []models.PartyInviteRosterEntry `json:"invites"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &rosterResp); err != nil {
		t.Fatalf("roster resp: %v", err)
	}
	if len(rosterResp.Invites) != 1 || rosterResp.Invites[0].Username != melName ||
		rosterResp.Invites[0].RSVP != "pending" {
		t.Errorf("roster = %+v; want [%s pending]", rosterResp.Invites, melName)
	}

	w = inviteDo(h.Roster, inviteReq(http.MethodGet, "/api/parties/"+code+"/invites",
		"", map[string]string{"code": code}, strangerID, strangerName))
	if w.Code != http.StatusForbidden {
		t.Errorf("roster as stranger: code = %d; want 403", w.Code)
	}

	// ── RSVP: pending→going pings the host exactly once ──
	inviteID := rosterResp.Invites[0].InviteID
	rsvpBody := `{"rsvp":"going"}`
	w = inviteDo(h.RSVP, inviteReq(http.MethodPost, fmt.Sprintf("/api/party-invites/%d/rsvp", inviteID),
		rsvpBody, map[string]string{"id": fmt.Sprint(inviteID)}, melID, melName))
	if w.Code != http.StatusOK {
		t.Fatalf("rsvp: code = %d body=%s", w.Code, w.Body.String())
	}

	// Wrong user on someone else's invite → 404 (SQL ownership scope).
	w = inviteDo(h.RSVP, inviteReq(http.MethodPost, fmt.Sprintf("/api/party-invites/%d/rsvp", inviteID),
		rsvpBody, map[string]string{"id": fmt.Sprint(inviteID)}, strangerID, strangerName))
	if w.Code != http.StatusNotFound {
		t.Errorf("foreign rsvp: code = %d; want 404", w.Code)
	}

	// Going→maybe→going again must NOT re-ping the host.
	for _, v := range []string{"maybe", "going"} {
		w = inviteDo(h.RSVP, inviteReq(http.MethodPost, fmt.Sprintf("/api/party-invites/%d/rsvp", inviteID),
			fmt.Sprintf(`{"rsvp":%q}`, v), map[string]string{"id": fmt.Sprint(inviteID)}, melID, melName))
		if w.Code != http.StatusOK {
			t.Fatalf("rsvp %s: code = %d", v, w.Code)
		}
	}
	var hostPings int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND type = $2`,
		hostID, models.NotificationPartyRSVP,
	).Scan(&hostPings); err != nil {
		t.Fatalf("count host pings: %v", err)
	}
	if hostPings != 1 {
		t.Errorf("host rsvp pings = %d; want exactly 1 (only the pending→going transition)", hostPings)
	}

	// ── invitee feed carries the schedule ──
	w = inviteDo(h.MyInvites, inviteReq(http.MethodGet, "/api/me/party-invites",
		"", nil, melID, melName))
	if w.Code != http.StatusOK {
		t.Fatalf("my invites: code = %d", w.Code)
	}
	var feedResp struct {
		Invites []models.MyPartyInvite `json:"invites"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &feedResp); err != nil {
		t.Fatalf("feed resp: %v", err)
	}
	if len(feedResp.Invites) != 1 {
		t.Fatalf("feed size = %d; want 1", len(feedResp.Invites))
	}
	got := feedResp.Invites[0]
	if got.PartyCode != code || got.RSVP != "going" || got.HostUsername != hostName ||
		got.Note != "Costumes optional." {
		t.Errorf("feed row = %+v; want code=%s rsvp=going host=%s + note", got, code, hostName)
	}
	if got.ScheduledStartAt == nil || !got.ScheduledStartAt.Equal(scheduledAt) {
		t.Errorf("feed scheduled_start_at = %v; want %v", got.ScheduledStartAt, scheduledAt)
	}
}
