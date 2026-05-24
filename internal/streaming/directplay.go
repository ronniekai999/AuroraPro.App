// Direct-play session registry.
//
// Background: transcode streams have a clear lifecycle handle (the
// FFmpeg process tracked by TranscodeManager), so the Admin → Active
// Streams tab can list them by walking TranscodeManager.sessions.
// Direct-play (no transcode) sessions have no such handle — they're
// just a series of HTTP range requests against http.ServeFile, and
// "the stream is over" is signaled implicitly by "no more requests
// from this client for a while".
//
// This registry fills that gap with a touch-and-expire map: a session
// is created on the first byte-serve for a (user, file) tuple and
// extended on every subsequent byte-serve. After `TTL` of inactivity
// it's GC'd. Admin endpoints can then list active direct-play streams
// alongside active transcodes for a unified "Now Streaming" view.
package streaming

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// DirectPlaySession describes a single in-flight direct-play stream.
// Fields are intentionally JSON-tagged so the admin endpoint can
// marshal them straight onto the wire.
type DirectPlaySession struct {
	ID       string    `json:"id"`
	UserID   int64     `json:"user_id"`
	Username string    `json:"username,omitempty"`
	// FileType is the resource kind the user is streaming: "media"
	// (a movie file) or "episode" (a TV episode file).
	FileType  string `json:"file_type"`
	FileID    int64  `json:"file_id"`
	FileName  string `json:"file_name,omitempty"`
	// Decision is "direct_play" (no remux, no transcode) or
	// "direct_stream" (codec-copy remux — still no transcode, but
	// container repackaged). Both share this registry because
	// neither holds an FFmpeg process the way transcode does.
	Decision   string    `json:"decision"`
	StartedAt  time.Time `json:"started_at"`
	LastAccess time.Time `json:"last_access"`
}

// DirectPlayRegistry is the in-memory tracker. Safe for concurrent use.
type DirectPlayRegistry struct {
	mu       sync.Mutex
	sessions map[string]*DirectPlaySession // key: userID|fileType|fileID
	byID     map[string]string             // sessionID → key, for quick End()
	ttl      time.Duration
	stopGC   chan struct{}
}

// NewDirectPlayRegistry returns an initialized registry and starts the
// background GC goroutine. Caller should hold the registry for the
// lifetime of the server; Close() stops the GC. ttl bounds "how long
// after the last byte-serve do we consider the session still active";
// ~60s is a good default — direct-play clients re-request bytes
// frequently enough that 60s covers normal seek-buffer gaps without
// false-positiving paused players forever.
func NewDirectPlayRegistry(ttl time.Duration) *DirectPlayRegistry {
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	r := &DirectPlayRegistry{
		sessions: make(map[string]*DirectPlaySession),
		byID:     make(map[string]string),
		ttl:      ttl,
		stopGC:   make(chan struct{}),
	}
	go r.gcLoop()
	return r
}

// Close stops the GC goroutine. Idempotent.
func (r *DirectPlayRegistry) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	select {
	case <-r.stopGC:
		// already closed
	default:
		close(r.stopGC)
	}
}

// Touch records (or extends) a direct-play session for the given
// (user, file) tuple. The first call creates the session; subsequent
// calls just bump LastAccess.
//
// Returns the session ID so callers can later End() if they have a
// definitive close signal (e.g., the player explicitly stopped). In
// practice most direct-play sessions are ended via the TTL sweep,
// not via End(), because HTTP range requests don't give us a clean
// shutdown signal.
func (r *DirectPlayRegistry) Touch(userID int64, username, fileType string, fileID int64, fileName, decision string) string {
	key := makeKey(userID, fileType, fileID)
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	if existing, ok := r.sessions[key]; ok {
		existing.LastAccess = now
		return existing.ID
	}
	id := newSessionID()
	r.sessions[key] = &DirectPlaySession{
		ID:         id,
		UserID:     userID,
		Username:   username,
		FileType:   fileType,
		FileID:     fileID,
		FileName:   fileName,
		Decision:   decision,
		StartedAt:  now,
		LastAccess: now,
	}
	r.byID[id] = key
	return id
}

// End removes a session by ID. Idempotent — calling on an already-
// expired or never-existed ID is a no-op. Used by an explicit
// player-stop hook if/when we wire one; the TTL sweep handles the
// no-explicit-stop case.
func (r *DirectPlayRegistry) End(sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if key, ok := r.byID[sessionID]; ok {
		delete(r.sessions, key)
		delete(r.byID, sessionID)
	}
}

// List returns a snapshot of all sessions whose LastAccess is within
// TTL. Sessions that fell behind TTL but haven't been swept yet are
// excluded — important so the admin UI doesn't briefly show a stale
// session between an inactivity event and the next GC tick.
func (r *DirectPlayRegistry) List() []DirectPlaySession {
	cutoff := time.Now().Add(-r.ttl)
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]DirectPlaySession, 0, len(r.sessions))
	for _, s := range r.sessions {
		if s.LastAccess.After(cutoff) {
			out = append(out, *s)
		}
	}
	return out
}

// ActiveCount mirrors List but returns just the count. Used by the
// admin dashboard tile that shows "Active Streams" alongside the
// transcode count.
func (r *DirectPlayRegistry) ActiveCount() int {
	cutoff := time.Now().Add(-r.ttl)
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, s := range r.sessions {
		if s.LastAccess.After(cutoff) {
			n++
		}
	}
	return n
}

// gcLoop runs in a background goroutine, sweeping expired sessions
// every TTL/2 seconds. The sweep is bounded by the registry's own
// lock; List/Touch contend with it briefly.
func (r *DirectPlayRegistry) gcLoop() {
	t := time.NewTicker(r.ttl / 2)
	defer t.Stop()
	for {
		select {
		case <-r.stopGC:
			return
		case <-t.C:
			r.sweep()
		}
	}
}

func (r *DirectPlayRegistry) sweep() {
	cutoff := time.Now().Add(-r.ttl)
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, s := range r.sessions {
		if !s.LastAccess.After(cutoff) {
			delete(r.sessions, key)
			delete(r.byID, s.ID)
		}
	}
}

func makeKey(userID int64, fileType string, fileID int64) string {
	// userID and fileID are int64, fileType is bounded ("media"/"episode").
	// A string concat keyed off these three uniquely identifies a
	// (user, file) playback — different users get separate entries
	// for the same file (so two admins watching the same movie show
	// as two streams, not one).
	b := make([]byte, 0, 32)
	b = appendInt64(b, userID)
	b = append(b, '|')
	b = append(b, fileType...)
	b = append(b, '|')
	b = appendInt64(b, fileID)
	return string(b)
}

func appendInt64(b []byte, n int64) []byte {
	if n == 0 {
		return append(b, '0')
	}
	neg := n < 0
	if neg {
		n = -n
		b = append(b, '-')
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return append(b, buf[i:]...)
}

func newSessionID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "dp_" + hex.EncodeToString(b[:])
}
