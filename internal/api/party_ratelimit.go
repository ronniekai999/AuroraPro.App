package api

import (
	"encoding/json"
	"time"

	"github.com/aurora-media/aurora/internal/watchparty"
)

// safeWSError maps a manager error to a message safe to send to the
// client. Errors minted via the watchparty package's user-error helper
// pass through verbatim ("only the host can pause", "party is full…");
// anything else — which could wrap a DB or filesystem error — degrades to
// a generic message so internal detail never crosses the WS boundary.
// 2026-06 review (security finding 2).
func safeWSError(err error) string {
	if err == nil {
		return ""
	}
	if watchparty.IsUserError(err) {
		return err.Error()
	}
	return "internal error"
}

// safeRESTError is the HTTP twin of safeWSError: user-facing manager
// errors pass through, anything else degrades to the caller's fallback
// message. Without this, e.g. a DB outage during CreateParty returned the
// raw wrapped driver error ("insert party: pq: …") in the HTTP response
// body (2026-06 review).
func safeRESTError(err error, fallback string) string {
	if err == nil {
		return ""
	}
	if watchparty.IsUserError(err) {
		return err.Error()
	}
	return fallback
}

// ============================================================
// Party WebSocket — shared constants, wire payloads, rate limiting
// ============================================================
//
// These symbols are shared across the V3 room (party_ws_v3_room.go) and
// sync (party_ws_v3_sync.go) handlers. They used to live in party_ws.go
// alongside the legacy V2 PartyWSHandler; that handler was unmounted and
// deleted (improvement #37), so the still-needed pieces were relocated
// here. Keep them in package api so existing references compile unchanged.

const (
	// partyMaxMessageSize is the maximum inbound WebSocket message size (bytes).
	// Raised from 4096 → 16384 post-M7 audit (H1): WebRTC SDPs commonly
	// exceed 4KB once codecs + rtpmap + extmap + ICE-restart trickle
	// candidates are all serialized into the offer. gorilla/websocket's
	// SetReadLimit closes the socket on overflow, which would kill the
	// whole room socket (chat + presence + voice). 16KB is comfortably
	// above the worst legitimate SDP we'll see; still small enough that
	// a malicious client can't blow up our buffers.
	partyMaxMessageSize = 16384

	// partyPongWait is the time allowed to read the next pong message.
	partyPongWait = 90 * time.Second

	// partyPingInterval must be less than partyPongWait.
	partyPingInterval = 60 * time.Second

	// partyWriteWait is the time allowed to write a message.
	partyWriteWait = 10 * time.Second

	// chatRateLimit is the maximum chat messages per user per minute.
	chatRateLimit = 30

	// chatRateWindow is the window for rate limiting chat messages.
	chatRateWindow = time.Minute
)

// chatRateTracker tracks message count per user within a time window. The
// V3 room handler reuses it for both chat and voice-signal limiting, and
// the sync handler reuses it for intent/time-sync limiting; the differing
// caps are applied by each call site, not baked into the tracker.
type chatRateTracker struct {
	count     int
	windowEnd time.Time
}

// partyWSMessage is the envelope for all WebSocket messages in the party protocol.
type partyWSMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// Specific payload types for each message kind.
type joinPartyPayload struct {
	PartyCode string `json:"party_code"`
}

type chatMessagePayload struct {
	Message string `json:"message"`
}

// reactionPayload carries an emoji reaction. M6 added the optional AbsMs
// field so the timestamp at which the reaction was sent (in absolute
// source-ms — the wire protocol's coordinate space) can be recorded in
// the per-party ring buffer for M9's reaction timeline / highlight reel.
// AbsMs=0 means "no client-provided timestamp" — the server stamps from
// its own authoritative CurrentAbsMs(). Validated and clamped server-side
// to guard against tampered timestamps.
type reactionPayload struct {
	Emoji string `json:"emoji"`
	AbsMs int64  `json:"abs_ms,omitempty"`
}

// changeMediaPayload swaps the party's media to a new item/episode. Used
// by V3's TV episode auto-advance (host's video ended → host's client
// resolves next episode via /api/media/{id}/next-episode → emits this).
// Host-only; manager enforces. EpisodeID is nullable because movies have
// no episode. The media_title and media_poster come from the client so
// the server doesn't need an extra DB lookup to update PartyState.
type changeMediaPayload struct {
	MediaItemID int64  `json:"media_item_id"`
	EpisodeID   *int64 `json:"episode_id,omitempty"`
	MediaTitle  string `json:"media_title"`
	MediaPoster string `json:"media_poster"`
}

// trackChangePayload broadcasts the host's audio or subtitle selection
// to all participants. Indexes are HLS-playlist-relative and stable
// across all clients of the same party (everyone watches the same
// transcoded HLS source, so the track ordering matches). Subtitle off
// is conveyed as Index = -1.
//
// Host-only — guests' track changes are personal preference, not
// party-wide. The host's choice wins for everyone; a guest can manually
// re-toggle after a host broadcast if they want a personal override.
type trackChangePayload struct {
	Kind  string `json:"kind"`  // "audio" | "subtitle"
	Index int    `json:"index"` // -1 = off (subtitle only)
}

// markReadyPayload toggles a participant's "I'm ready to start watching"
// state for M5's spoiler-free start gate. The host doesn't see Play
// activate until every non-host participant has Ready=true (if the
// SpoilerFreeStart setting is on). M5 fix.
type markReadyPayload struct {
	Ready bool `json:"ready"`
}

// M7 — WebRTC mesh voice signaling payloads. The server is a JSON relay;
// it never parses the SDP / candidate blobs, just stamps from_user_id
// and forwards. Audio bytes flow peer-to-peer directly. See
// internal/watchparty/manager.go's M7 section for the wire protocol.

// voiceSignalPayload is the common shape for voice-offer, voice-answer,
// and voice-ice. The ToUserID identifies the recipient peer; everything
// else is forwarded verbatim to that peer's room socket.
//
//   - For voice-offer / voice-answer: SDP carries the session description.
//   - For voice-ice: Candidate, SDPMid, SDPMLineIndex carry the ICE
//     candidate fields the recipient's RTCPeerConnection.addIceCandidate
//     needs.
//
// SDPMLineIndex is a pointer so we can distinguish "0" from "not provided"
// — some browsers omit it for null-mid candidates.
type voiceSignalPayload struct {
	ToUserID      int64   `json:"to_user_id"`
	SDP           string  `json:"sdp,omitempty"`
	Candidate     string  `json:"candidate,omitempty"`
	SDPMid        string  `json:"sdp_mid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdp_m_line_index,omitempty"`
}

// timeSyncPayload carries the client's originating wall-clock time and (on
// subsequent requests) a computed offset/RTT so the server can log quality.
type timeSyncPayload struct {
	ClientSendMs int64 `json:"client_send_ms"`
	// Optional: client tells us its computed RTT/offset for observability.
	MeasuredRTTms    int64 `json:"measured_rtt_ms,omitempty"`
	MeasuredOffsetMs int64 `json:"measured_offset_ms,omitempty"`
}
