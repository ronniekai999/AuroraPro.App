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
// JoinParty Tests
// ============================================================

func TestJoinParty_MaxParticipants(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 2,
		Participants:    make(map[int64]*Participant),
		conns:           make(map[int64]*SafeConn),
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
	_, err := m.JoinParty("ABCDEF", 3, "user3", nil)
	if err == nil {
		t.Error("JoinParty should fail when party is full")
	}
	if !strings.Contains(err.Error(), "full") {
		t.Errorf("error should mention full, got: %s", err.Error())
	}
}

func TestJoinParty_Reconnect(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 5,
		Participants:    make(map[int64]*Participant),
		conns:           make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{AllowChat: true, AllowPause: true, MaxParticipants: 5},
		CreatedAt:       time.Now(),
	}

	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now().Add(-time.Minute)}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// "Reconnect" the same user
	_, err := m.JoinParty("ABCDEF", 1, "host", nil)
	if err != nil {
		t.Fatalf("JoinParty reconnect failed: %v", err)
	}

	ps.mu.Lock()
	p := ps.Participants[1]
	ps.mu.Unlock()

	if time.Since(p.LastSeen) > time.Second {
		t.Error("reconnecting user should update LastSeen")
	}
}

func TestJoinParty_NotFound(t *testing.T) {
	m := mockPartyManager()

	_, err := m.JoinParty("XXXXXX", 1, "user", nil)
	if err == nil {
		t.Error("JoinParty should fail for non-existent party")
	}
}

// ============================================================
// LeaveParty Tests
// ============================================================

func TestLeaveParty_NonExistent(t *testing.T) {
	m := mockPartyManager()

	// Should not error for non-existent party
	err := m.LeaveParty("XXXXXX", 1)
	if err != nil {
		t.Errorf("LeaveParty for non-existent party should not error, got: %v", err)
	}
}

func TestLeaveParty_NotParticipant(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		conns:        make(map[int64]*SafeConn),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{AllowChat: true},
		CreatedAt:    time.Now(),
	}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.LeaveParty("ABCDEF", 99)
	if err != nil {
		t.Errorf("LeaveParty for non-participant should not error, got: %v", err)
	}
}

func TestLeaveParty_HostEndsParty(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 5,
		Participants:    make(map[int64]*Participant),
		conns:           make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{},
		CreatedAt:       time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.LeaveParty("ABCDEF", 1)
	if err != nil {
		t.Fatalf("LeaveParty (host) failed: %v", err)
	}

	// Party should be removed from memory
	m.mu.RLock()
	_, exists := m.parties["ABCDEF"]
	m.mu.RUnlock()
	if exists {
		t.Error("party should be removed from memory after host leaves")
	}
}

// ============================================================
// Playback Control Tests
// ============================================================

func TestHandlePlaybackControl_HostOnly(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 5,
		CurrentTimeMs:   0,
		IsPlaying:       false,
		Participants:    make(map[int64]*Participant),
		conns:           make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{AllowPause: false},
		CreatedAt:       time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Viewer tries to play — should fail
	err := m.HandlePlaybackControl("ABCDEF", 2, "play", 0)
	if err == nil {
		t.Error("non-host should not be able to play")
	}

	// Host plays — V2 transitions to Waiting (not Playing) until peers Ready.
	err = m.HandlePlaybackControl("ABCDEF", 1, "play", 5000)
	if err != nil {
		t.Fatalf("host play failed: %v", err)
	}

	ps.mu.Lock()
	if ps.GroupState != GroupStateWaiting {
		t.Errorf("GroupState = %q, want %q (play must enter Waiting until all peers Ready)",
			ps.GroupState, GroupStateWaiting)
	}
	if ps.IsPlaying {
		t.Error("IsPlaying should be false while group is Waiting")
	}
	if ps.CurrentTimeMs != 5000 {
		t.Errorf("CurrentTimeMs = %d, want 5000", ps.CurrentTimeMs)
	}
	ps.mu.Unlock()
}

func TestHandlePlaybackControl_AllowPause(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 5,
		CurrentTimeMs:   5000,
		IsPlaying:       true,
		Participants:    make(map[int64]*Participant),
		conns:           make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{AllowPause: true},
		CreatedAt:       time.Now(),
	}
	now := time.Now()
	ps.PlayingSince = &now
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	ps.Participants[2] = &Participant{UserID: 2, Username: "viewer", LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// Viewer pauses — should succeed when AllowPause is true
	err := m.HandlePlaybackControl("ABCDEF", 2, "pause", 6000)
	if err != nil {
		t.Fatalf("viewer pause with AllowPause failed: %v", err)
	}

	ps.mu.Lock()
	if ps.IsPlaying {
		t.Error("IsPlaying should be false after pause")
	}
	ps.mu.Unlock()
}

func TestHandlePlaybackControl_Seek(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:            "ABCDEF",
		HostUserID:      1,
		MaxParticipants: 5,
		CurrentTimeMs:   10000,
		IsPlaying:       true,
		Participants:    make(map[int64]*Participant),
		conns:           make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{},
		CreatedAt:       time.Now(),
	}
	now := time.Now()
	ps.PlayingSince = &now
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.HandlePlaybackControl("ABCDEF", 1, "seek", 60000)
	if err != nil {
		t.Fatalf("seek failed: %v", err)
	}

	ps.mu.Lock()
	if ps.CurrentTimeMs != 60000 {
		t.Errorf("CurrentTimeMs after seek = %d, want 60000", ps.CurrentTimeMs)
	}
	// V2: seek always enters Waiting, regardless of prior IsPlaying — every peer
	// must re-buffer to the new position before playback resumes.
	if ps.GroupState != GroupStateWaiting {
		t.Errorf("GroupState after seek = %q, want %q", ps.GroupState, GroupStateWaiting)
	}
	if ps.IsPlaying {
		t.Error("IsPlaying should be false while re-buffering after seek")
	}
	ps.mu.Unlock()
}

func TestHandlePlaybackControl_UnknownAction(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		conns:        make(map[int64]*SafeConn),
		ChatHistory:  make([]ChatMessage, 0),
		Settings:     PartySettings{},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.HandlePlaybackControl("ABCDEF", 1, "rewind", 0)
	if err == nil {
		t.Error("unknown action should return error")
	}
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
		conns:        make(map[int64]*SafeConn),
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

func TestHandleChat_TooLong(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		conns:        make(map[int64]*SafeConn),
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

func TestHandleChat_HTMLSanitization(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		conns:        make(map[int64]*SafeConn),
		ChatHistory:  make([]ChatMessage, 0, chatHistoryMax),
		Settings:     PartySettings{AllowChat: true},
		CreatedAt:    time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.HandleChat("ABCDEF", 1, "host", `<script>alert("xss")</script>`)
	if err != nil {
		t.Fatalf("HandleChat failed: %v", err)
	}

	ps.mu.Lock()
	msg := ps.ChatHistory[0].Message
	ps.mu.Unlock()

	if strings.Contains(msg, "<script>") {
		t.Errorf("message should be HTML-escaped, got: %s", msg)
	}
	if !strings.Contains(msg, "&lt;script&gt;") {
		t.Errorf("message should contain escaped HTML, got: %s", msg)
	}
}

func TestHandleChat_RingBuffer(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:         "ABCDEF",
		HostUserID:   1,
		Participants: make(map[int64]*Participant),
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
// Drift Calculation Tests
// ============================================================

func TestCalculateCurrentPosition_Paused(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		CurrentTimeMs: 30000,
		IsPlaying:     false,
		PlayingSince:  nil,
	}

	pos := m.calculateCurrentPosition(ps)
	if pos != 30000 {
		t.Errorf("paused position = %d, want 30000", pos)
	}
}

func TestCalculateCurrentPosition_Playing(t *testing.T) {
	m := mockPartyManager()

	playStart := time.Now().Add(-5 * time.Second)
	ps := &PartyState{
		CurrentTimeMs: 30000,
		IsPlaying:     true,
		PlayingSince:  &playStart,
	}

	pos := m.calculateCurrentPosition(ps)
	// Should be approximately 35000ms (30000 + 5000ms elapsed)
	// Allow 500ms tolerance for test execution time
	if pos < 34500 || pos > 35500 {
		t.Errorf("playing position = %d, want ~35000", pos)
	}
}

// ============================================================
// Sync Heartbeat Tests
// ============================================================

func TestHandleSyncHeartbeat_PartyNotFound(t *testing.T) {
	m := mockPartyManager()

	err := m.HandleSyncHeartbeat("XXXXXX", 1, 5000, false)
	if err == nil {
		t.Error("heartbeat for non-existent party should return error")
	}
}

// V2: heartbeats are purely informational (LastSeen + buffering state). The
// server never trusts a client-reported position — only the authoritative state
// machine (play/pause/seek/ready) is allowed to mutate CurrentTimeMs.
func TestHandleSyncHeartbeat_DoesNotMutatePosition(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:          "ABCDEF",
		HostUserID:    1,
		CurrentTimeMs: 10000,
		IsPlaying:     true,
		Participants:  make(map[int64]*Participant),
		conns:         make(map[int64]*SafeConn),
		ChatHistory:   make([]ChatMessage, 0),
		Settings:      PartySettings{},
		CreatedAt:     time.Now(),
	}
	now := time.Now()
	ps.PlayingSince = &now
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	err := m.HandleSyncHeartbeat("ABCDEF", 1, 15000, false)
	if err != nil {
		t.Fatalf("host heartbeat failed: %v", err)
	}

	ps.mu.Lock()
	if ps.CurrentTimeMs != 10000 {
		t.Errorf("heartbeat must not mutate CurrentTimeMs; got %d want 10000", ps.CurrentTimeMs)
	}
	if ps.Participants[1].LastSeen.Before(now) {
		t.Error("heartbeat should at least update LastSeen")
	}
	ps.mu.Unlock()
}

func TestHandleSyncHeartbeat_NonParticipant(t *testing.T) {
	m := mockPartyManager()

	ps := &PartyState{
		Code:          "ABCDEF",
		HostUserID:    1,
		CurrentTimeMs: 10000,
		Participants:  make(map[int64]*Participant),
		conns:         make(map[int64]*SafeConn),
		ChatHistory:   make([]ChatMessage, 0),
		Settings:      PartySettings{},
		CreatedAt:     time.Now(),
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}

	m.mu.Lock()
	m.parties["ABCDEF"] = ps
	m.mu.Unlock()

	// User 99 is not a participant — should silently return nil
	err := m.HandleSyncHeartbeat("ABCDEF", 99, 5000, false)
	if err != nil {
		t.Errorf("stale heartbeat from non-participant should not error: %v", err)
	}
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
		conns:        make(map[int64]*SafeConn),
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
	m.parties["A"] = &PartyState{Code: "A", Participants: make(map[int64]*Participant), conns: make(map[int64]*SafeConn)}
	m.parties["B"] = &PartyState{Code: "B", Participants: make(map[int64]*Participant), conns: make(map[int64]*SafeConn)}
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
		IsPlaying:       true,
		CurrentTimeMs:   5000,
		Participants:    make(map[int64]*Participant),
		conns:           make(map[int64]*SafeConn),
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
// V2 Sync Protocol Tests
// ============================================================
//
// These cover the Jellyfin-SyncPlay-inspired state machine added in sync.go:
//   - TimeSync request/response (clock offset handshake)
//   - Ready protocol (all non-suspended peers must Ready before Playing)
//   - Buffer hysteresis (one stall doesn't pause the group; a sustained stall does)
//   - Drift reports (thrashing clients get suspended, not disconnected)
//   - StateRevision monotonicity
//   - SyncConfig accessor / zero-value defaulting

// partyWithHost is a small helper for V2 tests: builds a party in Idle with a
// single host participant and installs it on m.
func partyWithHost(m *Manager, code string, hostID int64) *PartyState {
	ps := &PartyState{
		Code:            code,
		HostUserID:      hostID,
		MaxParticipants: 5,
		GroupState:      GroupStateIdle,
		StateRevision:   1,
		Participants:    make(map[int64]*Participant),
		conns:           make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{},
		CreatedAt:       time.Now(),
	}
	ps.Participants[hostID] = &Participant{
		UserID: hostID, Username: "host", IsHost: true,
		ReadyAtMs: -1, LastSeen: time.Now(),
		Suspensions: make(map[string]bool),
	}
	m.mu.Lock()
	m.parties[code] = ps
	m.mu.Unlock()
	return ps
}

// addGuest attaches a non-host participant to ps.
func addGuest(ps *PartyState, userID int64, username string) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	ps.Participants[userID] = &Participant{
		UserID: userID, Username: username,
		ReadyAtMs: -1, LastSeen: time.Now(),
		Suspensions: make(map[string]bool),
	}
}

// ------------------------------------------------------------
// TimeSync
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// Ready / group state transitions
// ------------------------------------------------------------

// Play must enter Waiting (not Playing) until every non-suspended peer emits
// Ready at the target position. This is the core of V2 — no more "play now"
// commands that leave slow peers behind.
func TestHandlePlaybackControl_PlayEntersWaiting(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)
	addGuest(ps, 2, "viewer")

	revBefore := ps.StateRevision

	if err := m.HandlePlaybackControl("ABCDEF", 1, "play", 8000); err != nil {
		t.Fatalf("play: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.GroupState != GroupStateWaiting {
		t.Errorf("GroupState = %q, want %q", ps.GroupState, GroupStateWaiting)
	}
	if ps.IsPlaying {
		t.Error("IsPlaying must be false during Waiting")
	}
	if ps.CurrentTimeMs != 8000 {
		t.Errorf("CurrentTimeMs = %d, want 8000", ps.CurrentTimeMs)
	}
	if ps.StateRevision <= revBefore {
		t.Errorf("StateRevision did not advance: before=%d after=%d", revBefore, ps.StateRevision)
	}
}

// With all non-suspended peers ready at the target, HandleReady flips the group
// from Waiting → Playing and stamps PlayingSince in the near future (accounting
// for PlayScheduleDelay).
func TestHandleReady_AllReadyTransitionsToPlaying(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)
	addGuest(ps, 2, "viewer")

	if err := m.HandlePlaybackControl("ABCDEF", 1, "play", 10000); err != nil {
		t.Fatalf("play: %v", err)
	}

	// Host reports ready first — group must remain Waiting.
	if err := m.HandleReady("ABCDEF", 1, 10000); err != nil {
		t.Fatalf("HandleReady(host): %v", err)
	}
	ps.mu.Lock()
	if ps.GroupState != GroupStateWaiting {
		t.Fatalf("after host-only ready: GroupState = %q, want %q", ps.GroupState, GroupStateWaiting)
	}
	ps.mu.Unlock()

	// Guest reports ready → all Ready → Playing.
	before := time.Now()
	if err := m.HandleReady("ABCDEF", 2, 10000); err != nil {
		t.Fatalf("HandleReady(guest): %v", err)
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.GroupState != GroupStatePlaying {
		t.Errorf("GroupState after all-ready = %q, want %q", ps.GroupState, GroupStatePlaying)
	}
	if !ps.IsPlaying {
		t.Error("IsPlaying must flip to true on Playing")
	}
	if ps.PlayingSince == nil {
		t.Fatal("PlayingSince must be set on Playing")
	}
	if ps.PlayingSince.Before(before) {
		t.Errorf("PlayingSince = %v should be ≥ %v (scheduled in future)", ps.PlayingSince, before)
	}
}

// A peer reporting Ready far from the target does NOT flip the group — the
// server waits until every non-suspended peer is within DriftHardSeekMs.
func TestHandleReady_OffTargetIgnored(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)
	addGuest(ps, 2, "slowpoke")

	if err := m.HandlePlaybackControl("ABCDEF", 1, "play", 10000); err != nil {
		t.Fatalf("play: %v", err)
	}

	_ = m.HandleReady("ABCDEF", 1, 10000)
	// Guest reports ready way off target — must not resume.
	_ = m.HandleReady("ABCDEF", 2, 10000+m.cfg.DriftHardSeekMs+500)

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.GroupState != GroupStateWaiting {
		t.Errorf("off-target ready must keep group Waiting; got %q", ps.GroupState)
	}
}

// A suspended peer (e.g. "buffer") is skipped by the Ready quorum — the group
// can resume without them, which is how SharePlay handles a peer that has
// dropped out of sync.
func TestHandleReady_SuspendedPeerNotRequired(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)
	addGuest(ps, 2, "buffering")

	if err := m.HandlePlaybackControl("ABCDEF", 1, "play", 5000); err != nil {
		t.Fatalf("play: %v", err)
	}

	// Mark guest as suspended and have host Ready — group should resume.
	ps.mu.Lock()
	ps.Participants[2].Suspensions["buffer"] = true
	ps.mu.Unlock()

	if err := m.HandleReady("ABCDEF", 1, 5000); err != nil {
		t.Fatalf("HandleReady(host): %v", err)
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.GroupState != GroupStatePlaying {
		t.Errorf("suspended peer should not block quorum; GroupState = %q", ps.GroupState)
	}
}

// ------------------------------------------------------------
// Buffer hysteresis
// ------------------------------------------------------------

// A single transient-buffer heartbeat (BufferingSince = now) should NOT drop
// the group into Waiting — only sustained buffering does.
func TestHandleSyncHeartbeat_TransientBufferDoesNotPauseGroup(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)
	addGuest(ps, 2, "viewer")

	ps.mu.Lock()
	ps.GroupState = GroupStatePlaying
	ps.IsPlaying = true
	now := time.Now()
	ps.PlayingSince = &now
	ps.CurrentTimeMs = 5000
	ps.mu.Unlock()

	// One buffering heartbeat — just started buffering, no elapsed time yet.
	if err := m.HandleSyncHeartbeat("ABCDEF", 2, 5000, true); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.GroupState != GroupStatePlaying {
		t.Errorf("transient stall must not pause group; GroupState = %q", ps.GroupState)
	}
	if !ps.Participants[2].IsBuffering {
		t.Error("participant.IsBuffering should reflect report")
	}
	if ps.Participants[2].BufferingSince == nil {
		t.Error("BufferingSince must be set on 0→1 transition")
	}
}

// A peer buffering for longer than BufferHysteresis should transition the
// group from Playing → Waiting and mark the peer suspended:"buffer".
func TestHandleSyncHeartbeat_SustainedBufferTransitionsToWaiting(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)
	addGuest(ps, 2, "viewer")

	ps.mu.Lock()
	ps.GroupState = GroupStatePlaying
	ps.IsPlaying = true
	now := time.Now()
	ps.PlayingSince = &now
	ps.CurrentTimeMs = 5000
	// Pre-seed BufferingSince far in the past so the next heartbeat crosses
	// the hysteresis threshold without needing a real sleep.
	old := now.Add(-10 * m.cfg.BufferHysteresis)
	ps.Participants[2].IsBuffering = true
	ps.Participants[2].BufferingSince = &old
	ps.mu.Unlock()

	if err := m.HandleSyncHeartbeat("ABCDEF", 2, 5200, true); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.GroupState != GroupStateWaiting {
		t.Errorf("sustained buffer must pause group; GroupState = %q", ps.GroupState)
	}
	if ps.IsPlaying {
		t.Error("IsPlaying must be false in Waiting")
	}
	if !ps.Participants[2].Suspensions["buffer"] {
		t.Error("buffering peer should be marked suspended:buffer")
	}
}

// Clearing the buffering flag must clear BufferingSince and drop the "buffer"
// suspension so the peer can rejoin the Ready quorum.
func TestHandleSyncHeartbeat_BufferClearRemovesSuspension(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)
	addGuest(ps, 2, "viewer")

	ps.mu.Lock()
	now := time.Now()
	ps.Participants[2].IsBuffering = true
	ps.Participants[2].BufferingSince = &now
	ps.Participants[2].Suspensions["buffer"] = true
	ps.mu.Unlock()

	if err := m.HandleSyncHeartbeat("ABCDEF", 2, 5000, false); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.Participants[2].IsBuffering {
		t.Error("IsBuffering should be cleared")
	}
	if ps.Participants[2].BufferingSince != nil {
		t.Error("BufferingSince should be cleared on 1→0 transition")
	}
	if ps.Participants[2].Suspensions["buffer"] {
		t.Error("suspension 'buffer' should be removed on clear")
	}
}

// ------------------------------------------------------------
// Drift reports
// ------------------------------------------------------------

// A corrected drift report zeroes the failure counter regardless of prior state.
func TestHandleDriftReport_CorrectedResetsCounter(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)

	ps.mu.Lock()
	ps.Participants[1].FailedSeekAttempts = 3
	ps.mu.Unlock()

	if err := m.HandleDriftReport("ABCDEF", 1, 100, true); err != nil {
		t.Fatalf("HandleDriftReport: %v", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.Participants[1].FailedSeekAttempts != 0 {
		t.Errorf("corrected report must zero counter; got %d", ps.Participants[1].FailedSeekAttempts)
	}
}

// Repeated uncorrected drift beyond DriftMaxAttempts must suspend the peer
// with "desync" (they stay in chat but drop out of group playback).
func TestHandleDriftReport_ExceedsMaxAttempts_SuspendsPeer(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)
	addGuest(ps, 2, "thrasher")

	for i := 0; i < m.cfg.DriftMaxAttempts; i++ {
		if err := m.HandleDriftReport("ABCDEF", 2, 5000, false); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()
	if !ps.Participants[2].Suspensions["desync"] {
		t.Errorf("peer exceeding DriftMaxAttempts=%d must be suspended:desync",
			m.cfg.DriftMaxAttempts)
	}
	if ps.Participants[2].FailedSeekAttempts < m.cfg.DriftMaxAttempts {
		t.Errorf("FailedSeekAttempts = %d, want ≥ %d",
			ps.Participants[2].FailedSeekAttempts, m.cfg.DriftMaxAttempts)
	}
}

// ------------------------------------------------------------
// State revision / config accessors
// ------------------------------------------------------------

// Every state-mutating transition must strictly increase StateRevision so
// clients can discard out-of-order snapshots. Because UDP-style out-of-order
// WS writes are rare in practice this is cheap insurance.
func TestStateRevisionIsMonotonic(t *testing.T) {
	m := mockPartyManager()
	ps := partyWithHost(m, "ABCDEF", 1)
	addGuest(ps, 2, "viewer")

	ps.mu.Lock()
	rev0 := ps.StateRevision
	ps.mu.Unlock()

	// play → waiting
	_ = m.HandlePlaybackControl("ABCDEF", 1, "play", 1000)
	ps.mu.Lock()
	rev1 := ps.StateRevision
	ps.mu.Unlock()
	if rev1 <= rev0 {
		t.Errorf("rev after play = %d, want > %d", rev1, rev0)
	}

	// all ready → playing
	_ = m.HandleReady("ABCDEF", 1, 1000)
	_ = m.HandleReady("ABCDEF", 2, 1000)
	ps.mu.Lock()
	rev2 := ps.StateRevision
	ps.mu.Unlock()
	if rev2 <= rev1 {
		t.Errorf("rev after ready quorum = %d, want > %d", rev2, rev1)
	}

	// seek → waiting (even from Playing)
	_ = m.HandlePlaybackControl("ABCDEF", 1, "seek", 30000)
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.StateRevision <= rev2 {
		t.Errorf("rev after seek = %d, want > %d", ps.StateRevision, rev2)
	}
}

// SyncConfig() on the Manager returns the active config. Useful for the WS
// handler to tell new clients the heartbeat cadence without a magic number.
func TestSyncConfigAccessor_ReturnsActiveConfig(t *testing.T) {
	m := mockPartyManager()
	got := m.SyncConfig()
	want := DefaultSyncConfig()
	if got != want {
		t.Errorf("SyncConfig() = %+v, want %+v", got, want)
	}
}

// NewManagerWithConfig must backfill any zero/negative values with defaults —
// operators specifying only a subset of YAML keys should not get pathological
// zero-threshold behavior.
func TestNewManagerWithConfig_BackfillsZeroValues(t *testing.T) {
	// Only set HeartbeatInterval; the rest are zero and must be defaulted.
	partial := SyncConfig{HeartbeatInterval: 100 * time.Millisecond}
	m := NewManagerWithConfig(nil, nil, partial)
	got := m.SyncConfig()
	def := DefaultSyncConfig()

	if got.HeartbeatInterval != 100*time.Millisecond {
		t.Errorf("HeartbeatInterval = %v, want 100ms (explicit override)", got.HeartbeatInterval)
	}
	if got.TimeSyncInterval != def.TimeSyncInterval {
		t.Errorf("TimeSyncInterval = %v, want default %v", got.TimeSyncInterval, def.TimeSyncInterval)
	}
	if got.BufferHysteresis != def.BufferHysteresis {
		t.Errorf("BufferHysteresis = %v, want default %v", got.BufferHysteresis, def.BufferHysteresis)
	}
	if got.DriftIgnoreMs != def.DriftIgnoreMs {
		t.Errorf("DriftIgnoreMs = %d, want default %d", got.DriftIgnoreMs, def.DriftIgnoreMs)
	}
	if got.DriftRateAdjustMs != def.DriftRateAdjustMs {
		t.Errorf("DriftRateAdjustMs = %d, want default %d", got.DriftRateAdjustMs, def.DriftRateAdjustMs)
	}
	if got.DriftHardSeekMs != def.DriftHardSeekMs {
		t.Errorf("DriftHardSeekMs = %d, want default %d", got.DriftHardSeekMs, def.DriftHardSeekMs)
	}
	if got.DriftMaxAttempts != def.DriftMaxAttempts {
		t.Errorf("DriftMaxAttempts = %d, want default %d", got.DriftMaxAttempts, def.DriftMaxAttempts)
	}
}

// ============================================================
// Schedule + Countdown Tests (migration 019, Phase 1)
// ============================================================

// TestFireScheduledStart_DedupsIfStartedAt locks in the dedup invariant
// in fireScheduledStart. Production bug class: a host who schedules a
// party and then manually clicks play before the scheduled moment would
// (without the fix in HandlePlaybackControl) trigger a double-fire — the
// scheduled timer would still fire at the original moment, broadcasting
// a second "party-starting" and kicking everyone back through the Ready
// handshake mid-movie.
//
// The fix has two parts:
//  1. HandlePlaybackControl("play") stamps ps.StartedAt and cancels the
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
		conns:        make(map[int64]*SafeConn),
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

// TestHandlePlaybackControl_PlayStampsStartedAt verifies that a manual
// host-play stamps ps.StartedAt on its first invocation. This is the
// other half of the double-fire fix: by stamping StartedAt here, the
// scheduled timer's dedup guard (above) becomes effective for the
// manual-play-before-schedule-fire path.
//
// We don't assert on broadcasts because mockPartyManager has no Hub
// (broadcasts to empty conns are no-ops). The behavioral guarantee is
// "first play stamps StartedAt", which the dedup test then verifies
// prevents double-firing.
func TestHandlePlaybackControl_PlayStampsStartedAt(t *testing.T) {
	m := mockPartyManager()

	code := "TESTPL"
	ps := &PartyState{
		Code:            code,
		HostUserID:      1,
		MaxParticipants: 5,
		Participants:    make(map[int64]*Participant),
		conns:           make(map[int64]*SafeConn),
		syncConns:       make(map[int64]*SafeConn),
		roomConns:       make(map[int64]*SafeConn),
		ChatHistory:     make([]ChatMessage, 0),
		Settings:        PartySettings{AllowPause: false},
		CreatedAt:       time.Now(),
		GroupState:      GroupStateIdle,
		StartedAt:       nil, // pre-condition: not yet started
	}
	ps.Participants[1] = &Participant{UserID: 1, Username: "host", IsHost: true, LastSeen: time.Now()}
	m.mu.Lock()
	m.parties[code] = ps
	m.mu.Unlock()

	if err := m.HandlePlaybackControl(code, 1, "play", 0); err != nil {
		t.Fatalf("HandlePlaybackControl(play) returned err: %v", err)
	}

	if ps.StartedAt == nil {
		t.Error("HandlePlaybackControl(play) did not stamp StartedAt; double-fire dedup will be ineffective")
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
		conns:        make(map[int64]*SafeConn),
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
