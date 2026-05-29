package websocket

import (
	"net/http"
	"testing"
)

// deep-debug (CORS consistency) — the hub /ws upgrader must allow SAME-ORIGIN
// upgrades regardless of the configured allowlist, mirroring the V3 party
// checker, so a self-hosted LAN-IP install works without a wildcard origin.
func TestHubCheckOriginSameOrigin(t *testing.T) {
	denyAll := func(string) bool { return false }
	mk := func(host, origin string) *http.Request {
		r := &http.Request{Host: host, Header: http.Header{}}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return r
	}
	check := NewHub(denyAll).upgrader.CheckOrigin

	cases := []struct {
		name   string
		host   string
		origin string
		want   bool
	}{
		{"same-origin LAN IP allowed despite deny-all", "192.168.1.5:8484", "http://192.168.1.5:8484", true},
		{"same-origin domain", "media.example.com", "https://media.example.com", true},
		{"cross-origin rejected", "192.168.1.5:8484", "https://evil.example.com", false},
		{"no Origin (non-browser) allowed", "192.168.1.5:8484", "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := check(mk(c.host, c.origin)); got != c.want {
				t.Errorf("CheckOrigin host=%q origin=%q = %v, want %v", c.host, c.origin, got, c.want)
			}
		})
	}
}
