package api

import (
	"bytes"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// captureLogs swaps the default slog handler for the duration of fn.
func captureLogs(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	fn()
	return buf.String()
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
}

// An unconfigured proxy is a SILENT failure: everything keeps working, the
// rate limiter just quietly stops being per-IP and the audit trail quietly
// stops identifying clients. Production ran that way — client_ip=127.0.0.1 on
// every refresh-replay warning — with nothing in the logs saying so.
func TestTrustedProxy_WarnsWhenProxyDetectedButUnconfigured(t *testing.T) {
	h := TrustedProxyMiddleware(nil)(okHandler())

	out := captureLogs(t, func() {
		r := httptest.NewRequest(http.MethodGet, "/api/media", nil)
		r.RemoteAddr = "127.0.0.1:5555"
		r.Header.Set("X-Forwarded-For", "203.0.113.9")
		h.ServeHTTP(httptest.NewRecorder(), r)
	})

	if !strings.Contains(out, "trusted_proxies is empty") {
		t.Fatalf("expected a warning naming the misconfiguration, got:\n%s", out)
	}
	if !strings.Contains(out, "AURORA_TRUSTED_PROXIES") {
		t.Fatalf("the warning must name the setting that fixes it, got:\n%s", out)
	}
}

// The condition is permanent until config changes, and this is a per-request
// path on a server doing ~500k requests a fortnight. Warning every time would
// bury the very logs it is complaining about.
func TestTrustedProxy_WarnsOnlyOnce(t *testing.T) {
	h := TrustedProxyMiddleware(nil)(okHandler())

	out := captureLogs(t, func() {
		for i := 0; i < 50; i++ {
			r := httptest.NewRequest(http.MethodGet, "/api/media", nil)
			r.RemoteAddr = "127.0.0.1:5555"
			r.Header.Set("X-Forwarded-For", "203.0.113.9")
			h.ServeHTTP(httptest.NewRecorder(), r)
		}
	})

	if n := strings.Count(out, "trusted_proxies is empty"); n != 1 {
		t.Fatalf("expected exactly 1 warning across 50 requests, got %d", n)
	}
}

// No proxy in front (direct LAN install) is a legitimate, correct setup. It
// must not be nagged about something that isn't wrong.
func TestTrustedProxy_SilentWhenNoProxyHeaders(t *testing.T) {
	h := TrustedProxyMiddleware(nil)(okHandler())

	out := captureLogs(t, func() {
		r := httptest.NewRequest(http.MethodGet, "/api/media", nil)
		r.RemoteAddr = "192.168.1.50:5555"
		h.ServeHTTP(httptest.NewRecorder(), r)
	})

	if strings.Contains(out, "trusted_proxies") {
		t.Fatalf("a direct install must not be warned, got:\n%s", out)
	}
}

// Properly configured: no warning, and RemoteAddr is rewritten to the real
// client so the rate limiter and audit log see it.
func TestTrustedProxy_ConfiguredRewritesAndStaysSilent(t *testing.T) {
	cidrs := ParseTrustedProxyCIDRs([]string{"127.0.0.1/32", "::1/128"})
	var seen string
	h := TrustedProxyMiddleware(cidrs)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.RemoteAddr
	}))

	out := captureLogs(t, func() {
		r := httptest.NewRequest(http.MethodGet, "/api/media", nil)
		r.RemoteAddr = "127.0.0.1:5555"
		r.Header.Set("X-Forwarded-For", "203.0.113.9")
		h.ServeHTTP(httptest.NewRecorder(), r)
	})

	host, _, err := net.SplitHostPort(seen)
	if err != nil || host != "203.0.113.9" {
		t.Fatalf("RemoteAddr = %q, want the forwarded client 203.0.113.9", seen)
	}
	if strings.Contains(out, "trusted_proxies is empty") {
		t.Fatalf("a correctly configured install must not warn, got:\n%s", out)
	}
}

// The security property that makes the whole design safe: an untrusted peer
// cannot forge its source IP, even with a perfect-looking header.
func TestTrustedProxy_UntrustedPeerCannotSpoof(t *testing.T) {
	cidrs := ParseTrustedProxyCIDRs([]string{"127.0.0.1/32"})
	var seen string
	h := TrustedProxyMiddleware(cidrs)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.RemoteAddr
	}))

	r := httptest.NewRequest(http.MethodGet, "/api/auth/login", nil)
	r.RemoteAddr = "203.0.113.77:40000" // NOT a trusted proxy
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	h.ServeHTTP(httptest.NewRecorder(), r)

	if !strings.HasPrefix(seen, "203.0.113.77:") {
		t.Fatalf("RemoteAddr = %q — an untrusted peer must not be able to rewrite its own IP", seen)
	}
}
