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
import { apiFetch, getAccessToken } from '@/lib/api'
import { createVoiceController, type VoiceController, type VoiceState } from '@/lib/voice'

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
  join: (code: string) => Promise<{ ok: boolean; error?: string }>
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
}

export function useParty(): UseParty {
  const [state, setState] = useState<PartyState>(INITIAL_STATE)
  const roomWsRef = useRef<WebSocket | null>(null)
  const syncWsRef = useRef<WebSocket | null>(null)
  const tickRef = useRef<TickPayload | null>(null)
  const helloAbsMsRef = useRef<number>(0)
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

  const setStatePatch = useCallback((patch: Partial<PartyState> | ((s: PartyState) => Partial<PartyState>)) => {
    setState(prev => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }))
  }, [])

  const closeSockets = useCallback(() => {
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
  }, [])

  const leave = useCallback(() => {
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
    closeSockets()
    setState(INITIAL_STATE)
    tickRef.current = null
    helloAbsMsRef.current = 0
    // Audit H1 (P4) — clear any buffered sync intent so a stale
    // play/pause from the previous party doesn't replay against
    // the next one when its sync socket opens.
    pendingSyncIntentRef.current = null
  }, [closeSockets])

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
        const p = msg.payload
        // Audit MED-3 (Phase 4.5 final) — clear recentReactions when
        // the party's mediaItemId changes vs. our current state.
        // Phase 4 doesn't handle media-change broadcasts yet, but
        // a fresh party-state arrival (e.g. host swapped media in
        // V1, server emits a new state snapshot) IS the boundary.
        // Without this, reactions from the previous movie keep
        // floating on screen after the swap.
        setStatePatch(prev => ({
          code: p.code,
          partyName: p.party_name,
          mediaTitle: p.media_title,
          mediaPoster: p.media_poster,
          mediaItemId: p.media_item_id,
          episodeId: p.episode_id,
          hostUserId: p.host_user_id,
          participants: p.participants ?? [],
          chat: (p.chat_history ?? []).slice(-MAX_CHAT),
          isPlaying: p.is_playing,
          currentTimeMs: p.current_time_ms,
          rev: p.rev ?? 0,
          error: null,
          recentReactions:
            prev.mediaItemId && prev.mediaItemId !== p.media_item_id
              ? []
              : prev.recentReactions,
        }))
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
      case 'error':
        setStatePatch({ error: msg.payload.error })
        break
    }
  }, [setStatePatch, closeSockets])

  const openSyncSocket = useCallback((code: string) => {
    const token = getAccessToken()
    if (!token) return
    if (syncWsRef.current) return
    const ws = new WebSocket(buildWsUrl('/ws/party-sync', token))
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
      }
    }
    ws.onerror = () => { /* silent — onclose handles cleanup */ }
  }, [handleSyncMessage, setStatePatch])

  const join = useCallback(async (rawCode: string): Promise<{ ok: boolean; error?: string }> => {
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
    try {
      const info = await apiFetch<CodeInfo>(`/api/code/${encodeURIComponent(code)}/info`)
      if (info.kind !== 'party') {
        const error = 'That code is a persistent room; no live session right now.'
        setStatePatch({ joining: false, error })
        return { ok: false, error }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Invalid party code.'
      setStatePatch({ joining: false, error })
      return { ok: false, error }
    }

    const token = getAccessToken()
    if (!token) {
      const error = 'You must be signed in to join a party.'
      setStatePatch({ joining: false, error })
      return { ok: false, error }
    }
    activeCodeRef.current = code
    setStatePatch({ code, joining: true })

    const rws = new WebSocket(buildWsUrl('/ws/party-room', token))
    roomWsRef.current = rws
    rws.onopen = () => {
      const msg: OutboundRoomMessage = { type: 'join-party', payload: { party_code: code } }
      try { rws.send(JSON.stringify(msg)) } catch { /* defensive */ }
      setStatePatch({ roomConnected: true, joining: false })
    }
    rws.onmessage = ev => {
      // Audit M3 (P4) — drop messages from a stale ws (see same
      // guard in openSyncSocket above).
      if (roomWsRef.current !== rws) return
      handleRoomMessage(ev.data)
    }
    rws.onclose = () => {
      if (roomWsRef.current === rws) {
        roomWsRef.current = null
        setStatePatch({ roomConnected: false })
      }
    }
    rws.onerror = () => { /* silent — close handler covers UI */ }
    return { ok: true }
  }, [closeSockets, handleRoomMessage, setStatePatch])

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
    onMediaChange,
  }
}
