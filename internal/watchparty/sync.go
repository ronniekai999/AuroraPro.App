package watchparty

import (
	"time"
)

// ============================================================
// Time sync (NTP-style offset estimation)
// ============================================================
//
// The party's canonical clock is the server's wall clock. Each client runs
// a periodic TimeSync round-trip to estimate its offset from server time;
// playback positions on the wire are anchored to absolute server time so
// clients can correct for their own skew with no further round-trips.
//
// This file used to also hold the V2 tri-state group machine
// (Idle/Waiting/Playing with Ready/DriftReport handshakes). V2's transport
// was removed in M1 and the engine itself was deleted in the 2026-06
// watch-party review ("step 5" of the V3 execution plan) — V3's
// Running/Paused anchor model in sync_v3.go is the only protocol.

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

// bumpRevLocked increments the state revision. Must hold ps.mu.
func (m *Manager) bumpRevLocked(ps *PartyState) uint64 {
	ps.StateRevision++
	return ps.StateRevision
}
