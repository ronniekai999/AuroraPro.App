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
  | { type: 'request-pause'; payload: { abs_ms: number } }
  | { type: 'request-seek'; payload: { abs_ms: number } }
  | { type: 'heartbeat'; payload: { abs_ms: number; buffering?: boolean } }
  // 2026-05-25 — server's actual protocol is `time-sync` (not
  // `time-sync-request`), and the round-trip carries server_recv + server_send
  // separately so the client can compute one-way latencies properly. The
  // original placeholder type with {client_ms} never matched server reality
  // (party_ws_v3_sync.go:207 expects {client_send_ms}). The optional
  // measured_* fields let the client report its computed RTT/offset back to
  // the server for observability (see manager.RecordRTT) — purely diagnostic.
  | { type: 'time-sync'; payload: { client_send_ms: number; measured_rtt_ms?: number; measured_offset_ms?: number } }

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
  // Mirrors PartyParticipant.companion — present on participant-join
  // events for a mobile-companion joiner so the optimistic local list
  // patch in useParty/useCompanion can carry the flag forward without
  // waiting for a fresh party-state. Optional / omitted for desktop.
  companion?: boolean
}

export interface TickPayload {
  abs_ms: number
  server_now_ms: number
  rev?: number
  running?: boolean
}

export interface PauseSeekPayload {
  abs_ms: number
  rev?: number
  running?: boolean
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

export type InboundRoomMessage =
  | { type: 'party-state'; payload: PartyStatePayload }
  | { type: 'participant-join'; payload: ParticipantEvent }
  | { type: 'participant-left'; payload: ParticipantEvent }
  | { type: 'chat-message'; payload: ChatMessageEvent }
  | { type: 'reaction'; payload: ReactionEvent }
  | { type: 'ready-changed'; payload: { user_id: number; ready: boolean } }
  | { type: 'party-ended' }
  | { type: 'error'; payload: { error: string } }
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

// Build a WebSocket URL with the access token in ?token=. The room and
// sync endpoints are both on the token-promotion whitelist (router.go's
// shouldPromoteToken includes /ws*). Once promoted, the per-message
// auth check uses the JWT — the ws upgrade is the only place we can't
// set an Authorization header from the browser.
export function buildWsUrl(path: '/ws/party-room' | '/ws/party-sync', token: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}?token=${encodeURIComponent(token)}`
}

// Build the room-socket URL for the MOBILE COMPANION (phone "second
// screen"). Identical to buildWsUrl('/ws/party-room', token) plus a
// `&companion=1` query param, which the server reads at upgrade time
// (PartyWSHandlerV3Room.ServeHTTP) to mark this participant's presence
// as companion (chat/voice/emoji only — no /ws/party-sync, no video).
// Any value other than the exact string "1" degrades to non-companion
// server-side, so this is strictly additive. Companion clients MUST use
// this instead of buildWsUrl so the flag is present on the very first
// (and every reconnect) upgrade.
export function buildCompanionWsUrl(token: string): string {
  return `${buildWsUrl('/ws/party-room', token)}&companion=1`
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
