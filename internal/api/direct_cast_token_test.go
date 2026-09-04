package api

// 2026-07 review — direct-play AirPlay hand-off. Direct-play titles have no
// transcode session, so cast tokens for them bind to a (fileType, fileID)
// via the "direct:<type>:<id>" SessionID sentinel. These tests pin the
// security surface of ServeDirectCastFile: a cast token grants access to
// exactly the file it was minted for, with a uniform 403 on any mismatch,
// and a session-scoped cast token can never reach the direct route (nor the
// sentinel a real HLS session).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/go-chi/chi/v5"
)

func directCastRequest(t *testing.T, fileID, fileType string, claims *auth.JWTClaims) *http.Request {
	t.Helper()
	url := "/api/stream/direct/" + fileID
	if fileType != "" {
		url += "?type=" + fileType
	}
	req := httptest.NewRequest(http.MethodGet, url, nil)
	ctx := context.WithValue(req.Context(), auth.ClaimsContextKey, claims)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("fileID", fileID)
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rctx)
	return req.WithContext(ctx)
}

func TestServeDirectCastFile_CastTokenBinding(t *testing.T) {
	h := &StreamHandler{} // binding checks fire before any queries/transcode use

	bound := &auth.JWTClaims{
		UserID: 7, Username: "u", Role: "user",
		Scope:     auth.ScopeCast,
		SessionID: directCastSessionID("media", 42),
	}

	tests := []struct {
		name     string
		fileID   string
		fileType string
		claims   *auth.JWTClaims
		want     int
	}{
		{"wrong file id", "43", "media", bound, http.StatusForbidden},
		{"wrong file type", "42", "episode", bound, http.StatusForbidden},
		{"missing type", "42", "", bound, http.StatusForbidden},
		{"invalid type value", "42", "bogus", bound, http.StatusForbidden},
		{
			// A cast token bound to a REAL HLS session (hex ID) must not
			// unlock the direct route: the sentinel prefix can't collide.
			"session-scoped cast token", "42", "media",
			&auth.JWTClaims{
				UserID: 7, Scope: auth.ScopeCast,
				SessionID: "0123456789abcdef0123456789abcdef",
			},
			http.StatusForbidden,
		},
		{"no claims at all", "42", "media", nil, http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			h.ServeDirectCastFile(rr, directCastRequest(t, tt.fileID, tt.fileType, tt.claims))
			if rr.Code != tt.want {
				t.Errorf("status = %d, want %d (body %q)", rr.Code, tt.want, rr.Body.String())
			}
		})
	}
}

func TestDirectCastSessionIDShape(t *testing.T) {
	got := directCastSessionID("media", 42)
	if got != "direct:media:42" {
		t.Errorf("directCastSessionID = %q, want %q", got, "direct:media:42")
	}
	// The sentinel must never look like a transcode session ID (32 hex
	// chars) — requireSessionAccess matches cast tokens by exact string
	// equality against real session IDs, so the prefix is the isolation.
	if len(got) == 32 {
		t.Error("sentinel must not be confusable with a hex session ID")
	}
}

// Issue #503 made HEAD a routinely-used method on this route: the sender
// self-tests a direct cast URL before handing it to the receiver, and uses
// HEAD so the probe writes no activity row and registers no phantom "now
// streaming" entry. A method that skips those side effects must not also skip
// the token binding — otherwise the probe path is a weaker door to the same
// bytes than the GET beside it.
func TestServeDirectCastFile_HeadEnforcesTheSameBinding(t *testing.T) {
	h := &StreamHandler{} // binding checks fire before any queries/transcode use

	bound := &auth.JWTClaims{
		UserID: 7, Username: "u", Role: "user",
		Scope:     auth.ScopeCast,
		SessionID: directCastSessionID("media", 42),
	}

	for _, tt := range []struct {
		name     string
		fileID   string
		fileType string
		claims   *auth.JWTClaims
		want     int
	}{
		{"wrong file id", "43", "media", bound, http.StatusForbidden},
		{"wrong file type", "42", "episode", bound, http.StatusForbidden},
		{"missing type", "42", "", bound, http.StatusForbidden},
		{"no claims at all", "42", "media", nil, http.StatusUnauthorized},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := directCastRequest(t, tt.fileID, tt.fileType, tt.claims)
			req.Method = http.MethodHead
			rr := httptest.NewRecorder()
			h.ServeDirectCastFile(rr, req)
			if rr.Code != tt.want {
				t.Errorf("HEAD status = %d, want %d (body %q)", rr.Code, tt.want, rr.Body.String())
			}
		})
	}
}

// The test above proves HEAD enforces the binding; it cannot prove HEAD is
// ROUTED, because ServeDirectCastFile has no method branch and a handler-level
// test never consults the router. That gap matters: the sender's cast self-test
// uses HEAD specifically (issue #503), so if the registration were dropped the
// probe would 405 on every direct cast. The probe is diagnostics only, so that
// is noise rather than breakage today — but it would also silently remove the
// one signal a sender has that the URL it is about to hand a receiver is
// reachable, and every test here would stay green.
//
// Asserted against router.go's text rather than by building a router, because
// the real registration needs the full RouterDeps graph and it is the presence
// of the line that carries the risk.
func TestDirectCastRouteRegistersBothGetAndHead(t *testing.T) {
	src, err := os.ReadFile("router.go")
	if err != nil {
		t.Fatalf("read router.go: %v", err)
	}
	body := string(src)
	for _, want := range []string{
		`r.Get("/api/stream/direct/{fileID}", streamH.ServeDirectCastFile)`,
		`r.Head("/api/stream/direct/{fileID}", streamH.ServeDirectCastFile)`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("router.go no longer registers:\n  %s\n"+
				"Both methods are load-bearing: GET serves the receiver, HEAD is the "+
				"sender's side-effect-free self-test.", want)
		}
	}
}
