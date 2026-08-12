package api

// Playback quality-of-experience ingest and reporting (August 2026 review,
// item #1).
//
// Two member-facing writes (first frame, then terminal) and one admin read.
// The schema's reasoning and privacy posture live in migration 056; what this
// file adds on top is the trust boundary: everything here arrives from a
// browser, so nothing is taken on faith.

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
)

// PlaybackQoEHandler serves the telemetry endpoints.
type PlaybackQoEHandler struct {
	queries *db.Queries

	// rateLimitLogged tracks which profiles have already had their over-limit
	// warning emitted in the current window, so enforcement cannot become its
	// own denial of service against the operator's log ring.
	rateLimitMu     sync.Mutex
	rateLimitLogged map[int64]time.Time
}

func NewPlaybackQoEHandler(queries *db.Queries) *PlaybackQoEHandler {
	return &PlaybackQoEHandler{
		queries:         queries,
		rateLimitLogged: make(map[int64]time.Time),
	}
}

// rateLimitLogInterval is how often one profile may produce a rate-limit
// warning. Matches the rate-limit window itself.
const rateLimitLogInterval = time.Hour

// logRateLimitOnce emits at most one warning per profile per interval.
func (h *PlaybackQoEHandler) logRateLimitOnce(profileID int64, recent int) {
	now := time.Now()
	h.rateLimitMu.Lock()
	last, seen := h.rateLimitLogged[profileID]
	if seen && now.Sub(last) < rateLimitLogInterval {
		h.rateLimitMu.Unlock()
		return
	}
	h.rateLimitLogged[profileID] = now
	// Bound the map: without this an attacker cycling profile ids would grow it
	// without limit, which is the same failure in a different resource.
	if len(h.rateLimitLogged) > 1024 {
		for id, at := range h.rateLimitLogged {
			if now.Sub(at) >= rateLimitLogInterval {
				delete(h.rateLimitLogged, id)
			}
		}
	}
	h.rateLimitMu.Unlock()

	slog.Warn("playback qoe ingest rate limit hit; dropping samples for this profile",
		"profile_id", profileID, "recent_rows", recent, "suppress_for", rateLimitLogInterval)
}

// maxQoEBodyBytes caps the request body. The payloads are a few hundred bytes;
// this is four kilobytes of headroom and a hard stop on anything else.
const maxQoEBodyBytes = 4 << 10

type playbackQoEStartRequest struct {
	SessionToken           string `json:"session_token"`
	ProfileID              int64  `json:"profile_id,omitempty"`
	Decision               string `json:"decision"`
	DecisionReason         string `json:"decision_reason"`
	OutputCodec            string `json:"output_codec"`
	EncoderFamily          string `json:"encoder_family"`
	SegmentFormat          string `json:"segment_format"`
	HDRConversion          string `json:"hdr_conversion"`
	BurnIn                 string `json:"burn_in"`
	SubtitleMode           string `json:"subtitle_mode"`
	Prewarm                string `json:"prewarm"`
	ViewportClass          string `json:"viewport_class"`
	ClickToFirstFrameMS    *int   `json:"click_to_first_frame_ms"`
	ManifestToFirstFrameMS *int   `json:"manifest_to_first_frame_ms"`
}

type playbackQoEFinishRequest struct {
	SessionToken      string `json:"session_token"`
	ProfileID         int64  `json:"profile_id,omitempty"`
	RebufferCount     int    `json:"rebuffer_count"`
	RebufferMS        int    `json:"rebuffer_ms"`
	RenditionSwitches int    `json:"rendition_switches"`
	WatchedMS         int    `json:"watched_ms"`
	ThroughputClass   string `json:"throughput_class"`
	Terminal          string `json:"terminal"`
}

// RecordStart handles the first-frame write.
//
// Responds 204 in every non-authorization case, including rejection: this is a
// fire-and-forget analytics call on the playback hot path, and a client that
// has just started a movie must never be given a reason to retry, surface an
// error, or block on telemetry. Rejections are counted in the server log.
func (h *PlaybackQoEHandler) RecordStart(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req playbackQoEStartRequest
	if !decodeQoEBody(w, r, &req) {
		return
	}
	if !db.ValidPlaybackQoESessionToken(req.SessionToken) {
		slog.Debug("playback qoe start rejected: malformed session token")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	profileID, ok := h.resolveProfile(r, claims.UserID, req.ProfileID)
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Rate guard: bounded rows per profile per hour. Checked before the insert
	// so a looping client cannot inflate the table or skew the percentiles.
	since := time.Now().Add(-time.Hour)
	if n, err := h.queries.CountRecentPlaybackQoE(r.Context(), profileID, since); err == nil &&
		n >= db.MaxPlaybackQoEPerProfilePerHour {
		// Logged at most once per profile per window. Every over-limit request
		// used to emit a WARN, and Aurora routes WARN into a bounded
		// problem-ring an operator reads to notice exactly this kind of abuse —
		// so a few seconds of a looping client evicted the evidence of itself.
		h.logRateLimitOnce(profileID, n)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	err := h.queries.RecordPlaybackQoEStart(r.Context(), profileID, db.PlaybackQoEStart{
		SessionToken:           req.SessionToken,
		Decision:               req.Decision,
		DecisionReason:         req.DecisionReason,
		OutputCodec:            req.OutputCodec,
		EncoderFamily:          req.EncoderFamily,
		SegmentFormat:          req.SegmentFormat,
		HDRConversion:          req.HDRConversion,
		BurnIn:                 req.BurnIn,
		SubtitleMode:           req.SubtitleMode,
		Prewarm:                req.Prewarm,
		ViewportClass:          req.ViewportClass,
		ClickToFirstFrameMS:    req.ClickToFirstFrameMS,
		ManifestToFirstFrameMS: req.ManifestToFirstFrameMS,
	})
	if err != nil {
		slog.Debug("record playback qoe start", "error", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// RecordFinish handles the terminal write, delivered by navigator.sendBeacon.
//
// A beacon fires during page unload: there is no page left to receive a
// response, so the only useful behavior is to accept and move on.
func (h *PlaybackQoEHandler) RecordFinish(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req playbackQoEFinishRequest
	if !decodeQoEBody(w, r, &req) {
		return
	}
	if !db.ValidPlaybackQoESessionToken(req.SessionToken) {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	profileID, ok := h.resolveProfile(r, claims.UserID, req.ProfileID)
	if !ok {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// The UPDATE is scoped to this profile's rows, so a leaked or guessed token
	// still cannot write through another account's session.
	if err := h.queries.FinishPlaybackQoE(r.Context(), profileID, db.PlaybackQoEFinish{
		SessionToken:      req.SessionToken,
		RebufferCount:     req.RebufferCount,
		RebufferMS:        req.RebufferMS,
		RenditionSwitches: req.RenditionSwitches,
		WatchedMS:         req.WatchedMS,
		ThroughputClass:   req.ThroughputClass,
		Terminal:          req.Terminal,
	}); err != nil {
		slog.Debug("finish playback qoe", "error", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// Summary is the admin read: percentiles and ratios over a recent window.
func (h *PlaybackQoEHandler) Summary(w http.ResponseWriter, r *http.Request) {
	window := 24 * time.Hour
	if raw := r.URL.Query().Get("hours"); raw != "" {
		hours, err := strconv.Atoi(raw)
		if err != nil || hours <= 0 {
			writeError(w, http.StatusBadRequest, "invalid hours")
			return
		}
		// Bounded by the retention window: a longer request would silently
		// report a partial period as if it were complete.
		if maxHours := int(db.PlaybackQoERetention.Hours()); hours > maxHours {
			hours = maxHours
		}
		window = time.Duration(hours) * time.Hour
	}

	summary, err := h.queries.PlaybackQoESummaryStats(r.Context(), window)
	if err != nil {
		slog.Error("playback qoe summary", "error", err)
		writeError(w, http.StatusInternalServerError, "failed to compute playback summary")
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

// decodeQoEBody reads a bounded JSON body. Malformed input is a 204 rather than
// a 400 for the same reason the rest of this file is: telemetry must never
// become something a player has to handle.
func decodeQoEBody(w http.ResponseWriter, r *http.Request, dst interface{}) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxQoEBodyBytes)).Decode(dst); err != nil {
		slog.Debug("playback qoe body decode", "error", err)
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	return true
}

// resolveProfile maps the request to a profile this user owns, defaulting to
// their default profile. An explicitly-supplied profile_id is verified against
// the caller — telemetry is still per-profile history and must not be
// attributable to somebody else's.
func (h *PlaybackQoEHandler) resolveProfile(r *http.Request, userID, requested int64) (int64, bool) {
	if requested > 0 {
		profile, err := h.queries.GetProfile(r.Context(), requested)
		if err != nil || profile == nil || profile.UserID != userID {
			return 0, false
		}
		return profile.ID, true
	}
	profile, err := h.queries.GetDefaultProfile(r.Context(), userID)
	if err != nil || profile == nil {
		return 0, false
	}
	return profile.ID, true
}
