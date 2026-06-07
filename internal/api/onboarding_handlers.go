package api

import (
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

const (
	onboardingMinPicks = 5  // titles required to finish onboarding
	onboardingMaxSeeds = 50 // cap on a single seed write / preview selection
	onboardingGridSize = 40 // default grid size
)

// OnboardingHandler powers the "Pick What You Love" taste-onboarding flow.
//
// A brand-new profile picks a few titles it loves; those are stored as
// taste_seeds, which BuildProfileVector folds into the taste vector so the
// hero / recommendations / discover / anchor-rails surfaces all personalize on
// first load instead of falling back to the generic popular pool.
//
// Phase 0 is vector-only: the flow is gated on the library actually having
// embeddings (otherwise seeds can't feed a vector) AND on the profile being
// UNRESTRICTED (no max_age_rating). Age-aware grid filtering for kid profiles
// lands in a later phase; until then a restricted profile is simply not offered
// onboarding rather than risk showing it above-rating titles.
type OnboardingHandler struct {
	queries *db.Queries
	hero    HeroProvider
}

func NewOnboardingHandler(queries *db.Queries) *OnboardingHandler {
	return &OnboardingHandler{queries: queries}
}

// SetHeroProvider attaches the recommender so a completed onboarding can drop
// the profile's stale cold-start cache immediately. Optional — without it the
// cache clears on its own 24h TTL.
func (h *OnboardingHandler) SetHeroProvider(p HeroProvider) {
	h.hero = p
}

// Status reports whether onboarding should be shown for the active profile.
func (h *OnboardingHandler) Status(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profile, ok := h.resolveProfile(w, r, claims.UserID)
	if !ok {
		return
	}
	eligible, libEmbedded, err := h.eligibility(r, profile)
	if err != nil {
		slog.Warn("onboarding: status check failed", "profile", profile.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to read onboarding status")
		return
	}
	seedCount, scErr := h.queries.CountTasteSeeds(r.Context(), profile.ID)
	if scErr != nil {
		slog.Warn("onboarding: seed count failed (non-fatal)", "profile", profile.ID, "error", scErr)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"profile_id":       profile.ID,
		"completed":        profile.TasteOnboardingCompleted,
		"eligible":         eligible,
		"library_embedded": libEmbedded,
		"min_picks":        onboardingMinPicks,
		"threshold":        db.PersonalizationThreshold(),
		"seed_count":       seedCount,
	})
}

// Grid returns the pool of titles the "Pick What You Love" grid draws from.
func (h *OnboardingHandler) Grid(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profile, ok := h.resolveProfile(w, r, claims.UserID)
	if !ok {
		return
	}
	eligible, _, err := h.eligibility(r, profile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build grid")
		return
	}
	if !eligible {
		// Not an error — the client just shouldn't show the screen.
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}})
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = onboardingGridSize
	} else if limit > 100 {
		limit = 100
	}
	items, err := h.queries.OnboardingGrid(r.Context(), profile.ID, limit)
	if err != nil {
		slog.Warn("onboarding: grid failed", "profile", profile.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to build grid")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// Preview is the "instant recommendations" rail: given the titles selected so
// far (?selected=1,2,3), build a partial taste vector and return the nearest
// unwatched titles. Empty until the selection clears the vector threshold.
func (h *OnboardingHandler) Preview(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profile, ok := h.resolveProfile(w, r, claims.UserID)
	if !ok {
		return
	}
	selected := parseIDList(r.URL.Query().Get("selected"), onboardingMaxSeeds)
	if len(selected) < db.PersonalizationThreshold() {
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}})
		return
	}
	vec, err := h.queries.PartialTasteVector(r.Context(), selected)
	if err != nil {
		// ErrInsufficientHistory (e.g. picks not embedded) → empty rail, not a 500.
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}})
		return
	}
	items, err := h.queries.NearestUnwatched(r.Context(), profile.ID, vec, 12, allowedRatingsForMax(profile.MaxAgeRating))
	if err != nil {
		slog.Warn("onboarding: preview failed", "profile", profile.ID, "error", err)
		writeJSON(w, http.StatusOK, map[string]any{"items": []any{}})
		return
	}
	// The selected titles aren't seeds yet, so NearestUnwatched won't exclude
	// them — drop any that slipped through so we never preview a pick back.
	items = filterOutIDs(items, selected)
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

type saveSeedsRequest struct {
	MediaIDs []int64 `json:"media_ids"`
}

// SaveSeeds persists the profile's picks, mirrors them to Favorites, marks
// onboarding complete, and drops the cold-start cache so the next home load is
// personalized.
func (h *OnboardingHandler) SaveSeeds(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profile, ok := h.resolveProfile(w, r, claims.UserID)
	if !ok {
		return
	}
	eligible, _, err := h.eligibility(r, profile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save picks")
		return
	}
	if !eligible {
		writeError(w, http.StatusConflict, "onboarding is not available for this profile")
		return
	}
	var req saveSeedsRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ids := dedupeIDs(req.MediaIDs)
	if len(ids) < onboardingMinPicks {
		writeError(w, http.StatusBadRequest, "pick at least "+strconv.Itoa(onboardingMinPicks)+" titles")
		return
	}
	if len(ids) > onboardingMaxSeeds {
		ids = ids[:onboardingMaxSeeds]
	}
	// Guarantee the seed actually unlocks personalization: enough of the picks
	// must be embedded to clear BuildProfileVector's threshold.
	embedded, err := h.queries.CountEmbeddedItems(r.Context(), ids)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to validate picks")
		return
	}
	if embedded < db.PersonalizationThreshold() {
		writeError(w, http.StatusBadRequest, "selected titles aren't ready for personalization yet")
		return
	}
	if err := h.queries.AddTasteSeeds(r.Context(), profile.ID, ids, "onboarding"); err != nil {
		slog.Error("onboarding: add seeds failed", "profile", profile.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to save picks")
		return
	}
	// Mirror into Favorites so the picks aren't throwaway. Non-fatal: the
	// recommender seed is the contract, the watchlist is gravy.
	if err := h.queries.MirrorSeedsToFavorites(r.Context(), profile.ID, ids); err != nil {
		slog.Warn("onboarding: mirror to favorites failed (non-fatal)", "profile", profile.ID, "error", err)
	}
	if err := h.queries.SetTasteOnboardingCompleted(r.Context(), profile.ID, true); err != nil {
		slog.Warn("onboarding: set completed flag failed (non-fatal)", "profile", profile.ID, "error", err)
	}
	// Drop the stale cold-start cache so the very next home load is personalized.
	if h.hero != nil {
		h.hero.Invalidate(profile.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"completed":  true,
		"seed_count": len(ids),
	})
}

// Reset clears the profile's seeds and re-arms onboarding — backs the
// "Refine your taste" entry point.
func (h *OnboardingHandler) Reset(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profile, ok := h.resolveProfile(w, r, claims.UserID)
	if !ok {
		return
	}
	if err := h.queries.ClearTasteSeeds(r.Context(), profile.ID); err != nil {
		slog.Error("onboarding: clear seeds failed", "profile", profile.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to reset onboarding")
		return
	}
	if err := h.queries.SetTasteOnboardingCompleted(r.Context(), profile.ID, false); err != nil {
		slog.Warn("onboarding: reset completed flag failed (non-fatal)", "profile", profile.ID, "error", err)
	}
	if h.hero != nil {
		h.hero.Invalidate(profile.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"reset": true})
}

// resolveProfile returns the profile to operate on — ?profile_id=N (validated
// to belong to the caller) wins, else the user's default profile — and a bool
// indicating whether to proceed. On failure it writes the response and returns
// false. Mirrors HeroHandler.resolveProfileID but returns the full profile so
// callers can read max_age_rating / the onboarding flag without a second query.
func (h *OnboardingHandler) resolveProfile(w http.ResponseWriter, r *http.Request, userID int64) (*models.UserProfile, bool) {
	if pidStr := r.URL.Query().Get("profile_id"); pidStr != "" {
		profileID, parseErr := strconv.ParseInt(pidStr, 10, 64)
		if parseErr != nil || profileID <= 0 {
			writeError(w, http.StatusBadRequest, "invalid profile_id")
			return nil, false
		}
		profile, err := h.queries.GetProfile(r.Context(), profileID)
		if err != nil || profile == nil {
			writeError(w, http.StatusNotFound, "profile not found")
			return nil, false
		}
		if profile.UserID != userID {
			writeError(w, http.StatusForbidden, "profile does not belong to this user")
			return nil, false
		}
		return profile, true
	}
	profile, err := h.queries.GetDefaultProfile(r.Context(), userID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "no default profile")
		return nil, false
	}
	return profile, true
}

// eligibility reports (eligible, libraryEmbedded, error). Onboarding is offered
// only when the library has embeddings (vector-only) and the profile is
// unrestricted (no max_age_rating) — see the type doc for the Phase 0 rationale.
func (h *OnboardingHandler) eligibility(r *http.Request, profile *models.UserProfile) (bool, bool, error) {
	libEmbedded, err := h.queries.LibraryHasEmbeddings(r.Context())
	if err != nil {
		return false, false, err
	}
	unrestricted := strings.TrimSpace(profile.MaxAgeRating) == ""
	return libEmbedded && unrestricted, libEmbedded, nil
}

// parseIDList parses a comma-separated list of positive int64 ids — deduped,
// invalid tokens skipped, capped at max.
func parseIDList(s string, max int) []int64 {
	if s == "" {
		return nil
	}
	seen := make(map[int64]struct{})
	var out []int64
	for _, tok := range strings.Split(s, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		id, err := strconv.ParseInt(tok, 10, 64)
		if err != nil || id <= 0 {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
		if len(out) >= max {
			break
		}
	}
	return out
}

// dedupeIDs drops non-positive and duplicate ids, preserving order.
func dedupeIDs(ids []int64) []int64 {
	seen := make(map[int64]struct{}, len(ids))
	var out []int64
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

// filterOutIDs returns items whose ID is not in exclude.
func filterOutIDs(items []*models.MediaItem, exclude []int64) []*models.MediaItem {
	if len(exclude) == 0 || len(items) == 0 {
		return items
	}
	ex := make(map[int64]struct{}, len(exclude))
	for _, id := range exclude {
		ex[id] = struct{}{}
	}
	out := make([]*models.MediaItem, 0, len(items))
	for _, it := range items {
		if _, skip := ex[it.ID]; skip {
			continue
		}
		out = append(out, it)
	}
	return out
}
