package streaming

import (
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// The cast lease exists for one scenario: playback has moved to a TV and the
// phone that started it has locked. A locked phone's page is frozen by the
// OS, so the 10-second keepalive stops entirely — and if the receiver also
// stops pulling (paused on the TV, a Wi-Fi blip, a short title fully
// buffered), nothing is left to defend a session that the 5-minute idle
// sweep is about to delete along with its segments.

func castLeaseManager(t *testing.T) *TranscodeManager {
	t.Helper()
	tm, err := NewTranscodeManager(t.TempDir(), config.TranscodeConfig{})
	if err != nil {
		t.Fatalf("NewTranscodeManager: %v", err)
	}
	t.Cleanup(tm.Close)
	return tm
}

func TestSessionIdleTimeout_CastHeldGetsTheLongerWindow(t *testing.T) {
	const configured = 5 * time.Minute

	if got := sessionIdleTimeout(false, configured); got != configured {
		t.Fatalf("local playback should keep the configured window: got %v, want %v", got, configured)
	}
	if got := sessionIdleTimeout(true, configured); got != castHeldTimeout {
		t.Fatalf("cast-held session should get the lease: got %v, want %v", got, castHeldTimeout)
	}
}

// A zero SessionTimeout means "unset" everywhere else in the cleanup loop,
// and the lease must not be the one place it reads as "expire immediately".
func TestSessionIdleTimeout_UnsetConfigFallsBackToTheDefault(t *testing.T) {
	if got := sessionIdleTimeout(false, 0); got != 5*time.Minute {
		t.Fatalf("unset timeout should fall back to 5m, got %v", got)
	}
	if got := sessionIdleTimeout(true, 0); got != castHeldTimeout {
		t.Fatalf("unset timeout + cast should still get the lease, got %v", got)
	}
}

// An operator who set session_timeout_sec above the lease meant it. Casting
// is the last thing that should get LESS patience than local playback, so
// the lease only ever widens the window.
func TestSessionIdleTimeout_NeverShortensAGenerousConfig(t *testing.T) {
	generous := castHeldTimeout + time.Hour
	if got := sessionIdleTimeout(true, generous); got != generous {
		t.Fatalf("lease must not shorten a longer configured window: got %v, want %v", got, generous)
	}
}

func TestMarkCastHeld_FlagsTheSessionAndRestartsItsClock(t *testing.T) {
	tm := castLeaseManager(t)

	stale := time.Now().Add(-4 * time.Minute)
	tm.mu.Lock()
	tm.sessions["cast-me"] = &TranscodeSession{
		ID:         "cast-me",
		LastAccess: stale,
		Variants:   map[string]*QualityVariant{},
	}
	tm.mu.Unlock()

	if !tm.MarkCastHeld("cast-me") {
		t.Fatal("MarkCastHeld should report success for an existing session")
	}

	tm.mu.Lock()
	s := tm.sessions["cast-me"]
	held, last := s.castHeld, s.LastAccess
	tm.mu.Unlock()

	if !held {
		t.Error("session should be marked cast-held")
	}
	// Minting a token means a receiver is about to fetch: the idle clock
	// should run from now, not from whenever the browser last pinged.
	if !last.After(stale) {
		t.Errorf("MarkCastHeld should bump LastAccess: got %v, want later than %v", last, stale)
	}
}

func TestMarkCastHeld_UnknownSessionIsReportedNotCreated(t *testing.T) {
	tm := castLeaseManager(t)
	if tm.MarkCastHeld("nope") {
		t.Error("MarkCastHeld should report failure for a session that does not exist")
	}
	tm.mu.Lock()
	n := len(tm.sessions)
	tm.mu.Unlock()
	if n != 0 {
		t.Errorf("MarkCastHeld must not conjure a session: got %d sessions", n)
	}
}

// The end-to-end shape of the fix, expressed against the same predicate the
// cleanup loop uses: at 10 minutes idle — a locked phone plus a cast paused
// on the TV — a normal session is gone and a cast-held one survives.
func TestCastHeldSessionOutlivesTheNormalIdleSweep(t *testing.T) {
	const configured = 5 * time.Minute
	const idle = 10 * time.Minute

	if idle <= sessionIdleTimeout(false, configured) {
		t.Fatal("precondition: a normal session should already be expired at 10m idle")
	}
	if idle > sessionIdleTimeout(true, configured) {
		t.Errorf("a cast-held session must survive %v idle, window is only %v",
			idle, sessionIdleTimeout(true, configured))
	}
}
