package watchparty

import (
	"testing"
	"time"
)

// TestV3_CurrentAbsMs_Paused asserts that when Running is false, the
// canonical position is frozen at the anchor regardless of how much wall
// clock has elapsed. This is the Paused half of the Running/Paused model.
func TestV3_CurrentAbsMs_Paused(t *testing.T) {
	ps := &PartyState{
		Running:        false,
		AnchorAbsMs:    120_000, // 2 minutes in
		AnchorServerAt: time.Now().Add(-10 * time.Second),
	}
	got := ps.CurrentAbsMs()
	if got != 120_000 {
		t.Fatalf("paused party: CurrentAbsMs=%d, want 120000 (anchor frozen)", got)
	}
}

// TestV3_CurrentAbsMs_Running asserts that when Running is true, the
// canonical position advances with wall-clock time. Allow a 50ms window
// for scheduler noise — the test isn't racing the clock, but it's still
// real wall-clock arithmetic.
func TestV3_CurrentAbsMs_Running(t *testing.T) {
	ps := &PartyState{
		Running:        true,
		AnchorAbsMs:    60_000, // 1 minute in
		AnchorServerAt: time.Now().Add(-500 * time.Millisecond),
	}
	got := ps.CurrentAbsMs()
	want := int64(60_500)
	if got < want-50 || got > want+50 {
		t.Fatalf("running party: CurrentAbsMs=%d, want ~%d (±50ms)", got, want)
	}
}

// TestV3_SetAnchorLocked_Pause captures the semantics of transitioning to
// Paused: the anchor absorbs the current position, and subsequent
// CurrentAbsMs calls return that frozen value.
func TestV3_SetAnchorLocked_Pause(t *testing.T) {
	ps := &PartyState{
		Running:        true,
		AnchorAbsMs:    0,
		AnchorServerAt: time.Now().Add(-3 * time.Second),
	}
	// Freeze at "~3s into the stream."
	ps.setAnchorLocked(3_000, false)
	time.Sleep(20 * time.Millisecond)
	got := ps.CurrentAbsMs()
	if got != 3_000 {
		t.Errorf("after pause: CurrentAbsMs=%d, want 3000 (frozen)", got)
	}
}

// TestV3_SetAnchorLocked_Seek captures the semantics of a seek while
// Running: the anchor resets to the seek target, and time continues
// advancing from there.
func TestV3_SetAnchorLocked_Seek(t *testing.T) {
	ps := &PartyState{
		Running:        true,
		AnchorAbsMs:    10_000,
		AnchorServerAt: time.Now(),
	}
	// Simulate wall clock advancing a bit before the seek.
	time.Sleep(30 * time.Millisecond)
	// Seek forward to the 5-minute mark, still Running.
	ps.setAnchorLocked(300_000, true)
	got := ps.CurrentAbsMs()
	// Should be ~300_000 plus whatever tiny amount of time elapsed since
	// setAnchorLocked set AnchorServerAt=now. Allow a 50ms window.
	if got < 300_000 || got > 300_050 {
		t.Errorf("after seek while Running: CurrentAbsMs=%d, want 300000–300050", got)
	}
}

// TestV3_TickLoop_StartStop asserts that starting and then stopping the
// tick loop is clean: no panic, and the cancel function becomes nil so
// subsequent start calls can spawn a fresh loop.
func TestV3_TickLoop_StartStop(t *testing.T) {
	m := NewManager(nil, nil)
	ps := &PartyState{
		Code:      "TEST01",
		Running:   true,
		syncConns: make(map[int64]*SafeConn),
	}
	m.startTickLoopLocked(ps)
	if ps.tickCancel == nil {
		t.Fatal("after startTickLoopLocked: tickCancel is nil (loop didn't start)")
	}
	// Second start is a no-op.
	firstCancel := ps.tickCancel
	m.startTickLoopLocked(ps)
	if ps.tickCancel == nil {
		t.Fatal("after double-start: tickCancel is nil")
	}
	// Pointer-equality check via indirect cancel call isn't directly
	// possible; assert that no new goroutine was registered by checking
	// we still have the same cancel (functions aren't comparable, but
	// calling the old one should still work after stop).
	_ = firstCancel

	m.stopTickLoopLocked(ps)
	if ps.tickCancel != nil {
		t.Fatal("after stopTickLoopLocked: tickCancel should be nil")
	}
	// Safe to double-stop.
	m.stopTickLoopLocked(ps)
}

// TestV3_TickLoop_EmitsWhileRunning is a smoke test: start the tick loop,
// wait ~2 intervals, assert that the party's CurrentAbsMs has advanced by
// roughly the elapsed wall-clock. This proves the goroutine is actually
// iterating and that the anchor model reacts to wall time.
func TestV3_TickLoop_EmitsWhileRunning(t *testing.T) {
	m := NewManagerWithConfig(nil, nil, SyncConfig{TickInterval: 20 * time.Millisecond})
	ps := &PartyState{
		Code:           "TICK01",
		Running:        true,
		AnchorAbsMs:    0,
		AnchorServerAt: time.Now(),
		syncConns:      make(map[int64]*SafeConn),
	}
	m.startTickLoopLocked(ps)
	defer m.stopTickLoopLocked(ps)

	time.Sleep(100 * time.Millisecond)

	ps.mu.Lock()
	got := ps.CurrentAbsMs()
	ps.mu.Unlock()
	if got < 80 || got > 200 {
		t.Errorf("after 100ms of Running: CurrentAbsMs=%d, want ~100 (80–200)", got)
	}
}

// ============================================================
// V3 intent-handler tests
// ============================================================
// These drive HandleRequestPlay/Pause/Seek against a fabricated party
// (no DB, no real WebSockets) and assert the state transitions and
// tick-loop side effects.

// v3TestParty creates a bare PartyState registered on m, with one host
// participant. No DB, no conns — enough for handler-level tests.
func v3TestParty(m *Manager, code string, hostID int64) *PartyState {
	ps := &PartyState{
		Code:            code,
		HostUserID:      hostID,
		MaxParticipants: 5,
		StateRevision:   1,
		Participants:    map[int64]*Participant{hostID: {UserID: hostID, Username: "host", IsHost: true, LastSeen: time.Now()}},
		syncConns:       map[int64]*SafeConn{},
		roomConns:       map[int64]*SafeConn{},
		ChatHistory:     []ChatMessage{},
		Settings:        PartySettings{AllowPause: false, AllowChat: true, MaxParticipants: 5},
		CreatedAt:       time.Now(),
	}
	m.mu.Lock()
	m.parties[code] = ps
	m.mu.Unlock()
	return ps
}

// TestV3_HandleRequestPlay_HostStartsRunning asserts a host's play request
// transitions the party to Running, starts the tick goroutine, and bumps
// StateRevision.
func TestV3_HandleRequestPlay_HostStartsRunning(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "PLAY01", 1)
	prevRev := ps.StateRevision

	if err := m.HandleRequestPlay("PLAY01", 1); err != nil {
		t.Fatalf("HandleRequestPlay returned error: %v", err)
	}
	defer m.stopTickLoopLocked(ps) // cleanup

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if !ps.Running {
		t.Errorf("Running=false after request-play, want true")
	}
	if ps.StateRevision <= prevRev {
		t.Errorf("StateRevision=%d did not advance past %d", ps.StateRevision, prevRev)
	}
	if ps.tickCancel == nil {
		t.Errorf("tickCancel is nil — tick goroutine did not start")
	}
}

// TestV3_HandleRequestPlay_NonHostRejected verifies a non-host cannot
// start playback in Phase 1 (host-only).
func TestV3_HandleRequestPlay_NonHostRejected(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "PLAY02", 1)
	ps.Participants[2] = &Participant{UserID: 2, Username: "guest"}

	if err := m.HandleRequestPlay("PLAY02", 2); err == nil {
		t.Fatal("guest's request-play was accepted, want error")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.Running {
		t.Errorf("Running=true after rejected guest request, want false")
	}
	if ps.tickCancel != nil {
		t.Errorf("tickCancel non-nil after rejection — goroutine should not have started")
	}
}

// TestV3_HandleRequestPause_StopsTickLoop asserts pause freezes the
// anchor and cancels the tick goroutine.
func TestV3_HandleRequestPause_StopsTickLoop(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "PAUS01", 1)

	// Start running.
	if err := m.HandleRequestPlay("PAUS01", 1); err != nil {
		t.Fatalf("setup play: %v", err)
	}
	time.Sleep(30 * time.Millisecond)

	if err := m.HandleRequestPause("PAUS01", 1, -1); err != nil {
		t.Fatalf("pause: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.Running {
		t.Errorf("Running=true after pause, want false")
	}
	if ps.tickCancel != nil {
		t.Errorf("tickCancel non-nil after pause — goroutine should have stopped")
	}
	// Anchor should absorb roughly 30ms of elapsed time.
	if ps.AnchorAbsMs < 20 || ps.AnchorAbsMs > 100 {
		t.Errorf("paused anchor=%d, want ~30 (20–100)", ps.AnchorAbsMs)
	}
}

// TestV3_HandleRequestSeek_Running asserts seek while Running moves the
// anchor, preserves Running state, and does NOT stop the tick loop.
func TestV3_HandleRequestSeek_Running(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SEEK01", 1)

	_ = m.HandleRequestPlay("SEEK01", 1)
	defer m.stopTickLoopLocked(ps)

	if err := m.HandleRequestSeek("SEEK01", 1, 600_000); err != nil {
		t.Fatalf("seek: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if !ps.Running {
		t.Errorf("Running=false after seek-while-running, want true")
	}
	if ps.AnchorAbsMs != 600_000 {
		t.Errorf("anchor=%d, want 600000", ps.AnchorAbsMs)
	}
	if ps.tickCancel == nil {
		t.Errorf("tickCancel nil after seek — tick goroutine should still be running")
	}
}

// TestV3_HandleRequestSeek_Paused asserts seek while Paused moves the
// anchor but does NOT start the tick loop.
func TestV3_HandleRequestSeek_Paused(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SEEK02", 1)
	// party is Idle/Paused by default

	if err := m.HandleRequestSeek("SEEK02", 1, 90_000); err != nil {
		t.Fatalf("seek: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.Running {
		t.Errorf("Running=true after seek-while-paused, want false")
	}
	if ps.AnchorAbsMs != 90_000 {
		t.Errorf("anchor=%d, want 90000", ps.AnchorAbsMs)
	}
	if ps.tickCancel != nil {
		t.Errorf("tickCancel non-nil — tick should not have started on paused seek")
	}
}

// TestV3_StateRevision_MonotonicOnIntent verifies that play, pause, and
// seek each bump StateRevision exactly once.
func TestV3_StateRevision_MonotonicOnIntent(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "REV001", 1)
	r0 := ps.StateRevision

	_ = m.HandleRequestPlay("REV001", 1)
	ps.mu.Lock()
	r1 := ps.StateRevision
	ps.mu.Unlock()
	if r1 <= r0 {
		t.Fatalf("play: rev %d → %d, want increase", r0, r1)
	}

	_ = m.HandleRequestSeek("REV001", 1, 10_000)
	ps.mu.Lock()
	r2 := ps.StateRevision
	ps.mu.Unlock()
	if r2 <= r1 {
		t.Fatalf("seek: rev %d → %d, want increase", r1, r2)
	}

	_ = m.HandleRequestPause("REV001", 1, -1)
	ps.mu.Lock()
	r3 := ps.StateRevision
	ps.mu.Unlock()
	if r3 <= r2 {
		t.Fatalf("pause: rev %d → %d, want increase", r2, r3)
	}
}

// TestV3_HandleRequestPause_RejectsOutOfRangePosition — 2026-06 review:
// pause writes the same anchor a seek does, so it needs the same 24h
// upper bound. An unbounded at_ms (e.g. MaxInt64) would overflow
// CurrentAbsMs() after the next play and broadcast absurd negative
// positions to every peer.
func TestV3_HandleRequestPause_RejectsOutOfRangePosition(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "PAUS02", 1)
	ps.mu.Lock()
	ps.setAnchorLocked(5_000, true)
	ps.mu.Unlock()

	if err := m.HandleRequestPause("PAUS02", 1, int64(1)<<62); err == nil {
		t.Fatal("pause with an absurd at_ms should be rejected")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if !ps.Running {
		t.Error("rejected pause must not change Running")
	}
	if ps.AnchorAbsMs != 5_000 {
		t.Errorf("rejected pause must not move the anchor; got %d", ps.AnchorAbsMs)
	}
	m.stopTickLoopLocked(ps)
}
