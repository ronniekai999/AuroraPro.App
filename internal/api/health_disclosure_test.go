package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
)

// healthTestService builds an auth.Service with a known secret so the test
// can mint a real access token the handler will accept.
func healthTestService() *auth.Service {
	return auth.NewService(config.AuthConfig{
		JWTSecret:         "test-secret-key-that-is-at-least-32-chars-long-for-testing",
		AccessTokenExpiry: 15 * time.Minute,
		Argon2Memory:      64 * 1024,
		Argon2Iterations:  1,
		Argon2Parallelism: 1,
		Argon2SaltLength:  16,
		Argon2KeyLength:   32,
		InviteCodeLength:  16,
	})
}

// newHealthTestRouter builds just enough of the router to exercise the public
// /api/health route. Pool is nil (db_connected reports true via the nil
// guard); StaticDir is empty so the SPA block is skipped. versionStore is nil
// so token-version checks are bypassed.
func newHealthTestRouter(svc *auth.Service) http.Handler {
	return NewRouter(RouterDeps{
		Cfg:       &config.Config{},
		AuthSvc:   svc,
		Version:   "9.9.9-test",
		StartTime: time.Now().Add(-time.Minute),
	})
}

// The public /api/health response must NOT leak the build version or host
// metrics to anonymous callers (CVE-fingerprinting surface). It returns a
// minimal liveness shape only.
func TestHealth_Anonymous_MinimalLiveness(t *testing.T) {
	r := newHealthTestRouter(healthTestService())

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, rec.Body.String())
	}

	// Liveness fields present.
	if _, ok := body["status"]; !ok {
		t.Error("anonymous response missing status")
	}
	if _, ok := body["db_connected"]; !ok {
		t.Error("anonymous response missing db_connected")
	}
	// Sensitive fields must be absent.
	for _, leaked := range []string{"version", "uptime", "disk_free_gb", "ffmpeg_available", "service"} {
		if _, ok := body[leaked]; ok {
			t.Errorf("anonymous health response leaked %q: %s", leaked, rec.Body.String())
		}
	}
}

// A bad / forged token is treated as anonymous — no version leak, no 401
// (the route is public by design).
func TestHealth_BadToken_TreatedAsAnonymous(t *testing.T) {
	r := newHealthTestRouter(healthTestService())

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Authorization", "Bearer not.a.real.token")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (public route)", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, ok := body["version"]; ok {
		t.Errorf("forged token must not unlock version: %s", rec.Body.String())
	}
}

// healthCallerAuthed is the gate that flips /api/health from the anonymous
// liveness shape to the full diagnostic payload. It's unit-tested directly
// (rather than through the full router) so the test stays hermetic — the
// authed branch in the handler is otherwise identical to the well-covered
// admin dashboard payload. versionStore is nil here, exactly as a token-
// version-less deployment / the bypass path uses it.
//
// A valid access token via the Authorization: Bearer header authenticates.
func TestHealthCallerAuthed_BearerHeader(t *testing.T) {
	svc := healthTestService()
	tok, _, err := svc.GenerateAccessToken(1, "alice", "user", 0, 0)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	if !healthCallerAuthed(req, svc, nil) {
		t.Error("valid Bearer token should authenticate the health caller")
	}
}

// The SPA authenticates via the httpOnly access cookie (not a header); the
// cookie path must also count as authenticated.
func TestHealthCallerAuthed_AccessCookie(t *testing.T) {
	svc := healthTestService()
	tok, _, err := svc.GenerateAccessToken(1, "alice", "user", 0, 0)
	if err != nil {
		t.Fatalf("GenerateAccessToken: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.AddCookie(&http.Cookie{Name: auth.AccessCookieName, Value: tok})
	if !healthCallerAuthed(req, svc, nil) {
		t.Error("valid access cookie should authenticate the health caller")
	}
}

// Negative cases: no credential, a malformed/forged token, a non-bearer
// scheme, and a nil service all read as anonymous (and never panic).
func TestHealthCallerAuthed_Negatives(t *testing.T) {
	svc := healthTestService()

	t.Run("no credential", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		if healthCallerAuthed(req, svc, nil) {
			t.Error("no token should read as anonymous")
		}
	})
	t.Run("forged token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set("Authorization", "Bearer not.a.real.token")
		if healthCallerAuthed(req, svc, nil) {
			t.Error("forged token should read as anonymous")
		}
	})
	t.Run("non-bearer scheme", func(t *testing.T) {
		svc := healthTestService()
		tok, _, _ := svc.GenerateAccessToken(1, "alice", "user", 0, 0)
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set("Authorization", "Basic "+tok) // valid token, wrong scheme
		if healthCallerAuthed(req, svc, nil) {
			t.Error("non-bearer scheme must not authenticate")
		}
	})
	t.Run("nil service", func(t *testing.T) {
		tok, _, _ := svc.GenerateAccessToken(1, "alice", "user", 0, 0)
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		if healthCallerAuthed(req, nil, nil) {
			t.Error("nil auth service must read as anonymous, not panic")
		}
	})
}
