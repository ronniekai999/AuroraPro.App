// Aurora V2 — Voice mesh peer management.
//
// Ports the V1 implementation (aurora_pro.html ~line 7303 "M7 — Voice
// presence"). Key rules preserved from V1:
//
//   1. MUTED BY DEFAULT — getUserMedia is only called on user click,
//      and tracks start with enabled=false. Clicking the mic button
//      just OPTS YOU IN; you need to explicitly unmute to broadcast.
//   2. "Newcomer initiates" — when WE join, the server hands us the
//      existing peer list and we send offers. When SOMEONE ELSE joins,
//      we wait for their offer. Avoids offer-collision without a
//      polite-peer state machine.
//   3. Voice never outlives the room socket — losing the WS auto-
//      leaves voice both client- and server-side.
//
// Mesh limit: ~4 participants before fan-out hurts. SFU upgrade is a
// future server-side work item; not blocking V2 parity.
//
// This file is pure logic — no React. The useParty hook creates a
// VoiceController and wires its callbacks into React state.

import { apiFetch } from './api'
import type { OutboundRoomMessage } from './party'

const VOICE_ICE_FALLBACK: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
const VOICE_SPEAKING_THRESHOLD = 22 // 0-255 Web Audio byte frequency

export interface VoicePeerInfo {
  userId: number
  username: string
  speaking: boolean
  // True when we've added them to the mesh but the ICE handshake
  // isn't complete yet. UI shows a connecting indicator.
  connecting: boolean
}

export interface VoiceState {
  enabled: boolean
  muted: boolean
  peers: VoicePeerInfo[]
  selfSpeaking: boolean
  status: string // human-readable: "Muted", "Live", "Connecting…"
}

interface PeerEntry {
  pc: RTCPeerConnection
  audioEl: HTMLAudioElement
  iceQueue: RTCIceCandidateInit[]
  hasRemoteDesc: boolean
  initiator: boolean
  reconnectAttempted: boolean
  username: string
  analyser?: AnalyserNode
  audioCtx?: AudioContext
  source?: MediaStreamAudioSourceNode
  raf?: number
  speaking: boolean
  connecting: boolean
}

export interface VoiceController {
  getState(): VoiceState
  // Subscribe to state-change notifications. Returns an unsubscribe.
  subscribe(cb: () => void): () => void
  join(): Promise<void>
  leave(emitLeave: boolean): void
  toggleMute(): void
  // Wire inbound signaling messages from useParty's room dispatch.
  handleInbound(msg: { type: string; payload?: unknown }): void
  // Called by useParty when the room socket itself disconnects.
  onRoomSocketDown(): void
}

interface CreateOptions {
  // Function that sends a room-socket message; supplied by useParty.
  // Returns true if delivered, false if the socket isn't OPEN.
  send: (msg: OutboundRoomMessage) => boolean
}

export function createVoiceController(opts: CreateOptions): VoiceController {
  let enabled = false
  let muted = true
  let localStream: MediaStream | null = null
  let iceServers: RTCIceServer[] = VOICE_ICE_FALLBACK
  let iceFetched = false
  let selfSpeaking = false
  let selfAnalyser: AnalyserNode | null = null
  let selfAudioCtx: AudioContext | null = null
  let selfRaf: number | null = null
  let status = 'Muted'
  const peers = new Map<number, PeerEntry>()
  const peerNames = new Map<number, string>()
  const subscribers = new Set<() => void>()
  const audioSinkContainer = (() => {
    // Hidden container to hold remote <audio> elements outside the
    // React tree. Each peer gets one. We keep them in the DOM so the
    // browser actually plays them.
    if (typeof document === 'undefined') return null
    let el = document.getElementById('aurora-voice-sinks')
    if (!el) {
      el = document.createElement('div')
      el.id = 'aurora-voice-sinks'
      el.style.display = 'none'
      document.body.appendChild(el)
    }
    return el
  })()

  const notify = () => {
    // Notify all subscribers; useParty re-runs setState to publish.
    for (const cb of subscribers) cb()
  }

  const getState = (): VoiceState => ({
    enabled,
    muted,
    selfSpeaking: enabled && !muted ? selfSpeaking : false,
    status,
    peers: Array.from(peers.entries()).map(([uid, p]) => ({
      userId: uid,
      username: p.username || peerNames.get(uid) || `User ${uid}`,
      speaking: p.speaking,
      connecting: p.connecting,
    })),
  })

  const subscribe = (cb: () => void) => {
    subscribers.add(cb)
    return () => { subscribers.delete(cb) }
  }

  const loadIceServers = async (): Promise<void> => {
    if (iceFetched) return
    try {
      const res = await apiFetch<{ ice_servers?: RTCIceServer[] }>('/api/voice/ice-servers')
      if (res && Array.isArray(res.ice_servers) && res.ice_servers.length > 0) {
        iceServers = res.ice_servers
      }
    } catch {
      // Fall through to the hardcoded STUN.
    }
    iceFetched = true
  }

  const startLocalMeter = (stream: MediaStream) => {
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 256
      src.connect(an)
      selfAudioCtx = ctx
      selfAnalyser = an
      const buf = new Uint8Array(an.frequencyBinCount)
      const tick = () => {
        if (!selfAnalyser) return
        selfAnalyser.getByteFrequencyData(buf)
        let max = 0
        for (let i = 0; i < buf.length; i++) if (buf[i] > max) max = buf[i]
        const next = max >= VOICE_SPEAKING_THRESHOLD
        if (next !== selfSpeaking) {
          selfSpeaking = next
          notify()
        }
        selfRaf = requestAnimationFrame(tick)
      }
      selfRaf = requestAnimationFrame(tick)
    } catch (err) {
      console.warn('voice self-meter failed', err)
    }
  }

  const stopLocalMeter = () => {
    if (selfRaf !== null) cancelAnimationFrame(selfRaf)
    selfRaf = null
    if (selfAudioCtx) { try { void selfAudioCtx.close() } catch { /* noop */ } }
    selfAudioCtx = null
    selfAnalyser = null
    selfSpeaking = false
  }

  const startPeerMeter = (peer: PeerEntry, stream: MediaStream, uid: number) => {
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 256
      src.connect(an)
      peer.audioCtx = ctx
      peer.analyser = an
      peer.source = src
      const buf = new Uint8Array(an.frequencyBinCount)
      const tick = () => {
        if (!peer.analyser) return
        peer.analyser.getByteFrequencyData(buf)
        let max = 0
        for (let i = 0; i < buf.length; i++) if (buf[i] > max) max = buf[i]
        const next = max >= VOICE_SPEAKING_THRESHOLD
        if (next !== peer.speaking) {
          peer.speaking = next
          notify()
        }
        peer.raf = requestAnimationFrame(tick)
        void uid
      }
      peer.raf = requestAnimationFrame(tick)
    } catch (err) {
      console.warn('voice peer-meter failed', err)
    }
  }

  const closePeer = (uid: number) => {
    const peer = peers.get(uid)
    if (!peer) return
    if (peer.raf !== undefined) cancelAnimationFrame(peer.raf)
    if (peer.audioCtx) { try { void peer.audioCtx.close() } catch { /* noop */ } }
    try { peer.pc.close() } catch { /* defensive */ }
    if (peer.audioEl) {
      try { peer.audioEl.srcObject = null } catch { /* defensive */ }
      peer.audioEl.remove()
    }
    peers.delete(uid)
    notify()
  }

  const createPC = (uid: number, username: string, initiator: boolean): PeerEntry => {
    const existing = peers.get(uid)
    if (existing) return existing
    const pc = new RTCPeerConnection({ iceServers })
    const audioEl = document.createElement('audio')
    audioEl.autoplay = true
    // playsInline is a video attribute; audio doesn't need it but
    // setting it via attribute (not property) is harmless on browsers
    // that have it on the union element type.
    audioEl.setAttribute('playsinline', '')
    if (audioSinkContainer) audioSinkContainer.appendChild(audioEl)
    const peer: PeerEntry = {
      pc, audioEl, iceQueue: [], hasRemoteDesc: false, initiator,
      reconnectAttempted: false, username, speaking: false, connecting: true,
    }
    peers.set(uid, peer)
    peerNames.set(uid, username)

    if (localStream) {
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream!))
    }

    pc.onicecandidate = ev => {
      if (!ev.candidate) return
      opts.send({
        type: 'voice-ice',
        payload: {
          to_user_id: uid,
          candidate: ev.candidate.candidate || '',
          sdp_mid: ev.candidate.sdpMid || '',
          sdp_m_line_index: ev.candidate.sdpMLineIndex ?? 0,
        },
      })
    }

    pc.ontrack = ev => {
      const stream = ev.streams && ev.streams[0]
      if (!stream) return
      audioEl.srcObject = stream
      audioEl.play().catch(err => console.warn('voice audio play() rejected', err))
      startPeerMeter(peer, stream, uid)
    }

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState
      if (s === 'connected' || s === 'completed') {
        if (peer.connecting) {
          peer.connecting = false
          notify()
        }
        return
      }
      if (s === 'closed') {
        if (peers.get(uid) === peer) closePeer(uid)
        return
      }
      if (s !== 'failed') return
      // One reconnect attempt with iceRestart:true (initiator only).
      if (peer.reconnectAttempted || !peer.initiator) {
        if (peers.get(uid) === peer) closePeer(uid)
        return
      }
      peer.reconnectAttempted = true
      ;(async () => {
        try {
          const offer = await pc.createOffer({ iceRestart: true, offerToReceiveAudio: true })
          await pc.setLocalDescription(offer)
          opts.send({ type: 'voice-offer', payload: { to_user_id: uid, sdp: offer.sdp || '' } })
        } catch (err) {
          console.warn('voice ICE restart failed', err)
          if (peers.get(uid) === peer) closePeer(uid)
        }
      })()
    }

    if (initiator) {
      ;(async () => {
        try {
          const offer = await pc.createOffer({ offerToReceiveAudio: true })
          await pc.setLocalDescription(offer)
          opts.send({ type: 'voice-offer', payload: { to_user_id: uid, sdp: offer.sdp || '' } })
        } catch (err) {
          console.error('voice offer failed', err)
          closePeer(uid)
        }
      })()
    }

    return peer
  }

  const handleOffer = async (fromUid: number, sdp: string) => {
    if (!enabled) return
    let peer = peers.get(fromUid)
    if (!peer) {
      peer = createPC(fromUid, peerNames.get(fromUid) || '', /*initiator=*/false)
    }
    if (!peer) return
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp })
      peer.hasRemoteDesc = true
      for (const c of peer.iceQueue) {
        try { await peer.pc.addIceCandidate(c) } catch (e) { console.warn('queued ICE add failed', e) }
      }
      peer.iceQueue = []
      const ans = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(ans)
      opts.send({ type: 'voice-answer', payload: { to_user_id: fromUid, sdp: ans.sdp || '' } })
    } catch (err) {
      console.error('voice offer handling failed', err)
      closePeer(fromUid)
    }
  }

  const handleAnswer = async (fromUid: number, sdp: string) => {
    const peer = peers.get(fromUid)
    if (!peer) return
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp })
      peer.hasRemoteDesc = true
      for (const c of peer.iceQueue) {
        try { await peer.pc.addIceCandidate(c) } catch (e) { console.warn('queued ICE add failed', e) }
      }
      peer.iceQueue = []
    } catch (err) {
      console.error('voice answer handling failed', err)
      closePeer(fromUid)
    }
  }

  const handleIce = async (
    fromUid: number,
    candidate: string,
    sdpMid: string,
    sdpMLineIndex: number,
  ) => {
    const peer = peers.get(fromUid)
    if (!peer) return
    const cand: RTCIceCandidateInit = { candidate, sdpMid, sdpMLineIndex }
    if (!peer.hasRemoteDesc) {
      peer.iceQueue.push(cand)
      return
    }
    try { await peer.pc.addIceCandidate(cand) } catch (err) {
      console.warn('voice ICE add failed', err)
    }
  }

  const join = async (): Promise<void> => {
    if (enabled) return
    status = 'Requesting mic…'
    notify()
    await loadIceServers()
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
    } catch (err) {
      status = 'Mic blocked'
      notify()
      // 2026-05-26 — re-throw with a richer reason. Original code lost
      // the distinction between several real-world failure modes:
      //   - browser prompt outstanding (user hasn't clicked yet)
      //   - browser-level permission denied (site explicitly blocked)
      //   - OS-level mic denied to the browser (macOS / Windows settings)
      //   - device in use by another app / no device present
      // The Permissions API tells us which of the first three. The
      // throw still carries the original err for upstream logging;
      // we tag a `reason` field so the toast component can pick the
      // right copy without re-querying.
      const richErr = err as Error & { reason?: string }
      try {
        if (navigator.permissions && (navigator.permissions as Permissions).query) {
          // 'microphone' isn't in lib.dom yet on all TS configs, hence the cast.
          const status = await (navigator.permissions as Permissions).query({ name: 'microphone' as PermissionName })
          if (status.state === 'denied') {
            richErr.reason = 'denied'      // explicit deny — needs settings change
          } else if (status.state === 'prompt') {
            richErr.reason = 'prompt'      // user dismissed/closed prompt without choosing
          } else if (status.state === 'granted') {
            richErr.reason = 'device'      // perm OK but device unavailable
          }
        }
      } catch { /* Permissions API not supported (Safari < 16) — leave reason undefined */ }
      throw richErr
    }
    localStream = stream
    enabled = true
    muted = true
    stream.getAudioTracks().forEach(t => { t.enabled = false })
    status = 'Muted'
    startLocalMeter(stream)
    // Tell the server we're in voice. Server replies with voice-peers
    // (the list of existing voice participants), each of whom we
    // initiate an offer to. New joiners after this point arrive via
    // voice-peer-joined; we wait for THEIR offer (they're the
    // newcomer in their own frame of reference).
    opts.send({ type: 'voice-join' })
    notify()
  }

  const leave = (emitLeave: boolean): void => {
    if (!enabled) return
    if (emitLeave) opts.send({ type: 'voice-leave' })
    for (const uid of Array.from(peers.keys())) closePeer(uid)
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop())
      localStream = null
    }
    stopLocalMeter()
    enabled = false
    muted = true
    status = 'Off'
    notify()
  }

  const toggleMute = () => {
    if (!enabled || !localStream) return
    muted = !muted
    localStream.getAudioTracks().forEach(t => { t.enabled = !muted })
    status = muted ? 'Muted' : 'Live'
    notify()
  }

  const handleInbound = (msg: { type: string; payload?: unknown }): void => {
    if (!msg || typeof msg.type !== 'string') return
    const p = (msg.payload || {}) as Record<string, unknown>
    switch (msg.type) {
      case 'voice-peers': {
        const list = (p.peers as { user_id: number; username: string }[] | undefined) || []
        for (const peerInfo of list) {
          peerNames.set(peerInfo.user_id, peerInfo.username)
          createPC(peerInfo.user_id, peerInfo.username, /*initiator=*/true)
        }
        break
      }
      case 'voice-peer-joined': {
        const uid = p.user_id as number
        const username = p.username as string
        if (uid) peerNames.set(uid, username)
        // We do NOT initiate — the new peer initiates toward us.
        break
      }
      case 'voice-peer-left': {
        const uid = p.user_id as number
        if (uid) closePeer(uid)
        break
      }
      case 'voice-offer': {
        const fromUid = p.from_user_id as number
        const sdp = p.sdp as string
        if (fromUid && sdp) void handleOffer(fromUid, sdp)
        break
      }
      case 'voice-answer': {
        const fromUid = p.from_user_id as number
        const sdp = p.sdp as string
        if (fromUid && sdp) void handleAnswer(fromUid, sdp)
        break
      }
      case 'voice-ice': {
        const fromUid = p.from_user_id as number
        const cand = (p.candidate as string) || ''
        const mid = (p.sdp_mid as string) || ''
        const idx = (p.sdp_m_line_index as number) ?? 0
        if (fromUid) void handleIce(fromUid, cand, mid, idx)
        break
      }
    }
  }

  const onRoomSocketDown = () => {
    // Room socket died → leave voice locally (no emitLeave; the
    // server already drops our voice participation when the WS
    // closes).
    leave(/*emitLeave=*/false)
  }

  return {
    getState, subscribe, join, leave, toggleMute, handleInbound, onRoomSocketDown,
  }
}
