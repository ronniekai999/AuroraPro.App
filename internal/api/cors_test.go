package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Issue #181 — casting to a Chromecast Default Media Receiver failed because
// the receiver fetches HLS fragments cross-origin (from a Google-hosted origin
// like https://www.gstatic.com) and the credentialed allowlist CORS — tightened
// in #154/#168 to drop the wildcard — emitted no Access-Control-Allow-Origin for
// that origin, so the browser sandbox blocked the segment XHRs. These tests pin
// the path-dispatched policy: token-authed HLS assets get a credential-less
// wildcard; everything else keeps the credentialed allowlist.

const testAllowedOrigin = "https://aurora.example.com"

func newCORSHandler(t *testing.T, terminal http.HandlerFunc) http.Handler {
	t.Helper()
	return corsMiddleware([]string{testAllowedOrigin})(terminal)
}

func TestCORS_HLSAssetsAreWildcardAndCredentialless(t *testing.T) {
	h := newCORSHandler(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

	// A Cast Default Media Receiver fetches segments from a Google-hosted origin.
	paths := []string{
		"/api/stream/hls/abc123/master.m3u8",
		"/api/stream/hls/abc123/source/stream.m3u8",
		"/api/stream/hls/abc123/source/seg_00001.ts",
		"/api/stream/hls/abc123/subs_0.m3u8",
	}
	for _, p := range paths {
		t.Run(p, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, p, nil)
			req.Header.Set("Origin", "https://www.gstatic.com")
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)

			if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("ACAO = %q, want %q (Cast receiver origin must be allowed)", got, "*")
			}
			// Credential-less is load-bearing for security: with `*` the browser
			// refuses to expose a credentialed response, so an ambient session
			// cookie can't be abused cross-origin to read another user's media.
			if got := rr.Header().Get("Access-Control-Allow-Credentials"); got != "" {
				t.Errorf("ACAC = %q, want empty (wildcard must stay credential-less)", got)
			}
		})
	}
}

func TestCORS_TraversalPathDoesNotInheritWildcard(t *testing.T) {
	// Deep-debug hardening (#181): the dispatch runs on the cleaned path, so a
	// crafted `/api/stream/hls/../...` that resolves OUTSIDE the HLS subtree must
	// fall back to the credentialed allowlist rather than picking up the
	// credential-less wildcard. (chi 404s such paths today; this pins the
	// boundary against a future CleanPath/RedirectSlashes.)
	h := newCORSHandler(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

	req := httptest.NewRequest(http.MethodGet, "/api/stream/hls/../../api/admin/backup", nil)
	req.Header.Set("Origin", "https://www.gstatic.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	// gstatic is NOT in the allowlist, so the credentialed branch emits no ACAO.
	// The only way this header could be "*" is if the wildcard branch leaked onto
	// a traversal path — which is exactly what we're guarding against.
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got == "*" {
		t.Errorf("traversal path got wildcard ACAO %q; must fall back to the credentialed allowlist", got)
	}
}

func TestCORS_HLSPreflightAllowsRangeRequests(t *testing.T) {
	h := newCORSHandler(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("preflight must be answered by CORS, not forwarded to the handler")
	})

	req := httptest.NewRequest(http.MethodOptions, "/api/stream/hls/abc123/source/seg_00001.ts", nil)
	req.Header.Set("Origin", "https://www.gstatic.com")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "range")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("preflight ACAO = %q, want %q", got, "*")
	}
	if got := rr.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("preflight ACAC = %q, want empty", got)
	}
	if got := rr.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "GET") {
		t.Errorf("preflight Allow-Methods = %q, want it to include GET", got)
	}
	// Range is not a CORS-safelisted header, so a byte-range segment fetch
	// preflights; the policy must echo it back or receivers that range-request
	// segments are blocked.
	if got := rr.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(strings.ToLower(got), "range") {
		t.Errorf("preflight Allow-Headers = %q, want it to include range", got)
	}
}

func TestCORS_APIKeepsCredentialedAllowlist(t *testing.T) {
	h := newCORSHandler(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })

	t.Run("allowed origin reflected with credentials", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/libraries", nil)
		req.Header.Set("Origin", testAllowedOrigin)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if got := rr.Header().Get("Access-Control-Allow-Origin"); got != testAllowedOrigin {
			t.Errorf("ACAO = %q, want reflected %q", got, testAllowedOrigin)
		}
		if got := rr.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Errorf("ACAC = %q, want %q", got, "true")
		}
	})

	t.Run("disallowed origin gets no ACAO", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/libraries", nil)
		req.Header.Set("Origin", "https://www.gstatic.com")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("ACAO = %q, want empty for a disallowed origin", got)
		}
	})

	// Guard against the wildcard leaking onto the cookie-authed cast-token
	// endpoint, which sits under /api/stream/ but NOT /api/stream/hls/.
	t.Run("cast-token endpoint is not wildcarded", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/stream/sessions/abc/cast-token", nil)
		req.Header.Set("Origin", "https://www.gstatic.com")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if got := rr.Header().Get("Access-Control-Allow-Origin"); got == "*" {
			t.Errorf("cast-token ACAO = %q, must NOT be the wildcard (it is cookie-authed)", got)
		}
	})
}
