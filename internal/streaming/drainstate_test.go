package streaming

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

func drainTestManager(t *testing.T) *TranscodeManager {
	t.Helper()
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("NewTranscodeManager: %v", err)
	}
	t.Cleanup(tm.Close)
	return tm
}

// addSession registers a session whose LastAccess is `age` in the past.
func addSession(tm *TranscodeManager, id string, age time.Duration) {
	tm.mu.Lock()
	tm.sessions[id] = &TranscodeSession{
		ID:         id,
		LastAccess: time.Now().Add(-age),
		Variants:   map[string]*QualityVariant{},
	}
	tm.mu.Unlock()
}

// TestDrainState_CountsPausedViewerAsHeld is the core regression: a PAUSED
// viewer is exactly the case the old `pgrep ffmpeg` gate got wrong. Their
// encoder has been reaped ("resumable"), so no ffmpeg process exists, but the
// client is still pinging keepalive every 10s and the session must count as
// held. DrainState deliberately looks at LastAccess, which keepalive
// refreshes, and never at process state.
func TestDrainState_CountsPausedViewerAsHeld(t *testing.T) {
	tm := drainTestManager(t)

	// A paused viewer: no variants running at all, but recently touched.
	addSession(tm, "paused-viewer", 5*time.Second)

	st := tm.DrainState()
	if st.Sessions != 1 {
		t.Fatalf("Sessions = %d, want 1", st.Sessions)
	}
	if st.HeldByViewer != 1 {
		t.Fatalf("HeldByViewer = %d, want 1 — a paused viewer with no ffmpeg "+
			"process must still block a deploy", st.HeldByViewer)
	}
}

func TestDrainState_HeldWindow(t *testing.T) {
	tm := drainTestManager(t)

	tests := []struct {
		name string
		age  time.Duration
		held bool
	}{
		{"just pinged", 1 * time.Second, true},
		{"10s cadence", 10 * time.Second, true},
		// Browsers throttle setInterval in background tabs to ~60s; a
		// backgrounded player is still a real viewer.
		{"throttled background tab", 65 * time.Second, true},
		{"one missed throttled ping", 119 * time.Second, true},
		{"abandoned", 121 * time.Second, false},
		{"long gone", 10 * time.Minute, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tm.mu.Lock()
			tm.sessions = map[string]*TranscodeSession{}
			tm.mu.Unlock()
			addSession(tm, "s", tc.age)

			st := tm.DrainState()
			if got := st.HeldByViewer == 1; got != tc.held {
				t.Fatalf("age %v: held=%v, want %v", tc.age, got, tc.held)
			}
			// Either way the session itself is still live — HeldByViewer is
			// about blocking deploys, not about GC.
			if st.Sessions != 1 {
				t.Fatalf("Sessions = %d, want 1", st.Sessions)
			}
		})
	}
}

// TestDrainState_AbandonedSessionDoesNotBlockDeploys — a tab closed without a
// clean DELETE lingers until the 5-minute GC, but must stop blocking restarts
// long before that.
func TestDrainState_AbandonedSessionDoesNotBlockDeploys(t *testing.T) {
	tm := drainTestManager(t)
	addSession(tm, "live", 3*time.Second)
	addSession(tm, "abandoned", 4*time.Minute)

	st := tm.DrainState()
	if st.Sessions != 2 {
		t.Fatalf("Sessions = %d, want 2", st.Sessions)
	}
	if st.HeldByViewer != 1 {
		t.Fatalf("HeldByViewer = %d, want 1 (only the live one)", st.HeldByViewer)
	}
}

func TestDrainState_Empty(t *testing.T) {
	st := drainTestManager(t).DrainState()
	if st.Sessions != 0 || st.HeldByViewer != 0 {
		t.Fatalf("empty manager: %+v", st)
	}
	if st.UnixTime == 0 {
		t.Fatal("UnixTime must be stamped so readers can detect staleness")
	}
	if st.WindowSeconds != 120 {
		t.Fatalf("WindowSeconds = %d, want 120", st.WindowSeconds)
	}
}

// TestPublishDrainState_FileShape pins the on-disk contract consumed by
// scripts/aurora-update.sh. If these key names change, the shell's sed
// extraction silently falls back to the old pgrep heuristic — which is safe
// but reintroduces the bug, so the field names are load-bearing.
func TestPublishDrainState_FileShape(t *testing.T) {
	tm := drainTestManager(t)
	path := filepath.Join(t.TempDir(), "stream-state.json")

	if !tm.SetStreamStateFile(path) {
		t.Fatal("SetStreamStateFile should enable publishing when the dir exists")
	}
	addSession(tm, "live", 2*time.Second)
	tm.publishDrainState()

	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read published state: %v", err)
	}

	// Parse into a bare map so a renamed field fails loudly rather than
	// zero-valuing through the typed struct.
	var raw map[string]any
	if uerr := json.Unmarshal(blob, &raw); uerr != nil {
		t.Fatalf("published state is not valid JSON: %v\n%s", uerr, blob)
	}
	for _, key := range []string{"unix_time", "sessions", "held_by_viewer", "window_seconds"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("published state missing %q — aurora-update.sh greps for it\n%s", key, blob)
		}
	}
	if got := raw["held_by_viewer"]; got != float64(1) {
		t.Fatalf("held_by_viewer = %v, want 1", got)
	}

	// No .tmp left behind by the atomic-rename write.
	if _, serr := os.Stat(path + ".tmp"); !os.IsNotExist(serr) {
		t.Fatal("temp file should not survive a successful publish")
	}
}

// TestSetStreamStateFile_MissingDirDisables — a dev box or source checkout has
// no /var/lib/aurora. Publishing must disable itself rather than log a failed
// write every 30s for the life of the process.
func TestSetStreamStateFile_MissingDirDisables(t *testing.T) {
	tm := drainTestManager(t)
	path := filepath.Join(t.TempDir(), "definitely", "absent", "stream-state.json")

	if tm.SetStreamStateFile(path) {
		t.Fatal("publishing should be disabled when the parent dir is missing")
	}
	tm.publishDrainState() // must not panic or create anything
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("nothing should have been written")
	}
}

// TestPublishDrainState_ConcurrentWritesStayValid — the published file is
// parsed by a shell script that falls back to the old ffmpeg heuristic on any
// malformed input. A torn write therefore doesn't crash anything; it silently
// downgrades the deploy gate back to the bug this all exists to fix. Hammer
// the publisher from several goroutines and require every observation to be
// well-formed. Run with -race to also catch unsynchronized access.
func TestPublishDrainState_ConcurrentWritesStayValid(t *testing.T) {
	tm := drainTestManager(t)
	path := filepath.Join(t.TempDir(), "stream-state.json")
	tm.SetStreamStateFile(path)
	addSession(tm, "live", time.Second)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				tm.publishDrainState()
			}
		}()
	}
	// Concurrent readers, mimicking the update script polling mid-write.
	var readErr error
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				blob, err := os.ReadFile(path)
				if err != nil {
					continue // mid-rename; the script retries too
				}
				var st StreamState
				if uerr := json.Unmarshal(blob, &st); uerr != nil {
					readErr = uerr
					return
				}
			}
		}()
	}
	wg.Wait()

	if readErr != nil {
		t.Fatalf("observed a torn snapshot: %v", readErr)
	}
}

// TestClearDrainState_RemovesFile — a stopped server must not leave a snapshot
// that a reader could mistake for live state.
func TestClearDrainState_RemovesFile(t *testing.T) {
	tm := drainTestManager(t)
	path := filepath.Join(t.TempDir(), "stream-state.json")
	tm.SetStreamStateFile(path)

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected an initial snapshot: %v", err)
	}
	tm.clearDrainState()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("clearDrainState should remove the published file")
	}
}
