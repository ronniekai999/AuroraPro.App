// @vitest-environment jsdom
// Keep useCast real: volume/mute events may only resample a cached Media.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer, type PartySync, type PlayTarget } from './VideoPlayer'
import { createCastToken, createDirectCastToken, createSession, getStreamInfo } from '@/lib/streaming'
import { reportProgress } from '@/lib/api'
const fake = vi.hoisted(() => ({
  hls: [] as Array<{ emit: (name: string, data?: unknown) => void }>,
}))
vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => true
    static Events = new Proxy({}, { get: (_target, name) => name })
    static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' }
    static ErrorDetails = { BUFFER_STALLED_ERROR: 'bufferStalledError' }
    handlers = new Map<string, Array<(name: string, data: unknown) => void>>()
    levels = []; currentLevel = 0; subtitleTrack = -1; bandwidthEstimate = 8000000
    constructor() { fake.hls.push(this) }
    on(name: string, callback: (name: string, data: unknown) => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], callback]) }
    emit(name: string, data: unknown = {}) { this.handlers.get(name)?.forEach(fn => fn(name, data)) }
    loadSource() {} attachMedia() {} startLoad() {} stopLoad() {} recoverMediaError() {} swapAudioCodec() {}
    destroy() { this.handlers.clear() }
  }
  return { default: FakeHls }
})

describe('Real player serialization with repeated cast URLs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as { cast?: unknown }).cast
    delete (window as { chrome?: unknown }).chrome
  })
  it.each(['heartbeat', 'relative', 'FINISHED'].flatMap(surface => ['cached', 'genuine old status', 'retired older generation', 'new session id', 'new Media instance'].map(evidence => ({ surface, evidence }))))(
    'requires the second LOAD generation for $surface with $evidence', async ({ surface, evidence }) => {
      const sdk = installFakeSdk()
      const session = sdk.makeSession()
      const uri = 'http://localhost:3000/api/stream/direct/media/10?token=same-second-cast-token'
      const newObject = evidence === 'new Media instance'
      const makeMedia = (position: number, id?: number) => {
        const listeners = new Set<(alive: boolean) => void>()
        const media: CastMediaSession & { mediaSessionId?: number } = {
          mediaSessionId: id, media: { contentId: uri, contentType: 'video/mp4' }, playerState: 'PAUSED', currentTime: position,
          getEstimatedTime() { return this.currentTime! },
          addUpdateListener: listener => { listeners.add(listener) }, removeUpdateListener: listener => { listeners.delete(listener) },
        }
        return { media, publish: (alive = true) => { for (const listener of [...listeners]) listener(alive) } }
      }
      let current = makeMedia(600, newObject ? undefined : 1)
      const retiredMedia = current
      // CAF's public getter excludes media once idleReason is present;
      // the watched Media delivers its terminal update through its listener.
      session.getMediaSession = () => current.media.idleReason ? null : current.media
      sdk.setRequestSessionImpl(async () => { sdk.setSession(session); sdk.triggerReconnect(); return undefined })
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200, headers: { 'Content-Type': 'video/mp4' } })))
      vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
      vi.mocked(createDirectCastToken).mockResolvedValue({ url: uri, token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })
      let acknowledge!: () => void
      const firstACK = new Promise<void>(resolve => { acknowledge = resolve })
      vi.mocked(session.loadMedia).mockImplementationOnce(async request => {
        expect(request.currentTime).toBe(600)
        current = makeMedia(600, newObject ? undefined : 2)
        Object.assign(sdk.getRemotePlayer()!, { isConnected: true, isMediaLoaded: true, mediaInfo: current.media.media, playerState: 'PAUSED', isPaused: true, currentTime: 600, canSeek: true })
        sdk.emitRemoteChange('playerState', 'PAUSED')
        await firstACK
      }).mockImplementationOnce(async request => {
        expect(request.currentTime).toBe(800); expect(request.media.contentId).toBe(uri)
        if (evidence === 'retired older generation') {
          current = makeMedia(800, 3)
          sdk.emitRemoteChange('currentTime', 800)
        } else if (evidence === 'new session id') {
          current.media.mediaSessionId = 3
          current.media.currentTime = 800
          current.publish()
        } else if (newObject) {
          current = makeMedia(800)
          sdk.emitRemoteChange('currentTime', 800)
        } else if (evidence === 'genuine old status') {
          // A receiver status about the old playback is genuine, but its
          // unchanged mediaSessionId cannot make it the newly loaded media.
          current.publish()
        }
      })
      const oldTarget = { ...movie, resumePositionMs: 600000 }
      const newTarget = { ...movie, resumePositionMs: 800000 }
      const seek = vi.fn(); const ended = vi.fn(() => false)
      const element = (selected = oldTarget, profileId = 7) => <VideoPlayer target={selected} profileId={profileId} onClose={() => {}} onSeekRebuild={seek} onEnded={ended} />
      const view = render(element()); await settle()
      const cast = screen.getByRole('button', { name: 'Cast' })
      fireEvent.click(cast); fireEvent.click(cast); await settle()
      expect(session.loadMedia).toHaveBeenCalledTimes(1)
      view.rerender(element(newTarget, 9)); await settle()
      fireEvent.canPlay(document.querySelector('video')!); await settle()
      await act(async () => { acknowledge() }); await settle()
      expect(session.loadMedia).toHaveBeenCalledTimes(2)
      if (evidence === 'retired older generation') {
        // After generations1→2→3, a late snapshot from1 is not incoming
        // merely because it differs from the immediately outgoing2.
        current = retiredMedia
        await act(async () => { sdk.emitRemoteChange() }); await settle()
      }
      const valid = evidence === 'new session id' || newObject
      if (surface === 'heartbeat') {
        await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
        if (valid) expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 800000, profile_id: 9 }), expect.any(AbortSignal))
        else expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ profile_id: 9 }), expect.anything())
      } else if (surface === 'relative') {
        fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
        const controller = sdk.getRemoteController()!
        controller.seek.mockClear()
        fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
        if (valid) { expect(controller.seek).toHaveBeenCalledOnce(); expect(sdk.getRemotePlayer()!.currentTime).toBe(810) }
        else expect(controller.seek).not.toHaveBeenCalled()
        expect(seek).not.toHaveBeenCalled()
      } else {
        await act(async () => { vi.advanceTimersByTime(3000) }); await settle()
        vi.mocked(reportProgress).mockClear()
        Object.assign(current.media, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0 })
        Object.assign(sdk.getRemotePlayer()!, { playerState: 'IDLE', isMediaLoaded: false, currentTime: 0 })
        await act(async () => { current.publish(false); sdk.emitRemoteChange('playerState', 'IDLE') }); await settle()
        if (valid) {
          expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000, profile_id: 9 }), expect.any(AbortSignal))
          expect(ended).toHaveBeenCalledOnce()
        } else {
          expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000, profile_id: 9 }), expect.anything())
          expect(ended).not.toHaveBeenCalled()
        }
        expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000, profile_id: 7 }), expect.anything())
      }
    },
  )
})
vi.mock('@/lib/streaming', async original => ({
  ...await original<typeof import('@/lib/streaming')>(),
  getStreamInfo: vi.fn(), createSession: vi.fn(), deleteSession: vi.fn(async () => {}), keepalive: vi.fn(async () => 'ok'),
  createCastToken: vi.fn(async () => ({ playlist: '/api/stream/cast/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: 100 })),
  createDirectCastToken: vi.fn(async () => ({ url: '/api/stream/direct/media/10?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })),
}))
vi.mock('@/lib/api', async original => ({
  ...await original<typeof import('@/lib/api')>(), reportProgress: vi.fn(async () => {}), markWatched: vi.fn(async () => ({})),
}))
vi.mock('@/lib/prewarm', () => ({ prewarmEnabled: () => false, takeWarmedSession: () => null }))
vi.mock('@/lib/playbackQoE', () => ({ attachPlaybackQoE: () => new Proxy({}, { get: (_target, name) => name === 'isFinished' ? () => false : () => {} }) }))
const movie: PlayTarget = { mediaItemId: 1, fileId: 10, fileType: 'media', title: 'Movie' }
function info(decision: 'transcode' | 'direct_play' = 'transcode', duration = 1000000) {
  return { stream: { decision, stream_url: '/file.mp4', duration_ms: duration, video_codec: 'h264', audio_codec: 'aac', audio_codec_out: 'aac', container: 'mp4', resolution: '1920x1080', width: 1920, height: 1080 }, audio_tracks: [{ index: 0, title: 'English', codec: 'aac' }, { index: 1, title: 'French', codec: 'aac' }], subtitles: [], markers: [] }
}
const paused = new WeakMap<HTMLMediaElement, boolean>()
const play = vi.fn(function(this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve() })
async function settle() { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }) }
async function bootHls() { await settle(); await act(async () => { fake.hls.at(-1)!.emit('MANIFEST_PARSED') }); await settle() }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.clearAllMocks(); fake.hls.length = 0; localStorage.clear()
  // Reset one-shot responses too: a failed adversarial case must not change
  // the delivery contract used by later independently mounted players.
  vi.mocked(createCastToken).mockReset().mockResolvedValue({ playlist: '/api/stream/cast/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: 100 })
  vi.mocked(createDirectCastToken).mockReset().mockResolvedValue({ url: '/api/stream/direct/media/10?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })
  vi.mocked(getStreamInfo).mockReset().mockResolvedValue(info() as Awaited<ReturnType<typeof getStreamInfo>>)
  vi.mocked(createSession).mockReset().mockImplementation(async request => ({ session_id: `session-${fake.hls.length}`, master_playlist: '/api/stream/session/master.m3u8', start_sec: request.start_sec ?? 0 } as Awaited<ReturnType<typeof createSession>>))
  vi.mocked(reportProgress).mockReset().mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) { paused.set(this, true); this.dispatchEvent(new Event('pause')) })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function(this: HTMLMediaElement) { this.currentTime = 0 })
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('')
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function(this: HTMLMediaElement) { return paused.get(this) ?? true })
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })


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
  volumeLevel = 1
  isMuted = false
}

class FakeRemotePlayerController implements CastRemotePlayerController {
  listeners = new Map<string, Set<(e: unknown) => void>>()
  player: FakeRemotePlayer
  constructor(player: FakeRemotePlayer) { this.player = player }
  playOrPause = vi.fn()
  stop = vi.fn()
  seek = vi.fn()
  addEventListener(type: string, l: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(l)
  }
  removeEventListener(type: string, l: (e: unknown) => void) {
    this.listeners.get(type)?.delete(l)
  }
  emit(type: string, event: unknown = {}) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event)
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
    getMediaSession: () => ({
      idleReason: null,
      media: remoteController?.player.mediaInfo ?? { contentId: 'https://example.com/current.mp4', contentType: 'video/mp4' },
      playerState: remoteController?.player.playerState ?? null,
      currentTime: remoteController?.player.currentTime,
    }),
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
    getRemoteController: () => remoteController,
    emitRemoteChange: (field = 'currentTime', value?: unknown) => remoteController?.emit('any_change', { field, value }),
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


describe('Sixth independent actual SDK cached Media after a rejected LOAD', () => {
  const token = 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x'
  const oldURL = 'http://localhost:3000/api/stream/hls/cached-old/master.m3u8?token=cast'
  const failedURL = 'http://localhost:3000/api/stream/hls/cached-failed/master.m3u8?token=cast'
  const target = { ...movie, resumePositionMs: 600000 }
  async function rejectedLoadWithCachedMedia({ armEnd = false, mintFailure = false, statusBeforeReject = false, statusApi = true, settleAfterFailure = true, party }: {
    armEnd?: boolean; mintFailure?: boolean; statusBeforeReject?: boolean; statusApi?: boolean; settleAfterFailure?: boolean; party?: PartySync
  } = {}) {
    const sdk = installFakeSdk()
    const session = sdk.makeSession()
    // getMediaSession() returns the cached chrome.cast.media.Media object.
    // A receiver LOAD timeout does not itself deliver a MEDIA_STATUS update.
    const mediaListeners = new Set<(alive: boolean) => void>()
    const cachedMedia: CastMediaSession & { mediaSessionId: number } = {
      mediaSessionId: 1,
      media: { contentId: oldURL, contentType: 'application/x-mpegURL' }, playerState: 'PAUSED', currentTime: 500, idleReason: null,
      ...(statusApi ? {
        addUpdateListener: (listener: (alive: boolean) => void) => { mediaListeners.add(listener) },
        removeUpdateListener: (listener: (alive: boolean) => void) => { mediaListeners.delete(listener) },
      } : {}),
    }
    const publishMediaStatus = (alive = true) => { for (const listener of [...mediaListeners]) listener(alive) }
    cachedMedia.getEstimatedTime = vi.fn(function(this: CastMediaSession) { expect(this).toBe(cachedMedia); return this.currentTime! })
    session.getMediaSession = vi.fn(() => cachedMedia.idleReason ? null : cachedMedia)
    sdk.setRequestSessionImpl(async () => { sdk.setSession(session); sdk.triggerReconnect(); return undefined })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('#EXTM3U', { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })))
    vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: oldURL, token, expires_at: 1, start_sec: 100 })
    vi.mocked(session.loadMedia).mockImplementationOnce(async () => {
      cachedMedia.mediaSessionId = 2
      if (armEnd) cachedMedia.playerState = 'PLAYING'
      const player = sdk.getRemotePlayer()!
      Object.assign(player, { isConnected: true, isMediaLoaded: true, mediaInfo: cachedMedia.media, currentTime: 500, playerState: cachedMedia.playerState, isPaused: !armEnd, canSeek: true })
      sdk.emitRemoteChange()
    })
    const seek = vi.fn(); const ended = vi.fn(() => false); const close = vi.fn()
    const element = (selected: PlayTarget | null = target, profileId = 7) => <VideoPlayer target={selected} profileId={profileId} party={party} onClose={close} onSeekRebuild={seek} onEnded={ended} />
    const view = render(element()); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    await act(async () => { vi.advanceTimersByTime(3000) }); await settle()
    if (armEnd) {
      cachedMedia.playerState = 'PAUSED'
      Object.assign(sdk.getRemotePlayer()!, { playerState: 'PAUSED', isPaused: true })
      await act(async () => { sdk.emitRemoteChange() }); await settle()
    }
    if (mintFailure) vi.mocked(createCastToken).mockRejectedValueOnce(new Error('token mint failed before LOAD'))
    else vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: failedURL, token, expires_at: 9999999999, start_sec: 580 })
    if (!mintFailure) vi.mocked(session.loadMedia).mockImplementationOnce(async () => {
      // A callback before the rejection must be included in the SDK error's
      // watermark even if React has not rendered its setRemote update yet.
      if (statusBeforeReject) publishMediaStatus()
      throw { code: 'timeout', description: 'LOAD reached receiver but timed out before acknowledgement' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(mintFailure ? 1 : 2)
    if (!mintFailure) expect(vi.mocked(session.loadMedia).mock.calls[1][0].currentTime).toBe(20)
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: 600000, profile_id: 7 }), expect.any(AbortSignal))
    vi.mocked(reportProgress).mockClear(); seek.mockClear()
    if (settleAfterFailure) { await act(async () => { vi.advanceTimersByTime(3000) }); await settle() }
    const player = sdk.getRemotePlayer()!
    return { sdk, session, cachedMedia, player, seek, ended, close, element, view, publishMediaStatus, mediaListeners }
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as { cast?: unknown }).cast
    delete (window as { chrome?: unknown }).chrome
  })
  it.each([false, true])('keeps outgoing receiver heartbeats after local playback fails and Back=%s', async back => {
    const { cachedMedia, view, element, close, publishMediaStatus } = await rejectedLoadWithCachedMedia()
    cachedMedia.currentTime = 510
    await act(async () => { publishMediaStatus() }); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    close.mockImplementation(() => view.rerender(element(null, 9)))
    vi.mocked(getStreamInfo).mockRejectedValueOnce(new Error('Local media unavailable while TV keeps playing'))
    view.rerender(element({ ...target, audioTrackIndex: 1 })); await settle()
    expect(screen.getByText('Playback Error')).toBeInTheDocument()
    if (back) {
      fireEvent.click(screen.getByRole('button', { name: 'Back' })); await settle()
      expect(close).toHaveBeenCalledOnce()
    }
    vi.mocked(reportProgress).mockClear()
    cachedMedia.currentTime = 610
    await act(async () => { publishMediaStatus() }); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledOnce()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 710000, profile_id: 7 }), expect.any(AbortSignal))
    expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ profile_id: 9 }), expect.anything())
  })
  it('keeps saving the acknowledged TV clock and profile across navigation that clears the local target', async () => {
    const { cachedMedia, view, element, publishMediaStatus } = await rejectedLoadWithCachedMedia()
    cachedMedia.currentTime = 510
    await act(async () => { publishMediaStatus() }); await settle()
    view.rerender(element(null, 9)); await settle()
    expect(document.querySelector('video')).toBeNull()
    vi.mocked(reportProgress).mockClear()
    for (const currentTime of [610, 620]) {
      cachedMedia.currentTime = currentTime
      await act(async () => { publishMediaStatus() }); await settle()
      await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    }
    expect(vi.mocked(reportProgress).mock.calls.map(([id, body]) => [id, body.position_ms, body.profile_id])).toEqual([
      [1, 710000, 7], [1, 720000, 7],
    ])
  })
  it.each([false, true])('declines a resumed receiver with unknown acknowledged context when local target is absent=%s', async absent => {
    const sdk = installFakeSdk()
    const session = sdk.makeSession()
    const media: CastMediaSession = {
      media: { contentId: oldURL, contentType: 'application/x-mpegURL' }, playerState: 'PLAYING', currentTime: 610,
      getEstimatedTime() { return this.currentTime! },
    }
    session.getMediaSession = () => media
    sdk.setSession(session); sdk.triggerReconnect()
    const view = render(<VideoPlayer target={absent ? null : target} profileId={9} onClose={() => {}} />)
    await settle()
    Object.assign(sdk.getRemotePlayer()!, { isConnected: true, isMediaLoaded: true, currentTime: 610, playerState: 'PLAYING', isPaused: false, mediaInfo: media.media })
    await act(async () => { sdk.emitRemoteChange() }); await settle()
    await act(async () => { vi.advanceTimersByTime(20000) }); await settle()
    expect(session.loadMedia).not.toHaveBeenCalled()
    expect(reportProgress).not.toHaveBeenCalled()
    view.unmount()
  })
  it('does not restore relative seeks when only volume republishes the cached outgoing Media object', async () => {
    const { sdk, cachedMedia, seek } = await rejectedLoadWithCachedMedia()
    vi.mocked(cachedMedia.getEstimatedTime!).mockClear()
    // The SDK emits ANY_CHANGE for volume; no MEDIA_STATUS has refreshed
    // the outgoing Media object since the rejected LOAD.
    sdk.getRemotePlayer()!.volumeLevel = 0.5
    await act(async () => { sdk.emitRemoteChange('volumeLevel', 0.5) }); await settle()
    expect(cachedMedia.getEstimatedTime).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(seek).not.toHaveBeenCalled()
  })
  it('does not restore heartbeat writes when only mute republishes the cached outgoing Media object', async () => {
    const { sdk } = await rejectedLoadWithCachedMedia()
    sdk.getRemotePlayer()!.isMuted = true
    await act(async () => { sdk.emitRemoteChange('isMuted', true) }); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
  })
  it('declines a genuine status that arrived before the receiver LOAD rejection rather than after it', async () => {
    const { sdk, seek } = await rejectedLoadWithCachedMedia({ statusBeforeReject: true })
    await act(async () => { sdk.emitRemoteChange('volumeLevel', 0.5) }); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(seek).not.toHaveBeenCalled()
  })
  it('keeps recovery suspended when the SDK Media has no update-listener API', async () => {
    const { sdk, cachedMedia, seek } = await rejectedLoadWithCachedMedia({ statusApi: false })
    cachedMedia.currentTime = 510
    sdk.getRemotePlayer()!.currentTime = 510
    await act(async () => { sdk.emitRemoteChange('currentTime', 510) }); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(seek).not.toHaveBeenCalled()
  })
  it('does not recover from a Media callback that says the media is no longer alive', async () => {
    const { sdk, cachedMedia, seek, publishMediaStatus } = await rejectedLoadWithCachedMedia()
    cachedMedia.currentTime = 510
    await act(async () => { publishMediaStatus(false); sdk.emitRemoteChange('volumeLevel', 0.5) }); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(seek).not.toHaveBeenCalled()
  })
  it('does not use volume-only cached healthy proof to accept a delayed outgoing FINISHED after retarget', async () => {
    const { sdk, cachedMedia, view, element, ended, player } = await rejectedLoadWithCachedMedia({ armEnd: true })
    player.volumeLevel = 0.5
    await act(async () => { sdk.emitRemoteChange('volumeLevel', 0.5) }); await settle()
    const next = { ...target, mediaItemId: 2, fileId: 20, title: 'Other title' }
    view.rerender(element(next, 9)); await bootHls()
    Object.assign(cachedMedia, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0 })
    Object.assign(player, { playerState: 'IDLE', isMediaLoaded: false, currentTime: 0 })
    await act(async () => { sdk.emitRemoteChange() }); await settle()
    expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000 }), expect.anything())
    expect(ended).not.toHaveBeenCalled()
  })
  it('preserves the barrier while the cached outgoing Media receives no post-failure event', async () => {
    const { seek } = await rejectedLoadWithCachedMedia()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(seek).not.toHaveBeenCalled()
  })
  it('preserves a coherent cached outgoing clock after preflight failure because receiver LOAD never ran', async () => {
    const { sdk } = await rejectedLoadWithCachedMedia({ mintFailure: true })
    sdk.getRemotePlayer()!.volumeLevel = 0.5
    await act(async () => { sdk.emitRemoteChange('volumeLevel', 0.5) }); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 600000, profile_id: 7 }), expect.any(AbortSignal))
  })
  it('uses a genuinely updated coherent old Media clock when the acknowledged outgoing media survives', async () => {
    const { sdk, session, cachedMedia, seek, publishMediaStatus } = await rejectedLoadWithCachedMedia()
    cachedMedia.currentTime = 510
    sdk.getRemotePlayer()!.currentTime = 510
    await act(async () => { publishMediaStatus() }); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 610000, profile_id: 7 }), expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    seek.mockClear(); vi.mocked(session.loadMedia).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    // This fixture's replacement mint is anchored at 100. Either supported
    // seek route must take exactly one action at absolute source second 620.
    expect([
      ...seek.mock.calls.map(([absoluteSec]) => absoluteSec),
      ...vi.mocked(session.loadMedia).mock.calls.map(([request]) => (request.currentTime ?? 0) + 100),
    ]).toEqual([620])
  })
  it('completes a quiet genuine FINISHED after healthy PAUSED recovery during LOAD settlement', async () => {
    const { cachedMedia, player, ended, publishMediaStatus } = await rejectedLoadWithCachedMedia({ settleAfterFailure: false })
    await act(async () => { publishMediaStatus() }); await settle()
    Object.assign(cachedMedia, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0 })
    Object.assign(player, { playerState: 'IDLE', isMediaLoaded: false })
    await act(async () => { publishMediaStatus(false) }); await settle()
    expect(ended).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(3000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000, profile_id: 7 }), expect.any(AbortSignal))
    expect(ended).toHaveBeenCalledOnce()
  })
  it.each(['Stop', 'disconnect'])('flushes only the trusted outgoing point on %s after a cached volume update', async action => {
    const { sdk } = await rejectedLoadWithCachedMedia()
    await act(async () => { sdk.emitRemoteChange('volumeLevel', 0.5) }); await settle()
    if (action === 'Stop') fireEvent.click(screen.getByRole('button', { name: 'Stop and close' }))
    else await act(async () => { sdk.triggerBlip(); vi.advanceTimersByTime(4500) })
    await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: 600000, profile_id: 7 }), expect.any(AbortSignal))
    expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000 }), expect.anything())
  })
  it.each(['Stop', 'unmount'])('detaches the real watched Media on quiet %s without waiting for another receiver event', async action => {
    const { view, mediaListeners } = await rejectedLoadWithCachedMedia()
    expect(mediaListeners.size).toBe(1)
    if (action === 'Stop') fireEvent.click(screen.getByRole('button', { name: 'Stop and close' }))
    else view.unmount()
    await settle()
    expect(mediaListeners.size).toBe(0)
  })
  it.each([true, false])('keeps party clock readers quiet after a cached volume update for host=%s', async isHost => {
    const party: PartySync = {
      isHost, currentUserId: 1, partyMediaItemId: movie.mediaItemId, partyEpisodeId: null, isPlaying: false, rev: 1, hlsStartSec: 0,
      tickRef: { current: { abs_ms: 600000, server_now_ms: Date.now(), receivedAtMs: Date.now(), running: false } },
      seekRef: { current: null }, helloAbsMsRef: { current: 600000 }, requestPlay: vi.fn(), requestPause: vi.fn(), requestSeek: vi.fn(),
    }
    const { sdk } = await rejectedLoadWithCachedMedia({ party })
    vi.mocked(party.requestPlay).mockClear(); vi.mocked(party.requestPause).mockClear(); vi.mocked(party.requestSeek).mockClear()
    const controller = sdk.getRemoteController()!
    controller.seek.mockClear(); controller.playOrPause.mockClear()
    await act(async () => { sdk.emitRemoteChange('volumeLevel', 0.5) }); await settle()
    for (let i = 0; i < 10; i++) {
      party.tickRef.current = { abs_ms: 700000, server_now_ms: Date.now(), receivedAtMs: Date.now(), running: false }
      await act(async () => { vi.advanceTimersByTime(1000) }); await settle()
    }
    expect(party.requestPlay).not.toHaveBeenCalled(); expect(party.requestPause).not.toHaveBeenCalled(); expect(party.requestSeek).not.toHaveBeenCalled()
    expect(controller.seek).not.toHaveBeenCalled(); expect(controller.playOrPause).not.toHaveBeenCalled()
  })
  it('persists positively identified FINISHED after a successful PAUSED retry ACK without requiring an observed PLAYING event', async () => {
    const { sdk, session, cachedMedia, ended, publishMediaStatus } = await rejectedLoadWithCachedMedia()
    const retryURL = 'http://localhost:3000/api/stream/hls/paused-retry/master.m3u8?token=cast'
    vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: retryURL, token, expires_at: 9999999999, start_sec: 590 })
    vi.mocked(session.loadMedia).mockImplementationOnce(async request => {
      Object.assign(cachedMedia, { mediaSessionId: 3, media: request.media, currentTime: 10, playerState: 'PAUSED', idleReason: null })
      Object.assign(sdk.getRemotePlayer()!, { mediaInfo: request.media, currentTime: 10, playerState: 'PAUSED', isPaused: true })
      sdk.emitRemoteChange('playerState', 'PAUSED')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(3)
    await act(async () => { vi.advanceTimersByTime(3000) }); await settle()
    vi.mocked(reportProgress).mockClear()
    Object.assign(cachedMedia, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0 })
    Object.assign(sdk.getRemotePlayer()!, { playerState: 'IDLE', isMediaLoaded: false })
    expect(session.getMediaSession()).toBeNull()
    await act(async () => { publishMediaStatus(false); sdk.emitRemoteChange('playerState', 'IDLE') }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000, profile_id: 7 }), expect.any(AbortSignal))
    expect(ended).toHaveBeenCalledOnce()
    vi.mocked(reportProgress).mockClear()
    await act(async () => { sdk.emitRemoteChange('volumeLevel', 0.5) }); await settle()
    expect(ended).toHaveBeenCalledOnce(); expect(reportProgress).not.toHaveBeenCalled()
  })
  it('stops exact acknowledged CANCELLED after a PAUSED retry ACK without marking completion', async () => {
    const { sdk, session, cachedMedia, ended, publishMediaStatus } = await rejectedLoadWithCachedMedia()
    const retryURL = 'http://localhost:3000/api/stream/hls/cancelled-paused-retry/master.m3u8?token=cast'
    const stop = vi.spyOn(session, 'endSession')
    vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: retryURL, token, expires_at: 9999999999, start_sec: 590 })
    vi.mocked(session.loadMedia).mockImplementationOnce(async request => {
      Object.assign(cachedMedia, { mediaSessionId: 3, media: request.media, currentTime: 10, playerState: 'PAUSED', idleReason: null })
      Object.assign(sdk.getRemotePlayer()!, { mediaInfo: request.media, currentTime: 10, playerState: 'PAUSED', isPaused: true })
      sdk.emitRemoteChange('playerState', 'PAUSED')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle()
    await act(async () => { vi.advanceTimersByTime(3000) }); await settle()
    vi.mocked(reportProgress).mockClear()
    Object.assign(cachedMedia, { playerState: 'IDLE', idleReason: 'CANCELLED', currentTime: 0 })
    Object.assign(sdk.getRemotePlayer()!, { playerState: 'IDLE', isMediaLoaded: false })
    expect(session.getMediaSession()).toBeNull()
    await act(async () => { publishMediaStatus(false); sdk.emitRemoteChange('playerState', 'IDLE') }); await settle()
    expect(stop).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled()
    expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000 }), expect.anything())
  })
  it.each(['CANCELLED', 'ERROR'])('stops the genuinely updated acknowledged receiver on TV %s when the public getter hides terminal media', async idleReason => {
    const { session, cachedMedia, player, ended, publishMediaStatus } = await rejectedLoadWithCachedMedia({ armEnd: true })
    const stop = vi.spyOn(session, 'endSession')
    cachedMedia.playerState = 'PLAYING'
    Object.assign(player, { playerState: 'PLAYING', isPaused: false })
    await act(async () => { publishMediaStatus() }); await settle()
    vi.mocked(reportProgress).mockClear()
    Object.assign(cachedMedia, { playerState: 'IDLE', idleReason, currentTime: 0 })
    Object.assign(player, { playerState: 'IDLE', isMediaLoaded: false })
    expect(session.getMediaSession()).toBeNull()
    await act(async () => { publishMediaStatus(false) }); await settle()
    expect(stop).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: 600000, profile_id: 7 }), expect.any(AbortSignal))
    expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000 }), expect.anything())
  })
  it.each(['FINISHED', 'CANCELLED'])('does not stop a newer retry waiting for ACK when the prior failed URI reports %s', async idleReason => {
    const { sdk, session, cachedMedia, ended, publishMediaStatus } = await rejectedLoadWithCachedMedia({ armEnd: true })
    const retryURL = 'http://localhost:3000/api/stream/hls/pending-new-retry/master.m3u8?token=cast'
    const stop = vi.spyOn(session, 'endSession')
    let acknowledge!: () => void
    vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: retryURL, token, expires_at: 9999999999, start_sec: 590 })
    vi.mocked(session.loadMedia).mockImplementationOnce(async request => {
      await new Promise<void>(resolve => { acknowledge = resolve })
      Object.assign(cachedMedia, { mediaSessionId: 3, media: request.media, currentTime: 10, playerState: 'PLAYING', idleReason: null })
      Object.assign(sdk.getRemotePlayer()!, { mediaInfo: request.media, currentTime: 10, playerState: 'PLAYING', isPaused: false, isMediaLoaded: true })
      sdk.emitRemoteChange('playerState', 'PLAYING')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(3)
    Object.assign(cachedMedia, { media: { contentId: failedURL, contentType: 'application/x-mpegURL' }, playerState: 'IDLE', idleReason, currentTime: 0 })
    Object.assign(sdk.getRemotePlayer()!, { playerState: 'IDLE', isMediaLoaded: false })
    expect(session.getMediaSession()).toBeNull()
    await act(async () => { publishMediaStatus(false); sdk.emitRemoteChange('playerState', 'IDLE'); vi.advanceTimersByTime(3000) }); await settle()
    expect(stop).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
    expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000 }), expect.anything())
    await act(async () => { acknowledge() }); await settle()
    await act(async () => { vi.advanceTimersByTime(3000) }); await settle()
    expect(stop).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
  })
})
