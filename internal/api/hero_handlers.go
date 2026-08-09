package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/jackc/pgx/v5/pgconn"
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
	// DiscoverCached returns cached Discover rails WITHOUT building. ok is true
	// only on a fresh cache hit. Lets the handler answer instantly when warm
	// and background-build (non-blocking) when cold.
	DiscoverCached(profileID int64) ([]DiscoverRail, bool)
	AnchorRailsFor(ctx context.Context, profileID int64) ([]AnchorRail, error)
	EngagementRailsFor(ctx context.Context, profileID int64) ([]EngagementRail, error)
	Invalidate(profileID int64)
}

// HubBroadcaster is the slice of the WebSocket hub HeroHandler needs to push a
// discover_ready event to a user. *websocket.Hub satisfies it; kept as an
// interface so the handler doesn't depend on the concrete hub (and tests can
// stub it).
type HubBroadcaster interface {
	BroadcastToUser(userID int64, eventType string, data interface{})
}

// discoverEmptyTTL suppresses re-kicking a background Discover build for a
// profile whose last build produced zero rails (cold-start, LLM disabled, no
// candidates). Short enough that a real taste change (a new watch →
// Invalidate, or ?refresh=1) rebuilds promptly; long enough that the client's
// poll fallback can't hammer the recommender. The client treats the resulting
// "empty" status as terminal and hides the Discover section.
const discoverEmptyTTL = 60 * time.Second

// recommendationImpressionConcurrency caps best-effort analytics writes so
// cache-hit traffic can never create an unbounded goroutine/pool backlog. When
// both slots are occupied the snapshot is deliberately dropped.
const recommendationImpressionConcurrency = 2

func newRecommendationSlateToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		slog.Error("hero: crypto/rand failed for slate token", "error", err)
		return ""
	}
	return hex.EncodeToString(b[:])
}

// discoverBuilds tracks background /api/me/discover builds so the non-blocking
// handler can report status ("building"/"empty") without re-kicking work the
// recommender's singleflight is already collapsing.
type discoverBuilds struct {
	mu        sync.Mutex
	inflight  map[int64]bool      // profileID -> a build goroutine is running
	emptyTill map[int64]time.Time // profileID -> suppress re-kicks until (last build was empty)
}

// DiscoverRail is one LLM-curated themed section. Mirrors
// recommender.DiscoverRail at the boundary. The frontend renders one
// shelf per rail. Description is the LLM's optional one-sentence theme line
// (≤100 chars); empty when the model omitted it, in which case the frontend
// falls back to a generic subtitle.
type DiscoverRail struct {
	Title       string              `json:"title"`
	Description string              `json:"description,omitempty"`
	Items       []*models.MediaItem `json:"items"`
}

// AnchorRail is one "Because You Watched X" section: an anchor reference
// + items most similar to that anchor's embedding. Mirrors
// recommender.AnchorRail at the boundary.
type AnchorRail struct {
	Anchor *models.AnchorRef   `json:"anchor"`
	Items  []*models.MediaItem `json:"items"`
}

// EngagementRail is one Phase C signal-driven section (Trending Now, Hidden
// Gems, …). Mirrors recommender.EngagementRail at the boundary. Description is a
// fixed (non-LLM) theme line the frontend renders as the rail subtitle.
type EngagementRail struct {
	Title       string              `json:"title"`
	Description string              `json:"description,omitempty"`
	Items       []*models.MediaItem `json:"items"`
}

// HeroPick is the API-layer shape of a hero pool entry. Mirrors
// recommender.HeroPick at the boundary so internal types can evolve freely.
//
// Score is the global Aurora Score (0-100): how feature-worthy the title is,
// same for everyone. Match is the personal "% for you" (0-100) from the
// profile's taste-vector similarity; 0/omitted for the cold-start popular pool,
// where the frontend shows Score instead.
type HeroPick struct {
	Item              *models.MediaItem `json:"item"`
	Reason            string            `json:"reason,omitempty"`
	Score             int               `json:"score,omitempty"`
	Match             int               `json:"match,omitempty"`
	MatchConfidence   float64           `json:"match_confidence,omitempty"`
	MatchModelVersion string            `json:"match_model_version,omitempty"`
	MatchSimilarity   float64           `json:"-"`
	MatchEvidence     int               `json:"-"`
}

// HeroHandler serves the personalized "Featured" rail. When no provider is
// attached, the endpoint returns 503 and the frontend falls back to its
// existing top-rated/recent pool.
type HeroHandler struct {
	queries         *db.Queries
	hero            HeroProvider
	hub             HubBroadcaster
	builds          *discoverBuilds
	impressionSlots chan struct{}
}

func NewHeroHandler(queries *db.Queries) *HeroHandler {
	return &HeroHandler{
		queries: queries,
		builds: &discoverBuilds{
			inflight:  make(map[int64]bool),
			emptyTill: make(map[int64]time.Time),
		},
		impressionSlots: make(chan struct{}, recommendationImpressionConcurrency),
	}
}

// SetHeroProvider attaches the personalization backend. Pass nil (or never
// call this) to keep the endpoint unavailable.
func (h *HeroHandler) SetHeroProvider(p HeroProvider) {
	h.hero = p
}

// SetHub attaches the realtime hub so cold-path Discover builds notify the user
// (discover_ready) when their rails are ready. Optional — without it the
// endpoint still works; the client falls back to polling.
func (h *HeroHandler) SetHub(b HubBroadcaster) {
	h.hub = b
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

	// Personalization status — drives the UI's cold-start hint. When the
	// profile has fewer than the threshold of embedded watch_progress
	// rows, hero falls back to popular-unwatched (no LLM reasons, no
	// Discover rails). Without this signal the UI silently shows
	// non-personalized picks as if they were curated, which makes it
	// look like the LLM is broken when it's actually just waiting for
	// taste data.
	//
	// Failures are non-fatal — degrade to "history_count: 0" rather
	// than failing the whole response. The hero picks are the contract;
	// the personalization hint is gravy.
	historyCount, hcErr := h.queries.PersonalizationHistoryCount(r.Context(), profileID)
	if hcErr != nil {
		slog.Warn("hero: history count failed (non-fatal)", "profile", profileID, "error", hcErr)
	}
	threshold := db.PersonalizationThreshold()
	coldStart := historyCount < threshold
	slateToken := newRecommendationSlateToken()

	// Queue a best-effort snapshot of the slate selected for this successful API
	// response, including cache hits. Persistence is detached and tightly bounded
	// so analytics can never add database latency to the hero response. It is an
	// API-delivery proxy, not proof the browser painted or the viewer saw the row.
	impressions := make([]db.RecommendationImpression, 0, len(picks))
	for position, pick := range picks {
		if pick.Item == nil {
			continue
		}
		impressions = append(impressions, db.RecommendationImpression{
			MediaItemID: pick.Item.ID, Position: position,
			Match: pick.Match, Confidence: pick.MatchConfidence,
			ModelVersion: pick.MatchModelVersion, Similarity: pick.MatchSimilarity,
			Evidence: pick.MatchEvidence,
		})
	}
	select {
	case h.impressionSlots <- struct{}{}:
		go func() {
			defer func() { <-h.impressionSlots }()
			ictx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			defer cancel()
			if err := h.queries.RecordRecommendationImpressions(ictx, profileID, "hero", slateToken, impressions); err != nil {
				slog.Warn("hero: impression recording failed (non-fatal)", "profile", profileID, "error", err)
			}
		}()
	default:
		// Measurement is explicitly lossy under backpressure. Do not log here:
		// repeated traffic while the DB is degraded would create its own flood.
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"picks":       picks,
		"slate_token": slateToken,
		"personalization": map[string]any{
			"cold_start":    coldStart,
			"history_count": historyCount,
			"threshold":     threshold,
		},
	})
}

// Exposure records that one hero from a selected slate remained at least half
// visible in a foreground tab. It is intentionally separate from Get: an API
// response containing five rotating picks is not five user impressions.
func (h *HeroHandler) Exposure(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}
	var req struct {
		SlateToken  string `json:"slate_token"`
		MediaItemID int64  `json:"media_item_id"`
		Position    int    `json:"position"`
		VisibleMs   int    `json:"visible_ms"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.SlateToken) != 32 || req.MediaItemID <= 0 || req.Position < 0 || req.VisibleMs < 1500 || req.VisibleMs > 24*60*60*1000 {
		writeError(w, http.StatusBadRequest, "invalid exposure")
		return
	}
	updated, err := h.queries.MarkRecommendationVisible(r.Context(), profileID, req.SlateToken, req.MediaItemID, req.Position, req.VisibleMs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record exposure")
		return
	}
	if !updated {
		// The bounded async selection write may still be in flight. 202 tells the
		// browser a single delayed retry is worthwhile without treating lossy
		// analytics as a user-facing error.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
		h.clearDiscoverEmpty(profileID) // force a rebuild even if the last build was empty
	}

	// Fast path: warm cache → return the rails immediately with status "ready".
	if rails, ok := h.hero.DiscoverCached(profileID); ok {
		writeJSON(w, http.StatusOK, map[string]any{"rails": rails, "status": "ready"})
		return
	}

	// Cold path: the LLM build runs 60s+. Don't hold the request open (the
	// client's old deadline timed out and DISCARDED the slow result, which is
	// why rails only appeared after a refresh). Kick a detached background
	// build (deduped per profile) and tell the client we're building — it
	// splices the rails in when the discover_ready WS push lands (or via its
	// bounded poll fallback). WithoutCancel keeps request values (trace/auth)
	// but detaches from the request's cancellation so the build survives the
	// handler returning.
	status := h.kickDiscoverBuild(context.WithoutCancel(r.Context()), profileID, claims.UserID)
	writeJSON(w, http.StatusOK, map[string]any{"rails": []DiscoverRail{}, "status": status})
}

// kickDiscoverBuild ensures a background Discover build is running for the
// profile and returns the status to report: "building" when a build is (now)
// in flight, "empty" when the most recent build produced no rails and we're
// suppressing churn for discoverEmptyTTL. Safe to call concurrently.
func (h *HeroHandler) kickDiscoverBuild(ctx context.Context, profileID, userID int64) string {
	h.builds.mu.Lock()
	if h.builds.inflight[profileID] {
		h.builds.mu.Unlock()
		return "building"
	}
	if t, ok := h.builds.emptyTill[profileID]; ok {
		if time.Now().Before(t) {
			h.builds.mu.Unlock()
			return "empty"
		}
		delete(h.builds.emptyTill, profileID)
	}
	h.builds.inflight[profileID] = true
	h.builds.mu.Unlock()

	go func() {
		// DiscoverFor bounds its LLM calls internally (rerankBudget then
		// discoverBudget, sequenced inside the 90s flight ceiling) and is
		// singleflight-deduped, so concurrent waiters share one build.
		rails, err := h.hero.DiscoverFor(ctx, profileID)

		h.builds.mu.Lock()
		delete(h.builds.inflight, profileID)
		if err == nil && len(rails) == 0 {
			h.builds.emptyTill[profileID] = time.Now().Add(discoverEmptyTTL)
		}
		h.builds.mu.Unlock()

		if err != nil {
			slog.Warn("discover: background build failed", "profile", profileID, "error", err)
		}
		// Notify even on empty/error so the client stops waiting and re-fetches
		// the terminal state instead of polling to its cap. The re-fetch hits
		// the now-warm cache (or the empty-suppression window).
		if h.hub != nil {
			h.hub.BroadcastToUser(userID, ws.EventDiscoverReady,
				map[string]any{"profile_id": profileID})
		}
	}()
	return "building"
}

// clearDiscoverEmpty drops the empty-suppression window for a profile so a
// forced ?refresh=1 rebuilds even right after an empty build.
func (h *HeroHandler) clearDiscoverEmpty(profileID int64) {
	h.builds.mu.Lock()
	delete(h.builds.emptyTill, profileID)
	h.builds.mu.Unlock()
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

// EngagementRails returns the Phase C signal-driven rails (Trending Now / Hidden
// Gems / Finish It Tonight / Comfort Rewatch) for the active profile. No LLM —
// pure first-party engagement signals, so it's fast and works even when the
// Cloud LLM is down. Response shape: `{"rails": [{title, description, items}]}`.
// Empty array is fine — the UI hides any empty rail.
func (h *HeroHandler) EngagementRails(w http.ResponseWriter, r *http.Request) {
	if h.hero == nil {
		writeError(w, http.StatusServiceUnavailable, "engagement rails not configured")
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
	rails, err := h.hero.EngagementRailsFor(r.Context(), profileID)
	if err != nil {
		slog.Warn("engagement rails: fetch failed", "profile", profileID, "error", err)
		rails = nil
	}
	writeJSON(w, http.StatusOK, map[string]any{"rails": rails})
}

// Feedback records a profile's thumb on a title (Phase D steerable thumbs) and
// invalidates the profile's rec caches so the feed re-curates: 👍 ("up") feeds
// the taste vector — more like this; 👎 ("down") excludes the title from every
// recommendation surface — not interested; "clear" removes the thumb.
// Body: {"media_item_id": N, "direction": "up"|"down"|"clear"}. Returns 204.
func (h *HeroHandler) Feedback(w http.ResponseWriter, r *http.Request) {
	if h.hero == nil {
		writeError(w, http.StatusServiceUnavailable, "recommendations not configured")
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
	var req struct {
		MediaItemID int64  `json:"media_item_id"`
		Direction   string `json:"direction"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.MediaItemID <= 0 {
		writeError(w, http.StatusBadRequest, "media_item_id required")
		return
	}
	switch req.Direction {
	case "up", "down":
		if err := h.queries.RecordItemFeedback(r.Context(), profileID, req.MediaItemID, req.Direction); err != nil {
			// A positive-but-nonexistent id trips the media_items FK (23503):
			// that's a client error, not a server fault — surface 404, not 500.
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				writeError(w, http.StatusNotFound, "media item not found")
				return
			}
			slog.Warn("feedback: record failed", "profile", profileID, "item", req.MediaItemID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to record feedback")
			return
		}
	case "clear":
		if err := h.queries.DeleteItemFeedback(r.Context(), profileID, req.MediaItemID); err != nil {
			slog.Warn("feedback: clear failed", "profile", profileID, "item", req.MediaItemID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to clear feedback")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, "direction must be 'up', 'down', or 'clear'")
		return
	}
	// Re-curate live: drops hero/discover/engagement caches + bumps the epoch.
	// clearDiscoverEmpty mirrors ?refresh=1 (and SetRating): a thumb from a
	// cold profile shouldn't wait out discoverEmptyTTL for its first rails.
	h.hero.Invalidate(profileID)
	h.clearDiscoverEmpty(profileID)
	w.WriteHeader(http.StatusNoContent)
}

// SetRating records a profile's 1-5★ star rating on a title and invalidates
// the profile's rec caches so the feed re-curates: 4-5★ feeds the taste
// vector, 1-2★ excludes the title from every recommendation surface AND
// anti-anchors its neighbors in the LLM prompts, 3★ is neutral (stored +
// displayed only). stars=0 clears the rating.
// Body: {"media_item_id": N, "stars": 0-5}. Returns 204.
//
// Unlike Feedback, this deliberately does NOT 503 when the recommender is
// unattached: a star rating has standalone value (detail-page display, and
// it steers recommendations retroactively the moment personalization is
// enabled), so storage must work on an LLM-less install too.
func (h *HeroHandler) SetRating(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}
	var req struct {
		MediaItemID int64 `json:"media_item_id"`
		Stars       int   `json:"stars"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.MediaItemID <= 0 {
		writeError(w, http.StatusBadRequest, "media_item_id required")
		return
	}
	switch {
	case req.Stars >= 1 && req.Stars <= 5:
		if err := h.queries.SetUserRating(r.Context(), profileID, req.MediaItemID, req.Stars); err != nil {
			// A positive-but-nonexistent id trips the media_items FK (23503):
			// that's a client error, not a server fault — surface 404, not 500.
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				writeError(w, http.StatusNotFound, "media item not found")
				return
			}
			slog.Warn("rating: set failed", "profile", profileID, "item", req.MediaItemID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to record rating")
			return
		}
	case req.Stars == 0:
		if err := h.queries.DeleteUserRating(r.Context(), profileID, req.MediaItemID); err != nil {
			slog.Warn("rating: clear failed", "profile", profileID, "item", req.MediaItemID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to clear rating")
			return
		}
	default:
		writeError(w, http.StatusBadRequest, "stars must be 1-5, or 0 to clear")
		return
	}
	// Re-curate live: drops hero/discover/engagement caches + bumps the epoch.
	// Nil-guarded (see the handler doc): storage works without a recommender.
	// Also lift the Discover empty-suppression window (like ?refresh=1 does):
	// a cold profile bootstrapping its taste via ratings shouldn't wait out
	// discoverEmptyTTL to see its first rails.
	if h.hero != nil {
		h.hero.Invalidate(profileID)
		h.clearDiscoverEmpty(profileID)
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetRating returns the profile's own star rating for one title:
// {"media_item_id": N, "stars": 0-5} (0 = unrated). Drives the detail page's
// star widget initial state. ?media_item_id=N required; ?profile_id=N
// optional (validated), defaulting to the user's default profile like every
// other /api/me endpoint.
func (h *HeroHandler) GetRating(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	profileID, ok := h.resolveProfileID(w, r, claims.UserID)
	if !ok {
		return
	}
	mediaItemID, err := strconv.ParseInt(r.URL.Query().Get("media_item_id"), 10, 64)
	if err != nil || mediaItemID <= 0 {
		writeError(w, http.StatusBadRequest, "invalid media_item_id")
		return
	}
	stars, err := h.queries.GetUserRating(r.Context(), profileID, mediaItemID)
	if err != nil {
		slog.Warn("rating: get failed", "profile", profileID, "item", mediaItemID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load rating")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"media_item_id": mediaItemID,
		"stars":         stars,
	})
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
