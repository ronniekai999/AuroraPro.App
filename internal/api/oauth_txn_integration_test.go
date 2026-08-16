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
func mintTxn(t *testing.T, q *db.Queries, mode db.OAuthTxnMode, provider, state string, userID, inviteID *int64) string {
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
	t.Cleanup(func() {
		_, _ = q.DeleteExpiredOAuthTransactions(context.Background())
		_ = id
	})
	return token
}

// TestConsumeOAuthTxn_LinkRoundTrip is the accepting case: a link transaction
// minted for this provider and state yields the recorded user id.
func TestConsumeOAuthTxn_LinkRoundTrip(t *testing.T) {
	q, pool := requireOAuthTxnTestDB(t)
	h := newTxnTestHandler(t, q)
	userID := seedTxnTestUser(t, pool)

	token := mintTxn(t, q, db.OAuthTxnModeLink, "google", "state-1", &userID, nil)
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

	token := mintTxn(t, q, db.OAuthTxnModeLink, "google", "state-minted", &userID, nil)
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

	token := mintTxn(t, q, db.OAuthTxnModeLink, "discord", "state-1", &userID, nil)
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

	token := mintTxn(t, q, db.OAuthTxnModeLink, "google", "state-1", &userID, nil)

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
	token := mintTxn(t, q, db.OAuthTxnModeLogin, "google", state, nil, &claimID)

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

// TestStart_RetiringAStaleTransactionReleasesItsInvite pins the sibling leak:
// starting a fresh un-invited flow must release the pending claim held by an
// abandoned one, not merely drop the cookie that addresses it.
func TestStart_RetiringAStaleTransactionReleasesItsInvite(t *testing.T) {
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
	token := mintTxn(t, q, db.OAuthTxnModeLogin, "google", "abandoned-state", nil, &claimID)

	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/start", nil)
	r.AddCookie(&http.Cookie{Name: oauthTxnCookieName, Value: token})
	w := httptest.NewRecorder()

	h.retireStaleOAuthTxn(w, r)

	if _, err := q.ClaimInviteCode(context.Background(), code); err != nil {
		t.Errorf("the abandoned flow's invite should be back in circulation: %v", err)
	}
}
