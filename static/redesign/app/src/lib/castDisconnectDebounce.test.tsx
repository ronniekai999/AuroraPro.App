// @vitest-environment jsdom
//
// Regression tests for useCast's disconnect-debounce state machine
// (refresh()'s settling/stoppedRef mechanism, added for issue #492: a
// transient Cast network blip was destroying the receiver's active stream
// session and forcing a full reload).
//
// This exact mechanism produced a real, verified bug in EVERY ONE of three
// independent adversarial review passes before it shipped:
//   1. A partial status update dropped `supported: true`, permanently
//      hiding the Cast button.
//   2. `stop()`'s immediate connected:false could be undone by a stale
//      SESSION_ENDING echo that still reports CastState CONNECTED.
//   3. The fix for #2 (`stoppedRef.current = false`) ran AFTER awaiting
//      requestSession() instead of before it, so a CONNECTED event fired
//      synchronously during session setup was swallowed — silently
//      breaking every cast after the first stop() for the rest of the
//      app's lifetime (useCast never remounts).
//   4. Freezing the mirrored RemotePlayer `remote` state during the grace
//      window, then eagerly resyncing it at the exact instant a reconnect
//      is detected, could republish a still-reset snapshot in the SAME
//      render as connected:true — exactly what the freeze was meant to
//      prevent, just moved to a different edge.
// None of that was caught by a test. These lock in the specific behaviors
// those bugs violated.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { useCast, type CastLoadArgs } from './cast'

const CAST_STATE = {
  NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE',
  NOT_CONNECTED: 'NOT_CONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
} as const

class FakeRemotePlayer implements CastRemotePlayer {
  isConnected = false
  isMediaLoaded = false
  isPaused = false
  canSeek = false
  currentTime = 0
  duration = 0
  playerState: string | null = null
}

class FakeRemotePlayerController implements CastRemotePlayerController {
  listeners = new Map<string, Set<(e: unknown) => void>>()
  player: FakeRemotePlayer
  constructor(player: FakeRemotePlayer) { this.player = player }
  playOrPause() {}
  stop() {}
  seek() {}
  addEventListener(type: string, l: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(l)
  }
  removeEventListener(type: string, l: (e: unknown) => void) {
    this.listeners.get(type)?.delete(l)
  }
  emit(type: string) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l({})
  }
}

// A minimal, behavior-faithful fake of the CAF Sender SDK surface useCast
// touches. `requestSessionImpl` is swappable per test so a test can control
// exactly WHEN the SDK fires CONNECTED relative to requestSession()'s
// promise settling — that is the crux of regression #3 above.
function installFakeSdk() {
  let castState: string = CAST_STATE.NOT_CONNECTED
  let session: CastSessionInstance | null = null
  const ctxListeners = new Map<string, Set<(e: unknown) => void>>()
  let remoteController: FakeRemotePlayerController | null = null

  const fireCtx = (type: string) => {
    for (const l of [...(ctxListeners.get(type) ?? [])]) l({})
  }

  const makeSession = (deviceName = 'Living Room'): CastSessionInstance => ({
    getCastDevice: () => ({ friendlyName: deviceName }),
    loadMedia: vi.fn(async () => undefined),
    getMediaSession: () => ({ idleReason: null }),
    endSession: () => {
      // Real CAF: SESSION_ENDING fires with CastState STILL reading
      // CONNECTED, and only the later SESSION_ENDED actually drops it.
      fireCtx('session_state_changed')
      castState = CAST_STATE.NOT_CONNECTED
      session = null
      fireCtx('session_state_changed')
    },
  })

  let requestSessionImpl = async (): Promise<undefined> => {
    castState = CAST_STATE.CONNECTED
    session = makeSession()
    fireCtx('cast_state_changed')
    return undefined
  }

  const ctx: CastContextInstance = {
    setOptions: () => {},
    getCastState: () => castState,
    requestSession: () => requestSessionImpl(),
    endCurrentSession: () => {},
    getCurrentSession: () => session,
    addEventListener: (type, l) => {
      if (!ctxListeners.has(type)) ctxListeners.set(type, new Set())
      ctxListeners.get(type)!.add(l)
    },
    removeEventListener: (type, l) => { ctxListeners.get(type)?.delete(l) },
  }

  window.cast = {
    framework: {
      CastContext: { getInstance: () => ctx },
      CastContextEventType: { CAST_STATE_CHANGED: 'cast_state_changed', SESSION_STATE_CHANGED: 'session_state_changed' },
      CastState: CAST_STATE,
      SessionState: {
        NO_SESSION: 'NO_SESSION', SESSION_STARTING: 'SESSION_STARTING', SESSION_STARTED: 'SESSION_STARTED',
        SESSION_START_FAILED: 'SESSION_START_FAILED', SESSION_ENDING: 'SESSION_ENDING', SESSION_ENDED: 'SESSION_ENDED',
        SESSION_RESUMED: 'SESSION_RESUMED',
      },
      AutoJoinPolicy: { ORIGIN_SCOPED: 'ORIGIN_SCOPED' },
      RemotePlayer: FakeRemotePlayer as unknown as new () => CastRemotePlayer,
      RemotePlayerController: class extends FakeRemotePlayerController {
        constructor(player: CastRemotePlayer) {
          super(player as unknown as FakeRemotePlayer)
          remoteController = this
        }
      } as unknown as new (player: CastRemotePlayer) => CastRemotePlayerController,
      RemotePlayerEventType: {
        ANY_CHANGE: 'any_change', IS_CONNECTED_CHANGED: 'icc', IS_MEDIA_LOADED_CHANGED: 'imlc',
        IS_PAUSED_CHANGED: 'ipc', CURRENT_TIME_CHANGED: 'ctc', DURATION_CHANGED: 'dc',
        CAN_SEEK_CHANGED: 'csc', PLAYER_STATE_CHANGED: 'psc',
      },
    },
  }

  window.chrome = {
    cast: {
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
        MediaInfo: class {
          contentId: string
          contentType: string
          streamType?: string
          tracks?: CastTrack[]
          metadata?: unknown
          constructor(contentId: string, contentType: string) {
            this.contentId = contentId
            this.contentType = contentType
          }
        } as unknown as new (contentId: string, contentType: string) => CastMediaInfo,
        LoadRequest: class {
          media: CastMediaInfo
          currentTime?: number
          autoplay?: boolean
          activeTrackIds?: number[]
          constructor(media: CastMediaInfo) { this.media = media }
        } as unknown as new (mediaInfo: CastMediaInfo) => CastLoadRequest,
        Track: class {
          trackId: number
          type: string
          subtype?: string
          trackContentId?: string
          trackContentType?: string
          name?: string
          language?: string
          constructor(trackId: number, type: string) {
            this.trackId = trackId
            this.type = type
          }
        } as unknown as new (trackId: number, type: string) => CastTrack,
        TrackType: { TEXT: 'TEXT', AUDIO: 'AUDIO', VIDEO: 'VIDEO' },
        TextTrackType: { SUBTITLES: 'SUBTITLES', CAPTIONS: 'CAPTIONS' },
        StreamType: { BUFFERED: 'BUFFERED', LIVE: 'LIVE', OTHER: 'OTHER' },
      },
    },
  }

  return {
    CAST_STATE,
    fireCastStateChanged: () => fireCtx('cast_state_changed'),
    setCastState: (s: string) => { castState = s },
    getRemotePlayer: () => remoteController?.player ?? null,
    emitRemoteChange: () => remoteController?.emit('any_change'),
    setRequestSessionImpl: (impl: () => Promise<undefined>) => { requestSessionImpl = impl },
    setSession: (s: CastSessionInstance | null) => { session = s },
    makeSession,
    // A transient blip: CastState drops with no session teardown, unlike
    // stop()/endSession() — this is what the debounce exists to survive.
    triggerBlip: () => {
      castState = CAST_STATE.NOT_CONNECTED
      fireCtx('cast_state_changed')
    },
    triggerReconnect: (deviceName?: string) => {
      castState = CAST_STATE.CONNECTED
      if (!session) session = makeSession(deviceName)
      fireCtx('cast_state_changed')
    },
  }
}

function Harness({ currentLoad }: { currentLoad?: () => CastLoadArgs | null }) {
  const cast = useCast(currentLoad ?? (() => null))
  return (
    <div>
      <span data-testid="connected">{String(cast.status.connected)}</span>
      <span data-testid="settling">{String(cast.status.settling)}</span>
      <span data-testid="supported">{String(cast.status.supported)}</span>
      <span data-testid="playerState">{cast.remote.playerState ?? ''}</span>
      <button onClick={() => { void cast.start() }}>start</button>
      <button onClick={() => cast.stop()}>stop</button>
    </div>
  )
}

const connected = () => screen.getByTestId('connected').textContent
const settling = () => screen.getByTestId('settling').textContent
const supported = () => screen.getByTestId('supported').textContent
const playerState = () => screen.getByTestId('playerState').textContent

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as { cast?: unknown }).cast
  delete (window as { chrome?: unknown }).chrome
})

describe('useCast disconnect debounce', () => {
  it('reports supported even when the SDK attaches while not connected (regression #1)', () => {
    installFakeSdk()
    render(<Harness />)
    expect(supported()).toBe('true')
    expect(connected()).toBe('false')
  })

  it('does not report a disconnect if a blip resolves within the grace window', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    expect(connected()).toBe('true')

    act(() => sdk.triggerBlip())
    expect(connected()).toBe('true') // not yet confirmed
    expect(settling()).toBe('true')

    act(() => sdk.triggerReconnect())
    expect(connected()).toBe('true')
    expect(settling()).toBe('false')

    // The stale timer must not still be armed and fire later.
    act(() => { vi.advanceTimersByTime(5000) })
    expect(connected()).toBe('true')
  })

  it('confirms the disconnect once a blip outlasts the grace window', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())

    act(() => sdk.triggerBlip())
    expect(connected()).toBe('true')

    act(() => { vi.advanceTimersByTime(4000) })
    expect(connected()).toBe('false')
    expect(settling()).toBe('false')
  })

  it('stop() is not undone by the stale SESSION_ENDING echo endSession() dispatches (regression #2)', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    expect(connected()).toBe('true')

    act(() => { screen.getByText('stop').click() })

    expect(connected()).toBe('false')
    expect(settling()).toBe('false')
  })

  it('stop() during a pending blip leaves settling cleared, not stuck true', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    act(() => sdk.triggerBlip())
    expect(settling()).toBe('true')

    act(() => { screen.getByText('stop').click() })
    expect(connected()).toBe('false')
    expect(settling()).toBe('false')

    // No timer should still be pending to fire later and misbehave.
    act(() => { vi.advanceTimersByTime(5000) })
    expect(connected()).toBe('false')
    expect(settling()).toBe('false')
  })

  it('start() after stop() is not swallowed by a CONNECTED event fired synchronously inside requestSession() (regression #3)', async () => {
    const sdk = installFakeSdk()
    render(<Harness currentLoad={() => ({
      contentUrl: 'https://example.com/master.m3u8',
      contentType: 'application/x-mpegURL',
    })} />)

    act(() => sdk.triggerReconnect())
    act(() => { screen.getByText('stop').click() })
    expect(connected()).toBe('false')

    // The SDK dispatches CONNECTED as part of establishing the session,
    // before its own promise resolves — i.e. before start()'s `await`
    // continuation gets to run any code.
    sdk.setRequestSessionImpl(async () => {
      sdk.setSession(sdk.makeSession('New Room'))
      sdk.setCastState(sdk.CAST_STATE.CONNECTED)
      sdk.fireCastStateChanged()
      return undefined
    })

    await act(async () => {
      screen.getByText('start').click()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(connected()).toBe('true')
  })

  it('freezes remote during a pending blip and does not eagerly republish a stale snapshot on reconnect (regression #4)', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())

    const player = sdk.getRemotePlayer()!
    player.playerState = 'PLAYING'
    act(() => sdk.emitRemoteChange())
    expect(playerState()).toBe('PLAYING')

    act(() => sdk.triggerBlip())
    // The receiver's RemotePlayer object resets the instant the channel
    // drops — but that reset must not be published while unconfirmed.
    player.playerState = 'IDLE'
    act(() => sdk.emitRemoteChange())
    expect(playerState()).toBe('PLAYING') // still the pre-blip reading, frozen

    // Reconnect lands, but the RemotePlayer's fields haven't caught up to
    // the receiver's real state yet (still show the mid-blip reset) — the
    // fix must NOT eagerly read them at this exact instant.
    act(() => sdk.triggerReconnect())
    expect(connected()).toBe('true')
    expect(settling()).toBe('false')
    expect(playerState()).toBe('PLAYING') // unchanged — no eager resync

    // The receiver's next genuine update is what actually refreshes it.
    player.playerState = 'BUFFERING'
    act(() => sdk.emitRemoteChange())
    expect(playerState()).toBe('BUFFERING')
  })

  it('syncs remote to the disconnected RemotePlayer once a blip is confirmed (not left frozen forever)', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())

    const player = sdk.getRemotePlayer()!
    player.playerState = 'PLAYING'
    act(() => sdk.emitRemoteChange())

    act(() => sdk.triggerBlip())
    player.playerState = 'IDLE'
    act(() => { vi.advanceTimersByTime(4000) })

    expect(connected()).toBe('false')
    expect(playerState()).toBe('IDLE')
  })
})
