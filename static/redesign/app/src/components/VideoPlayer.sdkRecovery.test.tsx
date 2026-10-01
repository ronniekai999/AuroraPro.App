// @vitest-environment jsdom
// Exercise the real player/controls; mock only delivery, telemetry and CAF.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer, type PlayTarget } from './VideoPlayer'
import { createSession, getStreamInfo, keepalive, createCastToken, createDirectCastToken } from '@/lib/streaming'
import { markWatched, reportProgress } from '@/lib/api'
const fake = vi.hoisted(() => ({
  hls: [] as Array<{ emit: (name: string, data?: unknown) => void; startLoad: ReturnType<typeof vi.fn>; stopLoad: ReturnType<typeof vi.fn>; options: { autoStartLoad: boolean }; loadSource: ReturnType<typeof vi.fn> }>,
}))
vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => true
    static Events = new Proxy({}, { get: (_target, name) => name })
    static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' }
    static ErrorDetails = { BUFFER_STALLED_ERROR: 'bufferStalledError' }
    handlers = new Map<string, Array<(name: string, data: unknown) => void>>()
    levels = []; currentLevel = 0; subtitleTrack = -1; bandwidthEstimate = 8000000
    url: string | null = null; options: { autoStartLoad: boolean }; constructor(options: { autoStartLoad: boolean }) { this.options = options; fake.hls.push(this) }
    on(name: string, callback: (name: string, data: unknown) => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], callback]) }
    emit(name: string, data: unknown = {}) { this.handlers.get(name)?.forEach(fn => fn(name, data)) }
    loadSource = vi.fn((url: string) => { this.url = url }); attachMedia() {} startLoad = vi.fn(); stopLoad = vi.fn(); recoverMediaError() {} swapAudioCodec() {}
    destroy() { this.handlers.clear() }
  }
  return { default: FakeHls }
})
vi.mock('@/lib/streaming', async original => ({
  ...await original<typeof import('@/lib/streaming')>(),
  getStreamInfo: vi.fn(), createSession: vi.fn(), deleteSession: vi.fn(async () => {}), keepalive: vi.fn(async () => 'alive'),
  createCastToken: vi.fn(async () => ({ playlist: '/api/stream/hls/cast-copy/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: 100, segment_format: 'fmp4' })),
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
  vi.mocked(createCastToken).mockReset().mockResolvedValue({ ...castTokenFor('cast-copy', 100), segment_format: 'fmp4' })
  vi.mocked(getStreamInfo).mockResolvedValue(info() as Awaited<ReturnType<typeof getStreamInfo>>)
  vi.mocked(createSession).mockImplementation(async request => ({ session_id: `session-${fake.hls.length}`, master_playlist: '/api/stream/session/master.m3u8', start_sec: request.start_sec ?? 0 } as Awaited<ReturnType<typeof createSession>>))
  vi.mocked(keepalive).mockResolvedValue('ok')
  vi.mocked(reportProgress).mockResolvedValue(undefined)
  vi.mocked(markWatched).mockResolvedValue({})
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
    emitRemoteChange: (event: unknown = {}) => remoteController?.emit('any_change', event),
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



afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as { cast?: unknown }).cast
  delete (window as { chrome?: unknown }).chrome
})
describe('VideoPlayer recovery with real useCast and receiver Media updates', () => {
  const token = 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x'
  const oldURI = 'http://localhost:3000/api/stream/hls/cache-old/master.m3u8?token=cast'
  const attemptedURI = 'http://localhost:3000/api/stream/hls/cache-attempt/master.m3u8?token=cast'
  async function failedLoadWithUnchangedMedia(waitAfterFailure = true) {
    const sdk=installFakeSdk()
    const session=sdk.makeSession()
    const listeners = new Set<(alive:boolean)=>void>()
    const media:CastMediaSession={mediaSessionId:1,addUpdateListener:listener=>{listeners.add(listener)},removeUpdateListener:listener=>{listeners.delete(listener)},media:{contentId:oldURI,contentType:'application/x-mpegURL'},playerState:'PAUSED',currentTime:500,idleReason:null}
    media.getEstimatedTime=vi.fn(function(this:CastMediaSession){expect(this).toBe(media);return this.currentTime!})
    session.getMediaSession=vi.fn(()=>media.idleReason?null:media)
    sdk.setRequestSessionImpl(async()=>{sdk.setSession(session);sdk.triggerReconnect();return undefined})
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('#EXTM3U',{status:200,headers:{'Content-Type':'application/vnd.apple.mpegurl'}})))
    vi.mocked(createCastToken).mockResolvedValueOnce({playlist:oldURI,token,expires_at:1,start_sec:100})
    vi.mocked(session.loadMedia).mockImplementationOnce(async()=>{
      media.mediaSessionId=2
      Object.assign(sdk.getRemotePlayer()!,{isConnected:true,isMediaLoaded:true,mediaInfo:media.media,currentTime:500,playerState:'PAUSED',isPaused:true,canSeek:true})
      sdk.emitRemoteChange({field:'currentTime',value:500})
    })
    const ended=vi.fn(async()=>false)
    render(<VideoPlayer target={{...movie,resumePositionMs:600000}} onClose={()=>{}} onEnded={ended} />)
    await bootHls();fireEvent.click(screen.getByRole('button',{name:'Cast'}));await settle()
    await act(async()=>{vi.advanceTimersByTime(3100)});await settle()
    vi.mocked(createCastToken).mockResolvedValueOnce({playlist:attemptedURI,token,expires_at:9999999999,start_sec:580})
    vi.mocked(session.loadMedia).mockRejectedValueOnce({code:'timeout',description:'LOAD reached receiver without an ACK or fresh MEDIA_STATUS'})
    fireEvent.click(screen.getByRole('button',{name:'Play'}));await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(2)
    expect(vi.mocked(session.loadMedia).mock.calls[1][0].currentTime).toBe(20)
    if(waitAfterFailure){await act(async()=>{vi.advanceTimersByTime(3100)});await settle()}
    fireEvent.click(screen.getByRole('button',{name:'Expand player'}));await settle()
    fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(2)
    return {sdk,session,media,ended, emitStatus:(alive=true)=>{for(const listener of [...listeners])listener(alive)}}
  }
  it('does not recover an uncertain clock solely by resampling cached PAUSED Media on a volume event',async()=>{
    const {sdk,session,media}=await failedLoadWithUnchangedMedia()
    const stateBefore={...media}
    vi.mocked(media.getEstimatedTime!).mockClear()
    Object.assign(sdk.getRemotePlayer()!,{volumeLevel:0.7})
    await act(async()=>{sdk.emitRemoteChange({field:'volumeLevel',value:0.7})});await settle()
    expect(media).toEqual(stateBefore)
    expect(media.getEstimatedTime).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(2)
  })
  it('keeps cached recovery suspended through mute and play-state-only RemotePlayer events',async()=>{
    const {sdk,session}=await failedLoadWithUnchangedMedia()
    Object.assign(sdk.getRemotePlayer()!,{isMuted:true,playerState:'PLAYING',isPaused:false})
    await act(async()=>{sdk.emitRemoteChange({field:'isMuted',value:true})});await settle()
    fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(2)
  })
  it('restores the committed clock only after a genuine post-rejection Media update',async()=>{
    const {session,emitStatus}=await failedLoadWithUnchangedMedia()
    await act(async()=>{emitStatus()});await settle()
    fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(3)
    expect(vi.mocked(createCastToken).mock.calls.at(-1)?.[1]).toMatchObject({atSec:610})
  })
  it('retains genuine quiet PAUSED recovery during settlement and handles later FINISHED once',async()=>{
    const {media,ended,emitStatus}=await failedLoadWithUnchangedMedia(false)
    await act(async()=>{emitStatus()});await settle()
    media.playerState='IDLE';media.idleReason='FINISHED'
    await act(async()=>{emitStatus(false)});await settle()
    expect(ended).not.toHaveBeenCalled()
    await act(async()=>{vi.advanceTimersByTime(3100)});await settle()
    expect(ended).toHaveBeenCalledOnce()
  })
})
describe('VideoPlayer serialized repeated-URI LOADs use the new Media generation', () => {
  async function repeatedLoad() {
    const sdk = installFakeSdk(), session = sdk.makeSession()
    const uri = 'http://localhost:3000/api/stream/direct/media/10?token=same-second-cast-token'
    const makeMedia=(id:number,time:number)=>{
      const listeners=new Set<(alive:boolean)=>void>()
      const media:CastMediaSession={
        mediaSessionId:id,media:{contentId:uri,contentType:'video/mp4'},playerState:'PAUSED',currentTime:time,idleReason:null,
        getEstimatedTime(){return this.currentTime!},
        addUpdateListener(listener){listeners.add(listener)},removeUpdateListener(listener){listeners.delete(listener)},
      }
      return{media,emit:(alive=true)=>{for(const listener of [...listeners])listener(alive)}}
    }
    let receiver=makeMedia(1,600)
    session.getMediaSession=()=>receiver.media.idleReason?null:receiver.media
    sdk.setRequestSessionImpl(async () => { sdk.setSession(session); sdk.triggerReconnect(); return undefined })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
    vi.mocked(createDirectCastToken).mockResolvedValue({ url: uri, token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })
    let ack!:()=>void
    vi.mocked(session.loadMedia).mockImplementationOnce(async request => {
      expect(request.currentTime).toBe(600)
      receiver=makeMedia(2,600)
      Object.assign(sdk.getRemotePlayer()!, { isConnected: true, isMediaLoaded: true, mediaInfo: receiver.media.media, playerState: 'PAUSED', isPaused: true, currentTime: 600, canSeek: true })
      sdk.emitRemoteChange()
      await new Promise<void>(resolve => { ack=resolve })
    }).mockImplementationOnce(async request => {
      expect(request.currentTime).toBe(800)
      expect(request.media.contentId).toBe(uri)
      // ACK precedes the replacement Media status; id 2 still owns 600.
    })
    const close=vi.fn(), ended=vi.fn(async()=>true)
    const oldTarget={...movie,resumePositionMs:600000}, newTarget={...movie,resumePositionMs:800000}
    const element=(target=oldTarget,profileId=7)=><VideoPlayer target={target} profileId={profileId} onClose={close} onEnded={ended}/>
    const view=render(element());await settle()
    const button=screen.getByRole('button',{name:'Cast'})
    fireEvent.click(button);fireEvent.click(button);await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(1)
    view.rerender(element(newTarget,9));await settle()
    fireEvent.canPlay(document.querySelector('video')!);await settle()
    await act(async()=>{ack()});await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(2)
    await act(async()=>{vi.advanceTimersByTime(3100)});await settle()
    return {sdk,session,media:receiver.media,close,ended,emit:receiver.emit,replaceGeneration:(id:number,time:number)=>{receiver=makeMedia(id,time);return receiver}}
  }
  for(const fresh of [false,true]) it(`requires a replacement Media generation for relative actions after same-URI ACK (fresh=${fresh})`,async()=>{
    const {sdk,emit,replaceGeneration}=await repeatedLoad()
    if(fresh){replaceGeneration(3,800);await act(async()=>{sdk.emitRemoteChange()});await settle()}
    else{await act(async()=>{emit()});await settle()}
    await act(async()=>{sdk.emitRemoteChange({field:'volumeLevel',value:0.7})});await settle()
    fireEvent.click(screen.getByRole('button',{name:'Expand player'}));await settle()
    fireEvent.mouseMove(screen.getByRole('dialog',{name:'Playing Movie'}),{clientX:100,clientY:100});await settle()
    fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
    expect(sdk.getRemotePlayer()!.currentTime).toBe(fresh?810:600)
  })
  it('ignores cached outgoing FINISHED, then completes the positively acknowledged new generation once without PLAYING',async()=>{
    const {sdk,media,ended,close,emit,replaceGeneration}=await repeatedLoad()
    media.playerState='IDLE';media.idleReason='FINISHED'
    await act(async()=>{emit(false)});await settle()
    expect(ended).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
    const incoming=replaceGeneration(3,800)
    await act(async()=>{sdk.emitRemoteChange()});await settle() // actual incoming PAUSED Media is watched first
    incoming.media.playerState='IDLE';incoming.media.idleReason='FINISHED'
    await act(async()=>{incoming.emit(false)});await settle()
    expect(ended).toHaveBeenCalledOnce()
    await act(async()=>{sdk.emitRemoteChange({field:'volumeLevel',value:0.8})});await settle()
    await act(async()=>{incoming.emit(false)});await settle()
    expect(ended).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled()
  })
})

function castTokenFor(id: string, startSec = 200): Awaited<ReturnType<typeof createCastToken>> {
  return { playlist: `/api/stream/hls/${id}/master.m3u8?token=cast`, token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: startSec, segment_format: 'ts' }
}

describe('VideoPlayer ignores recreated retired Media session IDs', () => {
  it('rejects an older recreated clock and FINISHED, then accepts the genuine incoming generation', async () => {
    const uri = 'http://localhost:3000/api/stream/direct/media/10?token=same-second'
    const makeMedia = (id: number, time: number) => {
      const listeners = new Set<(alive: boolean) => void>()
      const media: CastMediaSession = {
        mediaSessionId: id, media: { contentId: uri, contentType: 'video/mp4' },
        playerState: 'PAUSED', currentTime: time, idleReason: null,
        addUpdateListener: listener => { listeners.add(listener) },
        removeUpdateListener: listener => { listeners.delete(listener) },
        getEstimatedTime() { return this.currentTime! },
      }
      return { media, emit: (alive = true) => { for (const listener of [...listeners]) listener(alive) } }
    }
    const active = [makeMedia(1, 600).media]
    const sdk = installFakeSdk(), session = sdk.makeSession()
    // Public CAF filters out Media whose idleReason is already set.
    session.getMediaSession = () => active.find(media => !media.idleReason) ?? null
    sdk.setRequestSessionImpl(async () => { sdk.setSession(session); sdk.triggerReconnect(); return undefined })
    vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
    vi.mocked(createDirectCastToken).mockResolvedValue({ url: uri, token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    let ack!: () => void
    const seekSpy = vi.spyOn(FakeRemotePlayerController.prototype, 'seek')
    const received: ReturnType<typeof makeMedia>[] = []
    session.loadMedia = vi.fn(async request => {
      const incoming = makeMedia(received.length + 2, request.currentTime!)
      received.push(incoming)
      if (received.length === 3) {
        active.splice(0, active.length) // id 4 ACK precedes its first status
        Object.assign(sdk.getRemotePlayer()!, { isMediaLoaded: false, mediaInfo: null, currentTime: 0, playerState: 'IDLE' })
      } else {
        active.splice(0, active.length, incoming.media)
        Object.assign(sdk.getRemotePlayer()!, { isConnected: true, isMediaLoaded: true, mediaInfo: incoming.media.media,
          currentTime: request.currentTime, playerState: 'PAUSED', isPaused: true, canSeek: true })
      }
      sdk.emitRemoteChange()
      if (received.length === 1) await new Promise<void>(resolve => { ack = resolve })
    })
    const old = { ...movie, resumePositionMs: 600000 }, next = { ...movie, resumePositionMs: 900000 }
    const ended = vi.fn(async () => true)
    const element = (target = old, profileId = 7) => <VideoPlayer target={target} profileId={profileId} onClose={() => {}} onEnded={ended} />
    const view = render(element()); await settle()
    const button = screen.getByRole('button', { name: 'Cast' })
    fireEvent.click(button); fireEvent.click(button); fireEvent.click(button); await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(1)
    view.rerender(element(next, 9)); await settle()
    fireEvent.canPlay(document.querySelector('video')!); await settle()
    await act(async () => { ack() }); await settle()
    expect(session.loadMedia).toHaveBeenCalledTimes(3)
    expect(received.map(m => m.media.currentTime)).toEqual([600, 900, 900])
    await act(async () => { vi.advanceTimersByTime(3100) }); await settle()
    expect(session.getMediaSession()).toBeNull()
    const late = makeMedia(2, 600) // Legacy sender recreates evicted older id 2.
    active.push(late.media)
    Object.assign(sdk.getRemotePlayer()!, { isMediaLoaded: true, mediaInfo: late.media.media, currentTime: 600, playerState: 'PAUSED', isPaused: true })
    await act(async () => { sdk.emitRemoteChange() }); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    fireEvent.mouseMove(screen.getByRole('dialog', { name: 'Playing Movie' }), { clientX: 100, clientY: 100 }); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(seekSpy).not.toHaveBeenCalled()
    expect(sdk.getRemotePlayer()!.currentTime).toBe(600)
    late.media.playerState = 'IDLE'; late.media.idleReason = 'FINISHED'
    await act(async () => { late.emit(false); sdk.emitRemoteChange() }); await settle()
    expect(ended).not.toHaveBeenCalled()
    const incoming = received[2]
    active.splice(0, active.length, incoming.media)
    Object.assign(sdk.getRemotePlayer()!, { isMediaLoaded: true, mediaInfo: incoming.media.media, currentTime: 900, playerState: 'PAUSED', isPaused: true })
    await act(async () => { sdk.emitRemoteChange() }); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(sdk.getRemotePlayer()!.currentTime).toBe(910)
    incoming.media.playerState = 'IDLE'; incoming.media.idleReason = 'FINISHED'
    await act(async () => { incoming.emit(false) }); await settle()
    expect(ended).toHaveBeenCalledOnce()
  })
})

describe('VideoPlayer latest rejected same-URI attempt cleanup',()=>{
 for(const reason of ['FINISHED','CANCELLED'] as const)for(const recovery of ['none','sdk-retry','token-preflight','committed-status'] as const)for(const anyFirst of [false,true])it(`stops only latest rejected ${reason}, recovery=${recovery}, ANY first=${anyFirst}`,async()=>{
   const newerRetry=recovery==='sdk-retry'||recovery==='token-preflight'
   const uri='http://localhost:3000/api/stream/direct/media/10?token=same-second'
   const listeners=new Map<number,Set<(alive:boolean)=>void>>()
   const makeMedia=(id:number):CastMediaSession=>({mediaSessionId:id,media:{contentId:uri,contentType:'video/mp4'},playerState:'PAUSED',currentTime:600,idleReason:null,
     addUpdateListener:l=>{if(!listeners.has(id))listeners.set(id,new Set());listeners.get(id)!.add(l)},removeUpdateListener:l=>{listeners.get(id)?.delete(l)},getEstimatedTime(){return this.currentTime!}})
   const items=[makeMedia(1)],actualGet=()=>items.find(media=>!media.idleReason)??null
   const sdk=installFakeSdk(),session=sdk.makeSession(),ended=vi.fn(async()=>false),close=vi.fn()
   session.getMediaSession=actualGet;session.endSession=vi.fn(session.endSession)
   sdk.setRequestSessionImpl(async()=>{sdk.setSession(session);sdk.triggerReconnect();return undefined})
   vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
   const directToken={url:uri,token:'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x',expires_at:9999999999}
   vi.mocked(createDirectCastToken).mockResolvedValue(directToken)
   vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:200})))
   let firstAck!:()=>void,newestAck!:()=>void,releaseToken!:()=>void;const received:CastMediaSession[]=[]
   session.loadMedia=vi.fn(async()=>{
     const current=makeMedia(received.length+2);received.push(current);items.splice(0,items.length,current)
     Object.assign(sdk.getRemotePlayer()!,{isConnected:true,isMediaLoaded:true,mediaInfo:current.media,currentTime:600,playerState:'PAUSED',isPaused:true,canSeek:true})
     sdk.emitRemoteChange()
     if(received.length===1)await new Promise<void>(r=>{firstAck=r})
     else if(received.length===2)throw {code:'timeout',description:'LOAD reached the TV but ACK timed out'}
     else await new Promise<void>(r=>{newestAck=r})
   })
   render(<VideoPlayer target={{...movie,resumePositionMs:600000}} onClose={close} onEnded={ended}/>)
   await settle();const button=screen.getByRole('button',{name:'Cast'})
   fireEvent.click(button);fireEvent.click(button);await settle()
   expect(session.loadMedia).toHaveBeenCalledTimes(1)
   await act(async()=>{firstAck()});await settle();expect(session.loadMedia).toHaveBeenCalledTimes(2)
   await act(async()=>{vi.advanceTimersByTime(3100)});await settle()
   expect(session.endSession).not.toHaveBeenCalled()
   fireEvent.click(screen.getByRole('button',{name:'Expand player'}));await settle()
   await act(async()=>{for(const listener of [...listeners.get(3)??[]])listener(true);sdk.emitRemoteChange({field:'volumeLevel',value:0.7})});await settle()
   fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
   expect(session.loadMedia).toHaveBeenCalledTimes(2)
   if(newerRetry){
     if(recovery==='token-preflight')vi.mocked(createDirectCastToken).mockImplementationOnce(async()=>new Promise(resolve=>{releaseToken=()=>resolve(directToken)}))
     fireEvent.keyDown(screen.getByRole('slider',{name:'Seek'}),{key:'Home'});await settle()
     expect(session.loadMedia).toHaveBeenCalledTimes(recovery==='token-preflight'?2:3)
     items.splice(0,items.length,received[1])
   }else if(recovery==='committed-status'){
     items.splice(0,items.length,received[0])
     await act(async()=>{sdk.emitRemoteChange();for(const listener of [...listeners.get(2)??[]])listener(true)});await settle()
     fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
     expect(sdk.getRemotePlayer()!.currentTime).toBe(610)
     items.splice(0,items.length,received[1])
   }
   const current=received[1];current.playerState='IDLE';current.idleReason=reason
   expect(actualGet()).toBeNull()
   Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:false,mediaInfo:null,currentTime:0,playerState:'IDLE'})
   await act(async()=>{if(anyFirst)sdk.emitRemoteChange();for(const listener of [...listeners.get(3)??[]])listener(false);sdk.emitRemoteChange({field:'isMuted',value:true})});await settle()
   expect(ended).not.toHaveBeenCalled()
   if(newerRetry){
     expect(session.endSession).not.toHaveBeenCalled()
     if(recovery==='token-preflight'){
       await act(async()=>{vi.advanceTimersByTime(3100)});await settle()
       expect(session.endSession).not.toHaveBeenCalled();expect(ended).not.toHaveBeenCalled()
       await act(async()=>{releaseToken()});await settle()
       expect(session.loadMedia).toHaveBeenCalledTimes(3)
     }
     items.splice(0,items.length,received[2])
     Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:true,mediaInfo:received[2].media,currentTime:600,playerState:'PAUSED'})
     await act(async()=>{sdk.emitRemoteChange();newestAck()});await settle()
     await act(async()=>{vi.advanceTimersByTime(3100)});await settle()
     expect(session.endSession).not.toHaveBeenCalled()
     received[2].playerState='IDLE';received[2].idleReason='FINISHED'
     Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:false,mediaInfo:null,currentTime:0,playerState:'IDLE'})
     await act(async()=>{for(const listener of [...listeners.get(4)??[]])listener(false);sdk.emitRemoteChange()});await settle()
     expect(ended).toHaveBeenCalledOnce()
   }else if(recovery==='committed-status'){
     expect(session.endSession).not.toHaveBeenCalled()
     const committed=received[0]
     items.splice(0,items.length,committed)
     Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:true,mediaInfo:committed.media,currentTime:600,playerState:'PAUSED'})
     await act(async()=>{sdk.emitRemoteChange()});await settle()
     committed.playerState='IDLE';committed.idleReason='FINISHED'
     Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:false,mediaInfo:null,currentTime:0,playerState:'IDLE'})
     await act(async()=>{for(const listener of [...listeners.get(2)??[]])listener(false);sdk.emitRemoteChange()});await settle()
     expect(ended).toHaveBeenCalledOnce()
   }
   expect(session.endSession).toHaveBeenCalledOnce()
   expect(close).toHaveBeenCalledOnce()
 })
})

describe('VideoPlayer retry ACK retires prior committed Media generation',()=>{
 for(const terminal of [false,true])for(const injectStale of [false,true])for(const stalePhase of ['preACK','postACK'] as const)it(`excludes older ACK2 while ACK4 awaits first Media status, older FINISHED=${terminal}, inject stale=${injectStale}, phase=${stalePhase}`,async()=>{
   const uri='http://localhost:3000/api/stream/direct/media/10?token=same-second'
   const listeners=new Map<number,Set<(alive:boolean)=>void>>()
   const makeMedia=(id:number,time:number):CastMediaSession=>({mediaSessionId:id,media:{contentId:uri,contentType:'video/mp4'},playerState:'PAUSED',currentTime:time,idleReason:null,
     addUpdateListener:l=>{if(!listeners.has(id))listeners.set(id,new Set());listeners.get(id)!.add(l)},removeUpdateListener:l=>listeners.get(id)?.delete(l),getEstimatedTime(){return this.currentTime!}})
   const items=[makeMedia(1,600)],actualGet=()=>items.find(media=>!media.idleReason)??null
   const sdk=installFakeSdk(),session=sdk.makeSession(),ended=vi.fn(async()=>true)
   session.getMediaSession=actualGet;session.endSession=vi.fn(session.endSession)
   sdk.setRequestSessionImpl(async()=>{sdk.setSession(session);sdk.triggerReconnect();return undefined})
   vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
   vi.mocked(createDirectCastToken).mockResolvedValue({url:uri,token:'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x',expires_at:9999999999})
   vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:200})))
   let firstAck!:()=>void,newestAck!:()=>void;const received:CastMediaSession[]=[]
   session.loadMedia=vi.fn(async request=>{
     const current=makeMedia(received.length+2,request.currentTime!);received.push(current)
     if(received.length===3){
       items.splice(0,items.length)
       Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:false,mediaInfo:null,currentTime:0,playerState:'IDLE'})
       sdk.emitRemoteChange();await new Promise<void>(r=>{newestAck=r});return
     }
     items.splice(0,items.length,current)
     Object.assign(sdk.getRemotePlayer()!,{isConnected:true,isMediaLoaded:true,mediaInfo:current.media,currentTime:current.currentTime,playerState:'PAUSED',isPaused:true,canSeek:true})
     sdk.emitRemoteChange()
     if(received.length===1)await new Promise<void>(r=>{firstAck=r})
     else throw {code:'timeout',description:'Second LOAD reached the TV but ACK timed out'}
   })
   const old={...movie,resumePositionMs:600000},next={...movie,resumePositionMs:900000}
   const element=(target=old,profileId=7)=><VideoPlayer target={target} profileId={profileId} onClose={()=>{}} onEnded={ended}/>
   const view=render(element());await settle();const button=screen.getByRole('button',{name:'Cast'})
   fireEvent.click(button);fireEvent.click(button);fireEvent.click(button);await settle()
   expect(session.loadMedia).toHaveBeenCalledTimes(1)
   view.rerender(element(next,9));await settle();fireEvent.canPlay(document.querySelector('video')!);await settle()
   await act(async()=>{firstAck()});await settle();expect(session.loadMedia).toHaveBeenCalledTimes(3)
   expect(received.map(media=>media.currentTime)).toEqual([600,900,900])
   const retired=makeMedia(2,600)
   const publishOlder=async()=>{
     items.splice(0,items.length,retired)
     Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:true,mediaInfo:retired.media,currentTime:600,playerState:'PAUSED',isPaused:true})
     await act(async()=>{sdk.emitRemoteChange()});await settle()
   }
   if(injectStale&&stalePhase==='preACK')await publishOlder()
   await act(async()=>{newestAck()});await settle()
   await act(async()=>{vi.advanceTimersByTime(3100)});await settle()
   if(!injectStale)expect(actualGet()).toBeNull()
   if(injectStale&&stalePhase==='postACK')await publishOlder()
   fireEvent.click(screen.getByRole('button',{name:'Expand player'}));await settle()
   fireEvent.mouseMove(screen.getByRole('dialog',{name:'Playing Movie'}),{clientX:100,clientY:100});await settle()
   if(injectStale){
   const seek=vi.spyOn(FakeRemotePlayerController.prototype,'seek')
   fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
   const oldResult={calls:seek.mock.calls.length,clock:sdk.getRemotePlayer()!.currentTime}
   if(terminal){
     retired.playerState='IDLE';retired.idleReason='FINISHED'
     Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:false,mediaInfo:null,currentTime:0,playerState:'IDLE'})
     await act(async()=>{for(const listener of [...listeners.get(2)??[]])listener(false);sdk.emitRemoteChange()});await settle()
   }
   expect.soft(oldResult).toEqual({calls:0,clock:600})
   expect.soft(ended).not.toHaveBeenCalled()
   }
   items.splice(0,items.length,received[2])
   Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:true,mediaInfo:received[2].media,currentTime:900,playerState:'PAUSED',isPaused:true})
   await act(async()=>{sdk.emitRemoteChange()});await settle()
   fireEvent.mouseMove(screen.getByRole('dialog',{name:'Playing Movie'}),{clientX:100,clientY:100});await settle()
   fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
   expect(sdk.getRemotePlayer()!.currentTime).toBe(910)
   received[2].playerState='IDLE';received[2].idleReason='FINISHED'
   Object.assign(sdk.getRemotePlayer()!,{isMediaLoaded:false,mediaInfo:null,currentTime:0,playerState:'IDLE'})
   await act(async()=>{for(const listener of [...listeners.get(4)??[]])listener(false);sdk.emitRemoteChange()});await settle()
   expect(ended).toHaveBeenCalledOnce()
 })
})
