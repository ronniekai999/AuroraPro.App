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
// How long a connected:false reading must persist before useCast reports it
// publicly. See the comment on refresh()'s disconnect-debounce for why.
const CAST_DISCONNECT_GRACE_MS = 4000
const CAST_SDK_SRC =
  'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'

// describeCastError turns a Cast SDK rejection into a human-readable
// message. The CAF Sender is maddeningly inconsistent about its reject
// shape: requestSession()/loadMedia() may reject with a structured
// `chrome.cast.Error` ({code, description, details}), OR — as seen in
// the wild on Chrome 149 (issue #311) — with the BARE error-code STRING
// from chrome.cast.ErrorCode, e.g. "session_error" or "cancel". The old
// code only read `.code`/`.description`/`.message`; when the rejection
// was a bare string all three were undefined, so it threw "unknown",
// which surfaced to users as the useless "Cast failed: unknown".
//
// Here we (1) normalize the code out of either shape, and (2) map the
// known chrome.cast.ErrorCode values to a sentence the user can act on.
// Unknown codes fall back to the raw code/description so we never lose
// information again.
const CAST_ERROR_MESSAGES: Record<string, string> = {
  // The receiver app (CC1AD845) failed to launch or the session
  // dropped. Almost always a sender↔receiver reachability problem.
  session_error:
    'Could not connect to the Cast device. Make sure it is powered on and on the same Wi-Fi network, then try again.',
  // The picker timed out waiting for the device to respond.
  timeout: 'The Cast device did not respond in time. Please try again.',
  // No receiver is reachable on the network.
  receiver_unavailable:
    'No Cast devices were found. Check that your Chromecast is on and on the same Wi-Fi network.',
  // Sender↔receiver channel error (network blip, device went to sleep).
  channel_error:
    'Lost the connection to the Cast device. Please try again.',
  // The selected receiver is busy with another app/sender.
  extension_not_compatible:
    'This browser cannot reach the Cast device. Try a recent version of Chrome.',
  extension_missing:
    'Casting requires the Google Cast support built into Chrome. Try a recent version of Chrome.',
  // User dismissed the picker — callers treat this as a silent no-op.
  cancel: 'cancel',
  load_failed: 'The Cast device could not play this title. Please try again.',
  invalid_parameter: 'Casting failed due to an internal error (invalid request).',
}

export function describeCastError(rawErr: unknown): string {
  // Bare-string rejection (the issue-#311 case).
  if (typeof rawErr === 'string') {
    return CAST_ERROR_MESSAGES[rawErr] ?? rawErr
  }
  const e = (rawErr ?? {}) as {
    code?: string
    description?: string
    message?: string
  }
  const code = e.code
  const desc = e.description || e.message || ''
  if (code && CAST_ERROR_MESSAGES[code]) {
    return CAST_ERROR_MESSAGES[code]
  }
  // No mapping — preserve whatever the SDK gave us rather than collapsing
  // to "unknown". Prefer a code:description combo when both exist.
  if (code && desc) return `${code}: ${desc}`
  if (code) return code
  if (desc) return desc
  // Last resort: stringify so even an opaque object surfaces *something*.
  try {
    const s = JSON.stringify(rawErr)
    if (s && s !== '{}' && s !== 'null') return s
  } catch { /* circular / non-serializable */ }
  return 'Casting failed for an unknown reason. Please try again.'
}

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
  // Why the receiver last went IDLE: 'FINISHED' (natural end-of-media),
  // 'CANCELLED'/'INTERRUPTED' (user stop / media switch), 'ERROR', or null
  // (never idled / receiver didn't surface a reason). Sourced from the media
  // session, not the RemotePlayer (which only carries playerState). The player
  // uses this to auto-advance only on a genuine finish.
  idleReason: string | null
}

export function useCast(
  currentLoad?: () => CastLoadArgs | null | Promise<CastLoadArgs | null>,
): {
  status: CastStatus
  remote: CastRemoteState
  start: () => Promise<void>
  loadCurrent: (startTimeSec?: number) => Promise<void>
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
    idleReason: null,
  })
  // RemotePlayer + its controller, created once the framework is detected.
  // Held in refs so the play/pause/seek callbacks stay stable across renders.
  const remotePlayerRef = useRef<CastRemotePlayer | null>(null)
  const remoteControllerRef = useRef<CastRemotePlayerController | null>(null)

  // Pending "confirm the disconnect" timer + the last publicly-reported
  // connected value, both read/written by refresh() (see its comment) to
  // debounce connected:true -> false transitions across CAST_STATE_CHANGED /
  // SESSION_STATE_CHANGED events.
  const disconnectTimerRef = useRef<number | null>(null)
  const lastConnectedRef = useRef(false)
  // True while an explicit stop() is tearing its session down. endSession()
  // fires SESSION_STATE_CHANGED asynchronously — a SESSION_ENDING event can
  // still report CastState CONNECTED before the final SESSION_ENDED lands.
  // Without this guard, refresh() reads that stale CONNECTED, undoes stop()'s
  // immediate connected:false, and re-arms the disconnect debounce on the
  // SESSION_ENDED that follows, so one user Stop produces two false
  // transitions (double onClose(), double host-handoff rebuild). Cleared
  // once a NEW session is actually requested.
  const stoppedRef = useRef(false)

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

      // refresh() reflects most state changes immediately, but debounces the
      // connected:true -> false transition specifically. Consumers (the
      // player's cast-disconnect effects) react to connected going false by
      // tearing down the receiver's stream session and closing the player —
      // destructive, hard-to-reverse actions. A transient CastState blip (a
      // brief Wi-Fi hiccup, a router-level connection block, a receiver
      // re-handshake) flips CONNECTED away for one event and back moments
      // later as the SDK's own resumeSavedSession reconnects the sender —
      // but by then the clone the TV was streaming had already been
      // deleted, forcing a full loadMedia rebuild (issue #492: "goes back to
      // the beginning, then seeks to the right position"). Giving a real
      // reconnect a few seconds to land before propagating the disconnect
      // avoids that, at the cost of a short delay before a GENUINE stop
      // (TV remote, explicit Stop, receiver power-off) is reflected — an
      // acceptable trade since those all eventually settle to
      // connected:false and are not time-critical to observe instantly.
      const refresh = () => {
        if (!mounted) return
        const castState = ctx.getCastState()
        const session = ctx.getCurrentSession()
        const rawConnected = castState === fw.CastState.CONNECTED
        const deviceName = session ? session.getCastDevice().friendlyName : null
        const available = castState !== fw.CastState.NO_DEVICES_AVAILABLE

        if (rawConnected) {
          if (stoppedRef.current) {
            // Stale CONNECTED reading from a stop() still tearing its
            // session down (SESSION_ENDING fires before SESSION_ENDED) —
            // see stoppedRef's declaration. Ignore it: applying it here
            // would resurrect connected:true and let the SESSION_ENDED
            // that follows re-arm the disconnect debounce for a stop the
            // user already asked for.
            return
          }
          if (disconnectTimerRef.current != null) {
            window.clearTimeout(disconnectTimerRef.current)
            disconnectTimerRef.current = null
          }
          lastConnectedRef.current = true
          setStatus({ supported: true, available, connected: true, deviceName })
          return
        }

        // Not connected right now. `supported`/`available` (cast-button
        // visibility) aren't destructive, so reflect them immediately.
        // `deviceName` is kept as-is while connected is still being
        // reported true — the session has no device to name once
        // disconnected, and blanking it now would show "connected" UI with
        // no device while the debounce is pending. connected:false itself
        // only propagates once it survives the grace window, and only one
        // timer runs per disconnect (a second CAST_STATE_CHANGED while
        // already pending must not push the deadline back out).
        setStatus((prev) => ({ ...prev, supported: true, available }))
        if (!lastConnectedRef.current || disconnectTimerRef.current != null) return
        disconnectTimerRef.current = window.setTimeout(() => {
          disconnectTimerRef.current = null
          if (!mounted) return
          if (ctx.getCastState() !== fw.CastState.CONNECTED) {
            lastConnectedRef.current = false
            setStatus((prev) => ({ ...prev, connected: false }))
          }
        }, CAST_DISCONNECT_GRACE_MS)
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
          // A disconnect is pending confirmation (see refresh()'s debounce):
          // status.connected is still reporting true, but the RemotePlayer
          // frequently resets to IDLE/zeroed fields the instant the
          // underlying channel drops — well before we know whether this is
          // a real disconnect or a blip that's about to self-heal. Freeze
          // `remote` at its last good reading rather than publish that
          // reset: surfacing playerState:'IDLE' here while connected still
          // reads true is exactly what VideoPlayer's auto-advance effect
          // treats as a genuine end-of-media, which would skip to the next
          // episode (or close the player) on nothing more than the same
          // blip connected's debounce exists to survive. Once the blip
          // resolves — reconnect cancels the timer, or the disconnect gets
          // confirmed and downstream effects tear the cast down anyway —
          // fresh ANY_CHANGE events flow through normally again.
          if (disconnectTimerRef.current != null) return
          // idleReason lives on the media session, not the RemotePlayer. Read
          // it here so it lands in the SAME state update as playerState — the
          // receiver delivers both in one MEDIA_STATUS, so when playerState
          // becomes 'IDLE' the matching reason is already current. getMediaSession()
          // can be null between items; default to null then (treated as a
          // permissive "finished" by the player's advance gate).
          let idleReason: string | null = null
          try {
            idleReason = ctx.getCurrentSession()?.getMediaSession()?.idleReason ?? null
          } catch { /* defensive — SDK shape varies across builds */ }
          setRemote({
            isConnected: !!player.isConnected,
            isMediaLoaded: !!player.isMediaLoaded,
            isPaused: !!player.isPaused,
            canSeek: !!player.canSeek,
            currentTime: player.currentTime || 0,
            duration: player.duration || 0,
            playerState: player.playerState ?? null,
            idleReason,
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
        if (disconnectTimerRef.current != null) {
          window.clearTimeout(disconnectTimerRef.current)
          disconnectTimerRef.current = null
        }
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

  // Load the CURRENT media (from loadRef) onto the EXISTING cast session —
  // no device picker. This is the second half of start(), factored out so the
  // next-episode auto-advance can re-point a live receiver at a freshly-booted
  // local session (the receiver mirrors the local <video>'s server session).
  //
  // startTimeSec (optional) OVERRIDES the getter's startTime. Used by the
  // token-renewal resume path: after a long pause the session-scoped cast
  // token in the loaded URL has expired, so the media is re-loaded with a
  // freshly-minted token — and the resume position must be the RECEIVER's
  // timeline (cast.remote.currentTime), not the getter's default (the frozen
  // local <video> position, which paused when the cast began).
  // Throws on every failure so callers decide whether to retry or stop.
  const loadCurrent = async (startTimeSec?: number) => {
    if (!window.cast?.framework || !window.chrome?.cast?.media) {
      throw new Error('cast SDK not ready')
    }
    const ctx = window.cast.framework.CastContext.getInstance()
    const session = ctx.getCurrentSession()
    if (!session) throw new Error('cast session not established')

    const load = await Promise.resolve(loadRef.current?.())
    if (!load) throw new Error('no media to cast')
    // >= 0, not > 0 (2026-08 review fix, issue #461 follow-up): 0 is a valid
    // explicit resume position (the party/receiver rewound to the very
    // start), and every caller that passes this argument at all means it as
    // an authoritative override — "no override intended" is conveyed by
    // omitting the argument (undefined), which the typeof check already
    // handles. The old `> 0` silently ignored an explicit 0 and fell back to
    // the getter's default startTime (the local <video>'s frozen position,
    // stale since the cast session began), reloading at the wrong spot.
    if (typeof startTimeSec === 'number' && startTimeSec >= 0) {
      load.startTime = startTimeSec
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
      // Same robust mapping as requestSession — handles bare-string and
      // structured rejections alike so a load failure never degrades to
      // a bare "loadMedia: unknown".
      throw new Error(describeCastError(rawErr))
    }
  }

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
      // describeCastError handles BOTH the structured chrome.cast.Error
      // shape AND the bare error-code string the CAF Sender rejects with
      // on some Chrome builds (issue #311: rawErr === "session_error"),
      // mapping known codes to actionable, human-readable messages
      // instead of collapsing them to "unknown".
      throw new Error(describeCastError(rawErr))
    }
    // A genuine new session is starting — any earlier stop() this hook
    // instance ignored stale CONNECTED echoes for is over; let refresh()
    // treat CONNECTED as real again.
    stoppedRef.current = false
    const session = ctx.getCurrentSession()
    if (!session) throw new Error('cast session not established')

    // Hand off to the shared loader (also used by the next-episode
    // auto-advance). Preserve start()'s original cleanup: when there is
    // nothing to cast, tear the just-opened session back down rather than
    // stranding an empty receiver after the user picked a device.
    try {
      await loadCurrent()
    } catch (e) {
      if ((e as Error)?.message === 'no media to cast') {
        try { session.endSession(true) } catch { /* defensive */ }
      }
      throw e
    }
  }

  const stop = () => {
    if (!window.cast?.framework) return
    const ctx = window.cast.framework.CastContext.getInstance()
    const session = ctx.getCurrentSession()
    // Set before endSession(): its SESSION_STATE_CHANGED events fire
    // asynchronously and SESSION_ENDING can still report CastState CONNECTED
    // before the final SESSION_ENDED — refresh() checks this flag to ignore
    // that stale reading rather than resurrecting connected:true and
    // re-arming the disconnect debounce on the SESSION_ENDED that follows.
    stoppedRef.current = true
    if (session) session.endSession(true)
    // This is an explicit, intentional stop (widget button, TV-finish
    // cast.stop()) — unlike a CastState blip, there's nothing to wait out.
    // Bypass refresh()'s disconnect-debounce so the player closes right
    // away instead of sitting connected:true for the grace window.
    if (disconnectTimerRef.current != null) {
      window.clearTimeout(disconnectTimerRef.current)
      disconnectTimerRef.current = null
    }
    lastConnectedRef.current = false
    setStatus((prev) => ({ ...prev, connected: false }))
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

  return { status, remote, start, loadCurrent, stop, playOrPause, seek }
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

// castSessionIdFromPlaylist recovers the transcode-session ID out of the
// playlist URL the cast-token endpoint hands back
// (/api/stream/hls/{sessionID}/master.m3u8?token=…).
//
// That URL is the only place the sender learns which session the RECEIVER
// is actually streaming. It is often NOT the session the local <video> is
// playing: the server clones a cast-safe H.264+AAC session when the local
// one carries codecs the Default Media Receiver can't handle
// (CloneForCast), and the clone's ID appears nowhere else in the response.
// The player needs it for two things — keeping that session alive while
// it's the one feeding the TV, and not deleting it on teardown when the
// clone was skipped and both surfaces share one session.
//
// Returns null on any shape we don't recognize; every caller treats that as
// "no separate cast session", which is the safe reading.
export function castSessionIdFromPlaylist(playlist: string): string | null {
  const m = /\/api\/stream\/hls\/([^/?#]+)\/master\.m3u8/.exec(playlist)
  // No decodeURIComponent: session IDs are hex (hex.EncodeToString server-
  // side), so decoding is a no-op on every real input — and on a malformed
  // one ("%") it THROWS a URIError, which would reject the whole cast from a
  // function documented to return null on anything it doesn't recognize.
  return m ? m[1] : null
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
