package api

import (
	"encoding/json"
	"errors"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/httputil"
	"github.com/aurora-media/aurora/internal/models"
)

func getClaimsFromRequest(r *http.Request) *auth.JWTClaims {
	return auth.GetClaims(r.Context())
}

// queryParamTokenKey is the context key for the raw JWT token extracted from
// the ?token= query parameter. Used by HLS playlist handlers to embed the
// token in generated URLs so Safari's native HLS player can authenticate
// subsequent variant/segment requests.
type queryParamTokenKey struct{}

// QueryParamToken returns the JWT token extracted from ?token= by the
// middleware, or "" if the request did not include one.
// The value is validated to contain only JWT-safe characters (base64url + dots)
// to prevent HLS playlist injection via newlines or other control characters.
func QueryParamToken(r *http.Request) string {
	tok, _ := r.Context().Value(queryParamTokenKey{}).(string)
	if tok == "" {
		return ""
	}
	// JWTs are three base64url-encoded segments separated by dots.
	// Reject anything containing characters outside this set to prevent
	// response splitting in HLS playlists where the token is embedded.
	for _, c := range tok {
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
			return ""
		}
	}
	return tok
}

// requireQueryTokenClaims validates the browser-compatible ?token= auth path
// used by WebSocket/HLS-style endpoints. It intentionally mirrors
// auth.RequireAuth: JWT signature/expiry validation plus token-version
// revocation checks.
func requireQueryTokenClaims(w http.ResponseWriter, r *http.Request, svc *auth.Service, versionStore *auth.TokenVersionStore) (*auth.JWTClaims, bool) {
	token := QueryParamToken(r)
	if token == "" {
		// deep-debug H10 — the browser SPA no longer puts the JWT in the URL;
		// same-origin WS/HLS requests carry the httpOnly access cookie instead.
		// (Cast/AirPlay receivers, which aren't same-origin, still use ?token=.)
		if c, cerr := r.Cookie(auth.AccessCookieName); cerr == nil && c.Value != "" {
			token = c.Value
		}
	}
	if token == "" {
		writeError(w, http.StatusUnauthorized, "token required")
		return nil, false
	}
	claims, err := svc.ValidateAccessToken(token)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid or expired token")
		return nil, false
	}
	if versionStore != nil && !versionStore.Check(r.Context(), claims.UserID, claims.TokenVersion) {
		writeError(w, http.StatusUnauthorized, "invalid or expired token")
		return nil, false
	}
	// QA fix — surface user_id to the outer RequestLogger. All callers
	// of this helper (WS endpoints, /ws/party-room, etc.) bypass the
	// standard auth.RequireAuth middleware and would otherwise log as
	// user_id=0.
	auth.SetRequestUserID(r.Context(), claims.UserID)
	return claims, true
}

func clientIP(r *http.Request) string {
	// chi's middleware.RealIP (applied globally in the router) sets
	// r.RemoteAddr to the trusted client IP from X-Real-Ip / X-Forwarded-For.
	// When a proxy header is present, RealIP sets RemoteAddr to a bare IP
	// (no port). When NO proxy header is present (direct connection),
	// RemoteAddr retains Go's standard "ip:port" format (e.g. "192.168.1.1:54321"
	// or "[::1]:54321"). PostgreSQL's inet type rejects strings with ports,
	// so we must always strip the port component.
	addr := r.RemoteAddr
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	// Already a bare IP (set by chi RealIP from a proxy header), or
	// an unparseable value — return as-is.
	return addr
}

// writeJSON delegates to the shared httputil package.
// Kept as a package-local alias so call sites stay clean.
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	httputil.WriteJSON(w, status, data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	httputil.WriteError(w, status, message)
}

// requireClaims returns the JWT claims from context, writing a 401 and
// returning (nil, false) if absent. Used as a defensive guard in handlers
// that dereference claims.UserID — today every such handler sits behind
// RequireAuth so claims is always non-nil, but a future router refactor
// that exposes a handler unauthenticated would nil-panic without this.
//
// Pattern at call sites:
//
//	claims, ok := requireClaims(w, r)
//	if !ok { return }
//	// safe to use claims.UserID below
func requireClaims(w http.ResponseWriter, r *http.Request) (*auth.JWTClaims, bool) {
	c := auth.GetClaims(r.Context())
	if c == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return nil, false
	}
	return c, true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v interface{}) error {
	// Limit request body to 1MB to prevent memory exhaustion attacks.
	//
	// IMPORTANT: we pass nil for the ResponseWriter so MaxBytesReader does
	// NOT auto-write a 413. Auto-writing produced the "superfluous
	// response.WriteHeader" bug — every caller then ran writeError(...,400,...)
	// on the resulting Decode error, double-writing the response. Now an
	// over-limit body fails at Decode and the caller's single writeError
	// returns 400 ("invalid request body"). Losing the 413 differentiation
	// is acceptable; the DoS protection (the cap itself) is what mattered.
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}

// isValidEmail performs basic email format validation.
// Checks for: non-empty local part, exactly one @, non-empty domain with a dot.
func isValidEmail(email string) bool {
	if len(email) > 254 {
		return false
	}
	at := strings.LastIndex(email, "@")
	if at <= 0 || at >= len(email)-1 {
		return false
	}
	local := email[:at]
	domain := email[at+1:]
	if len(local) > 64 || len(domain) < 3 {
		return false
	}
	if !strings.Contains(domain, ".") {
		return false
	}
	// No whitespace allowed — ASCII OR Unicode. The ASCII check below was
	// the original guard; `unicode.IsSpace` also catches U+00A0 (NBSP),
	// U+2028 (LSEP), U+2029 (PSEP) and the rest of the Unicode whitespace
	// table, any of which would otherwise sneak past and produce a row
	// whose email looks valid but isn't deliverable / collides with a
	// near-twin.
	for _, r := range email {
		if unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

// normalizeEmail canonicalizes an email for storage and lookup: trimmed and
// lowercased. Paired with the case-insensitive unique index on LOWER(email)
// (migration 028) and the case-insensitive GetUserByEmail so "Bob@Corp.com"
// and "bob@corp.com" resolve to one account — without it, OAuth Tier-2
// auto-link silently failed and the email-collision anti-hijack safety net
// could be bypassed with a case variant. deep-debug H1.
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func paginate(r *http.Request) models.PaginationParams {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
	if page < 1 {
		page = 1
	}
	// Cap page count so ?page=999999999 doesn't produce a huge SQL OFFSET
	// that hammers the DB. At max perPage (100) this is still 1M rows of
	// reach — more than enough for any realistic admin list.
	if page > 10000 {
		page = 10000
	}
	if perPage < 1 || perPage > 100 {
		perPage = 20
	}
	return models.PaginationParams{Page: page, PerPage: perPage}
}

func paginatedResponse(data interface{}, total int64, params models.PaginationParams) models.PaginatedResponse {
	totalPages := int(math.Ceil(float64(total) / float64(params.PerPage)))
	return models.PaginatedResponse{
		Data:       data,
		Page:       params.Page,
		PerPage:    params.PerPage,
		TotalItems: total,
		TotalPages: totalPages,
	}
}

// validateLLMURL rejects URL strings that point at SSRF-risky targets.
// Used by the LLM-settings update endpoint to prevent an admin (or a
// leaked admin token) from pointing Aurora's LLM client at cloud
// metadata services or other internal-only endpoints to exfiltrate
// credentials.
//
// Policy:
//   - Scheme must be http or https.
//   - Host can be a hostname OR an IP literal.
//   - If the host is a literal IPv4 or IPv6 address, reject link-local
//     ranges (169.254.0.0/16 and fe80::/10), which include AWS / GCP /
//     Azure metadata services.
//   - Loopback (127.0.0.0/8, ::1) is ALLOWED — the default Ollama
//     install runs at http://localhost:11434.
//   - Private RFC1918 ranges are ALLOWED — Aurora may run in a docker
//     network with Ollama on a sibling container at 172.17.x.x.
//
// 2026-05-19 audit (BE-H6) — the prior code accepted any string and
// shoved it straight into http.Get, leaving Aurora's process as an
// SSRF launchpad against the host's network from an admin role.
func validateLLMURL(s string) error {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil {
		return errors.New("not a valid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("scheme must be http or https")
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("missing host")
	}
	// If host parses as an IP literal, apply the link-local block.
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return errors.New("link-local addresses are not allowed (cloud metadata SSRF risk)")
		}
		// Catch the specific AWS/GCP metadata service even when DNS
		// resolution would otherwise mask it. 169.254.169.254 is
		// already covered by IsLinkLocalUnicast, but be explicit.
		if ip.Equal(net.IPv4(169, 254, 169, 254)) {
			return errors.New("cloud metadata service is not allowed")
		}
	}
	return nil
}

// websocketOriginChecker builds the CheckOrigin function used by every
// WebSocket upgrader in this package. Mirrors the policy implemented by
// internal/websocket/hub.go: non-browser clients (no Origin header) are
// allowed; browser clients must match the configured allowlist; a nil
// checker denies cross-origin entirely.
//
// 2026-05-19 audit (API-H1) — V3 dual-socket handlers (sync + room)
// previously used `return true`, exposing cross-site WebSocket
// hijacking for any logged-in user. Centralizing the check here keeps
// the policy consistent and impossible to forget when adding new
// upgraders.
func websocketOriginChecker(originAllowed func(string) bool) func(*http.Request) bool {
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			// Non-browser clients (curl, Go test, native apps) don't
			// send Origin. Auth is still required via JWT in the
			// query param, so this isn't an open door.
			return true
		}
		// Same-origin upgrades are always allowed: the SPA is served from the
		// same host it connects back to, so the browser-set Origin host matches
		// the request Host. CSWSH is a CROSS-origin attack, so allowing
		// same-origin is safe — and it lets a self-hosted install work when
		// reached by LAN IP or hostname without a wildcard origin allowlist
		// (which is why we no longer default AURORA_ALLOWED_ORIGINS to '*').
		// The browser sets Origin from the real page origin and JS cannot forge
		// it, so an attacker page on another origin can't match r.Host.
		// (deep-debug — CORS hardening)
		if u, err := url.Parse(origin); err == nil && u.Host != "" && strings.EqualFold(u.Host, r.Host) {
			return true
		}
		if originAllowed == nil {
			return false
		}
		return originAllowed(origin)
	}
}
