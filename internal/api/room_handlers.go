package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/watchparty"
	"github.com/go-chi/chi/v5"
)

// ============================================================
// Room HTTP Handlers (M3 — persistent rooms)
// ============================================================
//
// Rooms are long-lived join targets. A "quick party" still uses the
// existing POST /api/parties endpoint (which creates an implicit non-
// persistent room). These endpoints are for the new persistent-room
// lifecycle:
//
//   POST   /api/rooms              — create a persistent room (no party)
//   GET    /api/rooms              — list caller's rooms
//   DELETE /api/rooms/{id}         — soft-delete a room (owner-only)
//   POST   /api/rooms/{id}/parties — start a party in an existing room

// RoomHandler handles REST endpoints for persistent room management.
// Mirrors PartyHandler's dependency shape so the wiring in router.go is
// uniform.
type RoomHandler struct {
	manager  *watchparty.Manager
	queries  *db.Queries
	activity *ActivityLogger
}

// NewRoomHandler creates a new RoomHandler with the given dependencies.
func NewRoomHandler(manager *watchparty.Manager, queries *db.Queries, activity *ActivityLogger) *RoomHandler {
	return &RoomHandler{
		manager:  manager,
		queries:  queries,
		activity: activity,
	}
}

// createRoomRequest is the JSON body for POST /api/rooms.
type createRoomRequest struct {
	Name     string               `json:"name"`
	Settings *createPartySettings `json:"settings,omitempty"`
}

// startPartyInRoomRequest is the JSON body for POST /api/rooms/{id}/parties.
// Mirrors createPartyRequest but without a name (the room's name applies)
// or max_participants (room settings apply).
type startPartyInRoomRequest struct {
	MediaItemID       int64      `json:"media_item_id"`
	EpisodeID         *int64     `json:"episode_id,omitempty"`
	InitialPositionMs *int64     `json:"initial_position_ms,omitempty"`
	ScheduledStartAt  *time.Time `json:"scheduled_start_at,omitempty"`
	MediaTitle        string     `json:"media_title"`
	MediaPoster       string     `json:"media_poster"`
}

// Create handles POST /api/rooms — creates a persistent room with no
// initial party. Friends can bookmark the room's code; the owner starts
// parties in it via POST /api/rooms/{id}/parties.
func (h *RoomHandler) Create(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req createRoomRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "room name is required")
		return
	}
	if len(req.Name) > 200 {
		writeError(w, http.StatusBadRequest, "room name too long (max 200 chars)")
		return
	}

	settings := watchparty.PartySettings{
		AllowPause: true, // sensible default; owner can adjust later
		AllowChat:  true,
	}
	if req.Settings != nil {
		settings.AllowPause = req.Settings.AllowPause
		settings.AllowChat = req.Settings.AllowChat
	}

	room, err := h.manager.CreatePersistentRoom(r.Context(), claims.UserID, req.Name, settings)
	if err != nil {
		slog.Error("create room failed", "error", err, "owner_user_id", claims.UserID)
		writeError(w, http.StatusInternalServerError, "failed to create room")
		return
	}

	// Activity log: ActivityLogger doesn't have a LogPartyCreated helper
	// today; if/when one is added, instrument here. For now the slog.Info
	// inside manager.CreatePersistentRoom is the audit trail.
	writeJSON(w, http.StatusCreated, room)
}

// List handles GET /api/rooms — returns the caller's live rooms ordered
// by most-recently-active first. Includes ALL rooms the user owns (both
// persistent and any in-flight quick-party rooms); the frontend filters
// further if it only wants the persistent ones for a "My Rooms" UI.
func (h *RoomHandler) List(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	rooms, err := h.manager.ListUserRooms(r.Context(), claims.UserID)
	if err != nil {
		slog.Error("list rooms failed", "error", err, "user_id", claims.UserID)
		writeError(w, http.StatusInternalServerError, "failed to list rooms")
		return
	}
	if rooms == nil {
		// Return [] not null so the frontend's .map / .length work
		// uniformly across "user has no rooms" vs "user has rooms".
		rooms = []*models.WatchPartyRoom{}
	}
	writeJSON(w, http.StatusOK, rooms)
}

// Delete handles DELETE /api/rooms/{id} — soft-deletes a persistent room.
// If a party is currently active, it's ended first (party-ended broadcast,
// socket close). Owner-only; the manager re-checks ownership.
func (h *RoomHandler) Delete(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid room id")
		return
	}

	if err := h.manager.DeleteRoom(r.Context(), claims.UserID, id); err != nil {
		// Distinguish 404 (not found) from 403 (ownership) for clearer
		// client UX. "not found" is a common case (race with another
		// tab), "only the room owner" is rarer and worth its own status.
		if err.Error() == "room not found" {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		if err.Error() == "only the room owner can delete this room" {
			writeError(w, http.StatusForbidden, err.Error())
			return
		}
		slog.Error("delete room failed", "error", err, "user_id", claims.UserID, "room_id", id)
		writeError(w, http.StatusInternalServerError, "failed to delete room")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// StartParty handles POST /api/rooms/{id}/parties — starts a new party
// session in an existing persistent room, reusing the room's code. The
// room owner is the host.
func (h *RoomHandler) StartParty(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid room id")
		return
	}

	var req startPartyInRoomRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.MediaItemID <= 0 {
		writeError(w, http.StatusBadRequest, "media_item_id required")
		return
	}

	// Lookup the room to get its code + verify ownership BEFORE delegating
	// to the manager, so we can return crisp 404 / 403 here rather than
	// fishing them out of error strings later.
	room, err := h.queries.GetRoomByID(r.Context(), id)
	if err != nil {
		slog.Error("start party: lookup room failed", "error", err, "room_id", id)
		writeError(w, http.StatusInternalServerError, "failed to lookup room")
		return
	}
	if room == nil {
		writeError(w, http.StatusNotFound, "room not found")
		return
	}
	if room.OwnerUserID != claims.UserID {
		writeError(w, http.StatusForbidden, "only the room owner can start a party here")
		return
	}

	// If a scheduled start was provided, validate it's in the future.
	if req.ScheduledStartAt != nil && !req.ScheduledStartAt.After(time.Now()) {
		writeError(w, http.StatusBadRequest, "scheduled_start_at must be in the future")
		return
	}

	initialPos := int64(0)
	if req.InitialPositionMs != nil {
		initialPos = *req.InitialPositionMs
	}

	// Use the persistent room's stored settings — the room owns them, so
	// SpoilerFreeStart, AllowPause, AllowChat configured at room-create
	// time propagate to every session started in the room. Previously this
	// hard-coded {AllowPause:true, AllowChat:true} and silently dropped
	// the room's settings; deep-debugger May 2026 caught the regression.
	settings := watchparty.PartySettings{AllowPause: true, AllowChat: true}
	if room.SettingsJSON != "" {
		// Best-effort unmarshal — if the JSON is malformed (shouldn't
		// happen, but defensive), fall back to the sensible defaults
		// above rather than failing the whole session-start request.
		if err := json.Unmarshal([]byte(room.SettingsJSON), &settings); err != nil {
			slog.Warn("start party in room: failed to parse room settings, using defaults",
				"room_id", id, "error", err)
		}
	}

	ps, err := h.manager.StartPartyInRoom(
		r.Context(),
		room.Code,
		claims.UserID,
		claims.Username,
		req.MediaItemID,
		req.EpisodeID,
		req.MediaTitle,
		req.MediaPoster,
		settings.MaxParticipants,
		settings,
		initialPos,
		req.ScheduledStartAt,
	)
	if err != nil {
		if err.Error() == "a party is already active in this room" {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		slog.Error("start party in room failed", "error", err, "room_id", id)
		writeError(w, http.StatusInternalServerError, "failed to start party")
		return
	}

	// Activity-log audit trail piggybacks on manager.StartPartyInRoom's
	// slog.Info — see note in Create above for adding LogPartyCreated.

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"code":          ps.Code,
		"room_id":       id,
		"media_item_id": req.MediaItemID,
		"episode_id":    req.EpisodeID,
	})
}
