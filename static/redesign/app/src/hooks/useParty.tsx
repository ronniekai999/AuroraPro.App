// Aurora V2 — useParty hook.
//
// Wraps the dual-socket party connection. Consumers see a single
// reactive `state` object + a small action API:
//
//   const party = useParty()
//   party.join('ABC123')
//   party.sendChat('hi')
//   party.leave()
//   party.state.participants // PartyParticipant[]
//
// Internally:
//   - Opens /ws/party-room first
//   - Waits for `party-state` then opens /ws/party-sync
//   - Sends `join-party` on each socket's onopen with the party_code
//   - Routes inbound messages into a single reducer-style update
//
// What's NOT yet here (Phase 4.5+):
//   - Voice mesh (WebRTC signalling via room socket)
//   - Reactions overlay animation (state captures the events; UI
//     overlay is a separate component)
//   - Ready-dot UI / spoiler-free start gate
//   - Time-sync request/response for clock-offset calibration
//   - Track-change broadcast (audio/sub selection mirroring)
//   - Media-change handling (TV auto-advance)
//
// Drift correction in playback is intentionally simplified: we apply
// hard snaps on pause/seek/hello and rate-1.0, NO rate-adjust. The
// rate-adjust algorithm in V1 is good but every detail matters
// (anchor timing, suppression windows, etc.) and getting it wrong
// produces stutter. Phase 4.5 ports it carefully with the seek-storm
// fix from V1's M5 audit.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildWsUrl,
  partyPauseRequest,
  partySeekRequest,
  participantFromJoinEvent,
  changeMediaRequest,
  receivedSeekFromHello,
  shouldAcceptPartyRevision,
  type ChatMessageEvent,
  type CodeInfo,
  type HostChangedEvent,
  type InboundRoomMessage,
  type InboundSyncMessage,
  type OutboundRoomMessage,
  type OutboundSyncMessage,
  type PartyParticipant,
  type ReactionEvent,
  type ReceivedSeekPayload,
  type TickPayload,
} from '@/lib/party'
import { apiFetch, getStoredUser, refreshAccessToken } from '@/lib/api'
import { cacheLastParty } from '@/lib/lastParty'
import { createVoiceController, type VoiceController, type VoiceState } from '@/lib/voice'

// 2026-05-25 — room-socket keepalive cadence. Server's gorilla/websocket
// already does protocol-level PING/PONG every 60s, but some upstream
// proxies (notably Cloudflare on non-Enterprise plans) don't reset
// their idle counter on control frames — only on data frames. Sending
// a `{type:"heartbeat"}` JSON data frame every 25s keeps every
// reasonable proxy happy. Server treats it as a no-op. 25s is well
// under the 30s WebSocket-idle floor most proxies enforce, and well
// under the 90s server pong-wait.
const ROOM_HEARTBEAT_INTERVAL_MS = 25_000

// Reconnect machinery — when the room WS closes unexpectedly (i.e. not
// from a user-initiated leave), try to re-open with exponential backoff.
// Caps at MAX_RECONNECT_ATTEMPTS; after that we surface "Connection
// lost — refresh to retry." The server-side host-disconnect grace
// period (90s in manager.go) gives the host enough time to land any
// of these attempts before guests get kicked.
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000]
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length

// 2026-05-29 — sync-socket reconnect machinery, mirroring the room
// socket's. The sync WS rides an independent backend/proxy connection
// from the room WS, so an idle-timeout drop can kill sync (hello/tick/
// pause/seek) while the room WS stays perfectly healthy. Before this,
// the sync socket only ever re-opened as a side effect of a fresh
// party-state on the ROOM socket — so a sync-only drop left playback
// sync silently dead with no UI signal and no recovery until the user
// rejoined. Same backoff curve + cap as the room socket; reuses the
// same activeCodeRef + userInitiatedLeaveRef guards so an intentional
// leave stops it. The room-driven reopen (room onclose force-closes
// sync, then party-state re-opens it) takes precedence: that path
// cancels any pending sync-reconnect timer to avoid a double-open.

export interface PartyState {
  joining: boolean
  code: string | null
  partyName?: string
  mediaTitle?: string
  mediaPoster?: string
  mediaItemId?: number
  episodeId?: number
  hostUserId?: number
  // Always-fresh participant list as broadcast by party-state.
  participants: PartyParticipant[]
  // Append-only chat history, capped at 200 entries to bound memory.
  chat: ChatMessageEvent[]
  // Last-100 reactions — Phase 4.5 will render these as a floating
  // overlay; for now consumers can read them if needed.
  recentReactions: ReactionEvent[]
  // Most recent sync state — the player effect reads these refs to
  // mirror playback. `tick.abs_ms` is source-position (NOT hls
  // currentTime); the player must offset by hls_start_sec from hello.
  isPlaying: boolean
  currentTimeMs: number
  hlsStartSec: number
  rev: number
  // Connection health flags (true once each socket is open).
  roomConnected: boolean
  syncConnected: boolean
  // 2026-05-25 — true while the room WS is mid-reconnect after an
  // unexpected close. UI shows a "Reconnecting…" badge so users
  // know what's happening (vs the previous "party silently dead"
  // behavior). False when fully connected OR when we've given up
  // after MAX_RECONNECT_ATTEMPTS.
  reconnecting: boolean
  // 2026-05-29 — true while the SYNC WS is mid-reconnect after an
  // independent (room-still-healthy) drop. Distinct from `reconnecting`
  // (room socket) so the UI can show a "Sync lost — reconnecting…"
  // badge separate from the room reconnect badge: chat keeps working
  // while playback sync is being re-established. False when sync is
  // connected OR after we've exhausted MAX_RECONNECT_ATTEMPTS.
  syncReconnecting: boolean
  // Countdown lobby (invites feature). scheduledStartAt set + startedAt
  // null ⇒ pre-start lobby: PartyPanel renders the countdown instead of
  // playback chrome. Sourced from party-state on join and kept fresh by
  // the party-scheduled / party-starting room events. ISO strings.
  scheduledStartAt: string | null
  startedAt: string | null
  // UI-facing: did the last operation fail? Cleared on next action.
  error: string | null
}

const INITIAL_STATE: PartyState = {
  joining: false,
  code: null,
  participants: [],
  chat: [],
  recentReactions: [],
  isPlaying: false,
  currentTimeMs: 0,
  hlsStartSec: 0,
  rev: 0,
  roomConnected: false,
  syncConnected: false,
  reconnecting: false,
  syncReconnecting: false,
  scheduledStartAt: null,
  startedAt: null,
  error: null,
}

const MAX_CHAT = 200
const MAX_REACTIONS = 100

export interface UseParty {
  state: PartyState
  // Phase 4.6 — voice mesh state + actions. Voice rides the room
  // socket so it lives inside useParty rather than as a separate
  // hook (would have required exposing roomWs publicly).
  voice: VoiceState
  joinVoice: () => Promise<void>
  leaveVoice: () => void
  toggleVoiceMute: () => void
  // Phase 5 — register a media-change callback. Fires when the
  // host advances the party (e.g. TV auto-advance to next episode).
  // The consumer should tear down their current player and re-init
  // with the new media. Returns an unsubscribe function.
  onMediaChange: (cb: (payload: { media_item_id: number; episode_id?: number; rev?: number }) => void) => () => void
  // 2026-08 — host succession. Fires when the server hands the party to
  // a new host (previous host left or timed out). State (hostUserId +
  // participants' is_host) is already patched by the time the callback
  // runs; the callback exists for App-level UX (the "X is now the host"
  // toast). Returns an unsubscribe function.
  onHostChange: (cb: (payload: HostChangedEvent) => void) => () => void
  // 2026-08 — host succession made "leave" and "end" different actions:
  // a host's leave() now hands the party off server-side. end() is the
  // deliberate end-for-everyone (POST /api/parties/{code}/end, host
  // only). On success the local session is torn down without waiting
  // for the party-ended broadcast; on failure state.error is set and
  // the party stays live.
  end: () => Promise<boolean>
  // Preflight + join. Returns { ok } on success and { ok: false,
  // error } on failure. Audit M1 (Phase 4.5) — callers need the
  // synchronous error string because `state.error` is set via React
  // batched updates and isn't visible to the awaiter yet.
  //
  // QA 2026-05-25 — added `skipPreflight` so handleStartParty can
  // bypass the GET /api/code/{code}/info check after createQuickParty.
  // Production observed: detail-page Watch Party POST 201s, but the
  // join's preflight returned 404 or wrong shape, silently leaving
  // the party in the in-memory manager but never connecting the host
  // (orphan party row, no UI feedback). When we JUST created the
  // party, we know it's active — preflight is redundant + the source
  // of the silent failure.
  join: (code: string, opts?: { skipPreflight?: boolean }) => Promise<{ ok: boolean; error?: string }>
  // Tear down both sockets and clear state.
  leave: () => void
  sendChat: (message: string) => void
  sendReaction: (emoji: string, absMs?: number) => void
  sendReady: (ready: boolean) => void
  // Issue #460 — host-only party-wide media swap (next-episode advance).
  // Returns false when the room socket isn't OPEN so the caller can keep
  // its card armed instead of pretending the advance happened.
  changeMedia: (p: { mediaItemId: number; episodeId?: number; mediaTitle: string; mediaPoster: string }) => boolean
  // Sync-socket actions — used by the VideoPlayer when the user is
  // the host. Guests' player events do NOT broadcast (host is the
  // sync authority).
  requestPlay: () => void
  requestPause: (absMs: number) => void
  requestSeek: (absMs: number) => void
  // Test seam (PARTY-9), not for app use: a copy of the sync intents
  // buffered for the sync socket's next open.
  __pendingSyncIntentsForTests: () => { seek?: OutboundSyncMessage; playPause?: OutboundSyncMessage }
  // Live sync values for the player effect. Refs avoid causing
  // re-renders on every tick (which fires at 1-2 Hz).
  tickRef: React.MutableRefObject<TickPayload | null>
  // Explicit host seek frames are separate from ticks so a guest can rebase
  // a sequential HLS session exactly once instead of mistaking normal drift
  // near the buffered edge for a scrub.
  seekRef: React.MutableRefObject<ReceivedSeekPayload | null>
  helloAbsMsRef: React.MutableRefObject<number>
  // 2026-05-25 — NTP-style clock offset from server, in ms.
  // Use as: serverTime ≈ Date.now() + clockOffsetRef.current
  // Without this correction, the drift-extrapolation in VideoPlayer
  // (Date.now() - t.server_now_ms) is wrong by however much the
  // client clock skews from the server's. Tested locally on a host
  // with NTP off — saw 400-800ms steady-state drift on watch-party
  // guests that disappeared after enabling sync. Filled by repeated
  // time-sync round-trips on the sync socket.
  clockOffsetRef: React.MutableRefObject<number>
  // Most-recent measured round-trip-time, ms. Exposed for diagnostics
  // (drift overlay) and so consumers can decide how much to trust the
  // current offset estimate (high RTT variance ⇒ noisy estimate).
  rttRef: React.MutableRefObject<number>
}

// 2026-05-25 — useParty now accepts the current user id so it can
// scope the last-party localStorage cache (lib/lastParty.ts) to the
// signed-in user. Optional — when undefined, caching is skipped and the
// modal's "Recently in" pill simply won't render. Callers that already
// have user.id should pass it (App.tsx does).
export function useParty(currentUserId?: number): UseParty {
  const [state, setState] = useState<PartyState>(INITIAL_STATE)
  // Track the latest userId in a ref so the leave callback's stable
  // identity doesn't capture a stale id when the user logs in/out
  // mid-session. Also avoids re-creating callbacks every render.
  const currentUserIdRef = useRef<number | undefined>(currentUserId)
  currentUserIdRef.current = currentUserId
  const roomWsRef = useRef<WebSocket | null>(null)
  const syncWsRef = useRef<WebSocket | null>(null)
  const tickRef = useRef<TickPayload | null>(null)
  const seekRef = useRef<ReceivedSeekPayload | null>(null)
  const seekSequenceRef = useRef(0)
  // Room and sync events share a server revision but travel over independent
  // WebSockets. This ref orders them synchronously before React state commits.
  const latestAcceptedRevRef = useRef(0)
  // A room reconnect can land on a restarted server whose in-memory party
  // revision begins again at 1. Its first snapshot establishes a new floor;
  // subsequent room/sync frames retain normal monotonic ordering.
  const awaitingRoomSnapshotRef = useRef(true)
  const acceptRevision = useCallback((incomingRev: number | undefined): boolean => {
    if (!shouldAcceptPartyRevision(latestAcceptedRevRef.current, incomingRev)) return false
    if (incomingRev !== undefined) {
      latestAcceptedRevRef.current = Math.max(latestAcceptedRevRef.current, incomingRev)
    }
    return true
  }, [])
  const helloAbsMsRef = useRef<number>(0)
  // 2026-05-25 — clock-offset estimation via repeated time-syncs.
  // EMA-smoothed across samples (newest weighted 30%) so a single
  // spike from a busy CPU doesn't blow the estimate.
  const clockOffsetRef = useRef<number>(0)
  const rttRef = useRef<number>(0)
  // Tracks whether we've done the initial 5-shot burst since the sync
  // socket opened. Cleared on sync-socket close so reconnects re-burst.
  const timeSyncBurstDoneRef = useRef<boolean>(false)
  // Interval handle for the steady-state 30s pings.
  const timeSyncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // The latest party-code we attempted to join. Used by reconnect
  // logic + to refuse late onmessage callbacks from a previous join
  // attempt the user already left.
  const activeCodeRef = useRef<string | null>(null)

  // Phase 4.6 — voice controller. Created once per hook instance.
  // Its `send` callback delivers signaling messages over the room
  // socket; `subscribe` lets us mirror its state into React state
  // for UI re-renders.
  const voiceRef = useRef<VoiceController | null>(null)
  const [voiceState, setVoiceState] = useState<VoiceState>({
    enabled: false, muted: true, peers: [], selfSpeaking: false, status: 'Off',
  })
  if (!voiceRef.current) {
    voiceRef.current = createVoiceController({
      send: (msg) => {
        const ws = roomWsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) return false
        try { ws.send(JSON.stringify(msg)); return true } catch { return false }
      },
    })
    voiceRef.current.subscribe(() => {
      // Snapshot — getState rebuilds the peer list each call, so the
      // returned object identity changes every notify and React
      // re-renders.
      setVoiceState(voiceRef.current!.getState())
    })
  }
  // Audit H1 (P4) — buffered sync intent. The host's video element
  // can fire play/pause/seeked BEFORE the sync socket finishes its
  // WS handshake (sync opens lazily after the room socket's first
  // party-state message). Without buffering, those early request*
  // calls silently no-op'd and the server never learned the host
  // had hit play. Guests joining after that point saw is_playing=
  // false until the host pause+played again.
  //
  // 2026-06 review (bug 3) — ONE SLOT PER INTENT KIND, not a single
  // last-write-wins slot. The old single slot let the host-broadcast
  // recovery's requestPlay() overwrite a buffered seek (host seeks
  // before sync opens → recovery fires → seek lost). Seek and
  // play/pause are buffered independently; play vs pause still
  // last-write-wins against each other (only the final state matters).
  // Flush order is seek FIRST, then play/pause: the server's seek
  // preserves Running and play resumes from the (new) anchor, so this
  // order is correct for every interleaving.
  const pendingSyncIntentRef = useRef<{ seek?: OutboundSyncMessage; playPause?: OutboundSyncMessage }>({})
  // Phase 5 — media-change subscribers. Used by the App-level player
  // glue to swap playerTarget when the host advances to a new
  // episode mid-party.
  const mediaChangeSubsRef = useRef<Set<(p: { media_item_id: number; episode_id?: number; rev?: number }) => void>>(new Set())
  // 2026-08 — host-succession subscribers (the App-level toast).
  const hostChangeSubsRef = useRef<Set<(p: HostChangedEvent) => void>>(new Set())
  // 2026-05-25 — room-socket keepalive + reconnect machinery.
  // heartbeatTimerRef holds the setInterval handle that fires a
  // `{type: "heartbeat"}` data frame every ROOM_HEARTBEAT_INTERVAL_MS
  // while the room WS is open. Resets every reasonable upstream
  // proxy's idle timer; specifically required at aurorapro.app where
  // Cloudflare was killing the room WS at exactly 90s of "idleness"
  // (control-frame PING/PONG didn't count).
  //
  // reconnectAttemptRef counts in-flight reconnect attempts after an
  // unexpected close. Reset to 0 on successful WS open or explicit
  // leave. reconnectTimerRef holds the setTimeout for the backoff
  // delay so we can cancel it if the user leaves mid-backoff.
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reconnectAttemptRef = useRef<number>(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 2026-05-29 — sync-socket reconnect counters, independent of the
  // room socket's. syncReconnectAttemptRef counts in-flight sync
  // reconnects after an unexpected sync-only close; reset to 0 on a
  // successful sync open, explicit leave, or a room-driven sync reopen.
  // syncReconnectTimerRef holds the backoff setTimeout so we can cancel
  // it (on leave, OR when the room socket drives its own sync reopen
  // and we must not double-open).
  const syncReconnectAttemptRef = useRef<number>(0)
  const syncReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks whether the user explicitly left (leave-party) — used to
  // suppress reconnect attempts after a deliberate teardown.
  const userInitiatedLeaveRef = useRef<boolean>(false)

  const setStatePatch = useCallback((patch: Partial<PartyState> | ((s: PartyState) => Partial<PartyState>)) => {
    setState(prev => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }))
  }, [])

  // Stop the heartbeat interval. Called on WS close, leave, unmount.
  // Safe to call when no timer is set — clearInterval on null is a no-op
  // here because we guard.
  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
  }, [])

  // Cancel any pending reconnect timer. Called on leave or unmount.
  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  // 2026-05-29 — cancel any pending SYNC reconnect timer. Called on
  // leave/unmount AND on the room-driven sync reopen path so the two
  // reopen routes (sync's own backoff vs. room's party-state) can't
  // race into a double-open of the sync socket.
  const cancelSyncReconnect = useCallback(() => {
    if (syncReconnectTimerRef.current) {
      clearTimeout(syncReconnectTimerRef.current)
      syncReconnectTimerRef.current = null
    }
  }, [])

  // 2026-05-25 — stop time-sync interval. Called on sync-WS close so a
  // dead socket doesn't keep firing send() into a closed FD (it would
  // throw silently but still burn CPU). Re-armed on next openSyncSocket.
  //
  // 2026-05-25 deep-debug (Medium #2) — do NOT reset clockOffsetRef /
  // rttRef here. The drift loop in VideoPlayer.tsx continues running
  // during the sync-WS-down window (it polls tickRef + clockOffsetRef
  // on a 250ms interval). If we zero the offset during teardown, the
  // drift loop's `correctedNow = Date.now() + 0` computation suddenly
  // operates without skew correction for a few hundred ms. A guest
  // with significant clock skew + pre-existing real drift could see
  // the apparent drift cross DRIFT_HARD_MS, triggering a visible
  // hard-snap that's purely an artifact of the offset reset (not real
  // drift). Instead, reset in openSyncSocket's onopen — the offset
  // stays current right up until the new socket replaces it, and the
  // new burst overwrites it within ~250ms.
  //
  // Previously this also called timeSyncBurstDoneRef.current = false
  // which the onopen burst block needs; that flag is now reset
  // explicitly in onopen alongside the EMA refs (single canonical
  // reset point).
  const stopTimeSync = useCallback(() => {
    if (timeSyncTimerRef.current) {
      clearInterval(timeSyncTimerRef.current)
      timeSyncTimerRef.current = null
    }
  }, [])

  const closeSockets = useCallback(() => {
    stopHeartbeat()
    stopTimeSync()
    cancelReconnect()
    cancelSyncReconnect()
    if (syncWsRef.current) {
      try { syncWsRef.current.close() } catch { /* defensive */ }
      syncWsRef.current = null
    }
    if (roomWsRef.current) {
      try { roomWsRef.current.close() } catch { /* defensive */ }
      roomWsRef.current = null
    }
    // Phase 4.6 — losing the room socket = voice is gone too.
    voiceRef.current?.onRoomSocketDown()
  }, [stopHeartbeat, stopTimeSync, cancelReconnect, cancelSyncReconnect])

  const leave = useCallback(() => {
    // 2026-05-25 — stash the just-left party in localStorage BEFORE
    // we wipe React state, so the join-modal's "Recently in" pill has
    // something to surface for accidental-leave recovery. Scoped to
    // currentUserId so logging out + back in as a different user
    // doesn't leak the prior user's history. Since host succession
    // (2026-08), a host's leave hands the party off rather than ending
    // it, so the rejoin genuinely works whenever anyone stayed behind
    // (the ex-host comes back as a guest); if the party ended for lack
    // of a successor, the rejoin 404s and the pill self-clears.
    const userId = currentUserIdRef.current
    if (userId && state.code) {
      cacheLastParty({
        userId,
        code: state.code,
        partyName: state.partyName,
        mediaTitle: state.mediaTitle,
        wasHost: state.hostUserId === userId,
      })
    }
    // Mark this as user-initiated FIRST so any pending close handlers
    // know not to attempt reconnect. Without this flag, calling leave()
    // would trigger closeSockets() → onclose fires → reconnect loop
    // starts → user is unexpectedly rejoined moments later.
    userInitiatedLeaveRef.current = true
    // Try to send a clean leave-party on the room socket before close
    // so the server fires participant-left to everyone else promptly.
    // (The server will eventually GC us on the socket-close path too,
    // but with a few seconds of lag — explicit is better.)
    const rws = roomWsRef.current
    if (rws && rws.readyState === WebSocket.OPEN) {
      const msg: OutboundRoomMessage = { type: 'leave-party' }
      try { rws.send(JSON.stringify(msg)) } catch { /* defensive */ }
    }
    activeCodeRef.current = null
    reconnectAttemptRef.current = 0
    syncReconnectAttemptRef.current = 0
    closeSockets()
    setState(INITIAL_STATE)
    tickRef.current = null
    seekRef.current = null
    latestAcceptedRevRef.current = 0
    helloAbsMsRef.current = 0
    // Audit H1 (P4) — clear any buffered sync intents so a stale
    // play/pause/seek from the previous party doesn't replay against
    // the next one when its sync socket opens.
    pendingSyncIntentRef.current = {}
  }, [closeSockets, state.code, state.partyName, state.mediaTitle, state.hostUserId])

  const handleRoomMessage = useCallback((raw: string) => {
    let msg: InboundRoomMessage
    try { msg = JSON.parse(raw) } catch { return }
    if (!msg || typeof msg !== 'object') return
    // Phase 4.6 — voice signaling rides the room socket. Hand off
    // before the chat/state switch so voice messages don't fall
    // through to the default (no-op) branch.
    if (msg.type === 'voice-peers' || msg.type === 'voice-peer-joined' ||
        msg.type === 'voice-peer-left' || msg.type === 'voice-offer' ||
        msg.type === 'voice-answer' || msg.type === 'voice-ice') {
      voiceRef.current?.handleInbound(msg)
      return
    }
    switch (msg.type) {
      case 'party-state': {
        // 2026-05-25 critical bug fix — production diagnosis at
        // aurorapro.app:
        //   1. POST /api/parties → 201 (server creates party)
        //   2. useParty.join sets state.code = "YZ8BN4" via setStatePatch
        //   3. /ws/party-room opens, server sends party-state
        //   4. This handler USED to read `payload.{code, party_name,
        //      media_title, ...}` directly — but the server nests those
        //      inside `payload.party`. So `p.code` was undefined.
        //   5. setStatePatch with `code: undefined` overwrote the
        //      previously-set code → state.code became undefined.
        //   6. UI re-rendered: no green dot, no panel, no toast.
        //
        // Confirmed via MutationObserver in production: title
        // transitioned "Join a watch party" → "In party YZ8BN4" →
        // "Join a watch party" within 321ms. Confirmed via server
        // source: manager.go's BuildPartyStateMessage uses a nested
        // {party: {code, party_name, ...}} structure.
        //
        // The participants + chat_history fields ARE at the payload
        // root (server keeps them out of the nested object). Server
        // sends `revision` here vs `rev` elsewhere; we map both.
        const p = msg.payload
        const inner = p.party || {}
        if (inner.code !== activeCodeRef.current) break
        if (awaitingRoomSnapshotRef.current) {
          awaitingRoomSnapshotRef.current = false
          latestAcceptedRevRef.current = 0
          tickRef.current = null
          seekRef.current = null
          helloAbsMsRef.current = 0
        }
        const acceptsSnapshot = acceptRevision(inner.revision)
        // Audit MED-3 (Phase 4.5 final) — clear recentReactions when
        // the party's mediaItemId changes vs. our current state.
        // Phase 4 doesn't handle media-change broadcasts yet, but
        // a fresh party-state arrival (e.g. host swapped media in
        // V1, server emits a new state snapshot) IS the boundary.
        // Without this, reactions from the previous movie keep
        // floating on screen after the swap.
        setStatePatch(prev => ({
          participants: p.participants ?? [],
          chat: (p.chat_history ?? []).slice(-MAX_CHAT),
          error: null,
          ...(acceptsSnapshot ? {
            code: inner.code,
            partyName: inner.party_name,
            mediaTitle: inner.media_title,
            mediaPoster: inner.media_poster,
            mediaItemId: inner.media_item_id,
            episodeId: inner.episode_id,
            hostUserId: inner.host_user_id,
            isPlaying: inner.is_playing,
            currentTimeMs: inner.current_time_ms,
            rev: inner.revision ?? prev.rev,
            scheduledStartAt: inner.scheduled_start_at ?? null,
            startedAt: inner.started_at ?? null,
            recentReactions:
              prev.mediaItemId && prev.mediaItemId !== inner.media_item_id
                ? []
                : prev.recentReactions,
          } : {}),
        }))
        // 2026-05-25 — refresh the last-party cache with the
        // server-authoritative values. This catches the "user
        // refreshed the tab mid-party" case: on the next page load,
        // the modal's Recently in pill knows where to send them. We
        // read from `inner` directly (not React state) because the
        // setStatePatch above is async and we want the latest server
        // truth.
        {
          const userId = currentUserIdRef.current
          if (acceptsSnapshot && userId && inner.code) {
            cacheLastParty({
              userId,
              code: inner.code,
              partyName: inner.party_name,
              mediaTitle: inner.media_title,
              wasHost: inner.host_user_id === userId,
            })
          }
        }
        // First party-state arrival is the cue to open the sync
        // socket. openSyncSocket is idempotent via the syncWsRef
        // guard.
        //
        // 2026-05-29 — this is the ROOM-DRIVEN sync reopen path. If a
        // sync-only drop already armed a backoff reconnect (sync's own
        // onclose), this party-state arrival wins: cancel that pending
        // timer and reset the counter first, so the two reopen routes
        // can't both fire and leave two sync sockets racing. (The
        // explicit open below replaces what the timer would have done.)
        if (!syncWsRef.current && activeCodeRef.current) {
          cancelSyncReconnect()
          syncReconnectAttemptRef.current = 0
          openSyncSocket(activeCodeRef.current)
        }
        break
      }
      case 'participant-join':
      case 'participant-left': {
        // Refresh-from-server on participant events would be cleaner
        // but the server doesn't currently re-broadcast party-state
        // on these. Patch the local list optimistically.
        setStatePatch(prev => {
          const p = msg.payload
          if (msg.type === 'participant-left') {
            return { participants: prev.participants.filter(u => u.user_id !== p.user_id) }
          }
          if (prev.participants.some(u => u.user_id === p.user_id)) return {}
          // participantFromJoinEvent carries EVERY event field — the
          // inline object it replaced dropped `companion`, which made
          // PartyPanel's hand-off dialog count phone companions as
          // eligible hosts (see the helper's comment in lib/party.ts).
          return { participants: [...prev.participants, participantFromJoinEvent(p)] }
        })
        break
      }
      case 'host-changed': {
        // 2026-08 — host succession. Patch instantly so the crown moves
        // even if the follow-up party-state snapshot is lost to a blip;
        // the snapshot (revision-guarded) then confirms the same facts.
        const p = msg.payload
        setStatePatch(prev => ({
          hostUserId: p.new_host_user_id,
          participants: prev.participants.map(u => ({
            ...u,
            is_host: u.user_id === p.new_host_user_id,
          })),
        }))
        for (const cb of hostChangeSubsRef.current) {
          try { cb(p) } catch { /* defensive */ }
        }
        break
      }
      case 'chat-message': {
        const m = msg.payload
        setStatePatch(prev => ({ chat: [...prev.chat, m].slice(-MAX_CHAT) }))
        break
      }
      case 'reaction': {
        const r = msg.payload
        setStatePatch(prev => ({ recentReactions: [...prev.recentReactions, r].slice(-MAX_REACTIONS) }))
        break
      }
      case 'ready-changed': {
        const p = msg.payload
        setStatePatch(prev => ({
          participants: prev.participants.map(u =>
            u.user_id === p.user_id ? { ...u, ready: p.ready } : u
          ),
        }))
        break
      }
      case 'media-change': {
        const p = msg.payload
        if (!acceptRevision(p.rev)) break
        // Update party state to reflect the new media. The reaction
        // overlay clear (M5) already triggers on mediaItemId change
        // via the party-state setter pattern — apply it here too.
        setStatePatch(prev => ({
          mediaItemId: p.media_item_id,
          episodeId: p.episode_id,
          mediaTitle: p.media_title ?? prev.mediaTitle,
          mediaPoster: p.media_poster ?? prev.mediaPoster,
          isPlaying: false,
          currentTimeMs: 0,
          rev: p.rev ?? prev.rev,
          recentReactions: [],
        }))
        // Reset sync refs — the next hello on the sync socket will
        // arrive with the new media's anchor.
        tickRef.current = null
        seekRef.current = null
        helloAbsMsRef.current = 0
        // Fan out to consumers (App.tsx will re-emit playerTarget
        // for the new episode).
        for (const cb of mediaChangeSubsRef.current) {
          try { cb({ media_item_id: p.media_item_id, episode_id: p.episode_id, rev: p.rev }) } catch { /* defensive */ }
        }
        break
      }
      case 'party-scheduled': {
        // Host (re)booked or cleared the countdown. Null clears — the
        // lobby reverts to "host plays manually".
        setStatePatch({ scheduledStartAt: msg.payload.scheduled_start_at })
        break
      }
      case 'party-starting': {
        // The countdown fired (or the host started early): leave the
        // lobby state. isPlaying/anchor flow in via the sync socket's
        // own events; this just flips the panel out of countdown mode.
        setStatePatch({
          scheduledStartAt: null,
          startedAt: new Date(msg.payload.started_at_ms).toISOString(),
        })
        break
      }
      case 'party-ended': {
        // Server broadcasts party-ended when host clicks End. Tear
        // down + flash a one-shot error so the UI can show "party
        // ended" rather than just disconnecting silently.
        setStatePatch({ error: 'Party ended by host.' })
        // Defer the actual cleanup so the consumer can read the
        // error before state resets.
        setTimeout(() => {
          activeCodeRef.current = null
          closeSockets()
          tickRef.current = null
          seekRef.current = null
          latestAcceptedRevRef.current = 0
          helloAbsMsRef.current = 0
          // PARTY-9 — an intent buffered for the party that just ended
          // must not replay into the next party's sync socket.
          pendingSyncIntentRef.current = {}
          setState(INITIAL_STATE)
        }, 50)
        break
      }
      case 'error': {
        setStatePatch({ error: msg.payload.error })
        break
      }
    }
  // openSyncSocket is defined below — declare its identity via ref
  // would let us add it to deps, but the ref-pattern is overkill for
  // a function that already has stable identity through closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setStatePatch, closeSockets, cancelSyncReconnect, acceptRevision])

  const handleSyncMessage = useCallback((raw: string) => {
    let msg: InboundSyncMessage
    try { msg = JSON.parse(raw) } catch { return }
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'hello': {
        const p = msg.payload
        if (!acceptRevision(p.rev)) break
        const receivedAtMs = Date.now()
        helloAbsMsRef.current = p.abs_ms
        setStatePatch({
          hlsStartSec: p.hls_start_sec ?? 0,
          isPlaying: p.running,
          currentTimeMs: p.abs_ms,
          rev: p.rev ?? 0,
        })
        // Treat hello as both the initial tick and a one-shot rebase. A guest
        // reconnecting after a host seek never saw the original `seek` frame;
        // without this signal its old sequential HLS window cannot serve the
        // new absolute position and a raw currentTime assignment stalls.
        seekRef.current = receivedSeekFromHello(
          p,
          receivedAtMs,
          ++seekSequenceRef.current,
        )
        tickRef.current = { abs_ms: p.abs_ms, server_now_ms: p.server_now_ms, running: p.running, rev: p.rev, receivedAtMs }
        break
      }
      case 'tick': {
        if (!acceptRevision(msg.payload.rev)) break
        tickRef.current = { ...msg.payload, receivedAtMs: Date.now() }
        setStatePatch({
          isPlaying: msg.payload.running !== false,
          currentTimeMs: msg.payload.abs_ms,
          rev: msg.payload.rev ?? 0,
        })
        break
      }
      case 'pause': {
        const p = msg.payload
        if (!acceptRevision(p.rev)) break
        setStatePatch(prev =>
          (p.rev ?? 0) < prev.rev
            ? {}
            : { isPlaying: false, currentTimeMs: p.abs_ms, rev: p.rev ?? prev.rev }
        )
        tickRef.current = { abs_ms: p.abs_ms, server_now_ms: Date.now(), running: false, rev: p.rev, receivedAtMs: Date.now() }
        break
      }
      case 'seek': {
        const p = msg.payload
        if (!acceptRevision(p.rev)) break
        const receivedAtMs = Date.now()
        setStatePatch(prev =>
          (p.rev ?? 0) < prev.rev
            ? {}
            : { currentTimeMs: p.abs_ms, isPlaying: p.running ?? prev.isPlaying, rev: p.rev ?? prev.rev }
        )
        seekRef.current = {
          ...p,
          receivedAtMs,
          sequence: ++seekSequenceRef.current,
        }
        tickRef.current = { abs_ms: p.abs_ms, server_now_ms: receivedAtMs, running: p.running, rev: p.rev, receivedAtMs }
        break
      }
      case 'party-ended':
        setStatePatch({ error: 'Party ended by host.' })
        setTimeout(() => {
          activeCodeRef.current = null
          closeSockets()
          tickRef.current = null
          seekRef.current = null
          latestAcceptedRevRef.current = 0
          helloAbsMsRef.current = 0
          // PARTY-9 — see the room socket's party-ended teardown.
          pendingSyncIntentRef.current = {}
          setState(INITIAL_STATE)
        }, 50)
        break
      case 'time-sync-response': {
        // 2026-05-25 — NTP-style clock offset estimation. Standard
        // formula assuming symmetric one-way latency:
        //   offset ≈ ((server_recv - client_send) + (server_send - client_recv)) / 2
        //   rtt    ≈ (client_recv - client_send) - (server_send - server_recv)
        //
        // The split server_recv/server_send terms separate network RTT
        // from server processing time — if the server queues the response
        // for, say, 5ms, that 5ms shouldn't inflate our RTT estimate. The
        // protocol's authors clearly knew what they were doing.
        //
        // EMA smoothing across samples (30% new, 70% existing) absorbs
        // single-sample spikes from a busy CPU / TCP delayed-ack /
        // network jitter without drifting too slowly to react to real
        // clock drift on long sessions.
        const p = msg.payload
        const clientRecvMs = Date.now()
        const newOffset = ((p.server_recv_ms - p.client_send_ms) + (p.server_send_ms - clientRecvMs)) / 2
        const newRtt = (clientRecvMs - p.client_send_ms) - (p.server_send_ms - p.server_recv_ms)
        if (rttRef.current === 0) {
          // First sample: take it raw (no history to blend with).
          clockOffsetRef.current = newOffset
          rttRef.current = newRtt
        } else {
          clockOffsetRef.current = 0.7 * clockOffsetRef.current + 0.3 * newOffset
          rttRef.current = 0.7 * rttRef.current + 0.3 * newRtt
        }
        break
      }
      case 'error':
        setStatePatch({ error: msg.payload.error })
        break
    }
  }, [setStatePatch, closeSockets, acceptRevision])

  // 2026-05-25 — opens the room WebSocket and wires up:
  //   - onopen: send `join-party`, start heartbeat interval, mark
  //     roomConnected, clear reconnect counter
  //   - onmessage: route through handleRoomMessage (with stale-WS guard)
  //   - onclose: if NOT user-initiated, schedule a reconnect with
  //     exponential backoff; otherwise clean up and stay disconnected
  //
  // Re-callable: the reconnect path invokes this again with a fresh
  // token (in case the access token rotated during the outage). The
  // server's host-disconnect-grace-period (90s in manager.go) means
  // the party survives most transient outages without ending.
  //
  // Defined as a stable useCallback because the onclose handler
  // references it indirectly through openRoomSocketRef to avoid
  // stale-closure-captures of itself (a callback can't reference
  // itself synchronously).
  const openRoomSocketRef = useRef<((code: string, token: string) => void) | null>(null)
  const openRoomSocket = useCallback((code: string, token: string) => {
    // Belt-and-suspenders: if openRoomSocket is ever called from a
    // path that didn't go through `join()` (currently only the
    // reconnect timer does, but future callers might bypass `join`),
    // ensure the user-initiated-leave flag is cleared so the upcoming
    // onclose doesn't suppress its own reconnect by mistake.
    userInitiatedLeaveRef.current = false
    const rws = new WebSocket(buildWsUrl('/ws/party-room', token))
    roomWsRef.current = rws
    awaitingRoomSnapshotRef.current = true

    rws.onopen = () => {
      if (roomWsRef.current !== rws) return
      // Send the join-party handshake so the server registers us.
      const msg: OutboundRoomMessage = { type: 'join-party', payload: { party_code: code } }
      try { rws.send(JSON.stringify(msg)) } catch { /* defensive */ }

      // Reset reconnect counters and flip UI flags.
      reconnectAttemptRef.current = 0
      setStatePatch({ roomConnected: true, joining: false, reconnecting: false })

      // Start the keepalive. Clear any prior interval first
      // (defensive — should already be null after onclose, but harmless).
      stopHeartbeat()
      heartbeatTimerRef.current = setInterval(() => {
        const ws = roomWsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        try { ws.send(JSON.stringify({ type: 'heartbeat' } satisfies OutboundRoomMessage)) }
        catch { /* defensive — onclose will follow if the send failed for real */ }
      }, ROOM_HEARTBEAT_INTERVAL_MS)
    }

    rws.onmessage = ev => {
      // Stale-WS guard (Audit M3 P4) — a slow callback from an old WS
      // we already replaced via reconnect shouldn't mutate state.
      if (roomWsRef.current !== rws) return
      handleRoomMessage(ev.data)
    }

    rws.onclose = () => {
      // Only react if THIS socket is still the active one (not a
      // late close from a socket we already replaced).
      if (roomWsRef.current !== rws) return
      roomWsRef.current = null
      stopHeartbeat()

      // 2026-05-25 deep-debug (High #2) — force-close + null the sync
      // socket synchronously here. The sync socket's own onclose fires
      // asynchronously when its TCP RST arrives (typically tens-of-ms
      // later than the room's close, since they share a backend
      // connection lifecycle). If a room-WS reconnect succeeds in
      // that window, the party-state arrival's
      //   `if (!syncWsRef.current && activeCodeRef.current) openSyncSocket(...)`
      // guard sees a stale-but-not-null ref → never opens the new
      // sync socket. Chat works, ticks/seeks/plays are dead until
      // the user manually rejoins. Pre-PR-#80 the room-WS itself
      // failed before reconnect could succeed, masking this; PR #80
      // made room reconnect reliable enough that this race actually
      // triggers in practice.
      if (syncWsRef.current) {
        try { syncWsRef.current.close() } catch { /* defensive */ }
        syncWsRef.current = null
        setStatePatch({ syncConnected: false })
        stopTimeSync()
      }
      // 2026-05-29 — the room drop owns sync recovery from here: the
      // reconnected room socket's party-state will re-open sync. So
      // tear down any sync-driven reconnect that was already in flight
      // (from a prior sync-only drop) and clear its UI badge, so we
      // don't end up with the sync backoff and the room-driven reopen
      // both firing. Nulling syncWsRef above also makes the sync
      // socket's own (async) onclose guard a no-op, so it won't arm a
      // fresh sync reconnect here.
      cancelSyncReconnect()
      syncReconnectAttemptRef.current = 0
      setStatePatch({ syncReconnecting: false })

      // Suppress reconnect when the user explicitly left.
      if (userInitiatedLeaveRef.current) {
        setStatePatch({ roomConnected: false, reconnecting: false })
        return
      }

      const attempt = reconnectAttemptRef.current
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        // 2026-06 review (bug 4) — drop the last tick so the player's
        // drift loop stops mirroring frozen sync data (stale isPlaying /
        // position) from before the outage. The party is unreachable;
        // local playback free-runs until the user rejoins.
        tickRef.current = null
        setStatePatch({
          roomConnected: false,
          reconnecting: false,
          error: 'Lost connection to the party. Refresh to retry.',
        })
        return
      }

      // Schedule the next attempt with exp backoff.
      const delay = RECONNECT_BACKOFF_MS[attempt]
      reconnectAttemptRef.current = attempt + 1
      setStatePatch({ roomConnected: false, reconnecting: true })
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        // 2026-05-25 — REFRESH BEFORE RECONNECT. The access token has a
        // 15-min lifetime (api.ts TokenResponse / AccessTokenExpiry
        // server-side); watch parties commonly run longer than that,
        // and `?token=` is part of the WS upgrade URL — once expired,
        // every reconnect attempt 401s at the upgrade and the WS
        // closes immediately. We watched this kill the M76PQA party:
        // host's WS dropped ~12min in, all 5 reconnect attempts
        // failed against the expired token, server's 90s host-grace
        // expired, server broadcast `party-ended` to the guest, and
        // both clients lost party state while the HLS player kept
        // playing (player has its own scoped token, independent of
        // auth). Refreshing here is a 200-300ms no-op when the token
        // is still valid (server returns same exp) and rescues the
        // reconnect when it's expired. Awaited inside the timer so
        // backoff timing still gates the actual WS open.
        void (async () => {
          await refreshAccessToken().catch(() => false)
          const code = activeCodeRef.current
          if (!code || !getStoredUser()) {
            setStatePatch({ reconnecting: false })
            return
          }
          // Re-enter via the ref so the function picks up the latest closure.
          // deep-debug H10 — WS auth rides the httpOnly cookie; empty token.
          openRoomSocketRef.current?.(code, '')
        })()
      }, delay)
    }

    rws.onerror = () => { /* silent — close handler covers UI */ }
  }, [handleRoomMessage, setStatePatch, stopHeartbeat, stopTimeSync, cancelSyncReconnect])

  // Keep the ref pointed at the latest version so onclose can recurse
  // without stale-closure shenanigans.
  openRoomSocketRef.current = openRoomSocket

  // 2026-05-29 — same self-reference trick as openRoomSocketRef: the
  // sync socket's onclose schedules a reconnect that re-invokes
  // openSyncSocket, but a useCallback can't reference itself
  // synchronously, so it goes through this ref.
  const openSyncSocketRef = useRef<((code: string) => void) | null>(null)
  const openSyncSocket = useCallback((code: string) => {
    if (!getStoredUser()) return
    if (syncWsRef.current) return
    // A fresh open supersedes any pending sync-reconnect timer (e.g.
    // join() / room-driven reopen calling us while a backoff was
    // armed). Clear it so the timer doesn't later fire a duplicate.
    cancelSyncReconnect()
    // deep-debug H10 — empty token: the same-origin WS handshake sends the cookie.
    const ws = new WebSocket(buildWsUrl('/ws/party-sync', ''))
    syncWsRef.current = ws
    ws.onopen = () => {
      const msg: OutboundSyncMessage = { type: 'join-party', payload: { party_code: code } }
      try { ws.send(JSON.stringify(msg)) } catch { /* defensive */ }
      // 2026-05-29 — sync is back: reset the reconnect counter and
      // clear the "sync lost" badge (mirrors the room socket's onopen).
      syncReconnectAttemptRef.current = 0
      setStatePatch({ syncConnected: true, syncReconnecting: false })
      // Audit H1 (P4) — flush the buffered intents NOW that we're
      // connected. The most common case: host's MANIFEST_PARSED
      // auto-fired vid.play() which called requestPlay before sync
      // was open. Without this replay, the server never learns the
      // host is playing. Seek flushes BEFORE play/pause (see the
      // pendingSyncIntentRef doc for why that order is always right).
      const pending = pendingSyncIntentRef.current
      pendingSyncIntentRef.current = {}
      if (pending.seek) {
        try { ws.send(JSON.stringify(pending.seek)) } catch { /* defensive */ }
      }
      if (pending.playPause) {
        // 2026-06 review — when BOTH a seek and a pause are buffered, the
        // pause's captured at_ms predates the seek (the slots don't
        // record order), so sending it verbatim would yank the party back
        // to the pre-seek position. at_ms:-1 tells the server "pause at
        // the current canonical position", which after the seek above is
        // exactly the seek target.
        let out = pending.playPause
        if (pending.seek && out.type === 'request-pause') {
          out = partyPauseRequest(-1)
        }
        try { ws.send(JSON.stringify(out)) } catch { /* defensive */ }
      }
      // 2026-05-25 — start clock-offset estimation via repeated
      // time-syncs. We use a 5-shot burst at 250ms intervals to get a
      // fast, reasonably-accurate initial estimate (single-sample RTT
      // can vary by 100ms+ depending on the OS scheduler, batching 5
      // and EMA-smoothing converges quickly), then settle to a 30s
      // steady-state ping to catch any clock drift on long sessions.
      //
      // The 30s cadence is chosen to be much faster than typical OS
      // clock drift (usually <1ms/s) but slow enough that we don't
      // spam the server. Each time-sync is ~50 bytes, so 2 messages/
      // minute is negligible.
      const sendTimeSync = () => {
        if (syncWsRef.current !== ws) return // stale
        if (ws.readyState !== WebSocket.OPEN) return
        const payload = {
          client_send_ms: Date.now(),
          // Send our last-measured RTT/offset back to the server for
          // observability (manager.RecordRTT logs it). Optional fields —
          // server ignores zeroes from our first-ever ping.
          measured_rtt_ms: Math.round(rttRef.current),
          measured_offset_ms: Math.round(clockOffsetRef.current),
        }
        const m: OutboundSyncMessage = { type: 'time-sync', payload }
        try { ws.send(JSON.stringify(m)) } catch { /* defensive */ }
      }
      // 2026-05-25 deep-debug (round 2, M1) — only reset rttRef, NOT
      // clockOffsetRef. The first-sample-raw guard in handleSyncMessage
      // (case 'time-sync-response') keys on `rttRef.current === 0`,
      // not on clockOffset. Zeroing clockOffset here opens a ~50-300ms
      // window where the drift loop sees clockOffset=0 against a stale
      // tick from the previous session, which could push apparent
      // drift across DRIFT_HARD_MS for a guest with significant clock
      // skew + pre-existing real drift in the same direction. Leaving
      // the previous session's offset untouched gives the drift loop
      // a stable (if slightly stale) reading until the first new
      // time-sync response lands and overwrites it cleanly.
      stopTimeSync()
      rttRef.current = 0
      timeSyncBurstDoneRef.current = true
      sendTimeSync() // first sample, fires immediately
      for (let i = 1; i < 5; i++) {
        setTimeout(sendTimeSync, i * 250)
      }
      timeSyncTimerRef.current = setInterval(sendTimeSync, 30_000)
    }
    ws.onmessage = ev => {
      // Audit M3 (P4) — drop messages from a stale ws. If the user
      // left + rejoined fast, an in-flight message from the previous
      // sync socket could land here after the new one has set state.
      if (syncWsRef.current !== ws) return
      handleSyncMessage(ev.data)
    }
    ws.onclose = () => {
      // Only react if THIS socket is still the active one. A late close
      // from a socket we already replaced — or one the room's onclose
      // already force-closed + nulled (the room then owns sync reopen
      // via its next party-state) — must NOT arm a reconnect here.
      if (syncWsRef.current !== ws) return
      syncWsRef.current = null
      setStatePatch({ syncConnected: false })
      // Stop pinging into a closed socket; onopen re-arms the burst.
      stopTimeSync()

      // 2026-05-29 — independent sync reconnect with exponential
      // backoff, mirroring openRoomSocket's onclose. A sync-only drop
      // (proxy idle-timeout while the room WS stays alive) used to
      // leave hello/tick/pause/seek dead with no recovery + no UI
      // signal. Reuses the room's activeCodeRef + userInitiatedLeaveRef
      // guards so an intentional leave / party-end stops it.

      // Intentional leave (or a teardown that nulled activeCodeRef, e.g.
      // party-ended): stay down, clear the badge, don't reconnect.
      if (userInitiatedLeaveRef.current || !activeCodeRef.current) {
        setStatePatch({ syncReconnecting: false })
        return
      }

      const attempt = syncReconnectAttemptRef.current
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        // Give up the dedicated retries, but DON'T surface a fatal
        // `error` like the room path does: the room socket is (by
        // construction here) still healthy, so chat/participants keep
        // working and a future room party-state can still re-open sync.
        // We just stop the badge + the backoff loop.
        //
        // 2026-06 review (bug 4) — also drop the last tick: with sync
        // permanently down, the drift loop would otherwise keep
        // correcting against a frozen position (and the stale clock
        // offset) indefinitely. Free-run until sync comes back; a fresh
        // hello repopulates tickRef on reopen.
        tickRef.current = null
        setStatePatch({ syncReconnecting: false })
        return
      }

      // Schedule the next attempt with exp backoff (same curve as room).
      const delay = RECONNECT_BACKOFF_MS[attempt]
      syncReconnectAttemptRef.current = attempt + 1
      setStatePatch({ syncReconnecting: true })
      syncReconnectTimerRef.current = setTimeout(() => {
        syncReconnectTimerRef.current = null
        // Refresh before reconnect for the same reason the room path
        // does: the sync WS upgrade authenticates via the httpOnly
        // cookie, which can expire on long sessions. A no-op (~200ms)
        // when still valid; rescues the reconnect when expired.
        void (async () => {
          await refreshAccessToken().catch(() => false)
          const code = activeCodeRef.current
          // Re-check guards after the await — the user may have left,
          // the room may have driven its own sync reopen, or signed out
          // during the refresh round-trip.
          if (!code || !getStoredUser() || userInitiatedLeaveRef.current || syncWsRef.current) {
            setStatePatch({ syncReconnecting: false })
            return
          }
          openSyncSocketRef.current?.(code)
        })()
      }, delay)
    }
    ws.onerror = () => { /* silent — onclose handles cleanup */ }
  }, [handleSyncMessage, setStatePatch, stopTimeSync, cancelSyncReconnect])

  // Keep the ref pointed at the latest version so the sync onclose can
  // recurse without stale-closure shenanigans (mirrors openRoomSocketRef).
  openSyncSocketRef.current = openSyncSocket

  const join = useCallback(async (rawCode: string, opts?: { skipPreflight?: boolean }): Promise<{ ok: boolean; error?: string }> => {
    const code = rawCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      const error = 'Party code must be 6 letters or digits.'
      setStatePatch({ error })
      return { ok: false, error }
    }
    // Tear down anything prior.
    activeCodeRef.current = null
    closeSockets()
    setState({ ...INITIAL_STATE, joining: true })
    tickRef.current = null
    seekRef.current = null
    latestAcceptedRevRef.current = 0
    helloAbsMsRef.current = 0
    // PARTY-9 — intents buffered for the party being left belong to it, not
    // to the one being joined (leave() and end() already drop them).
    pendingSyncIntentRef.current = {}
    // Preflight: distinguish a live party from a persistent-room
    // code. We don't deeply use the response yet (Phase 4.5 will
    // render an "offline room" panel) but we use the success/404 to
    // surface friendly errors before opening the WS.
    //
    // QA 2026-05-25 — skip the preflight for create-then-join flows.
    // Production observed the preflight failing silently for parties
    // we JUST created, leaving the room socket unopened and the user
    // staring at an unchanged detail page. We trust the caller when
    // they say "I made this code, just join it."
    if (!opts?.skipPreflight) {
      try {
        const info = await apiFetch<CodeInfo>(`/api/code/${encodeURIComponent(code)}/info`)
        // Backend distinguishes "active" (live party) from "offline_room"
        // (persistent room with no live session). Only "active" is
        // joinable — for "offline_room" surface a friendly message so
        // the user knows to start the party from the room first.
        if (info.type !== 'active') {
          const error = 'That code is a persistent room; no live session right now.'
          setStatePatch({ joining: false, error })
          return { ok: false, error }
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Invalid party code.'
        setStatePatch({ joining: false, error })
        return { ok: false, error }
      }
    }

    if (!getStoredUser()) {
      const error = 'You must be signed in to join a party.'
      setStatePatch({ joining: false, error })
      return { ok: false, error }
    }
    activeCodeRef.current = code
    userInitiatedLeaveRef.current = false
    reconnectAttemptRef.current = 0
    setStatePatch({ code, joining: true })

    openRoomSocket(code, '') // deep-debug H10 — WS auth via httpOnly cookie
    return { ok: true }
  }, [closeSockets, setStatePatch, openRoomSocket])

  const sendChat = useCallback((message: string) => {
    const trimmed = message.trim()
    if (!trimmed) return
    const ws = roomWsRef.current
    // 2026-06 review (bug 5) — surface send failures instead of
    // swallowing them. The composer clears the draft on send, so a
    // silent drop meant the user's message vanished with no feedback.
    // Server-side rejections (rate limit, chat disabled) already
    // surface via the inbound `error` frame → state.error banner; this
    // covers the client-side failure modes (socket not open / send
    // threw). The next successful action clears the banner.
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatePatch({ error: 'Message not sent — reconnecting to the party. Try again in a moment.' })
      return
    }
    const out: OutboundRoomMessage = { type: 'chat', payload: { message: trimmed } }
    try {
      ws.send(JSON.stringify(out))
      // A successful send clears any prior send-failure banner so the
      // error doesn't linger after the connection recovers.
      setStatePatch(prev => (prev.error ? { error: null } : {}))
    } catch {
      setStatePatch({ error: 'Message not sent — connection hiccup. Try again.' })
    }
  }, [setStatePatch])

  // Phase 4.6 — ready flag for spoiler-free start gate. Host
  // evaluates "everyone ready?" and decides whether to play; guests
  // click "I'm Ready" so the host knows the group is buffered + in
  // the room. Server broadcasts ready-changed; useParty's reducer
  // updates the participant.
  const sendReady = useCallback((ready: boolean) => {
    const ws = roomWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const out: OutboundRoomMessage = { type: 'ready', payload: { ready } }
    try { ws.send(JSON.stringify(out)) } catch { /* defensive */ }
  }, [])

  const sendReaction = useCallback((emoji: string, absMs?: number) => {
    const ws = roomWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const out: OutboundRoomMessage = { type: 'reaction', payload: { emoji, abs_ms: absMs ?? 0 } }
    try { ws.send(JSON.stringify(out)) } catch { /* defensive */ }
  }, [])

  // Issue #460 — host advances the whole party to the next episode.
  // Deliberately NOT buffered like the sync-socket request* helpers: a
  // replayed advance after a reconnect could jump the room an episode
  // ahead of what the host is looking at. A failed send reports false and
  // the caller re-offers the button.
  //
  // No local state is patched here. The server echoes `media-change` to
  // every room conn INCLUDING this one, so the host re-points through the
  // same onMediaChange resolver as guests — one code path, and the host
  // never gets ahead of a swap the server rejected (e.g. host-only check
  // lost to a succession race).
  const changeMedia = useCallback((p: { mediaItemId: number; episodeId?: number; mediaTitle: string; mediaPoster: string }) => {
    const ws = roomWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try { ws.send(JSON.stringify(changeMediaRequest(p))) } catch { return false }
    return true
  }, [])

  // Audit H1 (P4) — request* methods buffer the intent when the sync
  // socket isn't OPEN yet (it opens lazily after party-state arrives
  // on the room socket — typically 100-300ms after the user joins).
  // The replay happens in openSyncSocket's onopen handler. Seek is
  // buffered in its own slot so a later play/pause can't clobber it
  // (2026-06 review, bug 3); within each slot the newest intent wins.
  const sendOrBuffer = useCallback((msg: OutboundSyncMessage) => {
    const ws = syncWsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)) } catch { /* defensive */ }
      return
    }
    // PARTY-9 — with no party being joined or in, there is no party for
    // the intent to belong to, and buffering it would hand it to whichever
    // party is joined next.
    if (!activeCodeRef.current) return
    if (msg.type === 'request-seek') {
      pendingSyncIntentRef.current.seek = msg
    } else {
      pendingSyncIntentRef.current.playPause = msg
    }
  }, [])
  const requestPlay = useCallback(() => {
    sendOrBuffer({ type: 'request-play' })
  }, [sendOrBuffer])
  const requestPause = useCallback((absMs: number) => {
    sendOrBuffer(partyPauseRequest(absMs))
  }, [sendOrBuffer])
  const requestSeek = useCallback((absMs: number) => {
    sendOrBuffer(partySeekRequest(absMs))
  }, [sendOrBuffer])
  // Test seam (PARTY-9): a copy of the buffered sync intents. join() is
  // the only way into a party and it clears the buffer first, so the
  // party-ended teardowns' clears cannot be seen through the rest of this
  // API; the regression tests read the buffer here to pin each one. Not
  // for app use.
  const pendingSyncIntentsForTests = useCallback(
    () => ({ ...pendingSyncIntentRef.current }),
    [],
  )

  // Tear down on unmount — without this, navigating away from V2
  // (or refreshing) would orphan the sockets server-side until the
  // browser GC closes them.
  useEffect(() => {
    return () => closeSockets()
  }, [closeSockets])

  // Phase 4.6 — voice public API.
  const joinVoice = useCallback(async () => {
    if (!voiceRef.current) return
    await voiceRef.current.join()
  }, [])
  const leaveVoice = useCallback(() => {
    voiceRef.current?.leave(/*emitLeave=*/true)
  }, [])
  const toggleVoiceMute = useCallback(() => {
    voiceRef.current?.toggleMute()
  }, [])

  const onMediaChange = useCallback((cb: (p: { media_item_id: number; episode_id?: number }) => void) => {
    mediaChangeSubsRef.current.add(cb)
    return () => { mediaChangeSubsRef.current.delete(cb) }
  }, [])

  const onHostChange = useCallback((cb: (p: HostChangedEvent) => void) => {
    hostChangeSubsRef.current.add(cb)
    return () => { hostChangeSubsRef.current.delete(cb) }
  }, [])

  // 2026-08 — the deliberate end-for-everyone. Distinct from leave():
  // since host succession, a host's leave hands the party off; ending it
  // is this explicit host-only action. POST first, tear down only on
  // success — a failed end must leave the session intact (the party is
  // still live for everyone, including us).
  const end = useCallback(async (): Promise<boolean> => {
    const code = activeCodeRef.current
    if (!code) return false
    // Flag BEFORE the await: the server broadcasts party-ended and closes
    // our sockets before the HTTP 200 arrives, and the room onclose must
    // not arm a reconnect against the party we are ending. Restored on
    // failure so a later real drop still reconnects.
    userInitiatedLeaveRef.current = true
    try {
      await apiFetch(`/api/parties/${encodeURIComponent(code)}/end`, { method: 'POST' })
    } catch (err) {
      userInitiatedLeaveRef.current = false
      setStatePatch({
        error: err instanceof Error ? err.message : 'Failed to end the party.',
      })
      return false
    }
    // Local teardown mirrors leave()'s, minus the leave-party frame (the
    // server already ended the party) and minus the last-party cache —
    // an ended party's code is dead, so "Recently in" must not offer it.
    activeCodeRef.current = null
    reconnectAttemptRef.current = 0
    syncReconnectAttemptRef.current = 0
    closeSockets()
    setState(INITIAL_STATE)
    tickRef.current = null
    seekRef.current = null
    latestAcceptedRevRef.current = 0
    helloAbsMsRef.current = 0
    // Same Audit H1 (P4) guard leave() carries: no stale intents may
    // replay against a future party's sync socket.
    pendingSyncIntentRef.current = {}
    return true
  }, [closeSockets, setStatePatch])

  return {
    state,
    voice: voiceState,
    joinVoice,
    leaveVoice,
    toggleVoiceMute,
    join,
    leave,
    sendChat,
    sendReaction,
    sendReady,
    changeMedia,
    requestPlay,
    requestPause,
    requestSeek,
    __pendingSyncIntentsForTests: pendingSyncIntentsForTests,
    tickRef,
    seekRef,
    helloAbsMsRef,
    clockOffsetRef,
    rttRef,
    onMediaChange,
    onHostChange,
    end,
  }
}
