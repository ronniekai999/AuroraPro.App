package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	ws "github.com/aurora-media/aurora/internal/websocket"
)

// Changing a library's type (issue #510).
//
// Two endpoints on purpose. The preview is read-only and answers "what would
// this destroy"; the confirm echoes back the number it was shown and is refused
// if the catalog has moved since. A single destructive PUT on the library —
// which is what "just let Update change the type" would have been — gives an
// admin no way to see the cost before paying it, and this costs watch progress,
// watchlist entries and ratings for every title in the library.
//
// It is NOT folded into LibraryHandler.Update for the same reason: a field edit
// beside "name" reads like a field edit. This is a purge.

// RetypeRequest is the confirm call's body.
type RetypeRequest struct {
	Type string `json:"type"`
	// ExpectedItems is the count the preview returned. Required, and echoed so
	// the server can refuse a stale confirmation rather than delete a number of
	// rows nobody approved. Zero is a legitimate value (nothing to purge), so it
	// cannot double as "unset" — the field is a pointer.
	ExpectedItems *int64 `json:"expected_items"`
}

// validateRetypeRequest is the whole gate in front of a catalog purge, kept as a
// pure function so it can be tested without a database or a scanner — a case
// that needed either to be rejected would be a case this gate does not cover.
//
// Returns the parsed target, the approved count, and a reason to refuse ("" to
// proceed). The reason is user-facing and says what to send instead: an admin
// who gets a bare 400 here has no way to tell a typo from a stale preview.
func validateRetypeRequest(req RetypeRequest) (models.LibraryType, int64, string) {
	target, ok := parseLibraryType(req.Type)
	if !ok {
		return "", 0, `type must be "movie" or "show"`
	}
	// Required rather than defaulted, and a POINTER rather than an int64,
	// because 0 is a legitimate approval — a library already entirely of the
	// target type has nothing to purge. With a plain int64 an omitted field and
	// an approved zero are the same value, so a request that forgot the
	// interlock would read as one that approved deleting nothing... and then
	// delete whatever happened to be there. That is the exact failure this
	// endpoint exists to make impossible.
	if req.ExpectedItems == nil {
		return "", 0, "expected_items is required; call the preview endpoint first and echo its items_to_delete"
	}
	if *req.ExpectedItems < 0 {
		return "", 0, "expected_items must not be negative"
	}
	return target, *req.ExpectedItems, ""
}

func parseLibraryType(raw string) (models.LibraryType, bool) {
	switch models.LibraryType(strings.TrimSpace(raw)) {
	case models.LibraryMovies:
		return models.LibraryMovies, true
	case models.LibraryShows:
		return models.LibraryShows, true
	}
	return "", false
}

// RetypePreview answers what POST .../retype would delete. Read-only.
func (h *LibraryHandler) RetypePreview(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid library id")
		return
	}
	target, ok := parseLibraryType(r.URL.Query().Get("type"))
	if !ok {
		writeError(w, http.StatusBadRequest, `type must be "movie" or "show"`)
		return
	}

	preview, err := h.queries.PreviewLibraryRetype(r.Context(), id, target)
	if err != nil {
		slog.Error("retype preview failed", "library_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to preview retype")
		return
	}
	if preview == nil {
		writeError(w, http.StatusNotFound, "library not found")
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

// Retype purges every media item of the wrong type, sets the new type, and
// rescans. Destructive and irreversible.
func (h *LibraryHandler) Retype(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid library id")
		return
	}
	var req RetypeRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	target, expected, reason := validateRetypeRequest(req)
	if reason != "" {
		writeError(w, http.StatusBadRequest, reason)
		return
	}

	lib, err := h.queries.GetLibrary(r.Context(), id)
	if err != nil || lib == nil {
		writeError(w, http.StatusNotFound, "library not found")
		return
	}

	// Claim the scan slot BEFORE touching anything. A scan running through the
	// purge would be writing rows into the library as they are deleted and would
	// then keep walking it under the old parser; the claim is also what the
	// rescan below runs on, so the library is never unlocked between the two.
	if !h.scanner.TryStartScan(lib.ID) {
		writeError(w, http.StatusConflict, "a scan is in progress for this library; wait for it to finish")
		return
	}
	slotUsed := false
	defer func() {
		if !slotUsed {
			h.scanner.ReleaseScanSlot(lib.ID)
		}
	}()

	deleted, err := h.queries.RetypeLibrary(r.Context(), lib.ID, target, expected)
	if err != nil {
		var mismatch *db.ErrRetypeCountMismatch
		if errors.As(err, &mismatch) {
			writeError(w, http.StatusConflict, mismatch.Error()+" — re-run the preview and confirm the new figure")
			return
		}
		slog.Error("retype failed", "library_id", lib.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to change library type")
		return
	}

	if h.activity != nil {
		claims := auth.GetClaims(r.Context())
		h.activity.LogLibraryRetyped(r.Context(), claims.UserID, lib.ID, lib.Name,
			string(lib.Type), string(target), deleted)
	}
	slog.Warn("library type changed; catalog rows purged",
		"library", lib.Name, "library_id", lib.ID,
		"from", lib.Type, "to", target, "items_deleted", deleted)

	// Rescan on the slot already held, so nothing can start a scan of the old
	// shape in between. The library value carries the NEW type because that is
	// what the scanner branches on.
	rescan := *lib
	rescan.Type = target
	slotUsed = true
	go func() {
		ctx := h.scanContext()
		_ = h.scanner.ScanLibrary(ctx, &rescan, func(p *models.ScanProgress) {
			h.hub.Broadcast(ws.EventScanProgress, p)
		})
	}()

	writeJSON(w, http.StatusOK, map[string]any{
		"library_id":    lib.ID,
		"type":          target,
		"items_deleted": deleted,
		"rescanning":    true,
	})
}
