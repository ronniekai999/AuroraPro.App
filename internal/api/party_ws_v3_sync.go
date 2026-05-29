package api

// ============================================================
// Watch Party V3 — Sync Socket (/ws/party-sync)
// ============================================================
//
// High-frequency, low-payload channel. Carries the sync protocol:
//
//   Server → client:  tick, pause, seek, hello, party-ended
//   Client → server:  join-party, request-play, request-pause,
//                     request-seek, heartbeat, time-sync
//
// Coexists with /ws/party (V2) during rollout. The client opens this
// socket AFTER successfully opening /ws/party-room, because the room
// socket is what establishes participant membership in the party.

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

// PartyWSHandlerV3Sync handles /ws/party-sync. One instance per server,
// shared across all connections.
type PartyWSHandlerV3Sync struct {
	manager      *watchparty.Manager
	authSvc      *auth.Service
	versionStore *auth.TokenVersionStore
	upgrader     websocket.Upgrader
}

// NewPartyWSHandlerV3Sync constructs the handler.
// originAllowed gates browser-originated upgrades — see
// websocketOriginChecker in helpers.go for the policy. Pass
// cfg.OriginAllowed.
func NewPartyWSHandlerV3Sync(manager *watchparty.Manager, authSvc *auth.Service, versionStore *auth.TokenVersionStore, originAllowed func(string) bool) *PartyWSHandlerV3Sync {
	return &PartyWSHandlerV3Sync{
		manager:      manager,
		authSvc:      authSvc,
		versionStore: versionStore,
		upgrader: websocket.Upgrader{
			CheckOrigin:     websocketOriginChecker(originAllowed),
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
		},
	}
}

// V3-sync wire payloads. Field names mirror docs/watchparty-v3.md §3.
type v3RequestPlayPayload struct {
	FromMs int64 `json:"from_ms,omitempty"`
}
type v3RequestPausePayload struct {
	AtMs int64 `json:"at_ms"`
}
type v3RequestSeekPayload struct {
	ToMs int64 `json:"to_ms"`
}
type v3HeartbeatPayload struct {
	AbsMs         int64 `json:"abs_ms"`
	ReadyState    int   `json:"ready_state"`
	BufferedEndMs int64 `json:"buffered_end_ms,omitempty"`
}

func (h *PartyWSHandlerV3Sync) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireQueryTokenClaims(w, r, h.authSvc, h.versionStore)
	if !ok {
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("v3 sync upgrade failed", "err", err, "user_id", claims.UserID)
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

	// Ping goroutine — same cadence as V2.
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
			// Guarded leave: only evict if THIS conn is still the registered
			// one, so a fast reconnect (which already replaced sc in syncConns)
			// isn't torn down by this stale defer. Mirrors the room socket.
			// deep-debug MED (the previous unconditional call was the live bug;
			// the IfConn guard had been added but never wired here).
			h.manager.LeavePartyV3SyncIfConn(code, claims.UserID, sc)
		}
		_ = conn.Close()
		slog.Debug("v3 sync disconnected", "user_id", claims.UserID)
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Debug("v3 sync read err", "user_id", claims.UserID, "err", err)
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
			// Leave previous party's sync pool first.
			codeMu.Lock()
			if currentCode != "" && currentCode != p.PartyCode {
				h.manager.LeavePartyV3Sync(currentCode, claims.UserID)
			}
			codeMu.Unlock()

			if err := h.manager.JoinPartyV3Sync(p.PartyCode, claims.UserID, sc); err != nil {
				h.sendErr(sc, err.Error())
				continue
			}
			codeMu.Lock()
			currentCode = p.PartyCode
			codeMu.Unlock()

		case "request-play":
			code := h.currentCode(&codeMu, &currentCode)
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			if err := h.manager.HandleRequestPlay(code, claims.UserID); err != nil {
				h.sendErr(sc, err.Error())
			}

		case "request-pause":
			code := h.currentCode(&codeMu, &currentCode)
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			var p v3RequestPausePayload
			p.AtMs = -1 // signal "use current canonical position"
			_ = json.Unmarshal(msg.Payload, &p)
			if err := h.manager.HandleRequestPause(code, claims.UserID, p.AtMs); err != nil {
				h.sendErr(sc, err.Error())
			}

		case "request-seek":
			code := h.currentCode(&codeMu, &currentCode)
			if code == "" {
				h.sendErr(sc, "not in a party")
				continue
			}
			var p v3RequestSeekPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				h.sendErr(sc, "invalid request-seek payload")
				continue
			}
			if err := h.manager.HandleRequestSeek(code, claims.UserID, p.ToMs); err != nil {
				h.sendErr(sc, err.Error())
			}

		case "heartbeat":
			code := h.currentCode(&codeMu, &currentCode)
			if code == "" {
				continue
			}
			var p v3HeartbeatPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				continue
			}
			h.manager.HandleV3Heartbeat(code, claims.UserID, p.AbsMs, p.ReadyState)

		case "time-sync":
			serverRecvMs := time.Now().UnixMilli()
			code := h.currentCode(&codeMu, &currentCode)
			var p timeSyncPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				continue
			}
			resp, err := h.manager.HandleTimeSync(code, claims.UserID, p.ClientSendMs, serverRecvMs)
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
			if code != "" && (p.MeasuredRTTms > 0 || p.MeasuredOffsetMs != 0) {
				h.manager.RecordRTT(code, claims.UserID, p.MeasuredRTTms, p.MeasuredOffsetMs)
			}

		default:
			h.sendErr(sc, "unknown message type (v3-sync): "+msg.Type)
		}
	}
}

// currentCode reads the currently-joined party code under codeMu. Factored
// out because the pattern appears on every message dispatch arm.
func (h *PartyWSHandlerV3Sync) currentCode(mu *sync.Mutex, code *string) string {
	mu.Lock()
	defer mu.Unlock()
	return *code
}

func (h *PartyWSHandlerV3Sync) sendErr(sc *watchparty.SafeConn, errMsg string) {
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
