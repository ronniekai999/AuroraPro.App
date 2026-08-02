package streaming

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// Drain state — telling the deploy script when it is safe to restart.
//
// scripts/aurora-update.sh used to gate its pre-restart wait on
// `pgrep -u aurora ffmpeg`. That is a proxy for the wrong thing.
// reapIdleVariants() deliberately stops the encoder for a PAUSED viewer and
// logs "encoder stopped, resumable" — the session object survives and the
// viewer is still sitting there, but no ffmpeg process exists. The script saw
// an idle box, restarted, and StopAllSessions() destroyed the session out from
// under a viewer who was merely paused. Observed twice in production on
// 2026-08-02 (sessions 129998e2… and d2fa80a8…), each leaving a client
// POSTing keepalive against a dead session for over an hour.
//
// The honest signal is "how many sessions is a client still holding", which
// only the server knows. We publish it as a small JSON file rather than an
// HTTP endpoint on purpose: Aurora sits behind an nginx reverse proxy on the
// same host (scripts/setup-domain.sh), so EVERY internet request arrives with
// RemoteAddr 127.0.0.1. A "localhost only" HTTP gate would therefore be
// reachable from the open internet. A root-readable file in the state dir has
// no network surface at all, and mirrors the existing update-status.json /
// trigger-update file convention in the other direction.

// viewerHeldWindow bounds how recently a session must have been touched to
// count as "a client is still holding this".
//
// LastAccess is refreshed by both KeepAlive and GetSession (segment fetches),
// so any live player — playing OR paused — keeps it warm. The client pings
// every 10s, but browsers throttle setInterval in backgrounded tabs to roughly
// once a minute (this is why production logs show a 60s keepalive cadence for
// backgrounded players, not a client-side backoff). 120s tolerates one missed
// throttled ping without counting a live viewer as gone.
//
// It is deliberately much tighter than the 5-minute session GC timeout: an
// abandoned tab should stop blocking deploys after ~2 minutes, while the
// session itself lingers a little longer in case the user comes back.
const viewerHeldWindow = 120 * time.Second

// DefaultStreamStateFile is where the drain state is published. Matches the
// state dir already granted in aurora.service's ReadWritePaths.
const DefaultStreamStateFile = "/var/lib/aurora/stream-state.json"

// StreamState is the on-disk shape consumed by scripts/aurora-update.sh.
type StreamState struct {
	// UnixTime is when this snapshot was written. Readers MUST treat a stale
	// snapshot as "unknown" and fall back to their own heuristic rather than
	// believing a zero count — a crashed or wedged server would otherwise look
	// exactly like an idle one.
	UnixTime int64 `json:"unix_time"`
	// Sessions is every live transcode session, including ones whose client
	// has wandered off but which have not hit the GC timeout yet.
	Sessions int `json:"sessions"`
	// HeldByViewer is the subset with a client still touching them inside
	// viewerHeldWindow. This is the number a deploy should actually wait on.
	HeldByViewer int `json:"held_by_viewer"`
	// WindowSeconds documents the window HeldByViewer was computed with, so
	// the file is interpretable without reading this source.
	WindowSeconds int `json:"window_seconds"`
}

// DrainState snapshots session counts for the deploy drain gate.
func (tm *TranscodeManager) DrainState() StreamState {
	now := time.Now()

	tm.mu.Lock()
	total := len(tm.sessions)
	held := 0
	for _, s := range tm.sessions {
		if now.Sub(s.LastAccess) < viewerHeldWindow {
			held++
		}
	}
	tm.mu.Unlock()

	return StreamState{
		UnixTime:      now.Unix(),
		Sessions:      total,
		HeldByViewer:  held,
		WindowSeconds: int(viewerHeldWindow / time.Second),
	}
}

// SetStreamStateFile enables drain-state publishing at the given path and
// reports whether publishing was actually enabled. Passing "" disables it.
//
// A missing parent directory disables publishing rather than failing: a source
// checkout or dev box has no /var/lib/aurora, and we would otherwise log a
// failed write every 30s forever. Returning the decision lets the caller say
// so once at startup.
//
// Safe to call before the cleanup loop is running; the first snapshot is
// written immediately so the file is fresh well before any deploy reads it.
func (tm *TranscodeManager) SetStreamStateFile(path string) bool {
	if path != "" && !streamStateDirExists(path) {
		return false
	}
	tm.mu.Lock()
	tm.streamStateFile = path
	tm.mu.Unlock()
	if path == "" {
		return false
	}
	tm.publishDrainState()
	return true
}

// publishDrainState writes the current snapshot to the configured file.
// Best-effort: a failure to publish must never disturb streaming, so errors
// log at Debug and are otherwise swallowed. The consumer's staleness check is
// what makes that safe — an un-refreshed file is treated as unknown, not as
// "zero viewers".
//
// Written via temp file + rename so a reader never observes a half-written
// snapshot and parses it as zero sessions.
func (tm *TranscodeManager) publishDrainState() {
	tm.mu.Lock()
	path := tm.streamStateFile
	tm.mu.Unlock()
	if path == "" {
		return
	}

	// DrainState takes tm.mu itself — call it unlocked.
	blob, err := json.Marshal(tm.DrainState())
	if err != nil {
		slog.Debug("drain state: marshal failed", "error", err)
		return
	}
	blob = append(blob, '\n')

	// 0644: the update script runs as root and could read any mode, but the
	// counts are innocuous and a world-readable file keeps future non-root
	// tooling (a monitoring exporter) from needing privileges.
	tmp := path + ".tmp"
	if werr := os.WriteFile(tmp, blob, 0o644); werr != nil {
		// Most likely cause is the state dir not existing on an install that
		// predates it — Debug, because this is entirely optional telemetry.
		slog.Debug("drain state: write failed", "path", tmp, "error", werr)
		return
	}
	if rerr := os.Rename(tmp, path); rerr != nil {
		slog.Debug("drain state: rename failed", "path", path, "error", rerr)
		_ = os.Remove(tmp)
	}
}

// clearDrainState removes the published file on shutdown. Without this, a
// stopped server would leave its last snapshot behind; a reader that ignored
// the staleness check could then believe stale counts. Best-effort.
func (tm *TranscodeManager) clearDrainState() {
	tm.mu.Lock()
	path := tm.streamStateFile
	tm.mu.Unlock()
	if path == "" {
		return
	}
	_ = os.Remove(path)
	_ = os.Remove(path + ".tmp")
}

// streamStateDirExists reports whether the parent dir of the configured path
// is present. Used at startup to decide whether publishing is viable at all,
// so we log the "not publishing" case ONCE rather than every 30s.
func streamStateDirExists(path string) bool {
	if path == "" {
		return false
	}
	st, err := os.Stat(filepath.Dir(path))
	return err == nil && st.IsDir()
}
