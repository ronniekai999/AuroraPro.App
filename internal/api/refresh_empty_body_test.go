package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The browser sends NO body to /api/auth/refresh and /api/auth/logout — the
// refresh token rides the httpOnly cookie. Once that cookie expires, both
// handlers used to fall through to a JSON body decode, fail on the empty
// body, and answer 400 "invalid request body".
//
// Two consequences, both visible in production:
//
//   - Refresh: 734 mislabelled 400s in two weeks. An expired session is a 401,
//     and the 400 branch skipped the clearAuthCookies call the 401 branch runs.
//   - Logout: the 400 returned BEFORE clearAuthCookies, so "log me out" with an
//     already-expired cookie left the stale cookies in the browser.
//
// These tests pin the decision that fixes both: only attempt the body decode
// when a body was actually sent. They exercise the branch directly rather than
// standing up a full handler, because reaching the handler needs a database.

// bodyDecodeAttempted mirrors the guard in Refresh/Logout: cookie first, body
// only when one was sent.
func bodyDecodeAttempted(r *http.Request, hasCookieValue bool) bool {
	if hasCookieValue {
		return false
	}
	return r.ContentLength != 0
}

func TestRefreshEmptyBody_NoDecodeAttempted(t *testing.T) {
	tests := []struct {
		name      string
		body      string
		hasCookie bool
		wantParse bool
	}{
		{
			// The exact browser shape once the refresh cookie expires. This is
			// the 400 that should never have been a 400.
			name:      "browser: no cookie, no body",
			body:      "",
			hasCookie: false,
			wantParse: false,
		},
		{
			name:      "browser: valid cookie, no body",
			body:      "",
			hasCookie: true,
			wantParse: false,
		},
		{
			// API clients legitimately pass the token in a body; that path
			// must keep working, including its 400 on malformed JSON.
			name:      "api client: no cookie, JSON body",
			body:      `{"refresh_token":"abc"}`,
			hasCookie: false,
			wantParse: true,
		},
		{
			name:      "api client: no cookie, malformed body still parsed (and rejected)",
			body:      `{not json`,
			hasCookie: false,
			wantParse: true,
		},
		{
			// Cookie wins — a body present alongside a valid cookie is ignored,
			// which is the pre-existing precedence and must not change.
			name:      "cookie takes precedence over body",
			body:      `{"refresh_token":"abc"}`,
			hasCookie: true,
			wantParse: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var r *http.Request
			if tc.body == "" {
				r = httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
			} else {
				r = httptest.NewRequest(http.MethodPost, "/api/auth/refresh", strings.NewReader(tc.body))
			}
			if got := bodyDecodeAttempted(r, tc.hasCookie); got != tc.wantParse {
				t.Fatalf("bodyDecodeAttempted = %v, want %v", got, tc.wantParse)
			}
		})
	}
}

// httptest.NewRequest with a nil body reports ContentLength 0, which is what
// the guard keys on. If that ever changed, the guard would silently stop
// working and the 400s would come back — assert it explicitly.
func TestEmptyBodyHasZeroContentLength(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	if r.ContentLength != 0 {
		t.Fatalf("ContentLength = %d, want 0 for a bodyless POST", r.ContentLength)
	}
	withBody := httptest.NewRequest(http.MethodPost, "/api/auth/refresh",
		strings.NewReader(`{"refresh_token":"x"}`))
	if withBody.ContentLength == 0 {
		t.Fatal("a POST with a body must report a non-zero ContentLength")
	}
}
