package watchparty

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/notify"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/gorilla/websocket"
)

// ============================================================
// Types
// ============================================================

// PartySettings defines configurable behavior for a watch party.
type PartySettings struct {
	AllowPause      bool `json:"allow_pause"`
	AllowChat       bool `json:"allow_chat"`
	MaxParticipants int  `json:"max_participants"`
	// SpoilerFreeStart gates the host's first request-play on every
	// non-host participant having marked themselves Ready. Prevents the
	// "host hit play before everyone's actually buffered / paying
	// attention" scenario that produces 10-second sync gaps and missed
	// opening scenes. M5 fix.
	//
	// Applies to the FIRST play EVER in this PartyState lifetime
	// (HasEverPlayed=false). After that, snack-break pauses and resumes
	// don't re-gate. Also DOES NOT re-gate on ChangeMedia (episode auto-
	// advance) — already-watching guests don't need to re-Ready to
	// continue watching the next episode. Ready state per participant
	// likewise persists across ChangeMedia. Implementation:
	// HandleRequestPlay checks `!ps.HasEverPlayed && ps.Settings.SpoilerFreeStart`.
	SpoilerFreeStart bool `json:"spoiler_free_start"`
}

// SafeConn wraps a gorilla/websocket.Conn with a write mutex and a
// buffered outbound queue drained by a per-connection write pump.
//
// gorilla/websocket does not support concurrent writers, so all writes
// (pings, broadcasts, direct messages) serialize through writeMu.
//
// 2026-06 watch-party review (speed finding) — broadcasts used to call
// WriteMessage synchronously, several of them while holding ps.mu. One
// participant with a stalled TCP connection could block every state
// mutation in the party (joins, pause, chat) for up to the 10s write
// deadline. Broadcast paths now call Send, which enqueues onto `outbox`
// without blocking; the pump goroutine owns the slow socket. A peer whose
// queue overflows (outboxSize messages behind, ≈16s of ticks) is treated
// as dead: the conn is closed so its read pump unblocks and the normal
// disconnect cleanup runs. This is the standard gorilla chat-hub pattern.
type SafeConn struct {
	conn    *websocket.Conn
	writeMu sync.Mutex

	// Write-pump state. nil outbox/done means a zero-value SafeConn
	// (tests construct &SafeConn{} directly) — Send degrades to a
	// direct write and Close to a plain conn close.
	outbox    chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

// outboxSize bounds the per-connection send queue. At the 250ms tick
// cadence, 64 messages is ~16s of sync traffic — far beyond what a
// healthy client ever queues (writes complete in milliseconds), and a
// reasonable burst allowance for chat/reaction fan-out.
const outboxSize = 64

// ErrConnClosed is returned by Send when the connection is closed (or
// has just been closed because its outbound queue overflowed).
var ErrConnClosed = errors.New("watchparty: connection closed")

// NewSafeConn creates a SafeConn wrapping the given connection and starts
// its write pump. Callers MUST call Close when done with the connection
// (the WS handlers' deferred cleanup does) or the pump goroutine leaks.
func NewSafeConn(conn *websocket.Conn) *SafeConn {
	sc := &SafeConn{
		conn:   conn,
		outbox: make(chan []byte, outboxSize),
		done:   make(chan struct{}),
	}
	go sc.writePump()
	return sc
}

// writePump drains the outbox onto the socket. Owned by NewSafeConn.
// Exits when Close is called or a write fails (in which case it closes
// the conn itself so the read pump unblocks and cleanup runs).
func (sc *SafeConn) writePump() {
	for {
		select {
		case <-sc.done:
			return
		case data := <-sc.outbox:
			// Fresh deadline per write — see broadcastWriteTimeout for
			// the stale-deadline production bug this prevents.
			if err := sc.writeTextBy(data, time.Now().Add(broadcastWriteTimeout)); err != nil {
				_ = sc.Close()
				return
			}
		}
	}
}

// Send enqueues a text message for the write pump without blocking.
// Returns ErrConnClosed when the connection is closed, or when the
// outbound queue is full — in which case the peer is presumed dead/stuck
// and the connection is closed so its cleanup path runs. Safe to call
// while holding ps.mu (never blocks on socket I/O).
func (sc *SafeConn) Send(data []byte) error {
	if sc.outbox == nil {
		// Zero-value SafeConn (tests): degrade to a direct write, or
		// discard when there's no underlying conn at all.
		if sc.conn == nil {
			return nil
		}
		return sc.writeTextBy(data, time.Now().Add(broadcastWriteTimeout))
	}
	select {
	case <-sc.done:
		return ErrConnClosed
	default:
	}
	select {
	case sc.outbox <- data:
		return nil
	case <-sc.done:
		return ErrConnClosed
	default:
		// Queue overflow: the peer hasn't drained ~16s of traffic. Close
		// the conn (unblocks its read pump → disconnect cleanup) rather
		// than dropping arbitrary messages on a conn we'd keep trusting.
		_ = sc.Close()
		return ErrConnClosed
	}
}

// WriteMessage acquires the write mutex before writing. Prefer Send for
// anything called under ps.mu; direct writes are for per-client
// request/response traffic in the WS handlers (hello, snapshots, errors).
func (sc *SafeConn) WriteMessage(messageType int, data []byte) error {
	sc.writeMu.Lock()
	defer sc.writeMu.Unlock()
	return sc.conn.WriteMessage(messageType, data)
}

// WriteControl acquires the write mutex before writing a control message.
func (sc *SafeConn) WriteControl(messageType int, data []byte, deadline time.Time) error {
	sc.writeMu.Lock()
	defer sc.writeMu.Unlock()
	return sc.conn.WriteControl(messageType, data, deadline)
}

// SetWriteDeadline sets the write deadline on the underlying connection.
//
// Under writeMu like the writes: gorilla keeps the deadline in a plain field
// that every write reads, and this conn has two writers (the pump, and the
// handler's read loop answering time-sync probes and errors directly), so an
// unlocked set raced the other goroutine's write.
func (sc *SafeConn) SetWriteDeadline(t time.Time) error {
	sc.writeMu.Lock()
	defer sc.writeMu.Unlock()
	return sc.conn.SetWriteDeadline(t)
}

// writeTextBy writes one text message with the given deadline, both under a
// single writeMu hold, so the write cannot pick up another writer's deadline
// in between.
func (sc *SafeConn) writeTextBy(data []byte, deadline time.Time) error {
	sc.writeMu.Lock()
	defer sc.writeMu.Unlock()
	_ = sc.conn.SetWriteDeadline(deadline)
	return sc.conn.WriteMessage(websocket.TextMessage, data)
}

// Close stops the write pump and closes the underlying connection.
// Idempotent — every teardown path (handler defer, endPartyInternal,
// queue overflow, pump write failure) can call it safely.
func (sc *SafeConn) Close() error {
	var err error
	sc.closeOnce.Do(func() {
		if sc.done != nil {
			close(sc.done)
		}
		if sc.conn != nil {
			err = sc.conn.Close()
		}
	})
	return err
}

// Participant tracks a single connected user in a watch party.
//
// IsBuffering mirrors the peer's last self-reported readyState
// (< HAVE_FUTURE_DATA ⇒ buffering, see HandleV3Heartbeat) for presence
// display only — V3 never blocks the group on a buffering peer.
//
// LastSeen drives the stale-party reaper (CleanupStale). Refreshed on
// join/reconnect, on room-socket heartbeats (TouchParticipant), and on
// sync-socket heartbeats (HandleV3Heartbeat).
type Participant struct {
	UserID        int64     `json:"user_id"`
	Username      string    `json:"username"`
	IsHost        bool      `json:"is_host"`
	IsBuffering   bool      `json:"is_buffering"`
	LastSeen      time.Time `json:"last_seen"`
	LastRTTms     int64     `json:"-"`
	ClockOffsetMs int64     `json:"-"`
	// Ready is the per-participant "I'm ready to start watching" signal
	// for M5's spoiler-free start gate. Human-driven — the participant
	// clicked "I'm Ready" in the lobby UI. Reset to false when the party
	// transitions to a new session (e.g. media-change).
	Ready bool `json:"ready"`

	// Companion marks a participant that joined via the mobile companion
	// surface (the phone "second screen" — chat/voice/emoji only, no video
	// player, no /ws/party-sync). Set when the room-socket upgrade carries
	// the `?companion=1` query param (see PartyWSHandlerV3Room.ServeHTTP).
	//
	// Purely additive and advisory: it lets the frontend render a "📱 on
	// phone" affordance and lets future logic treat a companion's
	// disconnect differently from a primary-screen disconnect. When false
	// (the default, and the value for every existing/desktop client),
	// behavior is identical to before this field existed. It is NOT
	// persisted to the DB — it's a live-presence attribute only.
	Companion bool `json:"companion"`

	// JoinedAt is the moment this participant's CURRENT tenure began.
	// Slot-replacement reconnects keep it (the entry survives; the
	// reconnect path only refreshes conn + LastSeen), but a fully
	// cleaned-up leaver who rejoins mints a fresh one — a senior guest
	// who blips completely can lose succession seniority to a junior
	// one, which is accepted: tenure, not lifetime attendance, is the
	// claim. Host succession orders candidates by it
	// (promoteSuccessorLocked). Zero on entries created before the field
	// existed (in-memory state only, so just parties live across a
	// deploy); zero sorts earliest, which is the right answer — those
	// entries are by definition the oldest. Not serialized: party-state
	// participants are hand-built in BuildPartyStateMessage, which
	// deliberately doesn't include it.
	JoinedAt time.Time `json:"-"`
}

// ChatMessage represents a single chat message in the party history.
type ChatMessage struct {
	ID        string    `json:"id"`
	UserID    int64     `json:"user_id"`
	Username  string    `json:"username"`
	Message   string    `json:"message"`
	Timestamp time.Time `json:"timestamp"`
}

// ReactionRecord captures a single reaction with the moment-in-the-movie it
// was sent at. M6 introduced this for the Twitch-style overlay (so the
// client knows which timestamp this reaction belongs to even if delivery
// was delayed) and for M9's reaction-timeline / highlight-reel.
//
// AbsMs is the absolute source position (NOT the HLS-relative seconds)
// the participant was watching when they sent the reaction. The wire
// protocol's coordinate space. See manager.go's coordinate-space comment.
// Validated server-side: clamped to the party's current position ±
// reactionAbsMsClampWindow; outliers fall back to CurrentAbsMs().
//
// CreatedAt is the wall-clock instant the server accepted the reaction —
// distinct from AbsMs (movie position) so we can both "show the floating
// emoji NOW" and "tag the moment in the timeline at AbsMs".
type ReactionRecord struct {
	UserID    int64     `json:"user_id"`
	Username  string    `json:"username"`
	Emoji     string    `json:"emoji"`
	AbsMs     int64     `json:"abs_ms"`
	CreatedAt time.Time `json:"created_at"`
}

// HostDisconnectGracePeriod — how long the server keeps a party alive
// after the host's room WebSocket drops unexpectedly. Lets the host
// recover from a transient network blip, browser tab throttle, proxy
// idle timeout, or page reload without taking the whole party down
// with them. Explicit `leave-party` from the host still ends the
// party immediately (deliberate user action).
//
// 90s matches partyPongWait in the WS handler — i.e. roughly the
// longest a single network glitch could plausibly take to recover.
const HostDisconnectGracePeriod = 90 * time.Second

// broadcastWriteTimeout — max time to wait for a single outbound
// write to land on a participant's conn before considering it dead.
//
// History: 2026-05-25, a stale 10s deadline set by the initial
// party-state send silently broke every subsequent broadcast to the
// host with ErrDeadlineExceeded (host saw no participant-join, chat,
// or reactions). The fix was a fresh deadline immediately before each
// write. 2026-06, broadcasts moved onto per-conn write pumps
// (SafeConn.writePump) which set this deadline before every pump
// write; the remaining direct-write call sites (hello, snapshots,
// teardown party-ended) still set it explicitly.
//
// 10s matches partyWriteWait used elsewhere — a healthy LAN/WAN write
// completes in milliseconds; if it takes 10s the conn is genuinely
// hosed and we want to mark it failed + clean up.
const broadcastWriteTimeout = 10 * time.Second

// PartyState is the authoritative in-memory state for an active watch party.
// The mu field is a per-party mutex that protects the mutable fields
// (anchor, Participants, ChatHistory, conn pools).
// The Manager's top-level mu protects the parties map itself (add/remove/lookup).
//
// StateRevision increments on every broadcasted state change. Clients ignore
// any incoming snapshot whose revision is <= the highest they have seen, which
// makes out-of-order delivery and replays idempotent.
type PartyState struct {
	mu sync.Mutex // guards mutable fields below

	Code          string
	HostUserID    int64
	MediaItemID   int64
	EpisodeID     *int64
	MediaTitle    string
	MediaPoster   string
	PartyName     string
	StateRevision uint64
	Participants  map[int64]*Participant
	ChatHistory   []ChatMessage // ring buffer, max chatHistoryMax

	// Reactions is M6's per-party ring buffer of emoji reactions tagged
	// with the moment-in-the-movie they were sent at. Used by:
	//   - M6 floating-emoji overlay (delivered live via broadcast; this
	//     buffer is not needed for live UX — it's for replay / timeline).
	//   - M9 timeline UI (seekbar dots at each AbsMs).
	//   - M9 highlight-reel auto-export (top-N most-reacted moments).
	// Capped at reactionsRingBufferMax; oldest entries drop FIFO.
	// Guarded by ps.mu like everything else on PartyState.
	Reactions []ReactionRecord

	Settings        PartySettings
	CreatedAt       time.Time
	MaxParticipants int
	dbID            int64 // database row ID for participant tracking

	// M3 (migration 021) — link to the long-lived room. Quick parties have
	// IsRoomPersistent=false; their room is soft-deleted when the session
	// ends. Persistent rooms (IsRoomPersistent=true) survive session ends
	// so friends can rejoin under the same stable code. The two-table
	// split lets us model "join code is stable across sessions" without
	// fighting the existing party-as-session semantics.
	roomDBID         int64
	IsRoomPersistent bool

	// HasEverPlayed tracks whether playback has been initiated at least
	// once in this session. Used by M5's spoiler-free start gate: only
	// the FIRST request-play is gated on all participants being Ready.
	// After that, pause/play work normally even if guests un-ready (e.g.
	// snack break, sudden buffer hiccup). Flipped to true the first time
	// request-play succeeds.
	HasEverPlayed bool

	// HostDisconnectGracePeriod — 2026-05-25 fix for "party dies the
	// instant the host's room WebSocket drops". Previous behavior:
	// LeavePartyV3Room called endPartyInternal immediately when isHost.
	// Caught in production at aurorapro.app: host's room WS hit a 90s
	// idle/proxy timeout, server cleaned up → guests got 404s on the
	// shared code → "we never see them on our end, show never starts."
	//
	// HostDisconnectedAt is set when the host's room WS closes
	// unexpectedly (NOT on explicit leave-party — that path hands the
	// party off, or ends it when nobody eligible remains, immediately).
	// If non-nil and the host's WS hasn't reconnected within
	// HostGracePeriod, a background goroutine hands the party to the
	// most senior remaining participant (2026-08 host succession;
	// reapExpiredHostGrace) — or ends it if no one eligible is left.
	// If the host's room WS reconnects in that window, the field is
	// cleared and the goroutine no-ops on next check.
	//
	// Defended by ps.mu like every other field on PartyState.
	HostDisconnectedAt *time.Time

	// ============================================================
	// V3 "Running/Paused" model — the only sync protocol since the
	// 2026-06 V2 deletion ("step 5" of the V3 execution plan).
	// ============================================================
	// Canonical position is derived from an anchor:
	//
	//   CurrentAbsMs() = AnchorAbsMs + (now - AnchorServerAt)   (if Running)
	//                  = AnchorAbsMs                            (if Paused)
	//
	// The anchor is updated on request-play, request-pause, request-seek,
	// media-change, and party-create (seeded from the host's resume offset).
	//
	// AnchorServerAt is a time.Time (not a unix-ms int) so the elapsed
	// computation uses Go's monotonic clock — an NTP step on the server
	// can no longer jump every running party's position (2026-06 review).
	// Wall-clock values still go on the wire (server_now_ms) for client
	// offset estimation; only the server-side elapsed math is monotonic.
	Running        bool
	AnchorAbsMs    int64
	AnchorServerAt time.Time

	// Separate WebSocket pools for V3's two-socket model. Sync traffic
	// (tick/pause/seek/heartbeat/time-sync) rides syncConns. Room traffic
	// (chat/reaction/presence) rides roomConns.
	syncConns map[int64]*SafeConn
	roomConns map[int64]*SafeConn

	// M7 — voice presence. The set of user IDs currently in the voice
	// call. The server is ONLY a JSON signaling relay (offers, answers,
	// ICE candidates between peers); audio bytes flow directly
	// browser-to-browser over WebRTC. Mesh topology: O(N^2) connections
	// across the party, fine up to ~4 participants. M8 upgrades to SFU
	// (Pion's ion-sfu) for larger parties. Guarded by ps.mu like
	// everything else on PartyState. A user dropping their room socket
	// is implicitly removed from voice (LeavePartyV3Room calls
	// leaveVoiceLocked); voice state never outlives the room socket.
	VoiceParticipants map[int64]bool

	// Tick goroutine lifecycle. When Running transitions to true, a
	// per-party goroutine starts emitting tick broadcasts every 250ms
	// over syncConns. tickCancel stops it cleanly on pause or party end.
	tickCancel context.CancelFunc

	// ending is set (under ps.mu) at the top of endPartyInternal and never
	// cleared: teardown releases ps.mu midway (socket I/O + DB happen
	// unlocked), so for a window the party is dying but still present in
	// m.parties with its mutex takeable. 2026-08 host succession gave the
	// paths that can win that window (grace reap, host-leave promotion,
	// scheduled-start retry) NON-idempotent, liveness-creating actions —
	// promoting a host on a dying party, or worst case starting a fresh
	// tick loop after stopTickLoopLocked already ran, leaking the
	// goroutine forever once the party leaves the map. Every such action
	// now checks this flag first; a second endPartyInternal is a no-op.
	ending bool

	// ============================================================
	// Host-controlled countdown (migration 019).
	// ============================================================
	// ScheduledStartAt is the host's planned playback start moment. When
	// non-nil and in the future, a per-party goroutine sleeps until this
	// time then broadcasts "party-starting" + transitions to playing.
	// nil = no schedule, host plays manually.
	//
	// StartedAt records the actual moment playback began (either when the
	// scheduled timer fired, or on the first manual play of an unscheduled
	// party). Useful for late joiners and for analytics.
	//
	// scheduleCancel is the cancellation hook for the schedule goroutine.
	// Set inside ps.mu when starting; cleared when fired or cancelled.
	// Mirrors the tickCancel pattern.
	ScheduledStartAt *time.Time
	StartedAt        *time.Time
	scheduleCancel   context.CancelFunc
	// scheduleFiring is true while a fireScheduledStart invocation is in
	// flight (between its dedup check and its play attempt). Collapses
	// concurrent fires — countdown timer racing a retry — to one, so
	// clients can't receive duplicate "party-starting" broadcasts.
	scheduleFiring bool
	// reminderSentFor records the scheduled start the T-10 reminder was
	// already sent for (migration 051 invites). Reminder goroutines
	// self-validate against the current ScheduledStartAt at fire time,
	// and this pointer collapses double-arms
	// for the same target (e.g. CreateParty arming, then a same-time
	// reschedule) to one send. Reschedules to a NEW time compare unequal
	// and legitimately remind again.
	reminderSentFor *time.Time
	reminderCancel  context.CancelFunc
}

// Lock acquires the party-level mutex. Exported for cross-package use by handlers
// that need to read mutable fields (Participants, the playback anchor, etc.).
func (ps *PartyState) Lock() {
	ps.mu.Lock()
}

// Unlock releases the party-level mutex.
func (ps *PartyState) Unlock() {
	ps.mu.Unlock()
}

// SyncConfig holds the tuning parameters for the V3 sync protocol. Lives in
// the watchparty package so this package has no import cycle with config.
// Zero values are backfilled from DefaultSyncConfig in NewManagerWithConfig.
//
// 2026-06 V2 deletion — the V2 tunables (HeartbeatInterval, TimeSyncInterval,
// BufferHysteresis, PlayScheduleDelay, Drift*) were removed along with the
// protocol that consumed them; the corresponding aurora.yaml `watchparty:`
// knobs are now inert (see main.go).
type SyncConfig struct {
	// TickInterval is how often the server broadcasts a `tick` while
	// Running. 250ms is Twitch-low-latency territory and keeps late
	// joiners converged within one interval.
	TickInterval time.Duration
	// V3 catch-up thresholds, advertised to clients in the sync `hello`.
	// See docs/watchparty-v3.md §5.
	// |lag| <= V3DriftIgnoreMs           → do nothing
	// lag in (V3DriftIgnoreMs, V3DriftHardSeekMs) → rate-adjust
	// |lag| >= V3DriftHardSeekMs         → hard seek
	V3DriftIgnoreMs   int64   // default 200
	V3DriftHardSeekMs int64   // default 3000
	V3CatchUpRate     float64 // default 1.03 (behind → speed up)
	V3EaseBackRate    float64 // default 0.97 (ahead → slow down)
}

// DefaultSyncConfig returns the V3 defaults. Used when NewManager is called
// without a config, e.g. by tests.
func DefaultSyncConfig() SyncConfig {
	return SyncConfig{
		// V3 defaults (see docs/watchparty-v3.md §5): rate-adjust window
		// is 200ms–3s, beyond 3s is a hard seek. Catch-up at 1.03× keeps
		// pitch shift inaudible while still closing a 1s lag in ~33s.
		TickInterval:      250 * time.Millisecond,
		V3DriftIgnoreMs:   200,
		V3DriftHardSeekMs: 3000,
		V3CatchUpRate:     1.03,
		V3EaseBackRate:    0.97,
	}
}

// Manager orchestrates all active watch parties in memory.
// Thread-safe: the top-level mu guards the parties map; each PartyState
// has its own mutex for fine-grained locking.
type Manager struct {
	mu      sync.RWMutex
	parties map[string]*PartyState // keyed by party_code
	queries *db.Queries
	hub     *ws.Hub
	cfg     SyncConfig
	// dispatcher carries the reel-ready notification through the shared
	// persist → WS → push pipeline. Set via SetDispatcher at boot; nil
	// (tests) skips the notification with a warn.
	dispatcher *notify.Dispatcher

	cleanupDone chan struct{} // closed when CleanupStale goroutine exits

	// M9 — directory where generated highlight-reel MP4s are cached.
	// Layout: <highlightCacheDir>/<code>.mp4. Set via SetHighlightCacheDir
	// at boot; empty value disables reel generation (best-effort feature,
	// non-fatal if unavailable). Lives on Manager rather than threading
	// through every endPartyInternal caller.
	highlightCacheDir string
	// reaperOnce ensures the highlight-reel reaper is started at most
	// once even if SetHighlightCacheDir is called multiple times.
	reaperOnce sync.Once

	// shareCacheInvalidator drops a party's cached share artwork (the
	// legacy share image and every fingerprinted share-card variant).
	// Wired from the API layer at boot via SetShareCacheInvalidator,
	// because the renderer and its cache directory live on the HTTP
	// handler and the manager must not learn about either. Unset is fine
	// — the 30-day reaper is still the backstop.
	//
	// Held in an atomic rather than under m.mu deliberately: the call
	// sites (ChangeMedia, endPartyInternal) run while ps.mu is held, and
	// reaching for m.mu there would invert this file's one-way
	// m.mu → ps.mu nesting and can deadlock against any writer waiting
	// on m.mu.
	shareCacheInvalidator atomic.Pointer[func(code string)]

	// onReelForTest, when set, sees the title id, episode and name each
	// ending party's highlight reel is handed, before anything can skip the
	// reel. onReelSourceForTest sees the source file the reel resolved for
	// them ("" when there is none), before the file is opened. Tests only;
	// set them before any party ends.
	onReelForTest       func(mediaItemID int64, episodeID *int64, mediaTitle string)
	onReelSourceForTest func(srcPath string)

	// M9/M1 — server-lifecycle context for parent-of background work
	// (highlight-reel ffmpeg jobs, daily reaper). On SIGTERM this
	// context cancels, in-flight goroutines unwind cleanly rather than
	// orphaning child ffmpeg processes. Set via SetShutdownContext
	// from main.go AFTER NewManager so we don't grow the constructor
	// signature for a feature most callers don't need. nil is acceptable
	// (falls back to context.Background — no graceful shutdown, just no
	// hard crashes).
	shutdownCtx context.Context
}

// SyncConfig returns the active sync tuning. Exposed for handlers and tests
// that need to read the advertised V3 thresholds.
func (m *Manager) SyncConfig() SyncConfig { return m.cfg }

// SetDispatcher wires the notification pipeline for reel-ready
// announcements (persist → WS → push). Optional — nil skips the
// notification. Called once at boot.
func (m *Manager) SetDispatcher(d *notify.Dispatcher) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.dispatcher = d
}

// SetShareCacheInvalidator wires the share-image / share-card cache
// dropper. Called once at boot from NewRouter. Optional: without it the
// only cleanup is the daily reaper, which is how the system behaved
// before this hook existed.
func (m *Manager) SetShareCacheInvalidator(fn func(code string)) {
	if fn == nil {
		m.shareCacheInvalidator.Store(nil)
		return
	}
	m.shareCacheInvalidator.Store(&fn)
}

// invalidateShareCache fires the hook, if one is wired.
//
// Runs on its own goroutine: cache eviction is filesystem work and must
// never stall a party teardown or a media change. That also means the
// eviction can, in principle, land just after a concurrent request has
// re-rendered and written a fresh card — the glob would delete the new
// file too. Harmless: the cache is an optimisation, and the next request
// simply re-renders.
func (m *Manager) invalidateShareCache(code string) {
	fn := m.shareCacheInvalidator.Load()
	if fn == nil {
		return
	}
	go (*fn)(code)
}

// SetShutdownContext wires the server-lifecycle context for background
// goroutines (M9 highlight-reel renders + reaper). Cancellation unwinds
// in-flight ffmpeg jobs and stops the reaper ticker. Optional — passing
// nil leaves background work parented to context.Background (no graceful
// shutdown). Should be called once at boot, before SetHighlightCacheDir.
func (m *Manager) SetShutdownContext(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.shutdownCtx = ctx
}

// SetHighlightCacheDir wires the M9 highlight-reel cache directory.
// Called from main.go after Manager construction (avoids growing the
// constructor signature for an optional feature). Empty disables reel
// generation entirely — the endPartyInternal goroutine becomes a no-op.
// The directory is created lazily on first generation; we don't fail
// boot if it's not writable, just skip reels.
//
// Also launches a background reaper goroutine that ages out MP4s older
// than highlightReelMaxAge. Mirrors the share-image reaper pattern.
// Called at most once per Manager — the reaperOnce sync.Once guards.
func (m *Manager) SetHighlightCacheDir(dir string) {
	m.mu.Lock()
	m.highlightCacheDir = dir
	m.mu.Unlock()
	if dir != "" {
		m.startHighlightReaperOnce(dir)
	}
}

// highlightReelMaxAge bounds how long a generated reel survives on
// disk. 30 days mirrors share-image — long enough for "watch party last
// month, friend wants the highlight," short enough to bound disk use.
const highlightReelMaxAge = 30 * 24 * time.Hour

// highlightReaperInterval is how often the reaper sweeps. Daily.
const highlightReaperInterval = 24 * time.Hour

func (m *Manager) startHighlightReaperOnce(dir string) {
	m.reaperOnce.Do(func() {
		m.mu.RLock()
		parentCtx := m.shutdownCtx
		m.mu.RUnlock()
		if parentCtx == nil {
			parentCtx = context.Background()
		}
		go func() {
			t := time.NewTicker(highlightReaperInterval)
			defer t.Stop()
			// Initial sweep right at startup — picks up reels left
			// behind by a previous run that never aged out.
			m.reapHighlights(dir)
			for {
				select {
				case <-t.C:
					m.reapHighlights(dir)
				case <-parentCtx.Done():
					// M9/M1 — server shutting down. Stop the reaper
					// cleanly so we don't leak a goroutine in tests
					// (where main() creates Managers in a loop).
					return
				}
			}
		}()
	})
}

// reapHighlights walks the cache dir and deletes MP4s older than the
// max age. Best-effort; any error is logged at Warn.
func (m *Manager) reapHighlights(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("highlight reel reaper: readdir failed", "dir", dir, "err", err)
		}
		return
	}
	cutoff := time.Now().Add(-highlightReelMaxAge)
	reaped := 0
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		// M9/M5 — only reap our own files. Defends against an operator
		// (or a future feature) dropping unrelated files in this dir,
		// and explicitly skips `.tmp` files left behind by H1's atomic
		// rename if a render is in-flight. Expected pattern:
		// <6-char code>-<partyDBID>.mp4 (session-scoped reels), plus the
		// legacy <6-char code>.mp4 shape so files from earlier builds
		// still age out.
		if !strings.HasSuffix(name, ".mp4") {
			continue
		}
		base := strings.TrimSuffix(name, ".mp4")
		codePart := base
		if i := strings.IndexByte(base, '-'); i >= 0 {
			codePart = base[:i]
			idPart := base[i+1:]
			if idPart == "" {
				continue
			}
			validID := true
			for _, c := range idPart {
				if c < '0' || c > '9' {
					validID = false
					break
				}
			}
			if !validID {
				continue
			}
		}
		if len(codePart) != codeLength {
			continue
		}
		valid := true
		for _, c := range codePart {
			if !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		info, err := ent.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			if err := os.Remove(filepath.Join(dir, name)); err == nil {
				reaped++
			}
		}
	}
	if reaped > 0 {
		slog.Info("highlight reel reaper: swept stale files", "count", reaped, "older_than", highlightReelMaxAge)
	}
}

// HighlightReelPath returns the on-disk path for a code's reel and
// whether the file exists. Used by the HTTP handler to serve the MP4 or
// 404. Returns (empty, false) when reel generation is disabled, the
// file is missing, or the code is empty / suspicious.
func (m *Manager) HighlightReelPath(code string, partyDBID int64) (string, bool) {
	m.mu.RLock()
	dir := m.highlightCacheDir
	m.mu.RUnlock()
	if dir == "" || code == "" || partyDBID <= 0 {
		return "", false
	}
	// Defensive: party codes are uppercase alphanumeric (codeLength=6).
	// Reject anything else to prevent path-traversal via the URL. The
	// partyDBID component is an int64 — no traversal surface.
	for _, c := range code {
		if !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			return "", false
		}
	}
	if len(code) != codeLength {
		return "", false
	}
	path := filepath.Join(dir, highlightReelFilename(code, partyDBID))
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return "", false
	}
	return path, true
}

// ============================================================
// Constants
// ============================================================

const (
	// chatHistoryMax is the maximum number of chat messages kept in memory per party.
	chatHistoryMax = 100

	// chatMaxLength is the maximum length of a single chat message in characters.
	chatMaxLength = 500

	// codeLength is the length of generated party codes.
	codeLength = 6

	// codeAlphabet excludes confusable characters: 0, O, 1, I, L.
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

	// Drift correction lives on the client (see SyncConfig.V3DriftIgnoreMs /
	// V3DriftHardSeekMs, advertised in the sync hello). The server only
	// coordinates intent (play/pause/seek) and emits ticks.

	// staleParticipantTimeout is how long a participant can be unseen before
	// the party is considered stale (if ALL participants are stale).
	staleParticipantTimeout = 5 * time.Minute

	// cleanupInterval is how often the stale party cleanup runs.
	cleanupInterval = 60 * time.Second

	// maxParticipantsDefault is the default max participants if not specified.
	maxParticipantsDefault = 10

	// maxParticipantsHardLimit is the absolute maximum participants allowed.
	maxParticipantsHardLimit = 50

	// reactionsRingBufferMax caps how many reactions we retain per PartyState
	// for the M9 highlight reel (Twitch-style timeline). Capped at 200 — a
	// 2-hour movie with reactions every 36 seconds fills it; older entries
	// scroll out FIFO. Bounded memory: ~200 * sizeof(ReactionRecord) ≈ ~10KB
	// per party, negligible at our scale. M9 will persist to a table on
	// party-end if the user opts into highlights.
	reactionsRingBufferMax = 200

	// reactionAbsMsClampWindow is the max acceptable distance between a
	// client-claimed reaction timestamp and the party's authoritative
	// position. If a client lies / clock-skews / lags badly, we fall back
	// to the server's CurrentAbsMs() rather than recording bogus moments
	// on the timeline. 5 minutes is generous enough for legitimate
	// late-delivery but tight enough that a malicious client can't
	// fingerprint timestamps across the movie.
	reactionAbsMsClampWindow = 5 * 60 * 1000

	// maxPositionMs upper-bounds every client-supplied playback position
	// (request-seek target, request-pause position) at 24h — anything
	// beyond that is nonsense for media playback, and an unbounded value
	// (e.g. math.MaxInt64) would overflow once CurrentAbsMs() adds elapsed
	// wall-clock time, wrapping negative and propagating absurd tick
	// positions to every peer. 2026-06 review: previously enforced only
	// on seek; pause accepted unbounded positions through the same anchor.
	maxPositionMs = 24 * 60 * 60 * 1000
)

// Allowed emoji reactions whitelist.
var allowedReactions = map[string]bool{
	"\U0001F44D": true, // thumbs up
	"\U0001F44E": true, // thumbs down
	"\U0001F602": true, // laughing
	"\U0001F62E": true, // surprised
	"\U0001F622": true, // crying
	"\U0001F525": true, // fire
	"\U0001F60D": true, // heart eyes
	"\U0001F389": true, // party popper
	"\U0001F914": true, // thinking
	"\U0001F631": true, // screaming
	"\U0001F44F": true, // clapping
	"\U0001F648": true, // see-no-evil
	"\U0001F62D": true, // loudly crying
	"\U0001F60E": true, // sunglasses
	"\U00002764": true, // red heart
}

// ============================================================
// Constructor
// ============================================================

// NewManager creates a new watch party Manager with DefaultSyncConfig.
// Kept for backwards compatibility with tests; production callers should use
// NewManagerWithConfig to pass explicit tuning.
func NewManager(queries *db.Queries, hub *ws.Hub) *Manager {
	return NewManagerWithConfig(queries, hub, DefaultSyncConfig())
}

// NewManagerWithConfig creates a new watch party Manager with the given sync
// tuning. This is the entrypoint used from main.go so operators can override
// thresholds via aurora.yaml without recompiling.
func NewManagerWithConfig(queries *db.Queries, hub *ws.Hub, cfg SyncConfig) *Manager {
	// Sanity: fall back to defaults on any zero/negative value rather than
	// producing a manager with pathological thresholds.
	def := DefaultSyncConfig()
	if cfg.TickInterval <= 0 {
		cfg.TickInterval = def.TickInterval
	}
	if cfg.V3DriftIgnoreMs <= 0 {
		cfg.V3DriftIgnoreMs = def.V3DriftIgnoreMs
	}
	if cfg.V3DriftHardSeekMs <= 0 {
		cfg.V3DriftHardSeekMs = def.V3DriftHardSeekMs
	}
	if cfg.V3CatchUpRate <= 1.0 {
		cfg.V3CatchUpRate = def.V3CatchUpRate
	}
	if cfg.V3EaseBackRate <= 0 || cfg.V3EaseBackRate >= 1.0 {
		cfg.V3EaseBackRate = def.V3EaseBackRate
	}
	return &Manager{
		parties:     make(map[string]*PartyState),
		queries:     queries,
		hub:         hub,
		cfg:         cfg,
		cleanupDone: make(chan struct{}),
	}
}

// ============================================================
// Code Generation
// ============================================================

// GenerateCode produces a cryptographically random 6-character uppercase
// alphanumeric code, excluding confusable characters (0, O, 1, I, L).
// It retries if the generated code collides with an active party.
func (m *Manager) GenerateCode() (string, error) {
	alphabetLen := big.NewInt(int64(len(codeAlphabet)))

	for attempts := 0; attempts < 10; attempts++ {
		buf := make([]byte, codeLength)
		for i := range buf {
			idx, err := rand.Int(rand.Reader, alphabetLen)
			if err != nil {
				return "", fmt.Errorf("crypto/rand failed: %w", err)
			}
			buf[i] = codeAlphabet[idx.Int64()]
		}
		code := string(buf)

		// Check for collision with active parties
		m.mu.RLock()
		_, exists := m.parties[code]
		m.mu.RUnlock()
		if !exists {
			return code, nil
		}
		slog.Debug("party code collision, retrying", "code", code, "attempt", attempts+1)
	}

	return "", fmt.Errorf("failed to generate unique party code after 10 attempts")
}

// ============================================================
// Party Lifecycle
// ============================================================

// CreateParty creates a new watch party, persists it to the database, and
// stores the in-memory state. Returns the new PartyState.
//
// scheduledStartAt is optional (nil = no schedule, host plays manually).
// When non-nil, it MUST be in the future — callers validate this before
// reaching here; the Manager trusts the input. When the time arrives the
// server fires a "party-starting" event and transitions to playing
// automatically; until then the party is "scheduled" (visible in lobbies
// and shareable, but not playing).
func (m *Manager) CreateParty(
	ctx context.Context,
	hostUserID int64,
	hostUsername string,
	mediaItemID int64,
	episodeID *int64,
	partyName string,
	mediaTitle string,
	mediaPoster string,
	maxParticipants int,
	settings PartySettings,
	initialPositionMs int64,
	scheduledStartAt *time.Time,
) (*PartyState, error) {
	// Validate max participants
	if maxParticipants <= 0 {
		maxParticipants = maxParticipantsDefault
	}
	if maxParticipants > maxParticipantsHardLimit {
		maxParticipants = maxParticipantsHardLimit
	}
	settings.MaxParticipants = maxParticipants

	// Pre-check (non-authoritative) to avoid unnecessary work.
	// HostUserID is mutable since host succession (promoteSuccessorLocked
	// writes it under ps.mu), so the read needs ps.mu. Lock order here is
	// m.mu → ps.mu; nothing in the package acquires m.mu while holding a
	// ps.mu (endPartyInternal releases ps.mu before its map delete), so
	// the one-way nesting cannot deadlock.
	m.mu.RLock()
	for _, ps := range m.parties {
		ps.mu.Lock()
		isDup := ps.HostUserID == hostUserID
		ps.mu.Unlock()
		if isDup {
			m.mu.RUnlock()
			return nil, errUser("you already have an active party")
		}
	}
	m.mu.RUnlock()

	code, err := m.GenerateCode()
	if err != nil {
		return nil, err
	}

	now := time.Now()

	// Marshal settings for DB
	settingsJSON, err := json.Marshal(settings)
	if err != nil {
		return nil, fmt.Errorf("marshal settings: %w", err)
	}

	// M3 (migration 021): create the long-lived ROOM first, then the party
	// (session) that references it. CreateParty implicitly creates a
	// non-persistent room — the room is soft-deleted when the session ends.
	// Persistent rooms are created via the (forthcoming) CreateRoom API and
	// have their own party-create flow that reuses an existing room.id.
	//
	// Code generation already ensured no in-memory collision; the DB's
	// partial unique index on watch_party_rooms.code WHERE deleted_at IS
	// NULL is the authoritative gate. On rare collision, the INSERT
	// returns an error and we bubble up; caller can retry.
	dbRoom := &models.WatchPartyRoom{
		Code:         code,
		Name:         partyName,
		OwnerUserID:  hostUserID,
		IsPersistent: false, // quick-party rooms auto-cleanup on session end
		SettingsJSON: string(settingsJSON),
		CreatedAt:    now,
		LastActiveAt: now,
	}
	if err := m.queries.InsertRoom(ctx, dbRoom); err != nil {
		return nil, fmt.Errorf("insert room: %w", err)
	}

	// Insert party row linked to the new room. party_code mirrors room.code
	// for backwards-compat with the share-image URL space; the room owns
	// the authoritative code.
	dbParty := &models.WatchParty{
		PartyCode:        code,
		HostUserID:       hostUserID,
		MediaItemID:      mediaItemID,
		EpisodeID:        episodeID,
		PartyName:        partyName,
		MediaTitle:       mediaTitle,
		MediaPoster:      mediaPoster,
		MaxParticipants:  maxParticipants,
		IsActive:         true,
		SettingsJSON:     string(settingsJSON),
		CreatedAt:        now,
		ScheduledStartAt: scheduledStartAt,
		StartedAt:        nil,
		RoomID:           &dbRoom.ID,
	}

	if err := m.queries.InsertWatchParty(ctx, dbParty); err != nil {
		// Roll back the room — we created it but can't seat a party in it.
		// If the soft-delete ALSO fails (same transient hiccup that took
		// down the party INSERT), log loudly: there's no automated
		// reaper for orphan rooms today, so the code stays reserved
		// until an operator manually intervenes. Future work: add a
		// reaper for rooms with no associated active party older than
		// N hours.
		if delErr := m.queries.SoftDeleteRoom(context.Background(), dbRoom.ID); delErr != nil {
			slog.Error("party rollback: soft-delete of orphan room failed — code is now reserved indefinitely",
				"room_id", dbRoom.ID, "code", dbRoom.Code, "delete_error", delErr, "insert_error", err)
		}
		return nil, fmt.Errorf("insert party: %w", err)
	}

	// Build in-memory state
	ps := &PartyState{
		Code:            code,
		HostUserID:      hostUserID,
		MediaItemID:     mediaItemID,
		EpisodeID:       episodeID,
		MediaTitle:      mediaTitle,
		MediaPoster:     mediaPoster,
		PartyName:       partyName,
		StateRevision:   1,
		Participants:    make(map[int64]*Participant),
		ChatHistory:     make([]ChatMessage, 0, chatHistoryMax),
		Settings:        settings,
		CreatedAt:       now,
		MaxParticipants: maxParticipants,
		dbID:            dbParty.ID,
		// M3 — link to the long-lived room so EndParty can soft-delete or
		// preserve it based on persistence policy.
		roomDBID:         dbRoom.ID,
		IsRoomPersistent: dbRoom.IsPersistent,

		// Seed the canonical anchor from the host's resume offset. Running
		// starts false; the tick loop won't spin up until request-play.
		Running:        false,
		AnchorAbsMs:    initialPositionMs,
		AnchorServerAt: now,
		syncConns:      make(map[int64]*SafeConn),
		roomConns:      make(map[int64]*SafeConn),

		// Countdown fields (migration 019). Schedule goroutine is spawned
		// further down after the party is registered in the parties map,
		// so the goroutine's lookup-by-code can succeed.
		ScheduledStartAt: scheduledStartAt,
		StartedAt:        nil,
	}

	// Authoritative check under write lock to prevent TOCTOU race:
	// two concurrent CreateParty calls could both pass the RLock pre-check.
	// Same m.mu → ps.mu one-way nesting as the pre-check above (HostUserID
	// is mutable since host succession).
	m.mu.Lock()
	for _, existing := range m.parties {
		existing.mu.Lock()
		isDup := existing.HostUserID == hostUserID
		existing.mu.Unlock()
		if isDup {
			m.mu.Unlock()
			// Best-effort cleanup: mark the party row inactive AND
			// soft-delete the room we created for it. 2026-06 review
			// (bug 1) — this path used to leak the room row, leaving its
			// code reserved indefinitely (the non-race failure path above
			// already rolled the room back; this one didn't).
			if dbParty.ID > 0 {
				_ = m.queries.EndWatchParty(ctx, dbParty.ID)
			}
			if err := m.queries.SoftDeleteRoom(context.Background(), dbRoom.ID); err != nil {
				slog.Error("party rollback: soft-delete of orphan room failed — code is now reserved indefinitely",
					"room_id", dbRoom.ID, "code", dbRoom.Code, "delete_error", err)
			}
			return nil, errUser("you already have an active party")
		}
	}
	m.parties[code] = ps
	m.mu.Unlock()

	slog.Info("watch party created",
		"code", code,
		"host_user_id", hostUserID,
		"host_username", hostUsername,
		"media_title", mediaTitle,
		"max_participants", maxParticipants,
		"scheduled_start_at", scheduledStartAt,
	)

	// Spawn schedule timer if requested. Must happen AFTER the party is in
	// the m.parties map (above) so the goroutine's lookup-by-code in
	// fireScheduledStart can find it. Caller-supplied scheduledStartAt was
	// validated as future-tense by the API layer.
	if scheduledStartAt != nil {
		ps.mu.Lock()
		m.startScheduleTimerLocked(ps, *scheduledStartAt)
		ps.mu.Unlock()
	}

	return ps, nil
}

// ============================================================
// Persistent Rooms (M3)
// ============================================================

// CreatePersistentRoom creates a long-lived room with no initial session.
// Friends can bookmark the room's code and rejoin whenever the owner starts
// a party in it. Distinct from CreateParty which creates both a room AND a
// party in one shot (quick-party flow).
//
// Returns the new room. PartyState is NOT created — until the owner calls
// StartPartyInRoom, joiners hit a "room is offline" state.
func (m *Manager) CreatePersistentRoom(
	ctx context.Context,
	ownerUserID int64,
	name string,
	settings PartySettings,
) (*models.WatchPartyRoom, error) {
	code, err := m.GenerateCode()
	if err != nil {
		return nil, err
	}

	settingsJSON, err := json.Marshal(settings)
	if err != nil {
		return nil, fmt.Errorf("marshal settings: %w", err)
	}

	now := time.Now()
	room := &models.WatchPartyRoom{
		Code:         code,
		Name:         name,
		OwnerUserID:  ownerUserID,
		IsPersistent: true,
		SettingsJSON: string(settingsJSON),
		CreatedAt:    now,
		LastActiveAt: now,
	}

	if err := m.queries.InsertRoom(ctx, room); err != nil {
		return nil, fmt.Errorf("insert persistent room: %w", err)
	}

	slog.Info("persistent room created",
		"code", code,
		"owner_user_id", ownerUserID,
		"name", name,
	)
	return room, nil
}

// StartPartyInRoom starts a new party (session) inside an existing
// persistent room, reusing the room's code. The room owner is implicitly
// the host. Used when friends-bookmarked-room owner wants to start a new
// movie night without changing the join code.
//
// Validates room exists, isn't deleted, and the caller owns it. Validates
// no active party already exists in this room. Returns the new PartyState.
func (m *Manager) StartPartyInRoom(
	ctx context.Context,
	roomCode string,
	hostUserID int64,
	hostUsername string,
	mediaItemID int64,
	episodeID *int64,
	mediaTitle string,
	mediaPoster string,
	maxParticipants int,
	settings PartySettings,
	initialPositionMs int64,
	scheduledStartAt *time.Time,
) (*PartyState, error) {
	// Lookup the room. Soft-deleted rooms return nil — caller treats as 404.
	room, err := m.queries.GetRoomByCode(ctx, roomCode)
	if err != nil {
		return nil, fmt.Errorf("lookup room: %w", err)
	}
	if room == nil {
		return nil, fmt.Errorf("room not found")
	}
	if room.OwnerUserID != hostUserID {
		return nil, fmt.Errorf("only the room owner can start a party here")
	}

	// Refuse to start if an active party already exists in this room. The
	// existing partial unique on watch_parties.party_code WHERE is_active
	// would also enforce this at the DB level, but checking up front gives
	// a clearer error.
	m.mu.RLock()
	if _, exists := m.parties[roomCode]; exists {
		m.mu.RUnlock()
		return nil, fmt.Errorf("a party is already active in this room")
	}
	m.mu.RUnlock()

	if maxParticipants <= 0 {
		maxParticipants = maxParticipantsDefault
	}
	if maxParticipants > maxParticipantsHardLimit {
		maxParticipants = maxParticipantsHardLimit
	}
	settings.MaxParticipants = maxParticipants

	settingsJSON, err := json.Marshal(settings)
	if err != nil {
		return nil, fmt.Errorf("marshal settings: %w", err)
	}

	now := time.Now()
	dbParty := &models.WatchParty{
		PartyCode:        roomCode,
		HostUserID:       hostUserID,
		MediaItemID:      mediaItemID,
		EpisodeID:        episodeID,
		PartyName:        room.Name,
		MediaTitle:       mediaTitle,
		MediaPoster:      mediaPoster,
		MaxParticipants:  maxParticipants,
		IsActive:         true,
		SettingsJSON:     string(settingsJSON),
		CreatedAt:        now,
		ScheduledStartAt: scheduledStartAt,
		StartedAt:        nil,
		RoomID:           &room.ID,
	}
	if err := m.queries.InsertWatchParty(ctx, dbParty); err != nil {
		return nil, fmt.Errorf("insert party in room: %w", err)
	}

	// Touch the room's last_active_at so the "My Rooms" list orders it
	// at the top going forward.
	_ = m.queries.TouchRoom(context.Background(), room.ID)

	// Build PartyState. IsRoomPersistent=true so EndParty preserves the
	// room (Touch instead of SoftDelete) when this session ends.
	ps := &PartyState{
		Code:             roomCode,
		HostUserID:       hostUserID,
		MediaItemID:      mediaItemID,
		EpisodeID:        episodeID,
		MediaTitle:       mediaTitle,
		MediaPoster:      mediaPoster,
		PartyName:        room.Name,
		StateRevision:    1,
		Participants:     make(map[int64]*Participant),
		ChatHistory:      make([]ChatMessage, 0, chatHistoryMax),
		Settings:         settings,
		CreatedAt:        now,
		MaxParticipants:  maxParticipants,
		dbID:             dbParty.ID,
		roomDBID:         room.ID,
		IsRoomPersistent: true,

		Running:        false,
		AnchorAbsMs:    initialPositionMs,
		AnchorServerAt: now,
		syncConns:      make(map[int64]*SafeConn),
		roomConns:      make(map[int64]*SafeConn),

		ScheduledStartAt: scheduledStartAt,
		StartedAt:        nil,
	}

	// Authoritative register under write lock — same TOCTOU guard as
	// CreateParty in case another StartPartyInRoom raced past the
	// RLock check above.
	m.mu.Lock()
	if _, exists := m.parties[roomCode]; exists {
		m.mu.Unlock()
		_ = m.queries.EndWatchParty(ctx, dbParty.ID)
		return nil, fmt.Errorf("a party is already active in this room")
	}
	m.parties[roomCode] = ps
	m.mu.Unlock()

	slog.Info("party started in persistent room",
		"room_code", roomCode,
		"host_user_id", hostUserID,
		"host_username", hostUsername,
		"media_title", mediaTitle,
	)

	if scheduledStartAt != nil {
		ps.mu.Lock()
		m.startScheduleTimerLocked(ps, *scheduledStartAt)
		ps.mu.Unlock()
	}

	return ps, nil
}

// DeleteRoom soft-deletes a persistent room. If a party is currently
// active in the room, it's ended first (broadcasts party-ended to all
// participants, closes sockets, marks party inactive). After this
// returns, the room's code is reusable for a new room.
//
// Owner-only. The API handler enforces this; the manager also re-checks
// against the room's owner_user_id.
func (m *Manager) DeleteRoom(ctx context.Context, ownerUserID int64, roomID int64) error {
	room, err := m.queries.GetRoomByID(ctx, roomID)
	if err != nil {
		return fmt.Errorf("lookup room: %w", err)
	}
	if room == nil {
		return fmt.Errorf("room not found")
	}
	if room.OwnerUserID != ownerUserID {
		return fmt.Errorf("only the room owner can delete this room")
	}

	// End any active party in the room first. This broadcasts party-ended
	// to current participants so they see the room go away cleanly.
	m.mu.RLock()
	ps, hasActiveParty := m.parties[room.Code]
	m.mu.RUnlock()
	if hasActiveParty {
		// endPartyInternal will also soft-delete the room because
		// IsRoomPersistent is true — but the delete happens via
		// TouchRoom (not SoftDeleteRoom) when persistent. So we need to
		// flip persistence to false before ending, OR do the delete
		// explicitly after. Cleaner: end-then-delete explicitly.
		if err := m.endPartyInternal(room.Code, ps, 0); err != nil {
			slog.Warn("delete room: end active party failed", "code", room.Code, "error", err)
		}
	}

	if err := m.queries.SoftDeleteRoom(ctx, roomID); err != nil {
		return fmt.Errorf("soft delete room: %w", err)
	}

	slog.Info("persistent room deleted",
		"code", room.Code,
		"owner_user_id", ownerUserID,
	)
	return nil
}

// ListUserRooms returns the user's live (non-deleted) persistent rooms,
// ordered by most-recently-active first. Includes both persistent rooms
// and in-flight quick-party rooms; the API handler can filter further if
// it only wants persistent ones for a "My Rooms" UI.
func (m *Manager) ListUserRooms(ctx context.Context, userID int64) ([]*models.WatchPartyRoom, error) {
	return m.queries.ListRoomsForOwner(ctx, userID)
}

// SchedulePartyStart sets or clears the scheduled start time for an existing
// party. Passing nil clears any existing schedule (reverting to "host plays
// manually"). Non-nil values must be in the future. Host-only enforcement
// happens in the API layer before this is called.
//
// If a schedule was already in flight, the previous timer is cancelled
// before a new one is started, so back-to-back reschedules collapse to the
// latest call winning. Broadcasts a "party-scheduled" event so connected
// clients update their countdown display.
func (m *Manager) SchedulePartyStart(ctx context.Context, code string, scheduledStartAt *time.Time) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return errUser("party not found")
	}

	// Validate future-tense if non-nil. Past timestamps are rejected here
	// (defense in depth — the API layer also validates, but this guard
	// protects against direct internal callers and clock-skew edge cases).
	// The 1s grace matches the API-layer validation in party_handlers.go,
	// so a borderline-now timestamp doesn't get accepted by the API only
	// to be rejected here.
	if scheduledStartAt != nil && scheduledStartAt.Before(time.Now().Add(-1*time.Second)) {
		return fmt.Errorf("scheduled_start_at must be in the future")
	}

	ps.mu.Lock()
	// Cancel any in-flight schedule timer before starting a new one.
	if ps.ending {
		ps.mu.Unlock()
		return errUser("party has ended")
	}
	m.cancelScheduleTimerLocked(ps)
	ps.ScheduledStartAt = scheduledStartAt
	if scheduledStartAt != nil {
		m.startScheduleTimerLocked(ps, *scheduledStartAt)
	}
	dbID := ps.dbID
	// Snapshot for broadcast (releases the lock before DB write).
	broadcastMsg := map[string]interface{}{
		"type": "party-scheduled",
		"payload": map[string]interface{}{
			"scheduled_start_at": scheduledStartAt,
			"server_now_ms":      time.Now().UnixMilli(),
		},
	}
	m.broadcastToPartyLocked(ps, broadcastMsg)
	ps.mu.Unlock()

	// Persist outside the lock to avoid blocking other party operations on
	// DB latency. Failure here is best-effort — the in-memory state is the
	// source of truth for live behavior; the DB is for crash recovery and
	// the share-image lookup in Phase 2.
	if dbID > 0 {
		if err := m.queries.UpdatePartySchedule(ctx, dbID, scheduledStartAt); err != nil {
			slog.Warn("update party schedule in DB failed", "code", code, "error", err)
		}
	}

	return nil
}

// startScheduleTimerLocked spawns the per-party goroutine that fires the
// "party-starting" broadcast at scheduledStartAt. Caller must hold ps.mu.
// Replaces any existing timer (call cancelScheduleTimerLocked first if you
// want to be explicit; this function does NOT assume a clean slate).
//
// The goroutine context is derived from context.Background so the timer
// survives the request that created/updated it — Aurora's CreateParty and
// SchedulePartyStart are short request handlers, but the timer needs to
// outlive them by minutes or hours.
func (m *Manager) startScheduleTimerLocked(ps *PartyState, scheduledStartAt time.Time) {
	// Cancel any existing timer first — idempotent guard.
	m.cancelScheduleTimerLocked(ps)

	delay := time.Until(scheduledStartAt)
	if delay <= 0 {
		// Past timestamp — fire immediately rather than scheduling.
		// This shouldn't happen given the validation in SchedulePartyStart
		// + CreateParty, but defensively handle clock skew or races where
		// the validation passes but actual time-to-fire is already 0.
		code := ps.Code
		go m.fireScheduledStart(code)
		return
	}

	timerCtx, cancel := context.WithCancel(context.Background())
	ps.scheduleCancel = cancel
	code := ps.Code

	go func() {
		select {
		case <-time.After(delay):
			// Fire even if cancel was called concurrently with the timer
			// expiry — at-most-once semantics are guarded by the dedup
			// check inside fireScheduledStart (started_at nilness).
			m.fireScheduledStart(code)
		case <-timerCtx.Done():
			// Cancelled — host reschedeuled or cleared the schedule.
			return
		}
	}()

	// Invites (migration 051): nudge the host + non-declined invitees
	// shortly before showtime. Skips itself when the start is already
	// inside the lead window, self-validates at fire time, and is cancelled
	// along with the countdown on reschedule, play, end or shutdown.
	m.armReminderLocked(ps, scheduledStartAt)
}

// cancelScheduleTimerLocked cancels any in-flight schedule timer. Caller
// must hold ps.mu. Idempotent: safe to call when no timer is in flight.
func (m *Manager) cancelScheduleTimerLocked(ps *PartyState) {
	if ps.scheduleCancel != nil {
		ps.scheduleCancel()
		ps.scheduleCancel = nil
	}
	if ps.reminderCancel != nil {
		ps.reminderCancel()
		ps.reminderCancel = nil
	}
}

// fireScheduledStart is the goroutine body. Re-resolves the party by code
// (it may have ended since the timer was scheduled), checks that the party
// is still in pre-start state, engages playback via HandleRequestPlay, and
// broadcasts "party-starting" once playback actually started.
//
// 2026-06 review — two ordering fixes:
//   - "party-starting" is broadcast AFTER a successful play, not before
//     the gate check, so clients never see "Starting now!" while the
//     spoiler gate is still blocking (and a blocked fire is silent).
//   - the scheduleFiring flag makes concurrent fires (countdown timer
//     racing a maybeRetryScheduledStartLocked goroutine) collapse to one;
//     the dedup-on-StartedAt alone couldn't, because StartedAt is stamped
//     later inside HandleRequestPlay's own lock acquisition.
func (m *Manager) fireScheduledStart(code string) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		// Party ended between schedule and fire — nothing to do.
		return
	}

	ps.mu.Lock()
	// Dedup guard: skip if the party already started — a prior fire or a
	// manual host play stamped StartedAt / set HasEverPlayed (both happen
	// in HandleRequestPlay) — or another fire is in flight right now.
	// Also skip a party mid-teardown (see PartyState.ending): starting
	// playback on one would leak a tick goroutine past endPartyInternal's
	// stopTickLoopLocked.
	if ps.StartedAt != nil || ps.HasEverPlayed || ps.scheduleFiring || ps.ending {
		ps.mu.Unlock()
		return
	}
	ps.scheduleFiring = true
	// Capture the host under the lock. HostUserID is mutable since host
	// succession, and reading it after the unlock below raced promotion —
	// caught by the succession review's -race repro (write in
	// promoteSuccessorLocked vs the old unlocked read here).
	firedHostID := ps.HostUserID
	ps.mu.Unlock()

	// Engage playback via the V3 intent path (audit H6): HandleRequestPlay
	// sets the anchor Running, starts the per-party tick loop, stamps
	// StartedAt, persists MarkPartyStarted, and emits a synthetic tick that
	// drives clients to actually play.
	//
	// HandleRequestPlay can return without engaging playback — the
	// SpoilerFreeStart readiness gate returns a "waiting for: …" error, the
	// host may not have joined their room socket yet ("not a participant"),
	// or the party may have just ended. On failure StartedAt stays nil so a
	// later manual host play still works and nothing persists a bogus start
	// time; maybeRetryScheduledStartLocked re-fires when the gate's inputs
	// change (ready toggle, blocker leaves, host (re)joins).
	playErr := m.HandleRequestPlay(code, firedHostID)

	ps.mu.Lock()
	ps.scheduleFiring = false
	if playErr != nil {
		// If a host handoff landed while this fire was in flight, the
		// failure is stale ("not a participant"/"only the host" against
		// the departed host) — and the promotion's own retry was
		// suppressed by scheduleFiring above, so the retry event would
		// otherwise be permanently consumed. Re-arm with the current
		// host; the recursion is bounded because maybeRetry's pre-checks
		// mirror the fire's failure modes.
		if ps.HostUserID != firedHostID {
			m.maybeRetryScheduledStartLocked(ps)
		}
		ps.mu.Unlock()
		slog.Warn("scheduled-start play did not engage; party left unstarted (retried when the gate unblocks)", "code", code, "error", playErr)
		return
	}
	// Clear the cancel hook — the schedule is consumed (HandleRequestPlay
	// already cancelled the timer; this is belt-and-suspenders).
	ps.scheduleCancel = nil
	// Broadcast "party-starting" so all clients show the "Starting now!"
	// notification. Includes server_now_ms so late-joiners' countdown
	// widgets converge correctly.
	now := time.Now()
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type": "party-starting",
		"payload": map[string]interface{}{
			"started_at_ms": now.UnixMilli(),
			"server_now_ms": now.UnixMilli(),
		},
	})
	ps.mu.Unlock()

	slog.Info("scheduled watch party started", "code", code)
}

// maybeRetryScheduledStartLocked re-fires an overdue scheduled start when
// the spoiler gate's inputs may have just changed. The 2026-06 review's
// bug-2 fix originally hooked only the Ready toggle; the gate can also
// unblock when the last not-ready guest LEAVES, or when the HOST (whom
// HandleRequestPlay requires to be a current participant) (re)joins after
// the countdown fired. All three events route through here.
//
// Cheap pre-checks only — fireScheduledStart re-validates everything and
// dedups, so a spurious call is harmless. Caller MUST hold ps.mu; the
// fire runs in a goroutine because it re-acquires the lock.
func (m *Manager) maybeRetryScheduledStartLocked(ps *PartyState) {
	if ps.ending {
		return // dying party — must not spawn a fire (see PartyState.ending)
	}
	if ps.ScheduledStartAt == nil || ps.ScheduledStartAt.After(time.Now()) {
		return // no schedule, or not due yet (the timer goroutine owns it)
	}
	if ps.StartedAt != nil || ps.HasEverPlayed || ps.scheduleFiring {
		return // already started or a fire is in flight
	}
	if _, ok := ps.Participants[ps.HostUserID]; !ok {
		return // host not connected — HandleRequestPlay would reject
	}
	if ps.Settings.SpoilerFreeStart && len(spoilerGateBlockersLocked(ps)) > 0 {
		return // gate still blocked; a later event will retry
	}
	go m.fireScheduledStart(ps.Code)
}

// EndParty ends a party via the REST endpoint. Allowed for the CURRENT
// host — re-validated atomically inside endPartyInternal, because host
// succession makes HostUserID mutable and a check here could be stale by
// the time the teardown commits (an ex-host's in-flight end must not
// kill a successor's party) — and, for a party running in a persistent
// room, for the ROOM OWNER. The owner allowance exists because
// succession created a state that couldn't exist before: the owner
// hands off (or times out), a guest inherits, and the owner of the room
// would otherwise have no way to end the session in their own room
// short of DeleteRoom, which destroys the room and its stable code.
// Ownership is immutable, so the owner path needs no atomic re-check.
func (m *Manager) EndParty(code string, userID int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return errUser("party not found")
	}

	ps.mu.Lock()
	isCurrentHost := ps.HostUserID == userID
	roomDBID := ps.roomDBID
	isPersistent := ps.IsRoomPersistent
	ps.mu.Unlock()

	if isCurrentHost {
		return m.endPartyInternal(code, ps, userID)
	}
	if isPersistent && roomDBID > 0 && m.queries != nil {
		room, err := m.queries.GetRoomByID(context.Background(), roomDBID)
		if err == nil && room != nil && room.OwnerUserID == userID {
			slog.Info("v3: room owner ended a session they no longer host", "code", code, "owner", userID)
			return m.endPartyInternal(code, ps, 0)
		}
	}
	return errUser("only the host can end the party")
}

// promoteSuccessorLocked transfers the host role to the most senior
// eligible participant after the host departs, so an in-progress party
// survives as long as at least one person is still actively in it.
// Caller MUST hold ps.mu, and must have already handled (or be about to
// remove) the departing host's own Participants entry — the departing
// user is never a candidate.
//
// Eligible: any remaining participant except mobile companions — a
// companion surface has no video player and no sync socket (see
// Participant.Companion), so a party whose only remaining members are
// companions cannot play anything and is not worth keeping alive.
// Among the eligible, a participant with a live room conn outranks one
// briefly between sockets (a joiner mid-handshake), then seniority
// decides: earliest JoinedAt, tiebroken by lowest UserID. Deterministic,
// and matches the social expectation that the longest-present friend
// inherits the remote.
//
// On success: HostUserID and every per-participant IsHost flag are
// updated, any pending host-disconnect grace is cleared (it described
// the OLD host; the goroutine's nil check makes it a no-op), the
// revision is bumped, and two messages go out on the room pool — a
// "host-changed" event (drives the "X is now the host" toast) followed
// by a full party-state snapshot, whose revision guard makes it
// idempotent and whose participant list carries the flipped is_host
// flags so no client ever computes a hostless interval. The handoff is
// persisted best-effort, like every other in-party DB write.
//
// The V3 anchor is deliberately NOT touched: playback truth lives
// server-side (Running + AnchorAbsMs/AnchorServerAt), so the movie keeps
// playing through the handoff without a hiccup.
//
// Returns nil when no eligible successor exists — the caller falls back
// to ending the party, exactly the pre-succession behavior.
//
// departingUsername is passed in rather than looked up because both call
// sites remove the departing host's Participants entry before promoting
// (the explicit-leave path deletes every leaver up front; the grace path
// clears the reserved slot) — by the time this runs, the map no longer
// knows the name.
func (m *Manager) promoteSuccessorLocked(ps *PartyState, departingUserID int64, departingUsername, reason string) *Participant {
	// A dying party must not sprout a new host (see PartyState.ending):
	// returning nil sends every caller down its historical end-the-party
	// fallback, where endPartyInternal no-ops on the ending flag.
	if ps.ending {
		return nil
	}
	var successor *Participant
	better := func(cand, cur *Participant) bool {
		if cur == nil {
			return true
		}
		candConn := ps.roomConns[cand.UserID] != nil
		curConn := ps.roomConns[cur.UserID] != nil
		if candConn != curConn {
			return candConn
		}
		if !cand.JoinedAt.Equal(cur.JoinedAt) {
			return cand.JoinedAt.Before(cur.JoinedAt)
		}
		return cand.UserID < cur.UserID
	}
	for uid, p := range ps.Participants {
		if uid == departingUserID || p == nil || p.Companion {
			continue
		}
		if better(p, successor) {
			successor = p
		}
	}
	if successor == nil {
		return nil
	}

	previousHostID := ps.HostUserID
	ps.HostUserID = successor.UserID
	for uid, p := range ps.Participants {
		if p == nil {
			continue
		}
		p.IsHost = uid == successor.UserID
	}
	ps.HostDisconnectedAt = nil
	m.bumpRevLocked(ps)

	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type": "host-changed",
		"payload": map[string]interface{}{
			"new_host_user_id":       successor.UserID,
			"new_host_username":      successor.Username,
			"previous_host_user_id":  previousHostID,
			"previous_host_username": departingUsername,
			"reason":                 reason,
		},
	})
	m.broadcastToPartyLocked(ps, m.BuildPartyStateMessage(ps))

	// Persist off the lock: this runs while the caller holds ps.mu on the
	// hot leave path, and a slow Postgres must not stall ticks/joins/chat
	// (the async style ChangeMedia/MarkPartyStarted use, vs the in-line
	// UpdateParticipantLeft pattern). Bounded so a wedged pool can't
	// accumulate goroutines.
	if ps.dbID > 0 && m.queries != nil {
		dbID, newHost, partyCode := ps.dbID, successor.UserID, ps.Code
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := m.queries.UpdatePartyHost(ctx, dbID, newHost); err != nil {
				slog.Warn("v3: persist host handoff failed", "code", partyCode, "error", err)
			}
		}()
	}

	slog.Info("v3: host handoff",
		"code", ps.Code,
		"previous_host", previousHostID,
		"new_host", successor.UserID,
		"reason", reason,
	)
	return successor
}

// endPartyInternal broadcasts party-ended, cleans up DB and memory.
// ps.mu must NOT be held when calling this.
// endPartyInternal tears the party down. expectedHost is an atomicity
// hook for the one authorization-gated caller (EndParty): 0 means end
// unconditionally; non-zero means "end only if this user is STILL the
// host", re-validated under the same ps.mu acquisition that commits the
// teardown. Since host succession made HostUserID mutable, a check done
// in the caller's earlier lock hold can be stale by the time this runs —
// an ex-host's in-flight POST /end must not end the party a successor
// just inherited.
func (m *Manager) endPartyInternal(code string, ps *PartyState, expectedHost int64) error {
	ps.mu.Lock()

	// Idempotence + resurrection guard (2026-08, host succession review).
	// Teardown below releases ps.mu for the socket/DB work, so a second
	// ender (grace reap racing an explicit end, a stale-cleanup sweep)
	// can acquire the mutex mid-teardown. Everything liveness-creating
	// checks ps.ending; a second end is a clean no-op.
	if ps.ending {
		ps.mu.Unlock()
		return nil
	}
	if expectedHost != 0 && ps.HostUserID != expectedHost {
		ps.mu.Unlock()
		return errUser("only the host can end the party")
	}
	ps.ending = true

	// 2026-05-26 — diagnostic snapshot for "why did my party end?" reports.
	// Without this, journalctl shows only "ending stale watch party" or
	// "host grace period expired" with no context for what state the
	// party was actually in. A live user report ("I joined as a guest,
	// laptop died, party ended even though I wasn't host") could not be
	// proven or disproven from logs — we couldn't tell whether the host
	// also disconnected, whether participants were stale, or which code
	// path triggered the end. This single-line snapshot makes future
	// post-mortems possible without redoing the investigation each time.
	var (
		endParticipantCount  = len(ps.Participants)
		endRoomConnCount     = len(ps.roomConns)
		endSyncConnCount     = len(ps.syncConns)
		endHostDisconnectAge time.Duration
		endHostConnected     = ps.roomConns[ps.HostUserID] != nil
	)
	if ps.HostDisconnectedAt != nil {
		endHostDisconnectAge = time.Since(*ps.HostDisconnectedAt)
	}

	// M9 — snapshot the data we need for the highlight reel BEFORE the
	// lock is held for teardown. We launch generation after the lock
	// release so ffmpeg doesn't block other party operations. Best-
	// effort: empty reactions → no reel (handled by generator).
	reactionsForReel := make([]ReactionRecord, len(ps.Reactions))
	copy(reactionsForReel, ps.Reactions)
	// Since host succession this is the FINAL host, not necessarily the
	// creator — deliberate: the last steward gets the reel-ready bell. A
	// creator who handed off can still fetch the reel (party membership,
	// not hostship, gates access).
	hostForReel := ps.HostUserID
	// The title the party ends on, for its row; the reel takes the title
	// the row records.
	mediaIDAtEnd, episodeIDAtEnd := ps.MediaItemID, ps.EpisodeID
	mediaTitleAtEnd, mediaPosterAtEnd := ps.MediaTitle, ps.MediaPoster

	slog.Info("watch party ending — diagnostic snapshot",
		"code", code,
		"host_user_id", ps.HostUserID,
		"is_persistent_room", ps.IsRoomPersistent,
		"participants_remaining", endParticipantCount,
		"room_conns_open", endRoomConnCount,
		"sync_conns_open", endSyncConnCount,
		"host_room_conn_alive", endHostConnected,
		"host_disconnected_for", endHostDisconnectAge.Round(time.Second),
		"created_at", ps.CreatedAt.Format(time.RFC3339),
		"age", time.Since(ps.CreatedAt).Round(time.Second),
	)

	// Cancel any in-flight schedule timer. A scheduled party that gets
	// ended (host clicks "Cancel", or stale-cleanup fires) shouldn't
	// fire "party-starting" after the connections are closed.
	m.cancelScheduleTimerLocked(ps)

	// Stop the tick goroutine if it's running. MUST happen before we
	// close the sync conns, otherwise the goroutine could emit one more
	// tick into already-closed sockets. Idempotent — safe on a party that
	// never started a tick loop (never-played party).
	m.stopTickLoopLocked(ps)

	// Snapshot + clear the conn pools under the lock; do the actual socket
	// I/O (party-ended broadcast, close frames, Close) AFTER releasing it.
	// 2026-06 review — the old in-lock direct writes contended on each
	// conn's writeMu with a write pump potentially mid-write to a stalled
	// peer (10s deadline), holding ps.mu — and, from cleanupOnce/Shutdown,
	// the whole reaper — hostage for the duration. Clearing the maps first
	// also makes the party invisible to broadcasts immediately.
	closingConns := make([]*SafeConn, 0, len(ps.syncConns)+len(ps.roomConns))
	for uid, conn := range ps.syncConns {
		if conn != nil {
			closingConns = append(closingConns, conn)
		}
		delete(ps.syncConns, uid)
	}
	for uid, conn := range ps.roomConns {
		if conn != nil {
			closingConns = append(closingConns, conn)
		}
		delete(ps.roomConns, uid)
	}

	dbID := ps.dbID
	roomDBID := ps.roomDBID
	isRoomPersistent := ps.IsRoomPersistent
	ps.mu.Unlock()

	// Broadcast party-ended on both sockets so every client surface sees
	// the close (room handles UI teardown; sync stops the player mirror),
	// then close. Direct writes (not Send) so the final message is flushed
	// before Close rather than racing the pump's drain; blocking is
	// acceptable here because no locks are held.
	// 2026-05-25 — fresh write deadline before each (see
	// broadcastWriteTimeout). Critical here: if the host's conn has a
	// stale expired deadline, the party-ended message never lands and
	// the host's UI freezes on a dead party until they reload.
	endDeadline := time.Now().Add(broadcastWriteTimeout)
	for _, c := range closingConns {
		_ = c.SetWriteDeadline(endDeadline)
		_ = c.WriteMessage(websocket.TextMessage, []byte(`{"type":"party-ended","payload":{}}`))
		_ = c.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "party ended"),
			time.Now().Add(5*time.Second),
		)
		_ = c.Close()
	}

	// Mark inactive in DB, recording the final title when it still exists
	// (see EndWatchPartyOn).
	reelMediaID, reelTitle := int64(0), ""
	var reelEpisodeID *int64
	if dbID > 0 {
		var err error
		reelMediaID, reelEpisodeID, reelTitle, err = m.queries.EndWatchPartyOn(context.Background(), dbID, mediaIDAtEnd, episodeIDAtEnd, mediaTitleAtEnd, mediaPosterAtEnd)
		if err != nil {
			slog.Warn("failed to end party in DB", "error", err)
		}
	}

	// M9 — kick off highlight-reel generation. Goroutine + ffmpeg detach
	// from this function; the reel file appears at HighlightReelPath
	// minutes later (best-effort). Empty reactions → no reel, returns
	// immediately. On success the HOST gets a bell notification with the
	// reel link — by then every party conn is closed and the party UI is
	// gone, so the notification is the only surface that can announce it.
	// The reel is keyed by (code, dbID): persistent rooms and freed quick-
	// party codes REUSE codes across sessions, so a code-only file would
	// let a later session's reel be served under an earlier session's
	// notification (and vice versa for authorization).
	// It is cut from the title the row ended on, not the one in memory:
	// its gate reads the row, so the two must name the same title on every
	// path, including the ones where the final title could not be recorded.
	m.generateHighlightReelAsync(code, reactionsForReel, reelMediaID, reelEpisodeID, hostForReel, reelTitle, dbID)

	// M3 room lifecycle: persistent rooms survive the session end (touch
	// last_active_at so the "My Rooms" list orders correctly). Non-persistent
	// rooms (the implicit room created by every CreateParty pre-M3-API)
	// get soft-deleted, freeing their code for reuse and removing them from
	// owner listings. Background context so a request cancellation can't
	// orphan a room mid-cleanup.
	if roomDBID > 0 {
		bgCtx := context.Background()
		if isRoomPersistent {
			if err := m.queries.TouchRoom(bgCtx, roomDBID); err != nil {
				slog.Warn("failed to touch room on party end", "room_id", roomDBID, "error", err)
			}
		} else {
			if err := m.queries.SoftDeleteRoom(bgCtx, roomDBID); err != nil {
				slog.Warn("failed to soft-delete room on party end", "room_id", roomDBID, "error", err)
			}
		}
	}

	// Remove from memory
	m.mu.Lock()
	delete(m.parties, code)
	m.mu.Unlock()

	// The party is gone, so its cards can never be regenerated (the image
	// route resolves against live manager state) — the cached PNGs are now
	// pure dead weight.
	m.invalidateShareCache(code)

	slog.Info("watch party ended", "code", code, "room_persistent", isRoomPersistent)
	return nil
}

// ============================================================
// Chat
// ============================================================

// HandleChat processes a chat message from a participant.
func (m *Manager) HandleChat(code string, userID int64, username string, message string) error {
	if len(message) == 0 {
		return errUser("empty message")
	}
	// 2026-06 review (bug 6) — count RUNES, not bytes. `len(message)`
	// gave CJK/emoji users only ~125-250 characters against an error
	// message promising 500. The frontend input's maxLength=500 counts
	// UTF-16 units, so the two now roughly agree for the BMP. A byte
	// cap is unnecessary here: the WS read limit (partyMaxMessageSize)
	// already bounds the frame size.
	if utf8.RuneCountInString(message) > chatMaxLength {
		return errUser("message too long (max %d characters)", chatMaxLength)
	}

	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return errUser("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Check chat is enabled
	if !ps.Settings.AllowChat {
		return errUser("chat is disabled for this party")
	}

	// Verify user is a participant
	if _, ok := ps.Participants[userID]; !ok {
		return errUser("not a participant in this party")
	}

	// Trim leading/trailing whitespace; otherwise store the message as-is.
	//
	// 2026-05-26 — REMOVED html.EscapeString here. It was producing a real
	// user-visible bug: typing "I'm at 1:52" landed in the chat panel as
	// "I&#39;m at 1:52" because the frontend renders messages via React's
	// `{m.message}` (a JSX text child, which renders the string literally
	// and escapes HTML metacharacters at render time). Server-side
	// escaping plus React's render-time escaping double-encodes — the
	// `&#39;` from html.EscapeString gets shown as the literal text
	// `&#39;`, not as an apostrophe.
	//
	// XSS defense is still in place: every chat-message render site uses
	// `{m.message}` as a JSX text child, never dangerouslySetInnerHTML
	// (grepped the SPA — only ui/chart.tsx uses dHTML, and only for CSS,
	// not for chat). React's text-child escaping turns <script>alert(1)
	// </script> into the visible string "<script>alert(1)</script>" — no
	// code execution. Store-raw + render-escape is the canonical pattern;
	// the prior store-escape + render-escape was the bug.
	stored := strings.TrimSpace(message)
	if stored == "" {
		return errUser("empty message")
	}
	// 2026-05-27 (deep-debug Bug 9 fix) — TrimSpace uses unicode.IsSpace
	// which catches NBSP/tab/newline but NOT zero-width chars (U+200B
	// Zero-Width Space, U+FEFF BOM, U+2060 Word Joiner). A user could
	// send a chat of only ZWSPs and get a visually-empty bubble that
	// fills the ring buffer + counts against rate-limit budgets. Require
	// at least one printable, non-space rune. Short-circuits on the first
	// good rune so the per-call cost is negligible.
	hasPrintable := false
	for _, r := range stored {
		if unicode.IsPrint(r) && !unicode.IsSpace(r) {
			hasPrintable = true
			break
		}
	}
	if !hasPrintable {
		return errUser("empty message")
	}

	// Generate message ID
	msgID := fmt.Sprintf("%d-%d", time.Now().UnixNano(), userID)

	chatMsg := ChatMessage{
		ID:        msgID,
		UserID:    userID,
		Username:  username,
		Message:   stored,
		Timestamp: time.Now(),
	}

	// Append to ring buffer
	if len(ps.ChatHistory) >= chatHistoryMax {
		// Shift: drop oldest, append new
		ps.ChatHistory = append(ps.ChatHistory[1:], chatMsg)
	} else {
		ps.ChatHistory = append(ps.ChatHistory, chatMsg)
	}

	// Broadcast to all participants
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type": "chat-message",
		"payload": map[string]interface{}{
			"id":        chatMsg.ID,
			"user_id":   chatMsg.UserID,
			"username":  chatMsg.Username,
			"message":   chatMsg.Message,
			"timestamp": chatMsg.Timestamp.Format(time.RFC3339),
		},
	})

	return nil
}

// ============================================================
// Reactions
// ============================================================

// HandleReaction processes an emoji reaction from a participant.
//
// M6: the optional clientAbsMs argument is the timecode at which the
// participant sent the reaction (in absolute source-ms — the wire
// protocol's coordinate space). When > 0, it's validated against the
// party's current position and clamped to a generous ±5min window;
// outliers fall back to the server's authoritative CurrentAbsMs(). The
// validated timestamp is recorded in the ring buffer for the M9 highlight
// reel and rebroadcast in the payload so all peers paint the floating
// emoji "at the right moment" even under WebSocket delivery jitter.
//
// Passing 0 (V2 callers, future clients with no current position) tells
// the server to stamp from its own state — equivalent to "now in
// movie-time".
func (m *Manager) HandleReaction(code string, userID int64, username string, emoji string, clientAbsMs int64) error {
	if !allowedReactions[emoji] {
		return errUser("emoji not in allowed reactions whitelist")
	}

	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return errUser("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Verify user is a participant
	if _, ok := ps.Participants[userID]; !ok {
		return errUser("not a participant in this party")
	}

	// Resolve the timestamp the reaction is tagged against. Default to
	// the server's authoritative position. Honor the client-claimed
	// timestamp only if it's within reactionAbsMsClampWindow of where
	// the party actually is — otherwise drop it silently and use the
	// server position. This makes the timeline tamper-resistant.
	authoritativeAbsMs := ps.CurrentAbsMs()
	stampedAbsMs := authoritativeAbsMs
	if clientAbsMs > 0 {
		delta := clientAbsMs - authoritativeAbsMs
		if delta < 0 {
			delta = -delta
		}
		if delta <= reactionAbsMsClampWindow {
			stampedAbsMs = clientAbsMs
		}
	}

	// Build a single ReactionRecord and use it for both the ring buffer
	// and the wire payload. M6/L5 fix — previously we appended a struct
	// AND hand-built a map[string]interface{} broadcast with the same
	// fields. Two sources of truth; a future struct field addition
	// (color hint, variant) would have silently failed to reach the
	// wire. One struct, one source of truth.
	rec := ReactionRecord{
		UserID:    userID,
		Username:  username,
		Emoji:     emoji,
		AbsMs:     stampedAbsMs,
		CreatedAt: time.Now(),
	}

	// Append to ring buffer for M9 timeline / highlight-reel.
	ps.Reactions = append(ps.Reactions, rec)
	if len(ps.Reactions) > reactionsRingBufferMax {
		// Drop the oldest. Slice off the head; cap unchanged so the
		// underlying array reuses memory (Go's append will reallocate
		// when needed; we'd rather pay an occasional realloc than keep
		// the old array pinned forever).
		ps.Reactions = ps.Reactions[len(ps.Reactions)-reactionsRingBufferMax:]
	}

	// Broadcast to all participants. The ReactionRecord's JSON tags
	// produce the on-the-wire payload directly — user_id, username,
	// emoji, abs_ms, created_at. Clients render the overlay from
	// {emoji, username, user_id} and ignore the rest; created_at is
	// useful for M9 timeline labelling ("Sarah laughed 3s ago"). Both
	// V2 and V3 clients tolerate unknown fields (standard JSON.parse).
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type":    "reaction",
		"payload": rec,
	})

	return nil
}

// RecentReactions returns a snapshot copy of the party's reaction ring
// buffer. Used by M9's timeline / highlight-reel jobs that need to look
// at recent reaction activity without holding ps.mu. Returns an empty
// slice when the party doesn't exist (no error) — callers shouldn't fail
// hard on a missing party.
func (m *Manager) RecentReactions(code string) []ReactionRecord {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return nil
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if len(ps.Reactions) == 0 {
		return nil
	}
	out := make([]ReactionRecord, len(ps.Reactions))
	copy(out, ps.Reactions)
	return out
}

// ============================================================
// M9 — Reaction-driven highlight reel
// ============================================================
//
// At party-end, we generate a 30-second MP4 stitching the top 5
// most-reacted moments. The reaction ring buffer (PartyState.Reactions)
// is the data source. Algorithm:
//
//  1. Bucket reactions into 10-second sliding windows.
//  2. Pick the top 5 windows by reaction count (ties broken by recency).
//  3. For each window's center abs_ms, extract a 6-second clip from the
//     source media (±3s).
//  4. Concatenate via ffmpeg's concat demuxer.
//
// Best-effort: failure is logged but never propagates. Parties without
// reactions produce no reel. Polish for M9+: overlay emojis as text via
// `drawtext` with a color-emoji font (currently skipped due to font-dep
// complexity — see handoff doc).

const (
	highlightReelTopN          = 5  // top-N most-reacted moments to stitch
	highlightReelWindowSec     = 10 // sliding-window size for reaction density
	highlightReelClipBeforeSec = 3  // seconds before the moment
	highlightReelClipAfterSec  = 3  // seconds after the moment
)

// highlightMoment is a (window center, reaction count) pair after
// bucketing the ring buffer.
type highlightMoment struct {
	CenterMs int64
	Count    int
}

// generateHighlightReelAsync kicks off MP4 generation in a goroutine.
// Best-effort: any failure (no reactions, ffmpeg missing, file IO) logs
// at Warn and exits. The reel either exists at HighlightReelPath after
// some seconds, or it doesn't — the endpoint 404s gracefully either way.
//
// Called from endPartyInternal AFTER the ps.mu lock is released so the
// long-running ffmpeg job doesn't block other parties.
func (m *Manager) generateHighlightReelAsync(code string, reactions []ReactionRecord, mediaItemID int64, episodeID *int64, hostUserID int64, mediaTitle string, partyDBID int64) {
	if m.onReelForTest != nil {
		m.onReelForTest(mediaItemID, episodeID, mediaTitle)
	}
	m.mu.RLock()
	dir := m.highlightCacheDir
	queries := m.queries
	parentCtx := m.shutdownCtx
	m.mu.RUnlock()
	if dir == "" {
		slog.Debug("highlight reel: skipping (cache dir not configured)", "code", code)
		return
	}
	if mediaItemID == 0 {
		slog.Debug("highlight reel: skipping (no media)", "code", code)
		return
	}
	if len(reactions) < highlightReelTopN {
		slog.Debug("highlight reel: skipping (not enough reactions)", "code", code, "got", len(reactions), "min", highlightReelTopN)
		return
	}
	if queries == nil {
		slog.Debug("highlight reel: skipping (no DB)", "code", code)
		return
	}
	if partyDBID == 0 {
		// No DB row for the session (insert failed at create time) means
		// ServeHighlightReel could never authorize anyone for it post-end.
		slog.Debug("highlight reel: skipping (no DB row for session)", "code", code)
		return
	}
	if parentCtx == nil {
		parentCtx = context.Background()
	}

	go func() {
		// M1 fix — parent off the server-lifecycle context so SIGTERM
		// unwinds the ffmpeg job rather than orphaning it. 5min timeout
		// remains as the upper bound for a runaway render.
		ctx, cancel := context.WithTimeout(parentCtx, 5*time.Minute)
		defer cancel()

		// The file the reactions were made on: a show's own episode, never
		// the series' first one (see ReelSourcePath).
		srcPath := queries.ReelSourcePath(ctx, mediaItemID, episodeID)
		if m.onReelSourceForTest != nil {
			m.onReelSourceForTest(srcPath)
		}
		if srcPath == "" {
			slog.Warn("highlight reel: no source file for media", "code", code, "media_id", mediaItemID, "episode_id", episodeID)
			return
		}
		if _, err := os.Stat(srcPath); err != nil {
			slog.Warn("highlight reel: source file unreadable", "code", code, "path", srcPath, "err", err)
			return
		}

		moments := pickHighlightMoments(reactions, highlightReelTopN, highlightReelWindowSec*1000)
		if len(moments) == 0 {
			return
		}

		if err := os.MkdirAll(dir, 0o755); err != nil {
			slog.Warn("highlight reel: mkdir failed", "code", code, "dir", dir, "err", err)
			return
		}

		// M9/H1 — render to a .tmp file and atomic-rename on success so
		// HighlightReelPath never returns a half-written MP4 to a client
		// hitting /highlight.mp4 while ffmpeg is still writing. ffmpeg's
		// +faststart pass writes the moov atom AFTER the mdat box, so a
		// partial file is unplayable until the rename lands.
		outPath := filepath.Join(dir, highlightReelFilename(code, partyDBID))
		tmpPath := outPath + ".tmp"
		if err := renderHighlightReel(ctx, srcPath, tmpPath, moments); err != nil {
			slog.Warn("highlight reel: render failed", "code", code, "err", err)
			// Clean up any partial output so we don't leak. Ignore the
			// remove error — file might not exist.
			_ = os.Remove(tmpPath)
			return
		}
		if err := os.Rename(tmpPath, outPath); err != nil {
			slog.Warn("highlight reel: rename failed", "code", code, "err", err)
			_ = os.Remove(tmpPath)
			return
		}
		slog.Info("highlight reel: generated", "code", code, "moments", len(moments), "out", outPath)
		m.notifyReelReady(ctx, code, partyDBID, hostUserID, mediaTitle)
	}()
}

// highlightReelFilename is the on-disk name for a session's reel:
// <CODE>-<partyDBID>.mp4. Session-scoped (not just code-scoped) because
// persistent rooms and freed quick-party codes reuse codes; the reaper's
// filename filter and HighlightReelPath must agree with this shape.
func highlightReelFilename(code string, partyDBID int64) string {
	return fmt.Sprintf("%s-%d.mp4", code, partyDBID)
}

// notifyReelReady persists a bell notification for the party host and pushes
// it live over the 'notification' WebSocket event. The reel finishes minutes
// after endPartyInternal closed every party conn, so the notification is the
// only surface that can announce it. Host-only by design — the host can share
// the link; ServeHighlightReel authorizes past participants against the DB
// audit rows. Best-effort like the reel itself: failures log and move on.
func (m *Manager) notifyReelReady(ctx context.Context, code string, partyDBID, hostUserID int64, mediaTitle string) {
	m.mu.RLock()
	dispatcher := m.dispatcher
	m.mu.RUnlock()
	if dispatcher == nil {
		// Not wired (tests). Production always wires it in main.go; dropping
		// the notification beats duplicating the persist+broadcast pipeline.
		slog.Warn("highlight reel: no dispatcher wired; skipping ready notification", "code", code)
		return
	}
	if hostUserID == 0 {
		return
	}
	title := mediaTitle
	if title == "" {
		title = "Watch party"
	}
	// The dispatcher owns the persist → WS → push pipeline, including the
	// WithoutCancel+timeout detachment this function used to hand-roll: the
	// reel just landed on disk and this is its only announcement, so a
	// SIGTERM between the rename and here must not silently drop the write.
	dispatcher.Notify(ctx, &models.Notification{
		UserID: hostUserID,
		Type:   models.NotificationPartyReelReady,
		Title:  title,
		Link:   fmt.Sprintf("/api/parties/%s/highlight.mp4?session=%d", code, partyDBID),
	})
}

// pickHighlightMoments buckets reactions into sliding windows and returns
// the top-N windows by reaction count. Windows are seeded at every
// reaction's abs_ms (so a window always contains at least its seed).
// Coalesces overlapping picks: if two top windows are within windowMs of
// each other, the lower-count one is dropped.
func pickHighlightMoments(reactions []ReactionRecord, topN int, windowMs int64) []highlightMoment {
	if len(reactions) == 0 || topN <= 0 {
		return nil
	}

	// Sort a copy by abs_ms ascending. The ring buffer is insertion-
	// ordered (which IS chronological for events from the same client),
	// but cross-client delivery jitter means we should re-sort to be safe.
	sorted := make([]ReactionRecord, len(reactions))
	copy(sorted, reactions)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].AbsMs < sorted[j].AbsMs })

	half := windowMs / 2
	candidates := make([]highlightMoment, 0, len(sorted))

	// For each reaction, count how many other reactions fall within
	// ±half. O(N^2) — fine for N≤200 (the ring-buffer cap).
	for _, seed := range sorted {
		count := 0
		for _, other := range sorted {
			if other.AbsMs >= seed.AbsMs-half && other.AbsMs <= seed.AbsMs+half {
				count++
			}
		}
		candidates = append(candidates, highlightMoment{CenterMs: seed.AbsMs, Count: count})
	}

	// Sort by count desc, then by abs_ms ASC (early moments slightly
	// preferred for tie-break — more linear-feeling reel).
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Count != candidates[j].Count {
			return candidates[i].Count > candidates[j].Count
		}
		return candidates[i].CenterMs < candidates[j].CenterMs
	})

	// Greedy de-overlap: pick the top, skip any subsequent candidate
	// within windowMs of an already-picked one.
	picked := make([]highlightMoment, 0, topN)
	for _, c := range candidates {
		overlap := false
		for _, p := range picked {
			diff := c.CenterMs - p.CenterMs
			if diff < 0 {
				diff = -diff
			}
			if diff < windowMs {
				overlap = true
				break
			}
		}
		if overlap {
			continue
		}
		picked = append(picked, c)
		if len(picked) >= topN {
			break
		}
	}

	// Order picked moments chronologically for the reel itself (so the
	// final MP4 plays in source-time order, not popularity order).
	sort.Slice(picked, func(i, j int) bool { return picked[i].CenterMs < picked[j].CenterMs })
	return picked
}

// renderHighlightReel invokes ffmpeg to extract per-moment clips and
// concatenate them into a single MP4. Strategy: one ffmpeg process with
// multiple `-ss` / `-t` clip extractions piped through `-filter_complex
// concat`. Re-encodes (no -c copy) because keyframe alignment across
// disparate source positions is unreliable.
//
// Output: 1280x720 H.264 + AAC, ~30s total. Re-encode is ~5-30s
// wall-clock on a typical home server depending on hardware.
func renderHighlightReel(ctx context.Context, srcPath, outPath string, moments []highlightMoment) error {
	if len(moments) == 0 {
		return fmt.Errorf("no moments to render")
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", highlightReelArgs(srcPath, outPath, moments)...)
	return runHighlightReelFFmpeg(cmd)
}

// highlightReelArgs builds the ffmpeg argv for a reel render. Split out from
// renderHighlightReel purely so the argv is assertable without a real ffmpeg
// binary: the muxer bug this guards against is invisible to any test that
// can't run ffmpeg, and CI has no media tooling. See
// TestHighlightReelArgs_ExplicitMuxer.
func highlightReelArgs(srcPath, outPath string, moments []highlightMoment) []string {
	args := make([]string, 0, 6+len(moments)*4+8)
	args = append(args, "-y", "-hide_banner", "-loglevel", "warning")

	// One input per clip — each opens the source at a different -ss.
	// -ss BEFORE -i is fast (seek to keyframe before decoding), but may
	// miss exact frame. For a highlight reel that's fine.
	for _, mo := range moments {
		startSec := float64(mo.CenterMs)/1000.0 - float64(highlightReelClipBeforeSec)
		if startSec < 0 {
			startSec = 0
		}
		dur := float64(highlightReelClipBeforeSec + highlightReelClipAfterSec)
		args = append(args,
			"-ss", fmt.Sprintf("%.3f", startSec),
			"-t", fmt.Sprintf("%.3f", dur),
			"-i", srcPath,
		)
	}

	// Build the filter_complex: scale every input to 1280x720, then
	// concat them. Each input is [N:v:0]+[N:a:0]; concat takes n=N v=1
	// a=1 and outputs [outv][outa].
	var fc string
	for i := range moments {
		fc += fmt.Sprintf("[%d:v:0]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v%d];", i, i)
		fc += fmt.Sprintf("[%d:a:0]aresample=44100[a%d];", i, i)
	}
	for i := range moments {
		fc += fmt.Sprintf("[v%d][a%d]", i, i)
	}
	fc += fmt.Sprintf("concat=n=%d:v=1:a=1[outv][outa]", len(moments))

	args = append(args,
		"-filter_complex", fc,
		"-map", "[outv]",
		"-map", "[outa]",
		"-c:v", "libx264",
		"-preset", "veryfast",
		"-crf", "23",
		"-c:a", "aac",
		"-b:a", "128k",
		"-movflags", "+faststart",
		// Muxer MUST be explicit. Callers render to "<name>.mp4.tmp"
		// (atomic-rename staging, see generateHighlightReel), and ffmpeg
		// infers the output format from the file extension — ".tmp" matches
		// nothing, so every render died with "Unable to choose an output
		// format ... Invalid argument" before the encode even started.
		"-f", "mp4",
		outPath,
	)
	return args
}

// runHighlightReelFFmpeg starts the prepared command, drains stderr with a
// bounded buffer, and waits. Split from renderHighlightReel alongside
// highlightReelArgs; behaviour is unchanged.
func runHighlightReelFFmpeg(cmd *exec.Cmd) error {
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("ffmpeg stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("ffmpeg start: %w", err)
	}
	// Drain stderr to avoid hangs on slow filesystems. We don't log
	// the raw output unless ffmpeg exits non-zero; expected output
	// for healthy renders is innocuous "deprecated pixel format" warnings.
	stderrBuf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for {
		n, rerr := stderr.Read(tmp)
		if n > 0 {
			stderrBuf = append(stderrBuf, tmp[:n]...)
			if len(stderrBuf) > 16384 {
				// Keep last 16KB — bounded.
				stderrBuf = stderrBuf[len(stderrBuf)-16384:]
			}
		}
		if rerr != nil {
			break
		}
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("ffmpeg failed: %w (last stderr: %s)", err, string(stderrBuf))
	}
	return nil
}

// ============================================================
// M7 — Voice presence (WebRTC mesh signaling relay)
// ============================================================
//
// The server is a JSON message relay. Audio bytes flow browser-to-browser
// over WebRTC; we never see them. Three message families:
//   1. Membership: voice-join / voice-leave (broadcast to all room conns).
//   2. Initial peer list: voice-peers (sent only to the joiner, with the
//      set of existing voice participants so they can initiate offers).
//   3. Targeted signaling: voice-offer / voice-answer / voice-ice
//      (forwarded to exactly one peer — the to_user_id in the payload).
//
// Mesh topology means O(N^2) PCs across the party. Fine for ≤4
// participants; M8 upgrades to SFU. Cross-NAT failure is expected without
// TURN (M8 adds coturn).

// VoicePeerInfo is a single existing voice participant as returned to a
// new joiner. The new joiner uses this list to initiate outbound offers
// to every existing peer (the "newcomer initiates" pattern — avoids
// offer-collision races because only one side ever initiates).
type VoicePeerInfo struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
}

// JoinVoice marks a participant as "in voice" and returns the list of
// peers they should send WebRTC offers to. Also broadcasts
// voice-peer-joined to every OTHER room conn so existing peers expect
// the inbound offer storm.
//
// Idempotent: if the user is already in voice, returns the current peer
// list without re-broadcasting (avoids ping-pong if a flaky frontend
// double-clicks the mic button).
//
// Requires the user be a participant in the party (i.e. they've joined
// the room socket). Voice is opt-in per session and never persisted.
func (m *Manager) JoinVoice(code string, userID int64, username string) ([]VoicePeerInfo, error) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return nil, errUser("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	if _, ok := ps.Participants[userID]; !ok {
		return nil, errUser("not a participant in this party")
	}

	if ps.VoiceParticipants == nil {
		ps.VoiceParticipants = make(map[int64]bool)
	}

	// Build the peer list BEFORE adding ourselves — the joiner shouldn't
	// try to offer to themselves.
	peers := make([]VoicePeerInfo, 0, len(ps.VoiceParticipants))
	for peerID := range ps.VoiceParticipants {
		if peerID == userID {
			continue
		}
		p, ok := ps.Participants[peerID]
		if !ok {
			// Voice participant whose room socket is gone but
			// cleanup didn't run yet — skip and let the next
			// LeavePartyV3Room sweep them.
			continue
		}
		peers = append(peers, VoicePeerInfo{UserID: peerID, Username: p.Username})
	}

	if ps.VoiceParticipants[userID] {
		// Already in voice — return current peers without re-broadcast.
		return peers, nil
	}

	ps.VoiceParticipants[userID] = true

	// Tell everyone ELSE that a new peer is in voice. They don't initiate
	// — they wait for the joiner's offer — but they do want to know who
	// to expect contact from, and to render UI state ("Sarah joined voice").
	m.broadcastToRoomPeersExcludeLocked(ps, userID, map[string]interface{}{
		"type": "voice-peer-joined",
		"payload": map[string]interface{}{
			"user_id":  userID,
			"username": username,
		},
	})

	return peers, nil
}

// LeaveVoice removes the user from the voice set and broadcasts
// voice-peer-left. Idempotent — leaving when not in voice is a no-op.
// Called both by the explicit voice-leave message AND by
// LeavePartyV3Room when the room socket dies (voice never outlives the
// room socket — losing the connection drops your mic).
func (m *Manager) LeaveVoice(code string, userID int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return nil
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	return m.leaveVoiceLocked(ps, userID)
}

// leaveVoiceLocked is the shared core of LeaveVoice. Caller must hold
// ps.mu. Exists so LeavePartyV3Room (which already holds ps.mu) can
// reuse the same logic without reacquiring.
func (m *Manager) leaveVoiceLocked(ps *PartyState, userID int64) error {
	if ps.VoiceParticipants == nil || !ps.VoiceParticipants[userID] {
		return nil
	}
	delete(ps.VoiceParticipants, userID)

	// Broadcast to all OTHER room conns. Including the leaver in the
	// broadcast is harmless but wasteful — they're tearing down their
	// own PCs locally.
	m.broadcastToRoomPeersExcludeLocked(ps, userID, map[string]interface{}{
		"type": "voice-peer-left",
		"payload": map[string]interface{}{
			"user_id": userID,
		},
	})
	return nil
}

// RelayVoiceSignal forwards a WebRTC signaling message (offer / answer /
// ICE candidate) to a single target peer. The server validates that both
// sender and target are in voice + same party, then forwards the message
// verbatim with `from_user_id` stamped server-side (so a peer can't
// spoof another peer's identity).
//
// `signalType` is "voice-offer" | "voice-answer" | "voice-ice".
// `payload` is forwarded as-is to the recipient — the server doesn't
// parse the SDP / candidate. The recipient's WebRTC stack does.
//
// Returns an error for invalid sender/recipient/type. Drops silently if
// the recipient's room socket is gone (race: they left voice between our
// validation and the write — not worth surfacing).
func (m *Manager) RelayVoiceSignal(code string, fromUserID, toUserID int64, signalType string, payload map[string]interface{}) error {
	if signalType != "voice-offer" && signalType != "voice-answer" && signalType != "voice-ice" {
		return errUser("invalid voice signal type: %s", signalType)
	}
	if fromUserID == toUserID {
		return errUser("cannot signal to self")
	}

	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return errUser("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	if ps.VoiceParticipants == nil || !ps.VoiceParticipants[fromUserID] {
		return errUser("sender not in voice")
	}
	if !ps.VoiceParticipants[toUserID] {
		return errUser("recipient not in voice")
	}
	targetConn, ok := ps.roomConns[toUserID]
	if !ok || targetConn == nil {
		// Recipient's room socket is gone — they're about to be cleaned
		// up. Drop the signal silently rather than logging noise.
		return nil
	}

	// Stamp from_user_id so the recipient knows who sent it. We do not
	// trust client-provided from_user_id; we ALWAYS overwrite from the
	// authenticated WS sender.
	if payload == nil {
		payload = make(map[string]interface{})
	}
	payload["from_user_id"] = fromUserID
	// Strip any client-supplied to_user_id — it was instructions for the
	// server, not data for the recipient.
	delete(payload, "to_user_id")

	msg := map[string]interface{}{
		"type":    signalType,
		"payload": payload,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("voice signal marshal: %w", err)
	}
	if err := targetConn.Send(data); err != nil {
		// Best-effort: don't propagate send errors — the room-socket
		// read pump will detect the dead conn and clean up.
		slog.Debug("voice signal send failed", "code", code, "to", toUserID, "err", err)
	}
	return nil
}

// broadcastToRoomPeersExcludeLocked emits to every room conn except the
// given user's. Used by voice-peer-joined / voice-peer-left so the
// originator doesn't get an echo of their own state change.
// Requires ps.mu held.
func (m *Manager) broadcastToRoomPeersExcludeLocked(ps *PartyState, excludeUserID int64, msg map[string]interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	for uid, c := range ps.roomConns {
		if c == nil || uid == excludeUserID {
			continue
		}
		_ = c.Send(data)
	}
}

// ============================================================
// Media Change (TV episode auto-advance + manual swap)
// ============================================================

// changeMediaValidateTimeout bounds the existence check ChangeMedia runs
// before mutating. Short on purpose: it is a single indexed EXISTS, and a
// slow database must not hold up a host's episode advance.
const changeMediaValidateTimeout = 2 * time.Second

// CallerProfile resolves a socket caller's acting profile, at connect while
// its session row is certainly live. A socket outlives that row: the client
// rotates its session about every 15 minutes, the purge deletes the old row
// soon after, and a row that is gone resolves to the account's most
// restrictive profile, which refused an unrestricted host's next episode an
// hour into a party. nil when there is no pool or the lookup fails; the
// socket then resolves again at its next change-media (by then possibly to
// the most restrictive profile), so a failed lookup skips ChangeMedia's
// best-effort ceiling check for one message, as it did before.
func (m *Manager) CallerProfile(ctx context.Context, userID, refreshTokenID int64) *models.UserProfile {
	if m.queries == nil {
		return nil
	}
	profile, err := m.queries.ResolveActingProfile(ctx, userID, refreshTokenID)
	if err != nil {
		slog.Warn("party: resolve the caller's acting profile failed", "user_id", userID, "error", err)
		return nil
	}
	return profile
}

// ChangeMedia swaps the party's media to a new item/episode. Used primarily
// for TV episode auto-advance when the host's video reaches its end —
// the host's client resolves the next episode via the existing /next-episode
// endpoint and sends `change-media` over the room socket, which lands here.
//
// Host-only. Resets the playback anchor to 0 and transitions the party to
// Paused — the new media starts in the same state as a fresh party
// (everyone in Paused at position 0, host clicks play to resume).
// Stops the tick loop because we're entering Paused; the next request-play
// from the host restarts it.
//
// Broadcasts a `media-change` message on every connected room socket so
// the UI can tear down the old player and re-init with the new source.
// The new media's `hello` will be sent on the sync socket the next time
// each client (re-)opens it, OR the next tick / pause broadcast carries
// the new anchor — but in practice clients teardown+reopen their sync
// socket as part of the player re-init, so they receive a fresh hello.
// callerUserID/callerProfile identify whoever SENT the change-media
// message, not necessarily the host — the host-only check below runs AFTER
// the DB validation block (see that block's own comment for why), so
// naming these "host*" would be misleading about what's verified when.
// callerProfile is the caller's acting profile as CallerProfile resolved it
// when the socket connected; nil skips the ceiling check.
func (m *Manager) ChangeMedia(code string, callerUserID int64, callerProfile *models.UserProfile, newMediaItemID int64, newEpisodeID *int64, newMediaTitle, newMediaPoster string) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return errUser("party not found")
	}

	// Issue #460 — both ids come straight off the wire, and until the
	// next-episode button nothing ever sent this message. Reject a pair
	// that doesn't exist (or an episode belonging to another show) BEFORE
	// mutating: the in-memory swap used to succeed while the matching FK
	// failed inside UpdatePartyMedia's fire-and-forget goroutine, leaving
	// the room playing one thing and the row saying another until a
	// restart rehydrated the stale value.
	//
	// Deliberately outside ps.mu: this is the party-wide lock that ticks
	// and broadcasts take, and a DB round-trip under it would stall the
	// room. That does mean a non-host reaches the query before the
	// host check below — acceptable, since it's one indexed EXISTS behind
	// the room socket's 30/min limiter, and authorization itself is
	// unchanged. Skipped when queries is nil (tests build the manager
	// without a pool).
	if m.queries != nil {
		ctx, cancel := context.WithTimeout(context.Background(), changeMediaValidateTimeout)
		defer cancel()
		ok, err := m.queries.PartyMediaTargetExists(ctx, newMediaItemID, newEpisodeID)
		if err != nil {
			// Don't strand the room on a transient DB hiccup: log and let
			// the swap through, exactly as the persist path already
			// tolerates a failed write.
			slog.Warn("party: media-change validation failed, allowing swap",
				"code", code, "media_item_id", newMediaItemID, "error", err)
		} else if !ok {
			return errUser("unknown media for this party")
		}

		// Issue #462 — best-effort early rejection using the CALLER's own
		// rating ceiling (not yet verified as the host — see below). This is
		// deliberately NOT the security boundary (the real one is the
		// read/playback path enforcement in internal/api/phase2_handlers.go,
		// which every participant's player hits regardless of how it
		// learned the media id) — it only covers a host swapping to
		// something above their OWN ceiling, not a participant whose
		// ceiling is lower than the host's. Party JOIN carries no per-
		// participant rating gate at all (pre-existing, documented limit);
		// closing that is separate follow-up work, not this fix. Fails OPEN
		// on a lookup error, matching the existence check above — this
		// check exists for a good error message, not enforcement.
		//
		// It runs before the host-only check below and applies only the
		// CALLER's own ceiling (ownership-scoped by ResolveActingProfile).
		// Its error differs from the existence check's, though, so any
		// participant can tell a missing id from an over-ceiling one, which
		// the by-id routes no longer reveal (a documented gap).
		if callerProfile != nil {
			if item, ierr := m.queries.GetMediaItem(ctx, newMediaItemID); ierr == nil && item != nil {
				if !db.RatingAllowed(callerProfile.MaxAgeRating, item.ContentRating) {
					return errUser("media exceeds this profile's content rating")
				}
			}
		}
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Host-only — guests can't reroute the whole party to a different
	// episode. (Future: allow with democratic vote if AllowPause-style
	// settings expand.)
	if ps.HostUserID != callerUserID {
		return errUser("only the host can change media")
	}

	// Reactions are positions on the timeline of the title they were sent
	// on. A different title (or episode: a show's id is the series, so the
	// episode is what changes on an advance) starts a new timeline, and
	// carrying the old one's reactions over would cut the reel from the new
	// file at moments that belong to the old one, and paint them on its
	// seekbar. A re-sent change to the same title keeps them.
	if ps.MediaItemID != newMediaItemID || !sameEpisode(ps.EpisodeID, newEpisodeID) {
		ps.Reactions = nil
	}
	// Reset playback to a fresh-party state. V3 model: Paused at anchor=0,
	// tick loop stopped. Host's next request-play kicks off the new media.
	ps.MediaItemID = newMediaItemID
	ps.EpisodeID = newEpisodeID
	ps.MediaTitle = newMediaTitle
	ps.MediaPoster = newMediaPoster
	ps.setAnchorLocked(0, false)
	ps.StateRevision++
	m.stopTickLoopLocked(ps)

	// The cached share artwork is now stale — it shows the old episode's
	// poster. Drop it. The share CARD additionally fingerprints its cache
	// key on (schedule | title | poster | host | code), so a media change
	// already renders to a different file; this eviction is what reclaims
	// the superseded one instead of leaving it for the 30-day reaper.
	m.invalidateShareCache(code)

	// Persist the new media to DB so reconnects + share-image lookups
	// see the updated values. Best-effort: a transient DB hiccup
	// shouldn't fail the in-memory state change. Capture dbID before
	// the goroutine so we don't re-enter ps.mu inside the closure, and
	// use a fresh context so the call doesn't inherit caller cancellation.
	if m.queries != nil {
		dbID := ps.dbID
		go func(id int64, mid int64, eid *int64, title, poster string) {
			if err := m.queries.UpdatePartyMedia(context.Background(), id, mid, eid, title, poster); err != nil {
				slog.Warn("party: persist media change failed", "party_id", id, "error", err)
			}
		}(dbID, newMediaItemID, newEpisodeID, newMediaTitle, newMediaPoster)
	}

	// Broadcast to all participants. UI tears down player + re-inits with
	// new media; sync socket will deliver fresh hello on reconnect.
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type": "media-change",
		"payload": map[string]interface{}{
			"media_item_id": newMediaItemID,
			"episode_id":    newEpisodeID,
			"media_title":   newMediaTitle,
			"media_poster":  newMediaPoster,
			"rev":           ps.StateRevision,
		},
	})

	return nil
}

// sameEpisode reports whether two optional episode ids name the same episode
// (both absent counts as the same).
func sameEpisode(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// ============================================================
// Ready signal (M5 — spoiler-free start)
// ============================================================

// MarkReady toggles a participant's Ready state. Used by the M5 lobby UI's
// "I'm Ready" button. Broadcasts the updated participant list to all room
// connections so everyone sees the green dots live-update.
//
// Stateless from the host's POV — host clicks play later, server's
// HandleRequestPlay then evaluates the gate (all non-host Ready required
// if SpoilerFreeStart is on and this is the first play). The gate isn't
// applied here so a guest toggling Ready while a host is hitting play
// can't race-condition the play check.
//
// Allowed for any participant; the host's own Ready is a no-op for the
// gate (host never blocks themselves) but updates the broadcast for
// consistency.
func (m *Manager) MarkReady(code string, userID int64, ready bool) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return errUser("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	p, ok := ps.Participants[userID]
	if !ok {
		return errUser("not a participant in this party")
	}
	p.Ready = ready
	p.LastSeen = time.Now()
	// Snapshot the participant list under the lock so the broadcast
	// payload doesn't iterate a map that might be mutated concurrently.
	snapshot := make([]map[string]interface{}, 0, len(ps.Participants))
	for _, pt := range ps.Participants {
		if pt == nil {
			continue
		}
		snapshot = append(snapshot, map[string]interface{}{
			"user_id":  pt.UserID,
			"username": pt.Username,
			"is_host":  pt.IsHost,
			"ready":    pt.Ready,
		})
	}

	// broadcastToPartyLocked requires ps.mu held — deferred Unlock above
	// keeps the lock contract intact.
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type": "ready-changed",
		"payload": map[string]interface{}{
			"user_id":      userID,
			"ready":        ready,
			"participants": snapshot,
		},
	})

	// 2026-06 review (bug 2) — a Ready toggle can unblock an overdue
	// scheduled start whose first fire was held by the spoiler gate.
	m.maybeRetryScheduledStartLocked(ps)

	return nil
}

// ============================================================
// Track Sync (audio + subtitle)
// ============================================================

// BroadcastTrackChange propagates the host's audio or subtitle track
// selection to every participant. Host-only — guests' track changes
// are personal preferences and don't broadcast.
//
// Stateless: the server doesn't track current selections in PartyState
// (would add complexity for late-joiner replay which we don't currently
// do for tracks — late joiners get whatever default the HLS playlist
// declares, then can manually pick their own track or wait for the next
// host change). If we ever want late-joiner track replay, store the
// latest selection in PartyState and include it in BuildPartyStateMessage.
//
// Validates the `kind` enum at the boundary so a malformed message
// can't spam invalid types through. Index validation is per-client —
// the server doesn't know the available track count.
func (m *Manager) BroadcastTrackChange(code string, hostUserID int64, kind string, index int) error {
	if kind != "audio" && kind != "subtitle" {
		return errUser("invalid track kind: %q (want 'audio' or 'subtitle')", kind)
	}

	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return errUser("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	if ps.HostUserID != hostUserID {
		return errUser("only the host can change tracks for the party")
	}

	// Broadcast to all participants INCLUDING the host. The host's local
	// player is already on the new track (the broadcast fires AFTER the
	// host's setAudioTrack/setSubtitleTrack call), and the inbound handler
	// checks `_partySuppressTrackBroadcast` to avoid a re-broadcast loop —
	// the host receives the event but doesn't act on it. This keeps the
	// broadcast logic symmetric (no per-recipient filtering).
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type": "track-change",
		"payload": map[string]interface{}{
			"kind":  kind,
			"index": index,
		},
	})

	return nil
}

// ============================================================
// Stale Cleanup
// ============================================================

// CleanupStale runs a periodic goroutine that ends parties where all
// participants have been unseen for longer than staleParticipantTimeout.
// Call this once at startup; it blocks until ctx is cancelled.
func (m *Manager) CleanupStale(ctx context.Context) {
	defer close(m.cleanupDone)

	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.cleanupOnce()
		case <-ctx.Done():
			return
		}
	}
}

// cleanupOnce checks all active parties and ends stale ones.
// Lock ordering: never hold m.mu while acquiring ps.mu (or vice versa in
// the opposite direction) to prevent deadlocks with endPartyInternal.
func (m *Manager) cleanupOnce() {
	now := time.Now()

	// Step 1: Snapshot the parties map under read lock (fast, no ps.mu acquired).
	m.mu.RLock()
	type partyRef struct {
		code string
		ps   *PartyState
	}
	refs := make([]partyRef, 0, len(m.parties))
	for code, ps := range m.parties {
		refs = append(refs, partyRef{code: code, ps: ps})
	}
	m.mu.RUnlock()

	// Step 2: Check staleness for each party individually (no m.mu held).
	var staleCodes []string
	for _, ref := range refs {
		ref.ps.mu.Lock()
		// Invites (2026-08 review, critical finding): a scheduled-but-
		// unstarted party is LEGITIMATELY empty and idle for hours or
		// days before showtime — the host books it, closes the tab, and
		// the invites/calendar point at its code the whole time. Reaping
		// it here (or via the host-disconnect grace in sync_v3.go, which
		// carries the same exemption) silently broke every scheduled
		// party whose host didn't babysit a tab. Exempt until the
		// scheduled start has passed by the normal staleness window; an
		// overdue-unstarted party (fire blocked, nobody ever came) then
		// ages out through the ordinary rules below.
		if ref.ps.StartedAt == nil && ref.ps.ScheduledStartAt != nil &&
			now.Before(ref.ps.ScheduledStartAt.Add(staleParticipantTimeout)) {
			ref.ps.mu.Unlock()
			continue
		}
		// For empty parties the staleness anchor is the LATER of creation
		// and actual start: an auto-started scheduled party (countdown
		// fired, nobody in the room yet) gets a fresh window from
		// showtime, not from a CreatedAt that may be days old.
		emptyAnchor := ref.ps.CreatedAt
		if ref.ps.StartedAt != nil && ref.ps.StartedAt.After(emptyAnchor) {
			emptyAnchor = *ref.ps.StartedAt
		}
		allStale := true
		if len(ref.ps.Participants) == 0 {
			if now.Sub(emptyAnchor) > staleParticipantTimeout {
				staleCodes = append(staleCodes, ref.code)
			}
		} else {
			for _, p := range ref.ps.Participants {
				if now.Sub(p.LastSeen) <= staleParticipantTimeout {
					allStale = false
					break
				}
			}
			if allStale {
				staleCodes = append(staleCodes, ref.code)
			}
		}
		ref.ps.mu.Unlock()
	}

	// Step 3: End stale parties (endPartyInternal manages its own locking).
	for _, code := range staleCodes {
		slog.Info("ending stale watch party", "code", code)
		m.mu.RLock()
		ps, exists := m.parties[code]
		m.mu.RUnlock()
		if exists {
			m.endPartyInternal(code, ps, 0)
		}
	}
}

// ============================================================
// Broadcasting
// ============================================================

// broadcastToPartyLocked sends a JSON message to all connected party members.
// ps.mu must be held by the caller.
func (m *Manager) broadcastToPartyLocked(ps *PartyState, msg interface{}) {
	m.broadcastToPartyExcludeLocked(ps, msg, 0)
}

// broadcastToPartyExcludeLocked sends a JSON message to all connected party
// members except the user with the given excludeUserID (0 means no exclusion).
// ps.mu must be held by the caller.
//
// Delivers on the room pool — chat, reactions, participant-join,
// media-change, track-change, and ready-changed all ride this.
// Sync-only messages (tick, pause, seek) use a separate emit helper
// that writes only to ps.syncConns — those don't ride this broadcaster.
func (m *Manager) broadcastToPartyExcludeLocked(ps *PartyState, msg interface{}, excludeUserID int64) {
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("failed to marshal party broadcast", "error", err)
		return
	}

	// 2026-06 — Send enqueues onto the per-conn write pump (fresh write
	// deadline per write happens in the pump; see broadcastWriteTimeout
	// for the stale-deadline production bug that design retires). Never
	// blocks under ps.mu; a send failure means the conn is closed (dead
	// peer or queue overflow) so it's pruned from the pool.
	var failedRoom []int64
	for uid, conn := range ps.roomConns {
		if uid == excludeUserID {
			continue
		}
		if conn == nil {
			failedRoom = append(failedRoom, uid)
			continue
		}
		if err := conn.Send(data); err != nil {
			slog.Debug("failed to send to party participant (room)", "user_id", uid, "error", err)
			failedRoom = append(failedRoom, uid)
		}
	}
	for _, uid := range failedRoom {
		delete(ps.roomConns, uid)
	}
	// Don't remove from Participants — they might reconnect.
}

// ============================================================
// State Query
// ============================================================

// GetPartyState returns a copy of the party state, or nil if not found.
// Thread-safe.
func (m *Manager) GetPartyState(code string) *PartyState {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return nil
	}
	return ps
}

// IsParticipantOrHost returns true if userID is either the party host
// or currently in the participants list. False if the party doesn't
// exist. Thread-safe; takes ps.mu internally so callers don't have to
// reason about the manager's locking discipline.
//
// 2026-05-19 audit (API-H2, API-H3) — party-scoped endpoints (reaction
// timeline, highlight reel MP4) leaked data to any authenticated user
// who guessed a 6-char party code, because they did no membership
// check. This helper centralizes the gate so the policy can't be
// forgotten as new party endpoints are added.
func (m *Manager) IsParticipantOrHost(code string, userID int64) bool {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return false
	}
	// ps.mu is a sync.Mutex (not RWMutex) per the type declaration
	// above — write Lock/Unlock to match.
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.HostUserID == userID {
		return true
	}
	for _, p := range ps.Participants {
		if p.UserID == userID {
			return true
		}
	}
	return false
}

// BuildPartyStateMessage builds the full state message sent to joiners.
// ps.mu must be held by the caller.
func (m *Manager) BuildPartyStateMessage(ps *PartyState) map[string]interface{} {
	participants := make([]map[string]interface{}, 0, len(ps.Participants))
	for _, p := range ps.Participants {
		participants = append(participants, map[string]interface{}{
			"user_id":      p.UserID,
			"username":     p.Username,
			"is_host":      p.IsHost,
			"is_buffering": p.IsBuffering,
			// M5 — include Ready in the joiner snapshot so reconnecting
			// clients see the right green dots and their own "Cancel
			// Ready" button stays correctly labelled. Without this,
			// reconnect erased the visual state until someone else
			// toggled their Ready (which then broadcast ready-changed
			// and re-established the picture).
			"ready": p.Ready,
			// Mobile-companion presence flag. Additive: absent/false on
			// every desktop/legacy client, so existing UIs that ignore
			// it are unaffected. The companion frontend reads this to
			// render the "📱 on phone" badge next to a participant.
			"companion": p.Companion,
		})
	}

	chatHistory := make([]map[string]interface{}, 0, len(ps.ChatHistory))
	for _, msg := range ps.ChatHistory {
		chatHistory = append(chatHistory, map[string]interface{}{
			"id":        msg.ID,
			"user_id":   msg.UserID,
			"username":  msg.Username,
			"message":   msg.Message,
			"timestamp": msg.Timestamp.Format(time.RFC3339),
		})
	}

	// `current_time_ms` / `is_playing` come from the V3 anchor — the only
	// source of playback truth since the 2026-06 V2 deletion. The dead V2
	// fields (group_state, play_at_server_ms, the `sync` tunables block)
	// were dropped from the payload; the SPA never read them (verified
	// against lib/party.ts PartyStateInnerParty before removal).
	return map[string]interface{}{
		"type": "party-state",
		"payload": map[string]interface{}{
			"party": map[string]interface{}{
				"code":               ps.Code,
				"host_user_id":       ps.HostUserID,
				"media_item_id":      ps.MediaItemID,
				"episode_id":         ps.EpisodeID,
				"media_title":        ps.MediaTitle,
				"media_poster":       ps.MediaPoster,
				"party_name":         ps.PartyName,
				"current_time_ms":    ps.CurrentAbsMs(),
				"is_playing":         ps.Running,
				"revision":           ps.StateRevision,
				"server_now_ms":      time.Now().UnixMilli(),
				"max_participants":   ps.MaxParticipants,
				"scheduled_start_at": ps.ScheduledStartAt,
				"started_at":         ps.StartedAt,
				"settings": map[string]interface{}{
					"allow_pause": ps.Settings.AllowPause,
					"allow_chat":  ps.Settings.AllowChat,
				},
				"created_at": ps.CreatedAt.Format(time.RFC3339),
			},
			"participants": participants,
			"chat_history": chatHistory,
		},
	}
}

// PartyCount returns the number of active parties. Thread-safe.
func (m *Manager) PartyCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.parties)
}

// ActiveParties returns a snapshot of all active party states for listing.
// Thread-safe. Uses snapshot+iterate pattern to avoid holding m.mu while
// acquiring ps.mu (prevents deadlock with endPartyInternal).
func (m *Manager) ActiveParties() []map[string]interface{} {
	// Snapshot party pointers under read lock
	m.mu.RLock()
	snapshot := make([]*PartyState, 0, len(m.parties))
	for _, ps := range m.parties {
		snapshot = append(snapshot, ps)
	}
	m.mu.RUnlock()

	// Build result without holding m.mu
	result := make([]map[string]interface{}, 0, len(snapshot))
	for _, ps := range snapshot {
		ps.mu.Lock()
		result = append(result, map[string]interface{}{
			"code":               ps.Code,
			"host_user_id":       ps.HostUserID,
			"party_name":         ps.PartyName,
			"media_item_id":      ps.MediaItemID,
			"media_title":        ps.MediaTitle,
			"media_poster":       ps.MediaPoster,
			"participant_count":  len(ps.Participants),
			"max_participants":   ps.MaxParticipants,
			"is_playing":         ps.Running,
			"current_time_ms":    ps.CurrentAbsMs(),
			"created_at":         ps.CreatedAt.Format(time.RFC3339),
			"scheduled_start_at": ps.ScheduledStartAt,
			"started_at":         ps.StartedAt,
		})
		ps.mu.Unlock()
	}

	return result
}

// ============================================================
// Shutdown
// ============================================================

// Shutdown closes live parties, preserving scheduled, unstarted promises in
// the database for boot-time rehydration. Active parties retain the existing
// end policy.
func (m *Manager) Shutdown() {
	m.mu.RLock()
	codes := make([]string, 0, len(m.parties))
	for code := range m.parties {
		codes = append(codes, code)
	}
	m.mu.RUnlock()

	for _, code := range codes {
		m.mu.RLock()
		ps, exists := m.parties[code]
		m.mu.RUnlock()
		if exists {
			if !m.suspendScheduledParty(code, ps) {
				_ = m.endPartyInternal(code, ps, 0)
			}
		}
	}

	slog.Info("all watch parties shut down", "count", len(codes))
}

// suspendScheduledParty atomically claims an unstarted scheduled party for
// shutdown. Marking it ending under its lock prevents timers, late joins and
// disconnect reapers from starting or ending it while we close the sockets.
// Unlike ending a party, this performs no DB mutations or party-ended event.
func (m *Manager) suspendScheduledParty(code string, ps *PartyState) bool {
	ps.mu.Lock()
	if ps.ScheduledStartAt == nil || ps.StartedAt != nil || ps.HasEverPlayed {
		ps.mu.Unlock()
		return false
	}
	if ps.ending {
		ps.mu.Unlock()
		return true
	}
	ps.ending = true
	m.cancelScheduleTimerLocked(ps)
	m.stopTickLoopLocked(ps)
	closing := make([]*SafeConn, 0, len(ps.syncConns)+len(ps.roomConns))
	for _, pool := range []map[int64]*SafeConn{ps.syncConns, ps.roomConns} {
		for uid, conn := range pool {
			if conn != nil {
				closing = append(closing, conn)
			}
			delete(pool, uid)
		}
	}
	ps.mu.Unlock()

	m.mu.Lock()
	if m.parties[code] == ps {
		delete(m.parties, code)
	}
	m.mu.Unlock()
	for _, conn := range closing {
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "server restarting"),
			time.Now().Add(time.Second))
		_ = conn.Close()
	}
	m.invalidateShareCache(code)
	return true
}
