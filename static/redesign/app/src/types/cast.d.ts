// Ambient declarations for the Google Cast Sender SDK (CAF v3) and
// WebKit AirPlay. Intentionally minimal — we only declare the surfaces
// we actually call from src/lib/cast.ts and VideoPlayer.tsx.
//
// The SDK is loaded at runtime from
//   https://www.gstatic.com/cv/js/sender/v1/cast_sender.js
// by lib/cast.ts; there is no npm package on our dependency graph, so
// this file is the only contract our TypeScript build sees.

declare global {
  // The Cast SDK calls this once it is ready to be initialized. We
  // register it before injecting the script tag.
  var __onGCastApiAvailable: ((available: boolean, reason?: string) => void) | undefined

  interface Window {
    __onGCastApiAvailable?: ((available: boolean, reason?: string) => void) | undefined
    chrome?: ChromeCastNamespace
    cast?: CastNamespace
  }

  // ---- chrome.cast.* (low-level — used for MediaInfo/LoadRequest) ----
  interface ChromeCastNamespace {
    cast?: {
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: string
        MediaInfo: new (contentId: string, contentType: string) => CastMediaInfo
        LoadRequest: new (mediaInfo: CastMediaInfo) => CastLoadRequest
        Track: new (trackId: number, type: string) => CastTrack
        TrackType: { TEXT: string; AUDIO: string; VIDEO: string }
        TextTrackType: { SUBTITLES: string; CAPTIONS: string }
        StreamType: { BUFFERED: string; LIVE: string; OTHER: string }
      }
    }
  }

  interface CastMediaInfo {
    contentId: string
    contentType: string
    streamType?: string
    duration?: number
    tracks?: CastTrack[]
    metadata?: unknown
  }

  interface CastLoadRequest {
    media: CastMediaInfo
    currentTime?: number
    autoplay?: boolean
    activeTrackIds?: number[]
  }

  interface CastTrack {
    trackId: number
    type: string
    subtype?: string
    trackContentId?: string
    trackContentType?: string
    name?: string
    language?: string
    customData?: unknown
  }

  // ---- cast.framework.* (high-level — what we drive from lib/cast.ts) ----
  interface CastNamespace {
    framework: {
      CastContext: {
        getInstance(): CastContextInstance
      }
      CastContextEventType: {
        CAST_STATE_CHANGED: string
        SESSION_STATE_CHANGED: string
      }
      CastState: {
        NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE'
        NOT_CONNECTED: 'NOT_CONNECTED'
        CONNECTING: 'CONNECTING'
        CONNECTED: 'CONNECTED'
      }
      SessionState: {
        NO_SESSION: 'NO_SESSION'
        SESSION_STARTING: 'SESSION_STARTING'
        SESSION_STARTED: 'SESSION_STARTED'
        SESSION_START_FAILED: 'SESSION_START_FAILED'
        SESSION_ENDING: 'SESSION_ENDING'
        SESSION_ENDED: 'SESSION_ENDED'
        SESSION_RESUMED: 'SESSION_RESUMED'
      }
      AutoJoinPolicy: { ORIGIN_SCOPED: string }
      // Remote playback control — lets the sender drive (play/pause/seek)
      // and observe the receiver's media session. A RemotePlayer holds live
      // state; the controller mutates it. Both are singletons over the
      // CastContext's current session.
      RemotePlayer: new () => CastRemotePlayer
      RemotePlayerController: new (player: CastRemotePlayer) => CastRemotePlayerController
      RemotePlayerEventType: {
        ANY_CHANGE: string
        IS_CONNECTED_CHANGED: string
        IS_MEDIA_LOADED_CHANGED: string
        IS_PAUSED_CHANGED: string
        CURRENT_TIME_CHANGED: string
        DURATION_CHANGED: string
        CAN_SEEK_CHANGED: string
        PLAYER_STATE_CHANGED: string
      }
    }
  }

  // RemotePlayer carries live receiver state; RemotePlayerController mutates
  // it. To seek: set `player.currentTime = sec` then call `controller.seek()`.
  interface CastRemotePlayer {
    isConnected: boolean
    isMediaLoaded: boolean
    isPaused: boolean
    canSeek: boolean
    currentTime: number
    duration: number
    playerState: string | null
    title?: string | null
  }

  interface CastRemotePlayerController {
    playOrPause(): void
    stop(): void
    seek(): void
    addEventListener(type: string, listener: (e: unknown) => void): void
    removeEventListener(type: string, listener: (e: unknown) => void): void
  }

  interface CastContextInstance {
    setOptions(opts: {
      receiverApplicationId: string
      autoJoinPolicy?: string
      resumeSavedSession?: boolean
    }): void
    getCastState(): string
    requestSession(): Promise<string | undefined>
    endCurrentSession(stopCasting: boolean): void
    getCurrentSession(): CastSessionInstance | null
    addEventListener(type: string, listener: (e: unknown) => void): void
    removeEventListener(type: string, listener: (e: unknown) => void): void
  }

  interface CastSessionInstance {
    getCastDevice(): { friendlyName: string }
    loadMedia(request: CastLoadRequest): Promise<unknown>
    getMediaSession(): CastMediaSession | null
    endSession(stopCasting: boolean): void
  }

  // The receiver's current media session (chrome.cast.media.Media). We read
  // idleReason — the RemotePlayer exposes playerState ('IDLE') but NOT why it
  // went idle, and that distinction lives here — and this object's OWN
  // playerState, which answers a different question than the RemotePlayer's:
  // "is the session I just joined already playing something?".
  interface CastMediaSession {
    // Why playback went IDLE: 'FINISHED' on natural end-of-media,
    // 'CANCELLED'/'INTERRUPTED' on a user stop or media switch, 'ERROR' on
    // failure. Null/undefined until the media has gone idle at least once.
    idleReason?: string | null
    // 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING'. Load-bearing because the
    // media object SURVIVES going idle (that is how idleReason above is
    // readable at all), so its mere existence cannot distinguish "a cast
    // another tab is playing" from "our own cast that already finished".
    playerState?: string | null
  }

  // ---- WebKit-prefixed Fullscreen API ----
  // iOS Safari (and older WebKit) expose the prefixed names instead of the
  // standard Fullscreen API. Without these declarations, calling the
  // standard `requestFullscreen()` on iOS throws "requestFullscreen is not
  // a function" (issue #309), so we feature-detect and fall back to these.
  interface Element {
    webkitRequestFullscreen?: () => void
  }
  interface Document {
    webkitExitFullscreen?: () => void
    readonly webkitFullscreenElement?: Element | null
  }

  // ---- WebKit AirPlay on HTMLVideoElement ----
  interface HTMLVideoElement {
    // iPhone Safari fullscreen (issue #436). Unlike iPad/desktop Safari,
    // iPhone implements neither the standard nor the webkit-prefixed
    // Fullscreen API on arbitrary elements — `Element.webkitRequestFullscreen`
    // is simply absent, so the div-based fullscreen used everywhere else
    // silently does nothing. The only fullscreen surface iPhone exposes is
    // this native video-element API (OS chrome, not ours).
    webkitEnterFullscreen?: () => void
    webkitExitFullscreen?: () => void
    readonly webkitDisplayingFullscreen?: boolean
    // Available on Safari/WebKit. Pops the system AirPlay picker.
    webkitShowPlaybackTargetPicker?: () => void
    // True while the video is being mirrored to a wireless (AirPlay) target.
    // Read it to know whether the laptop <video> is currently the AirPlay
    // source; pairs with the 'webkitcurrentplaybacktargetiswirelesschanged'
    // event to drive the minimized cast/AirPlay control widget.
    readonly webkitCurrentPlaybackTargetIsWireless?: boolean
    // Fires when an AirPlay-capable device becomes available or
    // disappears. Detail is a CustomEvent-like object with
    // `availability: 'available' | 'not-available'`.
    onwebkitplaybacktargetavailabilitychanged?:
      | ((this: HTMLVideoElement, ev: Event & { availability?: string }) => unknown)
      | null
  }
}

// Allow JSX to pass the non-standard `x-webkit-airplay` attribute on
// <video> without React's type system complaining. React already accepts
// arbitrary `data-*` and `aria-*` props; this extends the contract to
// the WebKit AirPlay opt-in attribute we set explicitly in the player.
declare module 'react' {
  interface VideoHTMLAttributes<T> extends MediaHTMLAttributes<T> {
    'x-webkit-airplay'?: 'allow' | 'deny'
  }
}

export {}
