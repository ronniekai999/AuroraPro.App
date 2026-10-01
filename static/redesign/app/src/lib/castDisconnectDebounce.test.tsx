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
import { useEffect } from 'react'
import { act, render, screen } from '@testing-library/react'
import { CastMediaLoadError, useCast, type CastLoadArgs } from './cast'

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
  mediaInfo: CastMediaInfo | null = null
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
      // Genuinely asynchronous, matching the real SDK (its whole reason for
      // existing here): SESSION_STATE_CHANGED fires on a later microtask,
      // not synchronously inside this call. That asynchrony is exactly what
      // stoppedRef exists to survive — a fake that fired synchronously would
      // let stop()'s OWN trailing setStatus (the last synchronous write)
      // paper over a missing guard, making the regression test pass whether
      // or not the guard code exists at all.
      queueMicrotask(() => {
        // SESSION_ENDING: CastState STILL reads CONNECTED at this point.
        fireCtx('session_state_changed')
        castState = CAST_STATE.NOT_CONNECTED
        session = null
        // SESSION_ENDED: only now does it actually drop.
        fireCtx('session_state_changed')
      })
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
      // A constructor may return a different object than the one `new`
      // would otherwise produce — used here instead of subclassing so the
      // created controller can be captured for the test helpers below
      // without aliasing `this`.
      RemotePlayerController: function (player: CastRemotePlayer) {
        const controller = new FakeRemotePlayerController(player as unknown as FakeRemotePlayer)
        remoteController = controller
        return controller
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

// Captured on every render so tests can call start()/stop() directly and
// `await` their full internal promise chain, rather than firing a DOM click
// and guessing how many ticks its async work needs — that guesswork is what
// let a real network call and a dangling post-test promise slip through
// undetected (2026-08 review fix).
let latestCast: ReturnType<typeof useCast> | null = null

function Harness({ currentLoad }: { currentLoad?: () => CastLoadArgs | null }) {
  const cast = useCast(currentLoad ?? (() => null))
  // Captured after render (not during it — an in-render assignment to a
  // module-level variable is a side effect React's rules disallow), so
  // tests always read the latest hook instance from the last commit.
  useEffect(() => { latestCast = cast })
  return (
    <div>
      <span data-testid="connected">{String(cast.status.connected)}</span>
      <span data-testid="settling">{String(cast.status.settling)}</span>
      <span data-testid="supported">{String(cast.status.supported)}</span>
      <span data-testid="playerState">{cast.remote.playerState ?? ''}</span>
      <span data-testid="updateSeq">{cast.remote.updateSeq}</span>
      <button onClick={() => cast.stop()}>stop</button>
    </div>
  )
}

const connected = () => screen.getByTestId('connected').textContent
const settling = () => screen.getByTestId('settling').textContent
const supported = () => screen.getByTestId('supported').textContent
const playerState = () => screen.getByTestId('playerState').textContent
const updateSeq = () => Number(screen.getByTestId('updateSeq').textContent)

// Lets any pending queueMicrotask (endSession's deferred SESSION_STATE_CHANGED
// echo) resolve and apply its state updates before the test asserts or ends —
// required so a test never leaves a promise dangling into the next one.
const flush = () => act(async () => {
  await Promise.resolve()
  await Promise.resolve()
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  // loadCurrent()'s URL self-test calls fetch(); stub it so tests never make
  // a real network request (slow, flaky, and unavailable in sandboxed CI).
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/vnd.apple.mpegurl' },
    text: async () => '#EXTM3U',
  })))
})
afterEach(async () => {
  await flush()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (window as { cast?: unknown }).cast
  delete (window as { chrome?: unknown }).chrome
  latestCast = null
})

describe('useCast receiver LOAD outcome contract', () => {
  const load: CastLoadArgs = { contentUrl: 'https://example.com/attempt.m3u8?token=cast', contentType: 'application/x-mpegURL' }
  it('identifies only an actual receiver LOAD rejection with the attempted content ID', async () => {
    const sdk = installFakeSdk()
    const session = sdk.makeSession()
    session.loadMedia = vi.fn(async () => { throw { code: 'load_failed' } })
    sdk.setSession(session)
    render(<Harness currentLoad={() => load} />)
    act(() => sdk.triggerReconnect())
    let error: unknown
    await act(async () => {
      try { await latestCast!.loadCurrent() } catch (e) { error = e }
    })
    expect(error).toBeInstanceOf(CastMediaLoadError)
    expect((error as CastMediaLoadError).contentId).toBe(load.contentUrl)
    expect(session.loadMedia).toHaveBeenCalledOnce()
    expect(connected()).toBe('true')
  })
  it('keeps token and missing-session failures distinct from receiver LOAD failures', async () => {
    const sdk = installFakeSdk()
    const session = sdk.makeSession()
    sdk.setSession(session)
    const mintError = new Error('token mint failed')
    render(<Harness currentLoad={() => { throw mintError }} />)
    act(() => sdk.triggerReconnect())
    let error: unknown
    await act(async () => {
      try { await latestCast!.loadCurrent() } catch (e) { error = e }
    })
    expect(error).toBe(mintError)
    expect(error).not.toBeInstanceOf(CastMediaLoadError)
    expect(session.loadMedia).not.toHaveBeenCalled()
    sdk.setSession(null)
    await act(async () => {
      try { await latestCast!.loadCurrent() } catch (e) { error = e }
    })
    expect((error as Error).message).toBe('cast session not established')
    expect(error).not.toBeInstanceOf(CastMediaLoadError)
  })
  it('samples receiver identity atomically with the idle reason and tolerates missing fields', () => {
    const sdk = installFakeSdk()
    const session = sdk.makeSession()
    const media: CastMediaInfo = { contentId: 'https://example.com/failed.m3u8', contentType: 'application/x-mpegURL' }
    session.getMediaSession = () => ({ idleReason: 'ERROR', media })
    sdk.setSession(session)
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    const player = sdk.getRemotePlayer()!
    player.playerState = 'IDLE'
    act(() => sdk.emitRemoteChange())
    expect(latestCast!.remote).toMatchObject({ contentId: media.contentId, playerState: 'IDLE', idleReason: 'ERROR' })
    session.getMediaSession = () => ({ idleReason: null })
    player.mediaInfo = { ...media, contentId: 'https://example.com/player-info.m3u8' }
    act(() => sdk.emitRemoteChange())
    expect(latestCast!.remote.contentId).toBe(player.mediaInfo.contentId)
    player.mediaInfo = null
    act(() => sdk.emitRemoteChange())
    expect(latestCast!.remote.contentId).toBeNull()
  })
})

describe('useCast disconnect debounce', () => {
  it.each([
    ['ts', 'TS', 'MPEG2_TS'],
    ['fmp4', 'FMP4', 'FMP4'],
  ] as const)('passes the declared %s container through the SDK load', async (segmentFormat, audioFormat, videoFormat) => {
    const sdk = installFakeSdk()
    const session = sdk.makeSession()
    sdk.setSession(session)
    sdk.setCastState(sdk.CAST_STATE.CONNECTED)
    render(<Harness currentLoad={() => ({
      contentUrl: 'https://example.com/master.m3u8',
      contentType: 'application/x-mpegURL',
      segmentFormat,
    })} />)
    await act(async () => { await latestCast!.loadCurrent() })
    expect(session.loadMedia).toHaveBeenCalledWith(expect.objectContaining({
      media: expect.objectContaining({ hlsSegmentFormat: audioFormat, hlsVideoSegmentFormat: videoFormat }),
    }))
  })

  it('keeps receiver metadata available after an SDK reconnect', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    const player = sdk.getRemotePlayer()! as FakeRemotePlayer & { title: string }
    player.title = 'A running movie'
    act(() => sdk.emitRemoteChange())
    expect(latestCast!.remote.title).toBe('A running movie')
  })

  // Must match cast.ts's private RECONNECT_SETTLE_MS — how long settling
  // stays true after a reconnect before `remote` is trusted again.
  const RECONNECT_SETTLE_MS = 1500

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
    expect(settling()).toBe('false')

    act(() => sdk.triggerBlip())
    expect(connected()).toBe('true') // not yet confirmed
    expect(settling()).toBe('true')

    act(() => sdk.triggerReconnect())
    expect(connected()).toBe('true')
    // remote hasn't necessarily been resynced yet — still settling until the
    // fixed settle window elapses (see regression #4 below for why this
    // isn't event-driven).
    expect(settling()).toBe('true')

    act(() => { vi.advanceTimersByTime(RECONNECT_SETTLE_MS) })
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

  it('stop() is not undone by the stale SESSION_ENDING echo endSession() dispatches (regression #2)', async () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    expect(connected()).toBe('true')

    act(() => { screen.getByText('stop').click() })
    // stop()'s own synchronous write already reports the disconnect...
    expect(connected()).toBe('false')
    expect(settling()).toBe('false')

    // ...and the deferred SESSION_ENDING/SESSION_ENDED echo arriving after
    // must not undo it (this is the actual behavior under test — without
    // stoppedRef, the SESSION_ENDING echo's stale CONNECTED reading
    // resurrects connected:true here).
    await flush()
    expect(connected()).toBe('false')
    expect(settling()).toBe('false')
  })

  it('stop() during a pending blip leaves settling cleared, not stuck true', async () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    act(() => sdk.triggerBlip())
    expect(settling()).toBe('true')

    act(() => { screen.getByText('stop').click() })
    expect(connected()).toBe('false')
    expect(settling()).toBe('false')

    // No timer, and no deferred echo, should still be pending to fire later
    // and misbehave.
    await flush()
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
    // Let the old session's own teardown echo fully resolve before starting
    // a new one below — otherwise its deferred callback (closed over the
    // OLD session/castState) would land mid-way through the new start()
    // flow and corrupt it, which is a fake-SDK artifact, not something the
    // real SDK — or the code under test — would ever produce.
    await flush()

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
      await latestCast!.start()
    })

    expect(connected()).toBe('true')
  })

  it('does not eagerly read remote at the reconnect edge, but the freeze lifts immediately after (regression #4)', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())

    const player = sdk.getRemotePlayer()!
    player.playerState = 'PLAYING'
    act(() => sdk.emitRemoteChange())
    expect(playerState()).toBe('PLAYING')
    expect(settling()).toBe('false')
    const seqBeforeBlip = updateSeq()

    act(() => sdk.triggerBlip())
    expect(settling()).toBe('true')
    // The receiver's RemotePlayer object resets the instant the channel
    // drops — but that reset must not be published while unconfirmed, and
    // updateSeq (what VideoPlayer's auto-advance effect relies on to know a
    // reading is genuinely fresh — see cast.ts) must not advance either.
    player.playerState = 'IDLE'
    act(() => sdk.emitRemoteChange())
    expect(playerState()).toBe('PLAYING') // still the pre-blip reading, frozen
    expect(updateSeq()).toBe(seqBeforeBlip)

    // Reconnect lands. The fix must NOT eagerly read the RemotePlayer's
    // fields at this exact instant — they can still hold a not-yet-caught-up
    // snapshot from the disconnect.
    act(() => sdk.triggerReconnect())
    expect(connected()).toBe('true')
    expect(playerState()).toBe('PLAYING') // unchanged — no eager resync
    expect(updateSeq()).toBe(seqBeforeBlip)

    // But the freeze itself lifts immediately (disconnectTimerRef clears at
    // reconnect) — ordinary ANY_CHANGE events flow through normally again
    // from here, independent of settling (see the next two tests for why
    // settling clearing is NOT tied to this event) — and updateSeq advances
    // right along with it, even though settling is still true. This is the
    // exact case VideoPlayer's confirmation check exists for: a seq bump
    // alone, while still settling, is NOT enough to trust the reading.
    player.playerState = 'BUFFERING'
    act(() => sdk.emitRemoteChange())
    expect(playerState()).toBe('BUFFERING')
    expect(updateSeq()).toBe(seqBeforeBlip + 1)
  })

  it('keeps settling true for a fixed window after reconnect regardless of ANY_CHANGE timing, then clears it', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    act(() => sdk.triggerBlip())
    expect(settling()).toBe('true')

    act(() => sdk.triggerReconnect())
    expect(settling()).toBe('true') // not cleared by the reconnect itself

    // An ANY_CHANGE arriving during the settle window must not clear it
    // early — settling is a fixed timer, not event-driven, specifically so
    // a not-yet-caught-up event can't be mistaken for the real resync.
    const player = sdk.getRemotePlayer()!
    player.playerState = 'BUFFERING'
    act(() => sdk.emitRemoteChange())
    expect(settling()).toBe('true')

    act(() => { vi.advanceTimersByTime(RECONNECT_SETTLE_MS - 1) })
    expect(settling()).toBe('true')
    act(() => { vi.advanceTimersByTime(1) })
    expect(settling()).toBe('false')
  })

  it('clears settling via the fixed timer even if the receiver sends no further ANY_CHANGE at all (no unbounded wait)', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    act(() => sdk.triggerBlip())
    expect(settling()).toBe('true')

    // Reconnect lands, but the receiver stays static (e.g. genuinely
    // paused) and never fires another ANY_CHANGE — settling must still
    // resolve, not stay stuck true forever disabling party sync.
    act(() => sdk.triggerReconnect())
    expect(settling()).toBe('true')

    act(() => { vi.advanceTimersByTime(RECONNECT_SETTLE_MS) })
    expect(settling()).toBe('false')
  })

  it('the settle timer never bumps updateSeq itself — settling clearing is not, on its own, a confirmed update', () => {
    // VideoPlayer's auto-advance effect (and the two party polling loops)
    // snapshot updateSeq the instant settling clears and refuse to act
    // until it advances PAST that snapshot — the whole point being that
    // clearing settling on the fixed timer alone must NOT count as
    // confirmation. If a future change made the settle timer call
    // onRemoteChange() (the natural-looking symmetric counterpart of the
    // call already in the confirmed-disconnect timer), it would satisfy
    // every one of those checks with the exact stale reading they exist to
    // distrust, silently undoing this fix. This test exists to catch that.
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    const player = sdk.getRemotePlayer()!
    player.playerState = 'PLAYING'
    act(() => sdk.emitRemoteChange())
    const seqBeforeBlip = updateSeq()

    act(() => sdk.triggerBlip())
    act(() => sdk.triggerReconnect())
    expect(settling()).toBe('true')
    expect(updateSeq()).toBe(seqBeforeBlip) // no update has landed since reconnect

    act(() => { vi.advanceTimersByTime(RECONNECT_SETTLE_MS) })
    expect(settling()).toBe('false')
    expect(updateSeq()).toBe(seqBeforeBlip) // the timer firing did not bump it
  })

  it('clears a pending settle timer when a second blip starts, instead of letting it fire mid-blip', () => {
    const sdk = installFakeSdk()
    render(<Harness />)
    act(() => sdk.triggerReconnect())
    act(() => sdk.triggerBlip())
    act(() => sdk.triggerReconnect()) // arms a settle timer due 1500ms from now
    expect(settling()).toBe('true')

    act(() => { vi.advanceTimersByTime(500) })
    act(() => sdk.triggerBlip()) // a second, unrelated blip starts
    expect(settling()).toBe('true')

    // The FIRST settle timer would fire here (500ms + 1000ms = 1500ms since
    // it was armed) if the second blip hadn't cleared it — that would
    // incorrectly clear settling while genuinely mid-disconnect again.
    act(() => { vi.advanceTimersByTime(1000) })
    expect(settling()).toBe('true')
    expect(connected()).toBe('true') // still within the second blip's own grace window

    // The second blip's OWN disconnect-confirm timer (a fresh
    // CAST_DISCONNECT_GRACE_MS from when it started) is what actually
    // resolves this.
    act(() => { vi.advanceTimersByTime(3000) }) // 4000ms total since the 2nd blip
    expect(connected()).toBe('false')
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
