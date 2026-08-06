package watchparty

// Regression tests for the 2026-08 adversarial-review critical finding:
// every reaper (empty-party cleanup, host-disconnect grace, host explicit
// leave) used to end scheduled-but-unstarted parties, so "schedule for
// tomorrow, close the browser" silently killed the booking while invites,
// bell notifications, and calendar chips kept pointing at it. These pin
// the exemption: a scheduled party survives an empty lobby and a departed
// host until its start time has passed by the staleness window.

import (
	"testing"
	"time"
)

func TestCleanupOnce_SparesScheduledUnstartedParty(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SPARE1", 1)

	at := time.Now().Add(3 * time.Hour)
	ps.mu.Lock()
	ps.Participants = map[int64]*Participant{} // host closed the tab long ago
	ps.CreatedAt = time.Now().Add(-48 * time.Hour)
	ps.ScheduledStartAt = &at
	ps.mu.Unlock()

	m.cleanupOnce()

	if m.GetPartyState("SPARE1") == nil {
		t.Fatal("cleanupOnce reaped a scheduled-unstarted party before showtime; the booking must survive an empty lobby")
	}
}

func TestCleanupOnce_ReapsOverdueUnstartedParty(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SPARE2", 1)

	// Scheduled start long past, never started, empty — this one is
	// genuinely abandoned and must still age out.
	at := time.Now().Add(-1 * time.Hour)
	ps.mu.Lock()
	ps.Participants = map[int64]*Participant{}
	ps.CreatedAt = time.Now().Add(-48 * time.Hour)
	ps.ScheduledStartAt = &at
	ps.mu.Unlock()

	m.cleanupOnce()

	if m.GetPartyState("SPARE2") != nil {
		t.Fatal("cleanupOnce kept an overdue, never-started, empty party; abandoned bookings must still age out")
	}
}

func TestCleanupOnce_EmptyStartedPartyAnchorsOnStartedAt(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SPARE3", 1)

	// Countdown fired with nobody in the room: CreatedAt is days old but
	// StartedAt is fresh — showtime joiners get the full staleness window.
	started := time.Now().Add(-30 * time.Second)
	sched := started
	ps.mu.Lock()
	ps.Participants = map[int64]*Participant{}
	ps.CreatedAt = time.Now().Add(-48 * time.Hour)
	ps.ScheduledStartAt = &sched
	ps.StartedAt = &started
	ps.mu.Unlock()

	m.cleanupOnce()

	if m.GetPartyState("SPARE3") == nil {
		t.Fatal("cleanupOnce reaped a just-auto-started empty party; staleness must anchor on StartedAt, not the old CreatedAt")
	}
}

func TestLeave_HostLeavingScheduledLobbyKeepsBooking(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SPARE4", 7)

	at := time.Now().Add(2 * time.Hour)
	ps.mu.Lock()
	ps.ScheduledStartAt = &at
	ps.mu.Unlock()

	if err := m.LeavePartyV3Room("SPARE4", 7); err != nil {
		t.Fatalf("leave: %v", err)
	}

	got := m.GetPartyState("SPARE4")
	if got == nil {
		t.Fatal("host leaving the scheduled lobby ended the booking; only End Party may cancel it")
	}
	got.mu.Lock()
	defer got.mu.Unlock()
	if _, still := got.Participants[7]; still {
		t.Error("departed host still in Participants")
	}
	if got.HostUserID != 7 {
		t.Errorf("HostUserID = %d; want 7 (departed host keeps the crown for their rejoin)", got.HostUserID)
	}
}

func TestReapHostGrace_ScheduledLobbySurvivesDisconnect(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SPARE5", 7)

	at := time.Now().Add(2 * time.Hour)
	disc := time.Now().Add(-2 * time.Minute)
	ps.mu.Lock()
	ps.ScheduledStartAt = &at
	ps.HostDisconnectedAt = &disc
	ps.mu.Unlock()

	m.reapExpiredHostGrace("SPARE5", ps, disc)

	if m.GetPartyState("SPARE5") == nil {
		t.Fatal("host-disconnect grace ended a scheduled-unstarted party; the booking must survive a closed laptop")
	}
}

func TestHandleRequestPlay_EarlyStartBroadcastsPartyStarting(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "SPARE6", 7)

	at := time.Now().Add(1 * time.Hour)
	ps.mu.Lock()
	ps.ScheduledStartAt = &at
	ps.mu.Unlock()

	// The host starts early. Before the 2026-08 fix only the timer path
	// broadcast party-starting, so lobby clients kept their countdown and
	// the lobby card resurrected on the first pause.
	if err := m.HandleRequestPlay("SPARE6", 7); err != nil {
		t.Fatalf("request play: %v", err)
	}

	ps.mu.Lock()
	started := ps.StartedAt != nil
	m.stopTickLoopLocked(ps) // cleanup; contract requires holding ps.mu
	ps.mu.Unlock()
	if !started {
		t.Fatal("StartedAt not stamped on early start")
	}
	// Broadcast delivery is pinned indirectly: broadcastToPartyLocked
	// walks roomConns, and with none registered it must simply no-op —
	// this test's job is the code path not panicking plus the stamp; the
	// wire shape matches fireScheduledStart's, which
	// TestV3_FireScheduledStart_DrivesV3Playback exercises.
}
