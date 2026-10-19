package api

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/aurora-media/aurora/internal/auth"
)

// The admin role belongs to the account, not to a profile, so a session
// acting as a restricted profile on an admin account kept every admin power:
// it could invite a new, unrestricted account, change roles, restore a
// backup, or read any member's private collections. Such a session is treated
// as not an admin. An admin switches to an unrestricted profile (with its PIN,
// if it has one) to use them.
//
// The one exception is an admin account with no unrestricted profile at all.
// Profile changes cannot produce one (keepAnUnrestrictedProfile, and
// CreateProfileFor for an account's first profile), but data from before
// that rule, a backup restore or hand-written SQL can, and a
// restricted session cannot lift a ceiling or create a profile. Refused there
// too, the account would have no admin powers and no way back to them inside
// the app; on a one-admin install, the server no admin. Its restricted
// sessions keep the admin powers.

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
			if !requireLiveSession(w, r, store.SessionLive, claims) {
				return
			}
			acting, err := store.ResolveActingProfile(r.Context(), claims.UserID, claims.RefreshTokenID)
			if err != nil || acting == nil {
				slog.Warn("resolve acting profile failed", "user_id", claims.UserID, "error", err)
				writeError(w, http.StatusInternalServerError, "failed to resolve the active profile")
				return
			}
			if hasCeiling(acting.MaxAgeRating) {
				none, err := noUnrestrictedProfile(r.Context(), store, claims.UserID)
				if err != nil {
					slog.Warn("check for an unrestricted profile failed", "user_id", claims.UserID, "error", err)
					writeError(w, http.StatusInternalServerError, "failed to resolve the active profile")
					return
				}
				if !none {
					writeErrorReason(w, http.StatusForbidden, "profile_restricted",
						"switch to a profile without a content rating limit to use the admin pages")
					return
				}
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
	if err != nil || acting == nil {
		return false
	}
	if !hasCeiling(acting.MaxAgeRating) {
		return true
	}
	none, err := noUnrestrictedProfile(ctx, store, claims.UserID)
	return err == nil && none
}

// hasCeiling reads a stored ceiling as the exception's query does (SQL
// btrim, which strips spaces only), so the two cannot disagree about one
// profile: a ceiling of spaces is none, and anything else, a tab included, is
// one. (The ladder and the web app trim all whitespace, so a hand-written tab
// is no ceiling to them; boot's canonicalization rewrites it.)
func hasCeiling(maxAgeRating string) bool {
	return strings.Trim(maxAgeRating, " ") != ""
}

// unrestrictedProfiles is the store method behind the exception above.
type unrestrictedProfiles interface {
	HasUnrestrictedProfile(ctx context.Context, userID int64) (bool, error)
}

// noUnrestrictedProfile reports that the account has no profile without a
// ceiling. A store without the method reports false, so there is no
// exception: it fails closed.
func noUnrestrictedProfile(ctx context.Context, store sessionStore, userID int64) (bool, error) {
	u, ok := store.(unrestrictedProfiles)
	if !ok {
		return false, nil
	}
	has, err := u.HasUnrestrictedProfile(ctx, userID)
	if err != nil {
		return false, err
	}
	return !has, nil
}
