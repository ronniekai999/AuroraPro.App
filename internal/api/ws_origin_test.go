package api

import (
	"net/http"
	"testing"
)

// deep-debug (CORS hardening) — the WS origin checker must allow SAME-ORIGIN
// upgrades regardless of the configured allowlist, so a self-hosted install
// reached by LAN IP / hostname works without a wildcard origin (which we no
// longer default to). Cross-origin upgrades still require the allowlist.
func TestWebsocketOriginChecker(t *testing.T) {
	denyAll := func(string) bool { return false }
	allowList := func(o string) bool { return o == "https://trusted.example.com" }

	mk := func(host, origin string) *http.Request {
		r := &http.Request{Host: host, Header: http.Header{}}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		return r
	}

	cases := []struct {
		name    string
		host    string
		origin  string
		allowed func(string) bool
		want    bool
	}{
		{"same-origin LAN IP allowed despite deny-all list", "192.168.1.5:8484", "http://192.168.1.5:8484", denyAll, true},
		{"same-origin localhost", "localhost:8484", "http://localhost:8484", denyAll, true},
		{"same-origin domain behind TLS proxy", "media.example.com", "https://media.example.com", denyAll, true},
		{"cross-origin not in allowlist rejected", "192.168.1.5:8484", "https://evil.example.com", denyAll, false},
		{"cross-origin present in allowlist accepted", "192.168.1.5:8484", "https://trusted.example.com", allowList, true},
		{"no Origin header (non-browser) accepted", "192.168.1.5:8484", "", denyAll, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := websocketOriginChecker(c.allowed)(mk(c.host, c.origin)); got != c.want {
				t.Errorf("websocketOriginChecker host=%q origin=%q = %v, want %v", c.host, c.origin, got, c.want)
			}
		})
	}
}
