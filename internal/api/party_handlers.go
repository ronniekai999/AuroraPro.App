package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/watchparty"
	"github.com/go-chi/chi/v5"
)

// ============================================================
// Party HTTP Handlers
// ============================================================

// PartyHandler handles REST endpoints for watch party management.
type PartyHandler struct {
	manager  *watchparty.Manager
	queries  *db.Queries
	activity *ActivityLogger
	// M8 — voice ICE servers. Plumbed through so /api/voice/ice-servers
	// can return the configured STUN + TURN to authenticated clients.
	// The frontend fetches once on voice-join rather than hardcoding
	// the URLs in the SPA — lets operators rotate TURN credentials
	// without redeploying static assets.
	stunServers    []string
	turnURL        string
	turnUsername   string
	turnCredential string
}

// NewPartyHandler creates a new PartyHandler with the given dependencies.
// M8 — voice ICE config is optional; pass empty slice / strings when not
// using TURN.
func NewPartyHandler(manager *watchparty.Manager, queries *db.Queries, activity *ActivityLogger, stunServers []string, turnURL, turnUsername, turnCredential string) *PartyHandler {
	return &PartyHandler{
		manager:        manager,
		queries:        queries,
		activity:       activity,
		stunServers:    stunServers,
		turnURL:        turnURL,
		turnUsername:   turnUsername,
		turnCredential: turnCredential,
	}
}

// IceServer is one entry in the WebRTC iceServers array. Mirrors the
// browser's RTCIceServer dict so the JSON shape passes through to
// RTCPeerConnection without remapping.
type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// GetIceServers handles GET /api/voice/ice-servers — returns the
// authenticated user's WebRTC ICE configuration (STUN + optional TURN).
// Auth-required because TURN credentials are sensitive; we don't want
// unauthenticated scrapers harvesting them.
//
// M8 future: rotate TURN credentials per-session (short-lived) by signing
// a (timestamp, username) tuple with a shared secret — coturn's
// `use-auth-secret` mode. For MVP we return a single long-term credential
// from config; document the rotation path in the handoff.
func (h *PartyHandler) GetIceServers(w http.ResponseWriter, r *http.Request) {
	out := struct {
		IceServers []IceServer `json:"ice_servers"`
	}{}
	if len(h.stunServers) > 0 {
		out.IceServers = append(out.IceServers, IceServer{URLs: h.stunServers})
	}
	if h.turnURL != "" {
		out.IceServers = append(out.IceServers, IceServer{
			URLs:       []string{h.turnURL},
			Username:   h.turnUsername,
			Credential: h.turnCredential,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// M9 — GetReactions returns the per-party reaction ring buffer (up to
// reactionsRingBufferMax=200 entries, FIFO). Used by the frontend
// timeline UI to paint seekbar dots: small markers at each reaction's
// abs_ms position. Auth-required because reactions are participant-
// scoped data; only people who can see the party should see who reacted
// when. Returns 404 if the party doesn't exist OR has no reactions yet
// (empty parties don't need a network round trip for an empty array;
// keep the response shape consistent).
func (h *PartyHandler) GetReactions(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	if code == "" {
		writeError(w, http.StatusBadRequest, "code required")
		return
	}
	// 2026-05-19 audit (API-H2) — gate on party membership before
	// returning the reaction stream. Previously any authenticated
	// user could read any party's reactions if they guessed the
	// 6-char code, exposing username + emoji + timestamp tuples to
	// non-participants. Admins are allowed through for incident
	// response / moderation use cases.
	claims := getClaimsFromRequest(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	if claims.Role != "admin" && !h.manager.IsParticipantOrHost(code, claims.UserID) {
		writeError(w, http.StatusNotFound, "party not found")
		return
	}
	reactions := h.manager.RecentReactions(code)
	if reactions == nil {
		// Distinguish "party not found" from "no reactions yet". The
		// manager returns nil for both. For UX we just return an empty
		// list rather than a 404 — the frontend's seekbar code paints
		// nothing for an empty list, which is the desired UI anyway.
		reactions = []watchparty.ReactionRecord{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"reactions": reactions,
		"count":     len(reactions),
	})
}

// M9 — ServeHighlightReel returns the cached MP4 highlight reel for the
// party. Generated asynchronously when the party ends (see manager.go's
// GenerateHighlightReel). Returns 404 if the reel doesn't exist yet or
// the party never accumulated enough reactions to justify one.
//
// File lives at <cacheDir>/party-highlights/<code>.mp4. The reaper
// (mirrors share-image's TTL pattern) keeps the cache bounded.
func (h *PartyHandler) ServeHighlightReel(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	if code == "" {
		writeError(w, http.StatusBadRequest, "code required")
		return
	}
	// 2026-05-19 audit (API-H3) — same membership gate as GetReactions.
	// The highlight reel MP4 is participant-scoped content; we don't
	// want code-guessing to expose it.
	claims := getClaimsFromRequest(r)
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	if claims.Role != "admin" && !h.manager.IsParticipantOrHost(code, claims.UserID) {
		writeError(w, http.StatusNotFound, "highlight reel not available")
		return
	}
	// File path is resolved on-disk; PartyHandler doesn't know the
	// cache dir directly. We'll set this up via a small accessor on the
	// PartyShareHandler pattern OR have manager expose the path.
	// For now, defer to manager which carries the cacheDir config.
	path, ok := h.manager.HighlightReelPath(code)
	if !ok || path == "" {
		writeError(w, http.StatusNotFound, "highlight reel not available")
		return
	}
	http.ServeFile(w, r, path)
}

// createPartyRequest is the expected JSON body for creating a party.
type createPartyRequest struct {
	MediaItemID     int64                `json:"media_item_id"`
	EpisodeID       *int64               `json:"episode_id,omitempty"`
	PartyName       string               `json:"party_name"`
	MaxParticipants int                  `json:"max_participants"`
	Settings        *createPartySettings `json:"settings,omitempty"`
	// InitialPositionMs is the host's resume offset into the source. The
	// server stores it as the party's canonical CurrentTimeMs so every
	// participant's HLS gets transcoded from the same source second —
	// without this, each peer's per-user resume becomes their FFmpeg
	// start_sec and HLS time 0 means a different absolute position on
	// each client, breaking sync entirely.
	InitialPositionMs *int64 `json:"initial_position_ms,omitempty"`
	// ScheduledStartAt schedules a future start. When non-nil and in the
	// future, the party doesn't auto-play on join — the server fires
	// "party-starting" at this moment to all connected clients. RFC 3339
	// timestamp. Omit (or pass null) for the legacy "play immediately"
	// behavior. Future-tense validation lives in the handler.
	ScheduledStartAt *time.Time `json:"scheduled_start_at,omitempty"`
}

// schedulePartyRequest is the JSON body for POST /api/parties/{code}/schedule.
// scheduled_start_at = null clears the existing schedule. A non-null value
// must be in the future.
type schedulePartyRequest struct {
	ScheduledStartAt *time.Time `json:"scheduled_start_at"`
}

type createPartySettings struct {
	AllowPause bool `json:"allow_pause"`
	AllowChat  bool `json:"allow_chat"`
}

// Create handles POST /api/parties -- creates a new watch party.
func (h *PartyHandler) Create(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req createPartyRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate required fields
	if req.MediaItemID <= 0 {
		writeError(w, http.StatusBadRequest, "media_item_id is required")
		return
	}
	if req.PartyName == "" {
		req.PartyName = claims.Username + "'s Party"
	}
	if len(req.PartyName) > 100 {
		writeError(w, http.StatusBadRequest, "party_name too long (max 100 characters)")
		return
	}

	// Verify media item exists
	item, err := h.queries.GetMediaItem(r.Context(), req.MediaItemID)
	if err != nil || item == nil {
		writeError(w, http.StatusNotFound, "media item not found")
		return
	}

	// Build settings
	settings := watchparty.PartySettings{
		AllowPause: true, // default
		AllowChat:  true, // default
	}
	if req.Settings != nil {
		settings.AllowPause = req.Settings.AllowPause
		settings.AllowChat = req.Settings.AllowChat
	}

	maxP := req.MaxParticipants
	if maxP <= 0 {
		maxP = 10
	}

	// Get media title and poster for display
	mediaTitle := item.Title
	mediaPoster := item.PosterPath

	var initPos int64
	if req.InitialPositionMs != nil && *req.InitialPositionMs > 0 {
		initPos = *req.InitialPositionMs
	}

	// Validate scheduled_start_at if provided: must be in the future. A 1s
	// grace prevents legitimate "schedule for ~now" being rejected by clock
	// skew between client and server, while still rejecting clearly-past
	// timestamps from buggy clients or stale tabs.
	if req.ScheduledStartAt != nil {
		if req.ScheduledStartAt.Before(time.Now().Add(-1 * time.Second)) {
			writeError(w, http.StatusBadRequest, "scheduled_start_at must be in the future")
			return
		}
	}

	ps, err := h.manager.CreateParty(
		r.Context(),
		claims.UserID,
		claims.Username,
		req.MediaItemID,
		req.EpisodeID,
		req.PartyName,
		mediaTitle,
		mediaPoster,
		maxP,
		settings,
		initPos,
		req.ScheduledStartAt,
	)
	if err != nil {
		slog.Warn("failed to create party", "error", err, "user_id", claims.UserID)
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	// Log activity
	if h.activity != nil {
		h.activity.log(r.Context(), &models.ActivityEntry{
			UserID:    &claims.UserID,
			EventType: "party_created",
			Details: map[string]interface{}{
				"code":        ps.Code,
				"party_name":  ps.PartyName,
				"media_title": ps.MediaTitle,
			},
		})
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"code":               ps.Code,
		"party_name":         ps.PartyName,
		"host_user_id":       ps.HostUserID,
		"media_item_id":      ps.MediaItemID,
		"episode_id":         ps.EpisodeID,
		"media_title":        ps.MediaTitle,
		"media_poster":       ps.MediaPoster,
		"max_participants":   ps.MaxParticipants,
		"scheduled_start_at": ps.ScheduledStartAt,
		"started_at":         ps.StartedAt,
		"settings": map[string]interface{}{
			"allow_pause": ps.Settings.AllowPause,
			"allow_chat":  ps.Settings.AllowChat,
		},
		"created_at": ps.CreatedAt,
	})
}

// Schedule handles POST /api/parties/{code}/schedule -- updates (or clears)
// the scheduled start time for a party. Host-only.
//
// Body: {"scheduled_start_at": "2026-05-14T20:00:00Z"} sets the schedule.
// Body: {"scheduled_start_at": null} clears the schedule.
//
// Returns the same shape as Create's response for client convenience.
func (h *PartyHandler) Schedule(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	code := chi.URLParam(r, "code")
	if code == "" || len(code) != 6 {
		writeError(w, http.StatusBadRequest, "invalid party code")
		return
	}

	var req schedulePartyRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate future-tense for non-nil schedules (1s grace for clock skew).
	if req.ScheduledStartAt != nil && req.ScheduledStartAt.Before(time.Now().Add(-1*time.Second)) {
		writeError(w, http.StatusBadRequest, "scheduled_start_at must be in the future")
		return
	}

	// Host authorization. The manager doesn't enforce host-only on
	// SchedulePartyStart by design — the API layer is the only entry point
	// and is the right place to check JWT claims. Reach into the live state
	// just to compare host_user_id; if there's no live state, the party is
	// either ended or never existed.
	ps := h.manager.GetPartyState(code)
	if ps == nil {
		writeError(w, http.StatusNotFound, "party not found or has ended")
		return
	}
	ps.Lock()
	isHost := ps.HostUserID == claims.UserID
	ps.Unlock()
	if !isHost {
		writeError(w, http.StatusForbidden, "only the host can reschedule the party")
		return
	}

	if err := h.manager.SchedulePartyStart(r.Context(), code, req.ScheduledStartAt); err != nil {
		slog.Warn("schedule party failed", "code", code, "error", err)
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Re-fetch the live state for the response. The schedule was just
	// applied; this read picks up the new value.
	ps.Lock()
	scheduled := ps.ScheduledStartAt
	started := ps.StartedAt
	ps.Unlock()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code":               code,
		"scheduled_start_at": scheduled,
		"started_at":         started,
	})
}

// GetInfo handles GET /api/parties/{code} -- returns party info.
// If the party is active, returns live state from the manager.
// If ended, falls back to the DB record.
func (h *PartyHandler) GetInfo(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	if code == "" || len(code) != 6 {
		writeError(w, http.StatusBadRequest, "invalid party code")
		return
	}

	// Try live state first
	ps := h.manager.GetPartyState(code)
	if ps != nil {
		// 2026-05-29 MED-integration fix (finding 3): the participant
		// roster (user_id + username of every member) is participant-
		// scoped data. Previously buildLivePartyResponse returned it to
		// ANY authenticated user who knew the 6-char code, leaking the
		// guest list to non-members. Gate the roster on membership
		// (mirrors the GetReactions / ServeHighlightReel pattern): only
		// participants, the host, or an admin receive the named list.
		// Non-members still get participant_count (same as the
		// unauthenticated buildPublicPartyResponse already exposes) so the
		// join UI can show "N people watching" without naming them.
		includeRoster := false
		claims := getClaimsFromRequest(r)
		if claims != nil &&
			(claims.Role == "admin" || h.manager.IsParticipantOrHost(code, claims.UserID)) {
			includeRoster = true
		}
		// Build response under the party-level lock
		resp := h.buildLivePartyResponse(ps, includeRoster)
		writeJSON(w, http.StatusOK, resp)
		return
	}

	// Fall back to DB for ended parties
	party, err := h.queries.GetWatchPartyByCodeAny(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get party info")
		return
	}
	if party == nil {
		writeError(w, http.StatusNotFound, "party not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"code":             party.PartyCode,
		"party_name":       party.PartyName,
		"host_user_id":     party.HostUserID,
		"media_item_id":    party.MediaItemID,
		"episode_id":       party.EpisodeID,
		"media_title":      party.MediaTitle,
		"media_poster":     party.MediaPoster,
		"is_active":        party.IsActive,
		"max_participants": party.MaxParticipants,
		"created_at":       party.CreatedAt,
		"ended_at":         party.EndedAt,
	})
}

// GetCodeInfo handles GET /api/code/{code}/info — unified lookup for the
// magic-link landing UX. Returns:
//
//	{ type: "active", party: {...} }      — there's a live party; client joins it
//	{ type: "offline_room", room: {...} } — code maps to a persistent room
//	                                         with no active session; client
//	                                         shows "Room offline" state
//	404                                    — code matches neither a live
//	                                         party nor a live persistent room
//
// Used by joinParty's pre-flight check (M4) so the frontend can show a
// friendly "host hasn't started a session yet" message instead of an
// opaque "party not found" toast when a friend taps a bookmarked
// persistent-room code outside a movie night.
//
// Unauthenticated-friendly: no auth requirement so the magic-link landing
// page can render basic info before the user logs in. Doesn't leak
// anything sensitive (just the code + name a friend already has from the
// shared link).
func (h *PartyHandler) GetCodeInfo(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	if code == "" || len(code) != 6 {
		writeError(w, http.StatusBadRequest, "invalid code")
		return
	}

	// Live party wins — even if there's also a persistent room (which
	// would be the case during an active session in that room), the
	// client should join the active party.
	//
	// SECURITY: this endpoint is UNAUTHENTICATED so the magic-link
	// landing page can render before login. Only expose what the
	// public share image already shows (party name, media metadata,
	// scheduled times, code) — NOT the participant list. Knowing the
	// code shouldn't leak the guest list to strangers who haven't
	// authenticated. Use buildPublicPartyResponse instead of the full
	// buildLivePartyResponse.
	ps := h.manager.GetPartyState(code)
	if ps != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"type":  "active",
			"party": h.buildPublicPartyResponse(ps),
		})
		return
	}

	// No active party. Check whether a persistent room owns this code.
	room, err := h.queries.GetRoomByCode(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lookup code")
		return
	}
	if room != nil && room.IsPersistent {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"type": "offline_room",
			"room": map[string]interface{}{
				"code":           room.Code,
				"name":           room.Name,
				"owner_user_id":  room.OwnerUserID,
				"created_at":     room.CreatedAt,
				"last_active_at": room.LastActiveAt,
			},
		})
		return
	}

	// Neither active party nor persistent room with this code.
	writeError(w, http.StatusNotFound, "code not found")
}

// buildPublicPartyResponse builds an UNAUTHENTICATED-safe subset of party
// info for the magic-link landing page (GetCodeInfo). Includes only what
// the public share image already exposes: party name, media metadata,
// scheduled times, host's user_id. Specifically EXCLUDES the participant
// list, chat history, and playback position — knowing a 6-char code
// shouldn't leak the guest list to unauthenticated strangers.
func (h *PartyHandler) buildPublicPartyResponse(ps *watchparty.PartyState) map[string]interface{} {
	ps.Lock()
	defer ps.Unlock()
	return map[string]interface{}{
		"code":               ps.Code,
		"party_name":         ps.PartyName,
		"host_user_id":       ps.HostUserID,
		"media_item_id":      ps.MediaItemID,
		"episode_id":         ps.EpisodeID,
		"media_title":        ps.MediaTitle,
		"media_poster":       ps.MediaPoster,
		"is_active":          true,
		"participant_count":  len(ps.Participants),
		"max_participants":   ps.MaxParticipants,
		"scheduled_start_at": ps.ScheduledStartAt,
		"started_at":         ps.StartedAt,
	}
}

// buildLivePartyResponse locks the party and builds a JSON-friendly response map.
//
// includeRoster gates the named participant list (user_id + username of every
// member). Pass true only for members/host/admin — see finding 3 in GetInfo.
// When false, the "participants" key is omitted entirely; callers still get
// "participant_count" so the join UI can show a headcount without names.
func (h *PartyHandler) buildLivePartyResponse(ps *watchparty.PartyState, includeRoster bool) map[string]interface{} {
	ps.Lock()
	defer ps.Unlock()

	resp := map[string]interface{}{
		"code":            ps.Code,
		"party_name":      ps.PartyName,
		"host_user_id":    ps.HostUserID,
		"media_item_id":   ps.MediaItemID,
		"episode_id":      ps.EpisodeID,
		"media_title":     ps.MediaTitle,
		"media_poster":    ps.MediaPoster,
		"current_time_ms": ps.CurrentTimeMs,
		// 2026-05-25 — V3 OR (same contract as BuildPartyStateMessage /
		// ActiveParties). The pre-join detail endpoint was showing
		// V3-only parties as paused, so the join UI claimed "Host is
		// paused" even when actively playing.
		"is_playing":         ps.IsPlaying || ps.Running,
		"is_active":          true,
		"participant_count":  len(ps.Participants),
		"max_participants":   ps.MaxParticipants,
		"scheduled_start_at": ps.ScheduledStartAt,
		"started_at":         ps.StartedAt,
		"server_now_ms":      time.Now().UnixMilli(),
		"settings": map[string]interface{}{
			"allow_pause": ps.Settings.AllowPause,
			"allow_chat":  ps.Settings.AllowChat,
		},
		"created_at": ps.CreatedAt,
	}

	// Only members/host/admin get the named roster (finding 3).
	if includeRoster {
		participants := make([]map[string]interface{}, 0, len(ps.Participants))
		for _, p := range ps.Participants {
			participants = append(participants, map[string]interface{}{
				"user_id":      p.UserID,
				"username":     p.Username,
				"is_host":      p.IsHost,
				"is_buffering": p.IsBuffering,
			})
		}
		resp["participants"] = participants
	}

	return resp
}

// End handles POST /api/parties/{code}/end -- ends a party (host only).
func (h *PartyHandler) End(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	code := chi.URLParam(r, "code")
	if code == "" || len(code) != 6 {
		writeError(w, http.StatusBadRequest, "invalid party code")
		return
	}

	if err := h.manager.EndParty(code, claims.UserID); err != nil {
		slog.Warn("failed to end party", "code", code, "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	// Log activity
	if h.activity != nil {
		h.activity.log(r.Context(), &models.ActivityEntry{
			UserID:    &claims.UserID,
			EventType: "party_ended",
			Details: map[string]interface{}{
				"code": code,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ended"})
}

// ListActive handles GET /api/parties/active -- returns active parties visible to the user.
func (h *PartyHandler) ListActive(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	// Return live state from the manager (more up-to-date than DB)
	parties := h.manager.ActiveParties()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"parties": parties,
		"total":   len(parties),
	})
}
