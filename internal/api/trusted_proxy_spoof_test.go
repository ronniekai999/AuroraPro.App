package api

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Guards the rate-limiter bypass that the left-most X-Forwarded-For pick
// allowed behind the nginx this repo ships.
//
// scripts/install.sh and scripts/setup-domain.sh both write:
//
//	proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
//
// which expands to "$http_x_forwarded_for, $remote_addr" — nginx APPENDS the
// real client to whatever X-Forwarded-For the client sent. Taking the
// left-most entry therefore took an attacker-supplied value.
//
// This was latent until AURORA_TRUSTED_PROXIES became settable: with no
// trusted proxies the middleware is a pass-through and the branch is dead.
// Turning that setting on to fix the per-IP limiter is exactly what would
// have activated the bypass, so the two must land together.

// nginxRequest models the shipped reverse proxy: it appends the true client
// address to any client-supplied XFF, and sets X-Real-IP from $remote_addr.
func nginxRequest(clientSuppliedXFF, realClientIP string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	r.RemoteAddr = "127.0.0.1:44444" // nginx, on loopback
	xff := realClientIP
	if clientSuppliedXFF != "" {
		xff = clientSuppliedXFF + ", " + realClientIP
	}
	r.Header.Set("X-Forwarded-For", xff)
	r.Header.Set("X-Real-IP", realClientIP)
	return r
}

func keyFor(t *testing.T, r *http.Request, trusted []string) string {
	t.Helper()
	var seen string
	h := TrustedProxyMiddleware(ParseTrustedProxyCIDRs(trusted))(
		http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			seen = req.RemoteAddr
		}))
	h.ServeHTTP(httptest.NewRecorder(), r)
	host, _, err := net.SplitHostPort(seen)
	if err != nil {
		return seen
	}
	return host
}

// The bypass itself: one attacker rotating a header must NOT obtain a fresh
// rate-limit bucket per request. Before the fix each forged value became the
// key, so the 10/min login limiter never tripped and credential stuffing was
// effectively unlimited.
func TestXFF_ForgedLeftmostCannotChangeTheRateLimitKey(t *testing.T) {
	trusted := []string{"127.0.0.1/32", "::1/128"}
	const attacker = "203.0.113.77"

	for _, forged := range []string{"10.0.0.1", "10.0.0.2", "192.168.5.9", "8.8.8.8"} {
		got := keyFor(t, nginxRequest(forged, attacker), trusted)
		if got != attacker {
			t.Fatalf("forged XFF %q produced key %q — an attacker can rotate this to get "+
				"unlimited rate-limit buckets; it must stay pinned to %s", forged, got, attacker)
		}
	}
}

// The feature still has to work: a genuine client's address must reach the
// limiter, otherwise everyone shares one bucket (the bug being fixed).
func TestXFF_HonestClientIsAttributedCorrectly(t *testing.T) {
	got := keyFor(t, nginxRequest("", "198.51.100.42"), []string{"127.0.0.1/32"})
	if got != "198.51.100.42" {
		t.Fatalf("honest client key = %q, want 198.51.100.42", got)
	}
}

func TestXFF_RightmostUsedWhenNoXRealIP(t *testing.T) {
	r := nginxRequest("10.0.0.1", "203.0.113.9")
	r.Header.Del("X-Real-IP") // a proxy that sets only XFF
	if got := keyFor(t, r, []string{"127.0.0.1/32"}); got != "203.0.113.9" {
		t.Fatalf("key = %q, want the right-most (proxy-appended) entry 203.0.113.9", got)
	}
}

func TestXFF_SingleEntryNoComma(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/media", nil)
	r.RemoteAddr = "127.0.0.1:5555"
	r.Header.Set("X-Forwarded-For", "203.0.113.5")
	if got := keyFor(t, r, []string{"127.0.0.1/32"}); got != "203.0.113.5" {
		t.Fatalf("key = %q, want 203.0.113.5", got)
	}
}

func TestXFF_IPv6ClientSurvives(t *testing.T) {
	r := nginxRequest("10.0.0.1", "2001:db8::dead:beef")
	if got := keyFor(t, r, []string{"127.0.0.1/32"}); got != "2001:db8::dead:beef" {
		t.Fatalf("key = %q, want the IPv6 client (bracketing must survive SplitHostPort)", got)
	}
}

func TestXFF_WhitespaceTolerated(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/media", nil)
	r.RemoteAddr = "127.0.0.1:5555"
	r.Header.Set("X-Forwarded-For", "10.0.0.1 ,  203.0.113.9  ")
	if got := keyFor(t, r, []string{"127.0.0.1/32"}); got != "203.0.113.9" {
		t.Fatalf("key = %q, want 203.0.113.9", got)
	}
}

// An untrusted peer must not be able to rewrite its own address at all — the
// property that makes the whole design safe.
func TestXFF_UntrustedPeerIgnoredEntirely(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	r.RemoteAddr = "203.0.113.77:40000" // direct, not via a trusted proxy
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	r.Header.Set("X-Real-IP", "1.2.3.4")
	if got := keyFor(t, r, []string{"127.0.0.1/32"}); got != "203.0.113.77" {
		t.Fatalf("key = %q — an untrusted peer must not rewrite its own IP", got)
	}
}

// Garbage in the trusted header must not produce a nonsense key; the
// middleware leaves RemoteAddr alone when it can't parse an address.
func TestXFF_UnparseableHeaderLeavesPeerAddress(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/media", nil)
	r.RemoteAddr = "127.0.0.1:5555"
	r.Header.Set("X-Forwarded-For", "not-an-ip")
	r.Header.Set("X-Real-IP", "also-not-an-ip")
	if got := keyFor(t, r, []string{"127.0.0.1/32"}); got != "127.0.0.1" {
		t.Fatalf("key = %q, want the untouched peer address 127.0.0.1", got)
	}
}
