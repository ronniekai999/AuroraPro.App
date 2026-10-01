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
import type { PlaybackDeliveryMode } from './partyPlayer'

const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845'
// How long a connected:false reading must persist before useCast reports it
// publicly. See the comment on refresh()'s disconnect-debounce for why.
const CAST_DISCONNECT_GRACE_MS = 4000
// How long status.settling stays true after a reconnect before `remote` is
// trusted again. See remoteStaleRef's declaration for why this is a fixed
// delay rather than waiting for a specific SDK event. Exported so consumers
// that add their OWN bounded wait on top of settling (see VideoPlayer's
// auto-advance effect) share the same tuning rather than drifting from it.
export const RECONNECT_SETTLE_MS = 1500
const CAST_SDK_SRC =
  'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'
// CAST_NO_MEDIA_ERROR is the sentinel loadCurrent throws when the load getter
// has nothing to hand the receiver. start() keys its session teardown off the
// exact string, so it lives here rather than as a literal in two places — and
// callers that surface errors to users should map it to something a human can
// read rather than showing it verbatim (it leaked into a user-facing toast in
// issue #503).
export const CAST_NO_MEDIA_ERROR = 'no media to cast'
// How long the pre-load URL self-test may take before it is abandoned. It is
// diagnostics only — a non-OK probe never aborts the cast — so a slow one must
// never hold the load open.
const SELF_TEST_TIMEOUT_MS = 5000

// Only a receiver LOAD rejection can produce an IDLE event for a failed
// replacement. Token minting and SDK/session setup fail before disturbing
// receiver media, so callers must not treat those errors as media outcomes.
export class CastMediaLoadError extends Error {
  readonly contentId: string
  // SDK watermark captured at rejection, before React can publish a status
  // update that was received earlier in the same turn.
  readonly mediaStatusSeq?: number
  constructor(message: string, contentId: string, mediaStatusSeq?: number) {
    super(message)
    this.name = 'CastMediaLoadError'
    this.contentId = contentId
    this.mediaStatusSeq = mediaStatusSeq
  }
}

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
  segmentFormat?: 'ts' | 'fmp4'
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
  // True while a disconnect is suspected but not yet confirmed (mid grace
  // window — see refresh()'s debounce comment). `connected` and `remote`
  // both keep reporting their last known-good reading during this window,
  // so anything that treats them as LIVE receiver data to act on (seek/sync
  // corrections, not just display) should check this and hold off — the
  // data may be stale, not current.
  settling: boolean
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
  title?: string | null
  // The receiver's media identity, when CAF supplies it. Older SDK/device
  // shapes may omit it; end handling retains its reason-based fallback.
  contentId?: string | null
  // Non-null only when currentTime/playerState/isPaused were sampled from
  // the same chrome.cast.media.Media instance that owns this content ID.
  // RemotePlayer property mutations and URI-only updates are not clock proof.
  clockContentId?: string | null
  // This Media instance's last genuine addUpdateListener revision. Generic
  // RemotePlayer events (including volume/mute) only resample, never advance
  // it. New/unsupported Media instances start at 0 and inherit no evidence.
  mediaStatusSeq?: number
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
  // Bumped once for every update onRemoteChange actually applies (i.e. one
  // that got past its freeze check) — never during an active blip, but
  // still on every ordinary update once reconnected, INCLUDING the very
  // first one after a blip, which can itself still be a not-yet-caught-up
  // snapshot (settling covers the fixed wait, not the SDK's actual catch-up
  // time). Consumers that need to be sure a reading is genuinely fresh
  // rather than merely "not currently frozen" — i.e. landed strictly AFTER
  // settling last cleared, not just after the freeze lifted at reconnect —
  // compare this against a snapshot taken at the moment settling clears.
  // Pure counter, not itself gated by settling — gating it would just move
  // this same distinction one level deeper.
  updateSeq: number
}

export function useCast(
  currentLoad?: (atAbsSec?: number) => CastLoadArgs | null | Promise<CastLoadArgs | null>,
): {
  status: CastStatus
  remote: CastRemoteState
  start: () => Promise<void>
  loadCurrent: (atAbsSec?: number) => Promise<void>
  stop: () => void
  playOrPause: () => void
  seek: (toSec: number) => void
} {
  const [status, setStatus] = useState<CastStatus>({
    supported: false,
    available: false,
    connected: false,
    settling: false,
    deviceName: null,
  })
  const [remote, setRemote] = useState<CastRemoteState>({
    title: null,
    contentId: null,
    clockContentId: null,
    mediaStatusSeq: 0,
    isConnected: false,
    isMediaLoaded: false,
    isPaused: false,
    canSeek: false,
    currentTime: 0,
    duration: 0,
    playerState: null,
    idleReason: null,
    updateSeq: 0,
  })
  // RemotePlayer + its controller, created once the framework is detected.
  // Held in refs so the play/pause/seek callbacks stay stable across renders.
  const remotePlayerRef = useRef<CastRemotePlayer | null>(null)
  const remoteControllerRef = useRef<CastRemotePlayerController | null>(null)
  // Backing counter for CastRemoteState.updateSeq — a ref rather than
  // reading the previous state back, since onRemoteChange always replaces
  // the whole `remote` object and reading stale state out of a closure is
  // exactly the class of bug this file has spent several rounds fixing.
  const prevUpdateSeqRef = useRef(0)
  const mediaStatusSeqRef = useRef(0)
  const sampleRemoteRef = useRef<(() => void) | null>(null)
  const mediaLoadAssociationRef = useRef<{
    contentId: string
    outgoingMedia: CastMediaSession | null
    outgoingId: number | null
  } | null>(null)

  // Pending "confirm the disconnect" timer + the last publicly-reported
  // connected value, both read/written by refresh() (see its comment) to
  // debounce connected:true -> false transitions across CAST_STATE_CHANGED /
  // SESSION_STATE_CHANGED events.
  const disconnectTimerRef = useRef<number | null>(null)
  const lastConnectedRef = useRef(false)
  // True from the moment a disconnect debounce is armed until `remote` is
  // trusted again. Distinct from `disconnectTimerRef` being non-null: that
  // only covers the ACTIVE debounce window, but on reconnect the timer
  // clears (and connected goes back to true) before the receiver's next
  // real update necessarily arrives — `remote` stays frozen at its pre-blip
  // reading in that gap. status.settling stays true across that whole span
  // so automatic consumers (party drift-correction) don't act on it as live
  // data. Cleared by settleTimerRef below on a fixed delay, NOT by waiting
  // for a specific ANY_CHANGE — the SDK gives no guarantee one arrives
  // promptly (a paused, static receiver may fire nothing for a long time),
  // and waiting for a "real" one still can't prove IT isn't itself a
  // not-yet-caught-up reset snapshot. A short fixed wait is what bounds
  // both problems at once: `remote` gets one un-gated window to pick up
  // whatever the receiver actually sends (onRemoteChange only freezes
  // while disconnectTimerRef is non-null, which clears at reconnect — same
  // moment this timer starts), and settling can never be stuck forever.
  const remoteStaleRef = useRef(false)
  // Pending settle-timer handle — see RECONNECT_SETTLE_MS's declaration
  // above for why this is a fixed delay, armed at the reconnect edge below.
  const settleTimerRef = useRef<number | null>(null)
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
          // settling is NOT cleared here (2026-08 review fix, round 2): it
          // stays whatever it currently is — still true if a blip was
          // pending, since `remote` isn't resynced yet either (see below).
          // Clearing settling HERE, before `remote` is actually trustworthy,
          // would tell automatic consumers (party drift-correction) "remote
          // is live" while it's still the frozen pre-blip reading — a stale
          // `currentTime` compared against the party's continuously-
          // advancing position looks exactly like a seek and triggers a
          // spurious corrective broadcast.
          setStatus((prev) => ({ supported: true, available, connected: true, settling: prev.settling, deviceName }))
          // Deliberately NOT resyncing `remote` here either (round 1 of this
          // fix): the RemotePlayer's fields can still hold a reset/IDLE
          // snapshot from the disconnect at the exact instant CastState
          // flips back to CONNECTED — the receiver's own MEDIA_STATUS
          // catch-up hasn't necessarily landed yet. Reading it now would
          // republish that reset state as if current, which is exactly what
          // the freeze in onRemoteChange exists to prevent, just moved to
          // the reconnect edge instead of the mid-blip one. Leave `remote`
          // frozen; onRemoteChange's freeze lifts now that the timer is
          // cleared, so ordinary ANY_CHANGE events flow through and update
          // it on their own from here — settling just gives them a fixed
          // window to do so (below) before consumers trust it again.
          if (remoteStaleRef.current && settleTimerRef.current == null) {
            settleTimerRef.current = window.setTimeout(() => {
              settleTimerRef.current = null
              if (!mounted) return
              // A NEW blip may have started since this was armed — in that
              // case disconnectTimerRef is non-null again and that cycle's
              // own resolution (confirmed disconnect, or another reconnect
              // re-arming this same timer) owns clearing settling, not this
              // stale firing.
              if (disconnectTimerRef.current != null) return
              remoteStaleRef.current = false
              setStatus((prev) => ({ ...prev, settling: false }))
            }, RECONNECT_SETTLE_MS)
          }
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
        remoteStaleRef.current = true
        // A new disconnect cycle supersedes any settle-timer fallback left
        // over from a PRIOR reconnect (see its arming site below) — clear it
        // so the next reconnect gets the settle timer's full budget rather
        // than whatever was left on an unrelated, already-ticking one.
        if (settleTimerRef.current != null) {
          window.clearTimeout(settleTimerRef.current)
          settleTimerRef.current = null
        }
        setStatus((prev) => ({ ...prev, settling: true }))
        disconnectTimerRef.current = window.setTimeout(() => {
          disconnectTimerRef.current = null
          if (!mounted) return
          if (ctx.getCastState() !== fw.CastState.CONNECTED) {
            lastConnectedRef.current = false
            remoteStaleRef.current = false
            setStatus((prev) => ({ ...prev, connected: false, settling: false }))
            // Reconnect never came — sync remote to whatever the (now
            // truly disconnected) RemotePlayer currently reports, rather
            // than leaving it frozen at its pre-blip reading forever. Safe
            // here (unlike the reconnect edge above): connected is false in
            // this SAME update, so nothing treats `remote` as live data.
            onRemoteChange?.()
            return
          }
          // CastState already reads CONNECTED here — a rare race where this
          // timer fired before the CAST_STATE_CHANGED for the reconnect was
          // processed. Nothing to do: disconnectTimerRef is already null
          // (cleared above) and settling/remoteStaleRef are both still
          // true, which is exactly the state the ordinary rawConnected
          // reconnect path leaves behind too — when that event's own
          // refresh() call lands (which it still will), it arms the
          // settle-timer fallback the same as any other reconnect. Settling
          // is NOT stuck: nothing here needs to act on this race at all.
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
      let mediaBinding: {
        media: CastMediaSession
        listener: (alive: boolean) => void
        revision: number
        alive: boolean
      } | null = null
      const detachMedia = () => {
        const previous = mediaBinding
        mediaBinding = null
        try { previous?.media.removeUpdateListener?.(previous.listener) } catch { /* best effort */ }
      }
      const bindMedia = (media: CastMediaSession | null) => {
        if (mediaBinding?.media === media) return
        detachMedia()
        if (!media || typeof media.addUpdateListener !== 'function' ||
          typeof media.removeUpdateListener !== 'function') return
        const binding = {
          media,
          revision: 0,
          alive: true,
          listener: (alive: boolean) => {
            if (!mounted || mediaBinding !== binding || disconnectTimerRef.current != null) return
            // A replaced Media's delayed callback must not freshen its successor.
            try { if (ctx.getCurrentSession()?.getMediaSession() !== media) return } catch { return }
            binding.alive = alive
            binding.revision = ++mediaStatusSeqRef.current
            onRemoteChange?.()
          },
        }
        mediaBinding = binding
        try { media.addUpdateListener(binding.listener) } catch { detachMedia() }
      }
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
          let contentId: string | null = player.mediaInfo?.contentId ?? null
          let clockContentId: string | null = null
          let mediaStatusSeq = 0
          let currentTime = player.currentTime || 0
          // RemotePlayer's state can still belong to an outgoing item while
          // Media already identifies its replacement. Do not fabricate that
          // identity/state pair when the Media itself has no usable state.
          let playerState: string | null = null
          let isPaused = !!player.isPaused
          try {
            const mediaSession = ctx.getCurrentSession()?.getMediaSession() ?? null
            bindMedia(mediaSession)
            mediaStatusSeq = mediaBinding?.revision ?? 0
            idleReason = mediaSession?.idleReason ?? null
            contentId = mediaSession?.media?.contentId ?? contentId
            // CAF may update its Media identity before RemotePlayer's clock.
            // Read the state and estimated clock from this ONE Media object,
            // never pairing its URI with separately mirrored player fields.
            const mediaState = mediaSession?.playerState
            const mediaId = mediaSession?.media?.contentId
            const association = mediaLoadAssociationRef.current
            const id = mediaSession?.mediaSessionId
            const associated = !association || mediaId !== association.contentId ||
              association.outgoingMedia === null ||
              (association.outgoingId !== null && typeof id === 'number' && Number.isFinite(id)
                ? id !== association.outgoingId : mediaSession !== association.outgoingMedia)
            // A successful repeated-URI LOAD can precede the new Media status.
            // The outgoing Media remains coherent, but belongs to the prior
            // load: neither its clock nor terminal state proves the new item.
            if (!associated) idleReason = null
            if (associated && typeof mediaState === 'string') {
              isPaused = mediaState === 'PAUSED'
              if (typeof mediaId === 'string' && mediaId.length > 0) playerState = mediaState
            }
            if (associated && mediaSession && mediaBinding?.alive !== false && typeof mediaId === 'string' && mediaId.length > 0 &&
              (mediaState === 'PLAYING' || mediaState === 'PAUSED')) {
              // The SDK recommends getEstimatedTime over its sporadically
              // updated currentTime. Older shapes can use their own clock;
              // an invalid/throwing estimator never falls back to stale data.
              const mediaTime = typeof mediaSession.getEstimatedTime === 'function'
                ? mediaSession.getEstimatedTime() : mediaSession.currentTime
              if (typeof mediaTime === 'number' && Number.isFinite(mediaTime) && mediaTime >= 0) {
                currentTime = mediaTime
                clockContentId = mediaId
              }
            }
          } catch { /* defensive — SDK shape varies across builds */ }
          setRemote({
            title: player.title ?? null,
            contentId,
            clockContentId,
            mediaStatusSeq,
            isConnected: !!player.isConnected,
            isMediaLoaded: !!player.isMediaLoaded,
            isPaused,
            canSeek: !!player.canSeek,
            currentTime,
            duration: player.duration || 0,
            playerState,
            idleReason,
            updateSeq: (prevUpdateSeqRef.current += 1),
          })
        }
        sampleRemoteRef.current = onRemoteChange
        remoteController.addEventListener(fw.RemotePlayerEventType.ANY_CHANGE, onRemoteChange)
        onRemoteChange()
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Aurora Cast] RemotePlayer init failed:', e)
      }

      cleanup = () => {
        sampleRemoteRef.current = null
        detachMedia()
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
        if (settleTimerRef.current != null) {
          window.clearTimeout(settleTimerRef.current)
          settleTimerRef.current = null
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
  // atAbsSec (optional) is where the receiver should resume, in ABSOLUTE
  // SOURCE seconds — the file's own clock, not the receiver's and not the
  // local <video>'s. Omitting it lets the getter choose (the ordinary "cast
  // from where I am" case).
  //
  // 2026-09: this used to be a receiver-relative `startTimeSec` that
  // OVERWROTE load.startTime after the fact. That only worked while every
  // cast session shared the local player's `-ss` anchor, which stopped being
  // true when cast clones started being anchored near the sender: the same
  // number now means different positions on the two timelines. Handing the
  // absolute position to the getter instead — which is the thing that knows
  // the cast session's anchor, because it just minted it — keeps the one
  // conversion in the one place that can do it correctly.
  //
  // Throws on every failure so callers decide whether to retry or stop.
  const loadCurrent = async (atAbsSec?: number) => {
    if (!window.cast?.framework || !window.chrome?.cast?.media) {
      throw new Error('cast SDK not ready')
    }
    const ctx = window.cast.framework.CastContext.getInstance()
    const session = ctx.getCurrentSession()
    if (!session) throw new Error('cast session not established')

    const load = await Promise.resolve(loadRef.current?.(atAbsSec))
    if (!load) throw new Error(CAST_NO_MEDIA_ERROR)
    // eslint-disable-next-line no-console
    console.info('[Aurora Cast] loading media:', {
      url: load.contentUrl,
      type: load.contentType,
      startTime: load.startTime,
      device: session.getCastDevice().friendlyName,
    })

    // Self-test: try to fetch the media URL ourselves before handing it to
    // the receiver. If Chrome can't fetch it, the receiver definitely won't
    // either, and we can surface a much clearer error (auth/server problem)
    // than the SDK's silent hang (receiver-side problem). Best-effort — we
    // don't block casting on this test, just log the result.
    //
    // The METHOD depends on what contentUrl points at, which since issue #503
    // is no longer always a playlist.
    //
    // A master playlist is a few hundred bytes and its first lines ARE the
    // diagnostic, so fetch it. A direct-play media file is neither: a bare GET
    // of one pulls the WHOLE movie into the sender — gigabytes, before
    // loadMedia is even issued, blocking the cast for minutes and repeating on
    // every load, renewal and auto-advance — and `.text()` would then try to
    // build a multi-GB string out of binary MP4. HEAD proves exactly what this
    // test exists to prove (reachable, token accepted) with no body at all,
    // and /api/stream/direct/ treats HEAD as an explicit preflight that skips
    // every side effect, so probing cannot write an activity row, register a
    // phantom "now streaming" entry, or spawn a heartbeat goroutine for a
    // response nobody reads.
    const isPlaylist = /mpegurl|vnd\.apple/i.test(load.contentType)
    try {
      // Timed out deliberately. fetch() has no default timeout, and a server
      // that accepts the connection then never answers would leave this await
      // pending forever — which does not merely delay a diagnostic: the load
      // stays "in flight" on the sender, and the caller keys its correction
      // and end-of-media suppression off exactly that. A stalled probe would
      // silence the whole receiver loop for the rest of the cast.
      const probe = await fetch(load.contentUrl, {
        method: isPlaylist ? 'GET' : 'HEAD',
        credentials: 'omit',
        signal: AbortSignal.timeout(SELF_TEST_TIMEOUT_MS),
      })
      const preview = probe.ok && isPlaylist
        ? (await probe.text()).split('\n').slice(0, 3).join(' | ')
        : ''
      // eslint-disable-next-line no-console
      console.info('[Aurora Cast] URL self-test:', {
        method: isPlaylist ? 'GET' : 'HEAD',
        status: probe.status,
        ok: probe.ok,
        contentType: probe.headers.get('content-type'),
        contentLength: probe.headers.get('content-length'),
        firstLines: preview,
      })
      // Diagnostics only, deliberately: a non-OK probe does NOT abort the
      // cast. Aborting is the better behaviour on its face — for a direct
      // file this is nearly the receiver's own fetch, so a 401/404 predicts
      // its failure — but it can only be done safely if a failed load can
      // tear the session down without closing the player, and that is the
      // lifecycle problem start() above declines to reopen. Left as the
      // documented follow-up rather than half-built.
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Aurora Cast] URL self-test fetch threw:', e)
    }

    const media = new window.chrome.cast.media.MediaInfo(load.contentUrl, load.contentType)
    media.streamType = window.chrome.cast.media.StreamType.BUFFERED
    if (load.segmentFormat) {
      media.hlsSegmentFormat = load.segmentFormat === 'fmp4' ? 'FMP4' : 'TS'
      media.hlsVideoSegmentFormat = load.segmentFormat === 'fmp4' ? 'FMP4' : 'MPEG2_TS'
    }

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

    // Capture at the actual LOAD boundary, after picker/token/self-test work:
    // the picker may have joined a TV that was already playing this same URI.
    const previousAssociation = mediaLoadAssociationRef.current
    let outgoingMedia: CastMediaSession | null = null
    try { outgoingMedia = session.getMediaSession() } catch { /* unavailable SDK shape */ }
    const outgoingId = outgoingMedia?.mediaSessionId
    mediaLoadAssociationRef.current = {
      contentId: load.contentUrl,
      outgoingMedia,
      outgoingId: typeof outgoingId === 'number' && Number.isFinite(outgoingId) ? outgoingId : null,
    }
    sampleRemoteRef.current?.()
    try {
      await session.loadMedia(request)
      sampleRemoteRef.current?.()
      // eslint-disable-next-line no-console
      console.info('[Aurora Cast] loadMedia resolved — receiver should now be playing')
    } catch (rawErr) {
      mediaLoadAssociationRef.current = previousAssociation
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
      throw new CastMediaLoadError(describeCastError(rawErr), load.contentUrl, mediaStatusSeqRef.current)
    }
  }

  const start = async () => {
    if (!window.cast?.framework || !window.chrome?.cast?.media) {
      throw new Error('cast SDK not ready')
    }
    // A genuine new session is starting — clear this BEFORE requestSession()
    // (not after awaiting it): the SDK can dispatch CAST_STATE_CHANGED /
    // SESSION_STATE_CHANGED synchronously as part of establishing the
    // session, ahead of our `await` continuation resuming. If stoppedRef
    // were still true when those fire, refresh() would ignore the very
    // CONNECTED reading that starts this cast, and — since useCast lives for
    // the app's whole lifetime, not per-cast — every cast after the first
    // stop() would silently report connected:false while the receiver plays.
    stoppedRef.current = false
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
    const session = ctx.getCurrentSession()
    if (!session) throw new Error('cast session not established')

    // Hand off to the shared loader (also used by the next-episode
    // auto-advance). Preserve start()'s original cleanup: when there is
    // nothing to cast, tear the just-opened session back down rather than
    // stranding an empty receiver after the user picked a device.
    //
    // Keyed on the no-media sentinel ALONE, deliberately. Widening it to every
    // load failure looks obviously better and is not: ending the session
    // reaches the disconnect edge exactly like a finished cast, so the player
    // closes on the debounce four seconds later and takes a half-watched film
    // with it. Four review rounds were spent trying to hold that open safely —
    // the flag saying "this session never loaded anything" has to survive a
    // reconnect inside the debounce, a page reload that re-joins a live
    // session, and a `remote` snapshot that outlives the cast — and each fix
    // introduced the next defect. Callers that want teardown route through the
    // sentinel; anything else leaves the session alone. See CLAUDE.md's
    // known-limits for the two behaviours this leaves on the table.
    try {
      await loadCurrent()
    } catch (e) {
      if ((e as Error)?.message === CAST_NO_MEDIA_ERROR) {
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
    if (settleTimerRef.current != null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
    lastConnectedRef.current = false
    remoteStaleRef.current = false
    setStatus((prev) => ({ ...prev, connected: false, settling: false }))
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

// --- Direct-play casting --------------------------------------------------

// Containers/codecs the Default Media Receiver (CC1AD845) can be handed as a
// PROGRESSIVE file — i.e. with no HLS session in front of it. This is the
// direct-play twin of the server's CloneForCast doctrine.
//
// It is deliberately narrower than what the receiver might actually manage,
// because the two failure modes are not symmetric. A format the receiver
// cannot decode does NOT surface as an error the sender can catch: loadMedia
// RESOLVES and the TV then spins forever with nothing to report — the same
// silent hang issues #324/#328 document on the HLS side. So a false negative
// costs one honest "can't cast this format" message, while a false positive
// costs an indefinite spinner and a support ticket. The gate therefore names
// only what every Cast device generation decodes.
//
// Deliberately excluded, all of which a browser may still direct-play:
//   - VP8/VP9/AV1/HEVC — support varies by device generation, and the
//     decision engine tells us the container and codec, never which
//     Chromecast is on the other end.
//   - Opus/Vorbis/FLAC — fine for browser direct play, not for the receiver.
//   - webm — see above; its codecs are the ones that vary.
//
// A refusal here is final for that viewer, so do not read it as "falls back
// to HLS": a file the decision engine chose direct play for never acquires a
// session to clone (CloneForCast makes an EXISTING session receiver-safe, and
// there is none). Casting it would require minting a cast-only transcode
// session, which is the open follow-up.
const CAST_DIRECT_CONTAINERS = new Set(['mp4'])
const CAST_DIRECT_VIDEO_CODECS = new Set(['h264'])
const CAST_DIRECT_AUDIO_CODECS = new Set(['aac', 'mp3'])
// Height ceiling. Codec identity is not the receiver's only limit: the first
// three Chromecast generations top out at 1080p (and at H.264 L4.1, i.e.
// 1080p30/720p60), and only Ultra/Google TV decode 4K. The sender is never
// told which device is on the other end — the picker reports a friendly name,
// not a model — so a 4K H.264 file admitted on codec identity alone is an
// indefinite spinner on most of the installed base. 1080p is the height every
// generation handles.
//
// Residual, and deliberately not guessed at: this still cannot see H.264
// LEVEL or bitrate, so a 1080p60 High@L4.2 file or a 40 Mbps remux is
// admitted and may still defeat a first-generation device. The probe records
// neither, and inferring level from resolution alone would be fiction.
const CAST_DIRECT_MAX_HEIGHT = 1080

// The shape of a direct-play decision that matters to the gate. Field names
// mirror StreamDecision's, and the values are already normalized server-side
// (NormalizeContainer runs at scan time, so 'mov' has become 'mp4' long
// before it reaches us).
export interface DirectCastProbe {
  container?: string
  videoCodec?: string
  // The codec of the track the receiver will actually START — stream-info's
  // `audio_codec_out`, NOT `audio_codec`.
  //
  // Those differ, and the difference is a trap. `audio_codec` is the FIRST
  // audio stream's codec ("backward compat" in the scanner); the track a
  // player starts is the first FLAGGED DEFAULT, which is what the decision
  // engine reports through audio_codec_out. An MP4 whose stream 0 is AAC and
  // whose flagged default is FLAC — a shape `ffmpeg -c copy` produces
  // routinely — direct-plays in Chrome and would pass a gate reading
  // `audio_codec`, then hand the receiver a default track it cannot decode.
  audioCodec?: string
  // "WIDTHxHEIGHT" as the scanner records it, e.g. "1920x1080".
  resolution?: string
}

// castDirectPlaySupported reports whether a direct-play file can be handed to
// the Default Media Receiver as-is. Every field fails closed when absent or
// unrecognized.
//
// What makes the audio side sound is narrower than "we checked the codec", and
// worth stating because nothing here can enforce it: a `direct_play` decision
// requires `dpIsDefault`, so the track the engine picked IS the file's
// effective default — the one the receiver will start. `audio_codec_out`
// therefore names the codec the receiver actually has to decode. Should
// DecidePlaybackFor ever admit direct play for a non-default track, this gate
// would silently start describing the wrong one.
//
// Note "" is not reachable from the real data path: OutputAudioCodec falls
// back to "aac" when a decision carries no audio codec, so a silent file
// arrives here as "aac" and is admitted — correctly, since a silent MP4 casts
// fine. The empty case below is defensive only.
export function castDirectPlaySupported(probe: DirectCastProbe): boolean {
  const norm = (s?: string) => (s ?? '').trim().toLowerCase()
  if (!CAST_DIRECT_CONTAINERS.has(norm(probe.container))) return false
  if (!CAST_DIRECT_VIDEO_CODECS.has(norm(probe.videoCodec))) return false
  if (!CAST_DIRECT_AUDIO_CODECS.has(norm(probe.audioCodec))) return false
  return castDirectHeightOK(probe.resolution)
}

// A missing or unparseable resolution fails closed, for the same reason an
// unknown codec does.
function castDirectHeightOK(resolution?: string): boolean {
  const m = /^\s*(\d+)\s*x\s*(\d+)\s*$/.exec(resolution ?? '')
  if (!m) return false
  const height = Number(m[2])
  return Number.isFinite(height) && height > 0 && height <= CAST_DIRECT_MAX_HEIGHT
}

// What the receiver is playing. 'session' is the HLS path (the id is the
// transcode session behind the playlist); 'direct' is a whole media file.
export type CastLoadedMedia =
  | { kind: 'session'; sessionId: string }
  | { kind: 'direct'; fileId: number; fileType: 'media' | 'episode' }

// castLoadedIsDirectFor reports whether the receiver is playing THIS target as
// a direct file. Used to decide whether a scrub can be an in-window receiver
// seek: only true when the receiver's own media is known and is this file.
export function castLoadedIsDirectFor(
  loaded: CastLoadedMedia | null | undefined,
  target: { fileId: number; fileType: 'media' | 'episode' } | null | undefined,
): boolean {
  if (!loaded || loaded.kind !== 'direct' || !target) return false
  return loaded.fileId === target.fileId && loaded.fileType === target.fileType
}

// What the player knows about the current direct-play target.
export interface DirectCastTarget {
  fileId: number
  fileType: 'media' | 'episode'
  supported: boolean
}

// castDirectMatches reports whether `directCast` describes THIS target.
//
// Shared rather than re-derived at each call site: the load path, the
// pre-flight check and the seek path each need it, and an adversarial review
// caught them having already drifted apart — the seek path keyed on delivery
// mode alone, which describes the local <video>, not what the receiver is
// loaded with.
export function castDirectMatches(
  directCast: DirectCastTarget | null | undefined,
  target: { fileId: number; fileType: 'media' | 'episode' } | null | undefined,
): boolean {
  if (!directCast || !target) return false
  return directCast.fileId === target.fileId && directCast.fileType === target.fileType
}

// castDirectLoadEligible: may the direct-play cast path be used right now?
// `deliveryMode` is the LOCAL player's mode, so it is necessary but never
// sufficient — hence the target match beside it.
export function castDirectLoadEligible(
  deliveryMode: PlaybackDeliveryMode,
  directCast: DirectCastTarget | null | undefined,
  target: { fileId: number; fileType: 'media' | 'episode' } | null | undefined,
): boolean {
  return (
    deliveryMode === 'direct' &&
    castDirectMatches(directCast, target) &&
    !!directCast?.supported
  )
}

// Shown when a direct-play title fails the gate above. It says what happened
// and what still works, and promises nothing about a retry — clicking Cast
// again will fail identically, which is the whole complaint in issue #503.
export const CAST_UNSUPPORTED_DIRECT_FORMAT =
  "This title's format can't be sent to a Chromecast. It will keep playing here in your browser."

// The user-facing reading of CAST_NO_MEDIA_ERROR when nothing more specific
// is known — the title is still resolving, or its delivery went away between
// the click and the load.
export const CAST_NOTHING_TO_CAST =
  'There is nothing to cast yet. Wait for the title to start playing, then try again.'

// Distinct from the above because the advice differs: the title IS playing,
// and the server refused or failed to issue the receiver's access token, so
// waiting will not help.
export const CAST_MINT_FAILED =
  'Could not get permission to cast this title. Please try again.'

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
