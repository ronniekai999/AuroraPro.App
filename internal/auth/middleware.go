package auth

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/aurora-media/aurora/internal/httputil"
)

// UserIDHolder is a mutable, request-scoped slot for the
// authenticated user's ID, written by auth middleware once claims are
// validated. The outer RequestLogger in package `api` installs an
// empty holder into the request context BEFORE downstream middleware
// runs; auth middleware later updates it via SetRequestUserID. The
// logger reads it AFTER next.ServeHTTP returns.
//
// Why we need this rather than reading claims directly from the
// outer ctx: Go's http.Request context is immutable per-request —
// `r.WithContext(ctx)` creates a NEW request that downstream sees,
// but the outer logger keeps a reference to the original `r`. So
// claims written by RequireAuth via WithContext are visible only
// inside its subtree, not back at the outer logger. The
// pointer-in-context pattern lets the inner write be visible to the
// outer read.
//
// Defined in the auth package (not api) so all auth middlewares can
// write to it without forcing api -> auth -> api circular imports.
type UserIDHolder struct {
	id atomic.Int64
}

type userIDHolderKey struct{}

// NewRequestContextWithUserIDHolder returns a context derived from
// parent with a fresh UserIDHolder installed. The outer logger
// middleware calls this; the returned holder is the one auth
// middlewares will write into.
func NewRequestContextWithUserIDHolder(parent context.Context) (context.Context, *UserIDHolder) {
	h := &UserIDHolder{}
	return context.WithValue(parent, userIDHolderKey{}, h), h
}

// SetRequestUserID writes userID into the request-scoped holder if
// one is installed. No-op when called from a code path that bypassed
// the logger middleware (e.g., tests).
func SetRequestUserID(ctx context.Context, userID int64) {
	if h, _ := ctx.Value(userIDHolderKey{}).(*UserIDHolder); h != nil {
		h.id.Store(userID)
	}
}

// Load returns the current user ID. Zero means "not yet set / public".
func (h *UserIDHolder) Load() int64 {
	if h == nil {
		return 0
	}
	return h.id.Load()
}

type contextKey string

const (
	ClaimsContextKey contextKey = "claims"
)

// RequireAuth middleware validates JWT from Authorization header.
//
// versionStore is optional — pass nil to skip the token_version check (tests
// and pre-migration deployments). When non-nil, every authenticated request
// also verifies the JWT's TokenVersion claim against the current persisted
// version, so a password change immediately invalidates outstanding tokens.
// The store has a small in-memory cache so this doesn't become a DB hit per
// request.
func RequireAuth(svc *Service, versionStore *TokenVersionStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tokenStr, ok := tokenFromRequest(r)
			if !ok {
				httputil.WriteError(w, http.StatusUnauthorized, "missing authorization")
				return
			}

			claims, err := svc.ValidateAccessToken(tokenStr)
			if err != nil {
				httputil.WriteError(w, http.StatusUnauthorized, "invalid or expired token")
				return
			}

			if versionStore != nil {
				if !versionStore.Check(r.Context(), claims.UserID, claims.TokenVersion) {
					httputil.WriteError(w, http.StatusUnauthorized, "token revoked")
					return
				}
			}

			// QA fix — surface user_id to the outer RequestLogger.
			// See UserIDHolder docs for why this can't just rely on
			// the ClaimsContextKey below.
			SetRequestUserID(r.Context(), claims.UserID)

			ctx := context.WithValue(r.Context(), ClaimsContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireStreamAuth accepts either a regular access token or a cast-scoped
// token (Scope == ScopeCast). Used by HLS playlist/segment routes that
// Chromecast and AirPlay receivers fetch with a long-lived URL token.
//
// Cast tokens still flow through TokenVersionStore (password change kills
// outstanding cast sessions) but do NOT have their SessionID matched
// against the URL here — that check lives in the handler, which has
// chi.URLParam("sessionID") available. The handler must reject when
// claims.Scope == ScopeCast && claims.SessionID != urlSessionID.
//
// Regular access tokens are accepted unchanged, so a logged-in user
// hitting an HLS URL in their browser still works exactly as before.
func RequireStreamAuth(svc *Service, versionStore *TokenVersionStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tokenStr, ok := tokenFromRequest(r)
			if !ok {
				httputil.WriteError(w, http.StatusUnauthorized, "missing authorization")
				return
			}

			// Try the regular access-token path first. ValidateAccessToken
			// rejects scoped tokens, so a cast token falls through to the
			// cast validator below.
			claims, err := svc.ValidateAccessToken(tokenStr)
			if err != nil {
				claims, err = svc.ValidateCastToken(tokenStr)
				if err != nil {
					httputil.WriteError(w, http.StatusUnauthorized, "invalid or expired token")
					return
				}
			}

			if versionStore != nil {
				if !versionStore.Check(r.Context(), claims.UserID, claims.TokenVersion) {
					httputil.WriteError(w, http.StatusUnauthorized, "token revoked")
					return
				}
			}

			// QA fix — surface user_id to the outer RequestLogger.
			SetRequestUserID(r.Context(), claims.UserID)

			ctx := context.WithValue(r.Context(), ClaimsContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireAdmin middleware ensures the user has admin role
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := GetClaims(r.Context())
		if claims == nil || claims.Role != "admin" {
			httputil.WriteError(w, http.StatusForbidden, "admin access required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// GetClaims extracts JWT claims from context
func GetClaims(ctx context.Context) *JWTClaims {
	claims, _ := ctx.Value(ClaimsContextKey).(*JWTClaims)
	return claims
}

// tokenFromRequest extracts the bearer token from the Authorization header, or
// (deep-debug H10) falls back to the httpOnly access cookie used by the browser
// SPA. The router's query-param promotion still rewrites ?token= into the
// Authorization header for cast/HLS URLs, so this single helper covers the
// header, cookie, and ?token= paths. A present-but-malformed Authorization
// header is rejected (returns false) rather than falling through to the cookie.
func tokenFromRequest(r *http.Request) (string, bool) {
	if authHeader := r.Header.Get("Authorization"); authHeader != "" {
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") || parts[1] == "" {
			return "", false
		}
		return parts[1], true
	}
	if c, err := r.Cookie(AccessCookieName); err == nil && c.Value != "" {
		return c.Value, true
	}
	return "", false
}
