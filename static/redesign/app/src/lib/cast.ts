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
      try {
        const ctx = window.cast!.framework.CastContext.getInstance()
        ctx.setOptions({
          receiverApplicationId: DEFAULT_MEDIA_RECEIVER_APP_ID,
          // ORIGIN_SCOPED means a tab on aurora.local only auto-rejoins
          // sessions started from aurora.local — not from random other
          // sites that happened to be casting on the same network.
          autoJoinPolicy: window.cast!.framework.AutoJoinPolicy.ORIGIN_SCOPED,
          resumeSavedSession: false,
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
export function useCast(
  currentLoad?: () => CastLoadArgs | null | Promise<CastLoadArgs | null>,
): {
  status: CastStatus
  start: () => Promise<void>
  stop: () => void
} {
  const [status, setStatus] = useState<CastStatus>({
    supported: false,
    available: false,
    connected: false,
    deviceName: null,
  })

  // Stable ref to currentLoad so listeners don't need to be
  // re-attached when the player's state changes. Assigned in an
  // effect (not during render) per the react-hooks/refs rule —
  // a render-time write would skip on bail-out renders.
  const loadRef = useRef(currentLoad)
  useEffect(() => {
    loadRef.current = currentLoad
  })

  useEffect(() => {
    let canceled = false

    ensureSdk()
      .then(() => {
        if (canceled || !window.cast) return
        const ctx = window.cast.framework.CastContext.getInstance()
        const refresh = () => {
          const castState = ctx.getCastState()
          const session = ctx.getCurrentSession()
          setStatus({
            supported: true,
            available: castState !== window.cast!.framework.CastState.NO_DEVICES_AVAILABLE,
            connected: castState === window.cast!.framework.CastState.CONNECTED,
            deviceName: session ? session.getCastDevice().friendlyName : null,
          })
        }
        const onCastState = () => refresh()
        const onSessionState = () => refresh()
        ctx.addEventListener(
          window.cast.framework.CastContextEventType.CAST_STATE_CHANGED,
          onCastState,
        )
        ctx.addEventListener(
          window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
          onSessionState,
        )
        refresh()

        return () => {
          ctx.removeEventListener(
            window.cast!.framework.CastContextEventType.CAST_STATE_CHANGED,
            onCastState,
          )
          ctx.removeEventListener(
            window.cast!.framework.CastContextEventType.SESSION_STATE_CHANGED,
            onSessionState,
          )
        }
      })
      .catch(() => {
        if (!canceled) {
          setStatus((s) => ({ ...s, supported: false }))
        }
      })

    return () => {
      canceled = true
    }
  }, [])

  const start = async () => {
    if (!window.cast?.framework || !window.chrome?.cast?.media) {
      throw new Error('cast SDK not ready')
    }
    const ctx = window.cast.framework.CastContext.getInstance()
    // requestSession opens the Cast device picker. Resolves when
    // the user selects a device, rejects if they dismiss it.
    await ctx.requestSession()
    const session = ctx.getCurrentSession()
    if (!session) throw new Error('cast session not established')

    const load = await Promise.resolve(loadRef.current?.())
    if (!load) {
      session.endSession(true)
      throw new Error('no media to cast')
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

    await session.loadMedia(request)
  }

  const stop = () => {
    if (!window.cast?.framework) return
    const ctx = window.cast.framework.CastContext.getInstance()
    const session = ctx.getCurrentSession()
    if (session) session.endSession(true)
  }

  return { status, start, stop }
}

// absoluteUrl rewrites a server-relative path to a fully-qualified
// URL using the current document origin. Cast receivers fetch URLs
// independently of the browser, so they must be absolute.
//
// Exposed as a named export so tests / other modules (e.g. an Android
// sender that ever moves into the web bundle) can reuse the same
// origin-joining logic.
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const origin = window.location.origin
  return path.startsWith('/') ? `${origin}${path}` : `${origin}/${path}`
}
