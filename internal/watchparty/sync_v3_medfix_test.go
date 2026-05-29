package watchparty

import (
	"testing"
)

// ============================================================
// MED-integration fix coverage (2026-05-29)
// ============================================================
// Finding 1: LeavePartyV3SyncIfConn must not evict a freshly-reconnected
//            sync conn (conn-identity guard).
// Finding 2: HandleRequestPlay/Pause/Seek must reject non-participants even
//            when the per-intent host / AllowPause check would otherwise pass.
//
// These reuse v3TestParty + the no-DB Manager harness from sync_v3_test.go.

// TestV3_LeaveSyncIfConn_KeepsReconnectedConn verifies the conn-identity
// guard: when the stored sync conn has already been replaced by a newer one
// (reconnect), the OLD conn's deferred leave must NOT delete the live slot.
func TestV3_LeaveSyncIfConn_KeepsReconnectedConn(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "LEAVE1", 1)

	oldConn := &SafeConn{}
	newConn := &SafeConn{}

	// Simulate: user's first sync socket registered, then a second socket
	// (reconnect) overwrote the slot with newConn.
	ps.mu.Lock()
	ps.syncConns[1] = newConn
	ps.mu.Unlock()

	// The OLD socket's read pump now dies and its defer fires with oldConn.
	m.LeavePartyV3SyncIfConn("LEAVE1", 1, oldConn)

	ps.mu.Lock()
	got := ps.syncConns[1]
	ps.mu.Unlock()
	if got != newConn {
		t.Fatalf("reconnected conn was evicted by stale leave: got %p, want newConn %p", got, newConn)
	}
}

// TestV3_LeaveSyncIfConn_RemovesOwnConn verifies the guard still removes the
// slot when the leaving conn IS the one currently stored (the normal
// single-socket disconnect path).
func TestV3_LeaveSyncIfConn_RemovesOwnConn(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "LEAVE2", 1)

	myConn := &SafeConn{}
	ps.mu.Lock()
	ps.syncConns[1] = myConn
	ps.mu.Unlock()

	m.LeavePartyV3SyncIfConn("LEAVE2", 1, myConn)

	ps.mu.Lock()
	_, present := ps.syncConns[1]
	ps.mu.Unlock()
	if present {
		t.Fatal("own conn was not removed on disconnect")
	}
}

// TestV3_LeaveSyncIfConn_NilFallsBackToUnconditional verifies nil sc behaves
// like the unconditional LeavePartyV3Sync (used by callers without a conn
// handle, e.g. tests).
func TestV3_LeaveSyncIfConn_NilFallsBackToUnconditional(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "LEAVE3", 1)

	ps.mu.Lock()
	ps.syncConns[1] = &SafeConn{}
	ps.mu.Unlock()

	m.LeavePartyV3SyncIfConn("LEAVE3", 1, nil)

	ps.mu.Lock()
	_, present := ps.syncConns[1]
	ps.mu.Unlock()
	if present {
		t.Fatal("nil-sc leave should have removed the slot unconditionally")
	}
}

// TestV3_RequestPlay_NonParticipantRejected verifies finding 2: a userID that
// equals HostUserID but is NOT in Participants (e.g. a departed host whose
// sync socket lingered) cannot start playback.
func TestV3_RequestPlay_NonParticipantRejected(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "MPLAY1", 1)

	// Remove the host's participant record while leaving HostUserID == 1.
	ps.mu.Lock()
	delete(ps.Participants, 1)
	ps.mu.Unlock()

	if err := m.HandleRequestPlay("MPLAY1", 1); err == nil {
		t.Fatal("non-participant (stale host id) request-play accepted, want error")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.Running {
		t.Error("party went Running on a non-participant play request")
	}
	if ps.tickCancel != nil {
		t.Error("tick goroutine started on a rejected non-participant play")
	}
}

// TestV3_RequestPause_NonParticipantRejectedEvenWithAllowPause verifies the
// highest-risk variant of finding 2: with Settings.AllowPause=true the host
// check passes for ANY userID, so membership is the only thing standing
// between a former participant and pausing the whole party.
func TestV3_RequestPause_NonParticipantRejectedEvenWithAllowPause(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "MPAUS1", 1)

	// Open pause to all, start running, then have a "former participant"
	// (userID 99, never in Participants) attempt to pause.
	ps.mu.Lock()
	ps.Settings.AllowPause = true
	ps.mu.Unlock()
	if err := m.HandleRequestPlay("MPAUS1", 1); err != nil {
		t.Fatalf("setup play: %v", err)
	}
	defer m.stopTickLoopLocked(ps)

	if err := m.HandleRequestPause("MPAUS1", 99, -1); err == nil {
		t.Fatal("non-participant pause accepted despite AllowPause, want error")
	}
	ps.mu.Lock()
	running := ps.Running
	ps.mu.Unlock()
	if !running {
		t.Error("non-participant managed to pause the party (Running flipped to false)")
	}
}

// TestV3_RequestSeek_NonParticipantRejected mirrors the play case for seek.
func TestV3_RequestSeek_NonParticipantRejected(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "MSEEK1", 1)

	ps.mu.Lock()
	delete(ps.Participants, 1)
	ps.mu.Unlock()

	if err := m.HandleRequestSeek("MSEEK1", 1, 120_000); err == nil {
		t.Fatal("non-participant (stale host id) request-seek accepted, want error")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.AnchorAbsMs == 120_000 {
		t.Error("anchor moved on a rejected non-participant seek")
	}
}

// TestV3_RequestPlay_HostStillWorksAfterGuard is a regression guard: the new
// membership check must NOT break the legitimate host path (the host always
// has a Participant record from JoinPartyV3Room).
func TestV3_RequestPlay_HostStillWorksAfterGuard(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "MPLAY2", 1) // host id 1 IS a participant

	if err := m.HandleRequestPlay("MPLAY2", 1); err != nil {
		t.Fatalf("host request-play rejected after membership guard: %v", err)
	}
	defer m.stopTickLoopLocked(ps)

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if !ps.Running {
		t.Error("host play did not start the party")
	}
}
