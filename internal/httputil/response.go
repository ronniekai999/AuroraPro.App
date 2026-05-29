package httputil

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

// WriteJSON writes a JSON response with the given status code.
func WriteJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		slog.Error("write json response", "error", err)
	}
}

// WriteError writes a standardized JSON error response.
func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]interface{}{
		"error": map[string]interface{}{
			"code":    status,
			"message": message,
		},
	})
}

// SameOrigin reports whether the browser Origin header targets the same host as
// the request's Host — i.e. the request is same-origin. WebSocket upgraders use
// it to ALWAYS allow same-origin upgrades (the SPA connecting back to its own
// server) regardless of the configured cross-origin allowlist, so a self-hosted
// install reached by LAN IP/hostname works without a wildcard origin. It is the
// single source of truth for that policy, shared by the api and websocket
// upgraders so neither can drift.
//
// Safe because the browser sets Origin from the real page origin (JS can't
// forge it for a WebSocket), so an attacker page on another origin cannot make
// the Origin host equal the request Host. A DNS-rebinding attacker could force
// Origin==Host for an attacker-chosen name, but the auth cookie is host-bound
// (set with NO Domain attribute) so it is not delivered to the rebound host and
// the upgrade still fails auth — do not add a cookie Domain attribute without
// revisiting this. Host-only comparison matches the gorilla/websocket
// same-origin convention. (deep-debug — CORS hardening)
func SameOrigin(originHeader, requestHost string) bool {
	if originHeader == "" || requestHost == "" {
		return false
	}
	u, err := url.Parse(originHeader)
	if err != nil || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Host, requestHost)
}
