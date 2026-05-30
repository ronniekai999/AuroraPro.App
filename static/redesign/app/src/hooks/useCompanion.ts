// Aurora V2 — useCompanion hook (Mobile Companion "second screen").
//
// A trimmed, ROOM-ONLY sibling of useParty (src/hooks/useParty.tsx).
// The companion is a phone surface that gives a guest chat + voice +
// emoji reactions for a watch party running on someone else's big
// screen. Critically:
//
//   - It opens ONLY /ws/party-room. It NEVER opens /ws/party-sync and
//     NEVER drives playback (no request-play/pause/seek). The phone
//     doesn't decode video, so it has no business in the sync socket.
//   - It signals "companion mode" via a `?companion=1` query param on
//     the /ws/party-room upgrade URL (buildCompanionWsUrl). The server
//     reads it at upgrade time (PartyWSHandlerV3Room.ServeHTTP →
//     JoinPartyV3RoomCompanion) and marks the participant Companion=true,
//     which it then echoes back on each participant in party-state so the
//     UI can badge "📱 on phone". Strictly additive: any value other than
//     "1" degrades to the legacy non-companion path.
//   - It READS the now-playing title + position out of `party-state`
//     for a read-only synced strip, but takes no action on playback.
//
// Lifecycle parity with useParty's room socket: 25s heartbeat keepalive
// (Cloudflare-style idle-proxy defense), capped exponential-backoff
// reconnect with token refresh, and FULL teardown on unmount (socket
// close + voice.leave(false) + every timer cleared).
//
// Voice is delegated wholesale to createVoiceController from lib/voice
// (the existing WebRTC mesh — mute-by-default, ~4-peer cap). We do NOT
// build an SFU here.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildCompanionWsUrl,
  type ChatMessageEvent,
  type InboundRoomMessage,
  type OutboundRoomMessage,
  type PartyParticipant,
  type ReactionEvent,
} from '@/lib/party'
import { getStoredUser, refreshAccessToken } from '@/lib/api'
import { createVoiceController, type VoiceController, type VoiceState } from '@/lib/voice'

// Room-socket keepalive cadence — identical rationale to useParty: a
// `{type:"heartbeat"}` JSON data frame every 25s keeps upstream proxies
// (Cloudflare non-Enterprise) from idling out the socket at ~30-90s.
// The server treats it as a no-op.
const ROOM_HEARTBEAT_INTERVAL_MS = 25_000

// Capped exponential backoff for unexpected room-socket closes. Same
// curve + cap as useParty. After the last attempt we surface a fatal
// "connection lost" so the UI can prompt a manual refresh.
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000]
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length

// Bound chat + reaction memory across a long movie night, mirroring
// useParty's caps so the two surfaces behave the same.
const MAX_CHAT = 200
const MAX_REACTIONS = 100

export type CompanionConnStatus =
  | 'idle'          // not joined yet
  | 'joining'       // preflight + first socket open in flight
  | 'connected'     // room socket open + party-state received
  | 'reconnecting'  // unexpected drop, backoff in flight
  | 'error'         // gave up / fatal

export interface CompanionState {
  code: string | null
  joining: boolean
  // Party meta — read-only mirror of party-state for the now-playing
  // strip + header. The companion never WRITES any of these.
  partyName?: string
  mediaTitle?: string
  mediaPoster?: string
  mediaItemId?: number
  hostUserId?: number
  // Read-only playback indicator. party-state carries an authoritative
  // current_time_ms + is_playing snapshot; we surface them for the
  // "in sync with host" strip WITHOUT opening the sync socket. They
  // update on each fresh party-state (e.g. media change, late
  // re-snapshot) rather than at tick frequency — which is exactly
  // right for a passive read-only strip.
  isPlaying: boolean
  currentTimeMs: number
  participants: PartyParticipant[]
  chat: ChatMessageEvent[]
  recentReactions: ReactionEvent[]
  connected: boolean
  reconnecting: boolean
  status: CompanionConnStatus
  error: string | null
}

const INITIAL_STATE: CompanionState = {
  code: null,
  joining: false,
  isPlaying: false,
  currentTimeMs: 0,
  participants: [],
  chat: [],
  recentReactions: [],
  connected: false,
  reconnecting: false,
  status: 'idle',
  error: null,
}

export interface UseCompanion {
  state: CompanionState
  voice: VoiceState
  // Open the room socket for `code` in companion mode. Returns a
  // synchronous ok/error (state.error is set async via React batching,
  // so awaiters can't see it in time — same contract as useParty.join).
  join: (code: string) => { ok: boolean; error?: string }
  leave: () => void
  sendChat: (message: string) => void
  sendReaction: (emoji: string) => void
  // Voice (delegated to the existing mesh controller).
  joinVoice: () => Promise<void>
  toggleMute: () => void
  leaveVoice: () => void
}

export function useCompanion(): UseCompanion {
  const [state, setState] = useState<CompanionState>(INITIAL_STATE)

  const roomWsRef = useRef<WebSocket | null>(null)
  // Latest code we're trying to hold a connection to. Reconnect reads
  // it; stale onmessage/onclose callbacks compare against it.
  const activeCodeRef = useRef<string | null>(null)
  // True once the user (or unmount) deliberately tore down — suppresses
  // reconnect attempts that would otherwise fire from the close handler.
  const userInitiatedLeaveRef = useRef<boolean>(false)

  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Tracks the deferred teardown a 'party-ended' frame schedules so an
  // unmount / leave inside that ~50ms window can cancel it — otherwise it
  // fires setState on an unmounted tree (React warning + wasted work).
  const partyEndedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef<number>(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setStatePatch = useCallback(
    (patch: Partial<CompanionState> | ((s: CompanionState) => Partial<CompanionState>)) => {
      setState(prev => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }))
    },
    [],
  )

  // ── Voice controller — created once per hook instance. Its `send`
  // delivers signaling over the room socket; `subscribe` mirrors voice
  // state into React for UI re-renders. Identical wiring to useParty.
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
      setVoiceState(voiceRef.current!.getState())
    })
  }

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current)
      heartbeatTimerRef.current = null
    }
  }, [])

  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  // Close the room socket + tear down voice + clear timers. Safe to call
  // repeatedly. Voice teardown uses emitLeave=false because losing the
  // socket already drops our voice participation server-side (and a
  // closed socket can't carry a voice-leave anyway).
  const closeSocket = useCallback(() => {
    stopHeartbeat()
    cancelReconnect()
    if (partyEndedTimerRef.current) {
      clearTimeout(partyEndedTimerRef.current)
      partyEndedTimerRef.current = null
    }
    if (roomWsRef.current) {
      try { roomWsRef.current.close() } catch { /* defensive */ }
      roomWsRef.current = null
    }
    voiceRef.current?.onRoomSocketDown()
  }, [stopHeartbeat, cancelReconnect])

  const handleRoomMessage = useCallback((raw: string) => {
    let msg: InboundRoomMessage
    try { msg = JSON.parse(raw) } catch { return }
    if (!msg || typeof msg !== 'object') return

    // Voice signaling rides the room socket — hand off before the chat/
    // state switch so these don't fall through to the no-op default.
    if (msg.type === 'voice-peers' || msg.type === 'voice-peer-joined' ||
        msg.type === 'voice-peer-left' || msg.type === 'voice-offer' ||
        msg.type === 'voice-answer' || msg.type === 'voice-ice') {
      voiceRef.current?.handleInbound(msg)
      return
    }

    switch (msg.type) {
      case 'party-state': {
        // Server nests party-specific fields inside payload.party while
        // keeping participants + chat_history at the root (see useParty's
        // long note + manager.go BuildPartyStateMessage). We read the
        // now-playing fields + the read-only playback snapshot; we do NOT
        // open any sync socket off the back of this.
        const p = msg.payload
        const inner = p.party || ({} as NonNullable<typeof p.party>)
        setStatePatch(prev => ({
          code: inner.code ?? prev.code,
          partyName: inner.party_name,
          mediaTitle: inner.media_title,
          mediaPoster: inner.media_poster,
          mediaItemId: inner.media_item_id,
          hostUserId: inner.host_user_id,
          isPlaying: !!inner.is_playing,
          currentTimeMs: inner.current_time_ms ?? 0,
          participants: p.participants ?? [],
          chat: (p.chat_history ?? []).slice(-MAX_CHAT),
          // Drop stale reactions when the media changes under us.
          recentReactions:
            prev.mediaItemId && prev.mediaItemId !== inner.media_item_id
              ? []
              : prev.recentReactions,
          error: null,
        }))
        break
      }
      case 'participant-join':
      case 'participant-left': {
        setStatePatch(prev => {
          const ev = msg.payload
          if (msg.type === 'participant-left') {
            return { participants: prev.participants.filter(u => u.user_id !== ev.user_id) }
          }
          if (prev.participants.some(u => u.user_id === ev.user_id)) return {}
          return {
            participants: [
              ...prev.participants,
              {
                user_id: ev.user_id,
                username: ev.username,
                is_host: !!ev.is_host,
                is_buffering: false,
                last_seen: new Date().toISOString(),
                ready: false,
                // Carry the companion flag forward optimistically if the
                // server stamped it on the join event.
                companion: ev.companion,
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
      case 'media-change': {
        // The host advanced the media. Mirror the new descriptor + reset
        // the read-only playback indicator + clear stale reactions. No
        // player teardown — the companion has no player.
        const mc = msg.payload
        setStatePatch(prev => ({
          mediaItemId: mc.media_item_id,
          mediaTitle: mc.media_title ?? prev.mediaTitle,
          mediaPoster: mc.media_poster ?? prev.mediaPoster,
          isPlaying: false,
          currentTimeMs: 0,
          recentReactions: [],
        }))
        break
      }
      case 'ready-changed': {
        const rc = msg.payload
        setStatePatch(prev => ({
          participants: prev.participants.map(u =>
            u.user_id === rc.user_id ? { ...u, ready: rc.ready } : u,
          ),
        }))
        break
      }
      case 'party-ended': {
        // Host ended the party. Flash a one-shot message, then tear down
        // after a beat so the UI can read `error` before state resets.
        setStatePatch({ error: 'The host ended the party.', status: 'error' })
        if (partyEndedTimerRef.current) clearTimeout(partyEndedTimerRef.current)
        partyEndedTimerRef.current = setTimeout(() => {
          partyEndedTimerRef.current = null
          activeCodeRef.current = null
          userInitiatedLeaveRef.current = true
          closeSocket()
          setState({ ...INITIAL_STATE, error: 'The host ended the party.', status: 'error' })
        }, 50)
        break
      }
      case 'error': {
        setStatePatch({ error: msg.payload.error })
        break
      }
    }
  }, [setStatePatch, closeSocket])

  // openRoomSocket — opens /ws/party-room, sends the companion join
  // handshake on open, starts the heartbeat, routes messages, and on
  // unexpected close schedules a token-refreshing backoff reconnect.
  // Self-reference goes through a ref so the close handler can recurse
  // (a useCallback can't reference itself synchronously) — same pattern
  // as useParty.openRoomSocketRef.
  const openRoomSocketRef = useRef<((code: string, token: string) => void) | null>(null)
  const openRoomSocket = useCallback((code: string, token: string) => {
    userInitiatedLeaveRef.current = false
    // buildCompanionWsUrl appends `&companion=1` so the server flags this
    // participant as a phone "second screen" at upgrade time. The
    // join-party payload itself is identical to the desktop path.
    const ws = new WebSocket(buildCompanionWsUrl(token))
    roomWsRef.current = ws

    ws.onopen = () => {
      // Standard join-party handshake (party_code only). Companion mode
      // was already signaled via the `?companion=1` upgrade query param.
      const join: OutboundRoomMessage = {
        type: 'join-party',
        payload: { party_code: code },
      }
      try { ws.send(JSON.stringify(join)) } catch { /* defensive */ }

      reconnectAttemptRef.current = 0
      setStatePatch({ connected: true, joining: false, reconnecting: false, status: 'connected' })

      stopHeartbeat()
      heartbeatTimerRef.current = setInterval(() => {
        const sock = roomWsRef.current
        if (!sock || sock.readyState !== WebSocket.OPEN) return
        try { sock.send(JSON.stringify({ type: 'heartbeat' } satisfies OutboundRoomMessage)) }
        catch { /* defensive — onclose follows if the send really failed */ }
      }, ROOM_HEARTBEAT_INTERVAL_MS)
    }

    ws.onmessage = ev => {
      // Stale-socket guard — ignore a slow callback from a socket we've
      // already replaced via reconnect.
      if (roomWsRef.current !== ws) return
      handleRoomMessage(ev.data)
    }

    ws.onclose = () => {
      if (roomWsRef.current !== ws) return
      roomWsRef.current = null
      stopHeartbeat()
      // Socket gone → voice can't survive it.
      voiceRef.current?.onRoomSocketDown()

      if (userInitiatedLeaveRef.current) {
        setStatePatch({ connected: false, reconnecting: false, status: 'idle' })
        return
      }

      const attempt = reconnectAttemptRef.current
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        setStatePatch({
          connected: false,
          reconnecting: false,
          status: 'error',
          error: 'Lost connection to the party. Refresh to retry.',
        })
        return
      }

      const delay = RECONNECT_BACKOFF_MS[attempt]
      reconnectAttemptRef.current = attempt + 1
      setStatePatch({ connected: false, reconnecting: true, status: 'reconnecting' })
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null
        // Refresh before reconnect — the WS upgrade authenticates via the
        // httpOnly cookie, which can expire on a long movie night. A
        // ~200ms no-op when still valid; rescues the reconnect when not.
        void (async () => {
          await refreshAccessToken().catch(() => false)
          const c = activeCodeRef.current
          if (!c || !getStoredUser() || userInitiatedLeaveRef.current) {
            setStatePatch({ reconnecting: false, status: c ? 'error' : 'idle' })
            return
          }
          // deep-debug H10 — WS auth rides the httpOnly cookie; empty token.
          openRoomSocketRef.current?.(c, '')
        })()
      }, delay)
    }

    ws.onerror = () => { /* silent — onclose covers UI + cleanup */ }
  }, [handleRoomMessage, setStatePatch, stopHeartbeat])

  // Keep the ref pointed at the latest closure so onclose can recurse.
  openRoomSocketRef.current = openRoomSocket

  const join = useCallback((rawCode: string): { ok: boolean; error?: string } => {
    const code = rawCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      const error = 'Party code must be 6 letters or digits.'
      setStatePatch({ error, status: 'idle' })
      return { ok: false, error }
    }
    if (!getStoredUser()) {
      const error = 'You must be signed in to join a party.'
      setStatePatch({ error, status: 'idle' })
      return { ok: false, error }
    }
    // Tear down anything prior, then open fresh. We intentionally skip a
    // separate preflight here — the JoinScreen already calls
    // getCompanionPartyPreview (the GET /api/code/{code}/info check)
    // before invoking join, so a second round-trip would just add
    // latency. A bad/stale code surfaces as a server `error` frame.
    userInitiatedLeaveRef.current = true
    closeSocket()
    activeCodeRef.current = code
    userInitiatedLeaveRef.current = false
    reconnectAttemptRef.current = 0
    setState({ ...INITIAL_STATE, code, joining: true, status: 'joining' })
    // deep-debug H10 — WS auth via the httpOnly cookie; empty token.
    openRoomSocket(code, '')
    return { ok: true }
  }, [setStatePatch, closeSocket, openRoomSocket])

  const leave = useCallback(() => {
    userInitiatedLeaveRef.current = true
    const ws = roomWsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg: OutboundRoomMessage = { type: 'leave-party' }
      try { ws.send(JSON.stringify(msg)) } catch { /* defensive */ }
    }
    activeCodeRef.current = null
    reconnectAttemptRef.current = 0
    // Emit a clean voice-leave while the socket is still open, THEN
    // close everything. closeSocket()'s onRoomSocketDown is a no-op
    // once voice is already torn down.
    voiceRef.current?.leave(/*emitLeave=*/true)
    closeSocket()
    setState(INITIAL_STATE)
  }, [closeSocket])

  const sendChat = useCallback((message: string) => {
    const trimmed = message.trim()
    if (!trimmed) return
    const ws = roomWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const out: OutboundRoomMessage = { type: 'chat', payload: { message: trimmed } }
    try { ws.send(JSON.stringify(out)) } catch { /* defensive */ }
  }, [])

  const sendReaction = useCallback((emoji: string) => {
    const ws = roomWsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    // abs_ms=0 — the companion has no authoritative clock; the server
    // stamps from its own CurrentAbsMs() (see reactionPayload note).
    const out: OutboundRoomMessage = { type: 'reaction', payload: { emoji, abs_ms: 0 } }
    try { ws.send(JSON.stringify(out)) } catch { /* defensive */ }
  }, [])

  const joinVoice = useCallback(async () => {
    if (!voiceRef.current) return
    await voiceRef.current.join()
  }, [])
  const toggleMute = useCallback(() => {
    voiceRef.current?.toggleMute()
  }, [])
  const leaveVoice = useCallback(() => {
    voiceRef.current?.leave(/*emitLeave=*/true)
  }, [])

  // Full teardown on unmount — close the socket, leave voice (no emit;
  // the socket's already going away), clear every timer. Without this,
  // navigating away orphans the room socket + leaves the mic hot + an
  // AudioContext open until GC.
  useEffect(() => {
    return () => {
      userInitiatedLeaveRef.current = true
      activeCodeRef.current = null
      voiceRef.current?.leave(/*emitLeave=*/false)
      closeSocket()
    }
  }, [closeSocket])

  return {
    state,
    voice: voiceState,
    join,
    leave,
    sendChat,
    sendReaction,
    joinVoice,
    toggleMute,
    leaveVoice,
  }
}
