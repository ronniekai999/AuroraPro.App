package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/llm"
	"github.com/aurora-media/aurora/internal/recap"
	"github.com/go-chi/chi/v5"
)

// RecapHandler serves "Previously" — spoiler-safe AI series recaps.
type RecapHandler struct {
	queries *db.Queries
	svc     *recap.Service
}

// NewRecapHandler wires the recap service. llmClient may be nil (LLM disabled);
// the handler then reports the feature as unavailable rather than erroring.
func NewRecapHandler(queries *db.Queries, llmClient *llm.Client) *RecapHandler {
	return &RecapHandler{queries: queries, svc: recap.New(queries, llmClient)}
}

// recapResponse is the GET /api/media/{id}/recap payload. Available is false
// (with a Reason) whenever there's nothing to show — the frontend hides the
// affordance instead of surfacing an error.
type recapResponse struct {
	Available bool        `json:"available"`
	Reason    string      `json:"reason,omitempty"`
	Recap     string      `json:"recap,omitempty"`
	UpTo      *recap.UpTo `json:"up_to,omitempty"`
	Cached    bool        `json:"cached,omitempty"`
}

// Get returns the spoiler-safe recap for the resolved profile resuming a show.
func (h *RecapHandler) Get(w http.ResponseWriter, r *http.Request) {
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}

	res, err := h.svc.Build(r.Context(), profileID, mediaID)
	switch {
	case errors.Is(err, recap.ErrLLMUnavailable):
		writeJSON(w, http.StatusOK, recapResponse{Available: false, Reason: "ai_unavailable"})
	case errors.Is(err, recap.ErrNoHistory):
		writeJSON(w, http.StatusOK, recapResponse{Available: false, Reason: "no_history"})
	case errors.Is(err, recap.ErrInsufficientContext):
		writeJSON(w, http.StatusOK, recapResponse{Available: false, Reason: "insufficient_overviews"})
	case err != nil:
		slog.Warn("recap: build failed", "media_item_id", mediaID, "profile_id", profileID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to build recap")
	default:
		writeJSON(w, http.StatusOK, recapResponse{
			Available: true,
			Recap:     res.Recap,
			UpTo:      &res.UpTo,
			Cached:    res.Cached,
		})
	}
}

// resolveProfileID mirrors HeroHandler.resolveProfileID: honor ?profile_id=
// (validated against the caller's account), else fall back to the default
// profile. Kept local so the recap route is self-contained.
func (h *RecapHandler) resolveProfileID(w http.ResponseWriter, r *http.Request, userID int64) (int64, bool) {
	if pidStr := r.URL.Query().Get("profile_id"); pidStr != "" {
		profileID, parseErr := strconv.ParseInt(pidStr, 10, 64)
		if parseErr != nil || profileID <= 0 {
			writeError(w, http.StatusBadRequest, "invalid profile_id")
			return 0, false
		}
		profile, err := h.queries.GetProfile(r.Context(), profileID)
		if err != nil || profile == nil {
			writeError(w, http.StatusNotFound, "profile not found")
			return 0, false
		}
		if profile.UserID != userID {
			writeError(w, http.StatusForbidden, "profile does not belong to this user")
			return 0, false
		}
		return profileID, true
	}
	profile, err := h.queries.GetDefaultProfile(r.Context(), userID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "no default profile")
		return 0, false
	}
	return profile.ID, true
}
