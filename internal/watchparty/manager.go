package watchparty

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"html"
	"log/slog"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
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

// SafeConn wraps a gorilla/websocket.Conn with a write mutex.
// gorilla/websocket does not support concurrent writers, so all writes
// (including pings, broadcasts, and direct messages) must be serialized.
type SafeConn struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
}

// NewSafeConn creates a SafeConn wrapping the given connection.
func NewSafeConn(conn *websocket.Conn) *SafeConn {
	return &SafeConn{conn: conn}
}

// WriteMessage acquires the write mutex before writing.
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
func (sc *SafeConn) SetWriteDeadline(t time.Time) error {
	return sc.conn.SetWriteDeadline(t)
}

// Close closes the underlying connection.
func (sc *SafeConn) Close() error {
	return sc.conn.Close()
}

// Participant tracks a single connected user in a watch party.
//
// BufferingSince is set the first time the participant reports is_buffering=true
// in a heartbeat and cleared when they report !is_buffering. The manager uses
// (now - BufferingSince) >= BufferHysteresis to decide whether to transition
// the group into Waiting, avoiding a full group pause on transient stalls.
//
// ReadyAtMs is the last position (ms) at which this participant reported ready
// while the group was Waiting. Used by the resume gate.
//
// FailedSeekAttempts is incremented every time the client reports a drift
// above DriftHardSeekMs that it could not correct; at DriftMaxAttempts the
// client is dropped from the group rather than continuing to thrash.
//
// Suspensions is a SharePlay-style set of reasons this peer is currently out
// of group playback (e.g. "buffer", "focus_loss", "seeking"). A non-empty set
// means the peer is not in group time; the group stays in Waiting until it
// empties across all peers.
type Participant struct {
	UserID             int64           `json:"user_id"`
	Username           string          `json:"username"`
	IsHost             bool            `json:"is_host"`
	IsBuffering        bool            `json:"is_buffering"`
	BufferingSince     *time.Time      `json:"-"`
	ReadyAtMs          int64           `json:"-"`
	FailedSeekAttempts int             `json:"-"`
	Suspensions        map[string]bool `json:"-"`
	LastSeen           time.Time       `json:"last_seen"`
	LastRTTms          int64           `json:"-"`
	ClockOffsetMs      int64           `json:"-"`
	// Ready is the per-participant "I'm ready to start watching" signal
	// for M5's spoiler-free start gate. Distinct from `ReadyAtMs` which
	// is V2's buffered-to-target signal (always set on Ready protocol
	// emit). This Ready is human-driven — the participant clicked
	// "I'm Ready" in the lobby UI. Reset to false when the party
	// transitions to a new session (e.g. media-change).
	Ready bool `json:"ready"`
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

// GroupState models the Jellyfin-style state machine for a watch party.
// Idle: no media loaded yet.
// Waiting: group is paused waiting for all participants to emit Ready at
//
//	CurrentTimeMs (triggered by initial play, seek, or buffer hysteresis).
//
// Playing: group is playing, anchored at CurrentTimeMs @ PlayingSince.
type GroupState string

const (
	GroupStateIdle    GroupState = "idle"
	GroupStateWaiting GroupState = "waiting"
	GroupStatePlaying GroupState = "playing"
)

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

// PartyState is the authoritative in-memory state for an active watch party.
// The mu field is a per-party mutex that protects mutable fields (CurrentTimeMs,
// IsPlaying, PlayingSince, Participants, ChatHistory, conns).
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
	CurrentTimeMs int64
	IsPlaying     bool
	PlayingSince  *time.Time
	GroupState    GroupState
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
	conns           map[int64]*SafeConn
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
	// unexpectedly (NOT on explicit leave-party — that's still
	// immediate). If non-nil and the host's WS hasn't reconnected
	// within HostGracePeriod, a background goroutine ends the party.
	// If the host's room WS reconnects in that window, the field is
	// cleared and the goroutine no-ops on next check.
	//
	// Defended by ps.mu like every other field on PartyState.
	HostDisconnectedAt *time.Time

	// ============================================================
	// V3 "Running/Paused" model (Phase 1 — coexists with V2).
	// ============================================================
	// V3 collapses V2's tri-state (Idle/Waiting/Playing) into a simple
	// Running bool. Canonical position is derived from an anchor:
	//
	//   CurrentAbsMs() = AnchorAbsMs + (now - AnchorServerMs)   (if Running)
	//                  = AnchorAbsMs                            (if Paused)
	//
	// The anchor is updated on request-play, request-pause, request-seek,
	// and party-create (seeded from the host's resume offset). In Phase 1
	// these fields are maintained in parallel with V2; the frontend still
	// consumes V2 snapshots. Step 5 of the execution plan removes V2.
	Running        bool
	AnchorAbsMs    int64
	AnchorServerMs int64

	// Separate WebSocket pools for V3's two-socket model. Sync traffic
	// (tick/pause/seek/heartbeat/time-sync) rides syncConns. Room traffic
	// (chat/reaction/presence) rides roomConns. syncConns is additionally
	// populated in Phase 1 but not yet broadcast to — see tick goroutine.
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
}

// Lock acquires the party-level mutex. Exported for cross-package use by handlers
// that need to read mutable fields (Participants, CurrentTimeMs, etc.).
func (ps *PartyState) Lock() {
	ps.mu.Lock()
}

// Unlock releases the party-level mutex.
func (ps *PartyState) Unlock() {
	ps.mu.Unlock()
}

// SyncConfig holds the tuning parameters for the sync protocol. Mirrors
// config.WatchPartyConfig but lives in the watchparty package so this package
// has no import cycle with config. Populated by NewManager.
type SyncConfig struct {
	HeartbeatInterval time.Duration
	TimeSyncInterval  time.Duration
	BufferHysteresis  time.Duration
	PlayScheduleDelay time.Duration
	DriftIgnoreMs     int64
	DriftRateAdjustMs int64
	DriftHardSeekMs   int64
	DriftMaxAttempts  int

	// ============================================================
	// V3 additions (Phase 1). Zero values are backfilled in
	// NewManagerWithConfig from DefaultSyncConfig.
	// ============================================================
	// TickInterval is how often the server broadcasts a `tick` while
	// Running. 250ms is Twitch-low-latency territory and keeps late
	// joiners converged within one interval.
	TickInterval time.Duration
	// V3 catch-up thresholds. See docs/watchparty-v3.md §5.
	// |lag| <= V3DriftIgnoreMs           → do nothing
	// lag in (V3DriftIgnoreMs, V3DriftHardSeekMs) → rate-adjust
	// |lag| >= V3DriftHardSeekMs         → hard seek
	V3DriftIgnoreMs   int64   // default 200
	V3DriftHardSeekMs int64   // default 3000
	V3CatchUpRate     float64 // default 1.03 (behind → speed up)
	V3EaseBackRate    float64 // default 0.97 (ahead → slow down)
}

// DefaultSyncConfig returns the mpv-shim / Jellyfin-derived defaults. Used when
// NewManager is called without a config, e.g. by tests.
func DefaultSyncConfig() SyncConfig {
	return SyncConfig{
		HeartbeatInterval: 500 * time.Millisecond,
		TimeSyncInterval:  30 * time.Second,
		BufferHysteresis:  750 * time.Millisecond,
		PlayScheduleDelay: 300 * time.Millisecond,
		DriftIgnoreMs:     50,
		DriftRateAdjustMs: 300,
		DriftHardSeekMs:   2000,
		DriftMaxAttempts:  5,

		// V3 defaults. Chosen in consultation with user (see
		// docs/watchparty-v3.md §5): rate-adjust window is 200ms–3s,
		// beyond 3s is a hard seek. Catch-up at 1.03× keeps pitch
		// shift inaudible while still closing a 1s lag in ~33s.
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

// SyncConfig returns the active sync tuning. Exposed so the WS handler can
// tell new clients what heartbeat cadence to use.
func (m *Manager) SyncConfig() SyncConfig { return m.cfg }

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
		// rename if a render is in-flight. Expected pattern: <6-char
		// code>.mp4.
		if !strings.HasSuffix(name, ".mp4") {
			continue
		}
		base := strings.TrimSuffix(name, ".mp4")
		if len(base) != codeLength {
			continue
		}
		valid := true
		for _, c := range base {
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
func (m *Manager) HighlightReelPath(code string) (string, bool) {
	m.mu.RLock()
	dir := m.highlightCacheDir
	m.mu.RUnlock()
	if dir == "" || code == "" {
		return "", false
	}
	// Defensive: party codes are uppercase alphanumeric (codeLength=6).
	// Reject anything else to prevent path-traversal via the URL.
	for _, c := range code {
		if !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			return "", false
		}
	}
	if len(code) != codeLength {
		return "", false
	}
	path := filepath.Join(dir, code+".mp4")
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

	// Drift correction lives on the client now (see SyncConfig.DriftIgnoreMs /
	// DriftRateAdjustMs / DriftHardSeekMs). The server only coordinates state
	// transitions (play/pause/seek/Ready) and per-peer buffer hysteresis.

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
	if cfg.HeartbeatInterval <= 0 {
		cfg.HeartbeatInterval = def.HeartbeatInterval
	}
	if cfg.TimeSyncInterval <= 0 {
		cfg.TimeSyncInterval = def.TimeSyncInterval
	}
	// BufferHysteresis == 0 means "pause on any stall" — pathological. Zero is
	// backfilled along with negatives. PlayScheduleDelay == 0 is legitimate
	// ("schedule play immediately") so only negatives are corrected there.
	if cfg.BufferHysteresis <= 0 {
		cfg.BufferHysteresis = def.BufferHysteresis
	}
	if cfg.PlayScheduleDelay < 0 {
		cfg.PlayScheduleDelay = def.PlayScheduleDelay
	}
	if cfg.DriftIgnoreMs <= 0 {
		cfg.DriftIgnoreMs = def.DriftIgnoreMs
	}
	if cfg.DriftRateAdjustMs <= 0 {
		cfg.DriftRateAdjustMs = def.DriftRateAdjustMs
	}
	if cfg.DriftHardSeekMs <= 0 {
		cfg.DriftHardSeekMs = def.DriftHardSeekMs
	}
	if cfg.DriftMaxAttempts <= 0 {
		cfg.DriftMaxAttempts = def.DriftMaxAttempts
	}
	// V3 backfills.
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

	// Pre-check (non-authoritative) to avoid unnecessary work
	m.mu.RLock()
	for _, ps := range m.parties {
		if ps.HostUserID == hostUserID {
			m.mu.RUnlock()
			return nil, fmt.Errorf("you already have an active party")
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
		CurrentTimeMs:   initialPositionMs,
		IsPlaying:       false,
		PlayingSince:    nil,
		GroupState:      GroupStateIdle,
		StateRevision:   1,
		Participants:    make(map[int64]*Participant),
		ChatHistory:     make([]ChatMessage, 0, chatHistoryMax),
		Settings:        settings,
		conns:           make(map[int64]*SafeConn),
		CreatedAt:       now,
		MaxParticipants: maxParticipants,
		dbID:            dbParty.ID,
		// M3 — link to the long-lived room so EndParty can soft-delete or
		// preserve it based on persistence policy.
		roomDBID:         dbRoom.ID,
		IsRoomPersistent: dbRoom.IsPersistent,

		// V3 fields (Phase 1). Seed the canonical anchor from the host's
		// resume offset — same value V2 stores in CurrentTimeMs. Running
		// starts false; the tick loop won't spin up until request-play.
		Running:        false,
		AnchorAbsMs:    initialPositionMs,
		AnchorServerMs: now.UnixMilli(),
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
	m.mu.Lock()
	for _, existing := range m.parties {
		if existing.HostUserID == hostUserID {
			m.mu.Unlock()
			// Best-effort cleanup: mark DB row inactive since we can't use it
			if dbParty.ID > 0 {
				_ = m.queries.EndWatchParty(ctx, dbParty.ID)
			}
			return nil, fmt.Errorf("you already have an active party")
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
		CurrentTimeMs:    initialPositionMs,
		IsPlaying:        false,
		PlayingSince:     nil,
		GroupState:       GroupStateIdle,
		StateRevision:    1,
		Participants:     make(map[int64]*Participant),
		ChatHistory:      make([]ChatMessage, 0, chatHistoryMax),
		Settings:         settings,
		conns:            make(map[int64]*SafeConn),
		CreatedAt:        now,
		MaxParticipants:  maxParticipants,
		dbID:             dbParty.ID,
		roomDBID:         room.ID,
		IsRoomPersistent: true,

		Running:        false,
		AnchorAbsMs:    initialPositionMs,
		AnchorServerMs: now.UnixMilli(),
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
		if err := m.endPartyInternal(room.Code, ps); err != nil {
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
		return fmt.Errorf("party not found")
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
	if ps.scheduleCancel != nil {
		ps.scheduleCancel()
		ps.scheduleCancel = nil
	}

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
}

// cancelScheduleTimerLocked cancels any in-flight schedule timer. Caller
// must hold ps.mu. Idempotent: safe to call when no timer is in flight.
func (m *Manager) cancelScheduleTimerLocked(ps *PartyState) {
	if ps.scheduleCancel != nil {
		ps.scheduleCancel()
		ps.scheduleCancel = nil
	}
}

// fireScheduledStart is the goroutine body. Re-resolves the party by code
// (it may have ended since the timer was scheduled), checks that the party
// is still in pre-start state, then broadcasts "party-starting" and routes
// through HandlePlaybackControl(play) to engage the existing sync path.
//
// Marks the in-memory and persisted StartedAt so reconnecting clients can
// compute elapsed time from a stable timestamp.
func (m *Manager) fireScheduledStart(code string) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		// Party ended between schedule and fire — nothing to do.
		return
	}

	now := time.Now()

	ps.mu.Lock()
	// Dedup guard: if StartedAt is already set, the party already started
	// (either via manual play or a previous timer fire); don't double-fire.
	if ps.StartedAt != nil {
		ps.mu.Unlock()
		return
	}
	ps.StartedAt = &now
	// Clear the cancel hook — timer has fired, cancellation is moot.
	ps.scheduleCancel = nil
	dbID := ps.dbID

	// Broadcast "party-starting" so all clients show the "Starting now!"
	// notification before playback engages. Includes server_now_ms so
	// late-joiners' countdown widgets converge correctly.
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type": "party-starting",
		"payload": map[string]interface{}{
			"started_at_ms": now.UnixMilli(),
			"server_now_ms": now.UnixMilli(),
		},
	})
	ps.mu.Unlock()

	// Engage playback via the existing play path. This routes through
	// transitionToWaitingLocked → Ready protocol so all clients converge
	// at the start position before actually playing — same UX as the
	// host pressing play manually.
	if err := m.HandlePlaybackControl(code, ps.HostUserID, "play", 0); err != nil {
		slog.Warn("scheduled-start play failed", "code", code, "error", err)
	}

	// Persist started_at outside any lock. Best-effort; in-memory state
	// is authoritative for live behavior.
	if dbID > 0 {
		if err := m.queries.MarkPartyStarted(context.Background(), dbID, now); err != nil {
			slog.Warn("mark party started in DB failed", "code", code, "error", err)
		}
	}

	slog.Info("scheduled watch party started", "code", code)
}

// JoinParty adds a user to an existing party. The WebSocket connection is
// stored for direct messaging. Returns the party state for the initial sync.
func (m *Manager) JoinParty(code string, userID int64, username string, sc *SafeConn) (*PartyState, error) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("party not found or has ended")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Check if already in the party (reconnect case)
	if existing, ok := ps.Participants[userID]; ok {
		// Update connection and last seen
		ps.conns[userID] = sc
		existing.LastSeen = time.Now()
		existing.IsBuffering = false
		slog.Info("participant reconnected to party", "code", code, "user_id", userID, "username", username)
	} else {
		// Check max participants (host doesn't count against limit when re-joining)
		currentCount := len(ps.Participants)
		if currentCount >= ps.MaxParticipants {
			return nil, fmt.Errorf("party is full (%d/%d)", currentCount, ps.MaxParticipants)
		}

		// Add new participant
		ps.Participants[userID] = &Participant{
			UserID:      userID,
			Username:    username,
			IsHost:      userID == ps.HostUserID,
			IsBuffering: false,
			Suspensions: make(map[string]bool),
			LastSeen:    time.Now(),
		}
		ps.conns[userID] = sc

		slog.Info("participant joined party", "code", code, "user_id", userID, "username", username)
	}

	// Insert participant in DB (ON CONFLICT re-activates if they re-join)
	if ps.dbID > 0 {
		if err := m.queries.InsertParticipant(context.Background(), ps.dbID, userID); err != nil {
			slog.Warn("failed to insert participant in DB", "error", err)
		}
	}

	// Broadcast participant-join to other party members (exclude the joiner)
	m.broadcastToPartyExcludeLocked(ps, map[string]interface{}{
		"type": "participant-join",
		"payload": map[string]interface{}{
			"user_id":  userID,
			"username": username,
		},
	}, userID)

	// Send full party state to the joining user
	if sc != nil {
		stateMsg := m.BuildPartyStateMessage(ps)
		if data, err := json.Marshal(stateMsg); err == nil {
			if err := sc.WriteMessage(websocket.TextMessage, data); err != nil {
				slog.Debug("failed to send party state to joiner", "error", err)
			}
		}
	}

	return ps, nil
}

// LeaveParty removes a user from a party. If the host leaves, the party ends.
func (m *Manager) LeaveParty(code string, userID int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return nil // party already gone
	}

	ps.mu.Lock()

	participant, ok := ps.Participants[userID]
	if !ok {
		ps.mu.Unlock()
		return nil // not in the party
	}

	username := participant.Username
	isHost := ps.HostUserID == userID

	// Remove from in-memory state
	delete(ps.Participants, userID)
	delete(ps.conns, userID)

	// Update DB
	if ps.dbID > 0 {
		if err := m.queries.UpdateParticipantLeft(context.Background(), ps.dbID, userID); err != nil {
			slog.Warn("failed to update participant left in DB", "error", err)
		}
	}

	if isHost {
		// Host leaving ends the party
		ps.mu.Unlock()
		slog.Info("host left, ending party", "code", code, "user_id", userID)
		return m.endPartyInternal(code, ps)
	}

	// Broadcast participant-left to remaining members
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type": "participant-left",
		"payload": map[string]interface{}{
			"user_id":  userID,
			"username": username,
		},
	})

	ps.mu.Unlock()

	slog.Info("participant left party", "code", code, "user_id", userID, "username", username)
	return nil
}

// EndParty ends a party. Only the host can end it via the REST endpoint.
func (m *Manager) EndParty(code string, userID int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return fmt.Errorf("party not found")
	}

	ps.mu.Lock()
	if ps.HostUserID != userID {
		ps.mu.Unlock()
		return fmt.Errorf("only the host can end the party")
	}
	ps.mu.Unlock()

	return m.endPartyInternal(code, ps)
}

// endPartyInternal broadcasts party-ended, cleans up DB and memory.
// ps.mu must NOT be held when calling this.
func (m *Manager) endPartyInternal(code string, ps *PartyState) error {
	ps.mu.Lock()

	// M9 — snapshot the data we need for the highlight reel BEFORE the
	// lock is held for teardown. We launch generation after the lock
	// release so ffmpeg doesn't block other party operations. Best-
	// effort: empty reactions → no reel (handled by generator).
	reactionsForReel := make([]ReactionRecord, len(ps.Reactions))
	copy(reactionsForReel, ps.Reactions)
	mediaItemIDForReel := ps.MediaItemID

	// Cancel any in-flight schedule timer. A scheduled party that gets
	// ended (host clicks "Cancel", or stale-cleanup fires) shouldn't
	// fire "party-starting" after the connections are closed.
	m.cancelScheduleTimerLocked(ps)

	// V3: stop the tick goroutine if it's running. MUST happen before we
	// close the sync conns, otherwise the goroutine could emit one more
	// tick into already-closed sockets. Idempotent — safe on a party that
	// never started a tick loop (V2-only party, or never-played party).
	m.stopTickLoopLocked(ps)

	// Broadcast party-ended to all connected participants (V2 pool).
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type":    "party-ended",
		"payload": map[string]interface{}{},
	})
	// V3 pools: broadcast the same signal on both sockets so clients
	// speaking either protocol see the close. Piggybacks off the same
	// message envelope; V3 clients will treat "party-ended" the same.
	for _, c := range ps.syncConns {
		if c == nil {
			continue
		}
		_ = c.WriteMessage(websocket.TextMessage, []byte(`{"type":"party-ended","payload":{}}`))
	}
	for _, c := range ps.roomConns {
		if c == nil {
			continue
		}
		_ = c.WriteMessage(websocket.TextMessage, []byte(`{"type":"party-ended","payload":{}}`))
	}

	// Close all WebSocket connections (V2 + V3 pools).
	for uid, conn := range ps.conns {
		if conn != nil {
			conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "party ended"),
				time.Now().Add(5*time.Second),
			)
			_ = conn.Close()
		}
		delete(ps.conns, uid)
	}
	for uid, conn := range ps.syncConns {
		if conn != nil {
			conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "party ended"),
				time.Now().Add(5*time.Second),
			)
			_ = conn.Close()
		}
		delete(ps.syncConns, uid)
	}
	for uid, conn := range ps.roomConns {
		if conn != nil {
			conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "party ended"),
				time.Now().Add(5*time.Second),
			)
			_ = conn.Close()
		}
		delete(ps.roomConns, uid)
	}

	dbID := ps.dbID
	roomDBID := ps.roomDBID
	isRoomPersistent := ps.IsRoomPersistent
	ps.mu.Unlock()

	// M9 — kick off highlight-reel generation. Goroutine + ffmpeg detach
	// from this function; the reel file appears at HighlightReelPath
	// minutes later (best-effort). Empty reactions → no reel, returns
	// immediately.
	m.generateHighlightReelAsync(code, reactionsForReel, mediaItemIDForReel)

	// Mark inactive in DB
	if dbID > 0 {
		if err := m.queries.EndWatchParty(context.Background(), dbID); err != nil {
			slog.Warn("failed to end party in DB", "error", err)
		}
	}

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

	slog.Info("watch party ended", "code", code, "room_persistent", isRoomPersistent)
	return nil
}

// ============================================================
// Playback Control
// ============================================================

// HandlePlaybackControl processes play/pause/seek intents from participants.
// Only the host can issue play/seek; pause is allowed for everyone if
// AllowPause is set. Unlike the old implementation, this never trusts a
// client's self-reported timestamp as authoritative — it only trusts the
// *intent*, and computes the server-anchored time itself.
//
// play / seek always route through Waiting → Ready → Playing so every client
// buffers to the same position before the group starts. Pause is immediate.
func (m *Manager) HandlePlaybackControl(code string, userID int64, action string, timeMs int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return fmt.Errorf("party not found")
	}

	// 2026-05-19 audit (BE-H8) — clamp timeMs >= 0 at the top of the
	// handler. The V2 path used to broadcast negative current_time_ms
	// to all clients if a buggy host (or future bug in the wire layer)
	// passed timeMs < 0. The V3 sync handler validates this; V2 didn't.
	// A clamp here is safe because all legitimate playback positions
	// are >= 0 (frame 0 is the start of the media).
	if timeMs < 0 {
		timeMs = 0
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	isHost := ps.HostUserID == userID

	switch action {
	case "play", "seek":
		if !isHost {
			return fmt.Errorf("only the host can %s", action)
		}
	case "pause":
		if !isHost && !ps.Settings.AllowPause {
			return fmt.Errorf("only the host can pause")
		}
	default:
		return fmt.Errorf("unknown playback action: %s", action)
	}

	switch action {
	case "play":
		// First manual play: stamp StartedAt and cancel any in-flight
		// schedule timer. Without this, a host who schedules a party and
		// then impatiently hits play early would still see the timer fire
		// at the original scheduled moment, double-engaging play and
		// kicking everyone back to the Ready handshake. The dedup in
		// fireScheduledStart checks StartedAt — by stamping it here we
		// turn the manual-play path into "the party started, scheduled
		// timer is moot". cancelScheduleTimerLocked is idempotent so
		// non-scheduled parties pay only a nil check.
		if ps.StartedAt == nil {
			now := time.Now()
			ps.StartedAt = &now
			m.cancelScheduleTimerLocked(ps)
			dbID := ps.dbID
			// Persist async to avoid blocking the playback path on DB latency.
			// Best-effort; in-memory state is authoritative for live behavior.
			if dbID > 0 {
				go func(id int64, t time.Time) {
					if err := m.queries.MarkPartyStarted(context.Background(), id, t); err != nil {
						slog.Warn("mark party started (manual play) failed", "id", id, "error", err)
					}
				}(dbID, now)
			}
		}
		// Resume from current position, or at timeMs if the host specified one.
		targetMs := ps.CurrentTimeMs
		if timeMs > 0 {
			targetMs = timeMs
		}
		// Host's client is already at targetMs; guests need to buffer there.
		// Transition to Waiting and require Ready from everyone before resuming.
		m.transitionToWaitingLocked(ps, targetMs, "host:play")

	case "pause":
		// Freeze the group at the last known server-computed position. Don't
		// trust the requester's timeMs for position — compute from PlayingSince.
		pos := m.calculateCurrentPosition(ps)
		if timeMs > 0 {
			pos = timeMs
		}
		ps.IsPlaying = false
		ps.PlayingSince = nil
		ps.CurrentTimeMs = pos
		ps.GroupState = GroupStateWaiting
		for _, p := range ps.Participants {
			p.ReadyAtMs = -1
		}
		m.bumpRevLocked(ps)
		m.broadcastStateSnapshotLocked(ps)

	case "seek":
		// Seek always re-enters Waiting; resume requires all Ready.
		m.transitionToWaitingLocked(ps, timeMs, "host:seek")
	}

	return nil
}

// ============================================================
// Sync Heartbeat
// ============================================================

// HandleSyncHeartbeat processes position reports from participants.
//
// Key semantic change from the previous protocol: the server NEVER updates
// CurrentTimeMs from a heartbeat (not even the host's). Position is authored
// exclusively by HandlePlaybackControl and advanced by PlayingSince. Heartbeats
// are used for:
//  1. LastSeen refresh (keeps stale-cleanup from dropping live peers).
//  2. Buffer hysteresis: if a peer reports is_buffering for longer than
//     cfg.BufferHysteresis, the group transitions to Waiting. A transient
//     stall (one heartbeat's worth) does NOT pause the group.
//  3. Buffer clear: when the last buffering peer reports not-buffering, the
//     group stays in Waiting until each peer emits a Ready at CurrentTimeMs.
//
// Drift correction is entirely client-side (tiered: ignore / rate-adjust /
// hard-seek) using the client's own computed server-time offset; the server's
// only role in drift is counting failed attempts via HandleDriftReport.
func (m *Manager) HandleSyncHeartbeat(code string, userID int64, currentTimeMs int64, isBuffering bool) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return fmt.Errorf("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	p, ok := ps.Participants[userID]
	if !ok {
		return nil // not in the party (stale heartbeat)
	}

	now := time.Now()
	p.LastSeen = now

	// Peers that are suspended for non-buffer reasons (e.g. "desync" — kicked
	// by HandleDriftReport) MUST NOT re-influence group state via heartbeat.
	// Without this guard, a desync-kicked peer that re-buffers would trigger
	// another transitionToWaitingLocked and effectively un-kick itself.
	for reason := range p.Suspensions {
		if reason != "buffer" {
			return nil
		}
	}

	wasBuffering := p.IsBuffering
	p.IsBuffering = isBuffering

	// Track BufferingSince for hysteresis — only set on the 0→1 transition so a
	// peer that stays buffering across ticks accumulates duration correctly.
	if isBuffering && !wasBuffering {
		t := now
		p.BufferingSince = &t
	}
	if !isBuffering && wasBuffering {
		p.BufferingSince = nil
		delete(p.Suspensions, "buffer")
	}

	// Hysteresis check: if this peer has been buffering for long enough and
	// the group is still Playing, transition to Waiting. Avoids thrashing on
	// transient stalls.
	if isBuffering && p.BufferingSince != nil &&
		ps.GroupState == GroupStatePlaying &&
		now.Sub(*p.BufferingSince) >= m.cfg.BufferHysteresis {
		if p.Suspensions == nil {
			p.Suspensions = make(map[string]bool)
		}
		p.Suspensions["buffer"] = true
		pos := m.calculateCurrentPosition(ps)
		m.transitionToWaitingLocked(ps, pos, "buffer:"+p.Username)
		return nil
	}

	return nil
}

// calculateCurrentPosition returns the authoritative playback position in ms,
// accounting for time elapsed since PlayingSince if currently playing.
// ps.mu must be held.
func (m *Manager) calculateCurrentPosition(ps *PartyState) int64 {
	if !ps.IsPlaying || ps.PlayingSince == nil {
		return ps.CurrentTimeMs
	}
	elapsed := time.Since(*ps.PlayingSince)
	return ps.CurrentTimeMs + elapsed.Milliseconds()
}

// ============================================================
// Chat
// ============================================================

// HandleChat processes a chat message from a participant.
func (m *Manager) HandleChat(code string, userID int64, username string, message string) error {
	if len(message) == 0 {
		return fmt.Errorf("empty message")
	}
	if len(message) > chatMaxLength {
		return fmt.Errorf("message too long (max %d characters)", chatMaxLength)
	}

	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return fmt.Errorf("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Check chat is enabled
	if !ps.Settings.AllowChat {
		return fmt.Errorf("chat is disabled for this party")
	}

	// Verify user is a participant
	if _, ok := ps.Participants[userID]; !ok {
		return fmt.Errorf("not a participant in this party")
	}

	// Sanitize message
	sanitized := html.EscapeString(message)

	// Generate message ID
	msgID := fmt.Sprintf("%d-%d", time.Now().UnixNano(), userID)

	chatMsg := ChatMessage{
		ID:        msgID,
		UserID:    userID,
		Username:  username,
		Message:   sanitized,
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
		return fmt.Errorf("emoji not in allowed reactions whitelist")
	}

	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()

	if !exists {
		return fmt.Errorf("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Verify user is a participant
	if _, ok := ps.Participants[userID]; !ok {
		return fmt.Errorf("not a participant in this party")
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
func (m *Manager) generateHighlightReelAsync(code string, reactions []ReactionRecord, mediaItemID int64) {
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
	if parentCtx == nil {
		parentCtx = context.Background()
	}

	go func() {
		// M1 fix — parent off the server-lifecycle context so SIGTERM
		// unwinds the ffmpeg job rather than orphaning it. 5min timeout
		// remains as the upper bound for a runaway render.
		ctx, cancel := context.WithTimeout(parentCtx, 5*time.Minute)
		defer cancel()

		srcPath := queries.GetAnyFilePath(ctx, mediaItemID)
		if srcPath == "" {
			slog.Warn("highlight reel: no source file for media", "code", code, "media_id", mediaItemID)
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
		outPath := filepath.Join(dir, code+".mp4")
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
	}()
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
		outPath,
	)

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
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
		return nil, fmt.Errorf("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	if _, ok := ps.Participants[userID]; !ok {
		return nil, fmt.Errorf("not a participant in this party")
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
		return fmt.Errorf("invalid voice signal type: %s", signalType)
	}
	if fromUserID == toUserID {
		return fmt.Errorf("cannot signal to self")
	}

	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return fmt.Errorf("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	if ps.VoiceParticipants == nil || !ps.VoiceParticipants[fromUserID] {
		return fmt.Errorf("sender not in voice")
	}
	if !ps.VoiceParticipants[toUserID] {
		return fmt.Errorf("recipient not in voice")
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
	targetConn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if err := targetConn.WriteMessage(1 /*TextMessage*/, data); err != nil {
		// Best-effort: don't propagate write errors — the room-socket
		// read pump will detect the dead conn and clean up.
		slog.Debug("voice signal write failed", "code", code, "to", toUserID, "err", err)
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
		c.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_ = c.WriteMessage(1 /*TextMessage*/, data)
	}
}

// ============================================================
// Media Change (TV episode auto-advance + manual swap)
// ============================================================

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
func (m *Manager) ChangeMedia(code string, hostUserID int64, newMediaItemID int64, newEpisodeID *int64, newMediaTitle, newMediaPoster string) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return fmt.Errorf("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Host-only — guests can't reroute the whole party to a different
	// episode. (Future: allow with democratic vote if AllowPause-style
	// settings expand.)
	if ps.HostUserID != hostUserID {
		return fmt.Errorf("only the host can change media")
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

	// Note: the cached share image (party-share/{code}.png) is now stale —
	// it shows the old episode poster + code. We don't have a manager-level
	// invalidator wired today (party_share.go's InvalidateCache lives on the
	// HTTP handler and the manager has no reference to it). The 30-day
	// share-image reaper handles long-term cleanup; for immediate freshness,
	// wiring InvalidateCache into the manager is a small follow-up.

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
		return fmt.Errorf("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	p, ok := ps.Participants[userID]
	if !ok {
		return fmt.Errorf("not a participant in this party")
	}
	p.Ready = ready
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
	// keeps the lock contract intact. Iterates both V2 conns and V3
	// roomConns pools so V3 clients (the only real ones in production
	// today) actually receive the broadcast.
	m.broadcastToPartyLocked(ps, map[string]interface{}{
		"type": "ready-changed",
		"payload": map[string]interface{}{
			"user_id":      userID,
			"ready":        ready,
			"participants": snapshot,
		},
	})

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
		return fmt.Errorf("invalid track kind: %q (want 'audio' or 'subtitle')", kind)
	}

	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return fmt.Errorf("party not found")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	if ps.HostUserID != hostUserID {
		return fmt.Errorf("only the host can change tracks for the party")
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
		allStale := true
		if len(ref.ps.Participants) == 0 {
			if now.Sub(ref.ps.CreatedAt) > staleParticipantTimeout {
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
			m.endPartyInternal(code, ps)
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
// Writes to BOTH the V2 `ps.conns` pool AND the V3 `ps.roomConns` pool.
// In V3-only deployments (current state — the V2 /ws/party route was
// deleted in M1), `ps.conns` is always empty so the V2 loop is a no-op
// and only the room pool delivers. Without this fan-out, every
// broadcast-based feature (chat, reactions, participant-join,
// media-change, track-change, ready-changed) was silently failing in
// production for V3 clients because the broadcasts went to an empty
// map. Deep-debugger May 2026 caught this; fix mirrors the dual-pool
// iteration already used by endPartyInternal.
//
// Sync-only messages (tick, pause, seek) use a separate emit helper
// that writes only to ps.syncConns — those don't ride this broadcaster.
func (m *Manager) broadcastToPartyExcludeLocked(ps *PartyState, msg interface{}, excludeUserID int64) {
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("failed to marshal party broadcast", "error", err)
		return
	}

	// V2 conns pool (empty in V3-only deployments but kept for the case
	// where V2 routes are re-added or tests inject V2 connections).
	var failedV2 []int64
	for uid, conn := range ps.conns {
		if uid == excludeUserID {
			continue
		}
		if conn == nil {
			failedV2 = append(failedV2, uid)
			continue
		}
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			slog.Debug("failed to write to party participant (v2)", "user_id", uid, "error", err)
			failedV2 = append(failedV2, uid)
		}
	}
	for _, uid := range failedV2 {
		delete(ps.conns, uid)
	}

	// V3 room pool — this is where chat/reactions/presence/media-change/
	// track-change/ready-changed actually deliver in production.
	var failedRoom []int64
	for uid, conn := range ps.roomConns {
		if uid == excludeUserID {
			continue
		}
		if conn == nil {
			failedRoom = append(failedRoom, uid)
			continue
		}
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			slog.Debug("failed to write to party participant (v3-room)", "user_id", uid, "error", err)
			failedRoom = append(failedRoom, uid)
		}
	}
	for _, uid := range failedRoom {
		delete(ps.roomConns, uid)
	}
	// Don't remove from Participants — they might reconnect on either pool.
}

// sendToUserLocked sends a JSON message to a specific user in the party.
// ps.mu must be held by the caller.
func (m *Manager) sendToUserLocked(ps *PartyState, userID int64, msg interface{}) {
	conn, ok := ps.conns[userID]
	if !ok || conn == nil {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("failed to marshal party message", "error", err)
		return
	}

	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		slog.Debug("failed to write to party participant", "user_id", userID, "error", err)
		delete(ps.conns, userID)
	}
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

	var playAt int64
	if ps.GroupState == GroupStatePlaying && ps.PlayingSince != nil {
		playAt = ps.PlayingSince.UnixMilli()
	} else {
		playAt = time.Now().UnixMilli()
	}

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
				"current_time_ms":    m.calculateCurrentPosition(ps),
				"is_playing":         ps.IsPlaying,
				"group_state":        string(ps.GroupState),
				"revision":           ps.StateRevision,
				"play_at_server_ms":  playAt,
				"server_now_ms":      time.Now().UnixMilli(),
				"max_participants":   ps.MaxParticipants,
				"scheduled_start_at": ps.ScheduledStartAt,
				"started_at":         ps.StartedAt,
				"sync": map[string]interface{}{
					"heartbeat_interval_ms": m.cfg.HeartbeatInterval.Milliseconds(),
					"time_sync_interval_ms": m.cfg.TimeSyncInterval.Milliseconds(),
					"drift_ignore_ms":       m.cfg.DriftIgnoreMs,
					"drift_rate_adjust_ms":  m.cfg.DriftRateAdjustMs,
					"drift_hard_seek_ms":    m.cfg.DriftHardSeekMs,
					"drift_max_attempts":    m.cfg.DriftMaxAttempts,
				},
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
			"media_title":        ps.MediaTitle,
			"media_poster":       ps.MediaPoster,
			"participant_count":  len(ps.Participants),
			"max_participants":   ps.MaxParticipants,
			"is_playing":         ps.IsPlaying,
			"current_time_ms":    m.calculateCurrentPosition(ps),
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

// Shutdown ends all active parties and waits for cleanup to finish.
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
			_ = m.endPartyInternal(code, ps)
		}
	}

	slog.Info("all watch parties shut down", "count", len(codes))
}
