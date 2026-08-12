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

// The end-to-end shape of the fix, driven through the SWEEP rather than the
// pure helper: at 10 minutes idle — a locked phone plus a cast paused on the
// TV — the normal session is reaped and the cast-held one survives.
//
// This runs the real selection rule (takeExpiredSessions), which is what
// cleanupLoop calls. An earlier version of this test only called
// sessionIdleTimeout twice and compared it to constants; reverting the loop
// to ignore castHeld left it green, which made it worthless as a guard.
func TestTakeExpiredSessions_CastHeldSurvivesTheNormalIdleSweep(t *testing.T) {
	tm := castLeaseManager(t)
	now := time.Now()
	idle := 10 * time.Minute

	addLeaseSession(tm, "normal", now.Add(-idle), false)
	addLeaseSession(tm, "casting", now.Add(-idle), true)
	addLeaseSession(tm, "fresh", now.Add(-30*time.Second), false)

	expired := tm.takeExpiredSessions(5*time.Minute, now)

	gone := map[string]bool{}
	for _, s := range expired {
		gone[s.ID] = true
	}
	if !gone["normal"] {
		t.Error("a normal session idle for 10m should have been reaped")
	}
	if gone["casting"] {
		t.Error("a cast-held session idle for 10m must survive — this is the whole fix")
	}
	if gone["fresh"] {
		t.Error("a session touched 30s ago must not be reaped")
	}

	// And it is actually removed from the manager, not merely reported.
	tm.mu.Lock()
	_, normalStillThere := tm.sessions["normal"]
	_, castStillThere := tm.sessions["casting"]
	tm.mu.Unlock()
	if normalStillThere {
		t.Error("reaped session should be gone from the map")
	}
	if !castStillThere {
		t.Error("cast-held session should still be in the map")
	}
}

// The lease is a reprieve, not immortality: past castHeldTimeout a cast-held
// session is reaped like anything else. Without this, "never expires" would
// pass every other test in this file.
func TestTakeExpiredSessions_CastHeldStillExpiresEventually(t *testing.T) {
	tm := castLeaseManager(t)
	now := time.Now()

	addLeaseSession(tm, "long-abandoned-cast", now.Add(-castHeldTimeout-time.Minute), true)

	expired := tm.takeExpiredSessions(5*time.Minute, now)
	if len(expired) != 1 || expired[0].ID != "long-abandoned-cast" {
		t.Errorf("a cast-held session idle past the lease must be reaped, got %d session(s)", len(expired))
	}
}

func addLeaseSession(tm *TranscodeManager, id string, lastAccess time.Time, castHeld bool) {
	tm.mu.Lock()
	tm.sessions[id] = &TranscodeSession{
		ID:         id,
		LastAccess: lastAccess,
		castHeld:   castHeld,
		Variants:   map[string]*QualityVariant{},
	}
	tm.mu.Unlock()
}
