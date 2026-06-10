package watchparty

import (
	"testing"
	"time"
)

// TestV3_FireScheduledStart_DrivesV3Playback is the regression test for audit
// H6. A host-scheduled countdown firing must drive the V3 playback path
// (Running + tick loop), not the dead V2 state machine. Before the fix,
// fireScheduledStart called HandlePlaybackControl, which only mutated the
// unused V2 tri-state: ps.Running stayed false and the tick loop never
// started, so V3 clients (the only live transport) showed "Starting now!" and
// then sat paused at the anchor forever.
func TestV3_FireScheduledStart_DrivesV3Playback(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SCHED1", 1)

	m.fireScheduledStart("SCHED1")

	ps.mu.Lock()
	started := ps.StartedAt != nil
	running := ps.Running
	hasTick := ps.tickCancel != nil
	m.stopTickLoopLocked(ps) // cleanup; contract requires the caller hold ps.mu
	ps.mu.Unlock()

	if !started {
		t.Error("StartedAt is nil after fireScheduledStart; want set")
	}
	if !running {
		t.Error("Running=false after scheduled start; want true (V3 playback never engaged)")
	}
	if !hasTick {
		t.Error("tickCancel is nil after scheduled start; the tick loop did not start")
	}
}

// TestV3_FireScheduledStart_Dedup verifies the StartedAt guard: a second fire
// (e.g. timer fired after a manual play already started the party) is a no-op
// and does not restart the tick loop.
func TestV3_FireScheduledStart_Dedup(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SCHED2", 1)

	m.fireScheduledStart("SCHED2")
	ps.mu.Lock()
	firstStart := ps.StartedAt // *time.Time — pointer identity proves no re-stamp
	ps.mu.Unlock()

	m.fireScheduledStart("SCHED2") // second fire — should dedup on StartedAt

	ps.mu.Lock()
	defer ps.mu.Unlock()
	m.stopTickLoopLocked(ps)
	if ps.StartedAt != firstStart {
		t.Error("StartedAt was re-stamped on the second fire; dedup guard failed")
	}
	if !ps.Running {
		t.Error("Running flipped to false after a deduped second fire; want still true")
	}
}

// TestV3_FireScheduledStart_SpoilerGateLeavesRetryable is the regression test
// for the audit H6 follow-up. When SpoilerFreeStart is on and a non-host
// participant has not readied up, HandleRequestPlay refuses to start playback.
// fireScheduledStart must NOT stamp StartedAt (or persist MarkPartyStarted) in
// that case, so the scheduled start stays retryable (a later manual host play,
// which doesn't consult StartedAt, still works) rather than recording a false,
// permanent "started" state.
func TestV3_FireScheduledStart_SpoilerGateLeavesRetryable(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SCHED3", 1)
	ps.mu.Lock()
	ps.Settings.SpoilerFreeStart = true
	ps.Participants[2] = &Participant{
		UserID: 2, Username: "guest", IsHost: false, Ready: false,
		LastSeen: time.Now(),
	}
	ps.mu.Unlock()

	m.fireScheduledStart("SCHED3")

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.tickCancel != nil {
		m.stopTickLoopLocked(ps) // cleanup if somehow started
		t.Error("tick loop started despite the spoiler-free gate; want not started")
	}
	if ps.StartedAt != nil {
		t.Error("StartedAt was stamped despite the gate blocking playback; want nil (retryable)")
	}
	if ps.Running {
		t.Error("Running=true despite the spoiler-free gate; want false")
	}
}

// TestV3_MarkReady_RetriesOverdueScheduledStart is the 2026-06 review
// (bug 2) regression test: when the countdown fired while the spoiler-free
// gate was blocking, the LAST guest readying up must re-fire the scheduled
// start — previously the "retryable" log line had no retry mechanism and
// the party never auto-started.
func TestV3_MarkReady_RetriesOverdueScheduledStart(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SCHED4", 1)
	overdue := time.Now().Add(-1 * time.Second)
	ps.mu.Lock()
	ps.Settings.SpoilerFreeStart = true
	ps.ScheduledStartAt = &overdue
	ps.Participants[2] = &Participant{
		UserID: 2, Username: "guest", IsHost: false, Ready: false,
		LastSeen: time.Now(),
	}
	ps.mu.Unlock()

	// The countdown fires while the guest is not ready — blocked.
	m.fireScheduledStart("SCHED4")
	ps.mu.Lock()
	if ps.Running || ps.StartedAt != nil {
		ps.mu.Unlock()
		t.Fatal("precondition failed: gate should have blocked the scheduled start")
	}
	ps.mu.Unlock()

	// Guest readies up — the retry hook should engage playback.
	if err := m.MarkReady("SCHED4", 2, true); err != nil {
		t.Fatalf("MarkReady: %v", err)
	}

	// The retry runs in a goroutine; poll briefly for the transition.
	deadline := time.Now().Add(2 * time.Second)
	for {
		ps.mu.Lock()
		running := ps.Running
		started := ps.StartedAt != nil
		ps.mu.Unlock()
		if running && started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("party never started after the last guest readied up (scheduled-start retry missing)")
		}
		time.Sleep(10 * time.Millisecond)
	}

	ps.mu.Lock()
	m.stopTickLoopLocked(ps)
	ps.mu.Unlock()
}
