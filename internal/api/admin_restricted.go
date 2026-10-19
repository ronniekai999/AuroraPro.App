package api

import (
	"context"
	"net/http"

	"github.com/aurora-media/aurora/internal/auth"
)

// The admin role belongs to the account, not to a profile, so a session
// acting as a restricted profile on an admin account kept every admin power:
// it could invite a new, unrestricted account, change roles, restore a
// backup, or read any member's private collections. Such a session is treated
// as not an admin. An admin switches to an unrestricted profile (with its PIN,
// if it has one) to use them.

// refuseRestrictedAdmin is middleware for the admin routes, run after
// auth.RequireAdmin: it refuses (403 profile_restricted) a session acting as
// a restricted profile, and fails closed like denyRestrictedSession. It also
// refuses a non-admin and a scoped token itself, though auth.RequireAdmin and
// RequireAuth ahead of it already do, so the guard does not rest on its
// placement: a scoped token names no session, so it would resolve to the
// default.
func refuseRestrictedAdmin(store sessionStore) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := auth.GetClaims(r.Context())
			if claims == nil {
				writeError(w, http.StatusUnauthorized, "not authenticated")
				return
			}
			if claims.Role != "admin" {
				writeError(w, http.StatusForbidden, "admin access required")
				return
			}
			if claims.Scope != "" {
				writeError(w, http.StatusForbidden, "this token cannot use the admin pages")
				return
			}
			if denyRestrictedSession(w, r, store, claims, "use the admin pages") {
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// adminPowers reports whether a request may use the admin role's extra
// powers outside the admin routes (other members' private collections, any
// watch party's roster and reel). A session acting as a restricted profile,
// one whose session row is gone, or one whose profile cannot be resolved has
// none: it fails closed. So does a scoped token (a cast token copies its
// minter's role but names no session, so it would resolve to the account
// default), and a handler given no store: a nil interface, as PartyQRHandler
// and FeedbackHandler hold without one. A nil *db.Queries is not a nil
// interface; it panics, which the recoverer answers with a 500.
func adminPowers(ctx context.Context, store sessionStore, claims *auth.JWTClaims) bool {
	if claims == nil || claims.Role != "admin" || claims.Scope != "" || store == nil {
		return false
	}
	if claims.RefreshTokenID != 0 {
		if live, err := store.SessionLive(ctx, claims.UserID, claims.RefreshTokenID); err != nil || !live {
			return false
		}
	}
	acting, err := store.ResolveActingProfile(ctx, claims.UserID, claims.RefreshTokenID)
	return err == nil && acting != nil && acting.MaxAgeRating == ""
}
