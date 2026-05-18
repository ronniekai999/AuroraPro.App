package api

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// HeroProvider is the contract HeroHandler needs from the recommender.
// Defining it at the consumer keeps the api package free of recommender-specific
// types — main.go wires up an adapter that satisfies this interface.
//
// Invalidate is called from the progress handler when the user explicitly
// marks an item watched, so tomorrow's hero reflects the new taste without
// waiting for the 24h cache TTL. It clears the Discover cache too — both
// surfaces are taste-driven, so they should refresh together.
type HeroProvider interface {
	PoolFor(ctx context.Context, profileID int64) ([]HeroPick, error)
	RailFor(ctx context.Context, profileID int64, limit int) ([]*models.MediaItem, error)
	DiscoverFor(ctx context.Context, profileID int64) ([]DiscoverRail, error)
	AnchorRailsFor(ctx context.Context, profileID int64) ([]AnchorRail, error)
	Invalidate(profileID int64)
}

// DiscoverRail is one LLM-curated themed section. Mirrors
// recommender.DiscoverRail at the boundary. The frontend renders one
// shelf per rail.
type DiscoverRail struct {
	Title string              `json:"title"`
	Items []*models.MediaItem `json:"items"`
}

// AnchorRail is one "Because You Watched X" section: an anchor reference
// + items most similar to that anchor's embedding. Mirrors
// recommender.AnchorRail at the boundary.
type AnchorRail struct {
	Anchor *models.AnchorRef   `json:"anchor"`
	Items  []*models.MediaItem `json:"items"`
}

// HeroPick is the API-layer shape of a hero pool entry. Mirrors
// recommender.HeroPick at the boundary so internal types can evolve freely.
type HeroPick struct {
	Item   *models.MediaItem `json:"item"`
	Reason string            `json:"reason,omitempty"`
}

// HeroHandler serves the personalized "Featured" rail. When no provider is
// attached, the endpoint returns 503 and the frontend falls back to its
// existing top-rated/recent pool.
type HeroHandler struct {
	queries *db.Queries
	hero    HeroProvider
}

func NewHeroHandler(queries *db.Queries) *HeroHandler {
	return &HeroHandler{queries: queries}
}

// SetHeroProvider attaches the personalization backend. Pass nil (or never
// call this) to keep the endpoint unavailable.
func (h *HeroHandler) SetHeroProvider(p HeroProvider) {
	h.hero = p
}

// Get returns the personalized hero pool for the active profile.
//
// Profile resolution: ?profile_id=N (validated) wins; otherwise the user's
// default profile. Returns {"picks": [...]} so the response can grow new
// top-level fields (e.g. "generated_at") without breaking clients.
func (h *HeroHandler) Get(w http.ResponseWriter, r *http.Request) {
	if h.hero == nil {
		writeError(w, http.StatusServiceUnavailable, "personalized hero not configured")
		return
	}
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return // resolveProfileID already wrote the error response
	}

	// ?refresh=1 forces a rebuild — the user clicked the "Refresh suggestions"
	// button and wants new picks now, not in 24h. Cheap: just drops cache.
	if v := r.URL.Query().Get("refresh"); v == "1" || v == "true" {
		h.hero.Invalidate(profileID)
	}

	picks, err := h.hero.PoolFor(r.Context(), profileID)
	if err != nil {
		slog.Warn("hero: pool fetch failed", "profile", profileID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to build hero")
		return
	}

	// Annotations (Genres / Has4K) are baked into the cached snapshot by the
	// recommender so we don't mutate items here — that mutation was racing
	// across concurrent readers since the same pointers are served from the
	// 24h cache. See recommender.Hero.annotatePicks.

	writeJSON(w, http.StatusOK, map[string]any{"picks": picks})
}

// Rail returns a longer list of personalized recommendations for a "More
// like what you watched" home-page rail. Pure vector retrieval — no LLM, no
// blurbs. Items are annotated with genres + has_4k like other home rails.
//
// ?limit=N (default 24, max 60). ?profile_id=N (validated).
func (h *HeroHandler) Rail(w http.ResponseWriter, r *http.Request) {
	if h.hero == nil {
		writeError(w, http.StatusServiceUnavailable, "personalized recommendations not configured")
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

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 24
	} else if limit > 60 {
		limit = 60
	}

	items, err := h.hero.RailFor(r.Context(), profileID, limit)
	if err != nil {
		slog.Warn("rail: fetch failed", "profile", profileID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to build rail")
		return
	}
	// Annotations (Genres / Has4K) are populated inside RailFor so every
	// consumer of the HeroProvider interface — not just this handler —
	// gets badge-ready items.

	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// Discover returns the LLM-curated themed rails for the active profile.
//
// Response shape: `{"rails": [{"title": "...", "items": [...]}, ...]}`. Empty
// rails array is a legitimate response — the UI falls back to the
// "More like what you watched" rail when Discover has no content (cold
// start, LLM unavailable, parse failure, etc).
//
// ?refresh=1 invalidates the 24h cache, same as the hero endpoint.
func (h *HeroHandler) Discover(w http.ResponseWriter, r *http.Request) {
	if h.hero == nil {
		writeError(w, http.StatusServiceUnavailable, "discover not configured")
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

	if v := r.URL.Query().Get("refresh"); v == "1" || v == "true" {
		h.hero.Invalidate(profileID)
	}

	rails, err := h.hero.DiscoverFor(r.Context(), profileID)
	if err != nil {
		slog.Warn("discover: fetch failed", "profile", profileID, "error", err)
		// Empty rails is fine — the UI gracefully falls back. Don't
		// 500 here; that would turn a degraded experience into a
		// broken one.
		rails = nil
	}

	writeJSON(w, http.StatusOK, map[string]any{"rails": rails})
}

// AnchorRails returns up to 3 "Because You Watched X" rails for the
// active profile. Fast vector retrieval, no LLM — sub-300ms typical.
//
// Response shape: `{"rails": [{"anchor": {...}, "items": [...]}, ...]}`.
// Empty array is fine — the UI hides the section. Cold-start (no
// embedded watched items) returns empty.
func (h *HeroHandler) AnchorRails(w http.ResponseWriter, r *http.Request) {
	if h.hero == nil {
		writeError(w, http.StatusServiceUnavailable, "anchor rails not configured")
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
	rails, err := h.hero.AnchorRailsFor(r.Context(), profileID)
	if err != nil {
		slog.Warn("anchor rails: fetch failed", "profile", profileID, "error", err)
		rails = nil
	}
	writeJSON(w, http.StatusOK, map[string]any{"rails": rails})
}

// resolveProfileID returns the profile to personalize for and a bool
// indicating whether to proceed. On validation failure it writes the
// response itself and returns false.
func (h *HeroHandler) resolveProfileID(w http.ResponseWriter, r *http.Request, userID int64) (int64, bool) {
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
