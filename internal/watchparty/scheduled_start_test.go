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

// waitForScheduledStart polls until the party is Running with StartedAt
// stamped, or fails the test. The retry hooks fire in goroutines, so the
// transition is asynchronous.
func waitForScheduledStart(t *testing.T, m *Manager, ps *PartyState, msg string) {
	t.Helper()
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
			t.Fatal(msg)
		}
		time.Sleep(10 * time.Millisecond)
	}
	ps.mu.Lock()
	m.stopTickLoopLocked(ps)
	ps.mu.Unlock()
}

// TestV3_LeaveRetriesOverdueScheduledStart — 2026-06 review follow-up:
// the gate can also unblock when the last NOT-READY guest leaves the
// party (everyone remaining is already Ready, so no further ready toggle
// will ever fire). The leave path must re-fire the scheduled start.
func TestV3_LeaveRetriesOverdueScheduledStart(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SCHED5", 1)
	overdue := time.Now().Add(-1 * time.Second)
	ps.mu.Lock()
	ps.Settings.SpoilerFreeStart = true
	ps.ScheduledStartAt = &overdue
	ps.Participants[2] = &Participant{
		UserID: 2, Username: "ready-guest", IsHost: false, Ready: true,
		LastSeen: time.Now(),
	}
	ps.Participants[3] = &Participant{
		UserID: 3, Username: "blocker", IsHost: false, Ready: false,
		LastSeen: time.Now(),
	}
	ps.mu.Unlock()

	// Countdown fires while the blocker is not ready — blocked.
	m.fireScheduledStart("SCHED5")
	ps.mu.Lock()
	if ps.Running || ps.StartedAt != nil {
		ps.mu.Unlock()
		t.Fatal("precondition failed: gate should have blocked the scheduled start")
	}
	ps.mu.Unlock()

	// The blocker gives up and leaves — the gate is now satisfiable and
	// no ready toggle will ever fire again.
	if err := m.LeavePartyV3Room("SCHED5", 3); err != nil {
		t.Fatalf("LeavePartyV3Room: %v", err)
	}

	waitForScheduledStart(t, m, ps,
		"party never started after the blocking guest left (leave-path retry missing)")
}

// TestV3_HostLeaveHandoffRetriesOverdueScheduledStart — 2026-08 host
// succession: a host bailing before an overdue scheduled start used to
// end the party outright. Now the remaining guest inherits it — and
// because the spoiler gate never counts the HOST as a blocker
// (spoilerGateBlockersLocked skips IsHost), the handoff itself clears a
// gate that was blocked on that very guest, so the leave path's retry
// must fire the start for the survivor. Deliberate rule composition,
// not an accident: a scheduled party auto-starting on schedule is what
// its members signed up for, and the inherited host can pause at will.
func TestV3_HostLeaveHandoffRetriesOverdueScheduledStart(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SCHED7", 1)
	overdue := time.Now().Add(-1 * time.Second)
	ps.mu.Lock()
	ps.Settings.SpoilerFreeStart = true
	ps.ScheduledStartAt = &overdue
	// Guest 2 hasn't readied up — the gate's sole blocker.
	ps.Participants[2] = &Participant{
		UserID: 2, Username: "guest", IsHost: false, Ready: false,
		LastSeen: time.Now(), JoinedAt: time.Now(),
	}
	ps.mu.Unlock()

	// Countdown fires while the guest is not ready — blocked.
	m.fireScheduledStart("SCHED7")
	ps.mu.Lock()
	if ps.Running || ps.StartedAt != nil {
		ps.mu.Unlock()
		t.Fatal("precondition failed: not-ready guest should have blocked the scheduled start")
	}
	ps.mu.Unlock()

	// The host bails. Pre-succession this ended the party for everyone.
	if err := m.LeavePartyV3Room("SCHED7", 1); err != nil {
		t.Fatalf("LeavePartyV3Room: %v", err)
	}
	m.mu.RLock()
	_, exists := m.parties["SCHED7"]
	m.mu.RUnlock()
	if !exists {
		t.Fatal("party must survive the host leave while a guest remains (succession)")
	}

	waitForScheduledStart(t, m, ps,
		"party never started after the host handed off (promotion retry missing)")
}

// TestV3_HostJoinRetriesOverdueScheduledStart — 2026-06 review follow-up:
// the countdown can fire before the host's room socket has joined
// (HandleRequestPlay rejects non-participants), and if every guest was
// already Ready no ready toggle will ever fire. The host's join must
// re-fire the scheduled start.
func TestV3_HostJoinRetriesOverdueScheduledStart(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SCHED6", 1)
	overdue := time.Now().Add(-1 * time.Second)
	ps.mu.Lock()
	ps.ScheduledStartAt = &overdue
	// Host is NOT a participant yet (their room socket never joined —
	// v3TestParty seeds them, so remove).
	delete(ps.Participants, 1)
	ps.mu.Unlock()

	// Countdown fires with no host connected — play is rejected.
	m.fireScheduledStart("SCHED6")
	ps.mu.Lock()
	if ps.Running || ps.StartedAt != nil {
		ps.mu.Unlock()
		t.Fatal("precondition failed: missing host should have blocked the scheduled start")
	}
	ps.mu.Unlock()

	// Host's room socket joins — the join path must re-fire.
	if _, err := m.JoinPartyV3Room("SCHED6", 1, "host", nil); err != nil {
		t.Fatalf("JoinPartyV3Room: %v", err)
	}

	waitForScheduledStart(t, m, ps,
		"party never started after the host joined (host-join retry missing)")
}

// TestV3_SpoilerGate_SkipsCompanions — 2026-06 review: a phone-companion
// participant has no video player and no Ready affordance (useCompanion
// never sends {type:"ready"}), so counting them in the spoiler gate made
// a chat-only phone guest block the party's start forever.
func TestV3_SpoilerGate_SkipsCompanions(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SCHED7", 1)
	ps.mu.Lock()
	ps.Settings.SpoilerFreeStart = true
	ps.Participants[2] = &Participant{
		UserID: 2, Username: "phone-guest", IsHost: false, Ready: false,
		Companion: true, LastSeen: time.Now(),
	}
	ps.mu.Unlock()

	if err := m.HandleRequestPlay("SCHED7", 1); err != nil {
		t.Fatalf("companion-only guest must not block the spoiler gate, got: %v", err)
	}
	ps.mu.Lock()
	m.stopTickLoopLocked(ps)
	ps.mu.Unlock()
}
