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
  type ChatMessageEvent,
  type CodeInfo,
  type InboundRoomMessage,
  type InboundSyncMessage,
  type OutboundRoomMessage,
  type OutboundSyncMessage,
  type PartyParticipant,
  type ReactionEvent,
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
  onMediaChange: (cb: (payload: { media_item_id: number; episode_id?: number }) => void) => () => void
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
  // Sync-socket actions — used by the VideoPlayer when the user is
  // the host. Guests' player events do NOT broadcast (host is the
  // sync authority).
  requestPlay: () => void
  requestPause: (absMs: number) => void
  requestSeek: (absMs: number) => void
  // Live sync values for the player effect. Refs avoid causing
  // re-renders on every tick (which fires at 1-2 Hz).
  tickRef: React.MutableRefObject<TickPayload | null>
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
  // We store only the MOST RECENT pending intent — the host clicking
  // play→pause→play in rapid succession should result in "play"
  // being sent once the socket opens, not a queue of redundant ops.
  const pendingSyncIntentRef = useRef<OutboundSyncMessage | null>(null)
  // Phase 5 — media-change subscribers. Used by the App-level player
  // glue to swap playerTarget when the host advances to a new
  // episode mid-party.
  const mediaChangeSubsRef = useRef<Set<(p: { media_item_id: number; episode_id?: number }) => void>>(new Set())
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
  }, [stopHeartbeat, stopTimeSync, cancelReconnect])

  const leave = useCallback(() => {
    // 2026-05-25 — stash the just-left party in localStorage BEFORE
    // we wipe React state, so the join-modal's "Recently in" pill has
    // something to surface for accidental-leave recovery. Scoped to
    // currentUserId so logging out + back in as a different user
    // doesn't leak the prior user's history. Quick-parties die
    // server-side immediately on host-leave; the rejoin attempt will
    // 404 and the pill self-clears. For guests + persistent rooms,
    // the rejoin actually works.
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
    closeSockets()
    setState(INITIAL_STATE)
    tickRef.current = null
    helloAbsMsRef.current = 0
    // Audit H1 (P4) — clear any buffered sync intent so a stale
    // play/pause from the previous party doesn't replay against
    // the next one when its sync socket opens.
    pendingSyncIntentRef.current = null
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
        // Audit MED-3 (Phase 4.5 final) — clear recentReactions when
        // the party's mediaItemId changes vs. our current state.
        // Phase 4 doesn't handle media-change broadcasts yet, but
        // a fresh party-state arrival (e.g. host swapped media in
        // V1, server emits a new state snapshot) IS the boundary.
        // Without this, reactions from the previous movie keep
        // floating on screen after the swap.
        setStatePatch(prev => ({
          code: inner.code,
          partyName: inner.party_name,
          mediaTitle: inner.media_title,
          mediaPoster: inner.media_poster,
          mediaItemId: inner.media_item_id,
          episodeId: inner.episode_id,
          hostUserId: inner.host_user_id,
          participants: p.participants ?? [],
          chat: (p.chat_history ?? []).slice(-MAX_CHAT),
          isPlaying: inner.is_playing,
          currentTimeMs: inner.current_time_ms,
          rev: inner.revision ?? 0,
          error: null,
          recentReactions:
            prev.mediaItemId && prev.mediaItemId !== inner.media_item_id
              ? []
              : prev.recentReactions,
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
          if (userId && inner.code) {
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
        // socket. openSyncOnce is idempotent via the syncWsRef
        // guard.
        if (!syncWsRef.current && activeCodeRef.current) {
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
          return {
            participants: [
              ...prev.participants,
              {
                user_id: p.user_id,
                username: p.username,
                is_host: !!p.is_host,
                is_buffering: false,
                last_seen: new Date().toISOString(),
                ready: false,
              },
            ],
          }
        })
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
        helloAbsMsRef.current = 0
        // Fan out to consumers (App.tsx will re-emit playerTarget
        // for the new episode).
        for (const cb of mediaChangeSubsRef.current) {
          try { cb({ media_item_id: p.media_item_id, episode_id: p.episode_id }) } catch { /* defensive */ }
        }
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
  }, [setStatePatch, closeSockets])

  const handleSyncMessage = useCallback((raw: string) => {
    let msg: InboundSyncMessage
    try { msg = JSON.parse(raw) } catch { return }
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'hello': {
        const p = msg.payload
        helloAbsMsRef.current = p.abs_ms
        setStatePatch({
          hlsStartSec: p.hls_start_sec ?? 0,
          isPlaying: p.running,
          currentTimeMs: p.abs_ms,
          rev: p.rev ?? 0,
        })
        // Treat hello as the initial tick for the player.
        tickRef.current = { abs_ms: p.abs_ms, server_now_ms: p.server_now_ms, running: p.running, rev: p.rev }
        break
      }
      case 'tick': {
        tickRef.current = msg.payload
        setStatePatch({
          isPlaying: msg.payload.running !== false,
          currentTimeMs: msg.payload.abs_ms,
          rev: msg.payload.rev ?? 0,
        })
        break
      }
      case 'pause': {
        const p = msg.payload
        setStatePatch(prev =>
          (p.rev ?? 0) < prev.rev
            ? {}
            : { isPlaying: false, currentTimeMs: p.abs_ms, rev: p.rev ?? prev.rev }
        )
        tickRef.current = { abs_ms: p.abs_ms, server_now_ms: Date.now(), running: false, rev: p.rev }
        break
      }
      case 'seek': {
        const p = msg.payload
        setStatePatch(prev =>
          (p.rev ?? 0) < prev.rev
            ? {}
            : { currentTimeMs: p.abs_ms, isPlaying: p.running ?? prev.isPlaying, rev: p.rev ?? prev.rev }
        )
        tickRef.current = { abs_ms: p.abs_ms, server_now_ms: Date.now(), running: p.running, rev: p.rev }
        break
      }
      case 'party-ended':
        setStatePatch({ error: 'Party ended by host.' })
        setTimeout(() => {
          activeCodeRef.current = null
          closeSockets()
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
  }, [setStatePatch, closeSockets])

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

    rws.onopen = () => {
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

      // Suppress reconnect when the user explicitly left.
      if (userInitiatedLeaveRef.current) {
        setStatePatch({ roomConnected: false, reconnecting: false })
        return
      }

      const attempt = reconnectAttemptRef.current
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
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
  }, [handleRoomMessage, setStatePatch, stopHeartbeat])

  // Keep the ref pointed at the latest version so onclose can recurse
  // without stale-closure shenanigans.
  openRoomSocketRef.current = openRoomSocket

  const openSyncSocket = useCallback((code: string) => {
    if (!getStoredUser()) return
    if (syncWsRef.current) return
    // deep-debug H10 — empty token: the same-origin WS handshake sends the cookie.
    const ws = new WebSocket(buildWsUrl('/ws/party-sync', ''))
    syncWsRef.current = ws
    ws.onopen = () => {
      const msg: OutboundSyncMessage = { type: 'join-party', payload: { party_code: code } }
      try { ws.send(JSON.stringify(msg)) } catch { /* defensive */ }
      setStatePatch({ syncConnected: true })
      // Audit H1 (P4) — flush the buffered intent NOW that we're
      // connected. The most common case: host's MANIFEST_PARSED
      // auto-fired vid.play() which called requestPlay before sync
      // was open. Without this replay, the server never learns the
      // host is playing.
      const pending = pendingSyncIntentRef.current
      if (pending) {
        pendingSyncIntentRef.current = null
        try { ws.send(JSON.stringify(pending)) } catch { /* defensive */ }
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
      if (syncWsRef.current === ws) {
        syncWsRef.current = null
        setStatePatch({ syncConnected: false })
        // Stop pinging into a closed socket. Reconnect (when it
        // exists for the sync socket) will re-arm via onopen.
        stopTimeSync()
      }
    }
    ws.onerror = () => { /* silent — onclose handles cleanup */ }
  }, [handleSyncMessage, setStatePatch, stopTimeSync])

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
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const out: OutboundRoomMessage = { type: 'chat', payload: { message: trimmed } }
    try { ws.send(JSON.stringify(out)) } catch { /* defensive */ }
  }, [])

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

  // Audit H1 (P4) — request* methods buffer the most recent intent
  // when the sync socket isn't OPEN yet (it opens lazily after
  // party-state arrives on the room socket — typically 100-300ms
  // after the user joins). The replay happens in openSyncSocket's
  // onopen handler. Each new request* overwrites the buffer so we
  // don't replay stale intermediate states.
  const sendOrBuffer = useCallback((msg: OutboundSyncMessage) => {
    const ws = syncWsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)) } catch { /* defensive */ }
      return
    }
    pendingSyncIntentRef.current = msg
  }, [])
  const requestPlay = useCallback(() => {
    sendOrBuffer({ type: 'request-play' })
  }, [sendOrBuffer])
  const requestPause = useCallback((absMs: number) => {
    sendOrBuffer({ type: 'request-pause', payload: { abs_ms: absMs } })
  }, [sendOrBuffer])
  const requestSeek = useCallback((absMs: number) => {
    sendOrBuffer({ type: 'request-seek', payload: { abs_ms: absMs } })
  }, [sendOrBuffer])

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
    requestPlay,
    requestPause,
    requestSeek,
    tickRef,
    helloAbsMsRef,
    clockOffsetRef,
    rttRef,
    onMediaChange,
  }
}
