package api

import (
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type ProfileHandler struct {
	queries *db.Queries
	hero    HeroProvider // optional; for cache invalidation on maturity_pref change
}

// nebulaAvatarRe matches the built-in animated-nebula avatar ids the onboarding
// flow assigns ("nebula:aurora", "nebula:tidal", …). These are short opaque ids,
// not image URLs, so avatar validation accepts them alongside http(s) URLs.
var nebulaAvatarRe = regexp.MustCompile(`^nebula:[a-z0-9_-]{1,32}$`)

// validAvatarValue reports whether v is an acceptable, non-empty avatar
// reference: an http(s) URL (length already capped by callers) or a built-in
// nebula id. Callers handle the empty string (means "leave unchanged"/"clear")
// before calling this.
func validAvatarValue(v string) bool {
	if len(v) > 2048 {
		return false
	}
	if strings.HasPrefix(v, "http://") || strings.HasPrefix(v, "https://") {
		return true
	}
	return nebulaAvatarRe.MatchString(v)
}

func NewProfileHandler(queries *db.Queries) *ProfileHandler {
	return &ProfileHandler{queries: queries}
}

// SetHeroProvider wires the recommender so a content-tone (maturity_pref) change
// can invalidate the profile's cached hero/discover and re-curate promptly.
func (h *ProfileHandler) SetHeroProvider(p HeroProvider) { h.hero = p }

// ListProfiles returns all profiles for the authenticated user.
func (h *ProfileHandler) ListProfiles(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profiles, err := h.queries.GetProfilesByUser(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list profiles")
		return
	}
	if profiles == nil {
		profiles = []*models.UserProfile{}
	}
	writeJSON(w, http.StatusOK, profiles)
}

// CreateProfile creates a new profile for the authenticated user.
func (h *ProfileHandler) CreateProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}

	var req models.CreateProfileRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name == "" || len(req.Name) > 100 {
		writeError(w, http.StatusBadRequest, "name is required (max 100 characters)")
		return
	}

	// Check max profiles per user
	count, err := h.queries.CountProfilesByUser(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check profile count")
		return
	}

	maxStr, _ := h.queries.GetSetting(r.Context(), "max_profiles_per_user")
	maxProfiles := 6
	if maxStr != "" {
		if v, err := strconv.Atoi(maxStr); err == nil && v > 0 {
			maxProfiles = v
		}
	}
	if count >= maxProfiles {
		writeError(w, http.StatusBadRequest, "maximum number of profiles reached")
		return
	}

	lang := req.Language
	if lang == "" {
		lang = "en"
	}
	subMode := req.SubtitleMode
	if subMode == "" {
		subMode = "off"
	}
	if subMode != "off" && subMode != "auto" && subMode != "always" {
		writeError(w, http.StatusBadRequest, "subtitle_mode must be off, auto, or always")
		return
	}

	if req.AvatarURL != "" && !validAvatarValue(req.AvatarURL) {
		writeError(w, http.StatusBadRequest, "avatar must be an http(s) URL or a built-in avatar id")
		return
	}

	profile := &models.UserProfile{
		UserID:       claims.UserID,
		Name:         req.Name,
		AvatarURL:    req.AvatarURL,
		IsDefault:    false,
		MaxAgeRating: req.MaxAgeRating,
		Language:     lang,
		SubtitleLang: req.SubtitleLang,
		SubtitleMode: subMode,
	}

	if err := h.queries.CreateProfile(r.Context(), profile); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create profile")
		return
	}

	writeJSON(w, http.StatusCreated, profile)
}

// GetProfile returns a single profile by ID.
func (h *ProfileHandler) GetProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}

	writeJSON(w, http.StatusOK, profile)
}

// UpdateProfile updates a profile.
func (h *ProfileHandler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}

	var req models.UpdateProfileRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name != nil && (len(*req.Name) == 0 || len(*req.Name) > 100) {
		writeError(w, http.StatusBadRequest, "name must be 1-100 characters")
		return
	}
	if req.SubtitleMode != nil {
		m := *req.SubtitleMode
		if m != "off" && m != "auto" && m != "always" {
			writeError(w, http.StatusBadRequest, "subtitle_mode must be off, auto, or always")
			return
		}
	}
	// Language column is NOT NULL DEFAULT 'en' in the schema; allowing an
	// empty string through here would silently insert "" and break downstream
	// language-dependent code paths (subtitle picker, UI locale).
	if req.Language != nil && *req.Language == "" {
		writeError(w, http.StatusBadRequest, "language must be a non-empty BCP-47 tag (e.g. 'en')")
		return
	}
	if req.AvatarURL != nil && *req.AvatarURL != "" && !validAvatarValue(*req.AvatarURL) {
		writeError(w, http.StatusBadRequest, "avatar must be an http(s) URL or a built-in avatar id")
		return
	}

	if err := h.queries.UpdateProfile(r.Context(), profileID, &req); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update profile")
		return
	}

	// A content-tone change reshapes recall (maturityPenaltyExpr), so drop the
	// profile's cached hero/discover to re-curate on the next fetch instead of
	// waiting out the 24h TTL.
	if req.MaturityPref != nil && h.hero != nil {
		h.hero.Invalidate(profileID)
	}

	updated, _ := h.queries.GetProfile(r.Context(), profileID)
	writeJSON(w, http.StatusOK, updated)
}

// DeleteProfile deletes a non-default profile.
func (h *ProfileHandler) DeleteProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}
	if profile.IsDefault {
		writeError(w, http.StatusBadRequest, "cannot delete default profile")
		return
	}

	deleted, err := h.queries.DeleteProfile(r.Context(), profileID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete profile")
		return
	}
	if !deleted {
		writeError(w, http.StatusBadRequest, "cannot delete default profile")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "profile deleted"})
}

// SetDefault sets a profile as the user's default.
func (h *ProfileHandler) SetDefault(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return
	}

	if err := h.queries.SetDefaultProfile(r.Context(), claims.UserID, profileID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to set default profile")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "default profile updated"})
}

// ============================================================
// Watchlist Handlers
// ============================================================

func (h *ProfileHandler) requireProfileOwnership(w http.ResponseWriter, r *http.Request) (int64, bool) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return 0, false
	}
	profileID, err := strconv.ParseInt(chi.URLParam(r, "profileId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile id")
		return 0, false
	}

	profile, err := h.queries.GetProfile(r.Context(), profileID)
	if err != nil || profile == nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return 0, false
	}
	if profile.UserID != claims.UserID {
		writeError(w, http.StatusForbidden, "access denied")
		return 0, false
	}
	return profileID, true
}

func (h *ProfileHandler) requireWatchlistOwnership(w http.ResponseWriter, r *http.Request, profileID int64) (int64, bool) {
	listID, err := strconv.ParseInt(chi.URLParam(r, "listId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid watchlist id")
		return 0, false
	}

	wl, err := h.queries.GetWatchlist(r.Context(), listID)
	if err != nil || wl == nil {
		writeError(w, http.StatusNotFound, "watchlist not found")
		return 0, false
	}
	if wl.ProfileID != profileID {
		writeError(w, http.StatusForbidden, "access denied")
		return 0, false
	}
	return listID, true
}

// ListWatchlists returns all watchlists for a profile.
func (h *ProfileHandler) ListWatchlists(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	lists, err := h.queries.GetWatchlistsByProfile(r.Context(), profileID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list watchlists")
		return
	}
	if lists == nil {
		lists = []*models.Watchlist{}
	}
	writeJSON(w, http.StatusOK, lists)
}

// CreateWatchlist creates a new watchlist for a profile.
func (h *ProfileHandler) CreateWatchlist(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	var req models.CreateWatchlistRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name == "" || len(req.Name) > 255 {
		writeError(w, http.StatusBadRequest, "name is required (max 255 characters)")
		return
	}

	listType := req.ListType
	if listType == "" {
		listType = "custom"
	}
	if listType != "want_to_watch" && listType != "favorites" && listType != "custom" {
		writeError(w, http.StatusBadRequest, "list_type must be want_to_watch, favorites, or custom")
		return
	}

	wl := &models.Watchlist{
		ProfileID: profileID,
		Name:      req.Name,
		ListType:  listType,
	}

	if err := h.queries.CreateWatchlist(r.Context(), wl); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create watchlist")
		return
	}

	writeJSON(w, http.StatusCreated, wl)
}

// DeleteWatchlist deletes a watchlist.
func (h *ProfileHandler) DeleteWatchlist(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	listID, ok := h.requireWatchlistOwnership(w, r, profileID)
	if !ok {
		return
	}

	deleted, err := h.queries.DeleteWatchlist(r.Context(), listID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete watchlist")
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "watchlist not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "watchlist deleted"})
}

// GetWatchlistItems returns items in a watchlist.
func (h *ProfileHandler) GetWatchlistItems(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	listID, ok := h.requireWatchlistOwnership(w, r, profileID)
	if !ok {
		return
	}

	params := paginate(r)
	items, total, err := h.queries.GetWatchlistItems(r.Context(), listID, params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get watchlist items")
		return
	}
	if items == nil {
		items = []*models.WatchlistItem{}
	}

	writeJSON(w, http.StatusOK, paginatedResponse(items, total, params))
}

// AddToWatchlist adds an item to a watchlist.
func (h *ProfileHandler) AddToWatchlist(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	listID, ok := h.requireWatchlistOwnership(w, r, profileID)
	if !ok {
		return
	}

	var req models.AddToWatchlistRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.MediaItemID <= 0 {
		writeError(w, http.StatusBadRequest, "media_item_id required")
		return
	}

	if err := h.queries.AddToWatchlist(r.Context(), listID, req.MediaItemID); err != nil {
		// Distinguish FK violation (media_item_id doesn't exist) from
		// genuine server errors so the client gets an actionable 404
		// instead of a generic 500.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			writeError(w, http.StatusNotFound, "media item not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to add to watchlist")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"message": "added to watchlist"})
}

// RemoveFromWatchlist removes an item from a watchlist.
func (h *ProfileHandler) RemoveFromWatchlist(w http.ResponseWriter, r *http.Request) {
	profileID, ok := h.requireProfileOwnership(w, r)
	if !ok {
		return
	}

	listID, ok := h.requireWatchlistOwnership(w, r, profileID)
	if !ok {
		return
	}

	itemID, err := strconv.ParseInt(chi.URLParam(r, "itemId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid item id")
		return
	}

	deleted, err := h.queries.RemoveFromWatchlist(r.Context(), listID, itemID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove from watchlist")
		return
	}
	if !deleted {
		writeError(w, http.StatusNotFound, "item not found in watchlist")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "removed from watchlist"})
}
