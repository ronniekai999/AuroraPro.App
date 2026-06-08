package api

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
)

// NotificationHandler serves the per-user in-app notification feed that backs the
// bell badge and Notifications panel. It is the durable source of truth the SPA
// reads on load and reconnect — the WebSocket 'notification' event is best-effort
// live delivery layered on top (the hub does not persist or replay).
type NotificationHandler struct {
	queries *db.Queries
}

// NewNotificationHandler wires the handler to the shared query layer.
func NewNotificationHandler(queries *db.Queries) *NotificationHandler {
	return &NotificationHandler{queries: queries}
}

// List returns the caller's most-recent notifications plus the current unread
// count (for the bell badge), scoped to the authenticated user.
// GET /api/me/notifications
func (h *NotificationHandler) List(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	items, err := h.queries.ListNotificationsForUser(r.Context(), claims.UserID, 50)
	if err != nil {
		slog.Error("failed to list notifications", "error", err, "user_id", claims.UserID)
		writeError(w, http.StatusInternalServerError, "failed to load notifications")
		return
	}
	if items == nil {
		items = []*models.Notification{}
	}

	unread, err := h.queries.CountUnreadNotifications(r.Context(), claims.UserID)
	if err != nil {
		slog.Error("failed to count unread notifications", "error", err, "user_id", claims.UserID)
		writeError(w, http.StatusInternalServerError, "failed to load notifications")
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"notifications": items,
		"unread":        unread,
	})
}

// MarkRead marks a single notification read. Ownership-scoped: the query only
// touches a row that belongs to the caller, so it cleanly no-ops for someone
// else's id or an already-read row.
// POST /api/me/notifications/{id}/read
func (h *NotificationHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid notification id")
		return
	}

	if err := h.queries.MarkNotificationRead(r.Context(), id, claims.UserID); err != nil {
		slog.Error("failed to mark notification read", "error", err, "id", id, "user_id", claims.UserID)
		writeError(w, http.StatusInternalServerError, "failed to mark read")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// MarkAllRead marks all of the caller's unread notifications read (panel "mark
// all read" / clearing the badge).
// POST /api/me/notifications/read-all
func (h *NotificationHandler) MarkAllRead(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	if err := h.queries.MarkAllNotificationsRead(r.Context(), claims.UserID); err != nil {
		slog.Error("failed to mark all notifications read", "error", err, "user_id", claims.UserID)
		writeError(w, http.StatusInternalServerError, "failed to mark all read")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
