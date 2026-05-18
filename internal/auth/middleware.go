package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/aurora-media/aurora/internal/httputil"
)

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
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				httputil.WriteError(w, http.StatusUnauthorized, "missing authorization header")
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
				httputil.WriteError(w, http.StatusUnauthorized, "invalid authorization format")
				return
			}

			claims, err := svc.ValidateAccessToken(parts[1])
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
