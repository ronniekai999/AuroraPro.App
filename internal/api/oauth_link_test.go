package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
	"golang.org/x/oauth2"
)

// TestWouldLockOutUnlink pins the security-critical lockout guard: an unlink is
// refused exactly when removing it would leave the user with no sign-in method
// (no password AND no other OAuth identity). This is the invariant the
// DELETE /oauth/{provider}/link handler enforces before touching the DB.
func TestWouldLockOutUnlink(t *testing.T) {
	cases := []struct {
		name        string
		hasPassword bool
		nIdentities int
		wantLockout bool
	}{
		// Passwordless user with a single identity: removing it locks them out.
		{"passwordless, 1 identity", false, 1, true},
		// Passwordless with two identities: one can go, the other remains.
		{"passwordless, 2 identities", false, 2, false},
		// Has a password: any single identity can always be removed.
		{"password, 1 identity", true, 1, false},
		{"password, 0 identities", true, 0, false},
		// Degenerate: passwordless with 0 identities — nothing to remove; the
		// predicate stays total and reports "would lock out" (the handler 404s
		// downstream anyway).
		{"passwordless, 0 identities", false, 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := wouldLockOutUnlink(tc.hasPassword, tc.nIdentities); got != tc.wantLockout {
				t.Errorf("wouldLockOutUnlink(%v, %d) = %v, want %v",
					tc.hasPassword, tc.nIdentities, got, tc.wantLockout)
			}
		})
	}
}

// linkTestProvider is a minimal Provider stub for exercising handleLinkCallback
// branches that return before any provider call.
type linkTestProvider struct{}

func (linkTestProvider) Name() string { return "google" }
func (linkTestProvider) Config(context.Context) (*oauth2.Config, error) {
	return &oauth2.Config{}, nil
}
func (linkTestProvider) FetchUserInfo(context.Context, *http.Client) (*OAuthProfile, error) {
	// Must never be reached by the tests below: every one of them asserts that
	// handleLinkCallback bails out BEFORE the code exchange. Returning an empty
	// profile keeps the stub total; reaching it shows up as a failed assertion
	// on the rendered body.
	return &OAuthProfile{}, nil
}
func (linkTestProvider) BypassInviteEnabled(context.Context) bool { return false }

func newLinkTestHandler() *OAuthHandler {
	svc := auth.NewService(config.AuthConfig{
		JWTSecret:         "test-secret-key-that-is-at-least-32-chars-long-for-testing",
		AccessTokenExpiry: 15 * time.Minute,
	})
	return &OAuthHandler{authSvc: svc}
}

// TestHandleLinkCallback_RequiresLiveSession is the regression test for the
// account-takeover bug (audit C-01).
//
// The old link branch derived its target user from aurora_oauth_link_uid, a
// cookie whose value was a bare user id. HttpOnly kept page JavaScript from
// reading that cookie but placed no constraint whatsoever on what a caller
// could SEND, and the session cross-check only ran when a valid access cookie
// happened to be present — absent or expired fell through to trusting the
// cookie. So an attacker ran their own provider sign-in while naming a
// victim's id and sending no session at all, and their OAuth identity was
// attached to the victim's account; signing in "as themselves" afterwards
// logged them in as the victim, administrators included.
//
// The target now comes from a server-written transaction row rather than the
// request, and this test pins the second half of the fix: with NO session
// cookies, the link must abort before the code exchange rather than proceed.
func TestHandleLinkCallback_RequiresLiveSession(t *testing.T) {
	h := newLinkTestHandler()

	// No access cookie, no refresh cookie — exactly the shape that used to be
	// treated as "trust the link cookie".
	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback?code=abc&state=xyz", nil)
	w := httptest.NewRecorder()

	h.handleLinkCallback(w, r, linkTestProvider{}, &oauth2.Config{}, 99)

	body := strings.ToLower(w.Body.String())
	if !strings.Contains(body, "session changed or expired") {
		t.Errorf("unauthenticated link must be refused; got body: %q", w.Body.String())
	}
}

// TestHandleLinkCallback_UIDMismatch verifies the link-mode cross-check: when a
// VALID session access cookie is present but its uid differs from the link
// target, the link is aborted BEFORE any code exchange. This is the defense
// against a session swapping mid-link (e.g. the user logged into a different
// account in another tab).
func TestHandleLinkCallback_UIDMismatch(t *testing.T) {
	h := newLinkTestHandler()
	// Session token says the caller is user 7…
	sessionToken, _, err := h.authSvc.GenerateAccessToken(7, "seven", "user", 0, 0)
	if err != nil {
		t.Fatalf("generate session token: %v", err)
	}

	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback?code=abc&state=xyz", nil)
	r.AddCookie(&http.Cookie{Name: auth.AccessCookieName, Value: sessionToken})
	w := httptest.NewRecorder()

	// …but the link flow was started for user 99.
	h.handleLinkCallback(w, r, linkTestProvider{}, &oauth2.Config{}, 99)

	body := strings.ToLower(w.Body.String())
	if !strings.Contains(body, "session changed or expired") {
		t.Errorf("expected the session-mismatch error page, got body: %q", w.Body.String())
	}
}

// TestLinkSessionMatches_RejectsScopedToken pins that a narrow-scoped token
// cannot authorize a link. Cast tokens authenticate a playback device, not a
// person managing their account's sign-in methods.
//
// Note WHERE the refusal comes from: ValidateAccessToken already rejects any
// token with a non-empty Scope, so the cast token fails validation and falls
// through to the (absent) refresh cookie. linkSessionMatches has its own Scope
// check as well, but it is not the control doing the work here. The property
// under test is the outcome, which holds either way.
//
// This path returns before any database access, which is why it is exercisable
// with a nil Queries.
func TestLinkSessionMatches_RejectsScopedToken(t *testing.T) {
	h := newLinkTestHandler()
	castToken, _, err := h.authSvc.GenerateCastToken(7, "seven", "user", 0, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("generate cast token: %v", err)
	}

	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback", nil)
	r.AddCookie(&http.Cookie{Name: auth.AccessCookieName, Value: castToken})

	if h.linkSessionMatches(context.Background(), r, 7) {
		t.Error("a cast-scoped token must not authorize an account link")
	}
}

// TestLinkSessionMatches_NoCookies is the narrow unit-level statement of the
// fail-closed rule: nothing presented means no link.
func TestLinkSessionMatches_NoCookies(t *testing.T) {
	h := newLinkTestHandler()
	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback", nil)
	if h.linkSessionMatches(context.Background(), r, 7) {
		t.Error("no session cookies must not authorize an account link")
	}
}

// TestLinkSessionMatches_GarbageAccessTokenNoRefresh pins that an unparseable
// access cookie falls through to the refresh check rather than short-circuiting
// to success, and that with no refresh cookie the result is still a refusal.
func TestLinkSessionMatches_GarbageAccessTokenNoRefresh(t *testing.T) {
	h := newLinkTestHandler()
	r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback", nil)
	r.AddCookie(&http.Cookie{Name: auth.AccessCookieName, Value: "not.a.jwt"})
	if h.linkSessionMatches(context.Background(), r, 7) {
		t.Error("an unverifiable access token must not authorize an account link")
	}
}
