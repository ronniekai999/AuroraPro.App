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
    }
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
    getMediaSession(): unknown
    endSession(stopCasting: boolean): void
  }

  // ---- WebKit AirPlay on HTMLVideoElement ----
  interface HTMLVideoElement {
    // Available on Safari/WebKit. Pops the system AirPlay picker.
    webkitShowPlaybackTargetPicker?: () => void
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
