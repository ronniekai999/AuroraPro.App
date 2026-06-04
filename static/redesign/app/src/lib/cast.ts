// Aurora V2 — Google Cast (Chromecast) Web Sender wrapper.
//
// Encapsulates the CAF v3 Sender SDK behind a tiny React-friendly
// surface so VideoPlayer.tsx doesn't have to know about the SDK's
// initialization quirks (global callbacks, single-init guarantee,
// `chrome.cast.*` ambient types).
//
// Receiver strategy: Google's Default Media Receiver (App ID
// CC1AD845) — a hosted, fully-featured HLS-capable receiver that
// requires no developer account or hosting. Sufficient for MVP cast
// playback; a custom receiver with Aurora branding + watch-party UI
// can replace it in a follow-up without touching this module's API.
//
// Token model: this module does NOT mint cast tokens itself. It
// accepts a fully-qualified URL (with ?token=…) constructed by the
// caller via streaming.createCastToken(). That keeps the network +
// auth call site in the player where session lifecycle is already
// orchestrated.

import { useEffect, useRef, useState } from 'react'

const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845'
const CAST_SDK_SRC =
  'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'

// SDK load state — shared across every consumer in the app. The Cast
// SDK enforces single initialization globally; tracking state here
// prevents duplicate <script> injections during React strict-mode
// double-mounts and across navigation.
type LoadState = 'idle' | 'loading' | 'ready' | 'unsupported'
let sdkLoadState: LoadState = 'idle'
let sdkLoadPromise: Promise<void> | null = null

// ensureSdk injects the Cast Sender SDK script and resolves once
// cast.framework is initialized. Idempotent — repeated calls return
// the same promise. On non-Chromium browsers the SDK will load but
// report no devices; we still treat that as a successful load (the
// caller's `isAvailable` will simply remain false).
function ensureSdk(): Promise<void> {
  if (sdkLoadState === 'ready') return Promise.resolve()
  if (sdkLoadState === 'unsupported') return Promise.reject(new Error('cast unsupported'))
  if (sdkLoadPromise) return sdkLoadPromise

  sdkLoadState = 'loading'
  sdkLoadPromise = new Promise<void>((resolve, reject) => {
    // The Cast SDK calls window.__onGCastApiAvailable once it has
    // finished setting up the cast.framework namespace. We register
    // BEFORE injecting the script — racing with the script loader
    // is the documented pattern.
    window.__onGCastApiAvailable = (available, reason) => {
      if (!available) {
        sdkLoadState = 'unsupported'
        reject(new Error(`cast unavailable: ${reason ?? 'unknown'}`))
        return
      }
      // Some Chromium builds invoke this callback with available=true
      // BEFORE actually populating window.cast.framework. Dereferencing
      // eagerly produces a TypeError that surfaces as a load-time
      // console warning (QA BUG-008). Defer to the polling-based
      // useCast hook instead — it's resilient to delayed framework
      // availability and will pick up state once the namespace lands.
      const fw = window.cast?.framework
      if (!fw) {
        sdkLoadState = 'ready'
        resolve()
        return
      }
      try {
        const ctx = fw.CastContext.getInstance()
        // Bare-minimum options. autoJoinPolicy + resumeSavedSession
        // intentionally omitted — passing fw.AutoJoinPolicy.* can
        // evaluate to undefined on some SDK builds and cause the CAF
        // Sender to silently reject the whole options object, leading
        // to "Cannot start session before cast options are provided"
        // on requestSession(). useCast also re-applies setOptions
        // defensively after polling detects the framework, so this
        // call is best-effort.
        ctx.setOptions({
          receiverApplicationId: DEFAULT_MEDIA_RECEIVER_APP_ID,
        })
        sdkLoadState = 'ready'
        resolve()
      } catch (e) {
        sdkLoadState = 'unsupported'
        reject(e instanceof Error ? e : new Error('cast init failed'))
      }
    }

    // Only inject the script tag once per document.
    if (document.querySelector(`script[src^="${CAST_SDK_SRC.split('?')[0]}"]`)) {
      // Script already present (e.g. HMR re-entry) — wait for the
      // SDK's callback to fire. If the SDK already initialized,
      // __onGCastApiAvailable will not be re-called, so guard with
      // a feature check.
      if (window.cast?.framework) {
        sdkLoadState = 'ready'
        resolve()
        return
      }
      return // fall through to await __onGCastApiAvailable
    }

    const s = document.createElement('script')
    s.src = CAST_SDK_SRC
    s.async = true
    s.onerror = () => {
      sdkLoadState = 'unsupported'
      reject(new Error('cast SDK script failed to load'))
    }
    document.head.appendChild(s)
  })

  return sdkLoadPromise
}

export interface CastLoadArgs {
  // Fully-qualified URL (scheme + host + path + ?token=…). The
  // receiver fetches this directly; relative URLs will not work.
  contentUrl: string
  contentType: string // e.g. 'application/x-mpegURL' for HLS
  // Optional poster shown on the TV before media buffers.
  posterUrl?: string
  title?: string
  subtitle?: string
  // Where to resume from (seconds). 0 plays from the start.
  startTime?: number
  // External WebVTT subtitle tracks. The Default Media Receiver
  // renders these on the TV when a track is in activeTrackIds.
  textTracks?: Array<{ url: string; language?: string; label?: string }>
  // 0-based index into textTracks to enable on load. Omit to play
  // with no subtitles.
  activeTextTrackIndex?: number
}

export interface CastStatus {
  // SDK loaded successfully (false on iOS Safari, Firefox without
  // an extension, environments that block the gstatic load, etc.).
  supported: boolean
  // A receiver device is reachable on the network. False is the
  // common case — sender UI should hide the Cast button.
  available: boolean
  // We have an active session with a receiver.
  connected: boolean
  // Friendly device name when connected ("Living Room", etc.).
  deviceName: string | null
}

// useCast wires the Cast SDK into a React component. The returned
// `status` reflects live state (re-renders on cast-state changes);
// `start` and `stop` are stable callbacks the player binds to its
// Cast button.
//
// `currentLoad` is read AFTER the device picker resolves, so it can
// be async (e.g. minting a session-scoped token from the backend).
// We deliberately don't pre-mint before the picker opens — a user
// who dismisses the picker should not have wasted a token.
// Live receiver-side playback state, surfaced from the CAF RemotePlayer so
// the sender UI (the minimized cast control widget) can show + drive what's
// playing on the TV.
export interface CastRemoteState {
  // A RemotePlayer is bound to an active receiver session.
  isConnected: boolean
  // The receiver has media loaded (false during launch / between items).
  isMediaLoaded: boolean
  isPaused: boolean
  canSeek: boolean
  currentTime: number // seconds, receiver timeline
  duration: number // seconds
  // Receiver playback state: 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING'.
  // Flips to 'IDLE' when the media finishes (the explicit end-of-media signal
  // the player uses to dismiss the cast widget — robust to HLS streams whose
  // duration is unknown/growing).
  playerState: string | null
}

export function useCast(
  currentLoad?: () => CastLoadArgs | null | Promise<CastLoadArgs | null>,
): {
  status: CastStatus
  remote: CastRemoteState
  start: () => Promise<void>
  stop: () => void
  playOrPause: () => void
  seek: (toSec: number) => void
} {
  const [status, setStatus] = useState<CastStatus>({
    supported: false,
    available: false,
    connected: false,
    deviceName: null,
  })
  const [remote, setRemote] = useState<CastRemoteState>({
    isConnected: false,
    isMediaLoaded: false,
    isPaused: false,
    canSeek: false,
    currentTime: 0,
    duration: 0,
    playerState: null,
  })
  // RemotePlayer + its controller, created once the framework is detected.
  // Held in refs so the play/pause/seek callbacks stay stable across renders.
  const remotePlayerRef = useRef<CastRemotePlayer | null>(null)
  const remoteControllerRef = useRef<CastRemotePlayerController | null>(null)

  // Stable ref to currentLoad so listeners don't need to be
  // re-attached when the player's state changes. Assigned in an
  // effect (not during render) per the react-hooks/refs rule —
  // a render-time write would skip on bail-out renders.
  const loadRef = useRef(currentLoad)
  useEffect(() => {
    loadRef.current = currentLoad
  })

  useEffect(() => {
    let mounted = true
    let cleanup = () => {}
    let listenersAttached = false

    // Kick off the script load (best-effort — errors here are non-fatal
    // because we fall back to polling: even if the script's
    // __onGCastApiAvailable callback never fires, we can still detect
    // a populated window.cast.framework on subsequent ticks).
    //
    // We deliberately swallow rejections silently here: every failure
    // mode (callback skipped, framework not yet ready, options call
    // throws) is recoverable via the polling loop below. If polling
    // ALSO times out after 30s, we log a definitive warning then —
    // that's the one users should actually see.
    void ensureSdk().catch(() => { /* polling fallback handles it */ })

    const tryAttach = (): boolean => {
      if (!mounted) return false
      // Idempotency guard: once attached (RemotePlayer + listeners), never
      // re-run — a second successful pass would orphan the prior RemotePlayer's
      // ANY_CHANGE listener, since `cleanup` is reassigned wholesale below.
      if (listenersAttached) return true
      const fw = window.cast?.framework
      if (!fw) return false
      const ctx = fw.CastContext.getInstance()
      // Apply receiver options. Only receiverApplicationId is
      // strictly required — autoJoinPolicy + resumeSavedSession
      // have sensible defaults (TAB_AND_ORIGIN_SCOPED, true). We
      // deliberately do NOT pass autoJoinPolicy here: referencing
      // fw.AutoJoinPolicy.ORIGIN_SCOPED could evaluate to undefined
      // on some SDK builds, and the CAF Sender silently rejects the
      // whole options object when any field is undefined — leaving
      // requestSession() to fail with "Cannot start session before
      // cast options are provided" (seen in live testing 2026-05-23).
      try {
        ctx.setOptions({
          receiverApplicationId: DEFAULT_MEDIA_RECEIVER_APP_ID,
        })
        // eslint-disable-next-line no-console
        console.info('[Aurora Cast] setOptions applied with app ID', DEFAULT_MEDIA_RECEIVER_APP_ID)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Aurora Cast] setOptions threw:', e)
      }

      const refresh = () => {
        if (!mounted) return
        const castState = ctx.getCastState()
        const session = ctx.getCurrentSession()
        setStatus({
          supported: true,
          available: castState !== fw.CastState.NO_DEVICES_AVAILABLE,
          connected: castState === fw.CastState.CONNECTED,
          deviceName: session ? session.getCastDevice().friendlyName : null,
        })
      }
      const onCastState = () => refresh()
      const onSessionState = () => refresh()
      ctx.addEventListener(fw.CastContextEventType.CAST_STATE_CHANGED, onCastState)
      ctx.addEventListener(fw.CastContextEventType.SESSION_STATE_CHANGED, onSessionState)

      // RemotePlayer — live receiver playback state + controls. ANY_CHANGE
      // fires on every property mutation; we mirror the fields the minimized
      // control widget needs. Wrapped in try/catch because some SDK builds
      // expose the framework before RemotePlayer is constructible.
      let remoteController: CastRemotePlayerController | null = null
      let onRemoteChange: (() => void) | null = null
      try {
        const player = new fw.RemotePlayer()
        remoteController = new fw.RemotePlayerController(player)
        remotePlayerRef.current = player
        remoteControllerRef.current = remoteController
        onRemoteChange = () => {
          if (!mounted) return
          setRemote({
            isConnected: !!player.isConnected,
            isMediaLoaded: !!player.isMediaLoaded,
            isPaused: !!player.isPaused,
            canSeek: !!player.canSeek,
            currentTime: player.currentTime || 0,
            duration: player.duration || 0,
            playerState: player.playerState ?? null,
          })
        }
        remoteController.addEventListener(fw.RemotePlayerEventType.ANY_CHANGE, onRemoteChange)
        onRemoteChange()
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Aurora Cast] RemotePlayer init failed:', e)
      }

      cleanup = () => {
        try {
          ctx.removeEventListener(fw.CastContextEventType.CAST_STATE_CHANGED, onCastState)
          ctx.removeEventListener(fw.CastContextEventType.SESSION_STATE_CHANGED, onSessionState)
          if (remoteController && onRemoteChange) {
            remoteController.removeEventListener(fw.RemotePlayerEventType.ANY_CHANGE, onRemoteChange)
          }
        } catch { /* listener cleanup is best-effort */ }
        remotePlayerRef.current = null
        remoteControllerRef.current = null
      }
      refresh()
      // eslint-disable-next-line no-console
      console.info('[Aurora Cast] SDK detected and listeners attached')
      listenersAttached = true
      return true
    }

    // Try once immediately — the SDK may already be loaded (e.g.
    // because a previous component mounted it earlier in this session).
    if (!tryAttach()) {
      // Poll every 500ms for up to 30s. The CAF Sender SDK normally
      // loads in <2s on a warm connection; the 30s cap protects
      // against zombie polling on browsers that never load it at all
      // (Firefox without an extension, locked-down corporate proxies).
      //
      // Both the interval AND the timeout IDs are captured so the
      // cleanup function can clear them on unmount. Without the
      // timeout clear, every player open/close would leak a pending
      // 30-second timer that fires later with stale closure state.
      const intervalId = window.setInterval(() => {
        if (tryAttach()) window.clearInterval(intervalId)
      }, 500)
      const timeoutId = window.setTimeout(() => {
        if (!listenersAttached) {
          window.clearInterval(intervalId)
          // eslint-disable-next-line no-console
          console.warn('[Aurora Cast] SDK did not initialize within 30s — Cast button will remain hidden')
        }
      }, 30000)
      return () => {
        mounted = false
        window.clearInterval(intervalId)
        window.clearTimeout(timeoutId)
        cleanup()
      }
    }

    return () => {
      mounted = false
      cleanup()
    }
  }, [])

  const start = async () => {
    if (!window.cast?.framework || !window.chrome?.cast?.media) {
      throw new Error('cast SDK not ready')
    }
    const ctx = window.cast.framework.CastContext.getInstance()
    // Belt-and-suspenders: re-apply setOptions right before requesting
    // a session. The CAF Sender will throw "Cannot start session
    // before cast options are provided" if any earlier setOptions call
    // didn't take effect (e.g. timing race with SDK init). Calling
    // again is idempotent and cheap.
    try {
      ctx.setOptions({
        receiverApplicationId: DEFAULT_MEDIA_RECEIVER_APP_ID,
      })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Aurora Cast] setOptions in start() threw:', e)
    }
    // requestSession opens the Cast device picker. Resolves when
    // the user selects a device, rejects if they dismiss it. Wrap
    // in a richer rethrow so the caller sees the full Cast error
    // object (code + description + details), not just a bare
    // "session_error" string — those extra fields are what tell us
    // whether it was the receiver-app launch, a network problem, or
    // the user dismissing the picker.
    try {
      await ctx.requestSession()
    } catch (rawErr) {
      const e = rawErr as { code?: string; description?: string; details?: unknown } & Error
      // eslint-disable-next-line no-console
      console.error('[Aurora Cast] requestSession failed:', {
        code: e?.code,
        description: e?.description,
        details: e?.details,
        message: e?.message,
        raw: rawErr,
      })
      const code = e?.code ?? 'unknown'
      const desc = e?.description ?? e?.message ?? ''
      throw new Error(desc ? `${code}: ${desc}` : code)
    }
    const session = ctx.getCurrentSession()
    if (!session) throw new Error('cast session not established')

    const load = await Promise.resolve(loadRef.current?.())
    if (!load) {
      session.endSession(true)
      throw new Error('no media to cast')
    }
    // eslint-disable-next-line no-console
    console.info('[Aurora Cast] loading media:', {
      url: load.contentUrl,
      type: load.contentType,
      startTime: load.startTime,
      device: session.getCastDevice().friendlyName,
    })

    // Self-test: try to fetch the master playlist ourselves before
    // handing it to the receiver. If Chrome can't fetch it, the
    // receiver definitely won't either, and we can surface a much
    // clearer error (auth/server problem) than the SDK's silent hang
    // (receiver-side problem). Best-effort — we don't block casting
    // on this test, just log the result.
    try {
      const probe = await fetch(load.contentUrl, { method: 'GET', credentials: 'omit' })
      const preview = probe.ok ? (await probe.text()).split('\n').slice(0, 3).join(' | ') : ''
      // eslint-disable-next-line no-console
      console.info('[Aurora Cast] URL self-test:', {
        status: probe.status,
        ok: probe.ok,
        contentType: probe.headers.get('content-type'),
        firstLines: preview,
      })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Aurora Cast] URL self-test fetch threw:', e)
    }

    const media = new window.chrome.cast.media.MediaInfo(load.contentUrl, load.contentType)
    media.streamType = window.chrome.cast.media.StreamType.BUFFERED

    if (load.textTracks && load.textTracks.length) {
      media.tracks = load.textTracks.map((t, i) => {
        const track = new window.chrome!.cast!.media.Track(
          i,
          window.chrome!.cast!.media.TrackType.TEXT,
        )
        track.subtype = window.chrome!.cast!.media.TextTrackType.SUBTITLES
        track.trackContentId = t.url
        track.trackContentType = 'text/vtt'
        if (t.language) track.language = t.language
        if (t.label) track.name = t.label
        return track
      })
    }

    if (load.title) {
      media.metadata = {
        metadataType: 0, // GENERIC
        title: load.title,
        subtitle: load.subtitle,
        images: load.posterUrl ? [{ url: load.posterUrl }] : undefined,
      }
    }

    const request = new window.chrome.cast.media.LoadRequest(media)
    request.autoplay = true
    if (typeof load.startTime === 'number' && load.startTime > 0) {
      request.currentTime = load.startTime
    }
    if (
      typeof load.activeTextTrackIndex === 'number' &&
      load.textTracks &&
      load.activeTextTrackIndex < load.textTracks.length
    ) {
      request.activeTrackIds = [load.activeTextTrackIndex]
    }

    try {
      await session.loadMedia(request)
      // eslint-disable-next-line no-console
      console.info('[Aurora Cast] loadMedia resolved — receiver should now be playing')
    } catch (rawErr) {
      const e = rawErr as { code?: string; description?: string; details?: unknown } & Error
      // eslint-disable-next-line no-console
      console.error('[Aurora Cast] loadMedia failed:', {
        code: e?.code,
        description: e?.description,
        details: e?.details,
        message: e?.message,
        raw: rawErr,
      })
      const code = e?.code ?? 'unknown'
      const desc = e?.description ?? e?.message ?? ''
      throw new Error(desc ? `${code}: ${desc}` : `loadMedia: ${code}`)
    }
  }

  const stop = () => {
    if (!window.cast?.framework) return
    const ctx = window.cast.framework.CastContext.getInstance()
    const session = ctx.getCurrentSession()
    if (session) session.endSession(true)
  }

  // Toggle play/pause on the receiver. No-op until a RemotePlayer is bound.
  const playOrPause = () => {
    remoteControllerRef.current?.playOrPause()
  }

  // Seek the receiver. CAF's pattern: set the player's currentTime, then ask
  // the controller to commit it.
  const seek = (toSec: number) => {
    const player = remotePlayerRef.current
    const controller = remoteControllerRef.current
    if (!player || !controller) return
    player.currentTime = Math.max(0, toSec)
    controller.seek()
  }

  return { status, remote, start, stop, playOrPause, seek }
}

// absoluteUrl rewrites a server-relative path to a fully-qualified
// URL using the current document origin. Cast receivers fetch URLs
// independently of the browser, so they must be absolute.
//
// Exposed as a named export so tests / other modules (e.g. an Android
// sender that ever moves into the web bundle) can reuse the same
// origin-joining logic.
//
// Handles four input shapes:
//   - Already-absolute (https://host/p)   → passthrough
//   - Scheme-relative  (//host/p)         → prepend current protocol
//   - Root-relative    (/p)               → prepend window.location.origin
//   - Bare path        (p)                → prepend origin + /
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  if (path.startsWith('//')) return `${window.location.protocol}${path}`
  const origin = window.location.origin
  return path.startsWith('/') ? `${origin}${path}` : `${origin}/${path}`
}

// assertCastScopedToken decodes a JWT (without verifying its signature —
// only the server can do that) and throws if the `scope` claim is not
// "stream:cast". Used as a defense-in-depth check before handing a URL
// containing the token to a Chromecast / AirPlay receiver: a regular
// 15-minute access token (full account scope) must never end up on a
// receiver fetch, even if a future bug routes one through the cast
// flow. The server-side ValidateAccessToken already refuses scoped
// tokens, so the asymmetry is enforced; this check just surfaces a
// frontend bug at the source instead of letting it leak.
//
// Signature verification is intentionally NOT done client-side — we
// don't have the secret. A tampered scope claim would be caught by
// the server on the next API call. The only goal here is to catch
// "we accidentally used the wrong token kind."
export function assertCastScopedToken(token: string): void {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('cast token is not a valid JWT')
  }
  let payload: { scope?: string }
  try {
    // base64url -> base64 -> JSON
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    payload = JSON.parse(atob(padded)) as { scope?: string }
  } catch {
    throw new Error('cast token payload is not parseable')
  }
  if (payload.scope !== 'stream:cast') {
    throw new Error(
      `expected cast-scoped token, got scope=${JSON.stringify(payload.scope ?? null)}`,
    )
  }
}
