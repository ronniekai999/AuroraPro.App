package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/watchparty"
	"github.com/gorilla/websocket"
)

// ============================================================
// Party WebSocket Handler
// ============================================================

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

// PartyWSHandler handles the dedicated WebSocket endpoint for watch parties.
type PartyWSHandler struct {
	manager      *watchparty.Manager
	authSvc      *auth.Service
	versionStore *auth.TokenVersionStore
	upgrader     websocket.Upgrader

	// Per-user chat rate limiting
	rateMu    sync.Mutex
	chatRates map[int64]*chatRateTracker
}

// chatRateTracker tracks chat message count per user within a time window.
type chatRateTracker struct {
	count     int
	windowEnd time.Time
}

// NewPartyWSHandler creates a new PartyWSHandler.
func NewPartyWSHandler(manager *watchparty.Manager, authSvc *auth.Service, versionStore *auth.TokenVersionStore) *PartyWSHandler {
	return &PartyWSHandler{
		manager:      manager,
		authSvc:      authSvc,
		versionStore: versionStore,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				// Allow all origins -- auth is handled via JWT token in query param.
				// This matches the existing Hub pattern in hub.go where origin
				// checking is relaxed for JWT-authenticated WebSocket connections.
				return true
			},
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
		},
		chatRates: make(map[int64]*chatRateTracker),
	}
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

type playbackControlPayload struct {
	Action string `json:"action"`
	TimeMs int64  `json:"time_ms"`
}

type syncHeartbeatPayload struct {
	CurrentTimeMs int64 `json:"current_time_ms"`
	IsBuffering   bool  `json:"is_buffering"`
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

// Sync protocol V2 message payloads.

// timeSyncPayload carries the client's originating wall-clock time and (on
// subsequent requests) a computed offset/RTT so the server can log quality.
type timeSyncPayload struct {
	ClientSendMs int64 `json:"client_send_ms"`
	// Optional: client tells us its computed RTT/offset for observability.
	MeasuredRTTms    int64 `json:"measured_rtt_ms,omitempty"`
	MeasuredOffsetMs int64 `json:"measured_offset_ms,omitempty"`
}

// readyPayload is emitted by a client that has buffered to the group target
// position and is prepared to start when the group transitions to Playing.
type readyPayload struct {
	PositionMs int64 `json:"position_ms"`
}

// driftReportPayload is the client's self-report after attempting to correct
// its own drift. The server uses this to detect thrashing and drop clients
// that can't keep up.
type driftReportPayload struct {
	DriftMs   int64 `json:"drift_ms"`
	Corrected bool  `json:"corrected"`
}

// ServeHTTP upgrades the HTTP connection to WebSocket and runs the read pump.
// Auth is via ?token= query parameter, matching the existing /ws endpoint pattern.
func (h *PartyWSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Authenticate via query param token (same pattern as /ws in router.go)
	claims, ok := requireQueryTokenClaims(w, r, h.authSvc, h.versionStore)
	if !ok {
		return
	}

	// Upgrade to WebSocket
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("party websocket upgrade failed", "error", err, "user_id", claims.UserID)
		return
	}

	slog.Debug("party websocket connected", "user_id", claims.UserID, "username", claims.Username)

	// Configure connection parameters
	conn.SetReadLimit(partyMaxMessageSize)
	conn.SetReadDeadline(time.Now().Add(partyPongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(partyPongWait))
		return nil
	})

	// Wrap in SafeConn for thread-safe writes (shared between ping goroutine
	// and manager broadcasts). gorilla/websocket does NOT support concurrent writers.
	sc := watchparty.NewSafeConn(conn)

	// Track the party code this connection has joined
	var currentPartyCode string
	var partyCodeMu sync.Mutex

	// Start ping goroutine to keep connection alive
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(partyPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := sc.WriteControl(websocket.PingMessage, nil, time.Now().Add(partyWriteWait)); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}()

	// Read pump -- processes incoming messages until disconnect
	defer func() {
		close(done)

		// On disconnect, leave whatever party the user is in
		partyCodeMu.Lock()
		code := currentPartyCode
		partyCodeMu.Unlock()

		if code != "" {
			if err := h.manager.LeaveParty(code, claims.UserID); err != nil {
				slog.Debug("leave party on disconnect failed", "error", err)
			}
		}

		conn.Close()
		slog.Debug("party websocket disconnected", "user_id", claims.UserID, "username", claims.Username)
	}()

	for {
		_, rawMsg, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Debug("party websocket read error", "user_id", claims.UserID, "error", err)
			}
			return
		}

		var msg partyWSMessage
		if err := json.Unmarshal(rawMsg, &msg); err != nil {
			h.sendError(sc, "invalid message format")
			continue
		}

		// Route by message type
		switch msg.Type {
		case "join-party":
			var payload joinPartyPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				h.sendError(sc, "invalid join-party payload")
				continue
			}
			if payload.PartyCode == "" {
				h.sendError(sc, "party_code is required")
				continue
			}

			// Leave current party if in one
			partyCodeMu.Lock()
			if currentPartyCode != "" && currentPartyCode != payload.PartyCode {
				_ = h.manager.LeaveParty(currentPartyCode, claims.UserID)
			}
			partyCodeMu.Unlock()

			_, err := h.manager.JoinParty(payload.PartyCode, claims.UserID, claims.Username, sc)
			if err != nil {
				h.sendError(sc, err.Error())
				continue
			}

			partyCodeMu.Lock()
			currentPartyCode = payload.PartyCode
			partyCodeMu.Unlock()

		case "leave-party":
			partyCodeMu.Lock()
			code := currentPartyCode
			currentPartyCode = ""
			partyCodeMu.Unlock()

			if code != "" {
				_ = h.manager.LeaveParty(code, claims.UserID)
			}

		case "playback-control":
			partyCodeMu.Lock()
			code := currentPartyCode
			partyCodeMu.Unlock()

			if code == "" {
				h.sendError(sc, "not in a party")
				continue
			}

			var payload playbackControlPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				h.sendError(sc, "invalid playback-control payload")
				continue
			}

			if err := h.manager.HandlePlaybackControl(code, claims.UserID, payload.Action, payload.TimeMs); err != nil {
				h.sendError(sc, err.Error())
			}

		case "sync-heartbeat":
			partyCodeMu.Lock()
			code := currentPartyCode
			partyCodeMu.Unlock()

			if code == "" {
				continue // silently ignore heartbeats when not in a party
			}

			var payload syncHeartbeatPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue // silently ignore malformed heartbeats
			}

			_ = h.manager.HandleSyncHeartbeat(code, claims.UserID, payload.CurrentTimeMs, payload.IsBuffering)

		case "chat-message":
			partyCodeMu.Lock()
			code := currentPartyCode
			partyCodeMu.Unlock()

			if code == "" {
				h.sendError(sc, "not in a party")
				continue
			}

			// Rate limit chat messages
			if !h.checkChatRate(claims.UserID) {
				h.sendError(sc, "chat rate limit exceeded (max 30 messages per minute)")
				continue
			}

			var payload chatMessagePayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				h.sendError(sc, "invalid chat-message payload")
				continue
			}

			if err := h.manager.HandleChat(code, claims.UserID, claims.Username, payload.Message); err != nil {
				h.sendError(sc, err.Error())
			}

		case "reaction":
			partyCodeMu.Lock()
			code := currentPartyCode
			partyCodeMu.Unlock()

			if code == "" {
				h.sendError(sc, "not in a party")
				continue
			}

			// M6/H1 — rate limit reactions on V2 too for symmetry. Route is
			// currently unmounted in production (router.go only wires V3),
			// but keeping behavior aligned makes the eventual V2 deletion
			// safer (one fewer divergence to reason about).
			if !h.checkChatRate(claims.UserID) {
				h.sendError(sc, "reaction rate limit exceeded (max 30 per minute)")
				continue
			}

			var payload reactionPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				h.sendError(sc, "invalid reaction payload")
				continue
			}

			if err := h.manager.HandleReaction(code, claims.UserID, claims.Username, payload.Emoji, payload.AbsMs); err != nil {
				h.sendError(sc, err.Error())
			}

		case "time-sync":
			// Server stamps recv time ASAP to minimise the handling window in
			// the RTT calculation. The response is sent directly to the client
			// that asked; no broadcast.
			serverRecvMs := time.Now().UnixMilli()
			partyCodeMu.Lock()
			code := currentPartyCode
			partyCodeMu.Unlock()

			var payload timeSyncPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}

			resp, err := h.manager.HandleTimeSync(code, claims.UserID, payload.ClientSendMs, serverRecvMs)
			if err != nil {
				continue
			}
			respMsg := map[string]interface{}{
				"type": "time-sync-response",
				"payload": map[string]interface{}{
					"client_send_ms": resp.ClientSendMs,
					"server_recv_ms": resp.ServerRecvMs,
					"server_send_ms": resp.ServerSendMs,
				},
			}
			if data, err := json.Marshal(respMsg); err == nil {
				sc.SetWriteDeadline(time.Now().Add(partyWriteWait))
				_ = sc.WriteMessage(websocket.TextMessage, data)
			}
			// Record the client's measured RTT/offset if provided.
			if code != "" && (payload.MeasuredRTTms > 0 || payload.MeasuredOffsetMs != 0) {
				h.manager.RecordRTT(code, claims.UserID, payload.MeasuredRTTms, payload.MeasuredOffsetMs)
			}

		case "ready":
			partyCodeMu.Lock()
			code := currentPartyCode
			partyCodeMu.Unlock()

			if code == "" {
				continue
			}
			var payload readyPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			_ = h.manager.HandleReady(code, claims.UserID, payload.PositionMs)

		case "drift-report":
			partyCodeMu.Lock()
			code := currentPartyCode
			partyCodeMu.Unlock()

			if code == "" {
				continue
			}
			var payload driftReportPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			_ = h.manager.HandleDriftReport(code, claims.UserID, payload.DriftMs, payload.Corrected)

		default:
			h.sendError(sc, "unknown message type: "+msg.Type)
		}
	}
}

// sendError sends an error message to a single WebSocket connection via SafeConn.
func (h *PartyWSHandler) sendError(sc *watchparty.SafeConn, errMsg string) {
	msg := map[string]interface{}{
		"type": "error",
		"payload": map[string]string{
			"error": errMsg,
		},
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	sc.SetWriteDeadline(time.Now().Add(partyWriteWait))
	sc.WriteMessage(websocket.TextMessage, data)
}

// checkChatRate returns true if the user is within the chat rate limit.
// Uses a simple windowed counter: max chatRateLimit messages per chatRateWindow.
// Also performs lazy cleanup of expired rate entries to prevent unbounded map growth.
func (h *PartyWSHandler) checkChatRate(userID int64) bool {
	h.rateMu.Lock()
	defer h.rateMu.Unlock()

	now := time.Now()

	// Lazy cleanup: purge expired entries every ~100 checks to prevent map bloat.
	// This is O(n) but n is bounded by the number of active chatters which is small.
	if len(h.chatRates) > 100 {
		for uid, tracker := range h.chatRates {
			if now.After(tracker.windowEnd) {
				delete(h.chatRates, uid)
			}
		}
	}

	tracker, exists := h.chatRates[userID]

	if !exists || now.After(tracker.windowEnd) {
		// Start a new window
		h.chatRates[userID] = &chatRateTracker{
			count:     1,
			windowEnd: now.Add(chatRateWindow),
		}
		return true
	}

	if tracker.count >= chatRateLimit {
		return false
	}

	tracker.count++
	return true
}
