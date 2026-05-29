package watchparty

// ============================================================
// Sync Protocol V3 — Running/Paused model
// ============================================================
//
// This file implements the Phase 1 infrastructure for V3. It coexists with
// V2 (sync.go) during the rollout: V3 fields and goroutines are maintained
// alongside V2's tri-state machine, but no client currently reads V3's
// wire format. Step 4 of the execution plan flips a frontend feature flag
// to consume V3; step 5 deletes V2.
//
// The core insight: separate **intent** (Running vs Paused, global) from
// **readiness** (buffer state, per-peer). V2 conflated them as the
// `Waiting` group state; V3 doesn't have a Waiting state at all. When the
// host hits play, the server enters Running immediately and emits `tick`
// broadcasts at cfg.TickInterval. Each peer independently plays,
// rate-adjusts to catch up, or hard-seeks if hopelessly behind. Nobody
// waits for anyone.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// CurrentAbsMs is the party's canonical position at the moment of the call.
// In Running state, the anchor advances with wall-clock time. In Paused
// state, the anchor is frozen. Callers MUST hold ps.mu.
func (ps *PartyState) CurrentAbsMs() int64 {
	if !ps.Running {
		return ps.AnchorAbsMs
	}
	return ps.AnchorAbsMs + (time.Now().UnixMilli() - ps.AnchorServerMs)
}

// setAnchorLocked updates the party's position anchor and (optionally) its
// Running state. Called on request-play, request-pause, request-seek, and
// party-create. Bumps StateRevision so late-arriving state messages can be
// ordered against tick broadcasts. Callers MUST hold ps.mu.
func (ps *PartyState) setAnchorLocked(absMs int64, running bool) {
	ps.AnchorAbsMs = absMs
	ps.AnchorServerMs = time.Now().UnixMilli()
	ps.Running = running
}

// ============================================================
// Tick broadcaster
// ============================================================

// startTickLoopLocked spawns the per-party tick goroutine if one isn't
// already running. Idempotent: safe to call on every Running transition.
// Callers MUST hold ps.mu.
func (m *Manager) startTickLoopLocked(ps *PartyState) {
	if ps.tickCancel != nil {
		return // already running
	}
	ctx, cancel := context.WithCancel(context.Background())
	ps.tickCancel = cancel
	go m.tickLoop(ctx, ps)
}

// stopTickLoopLocked halts the per-party tick goroutine if one is running.
// Safe to call if no loop is active. Callers MUST hold ps.mu.
func (m *Manager) stopTickLoopLocked(ps *PartyState) {
	if ps.tickCancel != nil {
		ps.tickCancel()
		ps.tickCancel = nil
	}
}

// tickLoop is the per-party goroutine that emits `tick` broadcasts at
// cfg.TickInterval while the party is Running. Owned by ps.tickCancel.
//
// The loop re-reads ps.Running and ps.CurrentAbsMs() under ps.mu on every
// iteration — if the anchor is reset by a seek, the next tick already
// carries the new position without any explicit coordination here.
func (m *Manager) tickLoop(ctx context.Context, ps *PartyState) {
	interval := m.cfg.TickInterval
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	t := time.NewTicker(interval)
	defer t.Stop()

	slog.Debug("v3 tick loop started", "code", ps.Code, "interval", interval)
	defer slog.Debug("v3 tick loop stopped", "code", ps.Code)

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			// Re-check cancellation before doing the broadcast work. The
			// ticker can fire concurrently with stopTickLoopLocked: ctx is
			// cancelled but t.C's pending tick has already been delivered
			// to this case. Without this guard we'd acquire ps.mu and
			// write to conns that EndParty is about to close.
			if ctx.Err() != nil {
				return
			}
			m.emitTick(ps)
		}
	}
}

// emitTick builds and broadcasts a single tick. If the party has
// transitioned to Paused since the goroutine last checked, this is a
// no-op and the loop will exit on the next ctx.Done or the next
// stopTickLoopLocked call.
func (m *Manager) emitTick(ps *PartyState) {
	ps.mu.Lock()
	if !ps.Running {
		ps.mu.Unlock()
		return
	}
	msg := map[string]interface{}{
		"type": "tick",
		"payload": map[string]interface{}{
			"abs_ms":        ps.CurrentAbsMs(),
			"server_now_ms": time.Now().UnixMilli(),
			"rev":           ps.StateRevision,
		},
	}
	ps.mu.Unlock()
	m.broadcastToSyncPeers(ps, msg)
}

// ============================================================
// Sync-socket broadcast helper
// ============================================================

// broadcastToSyncPeers sends a message to every connection in
// ps.syncConns. Takes ps.mu internally (unlike broadcastToPartyLocked,
// which requires the caller to hold it) — tick emission is the hot path
// and shouldn't make callers manage locking. Failed writes are logged;
// the connection will be cleaned up by its own read loop's disconnect
// handler.
func (m *Manager) broadcastToSyncPeers(ps *PartyState, msg map[string]interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Warn("v3: marshal sync msg failed", "err", err, "code", ps.Code)
		return
	}
	ps.mu.Lock()
	conns := make([]*SafeConn, 0, len(ps.syncConns))
	for _, c := range ps.syncConns {
		conns = append(conns, c)
	}
	ps.mu.Unlock()
	// 2026-05-25 — reset write deadline before each conn write to
	// prevent the silent ErrDeadlineExceeded class of bug (see
	// broadcastWriteTimeout comment in manager.go). Sync ticks fire
	// frequently (every ~250ms while Running) so this is the most
	// affected path of the four broadcast helpers.
	deadline := time.Now().Add(broadcastWriteTimeout)
	for _, c := range conns {
		_ = c.SetWriteDeadline(deadline)
		if err := c.WriteMessage(1 /*TextMessage*/, data); err != nil {
			slog.Debug("v3: sync write failed", "err", err, "code", ps.Code)
		}
	}
}

// broadcastToRoomPeers is the symmetric helper for the room-socket pool
// (chat, reactions, presence). Same semantics as broadcastToSyncPeers.
func (m *Manager) broadcastToRoomPeers(ps *PartyState, msg map[string]interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Warn("v3: marshal room msg failed", "err", err, "code", ps.Code)
		return
	}
	ps.mu.Lock()
	conns := make([]*SafeConn, 0, len(ps.roomConns))
	for _, c := range ps.roomConns {
		conns = append(conns, c)
	}
	ps.mu.Unlock()
	// 2026-05-25 — reset write deadline before each broadcast write.
	// See broadcastWriteTimeout doc in manager.go for the production
	// bug this prevents (host gets initial party-state with 10s
	// deadline set by the WS handler, deadline expires, every
	// subsequent broadcast write silently fails with
	// ErrDeadlineExceeded).
	deadline := time.Now().Add(broadcastWriteTimeout)
	for _, c := range conns {
		_ = c.SetWriteDeadline(deadline)
		if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
			slog.Debug("v3: room write failed", "err", err, "code", ps.Code)
		}
	}
}

// ============================================================
// V3 Membership — two-socket model
// ============================================================
//
// The room socket carries membership, chat, reactions, presence. Open it
// first; it's the gate that enforces party-code validity, max-participants,
// and the participant record in the DB.
//
// The sync socket carries tick/pause/seek/heartbeat/time-sync. Open it
// second; it requires an existing participant record (established by the
// room socket). This keeps sync traffic on a dedicated pipe that chat
// spam can never contend with.

// JoinPartyV3Room registers a room-socket connection for a user joining a
// party. Creates/updates the Participant record. Returns the party state
// for the caller to build an initial room snapshot (participants, chat
// history) from. Send the initial snapshot over the returned conn.
func (m *Manager) JoinPartyV3Room(code string, userID int64, username string, sc *SafeConn) (*PartyState, error) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return nil, fmt.Errorf("party not found or has ended")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Existing participant → reconnect path. Refresh conn and LastSeen.
	if existing, ok := ps.Participants[userID]; ok {
		ps.roomConns[userID] = sc
		existing.LastSeen = time.Now()
		// 2026-05-25 — if this is the host reconnecting within the
		// grace window after their WS dropped, clear the disconnect
		// marker so the background ender goroutine no-ops on its
		// next check. Without this clear, a host who reload-recovers
		// at 89s would still see their party reaped at 90s.
		if userID == ps.HostUserID && ps.HostDisconnectedAt != nil {
			slog.Info("v3: host reconnected within grace window", "code", code, "elapsed_ms", time.Since(*ps.HostDisconnectedAt).Milliseconds())
			ps.HostDisconnectedAt = nil
		}
		slog.Info("v3: participant reconnected (room)", "code", code, "user_id", userID)
		return ps, nil
	}

	// New participant: enforce max, insert.
	if len(ps.Participants) >= ps.MaxParticipants {
		return nil, fmt.Errorf("party is full (%d/%d)", len(ps.Participants), ps.MaxParticipants)
	}
	ps.Participants[userID] = &Participant{
		UserID:      userID,
		Username:    username,
		IsHost:      userID == ps.HostUserID,
		IsBuffering: false,
		Suspensions: make(map[string]bool),
		LastSeen:    time.Now(),
	}
	ps.roomConns[userID] = sc

	// DB participant tracking. Best-effort — a DB hiccup shouldn't drop
	// the user from the in-memory party.
	if ps.dbID > 0 && m.queries != nil {
		if err := m.queries.InsertParticipant(context.Background(), ps.dbID, userID); err != nil {
			slog.Warn("v3: insert participant failed", "err", err, "code", code)
		}
	}

	// Announce to other room peers (exclude the joiner). Include `ready`
	// so reconnecting peers don't get their existing ready state erased
	// by the frontend's participant-join handler (which was overwriting
	// the local entry with just user_id+username — wiping ready=true).
	joinMsg, _ := json.Marshal(map[string]interface{}{
		"type": "participant-join",
		"payload": map[string]interface{}{
			"user_id":  userID,
			"username": username,
			"ready":    ps.Participants[userID].Ready,
		},
	})
	// 2026-05-25 fix — set write deadline before each conn write.
	// Without this, the host's stale 10s deadline from the initial
	// party-state send had already expired by the time a brother joined
	// (even seconds later), so this WriteMessage silently failed with
	// ErrDeadlineExceeded and the host never saw the participant-join
	// broadcast (even though server-side roomConns and Participants
	// were correctly populated).
	joinDeadline := time.Now().Add(broadcastWriteTimeout)
	for uid, c := range ps.roomConns {
		if uid == userID || c == nil {
			continue
		}
		_ = c.SetWriteDeadline(joinDeadline)
		_ = c.WriteMessage(websocket.TextMessage, joinMsg)
	}

	slog.Info("v3: participant joined (room)", "code", code, "user_id", userID, "username", username)
	return ps, nil
}

// JoinPartyV3Sync registers a sync-socket connection. Requires the user
// already be a participant (i.e. they opened the room socket first).
// Sends a `hello` snapshot so the client can enter Running or Paused
// immediately, without needing a tick round-trip to know where the party
// is.
func (m *Manager) JoinPartyV3Sync(code string, userID int64, sc *SafeConn) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return fmt.Errorf("party not found or has ended")
	}

	ps.mu.Lock()
	if _, ok := ps.Participants[userID]; !ok {
		ps.mu.Unlock()
		return fmt.Errorf("not a participant — open /ws/party-room first")
	}
	ps.syncConns[userID] = sc

	// Build hello inside the lock so the snapshot is consistent.
	hello := m.buildHelloLocked(ps)
	ps.mu.Unlock()

	data, err := json.Marshal(hello)
	if err != nil {
		return nil // non-fatal — tick broadcasts will still land
	}
	// 2026-05-25 — set fresh write deadline (see broadcastWriteTimeout
	// doc in manager.go for the bug class this prevents).
	_ = sc.SetWriteDeadline(time.Now().Add(broadcastWriteTimeout))
	_ = sc.WriteMessage(websocket.TextMessage, data)
	slog.Info("v3: participant joined (sync)", "code", code, "user_id", userID)
	return nil
}

// LeavePartyV3Room and LeavePartyV3Sync remove a connection from the
// respective pool. Used on socket disconnect. Leaving the room socket
// also removes the participant; leaving the sync socket does not.

func (m *Manager) LeavePartyV3Sync(code string, userID int64) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return
	}
	ps.mu.Lock()
	delete(ps.syncConns, userID)
	ps.mu.Unlock()
}

// LeavePartyV3SyncIfConn is the conn-identity-guarded variant of
// LeavePartyV3Sync. It removes the sync conn ONLY when ps.syncConns[userID]
// is still the SAME conn that is leaving (sc). This mirrors the room
// socket's LeavePartyV3RoomIfConn guard.
//
// 2026-05-29 MED-integration fix (finding 1): the defer-cleanup path in
// PartyWSHandlerV3Sync.ServeHTTP previously called the unconditional
// LeavePartyV3Sync. When a user opened a second sync socket, the new
// socket's JoinPartyV3Sync overwrote ps.syncConns[userID]; when the OLD
// socket's read pump then died, its deferred leave would delete(syncConns,
// userID) and evict the freshly-reconnected (active) conn — silently
// dropping that peer off all tick/pause/seek broadcasts. Comparing conn
// identity stops the dead socket from clobbering the live one.
//
// nil sc falls back to the unconditional delete (kept for callers without
// a SafeConn handle, e.g. tests).
func (m *Manager) LeavePartyV3SyncIfConn(code string, userID int64, sc *SafeConn) {
	if sc == nil {
		m.LeavePartyV3Sync(code, userID)
		return
	}
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return
	}
	ps.mu.Lock()
	if current := ps.syncConns[userID]; current == nil || current == sc {
		// Either we still own the slot, or it's already empty — safe to
		// remove. A newer conn holding the slot is left untouched.
		delete(ps.syncConns, userID)
	}
	ps.mu.Unlock()
}

// LeavePartyV3RoomIfConn is the conn-identity-guarded variant of
// LeavePartyV3Room. Skips the leave when ps.roomConns[userID] != sc —
// i.e. when this connection was already replaced by a fresher one
// (typical scenario: user opened a second tab, the new tab's
// join-party overwrote the slot, the old tab's read pump dies later
// and would otherwise clobber the active tab's conn).
//
// Post-M7-audit H2 fix. The defer cleanup path in
// PartyWSHandlerV3Room.ServeHTTP uses this; the EXPLICIT
// `leave-party` message still uses LeavePartyV3Room (no conn check)
// because that's a deliberate user action.
//
// 2026-05-25 — defer-cleanup callers now route through the GRACEFUL
// path so host disconnects don't immediately reap the party. See
// LeavePartyV3RoomGraceful for the grace-period semantics. Explicit
// leave-party messages still use the immediate path.
//
// nil sc behaves like LeavePartyV3RoomGraceful (always proceeds) —
// kept for callers that don't have a SafeConn handle (e.g. tests).
func (m *Manager) LeavePartyV3RoomIfConn(code string, userID int64, sc *SafeConn) error {
	if sc == nil {
		return m.LeavePartyV3RoomGraceful(code, userID)
	}
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return nil
	}
	ps.mu.Lock()
	current := ps.roomConns[userID]
	if current != nil && current != sc {
		// A newer conn holds the slot — don't clobber it.
		ps.mu.Unlock()
		return nil
	}
	ps.mu.Unlock()
	return m.LeavePartyV3RoomGraceful(code, userID)
}

// LeavePartyV3RoomGraceful is the implicit-disconnect variant of
// LeavePartyV3Room. For guests it behaves identically (remove from
// participants, broadcast participant-left). For the HOST it does NOT
// immediately end the party — instead it:
//  1. Removes the room conn (so broadcasts don't try to write to it)
//  2. Sets ps.HostDisconnectedAt = now
//  3. Spawns a goroutine that ends the party after HostDisconnectGracePeriod
//     IF and ONLY IF HostDisconnectedAt is still set at that point
//     (i.e. host hasn't reconnected via JoinPartyV3Room)
//
// 2026-05-25 — added in response to "guests can't join, party died at
// 90s" production diagnosis. Host's WS hit a proxy/idle timeout; before
// this change, that immediately ended the entire party. Now the host
// has HostDisconnectGracePeriod to reconnect (via reload, network
// recovery, etc.) before guests get kicked.
func (m *Manager) LeavePartyV3RoomGraceful(code string, userID int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return nil
	}

	ps.mu.Lock()
	participant, ok := ps.Participants[userID]
	if !ok {
		ps.mu.Unlock()
		return nil
	}
	isHost := ps.HostUserID == userID
	username := participant.Username

	if isHost {
		// Don't delete the Participant entry — we want the host slot
		// to remain reserved during the grace window so JoinPartyV3Room
		// takes the "reconnect" path (which clears HostDisconnectedAt).
		// We DO drop the room conn so broadcasts don't write to a dead
		// pipe.
		delete(ps.roomConns, userID)
		now := time.Now()
		ps.HostDisconnectedAt = &now
		slog.Info("v3: host room disconnect — starting grace timer", "code", code, "grace_period", HostDisconnectGracePeriod)
		ps.mu.Unlock()

		// Spawn a one-shot ender. Captures the *PartyState pointer +
		// the timestamp by value so a colliding code-reuse (party
		// ended, same code re-issued to a different party within 90s)
		// can't accidentally end the new party — we compare pointer
		// identity in checkHostGraceExpiry rather than re-looking-up
		// by code.
		go m.checkHostGraceExpiry(code, ps, now)
		return nil
	}

	// Non-host: same as the immediate variant — fully remove + announce.
	_ = m.leaveVoiceLocked(ps, userID)
	delete(ps.Participants, userID)
	delete(ps.roomConns, userID)
	delete(ps.syncConns, userID)
	if ps.dbID > 0 && m.queries != nil {
		if err := m.queries.UpdateParticipantLeft(context.Background(), ps.dbID, userID); err != nil {
			slog.Warn("v3: update participant left failed", "err", err, "code", code)
		}
	}
	m.broadcastToRoomPeersLocked(ps, map[string]interface{}{
		"type": "participant-left",
		"payload": map[string]interface{}{
			"user_id":  userID,
			"username": username,
		},
	})
	ps.mu.Unlock()
	return nil
}

// checkHostGraceExpiry runs in a background goroutine after the host's
// room WS drops. After HostDisconnectGracePeriod, it checks if the host
// has reconnected (HostDisconnectedAt cleared by JoinPartyV3Room) and
// ends the party only if not.
//
// Two staleness guards:
//  1. `expectedPS` is the pointer to the PartyState we captured at
//     schedule time. If the party already ended and the code was
//     re-issued to a different PartyState, the m.parties lookup
//     below would surface the NEW one — comparing pointer identity
//     stops us from accidentally ending it.
//  2. `expectedDisconnectTime` distinguishes back-to-back disconnects
//     of the SAME party (host dropped → reconnected → dropped again).
//     Only the LATEST disconnect's goroutine should be the one to
//     finally end the party.
func (m *Manager) checkHostGraceExpiry(code string, expectedPS *PartyState, expectedDisconnectTime time.Time) {
	time.Sleep(HostDisconnectGracePeriod)

	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return // party already ended through some other path
	}
	if ps != expectedPS {
		// Code was recycled to a different party in the meantime —
		// our timer doesn't own that one.
		return
	}

	ps.mu.Lock()
	if ps.HostDisconnectedAt == nil {
		// Host reconnected within the grace window — nothing to do.
		ps.mu.Unlock()
		slog.Info("v3: host grace timer found host reconnected", "code", code)
		return
	}
	if !ps.HostDisconnectedAt.Equal(expectedDisconnectTime) {
		// A more recent disconnect supersedes us; the newer goroutine
		// owns the timer.
		ps.mu.Unlock()
		return
	}
	ps.mu.Unlock()

	slog.Info("v3: host grace period expired without reconnect, ending party", "code", code)
	_ = m.endPartyInternal(code, ps)
}

// LeavePartyV3Room removes the participant entirely, mirroring V2's
// LeaveParty semantics (host-leaving ends the party). Also removes any
// lingering sync-socket conn for that user, so one socket dying cleans
// up the other.
func (m *Manager) LeavePartyV3Room(code string, userID int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return nil
	}

	ps.mu.Lock()
	participant, ok := ps.Participants[userID]
	if !ok {
		ps.mu.Unlock()
		return nil
	}
	username := participant.Username
	isHost := ps.HostUserID == userID

	// M7 — voice presence is bound to the room socket. Dropping the
	// socket means we're leaving the voice call too. Broadcast
	// voice-peer-left before we remove the conn so the broadcast lands
	// on the OTHER peers (not on us, since broadcastToRoomPeersExcludeLocked
	// already excludes the leaver). Idempotent; no-op if not in voice.
	_ = m.leaveVoiceLocked(ps, userID)

	delete(ps.Participants, userID)
	delete(ps.roomConns, userID)
	delete(ps.syncConns, userID)

	if ps.dbID > 0 && m.queries != nil {
		if err := m.queries.UpdateParticipantLeft(context.Background(), ps.dbID, userID); err != nil {
			slog.Warn("v3: update participant left failed", "err", err, "code", code)
		}
	}

	if isHost {
		ps.mu.Unlock()
		slog.Info("v3: host left, ending party", "code", code)
		return m.endPartyInternal(code, ps)
	}

	// Announce departure on the room socket.
	m.broadcastToRoomPeersLocked(ps, map[string]interface{}{
		"type": "participant-left",
		"payload": map[string]interface{}{
			"user_id":  userID,
			"username": username,
		},
	})
	ps.mu.Unlock()
	return nil
}

// broadcastToRoomPeersLocked is like broadcastToRoomPeers but assumes the
// caller already holds ps.mu. Needed by LeavePartyV3Room which already
// holds the lock when it needs to broadcast.
func (m *Manager) broadcastToRoomPeersLocked(ps *PartyState, msg map[string]interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	// 2026-05-25 — reset write deadline before each conn write to
	// prevent the silent ErrDeadlineExceeded class of bug (see
	// broadcastWriteTimeout comment in manager.go).
	deadline := time.Now().Add(broadcastWriteTimeout)
	for _, c := range ps.roomConns {
		if c == nil {
			continue
		}
		_ = c.SetWriteDeadline(deadline)
		_ = c.WriteMessage(websocket.TextMessage, data)
	}
}

// broadcastToSyncPeersLocked is the lock-held variant of broadcastToSyncPeers,
// used by intent handlers (pause, seek) that already hold ps.mu and would
// deadlock if they called the unlocked variant.
//
// The tradeoff: we hold ps.mu across the socket writes. For step 2's rare
// intent messages (pause/seek fire on explicit user action, not every tick)
// this is fine — a slow peer's write timeout of partyWriteWait (10s) would
// block the party, but that's strictly better than the status quo, which
// was an indefinite deadlock. A Phase 3 refactor could move writes onto
// per-conn outbound queues.
func (m *Manager) broadcastToSyncPeersLocked(ps *PartyState, msg map[string]interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	// 2026-05-25 — reset write deadline before each conn write to
	// prevent silent ErrDeadlineExceeded (see broadcastWriteTimeout
	// comment in manager.go).
	deadline := time.Now().Add(broadcastWriteTimeout)
	for _, c := range ps.syncConns {
		if c == nil {
			continue
		}
		_ = c.SetWriteDeadline(deadline)
		_ = c.WriteMessage(websocket.TextMessage, data)
	}
}

// ============================================================
// V3 Hello
// ============================================================

// buildHelloLocked constructs the initial-state message a new sync-socket
// peer receives on connect. It carries everything the client needs to
// enter Running or Paused without a round-trip: canonical position,
// server wall-clock (for offset calculation bootstrapping), revision,
// and the media descriptor.
//
// Caller MUST hold ps.mu.
func (m *Manager) buildHelloLocked(ps *PartyState) map[string]interface{} {
	return map[string]interface{}{
		"type": "hello",
		"payload": map[string]interface{}{
			"abs_ms":        ps.CurrentAbsMs(),
			"server_now_ms": time.Now().UnixMilli(),
			"running":       ps.Running,
			"rev":           ps.StateRevision,
			"media": map[string]interface{}{
				"media_item_id": ps.MediaItemID,
				"episode_id":    ps.EpisodeID,
				"media_title":   ps.MediaTitle,
				"media_poster":  ps.MediaPoster,
			},
			"tick_interval_ms":   m.cfg.TickInterval.Milliseconds(),
			"drift_ignore_ms":    m.cfg.V3DriftIgnoreMs,
			"drift_hard_seek_ms": m.cfg.V3DriftHardSeekMs,
			"catch_up_rate":      m.cfg.V3CatchUpRate,
			"ease_back_rate":     m.cfg.V3EaseBackRate,
		},
	}
}

// ============================================================
// V3 Intent handlers — request-play / pause / seek
// ============================================================
//
// These are the write-path equivalents of V2's HandlePlaybackControl.
// V3 separates the three intents into named methods so the per-intent
// authorization rules are visible at a glance.

// HandleRequestPlay transitions the party to Running. Resumes from the
// current anchor (no re-seek). Only the host may issue play in Phase 1
// (a future phase adds democratic mode).
func (m *Manager) HandleRequestPlay(code string, userID int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return fmt.Errorf("party not found")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// 2026-05-29 MED-integration fix (finding 2): require the sender to be
	// a CURRENT participant before honoring any intent. The host/AllowPause
	// checks below compare against a stored HostUserID / a global setting,
	// neither of which proves the sender is still in the party. A former
	// participant (or a departed host) whose sync socket outlived their
	// room membership could otherwise keep driving playback. The host
	// always has a Participant record (created in JoinPartyV3Room), so this
	// does not block the legitimate host path.
	if _, ok := ps.Participants[userID]; !ok {
		return fmt.Errorf("not a participant")
	}

	if ps.HostUserID != userID {
		return fmt.Errorf("only the host can start playback")
	}
	if ps.Running {
		return nil // no-op, already running
	}

	// M5 — spoiler-free start gate. The FIRST play of a session is held
	// until every non-host participant has marked themselves Ready.
	// Subsequent plays (snack break resume, etc.) bypass the gate via
	// HasEverPlayed=true. Host is never blocked on their own readiness
	// (the host clicking play implies they're ready).
	//
	// The error message lists who's still pending so the host's UI can
	// show "waiting for: Sarah, Adam". The frontend renders this as a
	// non-fatal toast — the host can either wait for the readies or
	// toggle the setting off and play.
	if !ps.HasEverPlayed && ps.Settings.SpoilerFreeStart {
		var notReady []string
		for _, p := range ps.Participants {
			if p == nil || p.IsHost {
				continue
			}
			if !p.Ready {
				notReady = append(notReady, p.Username)
			}
		}
		if len(notReady) > 0 {
			return fmt.Errorf("waiting for: %s", strings.Join(notReady, ", "))
		}
	}

	ps.setAnchorLocked(ps.AnchorAbsMs, true) // resume from wherever we paused
	ps.HasEverPlayed = true
	m.bumpRevLocked(ps)
	m.startTickLoopLocked(ps)

	slog.Info("v3: party → Running", "code", code, "abs_ms", ps.AnchorAbsMs, "rev", ps.StateRevision)
	// No explicit "play" broadcast; the first `tick` in ≤TickInterval is
	// the signal. Clients' hello-or-most-recent-tick tells them to play.
	// But for instant feedback we emit a synthetic tick right now:
	m.emitTickLocked(ps)
	return nil
}

// HandleRequestPause transitions the party to Paused at the given
// absolute position. If atAbsMs < 0, pause at the current canonical
// position. Allowed by the host always; allowed by any participant if
// Settings.AllowPause is true.
func (m *Manager) HandleRequestPause(code string, userID int64, atAbsMs int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return fmt.Errorf("party not found")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// 2026-05-29 MED-integration fix (finding 2): pause is the most exposed
	// intent — when Settings.AllowPause is true the host check below passes
	// for ANY userID, so a former participant with a lingering sync socket
	// could pause the party for everyone. Require current membership first.
	if _, ok := ps.Participants[userID]; !ok {
		return fmt.Errorf("not a participant")
	}

	if ps.HostUserID != userID && !ps.Settings.AllowPause {
		return fmt.Errorf("only the host can pause")
	}

	pos := atAbsMs
	if pos < 0 {
		pos = ps.CurrentAbsMs()
	}
	ps.setAnchorLocked(pos, false)
	m.bumpRevLocked(ps)
	m.stopTickLoopLocked(ps)

	slog.Info("v3: party → Paused", "code", code, "abs_ms", pos, "rev", ps.StateRevision, "by", userID)
	// MUST use the Locked variant here — HandleRequestPause holds ps.mu
	// via defer; calling the unlocked broadcaster would deadlock on
	// re-entrant Lock. Same applies to HandleRequestSeek below.
	m.broadcastToSyncPeersLocked(ps, map[string]interface{}{
		"type": "pause",
		"payload": map[string]interface{}{
			"abs_ms": pos,
			"rev":    ps.StateRevision,
			"by":     userID,
		},
	})
	return nil
}

// HandleRequestSeek moves the canonical position to toAbsMs. Running
// state is preserved — if Running, ticks continue from the new anchor.
// Host-only (seek permission is not democratized in Phase 1).
func (m *Manager) HandleRequestSeek(code string, userID int64, toAbsMs int64) error {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return fmt.Errorf("party not found")
	}
	if toAbsMs < 0 {
		return fmt.Errorf("seek target must be non-negative")
	}
	// Upper-bound at 24h in ms — anything beyond that is nonsense for media
	// playback and an unbounded toAbsMs (e.g. math.MaxInt64) would overflow
	// once CurrentAbsMs() adds elapsed wall-clock time, wrapping to negative
	// and propagating absurd tick positions to every peer.
	const maxSeekMs = 24 * 60 * 60 * 1000
	if toAbsMs > maxSeekMs {
		return fmt.Errorf("seek target out of range")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// 2026-05-29 MED-integration fix (finding 2): require current
	// membership before the host check (see HandleRequestPlay for the
	// rationale — a stale HostUserID alone does not prove the sender is
	// still in the party).
	if _, ok := ps.Participants[userID]; !ok {
		return fmt.Errorf("not a participant")
	}

	if ps.HostUserID != userID {
		return fmt.Errorf("only the host can seek")
	}

	ps.setAnchorLocked(toAbsMs, ps.Running)
	m.bumpRevLocked(ps)

	slog.Info("v3: party seek", "code", code, "abs_ms", toAbsMs, "rev", ps.StateRevision, "running", ps.Running)
	// Locked variant — we hold ps.mu here.
	m.broadcastToSyncPeersLocked(ps, map[string]interface{}{
		"type": "seek",
		"payload": map[string]interface{}{
			"abs_ms":  toAbsMs,
			"rev":     ps.StateRevision,
			"by":      userID,
			"running": ps.Running,
		},
	})
	// If still Running, a fresh tick immediately reinforces the new anchor
	// for any peer that missed the seek message.
	if ps.Running {
		m.emitTickLocked(ps)
	}
	return nil
}

// HandleV3Heartbeat is informational only. Updates LastSeen so presence
// timeouts don't fire on an active peer. Does NOT mutate the canonical
// position — peers cannot drag the party around by lying about where
// they are.
func (m *Manager) HandleV3Heartbeat(code string, userID int64, absMs int64, readyState int) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return
	}
	ps.mu.Lock()
	if p, ok := ps.Participants[userID]; ok {
		p.LastSeen = time.Now()
		// Keep IsBuffering in sync with readyState for presence display.
		// readyState < 3 (HAVE_FUTURE_DATA) means not smoothly playable.
		p.IsBuffering = readyState < 3
	}
	ps.mu.Unlock()
}

// emitTickLocked is the hold-the-lock variant of emitTick — used when a
// caller already has ps.mu (e.g. inside an intent handler) and wants a
// synthetic tick emitted for immediate client feedback, before the next
// scheduled tick interval.
func (m *Manager) emitTickLocked(ps *PartyState) {
	if !ps.Running {
		return
	}
	msg := map[string]interface{}{
		"type": "tick",
		"payload": map[string]interface{}{
			"abs_ms":        ps.CurrentAbsMs(),
			"server_now_ms": time.Now().UnixMilli(),
			"rev":           ps.StateRevision,
		},
	}
	// broadcast without releasing the lock — acceptable because writes
	// don't block on anything else in the party, and this is called on
	// the same goroutine that just mutated the anchor.
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	// 2026-05-25 — reset write deadline (see broadcastWriteTimeout).
	deadline := time.Now().Add(broadcastWriteTimeout)
	for _, c := range ps.syncConns {
		if c == nil {
			continue
		}
		_ = c.SetWriteDeadline(deadline)
		_ = c.WriteMessage(websocket.TextMessage, data)
	}
}
