package watchparty

import (
	"testing"
)

// ============================================================
// Mobile-companion presence flag (Feature 1)
// ============================================================
// The room socket can flag a participant as a phone "second screen" via
// JoinPartyV3RoomCompanion. The flag must be additive: the legacy
// JoinPartyV3Room path (and BuildPartyStateMessage for every existing
// client) must behave exactly as before when companion is false.
//
// Reuses v3TestParty + the no-DB Manager harness from sync_v3_test.go.

// TestCompanion_JoinSetsFlag verifies a companion join records Companion=true
// on the new participant.
func TestCompanion_JoinSetsFlag(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "COMP01", 1)

	if _, err := m.JoinPartyV3RoomCompanion("COMP01", 2, "phone-guest", true, &SafeConn{}); err != nil {
		t.Fatalf("companion join returned error: %v", err)
	}

	ps.mu.Lock()
	p, ok := ps.Participants[2]
	got := ok && p.Companion
	ps.mu.Unlock()
	if !got {
		t.Fatalf("participant 2 Companion=false after companion join, want true (ok=%v)", ok)
	}
}

// TestCompanion_LegacyJoinDefaultsFalse verifies the backward-compatible
// JoinPartyV3Room shim joins as a non-companion (Companion=false).
func TestCompanion_LegacyJoinDefaultsFalse(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "COMP02", 1)

	if _, err := m.JoinPartyV3Room("COMP02", 2, "desktop-guest", &SafeConn{}); err != nil {
		t.Fatalf("legacy join returned error: %v", err)
	}

	ps.mu.Lock()
	p := ps.Participants[2]
	ps.mu.Unlock()
	if p == nil {
		t.Fatal("participant 2 not registered by legacy join")
	}
	if p.Companion {
		t.Errorf("legacy JoinPartyV3Room set Companion=true, want false (backward-compat regression)")
	}
}

// TestCompanion_ReconnectRefreshesFlag verifies the flag tracks the current
// connection's surface: a user who first joins on desktop (companion=false)
// and reconnects from a phone (companion=true) gets re-flagged.
func TestCompanion_ReconnectRefreshesFlag(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "COMP03", 1)

	// First join: desktop.
	if _, err := m.JoinPartyV3RoomCompanion("COMP03", 2, "guest", false, &SafeConn{}); err != nil {
		t.Fatalf("first join error: %v", err)
	}
	ps.mu.Lock()
	first := ps.Participants[2].Companion
	ps.mu.Unlock()
	if first {
		t.Fatal("first (desktop) join should be Companion=false")
	}

	// Reconnect from phone.
	if _, err := m.JoinPartyV3RoomCompanion("COMP03", 2, "guest", true, &SafeConn{}); err != nil {
		t.Fatalf("reconnect error: %v", err)
	}
	ps.mu.Lock()
	second := ps.Participants[2].Companion
	count := len(ps.Participants)
	ps.mu.Unlock()
	if !second {
		t.Errorf("reconnect from phone did not refresh Companion to true")
	}
	// Reconnect must not duplicate the participant (host + guest = 2).
	if count != 2 {
		t.Errorf("participant count = %d after reconnect, want 2", count)
	}
}

// TestCompanion_BuildPartyStateMessageIncludesFlag verifies the joiner
// snapshot serializes the companion flag per participant, so the frontend can
// render the "on phone" badge from a fresh join / reconnect.
func TestCompanion_BuildPartyStateMessageIncludesFlag(t *testing.T) {
	m := NewManager(nil, nil)
	ps := v3TestParty(m, "COMP04", 1)

	if _, err := m.JoinPartyV3RoomCompanion("COMP04", 2, "phone-guest", true, &SafeConn{}); err != nil {
		t.Fatalf("companion join error: %v", err)
	}

	ps.mu.Lock()
	msg := m.BuildPartyStateMessage(ps)
	ps.mu.Unlock()

	payload, ok := msg["payload"].(map[string]interface{})
	if !ok {
		t.Fatal("party-state message has no payload map")
	}
	parts, ok := payload["participants"].([]map[string]interface{})
	if !ok {
		t.Fatalf("participants is %T, want []map[string]interface{}", payload["participants"])
	}

	// Every participant entry must carry the companion key (additive field);
	// the phone guest's must be true, the host's false.
	seenHost, seenGuest := false, false
	for _, p := range parts {
		companion, present := p["companion"].(bool)
		if !present {
			t.Errorf("participant %v missing companion field", p["user_id"])
			continue
		}
		switch p["user_id"] {
		case int64(1):
			seenHost = true
			if companion {
				t.Errorf("host serialized companion=true, want false")
			}
		case int64(2):
			seenGuest = true
			if !companion {
				t.Errorf("phone guest serialized companion=false, want true")
			}
		}
	}
	if !seenHost || !seenGuest {
		t.Errorf("expected both host(1) and guest(2) in snapshot; seenHost=%v seenGuest=%v", seenHost, seenGuest)
	}
}
