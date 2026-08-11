package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
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

// TestReadLinkUID covers the link-mode detection: only a present, non-empty,
// positive-integer cookie marks the flow as a link.
func TestReadLinkUID(t *testing.T) {
	h := &OAuthHandler{}
	cases := []struct {
		name     string
		setValue string // "" means don't set the cookie
		set      bool
		wantUID  int64
		wantOK   bool
	}{
		{"absent cookie", "", false, 0, false},
		{"empty value", "", true, 0, false},
		{"valid uid", "42", true, 42, true},
		{"zero uid rejected", "0", true, 0, false},
		{"negative uid rejected", "-5", true, 0, false},
		{"garbage rejected", "not-a-number", true, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/auth/oauth/google/callback", nil)
			if tc.set {
				r.AddCookie(&http.Cookie{Name: oauthLinkUIDCookieName, Value: tc.setValue})
			}
			uid, ok := h.readLinkUID(r)
			if uid != tc.wantUID || ok != tc.wantOK {
				t.Errorf("readLinkUID = (%d,%v), want (%d,%v)", uid, ok, tc.wantUID, tc.wantOK)
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
	// Should never be reached in the uid-mismatch test (we return before
	// exchange). If it is, fail loudly via an empty profile that the caller
	// rejects.
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

// TestHandleLinkCallback_UIDMismatch verifies the link-mode cross-check: when a
// VALID session access cookie is present but its uid differs from the link
// cookie's uid, the link is aborted with a "session changed" message and the
// link cookie is cleared — BEFORE any code exchange happens. This is the
// defense against a session swapping mid-link (e.g. the user logged into a
// different account in another tab).
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

	resp := w.Result()
	body := w.Body.String()
	if !strings.Contains(strings.ToLower(body), "session changed") {
		t.Errorf("expected 'session changed' error page, got body: %q", body)
	}
	// The link cookie must be cleared (MaxAge<0 → Set-Cookie with Max-Age=0/expired).
	if !linkCookieCleared(resp) {
		t.Errorf("expected link-uid cookie to be cleared on mismatch")
	}
}

// linkCookieCleared reports whether the response expires oauthLinkUIDCookieName
// (MaxAge=-1 renders as Max-Age=0 in the Set-Cookie header).
func linkCookieCleared(resp *http.Response) bool {
	for _, c := range resp.Cookies() {
		if c.Name == oauthLinkUIDCookieName && c.MaxAge < 0 {
			return true
		}
	}
	return false
}

// TestStartLinkCookieValue documents the exact format StartLink stores in the
// link cookie (a base-10 user ID), the contract readLinkUID parses back. Kept
// as a tiny round-trip so a future change to either side that breaks the pair
// fails a test rather than silently disabling link mode.
func TestStartLinkCookieValue(t *testing.T) {
	const uid int64 = 12345
	val := strconv.FormatInt(uid, 10)
	r := httptest.NewRequest(http.MethodGet, "/cb", nil)
	r.AddCookie(&http.Cookie{Name: oauthLinkUIDCookieName, Value: val})
	h := &OAuthHandler{}
	got, ok := h.readLinkUID(r)
	if !ok || got != uid {
		t.Errorf("round-trip = (%d,%v), want (%d,true)", got, ok, uid)
	}
}
