// Aurora V2 — Watch party protocol types + helpers.
//
// Aurora's watch-party WebSocket protocol has TWO sockets (V3 split):
//   - /ws/party-room — membership, chat, reactions, presence, track-changes
//   - /ws/party-sync — playback events (hello, tick, pause, seek)
//
// The split exists because sync ticks fire at 1-2 Hz and the lower-frequency
// room messages don't need to compete for socket bandwidth or be lost when
// the sync socket churns during media changes. Server-side, both sockets
// share the same PartyState (manager.go).
//
// The room socket must be joined FIRST — its `party-state` response proves
// the server inserted the user into Participants, at which point the sync
// socket can safely send its own `join-party` (otherwise it errors with
// "not a participant"). See V1's openSyncOnce dance in aurora_pro.html
// (around line 6217) for the original ordering rationale.
//
// Message envelope is `{ type: string, payload?: unknown }` for every
// message in both directions; the types below describe the payload shapes
// only.

// ──────────────────────────────────────────────────────────────────
// Wire types — outbound (client → server)

export type OutboundRoomMessage =
  // Companion mode is NOT signaled here. The server reads it from a
  // `?companion=1` query param on the /ws/party-room upgrade URL (see
  // PartyWSHandlerV3Room.ServeHTTP + useCompanion's buildCompanionWsUrl),
  // because the flag must be known at upgrade time — before any
  // join-party message arrives. The join-party payload stays identical
  // for desktop + companion clients (only party_code).
  | { type: 'join-party'; payload: { party_code: string } }
  | { type: 'chat'; payload: { message: string } }
  | { type: 'reaction'; payload: { emoji: string; abs_ms?: number } }
  | { type: 'ready'; payload: { ready: boolean } }
  | { type: 'leave-party' }
  // 2026-05-25 — application-level keepalive. Server's gorilla/websocket
  // already does protocol-level PING/PONG control frames, but those
  // don't always reset upstream-proxy idle counters (Cloudflare on
  // non-Enterprise plans was the specific offender — observed at
  // aurorapro.app where the host's room WS hit a hard 90s timeout
  // because PING control frames never reached the origin's
  // SetReadDeadline reset path). Sending a data frame every 25s keeps
  // every reasonable proxy's idle counter at zero. Server no-ops it.
  | { type: 'heartbeat' }
  // Phase 4.6 — voice mesh signaling (rides the room socket).
  | { type: 'voice-join' }
  | { type: 'voice-leave' }
  | { type: 'voice-offer'; payload: { to_user_id: number; sdp: string } }
  | { type: 'voice-answer'; payload: { to_user_id: number; sdp: string } }
  | { type: 'voice-ice'; payload: { to_user_id: number; candidate: string; sdp_mid: string; sdp_m_line_index: number } }

export type OutboundSyncMessage =
  | { type: 'join-party'; payload: { party_code: string } }
  | { type: 'request-play' }
  // Keep these names aligned with party_ws_v3_sync.go. Unknown JSON fields
  // are ignored by Go's decoder, so sending the old `abs_ms` silently turned
  // every seek into the zero-value `to_ms: 0` (issue #448).
  | { type: 'request-pause'; payload: { at_ms: number } }
  | { type: 'request-seek'; payload: { to_ms: number } }
  | { type: 'heartbeat'; payload: { abs_ms: number; buffering?: boolean } }
  // 2026-05-25 — server's actual protocol is `time-sync` (not
  // `time-sync-request`), and the round-trip carries server_recv + server_send
  // separately so the client can compute one-way latencies properly. The
  // original placeholder type with {client_ms} never matched server reality
  // (party_ws_v3_sync.go:207 expects {client_send_ms}). The optional
  // measured_* fields let the client report its computed RTT/offset back to
  // the server for observability (see manager.RecordRTT) — purely diagnostic.
  | { type: 'time-sync'; payload: { client_send_ms: number; measured_rtt_ms?: number; measured_offset_ms?: number } }

export function partyPauseRequest(absMs: number): Extract<OutboundSyncMessage, { type: 'request-pause' }> {
  return { type: 'request-pause', payload: { at_ms: absMs } }
}

export function partySeekRequest(absMs: number): Extract<OutboundSyncMessage, { type: 'request-seek' }> {
  return { type: 'request-seek', payload: { to_ms: absMs } }
}

/**
 * The room and sync channels are independent WebSockets, but their revision is
 * one shared monotonic sequence. Once a versioned frame has been accepted,
 * unversioned legacy frames are no longer safe to apply across that boundary.
 */
export function shouldAcceptPartyRevision(
  latestAcceptedRev: number,
  incomingRev: number | undefined,
): boolean {
  if (incomingRev === undefined) return latestAcceptedRev === 0
  return incomingRev >= latestAcceptedRev
}

// ──────────────────────────────────────────────────────────────────
// Wire types — inbound (server → client)

export interface PartyParticipant {
  user_id: number
  username: string
  is_host: boolean
  is_buffering: boolean
  last_seen: string
  ready: boolean
  // Mobile-companion presence flag (Watch Party companion feature).
  // True when this participant joined from the phone "second screen"
  // (room socket only — no playback sync). Lets the UI badge them as
  // "📱 on phone" and lets the server skip host-style cleanup when a
  // companion drops. Populated server-side from the `?companion=1`
  // upgrade query param (manager.go Participant.Companion, echoed in
  // BuildPartyStateMessage); optional so any server/state snapshot that
  // pre-dates the field simply leaves it undefined (treated as a
  // regular desktop participant).
  companion?: boolean
}

// 2026-05-25 — the original type put every field at the root of
// `payload`, but the server's actual shape (see
// internal/watchparty/manager.go BuildPartyStateMessage) puts party-
// specific fields inside a nested `party` object while keeping
// participants + chat_history at the root. The mismatch caused
// `setStatePatch({code: payload.code, ...})` to write `undefined` to
// every party-specific state field, including `code` — which is what
// flipped `state.code` from "YZ8BN4" back to "" 321ms after a
// successful join in production. Type now mirrors reality.
export interface PartyStateInnerParty {
  code: string
  host_user_id: number
  media_item_id: number
  episode_id?: number
  media_title: string
  media_poster?: string
  party_name?: string
  current_time_ms: number
  is_playing: boolean
  // Server emits this as `revision` here (vs `rev` in tick/pause/seek
  // payloads on the sync socket). Both refer to the same monotonic
  // state revision; the handler maps revision → rev internally.
  revision?: number
  // Countdown fields (migration 019, surfaced for the invites lobby).
  // scheduled_start_at non-null + started_at null ⇒ the party is a lobby
  // waiting on its countdown; the server fires 'party-starting' at the
  // scheduled moment.
  scheduled_start_at?: string | null
  started_at?: string | null
}

export interface PartyStatePayload {
  party: PartyStateInnerParty
  participants: PartyParticipant[]
  // The room delivers chat_history with the first party-state so a
  // late-joining guest sees what's been said. Subsequent messages
  // arrive as `chat-message` events.
  chat_history?: ChatMessageEvent[]
}

export interface ChatMessageEvent {
  id: string
  user_id: number
  username: string
  message: string
  timestamp: string
}

export interface ReactionEvent {
  user_id: number
  username: string
  emoji: string
  abs_ms: number
  created_at: string
}

export interface ParticipantEvent {
  user_id: number
  username: string
  is_host?: boolean
  // Sent on participant-join so a reconnecting peer's existing ready
  // state isn't erased by the optimistic patch (server includes it for
  // exactly that reason — see the join broadcast in sync_v3.go).
  ready?: boolean
  // Mirrors PartyParticipant.companion — present on participant-join
  // events for a mobile-companion joiner so the optimistic local list
  // patch in useParty/useCompanion can carry the flag forward without
  // waiting for a fresh party-state. Optional / omitted for desktop.
  companion?: boolean
}

/**
 * Builds the optimistic local participant for a `participant-join` event.
 *
 * Extracted and pure because silently dropping a field here has already
 * shipped a real bug (host-succession review, 2026-08): the inline patch
 * in useParty omitted `companion`, so a phone companion who joined AFTER
 * the initial snapshot read as a regular watcher — and PartyPanel's
 * hand-off dialog then counted them as an eligible host, promising the
 * host a hand-off that the server (which excludes companions) turned
 * into an end-for-everyone. Every field the event carries must land
 * here; the unit tests pin each one.
 */
export function participantFromJoinEvent(p: ParticipantEvent): PartyParticipant {
  return {
    user_id: p.user_id,
    username: p.username,
    is_host: !!p.is_host,
    is_buffering: false,
    last_seen: new Date().toISOString(),
    ready: !!p.ready,
    companion: !!p.companion,
  }
}

export interface TickPayload {
  abs_ms: number
  server_now_ms: number
  rev?: number
  running?: boolean
  // CLIENT-LOCAL, not on the wire: Date.now() at the moment the frame was
  // received, stamped by useParty when it stores the tick in tickRef. The
  // drift loop uses it to decide whether the tick is STALE (sync socket
  // down) — comparing two local timestamps is immune to client↔server
  // clock skew, unlike `Date.now() - server_now_ms`, which before the
  // time-sync offset converges would misclassify every fresh tick as
  // stale on a machine whose clock runs >3s fast (2026-06 review).
  receivedAtMs?: number
}

export interface PauseSeekPayload {
  abs_ms: number
  rev?: number
  running?: boolean
  by?: number
}

// Client-local enrichment of an explicit server `seek` frame. Unlike the
// high-frequency tickRef, this ref lets VideoPlayer distinguish a deliberate
// host scrub (which may require every sequential HLS session to rebase) from
// ordinary drift correction near the produced edge.
export interface ReceivedSeekPayload extends PauseSeekPayload {
  receivedAtMs: number
  sequence: number
}

export interface HelloPayload {
  abs_ms: number
  server_now_ms: number
  running: boolean
  rev?: number
  // hello carries the FFmpeg -ss offset so the client can map
  // abs_ms (source coordinates) ↔ hls.js currentTime (HLS-relative).
  // hls_start_sec is the snapped GOP boundary the server actually
  // started transcoding from (may differ from the requested resume
  // position by up to one GOP, ~2-4s).
  hls_start_sec?: number
}

/**
 * A sync-socket hello is also a one-shot absolute rebase instruction. This is
 * load-bearing on reconnect: the explicit seek that moved the party may have
 * happened while this client was offline.
 */
export function receivedSeekFromHello(
  payload: HelloPayload,
  receivedAtMs: number,
  sequence: number,
): ReceivedSeekPayload {
  return {
    abs_ms: payload.abs_ms,
    running: payload.running,
    rev: payload.rev,
    receivedAtMs,
    sequence,
  }
}

// 2026-08 — host succession. The previous host left (reason 'left') or
// timed out of the disconnect grace (reason 'disconnected') and the
// server handed the party to a remaining participant. A fresh
// party-state snapshot follows on the same socket; this event exists so
// the UI can NAME the change ("X is now the host") without diffing
// snapshots, and so a client can patch hostUserId instantly.
export interface HostChangedEvent {
  new_host_user_id: number
  new_host_username: string
  previous_host_user_id: number
  previous_host_username: string
  reason: 'left' | 'disconnected'
}

export type InboundRoomMessage =
  | { type: 'party-state'; payload: PartyStatePayload }
  | { type: 'participant-join'; payload: ParticipantEvent }
  | { type: 'participant-left'; payload: ParticipantEvent }
  | { type: 'host-changed'; payload: HostChangedEvent }
  | { type: 'chat-message'; payload: ChatMessageEvent }
  | { type: 'reaction'; payload: ReactionEvent }
  | { type: 'ready-changed'; payload: { user_id: number; ready: boolean } }
  | { type: 'party-ended' }
  | { type: 'error'; payload: { error: string } }
  // Countdown lifecycle (migration 019 events, consumed since the invites
  // lobby). party-scheduled fires on every (re)schedule — null clears the
  // countdown; party-starting fires once when the scheduled start engages
  // playback (also after a manual early start of a scheduled party).
  | { type: 'party-scheduled'; payload: { scheduled_start_at: string | null; server_now_ms: number } }
  | { type: 'party-starting'; payload: { started_at_ms: number; server_now_ms: number } }
  // Phase 5 — host advanced the party's media (TV episode auto-
  // advance or manual swap). Server reset its anchor; client must
  // tear down current player + re-init for the new media.
  | { type: 'media-change'; payload: { media_item_id: number; episode_id?: number; media_title?: string; media_poster?: string; rev?: number } }
  // Phase 4.6 — voice mesh signaling.
  | { type: 'voice-peers'; payload: { peers: { user_id: number; username: string }[] } }
  | { type: 'voice-peer-joined'; payload: { user_id: number; username: string } }
  | { type: 'voice-peer-left'; payload: { user_id: number } }
  | { type: 'voice-offer'; payload: { from_user_id: number; sdp: string } }
  | { type: 'voice-answer'; payload: { from_user_id: number; sdp: string } }
  | { type: 'voice-ice'; payload: { from_user_id: number; candidate: string; sdp_mid: string; sdp_m_line_index: number } }

export type InboundSyncMessage =
  | { type: 'hello'; payload: HelloPayload }
  | { type: 'tick'; payload: TickPayload }
  | { type: 'pause'; payload: PauseSeekPayload }
  | { type: 'seek'; payload: PauseSeekPayload }
  // 2026-05-25 — matches server response shape (party_ws_v3_sync.go:218).
  // server_recv_ms is when the server received the client_send_ms,
  // server_send_ms is when the server sent this response. The split lets
  // the client distinguish server processing time from network RTT:
  //   total_rtt = client_recv_ms - client_send_ms
  //   server_proc = server_send_ms - server_recv_ms
  //   network_rtt = total_rtt - server_proc
  //   offset = ((server_recv_ms - client_send_ms) + (server_send_ms - client_recv_ms)) / 2
  | { type: 'time-sync-response'; payload: { client_send_ms: number; server_recv_ms: number; server_send_ms: number } }
  | { type: 'party-ended' }
  | { type: 'error'; payload: { error: string } }

// ──────────────────────────────────────────────────────────────────
// Code-info preflight — distinguishes a persistent-room code (where the
// room exists but no session is running) from a live-party code. Used
// for the "Room offline" friendly state vs jumping straight into the
// dual-socket join.

export interface CodeInfo {
  // Backend (party_handlers.go GetCodeInfo) returns `type` with values
  // "active" (live party) or "offline_room" (persistent room with no
  // active session). Schema is committed to this shape; we mirror it
  // exactly. An earlier `kind: 'party'|'room'` shape never matched the
  // server and silently failed every join with the "persistent room"
  // toast — fixed in this PR.
  type: 'active' | 'offline_room'
  code?: string
  // For type === 'active': party-specific fields. For 'offline_room':
  // room-specific. Both optional in the type so consumers must
  // narrow on `type` before reading either.
  party?: {
    code: string
    media_title?: string
    media_poster?: string
    party_name?: string
    host_username?: string
    participant_count?: number
  }
  room?: {
    code?: string
    name?: string
    description?: string
    host_username?: string
  }
}

// Build a party WebSocket URL. The SPA authenticates the upgrade via the
// httpOnly access cookie (same-origin handshake, deep-debug H10) — the
// server's requireQueryTokenClaims falls back to the cookie when no
// ?token= is present. A non-empty `token` is still honored for callers
// that genuinely cannot send the cookie (none in the SPA today); the
// empty-token case emits NO query param so the URL carries no
// credential that could land in proxy logs (security review 2026-06).
export function buildWsUrl(path: '/ws/party-room' | '/ws/party-sync', token: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${proto}//${location.host}${path}${query}`
}

// Build the room-socket URL for the MOBILE COMPANION (phone "second
// screen"). Identical to buildWsUrl('/ws/party-room', token) plus a
// `companion=1` query param, which the server reads at upgrade time
// (PartyWSHandlerV3Room.ServeHTTP) to mark this participant's presence
// as companion (chat/voice/emoji only — no /ws/party-sync, no video).
// Any value other than the exact string "1" degrades to non-companion
// server-side, so this is strictly additive. Companion clients MUST use
// this instead of buildWsUrl so the flag is present on the very first
// (and every reconnect) upgrade.
export function buildCompanionWsUrl(token: string): string {
  const base = buildWsUrl('/ws/party-room', token)
  return `${base}${base.includes('?') ? '&' : '?'}companion=1`
}

// Build the app-wide hub socket URL (the general /ws endpoint behind the shared
// websocket.Hub — request_status, notification, etc.). No ?token= is needed for
// the SPA: this is a same-origin upgrade, so the browser sends the httpOnly
// access cookie, and the server's requireQueryTokenClaims falls back to reading
// that cookie when the query token is absent (helpers.go). Non-same-origin
// clients (Cast/AirPlay) don't use this hub.
export function buildAppWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

// Validate a code format before any network round-trip — same constraint
// V1 uses: 6 chars, uppercased. The backend ALSO validates (server is
// authoritative); this is purely a UX guard so we don't fire WebSocket
// connects for obvious typos.
export function isValidPartyCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code)
}
