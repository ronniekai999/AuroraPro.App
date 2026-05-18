package api

import (
	"encoding/json"
	"math"
	"net"
	"net/http"
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
//   claims, ok := requireClaims(w, r)
//   if !ok { return }
//   // safe to use claims.UserID below
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
