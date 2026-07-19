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
