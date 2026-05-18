package websocket

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Maximum number of queued messages per client before disconnect
	sendBufferSize = 64

	// WebSocket health check parameters
	maxMessageSize = 4096              // max inbound message size (bytes)
	pongWait       = 60 * time.Second  // time allowed to read the next pong
	pingInterval   = 50 * time.Second  // must be less than pongWait
	writeWait      = 10 * time.Second  // time allowed to write a message
)

// OriginChecker returns true if a given origin is allowed to connect.
type OriginChecker func(origin string) bool

// client wraps a single WebSocket connection with a buffered send channel
// to serialize writes (gorilla/websocket requires one writer at a time).
//
// remoteAddr is captured at construction so eviction-path logging works
// even after the underlying conn is closed (calling conn.RemoteAddr() on
// a closed gorilla connection can return stale or empty data depending on
// version).
type client struct {
	conn       *websocket.Conn
	send       chan []byte
	closeOnce  sync.Once
	userID     int64
	role       string // "admin" or "user"
	remoteAddr string // captured at HandleConnect; safe to read after conn closes
}

// closeSend safely closes the send channel exactly once.
// Called by both the reader goroutine (on disconnect) and
// the broadcast eviction path (on slow client), so must be idempotent.
func (c *client) closeSend() {
	c.closeOnce.Do(func() {
		close(c.send)
	})
}

// Hub manages WebSocket connections and broadcasts messages
type Hub struct {
	mu       sync.RWMutex
	clients  map[*client]bool
	upgrader websocket.Upgrader
}

func NewHub(checkOrigin OriginChecker) *Hub {
	h := &Hub{
		clients: make(map[*client]bool),
	}
	h.upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true // non-browser clients (e.g. curl) don't send Origin
			}
			if checkOrigin == nil {
				return false // deny by default if no checker configured
			}
			return checkOrigin(origin)
		},
	}
	return h
}

// HandleConnectAuth upgrades an HTTP connection to WebSocket with user identity.
func (h *Hub) HandleConnectAuth(w http.ResponseWriter, r *http.Request, userID int64, role string) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("websocket upgrade failed", "error", err)
		return
	}

	c := &client{
		conn:       conn,
		send:       make(chan []byte, sendBufferSize),
		userID:     userID,
		role:       role,
		remoteAddr: conn.RemoteAddr().String(),
	}

	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()

	slog.Debug("websocket client connected", "remote", conn.RemoteAddr(), "user_id", userID)

	// Configure read limits and deadlines for connection health
	conn.SetReadLimit(maxMessageSize)
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Writer goroutine: serializes all writes and sends periodic pings
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer func() {
			ticker.Stop()
			conn.Close()
		}()
		for {
			select {
			case msg, ok := <-c.send:
				if !ok {
					// Channel closed, send close frame
					conn.WriteControl(websocket.CloseMessage, nil, time.Now().Add(writeWait))
					return
				}
				conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					slog.Debug("write to client failed", "error", err)
					return
				}
			case <-ticker.C:
				conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	// Reader goroutine: keeps connection alive, handles disconnects
	go func() {
		defer func() {
			h.mu.Lock()
			delete(h.clients, c)
			h.mu.Unlock()
			c.closeSend() // stops the writer goroutine (safe if already closed by broadcast eviction)
			slog.Debug("websocket client disconnected", "remote", conn.RemoteAddr(), "user_id", userID)
		}()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
}

// Broadcast sends a JSON message to all connected clients
func (h *Hub) Broadcast(eventType string, data interface{}) {
	payload := marshalEvent(eventType, data)
	if payload == nil {
		return
	}
	h.broadcastPayload(payload, nil)
}

// BroadcastToAdmins sends a JSON message only to admin-role clients.
func (h *Hub) BroadcastToAdmins(eventType string, data interface{}) {
	payload := marshalEvent(eventType, data)
	if payload == nil {
		return
	}
	h.broadcastPayload(payload, func(c *client) bool {
		return c.role == "admin"
	})
}

// BroadcastToUser sends a JSON message to a specific user's connected clients.
func (h *Hub) BroadcastToUser(userID int64, eventType string, data interface{}) {
	payload := marshalEvent(eventType, data)
	if payload == nil {
		return
	}
	h.broadcastPayload(payload, func(c *client) bool {
		return c.userID == userID
	})
}

// ClientCount returns the number of connected clients
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// marshalEvent creates a JSON payload for a WebSocket event.
func marshalEvent(eventType string, data interface{}) []byte {
	msg := map[string]interface{}{
		"type": eventType,
		"data": data,
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		slog.Error("marshal broadcast", "error", err)
		return nil
	}
	return payload
}

// broadcastPayload sends a pre-marshaled payload to clients matching the filter.
// If filter is nil, sends to all clients.
func (h *Hub) broadcastPayload(payload []byte, filter func(*client) bool) {
	// Collect slow clients during RLock phase, then evict after releasing it.
	h.mu.RLock()
	var slow []*client
	for c := range h.clients {
		if filter != nil && !filter(c) {
			continue
		}
		select {
		case c.send <- payload:
			// queued successfully
		default:
			slow = append(slow, c)
		}
	}
	h.mu.RUnlock()

	if len(slow) > 0 {
		h.mu.Lock()
		for _, c := range slow {
			slog.Debug("client send buffer full, dropping", "remote", c.remoteAddr)
			delete(h.clients, c)
		}
		h.mu.Unlock()
		// Close send channels outside the lock to avoid holding it during I/O
		for _, c := range slow {
			c.closeSend()
		}
	}
}
