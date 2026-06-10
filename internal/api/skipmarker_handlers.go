package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/skipmarkers"
	"github.com/go-chi/chi/v5"
)

// SkipMarkerHandler exposes the Smart Skip admin surface: coverage
// status, manual sweep trigger, and per-file manual correction
// (detector='manual', which the background analyzer never overwrites).
// Player-facing marker delivery rides the existing stream-info payload
// (GetStreamInfo) — no extra round-trip on playback start.
type SkipMarkerHandler struct {
	queries *db.Queries
	worker  *skipmarkers.Worker
}

func NewSkipMarkerHandler(queries *db.Queries, worker *skipmarkers.Worker) *SkipMarkerHandler {
	return &SkipMarkerHandler{queries: queries, worker: worker}
}

// skipMarkerFileRef resolves the {fileID} path param + ?type= query
// into a validated (fileID, isEpisode) pair, verifying the file row
// actually exists (the marker tables FK both file families, so an
// unchecked ID would surface as an opaque 500 on insert).
func (h *SkipMarkerHandler) skipMarkerFileRef(w http.ResponseWriter, r *http.Request) (fileID int64, isEpisode bool, ok bool) {
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return 0, false, false
	}
	switch r.URL.Query().Get("type") {
	case "episode":
		isEpisode = true
		if _, err := h.queries.GetEpisodeFileByID(r.Context(), fileID); err != nil {
			writeError(w, http.StatusNotFound, "file not found")
			return 0, false, false
		}
	case "media":
		if _, err := h.queries.GetMediaFileByID(r.Context(), fileID); err != nil {
			writeError(w, http.StatusNotFound, "file not found")
			return 0, false, false
		}
	default:
		writeError(w, http.StatusBadRequest, "type must be 'episode' or 'media'")
		return 0, false, false
	}
	return fileID, isEpisode, true
}

func validSkipMarkerKind(kind string) bool {
	return kind == "recap" || kind == "intro" || kind == "credits"
}

// Status reports worker state + library coverage for the admin
// dashboard card. Cheap COUNT queries — safe to poll.
func (h *SkipMarkerHandler) Status(w http.ResponseWriter, r *http.Request) {
	if h.worker == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	coverage, err := h.queries.GetSkipMarkerStatus(r.Context(), skipmarkers.Detector)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get skip-marker status")
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Enabled  bool               `json:"enabled"`
		Detector string             `json:"detector"`
		Worker   skipmarkers.Status `json:"worker"`
		*db.SkipMarkerStatus
	}{
		Enabled:          h.worker.Enabled(r.Context()),
		Detector:         skipmarkers.Detector,
		Worker:           h.worker.Status(),
		SkipMarkerStatus: coverage,
	})
}

// TriggerSweep nudges the background worker. Fire-and-forget like the
// AI-rematch trigger: the sweep runs on the worker goroutine, well
// outside this route group's 60s timeout.
func (h *SkipMarkerHandler) TriggerSweep(w http.ResponseWriter, r *http.Request) {
	if h.worker == nil {
		writeError(w, http.StatusServiceUnavailable, "skip-marker worker not running")
		return
	}
	h.worker.TriggerSweep()
	writeJSON(w, http.StatusAccepted, map[string]string{"message": "sweep triggered"})
}

// GetMarkers returns ALL marker rows for a file — including zero-
// length admin suppressions the player never sees — for the in-player
// admin editor.
func (h *SkipMarkerHandler) GetMarkers(w http.ResponseWriter, r *http.Request) {
	fileID, isEpisode, ok := h.skipMarkerFileRef(w, r)
	if !ok {
		return
	}
	markers, err := h.queries.GetSkipMarkers(r.Context(), fileID, isEpisode)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get markers")
		return
	}
	if markers == nil {
		markers = []models.SkipMarker{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"markers": markers})
}

// UpsertMarker writes a manual correction for one (file, kind).
// start_ms == end_ms == 0 suppresses the marker (stored so the
// analyzer won't re-add it; hidden from the player).
func (h *SkipMarkerHandler) UpsertMarker(w http.ResponseWriter, r *http.Request) {
	fileID, isEpisode, ok := h.skipMarkerFileRef(w, r)
	if !ok {
		return
	}
	var req struct {
		Kind    string `json:"kind"`
		StartMs int64  `json:"start_ms"`
		EndMs   int64  `json:"end_ms"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !validSkipMarkerKind(req.Kind) {
		writeError(w, http.StatusBadRequest, "kind must be 'recap', 'intro' or 'credits'")
		return
	}
	// Mirrors the table CHECK so bad input is a clean 400, not a 500.
	if req.StartMs < 0 || req.EndMs < req.StartMs {
		writeError(w, http.StatusBadRequest, "marker window must satisfy 0 <= start_ms <= end_ms")
		return
	}
	marker := models.SkipMarker{
		Kind:       req.Kind,
		StartMs:    req.StartMs,
		EndMs:      req.EndMs,
		Confidence: 1,
		Detector:   "manual",
	}
	if err := h.queries.UpsertSkipMarker(r.Context(), fileID, isEpisode, marker); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save marker")
		return
	}
	markers, err := h.queries.GetSkipMarkers(r.Context(), fileID, isEpisode)
	if err != nil || markers == nil {
		markers = []models.SkipMarker{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"markers": markers})
}

// DeleteMarker is "revert to auto": removes the (file, kind) row AND
// the file's analysis-ledger entry, then nudges the worker so fresh
// auto-detection runs. (Removing only the row would leave the ledger
// saying "analyzed" and nothing would ever come back.)
func (h *SkipMarkerHandler) DeleteMarker(w http.ResponseWriter, r *http.Request) {
	fileID, isEpisode, ok := h.skipMarkerFileRef(w, r)
	if !ok {
		return
	}
	kind := r.URL.Query().Get("kind")
	if !validSkipMarkerKind(kind) {
		writeError(w, http.StatusBadRequest, "kind must be 'recap', 'intro' or 'credits'")
		return
	}
	if _, err := h.queries.DeleteSkipMarker(r.Context(), fileID, isEpisode, kind); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete marker")
		return
	}
	if err := h.queries.ResetSkipAnalysis(r.Context(), fileID, isEpisode); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reset analysis")
		return
	}
	if h.worker != nil {
		h.worker.TriggerSweep()
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": "marker deleted; re-detection queued"})
}
