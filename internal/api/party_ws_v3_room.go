package api

// ============================================================
// Watch Party V3 — Room Socket (/ws/party-room)
// ============================================================
//
// Low-frequency, membership + chat + reactions + presence. Opening this
// socket is what creates the participant record in the party; the sync
// socket refuses to register until the room socket has landed.
//
// Server → client:  participant-join, participant-left, chat, reaction,
//                   party-state (initial snapshot on join), party-ended
// Client → server:  join-party, leave-party, chat-message, reaction

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

// PartyWSHandlerV3Room handles /ws/party-room.
type PartyWSHandlerV3Room struct {
	manager  *watchparty.Manager
	authSvc  *auth.Service
	upgrader websocket.Upgrader

	rateMu    sync.Mutex
	chatRates map[int64]*chatRateTracker
	// M7 — voice signaling has its own (higher) rate limit because ICE
	// trickle candidates burst-fire during peer connection setup. Same
	// algorithm as chatRates, just a wider window cap.
	voiceRates map[int64]*chatRateTracker
}

// NewPartyWSHandlerV3Room constructs the handler.
// originAllowed gates browser-originated upgrades — see
// websocketOriginChecker in helpers.go for the policy. Pass
// cfg.OriginAllowed.
func NewPartyWSHandlerV3Room(manager *watchparty.Manager, authSvc *auth.Service, originAllowed func(string) bool) *PartyWSHandlerV3Room {
	return &PartyWSHandlerV3Room{
		manager: manager,
		authSvc: authSvc,
		upgrader: websocket.Upgrader{
			CheckOrigin:     websocketOriginChecker(originAllowed),
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
		},
		chatRates:  make(map[int64]*chatRateTracker),
		voiceRates: make(map[int64]*chatRateTracker),
	}
}

func (h *PartyWSHandlerV3Room) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token := QueryParamToken(r)
	if token == "" {
		writeError(w, http.StatusUnauthorized, "token query parameter required")
		return
	}
	claims, err := h.authSvc.ValidateAccessToken(token)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid or expired token")
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("v3 room upgrade failed", "err", err, "user_id", claims.UserID)
		return
	}
	conn.SetReadLimit(partyMaxMessageSize)
	conn.SetReadDeadline(time.Now().Add(partyPongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(partyPongWait))
		return nil
	})
	sc := watchparty.NewSafeConn(conn)

	var currentCode string
	var codeMu sync.Mutex

	done := make(chan struct{})
	go func() {
		t := time.NewTicker(partyPingInterval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				if err := sc.WriteControl(websocket.PingMessage, nil, time.Now().Add(partyWriteWait)); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}()

	defer func() {
		close(done)
		codeMu.Lock()
		code := currentCode
		codeMu.Unlock()
		if code != "" {
			// M7/H2 — conn-identity check: only clean up if THIS conn
			// is still the active one for this user. Prevents a dying
			// older tab from kicking the fresh tab's room slot (and
			// voice presence with it). The explicit `leave-party`
			// case above still uses LeavePartyV3Room unconditionally —
			// that's a deliberate user action, not a socket EOF.
			_ = h.manager.LeavePartyV3RoomIfConn(code, claims.UserID, sc)
		}
		_ = conn.Close()
		slog.Debug("v3 room disconnected", "user_id", claims.UserID)
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Debug("v3 room read err", "user_id", claims.UserID, "err", err)
			}
			return
		}
		var msg partyWSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			h.sendErr(sc, "invalid message format")
			continue
		}

		switch msg.Type {
		case "join-party":
			var p joinPartyPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil || p.PartyCode == "" {
				h.sendErr(sc, "invalid join-party payload")
				continue
			}
			codeMu.Lock()
			if currentCode != "" && currentCode != p.PartyCode {
				_ = h.manager.LeavePartyV3Room(currentCode, claims.UserID)
			}
			codeMu.Unlock()

			ps, err := h.manager.JoinPartyV3Room(p.PartyCode, claims.UserID, claims.Username, sc)
			if err != nil {
				h.sendErr(sc, err.Error())
				continue
			}
			codeMu.Lock()
			currentCode = p.PartyCode
			codeMu.Unlock()

			// Send an initial room snapshot (participant list, chat
			// history, media descriptor). Reuses V2's party-state builder
			// for payload parity during coexistence.
			ps.Lock()
			snap := h.manager.BuildPartyStateMessage(ps)
			ps.Unlock()
			if data, err := json.Marshal(snap); err == nil {
				sc.SetWriteDeadline(time.Now().Add(partyWriteWait))
				_ = sc.WriteMessage(websocket.TextMessage, data)
			}

		case "leave-party":
			codeMu.Lock()
			code := currentCode
			currentCode = ""
			codeMu.Unlock()
			if code != "" {
				_ = h.manager.LeavePartyV3Room(code, claims.UserID)
			}

		case "chat-message":
			codeMu.Lock()
			code := currentCode
			codeMu.Unlock()
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			if !h.checkChatRate(claims.UserID) {
				h.sendErr(sc, "chat rate limit exceeded (max 30 messages per minute)")
				continue
			}
			var p chatMessagePayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				h.sendErr(sc, "invalid chat-message payload")
				continue
			}
			if err := h.manager.HandleChat(code, claims.UserID, claims.Username, p.Message); err != nil {
				h.sendErr(sc, err.Error())
			}

		case "reaction":
			codeMu.Lock()
			code := currentCode
			codeMu.Unlock()
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			// M6/H1 — rate limit reactions. Each reaction is an O(N_roomConns)
			// broadcast AND a memory append to ps.Reactions; an unthrottled
			// client could saturate the broadcast loop and starve chat/sync
			// traffic. The chat tracker (30/min) is plenty of headroom for
			// real human clicking. Mirrors the mark-ready gate added in M5.
			if !h.checkChatRate(claims.UserID) {
				h.sendErr(sc, "reaction rate limit exceeded (max 30 per minute)")
				continue
			}
			var p reactionPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				h.sendErr(sc, "invalid reaction payload")
				continue
			}
			if err := h.manager.HandleReaction(code, claims.UserID, claims.Username, p.Emoji, p.AbsMs); err != nil {
				h.sendErr(sc, err.Error())
			}

		case "change-media":
			// Host-initiated media swap (TV episode auto-advance is the
			// primary trigger). Routed over the room socket because it's
			// low-frequency, membership-adjacent traffic — same channel
			// chat/reactions/presence use.
			codeMu.Lock()
			code := currentCode
			codeMu.Unlock()
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			var p changeMediaPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				h.sendErr(sc, "invalid change-media payload")
				continue
			}
			if p.MediaItemID <= 0 {
				h.sendErr(sc, "media_item_id required")
				continue
			}
			if err := h.manager.ChangeMedia(code, claims.UserID, p.MediaItemID, p.EpisodeID, p.MediaTitle, p.MediaPoster); err != nil {
				h.sendErr(sc, err.Error())
			}

		case "track-change":
			// Host's audio or subtitle track selection — broadcast to all
			// participants so the party watches in the same audio/sub.
			// Stateless on the server (no PartyState mutation) since track
			// indexes are stable across the same HLS source.
			codeMu.Lock()
			code := currentCode
			codeMu.Unlock()
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			var p trackChangePayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				h.sendErr(sc, "invalid track-change payload")
				continue
			}
			if err := h.manager.BroadcastTrackChange(code, claims.UserID, p.Kind, p.Index); err != nil {
				h.sendErr(sc, err.Error())
			}

		case "mark-ready":
			// M5 — participant's "I'm ready to start watching" toggle for
			// the spoiler-free start gate. Broadcasts updated participant
			// state so the host's UI can show real-time readiness; host's
			// request-play later evaluates the gate.
			//
			// Rate-limited via the same per-user tracker as chat (30/min).
			// Each mark-ready triggers a full-participant-list broadcast
			// to every room conn, so a malicious client spamming this
			// could amplify their traffic by O(party_size). The chat
			// rate limit (30/min) is more than enough headroom for
			// legitimate UI clicks (humans click Ready maybe twice).
			codeMu.Lock()
			code := currentCode
			codeMu.Unlock()
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			if !h.checkChatRate(claims.UserID) {
				h.sendErr(sc, "rate limit exceeded")
				continue
			}
			var p markReadyPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				h.sendErr(sc, "invalid mark-ready payload")
				continue
			}
			if err := h.manager.MarkReady(code, claims.UserID, p.Ready); err != nil {
				h.sendErr(sc, err.Error())
			}

		// ============================================================
		// M7 — Voice presence (WebRTC mesh signaling relay)
		// ============================================================

		case "voice-join":
			codeMu.Lock()
			code := currentCode
			codeMu.Unlock()
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			// Rate-limit voice-join with the chat tracker — bouncing
			// voice on/off is rare in normal use, and unlimited toggles
			// would O(N) broadcast voice-peer-{joined,left} forever.
			if !h.checkChatRate(claims.UserID) {
				h.sendErr(sc, "voice rate limit exceeded")
				continue
			}
			peers, err := h.manager.JoinVoice(code, claims.UserID, claims.Username)
			if err != nil {
				h.sendErr(sc, err.Error())
				continue
			}
			// Reply to the JOINER with the list of existing peers so
			// they can initiate outbound offers. The "newcomer initiates"
			// pattern avoids offer-collision races.
			resp := map[string]interface{}{
				"type":    "voice-peers",
				"payload": map[string]interface{}{"peers": peers},
			}
			if data, err := json.Marshal(resp); err == nil {
				sc.SetWriteDeadline(time.Now().Add(partyWriteWait))
				_ = sc.WriteMessage(websocket.TextMessage, data)
			}

		case "voice-leave":
			codeMu.Lock()
			code := currentCode
			codeMu.Unlock()
			if code == "" {
				continue // idempotent — not in a party means nothing to leave
			}
			// M7/M1 — rate-limit voice-leave for symmetry with voice-join.
			// Each leave triggers a voice-peer-left broadcast under ps.mu;
			// an unthrottled client could spam the lock. Reuse the chat
			// tracker (30/min) — humans don't toggle voice this fast.
			if !h.checkChatRate(claims.UserID) {
				h.sendErr(sc, "voice rate limit exceeded")
				continue
			}
			_ = h.manager.LeaveVoice(code, claims.UserID)

		case "voice-offer", "voice-answer", "voice-ice":
			// Targeted relay — server stamps from_user_id and forwards
			// to exactly one peer (the to_user_id in the payload). The
			// chat rate limiter is intentionally NOT used here: ICE
			// candidate trickle can fire 10-50 messages per peer-pair
			// during connection setup, comfortably above 30/min. Targeted
			// fan-out (not broadcast) makes the amplification risk
			// lower than chat/reactions anyway — but we still need SOME
			// limit. Reuse a separate higher tracker.
			codeMu.Lock()
			code := currentCode
			codeMu.Unlock()
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			if !h.checkVoiceSignalRate(claims.UserID) {
				h.sendErr(sc, "voice signal rate limit exceeded")
				continue
			}
			var p voiceSignalPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				h.sendErr(sc, "invalid voice signal payload")
				continue
			}
			if p.ToUserID <= 0 {
				h.sendErr(sc, "to_user_id required")
				continue
			}
			// M7/M3 — voice-offer and voice-answer MUST carry a non-empty
			// SDP. Empty SDP slips past `setRemoteDescription` with
			// `type='offer'/sdp=undefined` which throws on the recipient
			// and tears down their PC. A malicious peer could weaponize
			// this for cheap targeted teardown (no auth needed beyond
			// being-in-voice with the victim). Reject server-side.
			if (msg.Type == "voice-offer" || msg.Type == "voice-answer") && p.SDP == "" {
				h.sendErr(sc, "sdp required for voice-offer/voice-answer")
				continue
			}
			// M7/M4 — cap candidate length defensively. Legitimate ICE
			// candidates are < 300 bytes; 512 is generous headroom. Without
			// the cap, a peer could blast 3500-byte garbage candidates at
			// the relay's rate limit (10/sec) to burn recipient CPU on
			// `addIceCandidate` parse failures.
			if msg.Type == "voice-ice" && len(p.Candidate) > 512 {
				h.sendErr(sc, "ice candidate too long")
				continue
			}
			// Build the forwarded payload from the parsed struct fields —
			// don't pass the raw bytes through. This is the validation
			// boundary: server has parsed and re-serialized, so any
			// fields the client tried to inject beyond the schema are
			// stripped automatically.
			forward := map[string]interface{}{}
			if p.SDP != "" {
				forward["sdp"] = p.SDP
			}
			if msg.Type == "voice-ice" {
				forward["candidate"] = p.Candidate
				forward["sdp_mid"] = p.SDPMid
				if p.SDPMLineIndex != nil {
					forward["sdp_m_line_index"] = *p.SDPMLineIndex
				}
			}
			if err := h.manager.RelayVoiceSignal(code, claims.UserID, p.ToUserID, msg.Type, forward); err != nil {
				h.sendErr(sc, err.Error())
			}

		default:
			h.sendErr(sc, "unknown message type (v3-room): "+msg.Type)
		}
	}
}

func (h *PartyWSHandlerV3Room) sendErr(sc *watchparty.SafeConn, errMsg string) {
	data, err := json.Marshal(map[string]interface{}{
		"type":    "error",
		"payload": map[string]string{"error": errMsg},
	})
	if err != nil {
		return
	}
	sc.SetWriteDeadline(time.Now().Add(partyWriteWait))
	_ = sc.WriteMessage(websocket.TextMessage, data)
}

// checkChatRate: same algorithm as V2, duplicated to keep V3 self-contained
// (step 5 will delete V2's copy).
func (h *PartyWSHandlerV3Room) checkChatRate(userID int64) bool {
	h.rateMu.Lock()
	defer h.rateMu.Unlock()
	now := time.Now()
	if len(h.chatRates) > 100 {
		for uid, t := range h.chatRates {
			if now.After(t.windowEnd) {
				delete(h.chatRates, uid)
			}
		}
	}
	t, ok := h.chatRates[userID]
	if !ok || now.After(t.windowEnd) {
		h.chatRates[userID] = &chatRateTracker{count: 1, windowEnd: now.Add(chatRateWindow)}
		return true
	}
	if t.count >= chatRateLimit {
		return false
	}
	t.count++
	return true
}

// voiceSignalRateLimit allows ~10 signals/second per user. Sized for ICE
// trickle bursts during peer-connection setup (a 4-person mesh fires
// ~150 ICE candidates over 2-3 seconds across all peer-pairs). 600/min
// is comfortably above the worst legitimate burst but below the rate at
// which a malicious client could saturate the relay loop.
const voiceSignalRateLimit = 600

// checkVoiceSignalRate is the voice-signaling rate limiter. Same window
// (60s) as chat, but a much higher count to accommodate ICE trickle.
// Lazy-cleans expired entries to bound the map.
func (h *PartyWSHandlerV3Room) checkVoiceSignalRate(userID int64) bool {
	h.rateMu.Lock()
	defer h.rateMu.Unlock()
	now := time.Now()
	if len(h.voiceRates) > 100 {
		for uid, t := range h.voiceRates {
			if now.After(t.windowEnd) {
				delete(h.voiceRates, uid)
			}
		}
	}
	t, ok := h.voiceRates[userID]
	if !ok || now.After(t.windowEnd) {
		h.voiceRates[userID] = &chatRateTracker{count: 1, windowEnd: now.Add(chatRateWindow)}
		return true
	}
	if t.count >= voiceSignalRateLimit {
		return false
	}
	t.count++
	return true
}
