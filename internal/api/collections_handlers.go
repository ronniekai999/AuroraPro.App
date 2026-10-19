package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
)

// Phase 6 — Collections handler.
//
// Two creation paths:
//   - Manual: POST /api/collections with {name} → empty collection;
//             admin adds items via POST /api/collections/:id/items.
//   - AI:     POST /api/collections with {name, kind:"ai", prompt}
//             → server runs a semantic search using the prompt and
//             pre-fills items from the top N hits. The user can
//             still tweak after the fact via the standard item-CRUD.
//
// Public collections (is_public=true) appear in every user's
// home view as "Curated Collections" rails. is_public is admin-only
// to set — the handler refuses to flip it from a non-admin request.

const aiCollectionDefaultPicks = 12

// CollectionsHandler depends on the queries layer + the same
// SemanticSearcher interface MediaHandler uses for /search.
// SemanticSearcher is OPTIONAL — when nil, AI-collection creation
// is rejected with 503. Manual collections always work.
type CollectionsHandler struct {
	queries  *db.Queries
	semantic SemanticSearcher
	// resolveProfile is queries.ResolveActingProfile; a field so a test can
	// make it fail and pin that AI seeding does not fail open.
	resolveProfile func(ctx context.Context, userID, refreshTokenID int64) (*models.UserProfile, error)
}

func NewCollectionsHandler(queries *db.Queries) *CollectionsHandler {
	return &CollectionsHandler{queries: queries, resolveProfile: queries.ResolveActingProfile}
}

// SetSemanticSearcher wires the LLM-backed search for AI-collection
// curation. Pass nil to disable AI creation (manual still works).
func (h *CollectionsHandler) SetSemanticSearcher(s SemanticSearcher) {
	h.semantic = s
}

// List returns all collections visible to the caller (owned + public).
func (h *CollectionsHandler) List(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	// Audit M1 fix — admins see all collections (incl. others'
	// private ones). Regular users see owned + public.
	out, err := h.queries.ListCollectionsForUser(r.Context(), claims.UserID, adminPowers(r.Context(), h.queries, claims))
	if err != nil {
		slog.Warn("collections list failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to list collections")
		return
	}
	if out == nil {
		out = []*models.Collection{}
	}
	writeJSON(w, http.StatusOK, out)
}

// Get returns one collection plus its items.
func (h *CollectionsHandler) Get(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	c, err := h.queries.GetCollection(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if c == nil {
		writeError(w, http.StatusNotFound, "collection not found")
		return
	}
	// Visibility: owner OR public-readable OR admin (audit M1).
	// Admins can already mutate any collection — making them able
	// to READ what they can mutate removes a confusing asymmetry.
	if c.OwnerUserID != claims.UserID && !c.IsPublic && !adminPowers(r.Context(), h.queries, claims) {
		writeError(w, http.StatusForbidden, "not your collection")
		return
	}
	items, err := h.queries.ListCollectionItems(r.Context(), id)
	if err != nil {
		slog.Warn("collection items fetch failed", "id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load items")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"collection": c,
		"items":      items,
	})
}

// Create handles manual + AI creation. The kind field decides which.
func (h *CollectionsHandler) Create(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var req models.CreateCollectionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Kind == "" {
		req.Kind = "manual"
	}
	if req.Kind != "manual" && req.Kind != "ai" {
		writeError(w, http.StatusBadRequest, "kind must be 'manual' or 'ai'")
		return
	}
	// Only admins may flip is_public. Non-admin requests get
	// is_public=false regardless of the body payload — match other
	// is_public surfaces in Aurora (e.g. watchparty rooms).
	isPublic := req.IsPublic && adminPowers(r.Context(), h.queries, claims)

	if req.Kind == "ai" {
		if h.semantic == nil {
			writeError(w, http.StatusServiceUnavailable, "AI curation not configured (LLM disabled)")
			return
		}
		if strings.TrimSpace(req.Prompt) == "" {
			writeError(w, http.StatusBadRequest, "prompt is required for AI collections")
			return
		}
	}

	c := &models.Collection{
		OwnerUserID: claims.UserID,
		Name:        req.Name,
		Description: strings.TrimSpace(req.Description),
		Kind:        req.Kind,
		Prompt:      strings.TrimSpace(req.Prompt),
		IsPublic:    isPublic,
	}
	if err := h.queries.CreateCollection(r.Context(), c); err != nil {
		slog.Warn("create collection failed", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to create collection")
		return
	}

	// AI seed: run a semantic search using the prompt, pre-fill
	// items from the top hits. Failures are non-fatal — the empty
	// collection still gets returned and the user can rebuild via
	// "regenerate" later.
	//
	// The seed is a library search run as the creator, so it takes the
	// creator's acting-profile ceiling exactly as /api/media/search does;
	// otherwise a restricted profile could read any title back by prompting
	// a collection for it. Unlike that handler it does NOT fail open: the seed
	// is saved, and collection contents are read back without a ceiling, so a
	// resolve error skips the seed and returns the empty collection instead.
	if req.Kind == "ai" {
		c = h.seedAICollection(r, claims, c)
	}

	writeJSON(w, http.StatusCreated, c)
}

// seedAICollection fills a new AI collection from a semantic search on its
// prompt and returns the reloaded collection (c itself if nothing reloads).
func (h *CollectionsHandler) seedAICollection(r *http.Request, claims *auth.JWTClaims, c *models.Collection) *models.Collection {
	profile, err := h.resolveProfile(r.Context(), claims.UserID, claims.RefreshTokenID)
	if err != nil {
		slog.Warn("AI collection: resolve acting profile failed (returning empty collection)",
			"user_id", claims.UserID, "error", err)
		return c
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	hits, err := h.semantic.Search(ctx, c.Prompt, aiCollectionDefaultPicks, db.AllowedRatingsForMax(profile.MaxAgeRating))
	if err != nil {
		slog.Warn("AI collection: semantic search failed (returning empty collection)",
			"prompt", c.Prompt, "error", err)
		return c
	}
	for _, hit := range hits {
		// Re-checked as in MediaHandler.Search: the searcher filters in SQL,
		// and this is what the handler can promise itself.
		if hit.Item == nil || !db.RatingAllowed(profile.MaxAgeRating, hit.Item.ContentRating) {
			continue
		}
		if aerr := h.queries.AddToCollection(r.Context(), c.ID, hit.Item.ID); aerr != nil {
			slog.Warn("AI collection: add item failed",
				"collection_id", c.ID, "media_id", hit.Item.ID, "error", aerr)
		}
	}
	// Re-load to update ItemCount in the response.
	if reloaded, _ := h.queries.GetCollection(r.Context(), c.ID); reloaded != nil {
		c = reloaded
	}
	return c
}

// Delete removes a collection. Owner OR admin only.
func (h *CollectionsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	c, err := h.queries.GetCollection(r.Context(), id)
	if err != nil || c == nil {
		writeError(w, http.StatusNotFound, "collection not found")
		return
	}
	if c.OwnerUserID != claims.UserID && !adminPowers(r.Context(), h.queries, claims) {
		writeError(w, http.StatusForbidden, "not your collection")
		return
	}
	if err := h.queries.DeleteCollection(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AddItem adds a media item to a collection. Owner OR admin only.
func (h *CollectionsHandler) AddItem(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	c, gerr := h.queries.GetCollection(r.Context(), id)
	if gerr != nil || c == nil {
		writeError(w, http.StatusNotFound, "collection not found")
		return
	}
	if c.OwnerUserID != claims.UserID && !adminPowers(r.Context(), h.queries, claims) {
		writeError(w, http.StatusForbidden, "not your collection")
		return
	}
	var req models.AddToCollectionRequest
	if derr := json.NewDecoder(r.Body).Decode(&req); derr != nil || req.MediaItemID <= 0 {
		writeError(w, http.StatusBadRequest, "media_item_id is required")
		return
	}
	if aerr := h.queries.AddToCollection(r.Context(), id, req.MediaItemID); aerr != nil {
		// FK-violation on media_item_id bubbles up as a generic
		// error; the user sees "add item failed". The query is
		// idempotent on the (collection_id, media_item_id) UNIQUE
		// via ON CONFLICT DO NOTHING.
		slog.Warn("collection add item failed", "id", id, "error", aerr)
		writeError(w, http.StatusInternalServerError, "add item failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// RemoveItem removes a media item from a collection. Owner OR admin only.
func (h *CollectionsHandler) RemoveItem(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	itemID, err := strconv.ParseInt(chi.URLParam(r, "itemId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid item id")
		return
	}
	c, gerr := h.queries.GetCollection(r.Context(), id)
	if gerr != nil || c == nil {
		writeError(w, http.StatusNotFound, "collection not found")
		return
	}
	if c.OwnerUserID != claims.UserID && !adminPowers(r.Context(), h.queries, claims) {
		writeError(w, http.StatusForbidden, "not your collection")
		return
	}
	if err := h.queries.RemoveFromCollection(r.Context(), id, itemID); err != nil {
		writeError(w, http.StatusInternalServerError, "remove item failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
