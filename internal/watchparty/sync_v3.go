package watchparty

// ============================================================
// Sync Protocol V3 — Running/Paused model
// ============================================================
//
// The only sync protocol since the 2026-06 V2 deletion ("step 5" of the
// V3 execution plan; the V2 tri-state machine previously lived in
// sync.go, which now retains only the shared time-sync pieces).
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
	"log/slog"
	"strings"
	"time"
)

// CurrentAbsMs is the party's canonical position at the moment of the call.
// In Running state, the anchor advances with elapsed time since the anchor
// was set (monotonic — see PartyState.AnchorServerAt). In Paused state, the
// anchor is frozen. Callers MUST hold ps.mu.
func (ps *PartyState) CurrentAbsMs() int64 {
	if !ps.Running {
		return ps.AnchorAbsMs
	}
	return ps.AnchorAbsMs + time.Since(ps.AnchorServerAt).Milliseconds()
}

// setAnchorLocked updates the party's position anchor and (optionally) its
// Running state. Called on request-play, request-pause, request-seek, and
// party-create. Bumps StateRevision so late-arriving state messages can be
// ordered against tick broadcasts. Callers MUST hold ps.mu.
func (ps *PartyState) setAnchorLocked(absMs int64, running bool) {
	ps.AnchorAbsMs = absMs
	ps.AnchorServerAt = time.Now()
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
//
// 2026-06 — single lock acquisition. The old version built the payload
// under ps.mu, unlocked, then re-locked to snapshot the conn list into a
// fresh slice — a dance that existed only because writes used to block.
// Send never blocks, so the lock can be held across the whole emit.
func (m *Manager) emitTick(ps *PartyState) {
	ps.mu.Lock()
	m.emitTickLocked(ps)
	ps.mu.Unlock()
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
//
// Backward-compatible shim: joins as a primary-screen (non-companion)
// participant. New callers that know whether the upgrade was a mobile
// companion should call JoinPartyV3RoomCompanion directly.
func (m *Manager) JoinPartyV3Room(code string, userID int64, username string, sc *SafeConn) (*PartyState, error) {
	return m.JoinPartyV3RoomCompanion(code, userID, username, false, sc)
}

// JoinPartyV3RoomCompanion is JoinPartyV3Room plus the mobile-companion
// presence flag. companion=true marks the Participant as a phone
// "second-screen" join (no video player / no sync socket); companion=false
// is the exact behavior of the historical JoinPartyV3Room.
//
// The flag is set on first join and refreshed on reconnect, so a user who
// drops and reconnects from the same surface keeps an accurate badge, and a
// user who moves from desktop to phone (or vice-versa) gets re-flagged to
// match their current connection rather than being stuck on a stale value.
func (m *Manager) JoinPartyV3RoomCompanion(code string, userID int64, username string, companion bool, sc *SafeConn) (*PartyState, error) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return nil, errUser("party not found or has ended")
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Existing participant → reconnect path. Refresh conn and LastSeen.
	if existing, ok := ps.Participants[userID]; ok {
		ps.roomConns[userID] = sc
		existing.LastSeen = time.Now()
		// Refresh the companion flag to match the current connection's
		// surface (a reconnect may arrive from a different device than the
		// original join).
		//
		// SECURITY: `companion` is a self-asserted client hint (the
		// ?companion=1 upgrade param). It is a PRESENTATION flag only — it
		// drives the "on phone" UI badge and nothing else. It is NOT
		// authenticated and MUST NOT gate any authorization or capability
		// decision; identity and permissions come from the JWT, never this.
		existing.Companion = companion
		// 2026-05-25 — if this is the host reconnecting within the
		// grace window after their WS dropped, clear the disconnect
		// marker so the background ender goroutine no-ops on its
		// next check. Without this clear, a host who reload-recovers
		// at 89s would still see their party reaped at 90s.
		if userID == ps.HostUserID && ps.HostDisconnectedAt != nil {
			slog.Info("v3: host reconnected within grace window", "code", code, "elapsed_ms", time.Since(*ps.HostDisconnectedAt).Milliseconds())
			ps.HostDisconnectedAt = nil
		}
		// A returning host may be the missing piece of an overdue
		// scheduled start (HandleRequestPlay requires the host to be a
		// current participant) — 2026-06 review.
		if userID == ps.HostUserID {
			m.maybeRetryScheduledStartLocked(ps)
		}
		slog.Info("v3: participant reconnected (room)", "code", code, "user_id", userID)
		return ps, nil
	}

	// New participant: enforce max, insert.
	if len(ps.Participants) >= ps.MaxParticipants {
		return nil, errUser("party is full (%d/%d)", len(ps.Participants), ps.MaxParticipants)
	}
	ps.Participants[userID] = &Participant{
		UserID:      userID,
		Username:    username,
		IsHost:      userID == ps.HostUserID,
		IsBuffering: false,
		LastSeen:    time.Now(),
		Companion:   companion,
		JoinedAt:    time.Now(),
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
			"user_id":   userID,
			"username":  username,
			"ready":     ps.Participants[userID].Ready,
			"companion": ps.Participants[userID].Companion,
		},
	})
	// Non-blocking enqueue per conn (write pump owns the socket; the
	// pump sets a fresh deadline per write — see broadcastWriteTimeout
	// for the stale-deadline bug class this design retires).
	for uid, c := range ps.roomConns {
		if uid == userID || c == nil {
			continue
		}
		_ = c.Send(joinMsg)
	}

	// A first-time host join may be the missing piece of an overdue
	// scheduled start — the countdown can fire before the host's room
	// socket connects, and HandleRequestPlay rejects non-participants
	// (2026-06 review).
	if userID == ps.HostUserID {
		m.maybeRetryScheduledStartLocked(ps)
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
		return errUser("party not found or has ended")
	}

	ps.mu.Lock()
	if _, ok := ps.Participants[userID]; !ok {
		ps.mu.Unlock()
		return errUser("not a participant — open /ws/party-room first")
	}
	ps.syncConns[userID] = sc

	// Build AND enqueue the hello inside the lock. Registering the conn
	// makes it eligible for tick broadcasts immediately; enqueueing the
	// hello in the same critical section guarantees it is the FIRST frame
	// in this conn's outbox, so no tick can precede (or carry newer state
	// than) the snapshot (2026-06 review — the old direct write could
	// also overtake queued frames on writeMu, inverting FIFO). Send never
	// blocks, so holding ps.mu here is fine.
	hello := m.buildHelloLocked(ps)
	if data, err := json.Marshal(hello); err == nil {
		_ = sc.Send(data)
	}
	ps.mu.Unlock()

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
// immediately act — instead it:
//  1. Removes the room conn (so broadcasts don't try to write to it)
//  2. Sets ps.HostDisconnectedAt = now
//  3. Spawns a goroutine that, after HostDisconnectGracePeriod — IF and
//     ONLY IF HostDisconnectedAt is still set at that point (i.e. host
//     hasn't reconnected via JoinPartyV3Room) — hands the party to the
//     most senior remaining participant, or ends it when nobody
//     eligible remains (2026-08 host succession; reapExpiredHostGrace)
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
	// The leaver may have been the last not-ready blocker of an overdue
	// scheduled start (2026-06 review).
	m.maybeRetryScheduledStartLocked(ps)
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
	m.reapExpiredHostGrace(code, expectedPS, expectedDisconnectTime)
}

// reapExpiredHostGrace is checkHostGraceExpiry's post-sleep body, split
// out so tests can exercise the expiry decision without waiting out the
// real 90s grace period.
//
// 2026-08 — host succession. An expired grace used to end the party for
// everyone. Now the vanished host's reserved slot is cleared and the
// party is handed to the most senior remaining participant; only when
// nobody eligible remains does the party end (the pre-succession
// behavior). The host is genuinely gone by this point: the client's own
// room-reconnect backoff gives up after ~31s, well inside the 90s grace,
// and a host who returns later simply rejoins as a guest — the reconnect
// path keys on HostUserID, which is no longer theirs.
func (m *Manager) reapExpiredHostGrace(code string, expectedPS *PartyState, expectedDisconnectTime time.Time) {
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
	if ps.ending {
		// Party is already mid-teardown — the reap must not touch it
		// (see PartyState.ending; a promotion here could resurrect a
		// dying party).
		ps.mu.Unlock()
		return
	}
	if ps.HostDisconnectedAt == nil {
		// Nothing to reap: either the host reconnected within the grace
		// window, or a handoff already moved the crown (promotion clears
		// the marker too).
		ps.mu.Unlock()
		slog.Info("v3: host grace timer superseded — host reconnected or party already handed off", "code", code)
		return
	}
	if !ps.HostDisconnectedAt.Equal(expectedDisconnectTime) {
		// A more recent disconnect supersedes us; the newer goroutine
		// owns the timer.
		ps.mu.Unlock()
		return
	}

	// The grace is spent. Remove the vanished host like any leaver —
	// their entry was only reserved so a reconnect could reclaim the
	// crown, and that window is over — then try to hand the party on.
	staleHostID := ps.HostUserID
	staleHostName := ""
	if p, ok := ps.Participants[staleHostID]; ok {
		staleHostName = p.Username
	}
	// The host's ROOM socket is what died; their SYNC socket may still be
	// alive (the exact split that motivated the grace period). Capture
	// both before the map deletes so they can be closed after the lock is
	// released — once out of the maps, neither endPartyInternal nor any
	// broadcast can reach them, and an unclosed sync conn would keep its
	// write pump, read loop, and ping goroutine alive indefinitely while
	// the demoted host's player freezes on the last tick with no terminal
	// frame.
	staleRoomConn := ps.roomConns[staleHostID]
	staleSyncConn := ps.syncConns[staleHostID]
	// Idempotent; their voice presence died with the room socket.
	_ = m.leaveVoiceLocked(ps, staleHostID)
	delete(ps.Participants, staleHostID)
	delete(ps.roomConns, staleHostID)
	delete(ps.syncConns, staleHostID)
	if ps.dbID > 0 && m.queries != nil {
		if err := m.queries.UpdateParticipantLeft(context.Background(), ps.dbID, staleHostID); err != nil {
			slog.Warn("v3: update participant left failed", "err", err, "code", code)
		}
	}

	if m.promoteSuccessorLocked(ps, staleHostID, staleHostName, "disconnected") == nil {
		// Invites (2026-08 review, critical finding): a scheduled party
		// that hasn't started is a standing appointment, not an abandoned
		// room — the booking must survive its host closing the laptop.
		// Leave it registered (HostUserID still names the departed host,
		// so their rejoin via /p/{code} reclaims the crown) and let the
		// countdown timer fire on schedule; cleanupOnce carries the same
		// exemption and ages out overdue-unstarted parties.
		if ps.StartedAt == nil && ps.ScheduledStartAt != nil &&
			time.Now().Before(ps.ScheduledStartAt.Add(staleParticipantTimeout)) {
			ps.mu.Unlock()
			closeStaleConns(staleRoomConn, staleSyncConn)
			slog.Info("v3: host left the scheduled lobby; party stays booked until showtime", "code", code)
			return
		}
		ps.mu.Unlock()
		closeStaleConns(staleRoomConn, staleSyncConn)
		slog.Info("v3: host grace period expired without reconnect, ending party", "code", code)
		_ = m.endPartyInternal(code, ps, 0)
		return
	}

	// Promoted. Announce the old host's departure (the party-state
	// snapshot inside promoteSuccessorLocked already excluded them) and
	// give an overdue scheduled start its retry — the vanished host was
	// exactly the "host must be a current participant" blocker, and the
	// promoted successor satisfies it now.
	m.broadcastToRoomPeersLocked(ps, map[string]interface{}{
		"type": "participant-left",
		"payload": map[string]interface{}{
			"user_id":  staleHostID,
			"username": staleHostName,
		},
	})
	m.maybeRetryScheduledStartLocked(ps)
	ps.mu.Unlock()
	closeStaleConns(staleRoomConn, staleSyncConn)
	slog.Info("v3: host grace expired, handed party to successor", "code", code, "stale_host", staleHostID)
}

// closeStaleConns closes a reaped host's captured conns outside ps.mu
// (Close is cheap but there's no reason to hold the party lock for it).
// Nil-safe on both.
func closeStaleConns(conns ...*SafeConn) {
	for _, c := range conns {
		if c != nil {
			_ = c.Close()
		}
	}
}

// LeavePartyV3Room removes the participant entirely. Also removes any
// lingering sync-socket conn for that user, so one socket dying cleans
// up the other.
//
// 2026-08 — host succession. A host's explicit leave used to end the
// party for everyone (V2's LeaveParty semantics, carried into V3).
// Now it hands the party to the most senior remaining participant
// (promoteSuccessorLocked) and the movie keeps playing — the V3 anchor
// is server-side, so nothing about playback even blinks. Ending the
// party for everyone is a separate deliberate action (EndParty).
// The historical end-it behavior remains only when nobody eligible is
// left: a lone host, or a remainder of phone companions who have no
// player to keep watching on.
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
		if m.promoteSuccessorLocked(ps, userID, username, "left") == nil {
			// Invites (2026-08 review): a scheduled-but-unstarted party is
			// a standing appointment — the host stepping out of the lobby
			// must not cancel the booking (the deliberate cancel is End
			// Party). Same exemption as the disconnect-grace reaper and
			// cleanupOnce; the departed host reclaims the crown on rejoin
			// via /p/{code}. Fall through so any remaining companions
			// still hear participant-left.
			isScheduledLobby := ps.StartedAt == nil && ps.ScheduledStartAt != nil &&
				time.Now().Before(ps.ScheduledStartAt.Add(staleParticipantTimeout))
			if !isScheduledLobby {
				ps.mu.Unlock()
				slog.Info("v3: host left with no successor, ending party", "code", code)
				return m.endPartyInternal(code, ps, 0)
			}
			slog.Info("v3: host left the scheduled lobby; party stays booked until showtime", "code", code)
		}
		// Promoted (or scheduled-lobby exemption) — fall through to the
		// normal leaver bookkeeping below. Note the order the room pool
		// sees on promotion: host-changed + a fresh party-state (inside
		// promoteSuccessorLocked, sans the departed host — their entry
		// was deleted above), then participant-left.
	}

	// Announce departure on the room socket.
	m.broadcastToRoomPeersLocked(ps, map[string]interface{}{
		"type": "participant-left",
		"payload": map[string]interface{}{
			"user_id":  userID,
			"username": username,
		},
	})
	// The leaver may have been the last not-ready blocker of an overdue
	// scheduled start (2026-06 review) — and since succession, a leaving
	// HOST unblocks the same gate: HandleRequestPlay requires the host to
	// be a current participant, which the promoted successor is.
	m.maybeRetryScheduledStartLocked(ps)
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
	for _, c := range ps.roomConns {
		if c == nil {
			continue
		}
		_ = c.Send(data)
	}
}

// broadcastToSyncPeersLocked is the lock-held variant of broadcastToSyncPeers,
// used by intent handlers (pause, seek) that already hold ps.mu and would
// deadlock if they called the unlocked variant.
//
// 2026-06 — Send enqueues onto the per-conn write pump without blocking,
// so holding ps.mu across this loop is now safe (the "Phase 3 refactor"
// the previous version of this comment promised).
func (m *Manager) broadcastToSyncPeersLocked(ps *PartyState, msg map[string]interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	for _, c := range ps.syncConns {
		if c == nil {
			continue
		}
		_ = c.Send(data)
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
		return errUser("party not found")
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
		return errUser("not a participant")
	}

	if ps.HostUserID != userID {
		return errUser("only the host can start playback")
	}
	// A party mid-teardown must not start playback: endPartyInternal has
	// already run stopTickLoopLocked, and starting a fresh tick loop here
	// would leak its goroutine forever once the party leaves the map
	// (see PartyState.ending — the succession review's resurrection case).
	if ps.ending {
		return errUser("party has ended")
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
		if notReady := spoilerGateBlockersLocked(ps); len(notReady) > 0 {
			return errUser("waiting for: %s", strings.Join(notReady, ", "))
		}
	}

	ps.setAnchorLocked(ps.AnchorAbsMs, true) // resume from wherever we paused
	ps.HasEverPlayed = true

	// First play stamps StartedAt and cancels any in-flight schedule timer
	// (ported from the deleted V2 HandlePlaybackControl, 2026-06). Without
	// this, a host who schedules a party and then impatiently hits play
	// early would leave the countdown timer armed; fireScheduledStart's
	// dedup guard (StartedAt/HasEverPlayed) makes the late fire a no-op,
	// but cancelling here avoids the pointless wakeup, and StartedAt gives
	// late joiners + analytics a stable start timestamp.
	if ps.StartedAt == nil {
		now := time.Now()
		ps.StartedAt = &now
		m.cancelScheduleTimerLocked(ps)
		if ps.dbID > 0 && m.queries != nil {
			// Persist async — best-effort; in-memory state is authoritative.
			go func(id int64, t time.Time) {
				if err := m.queries.MarkPartyStarted(context.Background(), id, t); err != nil {
					slog.Warn("mark party started failed", "id", id, "error", err)
				}
			}(ps.dbID, now)
		}
		// Invites (2026-08 review): a manual early start of a SCHEDULED
		// party must tell lobby clients the countdown is over — only the
		// timer path used to broadcast this, so every client kept its
		// local scheduledStartAt and the lobby card resurrected on the
		// first pause with a countdown to a cancelled timer. Same payload
		// shape as fireScheduledStart's broadcast.
		if ps.ScheduledStartAt != nil {
			m.broadcastToPartyLocked(ps, map[string]interface{}{
				"type": "party-starting",
				"payload": map[string]interface{}{
					"started_at_ms": now.UnixMilli(),
					"server_now_ms": now.UnixMilli(),
				},
			})
		}
	}

	m.bumpRevLocked(ps)
	m.startTickLoopLocked(ps)

	slog.Info("v3: party → Running", "code", code, "abs_ms", ps.AnchorAbsMs, "rev", ps.StateRevision)
	// No explicit "play" broadcast; the first `tick` in ≤TickInterval is
	// the signal. Clients' hello-or-most-recent-tick tells them to play.
	// But for instant feedback we emit a synthetic tick right now:
	m.emitTickLocked(ps)
	return nil
}

// spoilerGateBlockersLocked returns the usernames of participants whose
// missing Ready blocks the spoiler-free first play. Hosts are exempt
// (clicking play implies readiness), and so are mobile COMPANIONS — the
// phone "second screen" has no video player and no Ready affordance
// (useCompanion never sends {type:"ready"}), so counting them made a
// chat-only phone guest block the party's start forever (2026-06 review).
// Callers MUST hold ps.mu. Shared by HandleRequestPlay's gate and the
// scheduled-start retry pre-check so the two can never drift apart.
func spoilerGateBlockersLocked(ps *PartyState) []string {
	var notReady []string
	for _, p := range ps.Participants {
		if p == nil || p.IsHost || p.Companion {
			continue
		}
		if !p.Ready {
			notReady = append(notReady, p.Username)
		}
	}
	return notReady
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
		return errUser("party not found")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// 2026-05-29 MED-integration fix (finding 2): pause is the most exposed
	// intent — when Settings.AllowPause is true the host check below passes
	// for ANY userID, so a former participant with a lingering sync socket
	// could pause the party for everyone. Require current membership first.
	if _, ok := ps.Participants[userID]; !ok {
		return errUser("not a participant")
	}

	if ps.HostUserID != userID && !ps.Settings.AllowPause {
		return errUser("only the host can pause")
	}

	// 2026-06 review — clamp like HandleRequestSeek does. Pause writes the
	// same anchor a seek does; an unbounded atAbsMs (math.MaxInt64) would
	// overflow CurrentAbsMs() on the next play and broadcast absurd
	// negative positions to every peer.
	if atAbsMs > maxPositionMs {
		return errUser("pause position out of range")
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
		return errUser("party not found")
	}
	if toAbsMs < 0 {
		return errUser("seek target must be non-negative")
	}
	if toAbsMs > maxPositionMs {
		return errUser("seek target out of range")
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()

	// 2026-05-29 MED-integration fix (finding 2): require current
	// membership before the host check (see HandleRequestPlay for the
	// rationale — a stale HostUserID alone does not prove the sender is
	// still in the party).
	if _, ok := ps.Participants[userID]; !ok {
		return errUser("not a participant")
	}

	if ps.HostUserID != userID {
		return errUser("only the host can seek")
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

// TouchParticipant refreshes a participant's LastSeen. Called by the room
// socket's application-level heartbeat (every 25s from the SPA).
//
// 2026-06 review (latent bug) — before this, NOTHING in the live protocol
// refreshed LastSeen after join: the room heartbeat was a pure no-op and
// the SPA never sends sync-socket heartbeats. With CleanupStale running
// (main.go), a party whose members quietly watched for 5+ minutes without
// chatting, reacting, or reconnecting had every participant "stale" and
// was reaped mid-movie — the likely cause of the unexplained
// "why did my party end?" reports the endPartyInternal diagnostic
// snapshot was added to investigate.
func (m *Manager) TouchParticipant(code string, userID int64) {
	m.mu.RLock()
	ps, exists := m.parties[code]
	m.mu.RUnlock()
	if !exists {
		return
	}
	ps.mu.Lock()
	if p, ok := ps.Participants[userID]; ok {
		p.LastSeen = time.Now()
	}
	ps.mu.Unlock()
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
	// Enqueue without releasing the lock — Send never blocks (per-conn
	// write pump), and this is called on the same goroutine that just
	// mutated the anchor.
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	for _, c := range ps.syncConns {
		if c == nil {
			continue
		}
		_ = c.Send(data)
	}
}
