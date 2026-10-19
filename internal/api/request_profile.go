package api

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/models"
)

// requestProfileStore is what resolveRequestProfile reads.
type requestProfileStore interface {
	GetProfile(ctx context.Context, profileID int64) (*models.UserProfile, error)
	ResolveActingProfile(ctx context.Context, userID, refreshTokenID int64) (*models.UserProfile, error)
}

// resolveRequestProfile picks the profile a profile-keyed request acts on.
// requested is the id the client named (a query parameter, a body field or a
// URL segment), 0 for none.
//
//   - No id means the session's acting profile (issue #462), never the
//     account default. These routes used to fall back to the default, so a
//     kid's session that left profile_id off got the parent's rails.
//   - A named id must belong to the account.
//   - A session acting as a restricted profile (one with a ceiling) may name
//     only itself. Otherwise ?profile_id= would read another profile's
//     recommendations, history or recaps, and undo the profile lock. An
//     unrestricted session may still name any of the account's profiles.
//
// It writes the refusal itself and fails closed: an acting-profile resolve
// error is a 500, never a fallback. The returned profile has ID 0 only when
// nothing was named and the account has no profile yet; callers decide what
// that means.
func resolveRequestProfile(w http.ResponseWriter, r *http.Request, store requestProfileStore, requested int64) (*models.UserProfile, bool) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return nil, false
	}
	profile, refusal := pickRequestProfile(r.Context(), store, claims, requested)
	if refusal != nil {
		if refusal.reason != "" {
			writeErrorReason(w, refusal.status, refusal.reason, refusal.message)
		} else {
			writeError(w, refusal.status, refusal.message)
		}
		return nil, false
	}
	return profile, true
}

// requestProfileRefusal is why pickRequestProfile refused, as the HTTP answer
// resolveRequestProfile gives.
type requestProfileRefusal struct {
	status          int
	reason, message string
}

// pickRequestProfile is resolveRequestProfile's rule without the response,
// for callers that refuse silently (the playback telemetry beacons).
func pickRequestProfile(ctx context.Context, store requestProfileStore, claims *auth.JWTClaims, requested int64) (*models.UserProfile, *requestProfileRefusal) {
	if requested < 0 {
		return nil, &requestProfileRefusal{status: http.StatusBadRequest, message: "invalid profile_id"}
	}
	acting, err := store.ResolveActingProfile(ctx, claims.UserID, claims.RefreshTokenID)
	if err != nil || acting == nil {
		slog.Warn("resolve acting profile failed", "user_id", claims.UserID, "error", err)
		return nil, &requestProfileRefusal{status: http.StatusInternalServerError, message: "failed to resolve the active profile"}
	}
	if requested == 0 || requested == acting.ID {
		return acting, nil
	}
	profile, err := store.GetProfile(ctx, requested)
	if err != nil {
		return nil, &requestProfileRefusal{status: http.StatusInternalServerError, message: "failed to validate profile"}
	}
	if profile == nil {
		return nil, &requestProfileRefusal{status: http.StatusNotFound, message: "profile not found"}
	}
	if profile.UserID != claims.UserID {
		return nil, &requestProfileRefusal{status: http.StatusForbidden, message: "profile does not belong to this user"}
	}
	if acting.MaxAgeRating != "" {
		return nil, &requestProfileRefusal{status: http.StatusForbidden, reason: "profile_restricted",
			message: "a profile with a content limit can only act as itself"}
	}
	return profile, nil
}

// queryProfileID parses ?profile_id=, 0 when absent. It writes a 400 for a
// value that is not a positive integer.
func queryProfileID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := r.URL.Query().Get("profile_id")
	if raw == "" {
		return 0, true
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid profile_id")
		return 0, false
	}
	return id, true
}

// resolveQueryProfile is resolveRequestProfile for ?profile_id=, for routes
// that need a real profile: an account with none is a 404.
func resolveQueryProfile(w http.ResponseWriter, r *http.Request, store requestProfileStore) (*models.UserProfile, bool) {
	requested, ok := queryProfileID(w, r)
	if !ok {
		return nil, false
	}
	profile, ok := resolveRequestProfile(w, r, store, requested)
	if !ok {
		return nil, false
	}
	if profile.ID == 0 {
		writeError(w, http.StatusNotFound, "no default profile")
		return nil, false
	}
	return profile, true
}

// resolveQueryProfileAllowingNone is resolveRequestProfile for ?profile_id=,
// for read routes where an account with no profile yet simply has nothing to
// show: it returns the acting profile with ID 0 then, not a 404.
func resolveQueryProfileAllowingNone(w http.ResponseWriter, r *http.Request, store requestProfileStore) (*models.UserProfile, bool) {
	requested, ok := queryProfileID(w, r)
	if !ok {
		return nil, false
	}
	return resolveRequestProfile(w, r, store, requested)
}
