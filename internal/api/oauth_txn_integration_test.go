package api

// Handler-level integration tests for the OAuth transaction consume path and
// the link session gate.
//
// These cover what the pure unit tests structurally cannot: every interesting
// branch of consumeOAuthTxn and the ACCEPTING side of linkSessionMatches needs
// a real *db.Queries. Without them the state/provider binding and the
// fail-closed direction were asserted only in prose, and no test exercised a
// link that should succeed — so a change breaking all legitimate linking, or
// one degrading a forged token into an ordinary login, would have shipped
// green.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

func requireOAuthTxnTestDB(t *testing.T) (*db.Queries, *pgxpool.Pool) {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping oauth transaction integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping test db: %v", err)
	}
	t.Cleanup(pool.Close)
	return db.NewQueries(pool), pool
}

// newTxnTestHandler builds a handler backed by the real query layer, with the
// stub provider registered under the name it reports.
func newTxnTestHandler(t *testing.T, q *db.Queries) *OAuthHandler {
	t.Helper()
	svc := auth.NewService(config.AuthConfig{
		JWTSecret:         "test-secret-key-that-is-at-least-32-chars-long-for-testing",
		AccessTokenExpiry: 15 * time.Minute,
	})
	return &OAuthHandler{
		queries:   q,
		authSvc:   svc,
		providers: map[string]Provider{"google": linkTestProvider{}},
	}
}

// seedTxnTestUser inserts a throwaway user and returns its id.
func seedTxnTestUser(t *testing.T, pool *pgxpool.Pool) int64 {
	t.Helper()
	suffix := time.Now().UnixNano()
	var id int64
	err := pool.QueryRow(context.Background(),
		`INSERT INTO users (username, email, password_hash)
		 VALUES ($1, $2, $3) RETURNING id`,
		"txnapi_test_"+itoaTxn(suffix),
		"txnapi_test_"+itoaTxn(suffix)+"@example.com",
		"$2a$10$placeholder",
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

func itoaTxn(n int64) string {
	const digits = "0123456789"
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{digits[n%10]}, b...)
		n /= 10
	}
	return string(b)
}

// callbackRequest builds a callback request carrying the given transaction
// token, with chi's {provider} param populated.
func callbackRequest(token, state string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback?state="+state, nil)
	if token != "" {
		r.AddCookie(&http.Cookie{Name: oauthTxnCookieName, Value: token})
	}
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("provider", "google")
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// mintTxn writes a transaction row and returns the raw token addressing it.
func mintTxn(t *testing.T, q *db.Queries, pool *pgxpool.Pool, mode db.OAuthTxnMode, provider, state string, userID, inviteID *int64) string {
	t.Helper()
	token, err := generateOAuthTxnToken()
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}
	id, err := q.CreateOAuthTransaction(context.Background(), hashOAuthTxnToken(token),
		mode, provider, state, userID, inviteID, 10*time.Minute)
	if err != nil {
		t.Fatalf("create transaction: %v", err)
	}
	// Delete exactly this row. Sweeping globally here would leave the row
	// behind (it is not expired) AND mutate other fixtures' invite claims.
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM oauth_transactions WHERE id = $1`, id)
	})
	return token
}

// TestConsumeOAuthTxn_LinkRoundTrip is the accepting case: a link transaction
// minted for this provider and state yields the recorded user id.
func TestConsumeOAuthTxn_LinkRoundTrip(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	token := mintTxn(t, q, pool, db.OAuthTxnModeLink, "google", "state-1", &userID, nil)
	w := httptest.NewRecorder()

	out, ok := h.consumeOAuthTxn(w, callbackRequest(token, "state-1"), "google", "state-1")
	if !ok {
		t.Fatalf("a matching link transaction must be accepted; body: %q", w.Body.String())
	}
	if !out.IsLink || out.LinkUID != userID {
		t.Errorf("outcome = %+v, want IsLink with uid %d", out, userID)
	}
}

// TestConsumeOAuthTxn_RejectsStateMismatch pins the state binding. Deleting the
// binding check must fail this test — without it a transaction minted for one
// flow could be spliced into another.
func TestConsumeOAuthTxn_RejectsStateMismatch(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	token := mintTxn(t, q, pool, db.OAuthTxnModeLink, "google", "state-minted", &userID, nil)
	w := httptest.NewRecorder()

	out, ok := h.consumeOAuthTxn(w, callbackRequest(token, "state-other"), "google", "state-other")
	if ok {
		t.Fatalf("a transaction minted for a different state must be refused, got %+v", out)
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "mismatched sign-in session") {
		t.Errorf("expected the mismatch error page, got: %q", w.Body.String())
	}
}

// TestConsumeOAuthTxn_RejectsProviderMismatch pins the provider half of the
// same binding: a transaction for one provider must not complete on another's
// callback.
func TestConsumeOAuthTxn_RejectsProviderMismatch(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	token := mintTxn(t, q, pool, db.OAuthTxnModeLink, "discord", "state-1", &userID, nil)
	w := httptest.NewRecorder()

	if _, ok := h.consumeOAuthTxn(w, callbackRequest(token, "state-1"), "google", "state-1"); ok {
		t.Fatal("a transaction minted for another provider must be refused")
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "mismatched sign-in session") {
		t.Errorf("expected the mismatch error page, got: %q", w.Body.String())
	}
}

// TestConsumeOAuthTxn_ForgedTokenFailsClosed is the fail-closed direction. A
// token naming no live row must ABORT the flow. Degrading it into an ordinary
// login is the tempting-but-wrong behavior: for a link flow that silently
// discards the safety check, and for an invited signup it leaks a free account.
func TestConsumeOAuthTxn_ForgedTokenFailsClosed(t *testing.T) {
	q, _ := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)

	forged, err := generateOAuthTxnToken()
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}
	w := httptest.NewRecorder()

	out, ok := h.consumeOAuthTxn(w, callbackRequest(forged, "state-1"), "google", "state-1")
	if ok {
		t.Fatalf("a forged token must abort the flow, got %+v", out)
	}
	if !strings.Contains(strings.ToLower(w.Body.String()), "expired or was already used") {
		t.Errorf("expected the not-live error page, got: %q", w.Body.String())
	}
}

// TestConsumeOAuthTxn_ReplayFailsClosed pins single-use at the HANDLER level,
// complementing the query-level replay test in the db package.
func TestConsumeOAuthTxn_ReplayFailsClosed(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	token := mintTxn(t, q, pool, db.OAuthTxnModeLink, "google", "state-1", &userID, nil)

	if _, ok := h.consumeOAuthTxn(httptest.NewRecorder(), callbackRequest(token, "state-1"), "google", "state-1"); !ok {
		t.Fatal("first consume should succeed")
	}
	w := httptest.NewRecorder()
	if _, ok := h.consumeOAuthTxn(w, callbackRequest(token, "state-1"), "google", "state-1"); ok {
		t.Fatal("replaying a consumed transaction must abort the flow")
	}
}

// TestLinkSessionMatches_AcceptsValidSession is the accepting case for the
// session gate — the one no unit test could reach, because verifying a matching
// uid requires loading the user's token_version from the database.
func TestLinkSessionMatches_AcceptsValidSession(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	user, err := q.GetUserByID(context.Background(), userID)
	if err != nil || user == nil {
		t.Fatalf("load seeded user: %v", err)
	}
	token, _, err := h.authSvc.GenerateAccessToken(userID, user.Username, "user", user.TokenVersion, 0)
	if err != nil {
		t.Fatalf("generate access token: %v", err)
	}

	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback", nil)
	r.AddCookie(&http.Cookie{Name: auth.AccessCookieName, Value: token})

	if !h.linkSessionMatches(context.Background(), r, userID) {
		t.Error("a valid current session for the link target must be accepted")
	}
}

// TestLinkSessionMatches_RejectsStaleTokenVersion pins that a password change
// landing mid-flow invalidates the link, matching what the auth middleware
// enforces on every other authenticated route.
func TestLinkSessionMatches_RejectsStaleTokenVersion(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	user, err := q.GetUserByID(context.Background(), userID)
	if err != nil || user == nil {
		t.Fatalf("load seeded user: %v", err)
	}
	token, _, err := h.authSvc.GenerateAccessToken(userID, user.Username, "user", user.TokenVersion, 0)
	if err != nil {
		t.Fatalf("generate access token: %v", err)
	}
	// Simulate the password change that bumps the persisted version.
	if _, err := pool.Exec(context.Background(),
		`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, userID); err != nil {
		t.Fatalf("bump token version: %v", err)
	}

	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback", nil)
	r.AddCookie(&http.Cookie{Name: auth.AccessCookieName, Value: token})

	if h.linkSessionMatches(context.Background(), r, userID) {
		t.Error("a token superseded by a password change must not authorize a link")
	}
}

// TestLinkSessionMatches_RefreshFallback pins the fallback that keeps linking
// usable when the short-lived access token ages out during the provider
// round-trip: no access cookie, but a live refresh row for the same user.
func TestLinkSessionMatches_RefreshFallback(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	refreshStr, err := h.authSvc.GenerateRefreshToken()
	if err != nil {
		t.Fatalf("generate refresh token: %v", err)
	}
	rt := &models.RefreshToken{
		UserID:    userID,
		Token:     refreshStr,
		ExpiresAt: time.Now().Add(24 * time.Hour),
	}
	if err := q.CreateRefreshToken(context.Background(), rt); err != nil {
		t.Fatalf("persist refresh token: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM refresh_tokens WHERE id = $1`, rt.ID)
	})

	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback", nil)
	r.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: refreshStr})

	if !h.linkSessionMatches(context.Background(), r, userID) {
		t.Error("a live refresh token for the link target must be accepted")
	}
	// …but not for somebody else's account.
	if h.linkSessionMatches(context.Background(), r, userID+100000) {
		t.Error("a refresh token must not authorize linking a different account")
	}
}

// TestCallback_DeclinedConsentReleasesInviteClaim is the regression test for the
// invite-destroying abort path.
//
// The transaction is consumed before the code exchange, so unlike the old
// cookie it cannot survive an abort and be retried. Declining the provider's
// consent screen is an ordinary user action, and if the claim is not released
// the invite is left used_at-set/used_by-null — a state ClaimInviteCode can
// never claim again, with no reaper or admin endpoint to repair it. Declining
// consent would silently destroy the invite.
func TestCallback_DeclinedConsentReleasesInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	owner := seedTxnTestUser(t, pool)

	// A real, claimable invite.
	code := "declinetest_" + itoaTxn(time.Now().UnixNano())
	var inviteID int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO invite_codes (code, created_by, expires_at)
		 VALUES ($1, $2, NOW() + INTERVAL '7 days') RETURNING id`, code, owner,
	).Scan(&inviteID); err != nil {
		t.Fatalf("seed invite: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM invite_codes WHERE id = $1`, inviteID)
	})

	claimID, err := q.ClaimInviteCode(context.Background(), code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	const state = "state-decline"
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", state, nil, &claimID)

	// Callback with NO ?code= — exactly what the provider sends when the user
	// declines consent.
	r := callbackRequest(token, state)
	r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: state})
	w := httptest.NewRecorder()

	h.Callback(w, r)

	if !strings.Contains(strings.ToLower(w.Body.String()), "cancelled") {
		t.Fatalf("expected the declined-consent page, got: %q", w.Body.String())
	}

	// The invite must be back in circulation.
	reclaimed, err := q.ClaimInviteCode(context.Background(), code)
	if err != nil {
		t.Fatalf("invite was not released by the aborted flow — it is now permanently unclaimable: %v", err)
	}
	if reclaimed != inviteID {
		t.Errorf("reclaimed id = %d, want %d", reclaimed, inviteID)
	}
}

// TestRetireStaleOAuthTxn_ReleasesItsInvite pins the helper directly: retiring
// an abandoned flow must release the pending claim it held, not merely drop the
// cookie that addresses it. The call SITES are pinned separately by
// TestStart_ReleasesPreviousFlowsInviteClaim below.
func TestRetireStaleOAuthTxn_ReleasesItsInvite(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	owner := seedTxnTestUser(t, pool)

	code := "staletest_" + itoaTxn(time.Now().UnixNano())
	var inviteID int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO invite_codes (code, created_by, expires_at)
		 VALUES ($1, $2, NOW() + INTERVAL '7 days') RETURNING id`, code, owner,
	).Scan(&inviteID); err != nil {
		t.Fatalf("seed invite: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM invite_codes WHERE id = $1`, inviteID)
	})

	claimID, err := q.ClaimInviteCode(context.Background(), code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", "abandoned-state", nil, &claimID)

	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/start", nil)
	r.AddCookie(&http.Cookie{Name: oauthTxnCookieName, Value: token})
	w := httptest.NewRecorder()

	h.retireStaleOAuthTxn(w, r)

	if _, err := q.ClaimInviteCode(context.Background(), code); err != nil {
		t.Errorf("the abandoned flow's invite should be back in circulation: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Start / StartLink. No test touched either handler before, which left the
// criterion-1 write itself unpinned: StartLink recording the WRONG user id is
// the whole account-takeover bug, and only linkSessionMatches stood between
// that and a live exploit.
// ---------------------------------------------------------------------------

// authedRequest builds a request carrying auth claims the way RequireAuth would.
func authedRequest(method, target string, claims *auth.JWTClaims) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("provider", "google")
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, rctx)
	ctx = context.WithValue(ctx, auth.ClaimsContextKey, claims)
	return r.WithContext(ctx)
}

// txnCookieFrom pulls the transaction token out of a response's Set-Cookie
// headers, ignoring the clearing form (empty value).
func txnCookieFrom(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	for _, c := range w.Result().Cookies() {
		if c.Name == oauthTxnCookieName && c.Value != "" {
			return c.Value
		}
	}
	return ""
}

// TestStartLink_RecordsTheAuthenticatedCallerAsLinkTarget pins the single
// assignment that IS the authorization decision behind criterion 1: the link
// transaction must name the caller's own user id and nobody else's.
//
// Nothing else pins it. linkSessionMatches would refuse a wrong id at callback
// time, so a defect here fails closed rather than opening a hole — but it would
// silently break all linking, and it is the exact line whose corruption the
// original vulnerability consisted of.
func TestStartLink_RecordsTheAuthenticatedCallerAsLinkTarget(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	claims := &auth.JWTClaims{UserID: userID, Username: "linker", Role: "user"}
	r := authedRequest(http.MethodPost, "/api/auth/oauth/google/link", claims)
	w := httptest.NewRecorder()

	h.StartLink(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("StartLink status = %d, body %q", w.Code, w.Body.String())
	}
	token := txnCookieFrom(t, w)
	if token == "" {
		t.Fatal("StartLink set no transaction cookie")
	}
	txn, err := q.ConsumeOAuthTransaction(context.Background(), hashOAuthTxnToken(token))
	if err != nil {
		t.Fatalf("the minted transaction should be live: %v", err)
	}
	if txn.Mode != db.OAuthTxnModeLink {
		t.Errorf("mode = %q, want link", txn.Mode)
	}
	if txn.UserID == nil || *txn.UserID != userID {
		t.Fatalf("link target = %v, want the authenticated caller %d", txn.UserID, userID)
	}
	if txn.Provider != "google" {
		t.Errorf("provider = %q, want google", txn.Provider)
	}
	if txn.State == "" {
		t.Error("transaction must be bound to a state")
	}
}

// TestStartLink_ReleasesPreviousFlowsInviteClaim pins that starting a link
// retires an abandoned invited signup rather than orphaning its claim. The
// cookie is about to be overwritten, and it is the only handle to that row.
func TestStartLink_ReleasesPreviousFlowsInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	code, _ := seedClaimableInvite(t, q, pool, userID, "linkstale")
	claimID, err := q.ClaimInviteCode(context.Background(), code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	stale := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", "abandoned", nil, &claimID)

	claims := &auth.JWTClaims{UserID: userID, Username: "linker", Role: "user"}
	r := authedRequest(http.MethodPost, "/api/auth/oauth/google/link", claims)
	r.AddCookie(&http.Cookie{Name: oauthTxnCookieName, Value: stale})
	w := httptest.NewRecorder()

	h.StartLink(w, r)

	if _, err := q.ClaimInviteCode(context.Background(), code); err != nil {
		t.Errorf("the abandoned signup's invite should be back in circulation: %v", err)
	}
}

// TestStart_InvitedFlowMintsTransactionCarryingTheClaim pins the invite
// pre-flight: the code must be claimed AND its id recorded server-side, since
// that recording is what replaced the forgeable cookie.
func TestStart_InvitedFlowMintsTransactionCarryingTheClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	owner := seedTxnTestUser(t, pool)

	code, inviteID := seedClaimableInvite(t, q, pool, owner, "startinv")

	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/start?invite="+code, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("provider", "google")
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	w := httptest.NewRecorder()

	h.Start(w, r)

	token := txnCookieFrom(t, w)
	if token == "" {
		t.Fatal("an invited Start must mint a transaction")
	}
	txn, err := q.ConsumeOAuthTransaction(context.Background(), hashOAuthTxnToken(token))
	if err != nil {
		t.Fatalf("the minted transaction should be live: %v", err)
	}
	if txn.Mode != db.OAuthTxnModeLogin {
		t.Errorf("mode = %q, want login", txn.Mode)
	}
	if txn.InviteID == nil || *txn.InviteID != inviteID {
		t.Fatalf("invite id = %v, want %d", txn.InviteID, inviteID)
	}
	if txn.UserID != nil {
		t.Errorf("a login transaction must not name a user, got %v", txn.UserID)
	}
}

// TestStart_ReleasesPreviousFlowsInviteClaim pins the retire CALL SITE in Start
// (as opposed to the helper, which is pinned separately). Removing the call
// leaves code A stranded when the user goes back and starts again with code B.
func TestStart_ReleasesPreviousFlowsInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	owner := seedTxnTestUser(t, pool)

	codeA, _ := seedClaimableInvite(t, q, pool, owner, "startA")
	codeB, _ := seedClaimableInvite(t, q, pool, owner, "startB")

	claimA, err := q.ClaimInviteCode(context.Background(), codeA)
	if err != nil {
		t.Fatalf("claim A: %v", err)
	}
	staleToken := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", "abandoned-A", nil, &claimA)

	// Second Start, this time with code B — the cookie for A is about to be
	// overwritten, so A must be released on the way through.
	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/start?invite="+codeB, nil)
	r.AddCookie(&http.Cookie{Name: oauthTxnCookieName, Value: staleToken})
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("provider", "google")
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	w := httptest.NewRecorder()

	h.Start(w, r)

	if _, err := q.ClaimInviteCode(context.Background(), codeA); err != nil {
		t.Errorf("code A should have been released by the second Start: %v", err)
	}
}

// TestCallback_StateMismatchReleasesInviteClaim pins that a state failure — which
// returns before the transaction is consumed — still retires the flow instead of
// stranding the claim.
func TestCallback_StateMismatchReleasesInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	owner := seedTxnTestUser(t, pool)

	code, _ := seedClaimableInvite(t, q, pool, owner, "statemis")
	claimID, err := q.ClaimInviteCode(context.Background(), code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", "the-real-state", nil, &claimID)

	// Callback whose state cookie disagrees with the query parameter.
	r := callbackRequest(token, "the-real-state")
	r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: "a-different-state"})
	w := httptest.NewRecorder()

	h.Callback(w, r)

	if !strings.Contains(strings.ToLower(w.Body.String()), "state mismatch") {
		t.Fatalf("expected the state-mismatch page, got: %q", w.Body.String())
	}
	if _, err := q.ClaimInviteCode(context.Background(), code); err != nil {
		t.Errorf("a state failure must not strand the invite: %v", err)
	}
}

// TestDeleteExpiredOAuthTransactions_FreesAbandonedInviteClaims pins the sweep's
// repair half — the most common abandonment of all: the user closes the tab at
// the provider's consent screen, so no callback ever runs.
func TestDeleteExpiredOAuthTransactions_FreesAbandonedInviteClaims(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	owner := seedTxnTestUser(t, pool)
	ctx := context.Background()

	code, _ := seedClaimableInvite(t, q, pool, owner, "sweepfree")
	claimID, err := q.ClaimInviteCode(ctx, code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	// An expired, never-consumed login transaction: the tab-close case.
	if _, err := q.CreateOAuthTransaction(ctx, hashOAuthTxnToken("abandoned-"+itoaTxn(time.Now().UnixNano())),
		db.OAuthTxnModeLogin, "google", "s", nil, &claimID, -1*time.Minute); err != nil {
		t.Fatalf("create expired transaction: %v", err)
	}

	if _, _, err := q.DeleteExpiredOAuthTransactions(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if _, err := q.ClaimInviteCode(ctx, code); err != nil {
		t.Errorf("the sweep must release an abandoned claim, else the invite is lost forever: %v", err)
	}
}

// TestDeleteExpiredOAuthTransactions_WontReopenARedeemedInvite is the other side
// of the sweep: it must never hand back an invite that was actually used.
func TestDeleteExpiredOAuthTransactions_WontReopenARedeemedInvite(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	owner := seedTxnTestUser(t, pool)
	redeemer := seedTxnTestUser(t, pool)
	ctx := context.Background()

	code, inviteID := seedClaimableInvite(t, q, pool, owner, "sweepkeep")
	claimID, err := q.ClaimInviteCode(ctx, code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	if err := q.FinalizeInviteCode(ctx, claimID, redeemer); err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if _, err := q.CreateOAuthTransaction(ctx, hashOAuthTxnToken("spent-"+itoaTxn(time.Now().UnixNano())),
		db.OAuthTxnModeLogin, "google", "s", nil, &claimID, -1*time.Minute); err != nil {
		t.Fatalf("create expired transaction: %v", err)
	}

	if _, _, err := q.DeleteExpiredOAuthTransactions(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	var usedBy *int64
	if err := pool.QueryRow(ctx, `SELECT used_by FROM invite_codes WHERE id = $1`, inviteID).Scan(&usedBy); err != nil {
		t.Fatalf("read invite: %v", err)
	}
	if usedBy == nil || *usedBy != redeemer {
		t.Errorf("a redeemed invite must stay redeemed, got used_by = %v", usedBy)
	}
}

// seedClaimableInvite inserts an unclaimed, unexpired invite and returns its
// code and id.
func seedClaimableInvite(t *testing.T, q *db.Queries, pool *pgxpool.Pool, owner int64, prefix string) (string, int64) {
	t.Helper()
	code := prefix + "_" + itoaTxn(time.Now().UnixNano())
	var id int64
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO invite_codes (code, created_by, expires_at)
		 VALUES ($1, $2, NOW() + INTERVAL '7 days') RETURNING id`, code, owner,
	).Scan(&id); err != nil {
		t.Fatalf("seed invite: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM invite_codes WHERE id = $1`, id)
	})
	return code, id
}

// ---------------------------------------------------------------------------
// Paths past the token exchange. Reaching them needs a provider whose Config
// points at a live token endpoint, so a fake one is stood up here. Without it
// the empty-email abort and the tier-1/2 unclaim are unreachable from tests.
// ---------------------------------------------------------------------------

// exchangingProvider completes a real oauth2 code exchange against a local test
// server, then returns a canned profile.
type exchangingProvider struct {
	tokenURL string
	profile  *OAuthProfile
}

func (p exchangingProvider) Name() string { return "google" }
func (p exchangingProvider) Config(context.Context) (*oauth2.Config, error) {
	return &oauth2.Config{
		ClientID:     "test-client",
		ClientSecret: "test-secret",
		Endpoint:     oauth2.Endpoint{TokenURL: p.tokenURL, AuthURL: p.tokenURL + "/auth"},
	}, nil
}
func (p exchangingProvider) FetchUserInfo(context.Context, *http.Client) (*OAuthProfile, error) {
	return p.profile, nil
}
func (p exchangingProvider) BypassInviteEnabled(context.Context) bool { return false }

// newExchangingHandler wires a handler whose "google" provider will actually
// complete a code exchange and hand back the given profile.
func newExchangingHandler(t *testing.T, q *db.Queries, profile *OAuthProfile) *OAuthHandler {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"test-token","token_type":"Bearer","expires_in":3600}`))
	}))
	t.Cleanup(srv.Close)

	h := newTxnTestHandler(t, q)
	h.providers = map[string]Provider{"google": exchangingProvider{tokenURL: srv.URL, profile: profile}}
	return h
}

// TestCallback_EmptyEmailReleasesInviteClaim covers the second abort path past
// the consume. A provider that returns no usable email fails the login, and the
// claim must go back — the same permanent-loss hazard as declined consent, just
// reached one step later.
func TestCallback_EmptyEmailReleasesInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	owner := seedTxnTestUser(t, pool)
	h := newExchangingHandler(t, q, &OAuthProfile{Subject: "subject-no-email", Email: ""})

	code, _ := seedClaimableInvite(t, q, pool, owner, "noemail")
	claimID, err := q.ClaimInviteCode(context.Background(), code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	const state = "state-noemail"
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", state, nil, &claimID)

	r := callbackRequest(token, state)
	r.URL.RawQuery = "state=" + state + "&code=auth-code"
	r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: state})
	w := httptest.NewRecorder()

	h.Callback(w, r)

	if !strings.Contains(strings.ToLower(w.Body.String()), "complete profile") {
		t.Fatalf("expected the incomplete-profile page, got: %q", w.Body.String())
	}
	if _, err := q.ClaimInviteCode(context.Background(), code); err != nil {
		t.Errorf("an incomplete profile must not strand the invite: %v", err)
	}
}

// TestCallback_ExistingUserReleasesUnusedInviteClaim covers the tier-1 path: a
// caller who already has an account does not consume an invite, so the code
// they happened to be carrying must go back into circulation rather than being
// silently burned.
func TestCallback_ExistingUserReleasesUnusedInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	ctx := context.Background()
	existing := seedTxnTestUser(t, pool)
	owner := seedTxnTestUser(t, pool)

	const subject = "existing-subject-1"
	if err := q.AddOAuthIdentity(ctx, existing, "google", subject); err != nil {
		t.Fatalf("seed oauth identity: %v", err)
	}
	h := newExchangingHandler(t, q, &OAuthProfile{
		Subject: subject, Email: "existing@example.com", EmailVerified: true,
	})

	code, _ := seedClaimableInvite(t, q, pool, owner, "tier1")
	claimID, err := q.ClaimInviteCode(ctx, code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	const state = "state-tier1"
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", state, nil, &claimID)

	r := callbackRequest(token, state)
	r.URL.RawQuery = "state=" + state + "&code=auth-code"
	r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: state})
	w := httptest.NewRecorder()

	h.Callback(w, r)

	if _, err := q.ClaimInviteCode(ctx, code); err != nil {
		t.Errorf("an existing-user login must not consume the invite: %v", err)
	}
}

// TestConsumeOAuthTxn_MismatchReleasesInviteClaim is the regression test for the
// last abandonment hole.
//
// The binding checks run AFTER the row is consumed, so their fail-closed
// returns own the claim's fate: the sweep deliberately skips consumed rows, so
// walking away here strands the invite at used_at-set/used_by-null with nothing
// left in the system able to repair it. Worse than the paths already fixed,
// because the repair mechanism is switched off for it by design.
func TestConsumeOAuthTxn_MismatchReleasesInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	owner := seedTxnTestUser(t, pool)
	ctx := context.Background()

	code, _ := seedClaimableInvite(t, q, pool, owner, "bindmis")
	claimID, err := q.ClaimInviteCode(ctx, code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	// Minted for discord, completing on google's callback.
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "discord", "state-1", nil, &claimID)

	w := httptest.NewRecorder()
	if _, ok := h.consumeOAuthTxn(w, callbackRequest(token, "state-1"), "google", "state-1"); ok {
		t.Fatal("a provider mismatch must abort the flow")
	}
	if _, err := q.ClaimInviteCode(ctx, code); err != nil {
		t.Errorf("a mismatch must release the claim — the sweep cannot, the row is consumed: %v", err)
	}
}

// TestConsumeOAuthTxn_StateMismatchReleasesInviteClaim covers the state half of
// the same guard.
func TestConsumeOAuthTxn_StateMismatchReleasesInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	owner := seedTxnTestUser(t, pool)
	ctx := context.Background()

	code, _ := seedClaimableInvite(t, q, pool, owner, "bindstate")
	claimID, err := q.ClaimInviteCode(ctx, code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", "state-minted", nil, &claimID)

	w := httptest.NewRecorder()
	if _, ok := h.consumeOAuthTxn(w, callbackRequest(token, "state-other"), "google", "state-other"); ok {
		t.Fatal("a state mismatch must abort the flow")
	}
	if _, err := q.ClaimInviteCode(ctx, code); err != nil {
		t.Errorf("a state mismatch must release the claim: %v", err)
	}
}

// TestSweep_SkipsConsumedTransactions pins the guard that keeps the sweep from
// second-guessing a callback that already decided a claim's fate. Removing it
// would let the sweep reopen an invite whose flow deliberately kept it.
func TestSweep_SkipsConsumedTransactions(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	owner := seedTxnTestUser(t, pool)
	ctx := context.Background()

	code, inviteID := seedClaimableInvite(t, q, pool, owner, "sweepconsumed")
	claimID, err := q.ClaimInviteCode(ctx, code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	// An expired row that WAS consumed: the callback already ran.
	hash := hashOAuthTxnToken("consumed-" + itoaTxn(time.Now().UnixNano()))
	if _, err := q.CreateOAuthTransaction(ctx, hash, db.OAuthTxnModeLogin, "google", "s",
		nil, &claimID, 10*time.Minute); err != nil {
		t.Fatalf("create transaction: %v", err)
	}
	if _, err := q.ConsumeOAuthTransaction(ctx, hash); err != nil {
		t.Fatalf("consume: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE oauth_transactions SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1`,
		hash); err != nil {
		t.Fatalf("expire: %v", err)
	}

	// Assert on THIS fixture's invite, not the process-wide freed count: the
	// sweep is global and `go test ./...` runs packages against one database.
	if _, _, err := q.DeleteExpiredOAuthTransactions(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	var usedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT used_at FROM invite_codes WHERE id = $1`, inviteID).Scan(&usedAt); err != nil {
		t.Fatalf("read invite: %v", err)
	}
	if usedAt == nil {
		t.Error("the sweep must not have touched a consumed transaction's claim")
	}
}

// TestSweep_FreedCountCountsOnlyRealReleases pins the accuracy of the number
// that gets logged as "codes recovered from abandoned signups". Without the
// used_at predicate the join also matches never-claimed invites and inflates it.
func TestSweep_FreedCountCountsOnlyRealReleases(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	owner := seedTxnTestUser(t, pool)
	ctx := context.Background()

	// An expired, unconsumed transaction pointing at an invite that was never
	// claimed — nothing to recover.
	_, inviteID := seedClaimableInvite(t, q, pool, owner, "sweepcount")
	if _, err := q.CreateOAuthTransaction(ctx, hashOAuthTxnToken("noclaim-"+itoaTxn(time.Now().UnixNano())),
		db.OAuthTxnModeLogin, "google", "s", nil, &inviteID, -1*time.Minute); err != nil {
		t.Fatalf("create transaction: %v", err)
	}

	// Scoped to this fixture: the invite was never claimed, so the sweep must
	// leave it exactly as it found it. Asserting on the process-wide freed
	// count would couple this to every other test sharing the database.
	if _, _, err := q.DeleteExpiredOAuthTransactions(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	var usedBy *int64
	var usedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT used_by, used_at FROM invite_codes WHERE id = $1`, inviteID).Scan(&usedBy, &usedAt); err != nil {
		t.Fatalf("read invite: %v", err)
	}
	if usedBy != nil || usedAt != nil {
		t.Errorf("an unclaimed invite must be untouched, got used_by=%v used_at=%v", usedBy, usedAt)
	}
}

// TestCallback_MissingStateCookieReleasesInviteClaim pins the retire call on the
// missing-state-cookie branch, the sibling of the state-mismatch branch.
func TestCallback_MissingStateCookieReleasesInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	owner := seedTxnTestUser(t, pool)
	ctx := context.Background()

	code, _ := seedClaimableInvite(t, q, pool, owner, "nostate")
	claimID, err := q.ClaimInviteCode(ctx, code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", "s", nil, &claimID)

	// No state cookie at all.
	r := callbackRequest(token, "s")
	w := httptest.NewRecorder()
	h.Callback(w, r)

	if !strings.Contains(strings.ToLower(w.Body.String()), "missing state cookie") {
		t.Fatalf("expected the missing-state page, got: %q", w.Body.String())
	}
	if _, err := q.ClaimInviteCode(ctx, code); err != nil {
		t.Errorf("a missing state cookie must not strand the invite: %v", err)
	}
}

// TestCallback_ResolveFailureReleasesInviteClaim pins the caller-side unclaim on
// resolveOAuthUser's error return.
//
// That release became single-sourced when the duplicate inside
// resolveOAuthUser's finalize rollback was removed (the duplicate opened a
// window where a concurrent registration's fresh claim could be wiped). The
// argument for removing it was "the caller unclaims on every error return" —
// which holds, but left the surviving call untested.
//
// The error used here is tier 2's already-linked conflict: the email matches an
// existing verified account that already has a different identity for this
// provider. Nothing was consumed, so the invite must go back.
func TestCallback_ResolveFailureReleasesInviteClaim(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	ctx := context.Background()
	owner := seedTxnTestUser(t, pool)
	existing := seedTxnTestUser(t, pool)

	var email string
	if err := pool.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, existing).Scan(&email); err != nil {
		t.Fatalf("read email: %v", err)
	}
	// The account already has a google identity, so tier 2's auto-link of a
	// SECOND google subject onto it is refused.
	if err := q.AddOAuthIdentity(ctx, existing, "google", "already-linked-subject"); err != nil {
		t.Fatalf("seed identity: %v", err)
	}
	h := newExchangingHandler(t, q, &OAuthProfile{
		Subject: "a-different-subject", Email: email, EmailVerified: true,
	})

	code, _ := seedClaimableInvite(t, q, pool, owner, "resolvefail")
	claimID, err := q.ClaimInviteCode(ctx, code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	const state = "state-resolvefail"
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", state, nil, &claimID)

	r := callbackRequest(token, state)
	r.URL.RawQuery = "state=" + state + "&code=auth-code"
	r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: state})
	w := httptest.NewRecorder()

	h.Callback(w, r)

	if !strings.Contains(strings.ToLower(w.Body.String()), "authentication failed") {
		t.Fatalf("expected the resolve-failure page, got: %q", w.Body.String())
	}
	if _, err := q.ClaimInviteCode(ctx, code); err != nil {
		t.Errorf("a failed resolve must release the invite claim: %v", err)
	}
}

// TestCallback_InvitedSignupFinalizesTheInvite pins the invite lifecycle's
// POSITIVE terminal state, which nothing else asserts.
//
// Every other invite test in this file checks that a claim was RELEASED. That
// asymmetry let two lifecycle-breaking mutants live: adding a release to the
// login success path (which would break every invited OAuth signup, since
// FinalizeInviteCode then fails its used_at predicate and the new user is
// rolled back), and skipping FinalizeInviteCode entirely (which enrols the user
// and strands the invite at used_at-set/used_by-null on the SUCCESS path, with
// the sweep switched off for it because the transaction is consumed).
//
// Tier 3 is reached with a verified email matching no existing account.
func TestCallback_InvitedSignupFinalizesTheInvite(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	ctx := context.Background()
	owner := seedTxnTestUser(t, pool)

	newEmail := "invited_" + itoaTxn(time.Now().UnixNano()) + "@example.com"
	h := newExchangingHandler(t, q, &OAuthProfile{
		Subject: "brand-new-subject-" + itoaTxn(time.Now().UnixNano()),
		Email:   newEmail, EmailVerified: true,
	})
	// Tier 3 creates a real user; clean it up whatever the outcome.
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE email = $1`, newEmail)
	})

	code, inviteID := seedClaimableInvite(t, q, pool, owner, "invitedok")
	claimID, err := q.ClaimInviteCode(ctx, code)
	if err != nil {
		t.Fatalf("claim invite: %v", err)
	}
	const state = "state-invited"
	token := mintTxn(t, q, pool, db.OAuthTxnModeLogin, "google", state, nil, &claimID)

	r := callbackRequest(token, state)
	r.URL.RawQuery = "state=" + state + "&code=auth-code"
	r.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: state})
	w := httptest.NewRecorder()

	h.Callback(w, r)

	// The signup must have succeeded.
	created, err := q.GetUserByEmail(ctx, newEmail)
	if err != nil {
		t.Fatalf("look up created user: %v", err)
	}
	if created == nil {
		t.Fatalf("the invited signup did not create a user; page was: %q", w.Body.String())
	}

	// …and the invite must be SPENT BY THEM — neither released nor stranded.
	var usedBy *int64
	var usedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT used_by, used_at FROM invite_codes WHERE id = $1`, inviteID).Scan(&usedBy, &usedAt); err != nil {
		t.Fatalf("read invite: %v", err)
	}
	if usedBy == nil {
		if usedAt != nil {
			t.Fatal("invite is STRANDED: used_at set with no used_by, and the sweep skips consumed transactions")
		}
		t.Fatal("invite was released instead of finalized — the signup consumed it")
	}
	if *usedBy != created.ID {
		t.Errorf("invite used_by = %d, want the new user %d", *usedBy, created.ID)
	}
}
