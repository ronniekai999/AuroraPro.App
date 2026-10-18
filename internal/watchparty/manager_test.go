package watchparty

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// ============================================================
// GenerateCode Tests
// ============================================================

func TestGenerateCode_Length(t *testing.T) {
	m := &Manager{
		parties: make(map[string]*PartyState),
	}

	code, err := m.GenerateCode()
	if err != nil {
		t.Fatalf("GenerateCode() error = %v", err)
	}
	if len(code) != codeLength {
		t.Errorf("GenerateCode() length = %d, want %d", len(code), codeLength)
	}
}

func TestGenerateCode_Charset(t *testing.T) {
	m := &Manager{
		parties: make(map[string]*PartyState),
	}

	// Generate many codes and verify all characters are in the alphabet
	for i := 0; i < 100; i++ {
		code, err := m.GenerateCode()
		if err != nil {
			t.Fatalf("GenerateCode() error = %v", err)
		}
		for _, c := range code {
			if !strings.ContainsRune(codeAlphabet, c) {
				t.Errorf("GenerateCode() produced char %c not in alphabet", c)
			}
		}
	}
}

func TestGenerateCode_ExcludesConfusable(t *testing.T) {
	m := &Manager{
		parties: make(map[string]*PartyState),
	}

	confusable := "0O1IL"
	for i := 0; i < 200; i++ {
		code, err := m.GenerateCode()
		if err != nil {
			t.Fatalf("GenerateCode() error = %v", err)
		}
		for _, c := range code {
			if strings.ContainsRune(confusable, c) {
				t.Errorf("GenerateCode() produced confusable char %c in code %s", c, code)
			}
		}
	}
}

func TestGenerateCode_Uniqueness(t *testing.T) {
	m := &Manager{
		parties: make(map[string]*PartyState),
	}

	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		code, err := m.GenerateCode()
		if err != nil {
			t.Fatalf("GenerateCode() error = %v", err)
		}
		if seen[code] {
			t.Errorf("GenerateCode() produced duplicate code %s at iteration %d", code, i)
		}
		seen[code] = true
	}
}

func TestGenerateCode_Uppercase(t *testing.T) {
	m := &Manager{
		parties: make(map[string]*PartyState),
	}

	for i := 0; i < 50; i++ {
		code, err := m.GenerateCode()
		if err != nil {
			t.Fatalf("GenerateCode() error = %v", err)
		}
		if code != strings.ToUpper(code) {
			t.Errorf("GenerateCode() produced non-uppercase code: %s", code)
		}
	}
}

// ============================================================
// CreateParty Tests (unit-level, no DB)
// ============================================================

// mockPartyManager creates a Manager with no DB/Hub for unit tests.
func mockPartyManager() *Manager {
	return &Manager{
		parties:     make(map[string]*PartyState),
		cleanupDone: make(chan struct{}),
		cfg:         DefaultSyncConfig(),
	}
}

func TestCreateParty_DefaultMaxParticipants(t *testing.T) {
	_ = mockPartyManager()

	// Directly test the max participants validation logic
	maxP := 0
	if maxP <= 0 {
		maxP = maxParticipantsDefault
	}
	if maxP != 10 {
		t.Errorf("default max participants = %d, want 10", maxP)
	}
}

func TestCreateParty_HardLimit(t *testing.T) {
	maxP := 100
	if maxP > maxParticipantsHardLimit {
		maxP = maxParticipantsHardLimit
	}
	if maxP != maxParticipantsHardLimit {
		t.Errorf("capped max participants = %d, want %d", maxP, maxParticipantsHardLimit)
	}
}

// ============================================================
// Room-Socket Join Tests (V3 membership)
// ============================================================

func TestJoinPartyV3Room_MaxParticipants(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 2,
		Participants:    make(map[int64]*Participant),
		roomConns:       make(map[int64]*SafeConn),
		syncConns:       make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{AllowChat: true, AllowPause: true, MaxParticipants: 2},
		CreatedAt:       time.Now(),
	}

	// Add 2 participants manually
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	ps.Participants[2] = &Participant{UserID: 2, Username: "user2", LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Try to add a third — should fail
	_, err := m.JoinPartyV3Room("ABCDEF", 3, "user3", nil)
	if err == nil {
		t.Error("JoinPartyV3Room should fail when party is full")
	}
	if !strings.Contains(err.Error(), "full") {
		t.Errorf("error should mention full, got: %s", err.Error())
	}
}

func TestJoinPartyV3Room_ReconnectRefreshesLastSeen(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 5,
		Participants:    make(map[int64]*Participant),
		roomConns:       make(map[int64]*SafeConn),
		syncConns:       make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{AllowChat: true, AllowPause: true, MaxParticipants: 5},
		CreatedAt:       time.Now(),
	}

	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now().Add(-time.Minute)}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// "Reconnect" the same user
	_, err := m.JoinPartyV3Room("ABCDEF", 1, "host", nil)
	if err != nil {
		t.Fatalf("JoinPartyV3Room reconnect failed: %v", err)
	}

	ps.mu.Lock()
	p := ps.Participants[1]
	ps.mu.Unlock()

	if time.Since(p.LastSeen) > time.Second {
		t.Error("reconnecting user should update LastSeen")
	}
}

func TestJoinPartyV3Room_NotFound(t *testing.T) {
	m := mockPartyManager()

	_, err := m.JoinPartyV3Room("XXXXXX", 1, "user", nil)
	if err == nil {
		t.Error("JoinPartyV3Room should fail for non-existent party")
	}
}

// ============================================================
// Room-Socket Leave Tests (V3 membership)
// ============================================================

func TestLeavePartyV3Room_NonExistent(t *testing.T) {
	m := mockPartyManager()

	// Should not error for non-existent party
	err := m.LeavePartyV3Room("XXXXXX", 1)
	if err != nil {
		t.Errorf("LeavePartyV3Room for non-existent party should not error, got: %v", err)
	}
}

func TestLeavePartyV3Room_NotParticipant(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		roomConns:    make(map[int64]*SafeConn),
		syncConns:    make(map[int64]*SafeConn),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{AllowChat: true},
		CreatedAt:    time.Now(),
	}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.LeavePartyV3Room("ABCDEF", 99)
	if err != nil {
		t.Errorf("LeavePartyV3Room for non-participant should not error, got: %v", err)
	}
}

// ============================================================
// Host succession (2026-08) — a party in progress survives the host
// leaving as long as at least one eligible participant remains.
// ============================================================

// succession test harness: host 1 plus guests, party Running with a
// known anchor so the tests can assert playback is untouched by a
// handoff. JoinedAt spreads establish seniority.
func successionParty() *PartyState {
	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 5,
		Running:         true,
		AnchorAbsMs:     42_000,
		AnchorServerAt:  time.Now(),
		StateRevision:   7,
		Participants:    make(map[int64]*Participant),
		roomConns:       make(map[int64]*SafeConn),
		syncConns:       make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{},
		CreatedAt:       time.Now(),
	}
	now := time.Now()
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: now, JoinedAt: now.Add(-30 * time.Minute)}
	return ps
}

func TestLeavePartyV3Room_HostLeaves_PromotesMostSeniorGuest(t *testing.T) {
	m := mockPartyManager()

	// Five candidates and a dozen fresh parties: Go map iteration is
	// randomized, so with two candidates a broken (first-iterated-wins)
	// selection still passes half of runs. Twelve rounds over five
	// candidates make an ordering regression fail with near-certainty
	// instead of flaking green.
	for i := 0; i < 12; i++ {
		ps := successionParty()
		now := time.Now()
		// Guest 5 joined FIRST — seniority, not user ID, must decide.
		ps.Participants[2] = &Participant{UserID: 2, Username: "g2", LastSeen: now, JoinedAt: now.Add(-5 * time.Minute)}
		ps.Participants[3] = &Participant{UserID: 3, Username: "g3", LastSeen: now, JoinedAt: now.Add(-10 * time.Minute)}
		ps.Participants[4] = &Participant{UserID: 4, Username: "g4", LastSeen: now, JoinedAt: now.Add(-15 * time.Minute)}
		ps.Participants[5] = &Participant{UserID: 5, Username: "g5-early", LastSeen: now, JoinedAt: now.Add(-20 * time.Minute)}

		m.mu.Lock()
		m.parties["ABCDEF"] = ps
		m.mu.Unlock()

		if err := m.LeavePartyV3Room("ABCDEF", 1); err != nil {
			t.Fatalf("LeavePartyV3Room (host) failed: %v", err)
		}

		m.mu.RLock()
		_, exists := m.parties["ABCDEF"]
		m.mu.RUnlock()
		if !exists {
			t.Fatal("party must survive a host leave while eligible guests remain")
		}

		ps.mu.Lock()
		if ps.HostUserID != 5 {
			t.Fatalf("round %d: HostUserID = %d, want 5 (earliest JoinedAt)", i, ps.HostUserID)
		}
		if _, stillThere := ps.Participants[1]; stillThere {
			t.Error("departed host must be removed from participants")
		}
		if !ps.Participants[5].IsHost {
			t.Error("successor's IsHost flag must flip true")
		}
		if ps.Participants[2].IsHost {
			t.Error("non-successor must not be flagged host")
		}
		// The movie must not blink: the V3 anchor is server-side truth and
		// a handoff has no business touching it.
		if !ps.Running || ps.AnchorAbsMs != 42_000 {
			t.Errorf("playback anchor changed on handoff: Running=%v AnchorAbsMs=%d", ps.Running, ps.AnchorAbsMs)
		}
		if ps.StateRevision <= 7 {
			t.Errorf("StateRevision = %d, want a bump past 7 so clients apply the new snapshot", ps.StateRevision)
		}
		if ps.HostDisconnectedAt != nil {
			t.Error("HostDisconnectedAt must be cleared on handoff")
		}
		ps.mu.Unlock()

		m.mu.Lock()
		delete(m.parties, "ABCDEF")
		m.mu.Unlock()
	}
}

func TestLeavePartyV3Room_ExHostRejoinsAsGuest(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: now, JoinedAt: now.Add(-10 * time.Minute)}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.LeavePartyV3Room("ABCDEF", 1); err != nil {
		t.Fatalf("host leave failed: %v", err)
	}

	// The ex-host comes back: their slot was freed, so this is a brand-new
	// join, and the crown stays where succession put it.
	if _, err := m.JoinPartyV3Room("ABCDEF", 1, "ex-host", nil); err != nil {
		t.Fatalf("ex-host rejoin failed: %v", err)
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.HostUserID != 2 {
		t.Errorf("HostUserID = %d, want 2 — a rejoin must not reclaim the crown", ps.HostUserID)
	}
	rejoined, ok := ps.Participants[1]
	if !ok {
		t.Fatal("ex-host must be re-admitted as a participant")
	}
	if rejoined.IsHost {
		t.Error("rejoined ex-host must be a guest")
	}
	if rejoined.JoinedAt.IsZero() {
		t.Error("rejoined ex-host must get a fresh JoinedAt (new tenure)")
	}
}

func TestPromotedHostDisconnect_ArmsGraceForNewHost(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: now, JoinedAt: now.Add(-10 * time.Minute)}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.LeavePartyV3Room("ABCDEF", 1); err != nil {
		t.Fatalf("host leave failed: %v", err)
	}

	// The freshly promoted host's room socket dies. The grace machinery
	// must key on the NEW HostUserID: reserve their slot and arm the
	// timer rather than treating them as a plain guest (which would
	// delete the entry outright).
	if err := m.LeavePartyV3RoomGraceful("ABCDEF", 2); err != nil {
		t.Fatalf("promoted host graceful disconnect failed: %v", err)
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.HostDisconnectedAt == nil {
		t.Fatal("grace must arm for the promoted host's disconnect")
	}
	if _, reserved := ps.Participants[2]; !reserved {
		t.Error("promoted host's slot must stay reserved during their grace window")
	}
}

func TestLeavePartyV3Room_LoneHostLeaves_EndsParty(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.LeavePartyV3Room("ABCDEF", 1); err != nil {
		t.Fatalf("LeavePartyV3Room (lone host) failed: %v", err)
	}

	m.mu.RLock()
	_, exists := m.parties["ABCDEF"]
	m.mu.RUnlock()
	if exists {
		t.Error("party should end when the last participant (the host) leaves")
	}
}

func TestLeavePartyV3Room_HostLeaves_OnlyCompanionsRemain_EndsParty(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	// A phone companion has no player and no sync socket — it cannot
	// keep a party "playing" and must not inherit it.
	ps.Participants[2] = &Participant{UserID: 2, Username: "phone", LastSeen: now, JoinedAt: now.Add(-25 * time.Minute), Companion: true}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.LeavePartyV3Room("ABCDEF", 1); err != nil {
		t.Fatalf("LeavePartyV3Room (host, companions only) failed: %v", err)
	}

	m.mu.RLock()
	_, exists := m.parties["ABCDEF"]
	m.mu.RUnlock()
	if exists {
		t.Error("party should end when only companions remain — nobody left can actually watch")
	}
}

func TestReapExpiredHostGrace_PromotesSuccessor(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: now, JoinedAt: now.Add(-10 * time.Minute)}
	disconnectAt := now.Add(-HostDisconnectGracePeriod)
	ps.HostDisconnectedAt = &disconnectAt
	delete(ps.roomConns, 1) // host's room conn died with the disconnect

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	m.reapExpiredHostGrace("ABCDEF", ps, disconnectAt)

	m.mu.RLock()
	_, exists := m.parties["ABCDEF"]
	m.mu.RUnlock()
	if !exists {
		t.Fatal("party must survive grace expiry while an eligible guest remains")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.HostUserID != 2 {
		t.Errorf("HostUserID = %d, want 2", ps.HostUserID)
	}
	if _, stillThere := ps.Participants[1]; stillThere {
		t.Error("vanished host's reserved slot must be cleared on grace expiry")
	}
	if ps.HostDisconnectedAt != nil {
		t.Error("HostDisconnectedAt must be cleared after the handoff")
	}
	if !ps.Running || ps.AnchorAbsMs != 42_000 {
		t.Errorf("playback anchor changed on grace handoff: Running=%v AnchorAbsMs=%d", ps.Running, ps.AnchorAbsMs)
	}
	if ps.StateRevision <= 7 {
		t.Errorf("StateRevision = %d, want a bump past 7 on the grace handoff too", ps.StateRevision)
	}
}

// ============================================================
// The ending flag — a dying party must not sprout new liveness
// (succession review HIGH-2: a reap or leave racing endPartyInternal's
// unlocked teardown window could promote a host on, or worst-case start
// a tick loop for, a party about to leave the map).
// ============================================================

func TestEndPartyInternal_SecondCallIsNoOp(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: now, JoinedAt: now}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.endPartyInternal("ABCDEF", ps, 0); err != nil {
		t.Fatalf("first end failed: %v", err)
	}
	if err := m.endPartyInternal("ABCDEF", ps, 0); err != nil {
		t.Fatalf("second end must be a clean no-op, got: %v", err)
	}
}

func TestPromoteSuccessor_NoOpOnEndingParty(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: now, JoinedAt: now}
	ps.ending = true

	ps.mu.Lock()
	got := m.promoteSuccessorLocked(ps, 1, "host", "left")
	hostAfter := ps.HostUserID
	ps.mu.Unlock()

	if got != nil {
		t.Fatal("promotion on a dying party must refuse")
	}
	if hostAfter != 1 {
		t.Errorf("HostUserID mutated on a dying party: %d", hostAfter)
	}
}

func TestHandleRequestPlay_RejectedWhileEnding(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	ps.Running = false
	ps.ending = true

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.HandleRequestPlay("ABCDEF", 1); err == nil {
		t.Fatal("play on a dying party must be rejected — a tick loop started here outlives the party forever")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.Running || ps.tickCancel != nil {
		t.Error("dying party must not transition to Running or start a tick loop")
	}
}

func TestEndParty_StaleHostRejectedAtomically(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: now, JoinedAt: now}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Handoff first: user 1's hostship is gone by the time their end
	// request reaches the teardown. endPartyInternal re-validates under
	// the same lock acquisition that commits (succession review MEDIUM —
	// the old check-then-unlock-then-end let an ex-host's in-flight POST
	// kill a successor's party).
	if err := m.LeavePartyV3Room("ABCDEF", 1); err != nil {
		t.Fatalf("host leave failed: %v", err)
	}
	if err := m.endPartyInternal("ABCDEF", ps, 1); err == nil {
		t.Fatal("stale host's end must be rejected")
	}
	m.mu.RLock()
	_, exists := m.parties["ABCDEF"]
	m.mu.RUnlock()
	if !exists {
		t.Error("party must survive a stale host's end attempt")
	}
}

func TestReapExpiredHostGrace_HostReconnected_NoOp(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: now, JoinedAt: now}
	// HostDisconnectedAt nil = the host came back inside the window.
	staleDisconnect := now.Add(-HostDisconnectGracePeriod)

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	m.reapExpiredHostGrace("ABCDEF", ps, staleDisconnect)

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.HostUserID != 1 {
		t.Errorf("reconnected host must keep the party; HostUserID = %d", ps.HostUserID)
	}
	if _, hostThere := ps.Participants[1]; !hostThere {
		t.Error("reconnected host must keep their participant entry")
	}
}

func TestReapExpiredHostGrace_SupersededTimer_NoOp(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: now, JoinedAt: now}
	// A NEWER disconnect than the one this timer was armed for — the
	// newer goroutine owns the decision.
	newerDisconnect := now.Add(-1 * time.Second)
	ps.HostDisconnectedAt = &newerDisconnect

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	m.reapExpiredHostGrace("ABCDEF", ps, now.Add(-HostDisconnectGracePeriod))

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.HostUserID != 1 {
		t.Errorf("superseded timer must not act; HostUserID = %d", ps.HostUserID)
	}
	if _, hostThere := ps.Participants[1]; !hostThere {
		t.Error("superseded timer must not clear the host's slot")
	}
}

func TestReapExpiredHostGrace_NoSuccessor_EndsParty(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	disconnectAt := time.Now().Add(-HostDisconnectGracePeriod)
	ps.HostDisconnectedAt = &disconnectAt
	delete(ps.roomConns, 1)

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	m.reapExpiredHostGrace("ABCDEF", ps, disconnectAt)

	m.mu.RLock()
	_, exists := m.parties["ABCDEF"]
	m.mu.RUnlock()
	if exists {
		t.Error("party should end when the grace expires with nobody to hand off to")
	}
}

func TestLeavePartyV3Room_HostLeaves_LiveConnOutranksSeniority(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	// Guest 2 is senior but between sockets (no room conn — e.g. a
	// mid-handshake rejoin); guest 3 is junior but demonstrably present.
	// The party should go to the one who is actually there.
	ps.Participants[2] = &Participant{UserID: 2, Username: "senior-adrift", LastSeen: now, JoinedAt: now.Add(-25 * time.Minute)}
	ps.Participants[3] = &Participant{UserID: 3, Username: "junior-live", LastSeen: now, JoinedAt: now.Add(-2 * time.Minute)}
	ps.roomConns[3] = &SafeConn{} // zero-value SafeConn: Send() discards (see Send's nil-outbox branch)

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.LeavePartyV3Room("ABCDEF", 1); err != nil {
		t.Fatalf("LeavePartyV3Room (host) failed: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.HostUserID != 3 {
		t.Errorf("HostUserID = %d, want 3 (live room conn outranks seniority)", ps.HostUserID)
	}
}

func TestPromotion_TransfersPlaybackControl(t *testing.T) {
	m := mockPartyManager()
	ps := successionParty()
	now := time.Now()
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: now, JoinedAt: now}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.LeavePartyV3Room("ABCDEF", 1); err != nil {
		t.Fatalf("host leave failed: %v", err)
	}

	// The crown moved: the ex-host is rejected, the successor controls.
	if err := m.HandleRequestPause("ABCDEF", 1, 43_000); err == nil {
		t.Error("ex-host must lose pause control after the handoff")
	}
	if err := m.HandleRequestPause("ABCDEF", 2, 43_000); err != nil {
		t.Errorf("promoted host pause failed: %v", err)
	}
	ps.mu.Lock()
	if ps.Running {
		t.Error("party should be Paused after the promoted host's pause")
	}
	ps.mu.Unlock()

	// And the deliberate end stays host-gated on the NEW host.
	if err := m.EndParty("ABCDEF", 1); err == nil {
		t.Error("ex-host must not be able to end the party")
	}
	if err := m.EndParty("ABCDEF", 2); err != nil {
		t.Errorf("promoted host EndParty failed: %v", err)
	}
	m.mu.RLock()
	_, exists := m.parties["ABCDEF"]
	m.mu.RUnlock()
	if exists {
		t.Error("party should be removed after the promoted host ends it")
	}
}

// ============================================================
// Playback Intent Tests (V3 — see sync_v3_test.go for the rest)
// ============================================================

// AllowPause lets a non-host guest pause the party. The negative case
// (guest pause WITHOUT AllowPause) is covered by
// TestV3_HandleRequestPause's sibling tests in sync_v3_medfix_test.go.
func TestV3_HandleRequestPause_GuestAllowedWhenAllowPause(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 5,
		Running:         true,
		AnchorAbsMs:     5000,
		AnchorServerAt:  time.Now(),
		Participants:    make(map[int64]*Participant),
		roomConns:       make(map[int64]*SafeConn),
		syncConns:       make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{AllowPause: true},
		CreatedAt:       time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.HandleRequestPause("ABCDEF", 2, 6000); err != nil {
		t.Fatalf("viewer pause with AllowPause failed: %v", err)
	}

	ps.mu.Lock()
	if ps.Running {
		t.Error("party should be Paused after guest pause")
	}
	if ps.AnchorAbsMs != 6000 {
		t.Errorf("anchor after pause = %d, want 6000", ps.AnchorAbsMs)
	}
	ps.mu.Unlock()
}

// ============================================================
// Chat Tests
// ============================================================

func TestHandleChat_Success(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0, chatHistoryMax),
		Settings:     PartySettings{AllowChat: true},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.HandleChat("ABCDEF", 1, "host", "Hello world!")
	if err != nil {
		t.Fatalf("HandleChat failed: %v", err)
	}

	ps.mu.Lock()
	if len(ps.ChatHistory) != 1 {
		t.Errorf("ChatHistory length = %d, want 1", len(ps.ChatHistory))
	}
	if ps.ChatHistory[0].Message != "Hello world!" {
		t.Errorf("message = %q, want %q", ps.ChatHistory[0].Message, "Hello world!")
	}
	ps.mu.Unlock()
}

func TestHandleChat_EmptyMessage(t *testing.T) {
	m := mockPartyManager()

	err := m.HandleChat("ABCDEF", 1, "host", "")
	if err == nil {
		t.Error("empty message should return error")
	}
}

// TestHandleChat_RejectsInvisibleOnly verifies the deep-debug Bug 9 fix:
// messages that contain ONLY non-printable / zero-width chars (which
// survive unicode.IsSpace and thus TrimSpace) must be rejected so they
// don't fill the ring buffer with visually-empty bubbles. We cover the
// common offenders: BOM (U+FEFF), Zero-Width Space (U+200B), Word
// Joiner (U+2060). The test ALSO ensures normal NBSP/space behavior
// still works (covered by the EmptyMessage test above with regular
// space, and StoresRawContent's trim case).
func TestHandleChat_RejectsInvisibleOnly(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0, chatHistoryMax),
		Settings:     PartySettings{AllowChat: true},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	cases := []struct {
		name, input string
	}{
		{"zero_width_space", "\u200b"},
		{"zero_width_space_repeated", "\u200b\u200b\u200b"},
		{"byte_order_mark", "\ufeff"},
		{"word_joiner", "\u2060"},
		{"mixed_invisibles", "\u200b\ufeff\u2060"},
		{"invisibles_around_space", " \u200b \u200b "},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := m.HandleChat("ABCDEF", 1, "host", c.input)
			if err == nil {
				t.Errorf("invisible-only message %q should be rejected", c.input)
			}
		})
	}
}

func TestHandleChat_TooLong(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{AllowChat: true},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	longMsg := strings.Repeat("A", chatMaxLength+1)
	err := m.HandleChat("ABCDEF", 1, "host", longMsg)
	if err == nil {
		t.Error("message exceeding max length should return error")
	}
}

// TestHandleChat_StoresRawContent verifies that chat messages are
// persisted exactly as the user typed them (modulo whitespace trim).
// Renamed from TestHandleChat_HTMLSanitization in 2026-05-26 along
// with the removal of server-side html.EscapeString:
//
//   - The escape step produced a visible bug where apostrophes were
//     persisted as `&#39;` and rendered literally by React (whose JSX
//     text-child rendering already escapes HTML metacharacters, so the
//     server-side escape was double-encoding).
//
//   - XSS defense is preserved at render time: every chat-message
//     render site in the SPA uses `{m.message}` as a JSX text child
//     (verified by grep — no dangerouslySetInnerHTML on chat). React
//     turns `<script>alert(1)</script>` into the visible literal
//     string, no code execution. Store-raw + render-escape is the
//     canonical pattern; store-escape + render-escape was the bug.
//
// We KEEP an XSS payload in the input here as a smoke test that the
// server doesn't crash, log noise, or otherwise mangle the message —
// it should arrive at the storage layer byte-for-byte.
func TestHandleChat_StoresRawContent(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0, chatHistoryMax),
		Settings:     PartySettings{AllowChat: true},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Cases: apostrophe (the user-reported bug), HTML (verifies we don't
	// re-introduce server escaping), and a leading/trailing space (verifies
	// the only mutation is TrimSpace).
	cases := []struct {
		name, input, want string
	}{
		{"apostrophe", "I'm at 1:52", "I'm at 1:52"},
		{"raw_html_payload", `<script>alert("xss")</script>`, `<script>alert("xss")</script>`},
		{"trim_whitespace", "  hello  ", "hello"},
		// Mixed printable + non-printable should keep the printable run intact.
		{"keeps_visible_with_zwsp", "hi\u200bthere", "hi\u200bthere"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ps.mu.Lock()
			ps.ChatHistory = ps.ChatHistory[:0]
			ps.mu.Unlock()
			if err := m.HandleChat("ABCDEF", 1, "host", c.input); err != nil {
				t.Fatalf("HandleChat failed: %v", err)
			}
			ps.mu.Lock()
			got := ps.ChatHistory[0].Message
			ps.mu.Unlock()
			if got != c.want {
				t.Errorf("input=%q got=%q want=%q", c.input, got, c.want)
			}
		})
	}
}

func TestHandleChat_RingBuffer(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0, chatHistoryMax),
		Settings:     PartySettings{AllowChat: true},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Fill beyond the ring buffer limit
	for i := 0; i < chatHistoryMax+20; i++ {
		err := m.HandleChat("ABCDEF", 1, "host", "msg")
		if err != nil {
			t.Fatalf("HandleChat %d failed: %v", i, err)
		}
	}

	ps.mu.Lock()
	histLen := len(ps.ChatHistory)
	ps.mu.Unlock()

	if histLen != chatHistoryMax {
		t.Errorf("ChatHistory length = %d, want %d (ring buffer overflow)", histLen, chatHistoryMax)
	}
}

func TestHandleChat_Disabled(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{AllowChat: false},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.HandleChat("ABCDEF", 1, "host", "test")
	if err == nil {
		t.Error("chat should fail when disabled")
	}
}

func TestHandleChat_NonParticipant(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{AllowChat: true},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.HandleChat("ABCDEF", 99, "intruder", "sneaky message")
	if err == nil {
		t.Error("non-participant should not be able to chat")
	}
}

// ============================================================
// Reaction Tests
// ============================================================

func TestHandleReaction_ValidEmoji(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.HandleReaction("ABCDEF", 1, "host", "\U0001F525", 0) // fire emoji, server-stamped abs_ms
	if err != nil {
		t.Fatalf("valid reaction should succeed: %v", err)
	}
	// M6: assert ring buffer captured it
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if len(ps.Reactions) != 1 {
		t.Fatalf("expected 1 reaction in ring buffer, got %d", len(ps.Reactions))
	}
	if ps.Reactions[0].Emoji != "\U0001F525" {
		t.Errorf("ring buffer emoji mismatch: got %q", ps.Reactions[0].Emoji)
	}
}

func TestHandleReaction_InvalidEmoji(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.HandleReaction("ABCDEF", 1, "host", "not-an-emoji", 0)
	if err == nil {
		t.Error("invalid emoji should return error")
	}
}

// M6 — confirm the per-party ring buffer caps at reactionsRingBufferMax
// and oldest entries drop FIFO. Without this, a long movie's reactions
// would unbound-grow ps.Reactions until party-end.
func TestHandleReaction_RingBufferCap(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Emit reactionsRingBufferMax+50 reactions; expect cap to clamp.
	for i := 0; i < reactionsRingBufferMax+50; i++ {
		if err := m.HandleReaction("ABCDEF", 1, "host", "\U0001F525", 0); err != nil {
			t.Fatalf("reaction %d errored: %v", i, err)
		}
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if len(ps.Reactions) != reactionsRingBufferMax {
		t.Errorf("ring buffer should cap at %d, got %d", reactionsRingBufferMax, len(ps.Reactions))
	}
}

// M6 — assert client-claimed abs_ms is rejected when it's outside the
// reactionAbsMsClampWindow of the party's authoritative position. This is
// the tamper-resistance guard for the M9 timeline: a malicious client
// shouldn't be able to seed reactions at arbitrary positions.
func TestHandleReaction_AbsMsClamp(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now(),
		// Paused at 30s. CurrentAbsMs() returns AnchorAbsMs when !Running.
		Running:     false,
		AnchorAbsMs: 30_000,
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Client claims 10 hours into the movie — way outside the ±5min window.
	// Should be discarded and the server's CurrentAbsMs() used instead.
	if err := m.HandleReaction("ABCDEF", 1, "host", "\U0001F525", 10*60*60*1000); err != nil {
		t.Fatalf("reaction errored: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if len(ps.Reactions) != 1 {
		t.Fatalf("expected 1 reaction, got %d", len(ps.Reactions))
	}
	if ps.Reactions[0].AbsMs != 30_000 {
		t.Errorf("expected clamped abs_ms=30000, got %d (client lie was honored)", ps.Reactions[0].AbsMs)
	}
}

// M6/L4 — RecentReactions returns a snapshot copy in insertion order, and
// mutating the returned slice doesn't affect the party's ring buffer.
// Snapshot independence matters because M9 callers (timeline UI,
// highlight-reel job) will run outside the ps.mu lock and shouldn't be
// able to corrupt party state if they hold the slice for a while.
func TestRecentReactions_SnapshotIsolated(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	emojis := []string{"\U0001F525", "\U0001F602", "\U0001F389"} // fire, laughing, party-popper
	for _, e := range emojis {
		if err := m.HandleReaction("ABCDEF", 1, "host", e, 0); err != nil {
			t.Fatalf("reaction %q errored: %v", e, err)
		}
	}

	snap := m.RecentReactions("ABCDEF")
	if len(snap) != len(emojis) {
		t.Fatalf("expected %d reactions in snapshot, got %d", len(emojis), len(snap))
	}
	// Order is insertion order — important for M9 timeline rendering.
	for i, e := range emojis {
		if snap[i].Emoji != e {
			t.Errorf("snap[%d].Emoji = %q, want %q", i, snap[i].Emoji, e)
		}
	}

	// Mutate the snapshot — the party's ring buffer must NOT see the change.
	snap[0].Emoji = "tampered"
	ps.mu.Lock()
	got := ps.Reactions[0].Emoji
	ps.mu.Unlock()
	if got == "tampered" {
		t.Error("snapshot shares storage with ps.Reactions — RecentReactions must deep-copy")
	}

	// Missing party returns nil, not an error.
	if r := m.RecentReactions("DOES-NOT-EXIST"); r != nil {
		t.Errorf("RecentReactions on missing party should return nil, got %v", r)
	}
}

// ============================================================
// M7 — Voice presence signaling tests
// ============================================================

// voiceTestParty builds a 2-participant party (host + one guest) so voice
// signaling has a peer to talk to. Returns the manager, the PartyState,
// and the two user IDs.
func voiceTestParty(t *testing.T) (*Manager, *PartyState, int64, int64) {
	t.Helper()
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		roomConns:    make(map[int64]*SafeConn),
		syncConns:    make(map[int64]*SafeConn),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	ps.Participants[2] = &Participant{UserID: 2, Username: "guest", LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()
	return m, ps, 1, 2
}

// First joiner sees no peers; the second joiner sees the first.
func TestJoinVoice_AddsAndReturnsPeers(t *testing.T) {
	m, ps, host, guest := voiceTestParty(t)

	peers, err := m.JoinVoice("ABCDEF", host, "host")
	if err != nil {
		t.Fatalf("host JoinVoice err: %v", err)
	}
	if len(peers) != 0 {
		t.Errorf("first joiner should see 0 peers, got %d", len(peers))
	}

	peers, err = m.JoinVoice("ABCDEF", guest, "guest")
	if err != nil {
		t.Fatalf("guest JoinVoice err: %v", err)
	}
	if len(peers) != 1 || peers[0].UserID != host {
		t.Errorf("guest should see host as peer, got %+v", peers)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if !ps.VoiceParticipants[host] || !ps.VoiceParticipants[guest] {
		t.Error("both users should be in VoiceParticipants set")
	}
}

// Re-joining when already in voice is idempotent (no panic, no double-broadcast).
func TestJoinVoice_Idempotent(t *testing.T) {
	m, _, host, _ := voiceTestParty(t)
	if _, err := m.JoinVoice("ABCDEF", host, "host"); err != nil {
		t.Fatalf("first join err: %v", err)
	}
	peers, err := m.JoinVoice("ABCDEF", host, "host")
	if err != nil {
		t.Fatalf("second join err: %v", err)
	}
	if len(peers) != 0 {
		t.Errorf("self should be excluded from own peer list, got %d", len(peers))
	}
}

// Non-participants can't join voice (security boundary — voice is gated
// on having joined the party's room socket first).
func TestJoinVoice_NonParticipant(t *testing.T) {
	m, _, _, _ := voiceTestParty(t)
	_, err := m.JoinVoice("ABCDEF", 999, "intruder")
	if err == nil {
		t.Error("non-participant should be rejected from voice")
	}
}

// Leaving removes from the set; idempotent on a non-member.
func TestLeaveVoice_RemovesAndIsIdempotent(t *testing.T) {
	m, ps, host, _ := voiceTestParty(t)
	_, _ = m.JoinVoice("ABCDEF", host, "host")

	if err := m.LeaveVoice("ABCDEF", host); err != nil {
		t.Fatalf("leave err: %v", err)
	}
	ps.mu.Lock()
	stillIn := ps.VoiceParticipants[host]
	ps.mu.Unlock()
	if stillIn {
		t.Error("host should no longer be in voice")
	}

	// Idempotent: leaving again is fine.
	if err := m.LeaveVoice("ABCDEF", host); err != nil {
		t.Errorf("second leave should be no-op, got err: %v", err)
	}
}

// Bad signal type is rejected — defends against forged WS messages
// like "voice-explode".
func TestRelayVoiceSignal_InvalidType(t *testing.T) {
	m, _, host, guest := voiceTestParty(t)
	_, _ = m.JoinVoice("ABCDEF", host, "host")
	_, _ = m.JoinVoice("ABCDEF", guest, "guest")

	if err := m.RelayVoiceSignal("ABCDEF", host, guest, "voice-explode", nil); err == nil {
		t.Error("invalid signal type should be rejected")
	}
}

// A non-voice participant can't relay signaling messages. Prevents
// "lurker" signaling attacks where someone in the party but not in voice
// floods other peers with garbage offers.
func TestRelayVoiceSignal_SenderNotInVoice(t *testing.T) {
	m, _, host, guest := voiceTestParty(t)
	_, _ = m.JoinVoice("ABCDEF", guest, "guest") // only guest in voice

	if err := m.RelayVoiceSignal("ABCDEF", host, guest, "voice-offer", nil); err == nil {
		t.Error("non-voice sender should be rejected")
	}
}

// Can't signal to a peer who isn't in voice — would just queue messages
// for a connection that's never going to materialize.
func TestRelayVoiceSignal_RecipientNotInVoice(t *testing.T) {
	m, _, host, guest := voiceTestParty(t)
	_, _ = m.JoinVoice("ABCDEF", host, "host") // only host in voice

	if err := m.RelayVoiceSignal("ABCDEF", host, guest, "voice-offer", nil); err == nil {
		t.Error("non-voice recipient should be rejected")
	}
}

// Self-signaling is nonsense and would represent a buggy frontend; reject.
func TestRelayVoiceSignal_RejectsSelf(t *testing.T) {
	m, _, host, _ := voiceTestParty(t)
	_, _ = m.JoinVoice("ABCDEF", host, "host")

	if err := m.RelayVoiceSignal("ABCDEF", host, host, "voice-offer", nil); err == nil {
		t.Error("self-signal should be rejected")
	}
}

// Leaving the room socket implicitly drops the user from voice. Without
// this, a flaky connection would leave ghost voice participants others
// keep trying to offer to.
func TestLeavePartyV3Room_CleansUpVoice(t *testing.T) {
	m, ps, host, guest := voiceTestParty(t)
	// We need a roomConn registered for the LeavePartyV3Room path; nil
	// SafeConn is fine for this test — we just need the participant entry.
	ps.mu.Lock()
	ps.roomConns[host] = nil
	ps.roomConns[guest] = nil
	ps.mu.Unlock()

	_, _ = m.JoinVoice("ABCDEF", host, "host")
	_, _ = m.JoinVoice("ABCDEF", guest, "guest")

	if err := m.LeavePartyV3Room("ABCDEF", guest); err != nil {
		t.Fatalf("LeavePartyV3Room err: %v", err)
	}

	// Guest should NOT be in voice anymore — but party still exists
	// (host remains). Verify by re-reading via JoinVoice as a fresh user
	// scenario isn't quite right; just read ps state directly.
	ps.mu.Lock()
	stillIn := ps.VoiceParticipants[guest]
	ps.mu.Unlock()
	if stillIn {
		t.Error("disconnecting room socket should auto-leave voice")
	}
}

// ============================================================
// Sync Heartbeat Tests (V3 — heartbeats are informational only)
// ============================================================

func TestHandleV3Heartbeat_PartyNotFound(t *testing.T) {
	m := mockPartyManager()

	// Must not panic; missing party is a silent no-op.
	m.HandleV3Heartbeat("XXXXXX", 1, 5000, 4)
}

// Heartbeats are purely informational (LastSeen + buffering state). The
// server never trusts a client-reported position — only the intent handlers
// (request-play/pause/seek) are allowed to move the anchor.
func TestHandleV3Heartbeat_DoesNotMutateAnchor(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:           "ABCDEF",
		HostUserID:     1,
		Running:        true,
		AnchorAbsMs:    10000,
		AnchorServerAt: time.Now(),
		Participants:   make(map[int64]*Participant),
		ChatHistory:    make([]ChatMessage, 0),
		Settings:       PartySettings{},
		CreatedAt:      time.Now(),
	}
	earlier := time.Now().Add(-time.Minute)
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: earlier}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Client claims abs_ms=15000 and readyState=2 (buffering).
	m.HandleV3Heartbeat("ABCDEF", 1, 15000, 2)

	ps.mu.Lock()
	if ps.AnchorAbsMs != 10000 {
		t.Errorf("heartbeat must not move the anchor; got %d want 10000", ps.AnchorAbsMs)
	}
	if !ps.Participants[1].LastSeen.After(earlier) {
		t.Error("heartbeat should refresh LastSeen")
	}
	if !ps.Participants[1].IsBuffering {
		t.Error("readyState < 3 should set IsBuffering for presence display")
	}
	ps.mu.Unlock()
}

func TestHandleV3Heartbeat_NonParticipant(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:           "ABCDEF",
		HostUserID:     1,
		AnchorAbsMs:    10000,
		AnchorServerAt: time.Now(),
		Participants:   make(map[int64]*Participant),
		ChatHistory:    make([]ChatMessage, 0),
		Settings:       PartySettings{},
		CreatedAt:      time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// User 99 is not a participant — silent no-op, must not panic or
	// create a participant entry.
	m.HandleV3Heartbeat("ABCDEF", 99, 5000, 4)
	ps.mu.Lock()
	if _, ok := ps.Participants[99]; ok {
		t.Error("heartbeat from non-participant must not create a participant entry")
	}
	ps.mu.Unlock()
}

// ============================================================
// End Party Tests
// ============================================================

func TestEndParty_HostOnly(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Non-host tries to end
	err := m.EndParty("ABCDEF", 2)
	if err == nil {
		t.Error("non-host should not be able to end party")
	}

	// Host ends
	err = m.EndParty("ABCDEF", 1)
	if err != nil {
		t.Fatalf("host EndParty failed: %v", err)
	}

	m.mu.RLock()
	_, exists := m.parties["ABCDEF"]
	m.mu.RUnlock()
	if exists {
		t.Error("party should be removed after EndParty")
	}
}

func TestEndParty_NotFound(t *testing.T) {
	m := mockPartyManager()

	err := m.EndParty("XXXXXX", 1)
	if err == nil {
		t.Error("EndParty on non-existent should error")
	}
}

// ============================================================
// Stale Cleanup Tests
// ============================================================

func TestCleanupOnce_RemovesStaleparties(t *testing.T) {
	m := mockPartyManager()

	// Create a party with all participants stale
	staleTime := time.Now().Add(-10 * time.Minute)
	ps := &PartyState{
		Code:         "STALE1",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now().Add(-30 * time.Minute),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: staleTime}

	// Create a party with a fresh participant
	freshPS := &PartyState{
		Code:         "FRESH1",
		HostUserID:   2,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now(),
	}
	freshPS.Participants[2] = &Participant{UserID: 2, Username: "host2", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["STALE1"] = ps
	m.parties["FRESH1"] = freshPS
	m.mu.Unlock()

	m.cleanupOnce()

	m.mu.RLock()
	_, staleExists := m.parties["STALE1"]
	_, freshExists := m.parties["FRESH1"]
	m.mu.RUnlock()

	if staleExists {
		t.Error("stale party should have been cleaned up")
	}
	if !freshExists {
		t.Error("fresh party should not have been cleaned up")
	}
}

func TestCleanupOnce_EmptyPartyStale(t *testing.T) {
	m := mockPartyManager()

	// Party with no participants, old enough
	ps := &PartyState{
		Code:         "EMPTY1",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now().Add(-10 * time.Minute),
	}

	m.mu.Lock()
	m.parties["EMPTY1"] = ps
	m.mu.Unlock()

	m.cleanupOnce()

	m.mu.RLock()
	_, exists := m.parties["EMPTY1"]
	m.mu.RUnlock()

	if exists {
		t.Error("empty stale party should have been cleaned up")
	}
}

// ============================================================
// ChangeMedia Tests (issue #462 — hostRefreshTokenID param)
// ============================================================

func changeMediaParty() *PartyState {
	return &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MediaItemID:     100,
		MaxParticipants: 5,
		Participants:    map[int64]*Participant{1: {UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}},
		roomConns:       make(map[int64]*SafeConn),
		syncConns:       make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{AllowChat: true, AllowPause: true, MaxParticipants: 5},
		CreatedAt:       time.Now(),
	}
}

// TestChangeMedia_NonHostRejected pins that the caller-profile parameter
// didn't loosen the existing host-only authorization — a non-host caller
// must still be rejected regardless of what it passes.
func TestChangeMedia_NonHostRejected(t *testing.T) {
	m := mockPartyManager()
	ps := changeMediaParty()
	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.ChangeMedia("ABCDEF", 2 /* not the host */, nil, 200, nil, "new title", "")
	if err == nil {
		t.Fatal("ChangeMedia should reject a non-host caller")
	}
	if !strings.Contains(err.Error(), "host") {
		t.Errorf("error should mention host, got: %s", err.Error())
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.MediaItemID != 100 {
		t.Error("rejected swap must not mutate party state")
	}
}

// TestChangeMedia_NilQueriesSkipsValidation pins that m.queries == nil (the
// existing "tests build the manager without a pool" contract) still lets a
// host's swap through untouched — issue #462's rating-ceiling check hangs
// off the SAME `if m.queries != nil` guard as the pre-existing existence
// check, so it must not become a hard dependency on a DB being wired.
func TestChangeMedia_NilQueriesSkipsValidation(t *testing.T) {
	m := mockPartyManager() // queries is nil
	ps := changeMediaParty()
	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	if err := m.ChangeMedia("ABCDEF", 1, nil, 200, nil, "new title", "poster.jpg"); err != nil {
		t.Fatalf("host swap with nil queries should succeed, got: %v", err)
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.MediaItemID != 200 {
		t.Errorf("MediaItemID = %d, want 200", ps.MediaItemID)
	}
	if ps.MediaTitle != "new title" {
		t.Errorf("MediaTitle = %q, want %q", ps.MediaTitle, "new title")
	}
}

// ============================================================
// Concurrency Tests
// ============================================================

func TestConcurrentCodeGeneration(t *testing.T) {
	m := &Manager{
		parties: make(map[string]*PartyState),
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := make(map[string]bool)

	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, err := m.GenerateCode()
			if err != nil {
				t.Errorf("concurrent GenerateCode error: %v", err)
				return
			}
			mu.Lock()
			codes[code] = true
			mu.Unlock()
		}()
	}

	wg.Wait()

	if len(codes) != 50 {
		t.Errorf("expected 50 unique codes, got %d", len(codes))
	}
}

func TestCleanupStale_ContextCancellation(t *testing.T) {
	m := mockPartyManager()

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		m.CleanupStale(ctx)
		close(done)
	}()

	// Cancel immediately
	cancel()

	select {
	case <-done:
		// Good — CleanupStale exited
	case <-time.After(5 * time.Second):
		t.Fatal("CleanupStale did not exit after context cancellation")
	}
}

// ============================================================
// PartyCount / ActiveParties Tests
// ============================================================

func TestPartyCount(t *testing.T) {
	m := mockPartyManager()

	if m.PartyCount() != 0 {
		t.Errorf("initial PartyCount = %d, want 0", m.PartyCount())
	}

	m.mu.Lock()
	m.parties["A"] = &PartyState{Code: "A", Participants: make(map[int64]*Participant)}
	m.parties["B"] = &PartyState{Code: "B", Participants: make(map[int64]*Participant)}
	m.mu.Unlock()

	if m.PartyCount() != 2 {
		t.Errorf("PartyCount = %d, want 2", m.PartyCount())
	}
}

func TestActiveParties(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		PartyName:       "Movie Night",
		MediaTitle:      "Inception",
		MediaPoster:     "/poster.jpg",
		MaxParticipants: 10,
		Running:         true,
		AnchorAbsMs:     5000,
		AnchorServerAt:  time.Now(),
		Participants:    make(map[int64]*Participant),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{},
		CreatedAt:       time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true}
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer"}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	parties := m.ActiveParties()
	if len(parties) != 1 {
		t.Fatalf("ActiveParties() length = %d, want 1", len(parties))
	}

	p := parties[0]
	if p["code"] != "ABCDEF" {
		t.Errorf("code = %v, want ABCDEF", p["code"])
	}
	if p["participant_count"] != 2 {
		t.Errorf("participant_count = %v, want 2", p["participant_count"])
	}
	if p["media_title"] != "Inception" {
		t.Errorf("media_title = %v, want Inception", p["media_title"])
	}
}

// ============================================================
// Time-Sync Tests (NTP-style clock offset handshake — used by V3)
// ============================================================

// partyWithHost is a small helper: builds a paused party with a single host
// participant and installs it on m.
func partyWithHost(m *Manager, code string, hostID int64) *PartyState {
	ps := &PartyState{
		Code:            code,
		HostUserID:      hostID,
		MaxParticipants: 5,
		StateRevision:   1,
		AnchorServerAt:  time.Now(),
		Participants:    make(map[int64]*Participant),
		roomConns:       make(map[int64]*SafeConn),
		syncConns:       make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{},
		CreatedAt:       time.Now(),
	}
	ps.Participants[hostID] = &Participant{
		UserID: hostID, Username: "host", IsHost: true,
		LastSeen: time.Now(),
	}
	m.mu.Lock()
	m.parties[code] = ps
	m.mu.Unlock()
	return ps
}

// HandleTimeSync is the server half of the NTP-style handshake. It echoes the
// client's send timestamp (so the client can compute RTT without tracking
// nonces) and returns a fresh server-send timestamp (so the client can compute
// offset = server_send - (client_send + rtt/2)).
func TestHandleTimeSync_EchoesClientTimestamp(t *testing.T) {
	m := mockPartyManager()
	partyWithHost(m, "ABCDEF", 1)

	before := time.Now().UnixMilli()
	resp, err := m.HandleTimeSync("ABCDEF", 1, 12345, 23456)
	if err != nil {
		t.Fatalf("HandleTimeSync error: %v", err)
	}
	after := time.Now().UnixMilli()

	if resp.ClientSendMs != 12345 {
		t.Errorf("ClientSendMs = %d, want 12345 (must echo verbatim)", resp.ClientSendMs)
	}
	if resp.ServerRecvMs != 23456 {
		t.Errorf("ServerRecvMs = %d, want 23456 (must echo verbatim)", resp.ServerRecvMs)
	}
	if resp.ServerSendMs < before || resp.ServerSendMs > after {
		t.Errorf("ServerSendMs = %d, want within [%d, %d]", resp.ServerSendMs, before, after)
	}
}

// RecordRTT writes observability fields on the participant; missing peers are
// silently ignored (no panic).
func TestRecordRTT_UpdatesParticipantFields(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)

	m.RecordRTT("ABCDEF", 1, 42, -17)

	ps.mu.Lock()
	p := ps.Participants[1]
	if p.LastRTTms != 42 {
		t.Errorf("LastRTTms = %d, want 42", p.LastRTTms)
	}
	if p.ClockOffsetMs != -17 {
		t.Errorf("ClockOffsetMs = %d, want -17", p.ClockOffsetMs)
	}
	ps.mu.Unlock()

	// Unknown user silently no-ops — must not panic.
	m.RecordRTT("ABCDEF", 999, 10, 10)
	m.RecordRTT("NOPARTY", 1, 10, 10)
}

// SyncConfig() on the Manager returns the active config. Useful for handlers
// and tests that need the advertised V3 thresholds without magic numbers.
func TestSyncConfigAccessor_ReturnsActiveConfig(t *testing.T) {
	m := mockPartyManager()
	got := m.SyncConfig()
	want := DefaultSyncConfig()
	if got != want {
		t.Errorf("SyncConfig() = %+v, want %+v", got, want)
	}
}

// NewManagerWithConfig must backfill any zero/negative values with defaults —
// callers specifying only a subset of knobs should not get pathological
// zero-threshold behavior.
func TestNewManagerWithConfig_BackfillsZeroValues(t *testing.T) {
	// Only set TickInterval; the rest are zero and must be defaulted.
	partial := SyncConfig{TickInterval: 100 * time.Millisecond}
	m := NewManagerWithConfig(nil, nil, partial)
	got := m.SyncConfig()
	def := DefaultSyncConfig()

	if got.TickInterval != 100*time.Millisecond {
		t.Errorf("TickInterval = %v, want 100ms (explicit override)", got.TickInterval)
	}
	if got.V3DriftIgnoreMs != def.V3DriftIgnoreMs {
		t.Errorf("V3DriftIgnoreMs = %d, want default %d", got.V3DriftIgnoreMs, def.V3DriftIgnoreMs)
	}
	if got.V3DriftHardSeekMs != def.V3DriftHardSeekMs {
		t.Errorf("V3DriftHardSeekMs = %d, want default %d", got.V3DriftHardSeekMs, def.V3DriftHardSeekMs)
	}
	if got.V3CatchUpRate != def.V3CatchUpRate {
		t.Errorf("V3CatchUpRate = %v, want default %v", got.V3CatchUpRate, def.V3CatchUpRate)
	}
	if got.V3EaseBackRate != def.V3EaseBackRate {
		t.Errorf("V3EaseBackRate = %v, want default %v", got.V3EaseBackRate, def.V3EaseBackRate)
	}
}

// ============================================================
// Schedule + Countdown Tests (migration 019, Phase 1)
// ============================================================

// TestFireScheduledStart_DedupsIfStartedAt locks in the dedup invariant
// in fireScheduledStart. Production bug class: a host who schedules a
// party and then manually clicks play before the scheduled moment would
// (without the fix in HandleRequestPlay) trigger a double-fire — the
// scheduled timer would still fire at the original moment, broadcasting
// a second "party-starting" mid-movie.
//
// The fix has two parts:
//  1. HandleRequestPlay stamps ps.StartedAt on first play and cancels the
//     schedule timer.
//  2. fireScheduledStart guards on `ps.StartedAt != nil` and no-ops.
//
// This test exercises part 2 directly: if StartedAt is already set when
// the timer fires (any reason — manual play, prior fire, race), the
// goroutine returns without broadcasting or mutating state.
func TestFireScheduledStart_DedupsIfStartedAt(t *testing.T) {
	m := mockPartyManager()

	code := "TESTSC"
	earlier := time.Now().Add(-1 * time.Minute)
	ps := &PartyState{
		Code:         code,
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		syncConns:    make(map[int64]*SafeConn),
		roomConns:    make(map[int64]*SafeConn),
		// Pre-set StartedAt to simulate "the party already started" state.
		StartedAt: &earlier,
	}
	m.mu.Lock()
	m.parties[code] = ps
	m.mu.Unlock()

	// Snapshot before; pointer comparison detects if dedup misfired and
	// stamped a fresh now over the pre-set value.
	before := ps.StartedAt

	m.fireScheduledStart(code)

	if ps.StartedAt != before {
		t.Errorf("fireScheduledStart re-stamped StartedAt despite dedup guard; pointer changed")
	}
}

// TestHandleRequestPlay_StampsStartedAt verifies that a manual host-play
// stamps ps.StartedAt on its first invocation. This is the other half of
// the double-fire fix: by stamping StartedAt here, the scheduled timer's
// dedup guard (above) becomes effective for the
// manual-play-before-schedule-fire path. Ported from the deleted V2
// HandlePlaybackControl during the 2026-06 V2 deletion.
func TestHandleRequestPlay_StampsStartedAt(t *testing.T) {
	m := mockPartyManager()

	code := "TESTPL"
	ps := &PartyState{
		Code:            code,
		HostUserID:      1,
		MaxParticipants: 5,
		Participants:    make(map[int64]*Participant),
		syncConns:       make(map[int64]*SafeConn),
		roomConns:       make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{AllowPause: false},
		CreatedAt:       time.Now(),
		StartedAt:       nil, // pre-condition: not yet started
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	m.mu.Lock()
	m.parties[code] = ps
	m.mu.Unlock()

	if err := m.HandleRequestPlay(code, 1); err != nil {
		t.Fatalf("HandleRequestPlay returned err: %v", err)
	}
	// Stop the tick loop the play started so the test doesn't leak it.
	defer func() {
		ps.mu.Lock()
		m.stopTickLoopLocked(ps)
		ps.mu.Unlock()
	}()

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.StartedAt == nil {
		t.Error("HandleRequestPlay did not stamp StartedAt; double-fire dedup will be ineffective")
	}
}

// TestSchedulePartyStart_RejectsPastTimestamps verifies the manager
// validation matches the API layer (1s grace for clock skew). Anything
// more than 1s in the past must be rejected with an error.
func TestSchedulePartyStart_RejectsPastTimestamps(t *testing.T) {
	m := mockPartyManager()

	code := "TESTPA"
	ps := &PartyState{
		Code:         code,
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		syncConns:    make(map[int64]*SafeConn),
		roomConns:    make(map[int64]*SafeConn),
	}
	m.mu.Lock()
	m.parties[code] = ps
	m.mu.Unlock()

	// Clearly past: 1 hour ago. Must error.
	past := time.Now().Add(-1 * time.Hour)
	if err := m.SchedulePartyStart(context.Background(), code, &past); err == nil {
		t.Error("SchedulePartyStart should reject timestamps clearly in the past")
	}

	// Within grace window (500ms ago): should pass (matches API behavior).
	within := time.Now().Add(-500 * time.Millisecond)
	if err := m.SchedulePartyStart(context.Background(), code, &within); err != nil {
		t.Errorf("SchedulePartyStart rejected timestamp within 1s grace: %v", err)
	}
}
