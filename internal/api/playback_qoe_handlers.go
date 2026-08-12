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
	"github.com/aurora-media/aurora/internal/streaming"
)

// PlaybackQoEHandler serves the telemetry endpoints.
type PlaybackQoEHandler struct {
	queries *db.Queries
	// transcode resolves the delivery facts (encoder family, segment format,
	// burn-in, HDR conversion) from the live session rather than trusting the
	// browser to report them. Optional — nil disables stamping, which is what
	// the handler unit tests use.
	transcode *streaming.TranscodeManager

	// rateLimitLogged tracks which profiles have already had their over-limit
	// warning emitted in the current window, so enforcement cannot become its
	// own denial of service against the operator's log ring.
	rateLimitMu     sync.Mutex
	rateLimitLogged map[int64]time.Time
}

func NewPlaybackQoEHandler(queries *db.Queries, transcode *streaming.TranscodeManager) *PlaybackQoEHandler {
	return &PlaybackQoEHandler{
		queries:         queries,
		transcode:       transcode,
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
	SessionToken   string `json:"session_token"`
	ProfileID      int64  `json:"profile_id,omitempty"`
	Decision       string `json:"decision"`
	DecisionReason string `json:"decision_reason"`
	// NOTE: output_codec, encoder_family, segment_format, hdr_conversion,
	// burn_in and subtitle_mode are deliberately NOT accepted here. They are
	// delivery facts the server resolves from the session itself.
	Prewarm       string `json:"prewarm"`
	ViewportClass string `json:"viewport_class"`
	// SessionID names the transcode session this playback used, so the server
	// can stamp the delivery facts itself. Absent for direct play, which has
	// no session and for which every delivery field is "none".
	SessionID              string `json:"session_id,omitempty"`
	ClickToFirstFrameMS    *int   `json:"click_to_first_frame_ms"`
	ManifestToFirstFrameMS *int   `json:"manifest_to_first_frame_ms"`
}

type playbackQoEFinishRequest struct {
	SessionToken      string `json:"session_token"`
	ProfileID         int64  `json:"profile_id,omitempty"`
	RebufferCount     int    `json:"rebuffer_count"`
	RebufferMS        int    `json:"rebuffer_ms"`
	RenditionSwitches int    `json:"rendition_switches"`
	DeliveryRebuilds  int    `json:"delivery_rebuilds"`
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

	// Delivery facts come from the SERVER, never from the payload. The browser
	// cannot know them — burn-in is configured on a pre-play path the player
	// holds no reference to, the encoder family is a probe result, the segment
	// format is a manager setting — and they are not the client's to assert
	// anyway. Whatever the request claimed for these fields is discarded.
	facts := h.deliveryFacts(req.Decision, req.SessionID)

	err := h.queries.RecordPlaybackQoEStart(r.Context(), profileID, db.PlaybackQoEStart{
		SessionToken:   req.SessionToken,
		Decision:       req.Decision,
		DecisionReason: req.DecisionReason,
		OutputCodec:    facts.OutputCodec,
		EncoderFamily:  facts.EncoderFamily,
		SegmentFormat:  facts.SegmentFormat,
		HDRConversion:  facts.HDRConversion,
		BurnIn:         facts.BurnIn,
		SubtitleMode:   facts.SubtitleMode,
		// Client-side facts the server genuinely cannot see: whether the
		// hover pre-warm was adopted, and how big the player was rendered.
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
		DeliveryRebuilds:  req.DeliveryRebuilds,
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

// deliveryFacts resolves how this playback was delivered.
//
// Direct play has no session and needs no lookup. A transcode/remux session
// that has already been reaped by the time the first frame lands falls back to
// the zero vocabulary rather than to client-supplied values — an unknown is
// more honest than an unverified claim, and it shows up in the aggregate as
// "none" rather than as a fabricated encoder family.
func (h *PlaybackQoEHandler) deliveryFacts(decision, sessionID string) streaming.SessionQoEFacts {
	if decision == "direct_play" || sessionID == "" || h.transcode == nil {
		return streaming.DirectPlayQoEFacts()
	}
	if facts, ok := h.transcode.SessionQoEFacts(sessionID); ok {
		return facts
	}
	slog.Debug("playback qoe: session gone before the first-frame write; "+
		"delivery facts unavailable", "session_id", sessionID)
	return streaming.DirectPlayQoEFacts()
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
