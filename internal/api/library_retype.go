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
	"github.com/aurora-media/aurora/internal/library"
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

	// The purge runs on the SERVER-lifecycle context, not the request's.
	//
	// The route carries middleware.Timeout(60s), which cancels r.Context(). A
	// DELETE cascading across the whole closure scales with library size, and a
	// cancellation racing Commit is ambiguous: the handler would answer 500
	// while the purge may have landed, leaving slotUsed false — so no rescan —
	// on the one endpoint in the repo with no undo. Moving the multi-minute
	// watcher walk off this route last round did not cover the DELETE, which is
	// the part that actually scales. It still ends at shutdown, so this is not
	// context.Background().
	deleted, err := h.queries.RetypeLibrary(h.scanContext(), lib.ID, target, expected)
	if err != nil {
		if errors.Is(err, db.ErrLibraryGone) {
			writeError(w, http.StatusNotFound, "library not found")
			return
		}
		var mismatch *db.ErrRetypeCountMismatch
		if errors.As(err, &mismatch) {
			writeError(w, http.StatusConflict, mismatch.Error()+" — re-run the preview and confirm the new figure")
			return
		}
		slog.Error("retype failed", "library_id", lib.ID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to change library type")
		return
	}

	// Guarded like MediaHandler.DeleteItem's. A panic here lands AFTER the purge
	// has committed and BEFORE the rescan is launched: a purged catalog, no
	// rescan, and a watcher still holding the old type. (The scan slot itself is
	// fine — the defer above runs during unwinding; an earlier version of this
	// comment claimed otherwise.)
	if claims := auth.GetClaims(r.Context()); h.activity != nil && claims != nil {
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

		// Re-point the WATCHER at the new value, before the rescan and OFF the
		// request path.
		//
		// Why it must happen at all: Watcher.WatchLibrary stores the
		// *models.Library it is handed as a SNAPSHOT, and it is only ever called
		// at boot and on library creation — so the periodic tick and the
		// fsnotify debounce go on passing the pre-retype value to ScanLibrary,
		// which branches on lib.Type rather than re-reading the database.
		// Without this the first file event after a retype re-scans under the
		// OLD parser and re-creates the phantom state this operation exists to
		// remove. A review demonstrated that end to end.
		//
		// Why it must NOT happen inline: WatchLibrary calls addDirRecursive
		// (filepath.WalkDir) over every library path, which takes minutes on a
		// large tree — LibraryHandler.Create carries the post-mortem comment for
		// exactly that, having caused 504s. Doing it in the handler put a
		// multi-minute walk AFTER a committed purge on a 60s-timeout route, so
		// the most destructive endpoint in the repo could report a gateway
		// failure for an operation that had already deleted the catalog. Same
		// ordering as Create now: goroutine first, walk inside it.
		// A concurrent Delete unwatches and then removes the library; without
		// this check the re-point below would re-install a watch for a row that
		// no longer exists, and periodicScanLoop would scan a deleted library
		// every interval for the life of the process.
		if still, err := h.queries.GetLibrary(ctx, rescan.ID); err != nil || still == nil {
			slog.Info("library disappeared during retype; skipping re-watch and rescan",
				"library_id", rescan.ID)
			return
		}

		if h.watcher != nil {
			// WatchLibrary now installs the entry even when file-event watching
			// cannot start, so the library keeps its periodic tick with the
			// CURRENT value. That is the whole point of the sentinel: an earlier
			// version dropped the watch on failure, which also dropped the
			// library out of periodic scanning — worse than documented, and
			// exactly the case where the rescan below is most likely to have
			// failed too.
			err := h.watcher.WatchLibrary(ctx, &rescan)
			switch {
			case errors.Is(err, library.ErrFSWatchUnavailable):
				slog.Warn("library retyped; file-event watching unavailable, periodic scans still cover it",
					"library", rescan.Name, "library_id", rescan.ID, "error", err)
			case err != nil:
				slog.Error("library retyped but re-watching failed",
					"library", rescan.Name, "library_id", rescan.ID, "error", err)
			}
			h.watcher.NoteExternalScan(rescan.ID)
		}

		if h.onRescanProgressForTest != nil {
			h.onRescanProgressForTest()
		}
		_ = h.scanner.ScanLibrary(ctx, &rescan, func(p *models.ScanProgress) {
			h.hub.Broadcast(ws.EventScanProgress, p)
			// Mirror Create's completion fan-out: without it the SPA never
			// learns the rescan re-populated the library it just emptied.
			if p.Status == models.ScanComplete {
				h.hub.Broadcast(ws.EventLibraryUpdate, map[string]interface{}{
					"library_id":   rescan.ID,
					"library_name": rescan.Name,
					"new_items":    p.NewFiles,
					"action":       "retype_rescan_completed",
				})
			}
		})
	}()

	writeJSON(w, http.StatusOK, map[string]any{
		"library_id":    lib.ID,
		"type":          target,
		"items_deleted": deleted,
		"rescanning":    true,
	})
}
