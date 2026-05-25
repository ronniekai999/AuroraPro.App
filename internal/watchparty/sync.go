package watchparty

import (
	"log/slog"
	"time"
)

// ============================================================
// Sync Protocol V2 — Jellyfin SyncPlay-inspired
// ============================================================
//
// The party's canonical clock is the server's wall clock. Clients do not trust
// each other (and the server does not trust the host). Each client runs a
// periodic TimeSync round-trip to estimate its offset from server time, then
// playback commands are anchored to absolute server time ("play at server-ms
// T") rather than "play now". The server-authored state snapshot carries a
// monotonic StateRevision so stale broadcasts can be ignored.
//
// Three top-level state transitions:
//
//   Idle     → Waiting: first play issued, seek issued, or a peer suspends
//   Waiting  → Playing: every participant emits Ready at the target position
//   Playing  → Waiting: any participant reports buffering for longer than
//                       BufferHysteresis
//
// All corrections for <DriftHardSeekMs drift happen client-side (rate nudge or
// hard seek). The server only intervenes by transitioning group state.

// TimeSyncResponse is what the server returns for a TimeSync ping. Client
// computes offset = server_send_ms - (client_send_ms + rtt/2). The ClientSendMs
// is echoed back unchanged so the client can measure RTT without needing to
// track outstanding nonces.
type TimeSyncResponse struct {
	ClientSendMs int64 `json:"client_send_ms"`
	ServerRecvMs int64 `json:"server_recv_ms"`
	ServerSendMs int64 `json:"server_send_ms"`
}

// HandleTimeSync records the round-trip with the participant and returns the
// server timestamps for the client to compute its offset. No party-level
// mutation here — this is read-only against PartyState; the participant's
// RTT/offset are informational for server-side diagnostics only.
func (m *Manager) HandleTimeSync(code string, userID int64, clientSendMs int64, serverRecvMs int64) (TimeSyncResponse, error) {
	sendMs := time.Now().UnixMilli()
	return TimeSyncResponse{
		ClientSendMs: clientSendMs,
		ServerRecvMs: serverRecvMs,
		ServerSendMs: sendMs,
	}, nil
}

// RecordRTT is called after the client reports back the measured RTT so we
// can track it for observability and eventually weight drift tolerance per
// peer. Exported for the WS handler.
func (m *Manager) RecordRTT(code string, userID int64, rttMs int64, offsetMs int64) {
	m.mu.RLock()
	ps, ok := m.parties[code]
	m.mu.RUnlock()
	if !ok {
		return
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if p, ok := ps.Participants[userID]; ok {
		p.LastRTTms = rttMs
		p.ClockOffsetMs = offsetMs
	}
}

// ============================================================
// Group state machine
// ============================================================

// bumpRevLocked increments the state revision. Must hold ps.mu.
func (m *Manager) bumpRevLocked(ps *PartyState) uint64 {
	ps.StateRevision++
	return ps.StateRevision
}

// stateSnapshotLocked builds the authoritative snapshot that clients use to
// reconcile their player state. Must hold ps.mu.
//
// Includes an anchored play instruction: if the group is Playing, PlayAtServerMs
// is the wall-clock server time at which CurrentTimeMs applies. This lets
// clients correct for their own offset and RTT with no further round-trip.
func (m *Manager) stateSnapshotLocked(ps *PartyState) map[string]interface{} {
	var playAt int64
	if ps.GroupState == GroupStatePlaying && ps.PlayingSince != nil {
		playAt = ps.PlayingSince.UnixMilli()
	} else {
		playAt = time.Now().UnixMilli()
	}

	participants := make([]map[string]interface{}, 0, len(ps.Participants))
	for _, p := range ps.Participants {
		participants = append(participants, map[string]interface{}{
			"user_id":      p.UserID,
			"username":     p.Username,
			"is_host":      p.IsHost,
			"is_buffering": p.IsBuffering,
			"suspended":    len(p.Suspensions) > 0,
		})
	}

	return map[string]interface{}{
		"type": "state-snapshot",
		"payload": map[string]interface{}{
			"revision":          ps.StateRevision,
			"group_state":       string(ps.GroupState),
			"current_time_ms":   ps.CurrentTimeMs,
			// 2026-05-25 — V3 OR for consistency with BuildPartyStateMessage.
			// V2-only message that the redesign client doesn't currently
			// consume, but keep the contract aligned so a future client
			// doesn't silently regress to "host is paused" mid-stream.
			"is_playing":        ps.IsPlaying || ps.Running,
			"play_at_server_ms": playAt,
			"server_now_ms":     time.Now().UnixMilli(),
			"participants":      participants,
		},
	}
}

// broadcastStateSnapshotLocked emits a new state snapshot to all peers. Must
// hold ps.mu. Callers should have already mutated the relevant fields and
// called bumpRevLocked before invoking this.
func (m *Manager) broadcastStateSnapshotLocked(ps *PartyState) {
	m.broadcastToPartyLocked(ps, m.stateSnapshotLocked(ps))
}

// transitionToWaitingLocked moves the group into Waiting at the given position.
// All peers are expected to buffer to posMs and emit a Ready message, at which
// point the group resumes (see HandleReady). Must hold ps.mu.
func (m *Manager) transitionToWaitingLocked(ps *PartyState, posMs int64, reason string) {
	if ps.GroupState == GroupStateWaiting && ps.CurrentTimeMs == posMs {
		return
	}
	ps.GroupState = GroupStateWaiting
	ps.IsPlaying = false
	ps.PlayingSince = nil
	ps.CurrentTimeMs = posMs
	for _, p := range ps.Participants {
		p.ReadyAtMs = -1 // any previous ready is invalidated by the new target
	}
	m.bumpRevLocked(ps)
	slog.Debug("party → waiting", "code", ps.Code, "pos_ms", posMs, "reason", reason, "rev", ps.StateRevision)
	m.broadcastStateSnapshotLocked(ps)
}

// transitionToPlayingLocked moves the group into Playing, anchoring the play
// instant at now + PlayScheduleDelay so every client has a lead time to schedule
// the start via their offset-corrected clock. Must hold ps.mu.
func (m *Manager) transitionToPlayingLocked(ps *PartyState) {
	startAt := time.Now().Add(m.cfg.PlayScheduleDelay)
	ps.GroupState = GroupStatePlaying
	ps.IsPlaying = true
	ps.PlayingSince = &startAt
	m.bumpRevLocked(ps)
	slog.Debug("party → playing", "code", ps.Code,
		"pos_ms", ps.CurrentTimeMs, "play_at_server_ms", startAt.UnixMilli(), "rev", ps.StateRevision)
	m.broadcastStateSnapshotLocked(ps)
}

// ============================================================
// Ready protocol
// ============================================================

// HandleReady is the guest's "I have buffered to posMs and can start" message.
// If the group is Waiting and every non-suspended participant has now emitted
// Ready at the current target, the group transitions to Playing.
func (m *Manager) HandleReady(code string, userID int64, posMs int64) error {
	m.mu.RLock()
	ps, ok := m.parties[code]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()

	p, ok := ps.Participants[userID]
	if !ok {
		return nil
	}
	p.ReadyAtMs = posMs
	p.LastSeen = time.Now()

	if ps.GroupState != GroupStateWaiting {
		return nil
	}

	// All active (non-suspended) participants must be within a tight window
	// of the current target position to be considered ready.
	for _, pp := range ps.Participants {
		if len(pp.Suspensions) > 0 {
			continue
		}
		diff := pp.ReadyAtMs - ps.CurrentTimeMs
		if diff < 0 {
			diff = -diff
		}
		if pp.ReadyAtMs < 0 || diff > m.cfg.DriftHardSeekMs {
			return nil
		}
	}

	m.transitionToPlayingLocked(ps)
	return nil
}

// ============================================================
// Drift report (client-side correction counters)
// ============================================================

// HandleDriftReport is the client's self-report after it attempted to correct
// its own drift (either ignored, rate-adjusted, or hard-seeked). The server
// tracks consecutive failed attempts so it can drop thrashing clients from the
// group, preventing them from poisoning shared state.
func (m *Manager) HandleDriftReport(code string, userID int64, driftMs int64, corrected bool) error {
	m.mu.RLock()
	ps, ok := m.parties[code]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()

	p, ok := ps.Participants[userID]
	if !ok {
		return nil
	}

	if corrected {
		p.FailedSeekAttempts = 0
		return nil
	}
	p.FailedSeekAttempts++
	if p.FailedSeekAttempts >= m.cfg.DriftMaxAttempts {
		slog.Info("dropping thrashing client from party",
			"code", code, "user_id", userID, "drift_ms", driftMs,
			"attempts", p.FailedSeekAttempts)
		// Mark as suspended rather than disconnecting — client stays in chat.
		if p.Suspensions == nil {
			p.Suspensions = make(map[string]bool)
		}
		p.Suspensions["desync"] = true
		m.bumpRevLocked(ps)
		m.broadcastStateSnapshotLocked(ps)
	}
	return nil
}
