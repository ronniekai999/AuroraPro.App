// @vitest-environment jsdom
// Exercise the real player/controls; mock only delivery, telemetry and CAF.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer, type PlayTarget, type PartySync } from './VideoPlayer'
import { createSession, getStreamInfo, keepalive, createCastToken, deleteSession } from '@/lib/streaming'
import { markWatched, reportProgress } from '@/lib/api'
import { CastMediaLoadError, type CastLoadArgs } from '@/lib/cast'
const fake = vi.hoisted(() => ({
  getter: null as null | ((at?: number) => Promise<unknown>),
  cast: {
    status: { supported: true, available: true, connected: false, settling: false, deviceName: 'TV' },
    remote: { title: 'Receiver title', contentId: null as string | null, clockContentId: null as string | null, mediaStatusSeq: 0, isMediaLoaded: true, isPaused: false, canSeek: true, currentTime: 0, duration: 1000, playerState: 'PLAYING' as string | null, idleReason: null as string | null, updateSeq: 0 },
    start: vi.fn(), stop: vi.fn(), loadCurrent: vi.fn(), seek: vi.fn(), playOrPause: vi.fn(),
  },
  hls: [] as Array<{ emit: (name: string, data?: unknown) => void; startLoad: ReturnType<typeof vi.fn>; stopLoad: ReturnType<typeof vi.fn>; options: { autoStartLoad: boolean }; loadSource: ReturnType<typeof vi.fn> }>,
}))
vi.mock('@/lib/cast', async original => ({
  ...await original<typeof import('@/lib/cast')>(),
  useCast: (getter: (at?: number) => Promise<unknown>) => { fake.getter = getter; return fake.cast },
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
  return { stream: { decision, stream_url: '/file.mp4', duration_ms: duration, video_codec: 'h264', audio_codec: 'aac', audio_codec_out: 'aac', container: 'mp4', width: 1920, height: 1080 }, audio_tracks: [{ index: 0, title: 'English', codec: 'aac' }, { index: 1, title: 'French', codec: 'aac' }], subtitles: [], markers: [] }
}
const paused = new WeakMap<HTMLMediaElement, boolean>()
const play = vi.fn(function(this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve() })
async function settle() { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }) }
async function bootHls() { await settle(); await act(async () => { fake.hls.at(-1)!.emit('MANIFEST_PARSED') }); await settle() }
function video() { return document.querySelector('video')! }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.clearAllMocks(); fake.hls.length = 0; localStorage.clear()
  fake.getter = null
  Object.assign(fake.cast.status, { connected: false, settling: false })
  Object.assign(fake.cast.remote, { title: 'Receiver title', contentId: null, clockContentId: null, mediaStatusSeq: 0, isMediaLoaded: true, isPaused: false, currentTime: 0, duration: 1000, playerState: 'PLAYING', idleReason: null, updateSeq: 0 })
  fake.cast.stop.mockReset()
  fake.cast.start.mockReset(); fake.cast.loadCurrent.mockReset()
  vi.mocked(createCastToken).mockReset().mockResolvedValue({ ...castTokenFor('cast-copy', 100), segment_format: 'fmp4' })
  fake.cast.start.mockImplementation(async () => {
    const load = await fake.getter?.() as CastLoadArgs | null
    fake.cast.status.connected = true
    fake.cast.remote.contentId = load?.contentUrl ?? null
    fake.cast.remote.clockContentId = load?.contentUrl ?? null
  })
  fake.cast.loadCurrent.mockImplementation(async (at?: number) => {
    const load = await fake.getter?.(at) as CastLoadArgs | null
    if (!load) throw new Error('CAST_NO_MEDIA_ERROR')
    Object.assign(fake.cast.remote, { contentId: load.contentUrl, clockContentId: load.contentUrl, currentTime: load.startTime ?? 0, playerState: 'PLAYING', isPaused: false, idleReason: null, isMediaLoaded: true, updateSeq: fake.cast.remote.updateSeq + 1 })
  })
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

function castTokenFor(id: string, startSec = 200): Awaited<ReturnType<typeof createCastToken>> {
  return { playlist: `/api/stream/hls/${id}/master.m3u8?token=cast`, token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: startSec, segment_format: 'ts' }
}
async function connectedCast(party?: PartySync) {
  const close = vi.fn(), ended = vi.fn(async () => false)
  const element = () => <VideoPlayer target={movie} onClose={close} onEnded={ended} party={party} />
  const view = render(element()); await bootHls()
  fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle(); view.rerender(element()); await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
  return { view, element, close, ended }
}
function rejectReplacement(reason: string | null, identity: 'failed' | 'committed' | 'missing' = 'failed') {
  const committed = fake.cast.remote.contentId
  vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('failed-copy'))
  fake.cast.loadCurrent.mockImplementationOnce(async (at?: number) => {
    const load = await fake.getter?.(at) as CastLoadArgs
    Object.assign(fake.cast.remote, {
      contentId: identity === 'failed' ? load.contentUrl : identity === 'committed' ? committed : null,
      clockContentId: null,
      playerState: 'IDLE', idleReason: reason, isMediaLoaded: false, updateSeq: fake.cast.remote.updateSeq + 1,
    })
    throw new CastMediaLoadError('Receiver LOAD failed', load.contentUrl)
  })
}
async function advanceLoadWindow() { await act(async () => { vi.advanceTimersByTime(3100) }); await settle() }

describe('Cast first-release regressions through VideoPlayer', () => {
  it('offers a working Stop control for an SDK-resumed cast without a local target', async () => {
    fake.cast.status.connected = true
    const close = vi.fn(), remote = vi.fn()
    const view = render(<VideoPlayer target={null} onClose={close} onRemoteActiveChange={remote} />)
    await settle()
    expect(screen.getByRole('dialog', { name: 'Cast controls' })).toBeInTheDocument()
    expect(screen.getByText('Receiver title')).toBeInTheDocument()
    expect(remote).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('button', { name: 'Expand player' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop casting' }))
    expect(fake.cast.stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
    fake.cast.status.connected = false; view.rerender(<VideoPlayer target={null} onClose={close} onRemoteActiveChange={remote} />)
    await settle(); expect(screen.queryByRole('dialog')).toBeNull(); expect(remote).toHaveBeenLastCalledWith(false)
  })
  it('keeps remote close ownership after expanding the widget', async () => {
    const remote = vi.fn(), minimized = vi.fn(), close = vi.fn()
    const element = () => <VideoPlayer target={movie} onClose={close} onRemoteActiveChange={remote} onMinimizedChange={minimized} />
    const view = render(element()); await bootHls()
    fake.cast.status.connected = true; view.rerender(element()); await settle()
    expect(minimized).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    expect(minimized).toHaveBeenLastCalledWith(false); expect(remote).toHaveBeenLastCalledWith(true)
    fireEvent.keyDown(window, { key: 'Escape' }); await settle(); expect(close).not.toHaveBeenCalled()
  })
  it('stops local loading during Chromecast and ignores trailing local recovery errors', async () => {
    const close = vi.fn(); const element = () => <VideoPlayer target={movie} onClose={close} />
    const view = render(element()); await bootHls(); const hls = fake.hls.at(-1)!
    fake.cast.status.connected = true; view.rerender(element()); await settle()
    expect(hls.stopLoad).toHaveBeenCalled()
    await act(async () => hls.emit('ERROR', { fatal: true, type: 'networkError', response: { code: 401 } }))
    expect(hls.startLoad).not.toHaveBeenCalled(); expect(createSession).toHaveBeenCalledOnce()
    fake.cast.status.connected = false; view.rerender(element()); await settle()
    expect(hls.startLoad).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
  })
  it('restarts local loading when a party cast ends and playback returns locally', async () => {
    const party: PartySync = { isHost: true, currentUserId: 7, partyMediaItemId: 1, tickRef: { current: null }, seekRef: { current: null }, helloAbsMsRef: { current: 0 }, hlsStartSec: 0, isPlaying: false, rev: 1, requestPlay: vi.fn(), requestPause: vi.fn(), requestSeek: vi.fn() }
    const close = vi.fn(); const element = () => <VideoPlayer target={movie} onClose={close} party={party} />
    const view = render(element()); await bootHls(); const hls = fake.hls.at(-1)!
    fake.cast.status.connected = true; view.rerender(element()); await settle(); expect(hls.stopLoad).toHaveBeenCalled()
    fake.cast.status.connected = false; view.rerender(element()); await settle()
    expect(hls.startLoad).toHaveBeenCalledOnce(); expect(hls.loadSource).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled()
  })
  it('keeps AirPlay loading because its video element supplies the receiver', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls(); const hls = fake.hls.at(-1)!
    Object.defineProperty(video(), 'webkitCurrentPlaybackTargetIsWireless', { value: true, configurable: true })
    fireEvent(video(), new Event('webkitcurrentplaybacktargetiswirelesschanged')); await settle()
    expect(screen.getByText('Playing via AirPlay')).toBeInTheDocument(); expect(hls.stopLoad).not.toHaveBeenCalled()
  })
  it('does not auto-start a new local HLS loader while Chromecast is already connected', async () => {
    fake.cast.status.connected = true
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(fake.hls.at(-1)!.options.autoStartLoad).toBe(false); expect(fake.hls.at(-1)!.stopLoad).toHaveBeenCalled()
  })
  it('declares the actual server segment format in the receiver load', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(await fake.getter?.(150)).toMatchObject({ segmentFormat: 'fmp4', startTime: 50 })
  })
  it('preserves a healthy cast when a seek replacement mint fails without rebuilding local playback', async () => {
    const rebuild = vi.fn(), close = vi.fn(); const element = () => <VideoPlayer target={movie} onClose={close} onSeekRebuild={rebuild} />
    const view = render(element()); await bootHls()
    // Use the Cast button so the real pending/committed tracker is populated.
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle(); view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    vi.mocked(createCastToken).mockRejectedValueOnce(new Error('429 too many active streams'))
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.stop).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(rebuild).not.toHaveBeenCalled()
    expect(createSession).toHaveBeenCalledOnce(); expect(deleteSession).not.toHaveBeenCalledWith('cast-copy')
    expect(screen.getByText(/Could not seek on the TV/)).toBeInTheDocument()
  })
  for (const reason of ['ERROR', 'INTERRUPTED', null]) for (const identity of ['failed', 'committed', 'missing'] as const) {
    it(`retains controls/copy after rejected LOAD ${reason} with ${identity} identity and repeated idle updates`, async () => {
      const { view, element, close, ended } = await connectedCast()
      rejectReplacement(reason, identity)
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle()
      expect(deleteSession).toHaveBeenCalledWith('failed-copy')
      for (let i = 0; i < 3; i++) {
        await advanceLoadWindow()
        fake.cast.remote.updateSeq += 1; view.rerender(element()); await settle()
      }
      expect(fake.cast.stop).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
      expect(deleteSession).not.toHaveBeenCalledWith('cast-copy')
      expect(screen.getByRole('button', { name: 'Stop casting' })).toBeInTheDocument()
    })
  }
  it('can successfully retry after a rejected LOAD, ignore its late error, then handle the new item finishing', async () => {
    const { view, element, close, ended } = await connectedCast()
    rejectReplacement('ERROR')
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
    const failedId = fake.cast.remote.contentId
    vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('recovered-copy', 500))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Seek' }), { key: 'End' }); await settle(); view.rerender(element()); await settle()
    expect(fake.cast.loadCurrent).toHaveBeenLastCalledWith(1000)
    const recoveredId = fake.cast.remote.contentId
    expect(deleteSession).toHaveBeenCalledWith('cast-copy')
    expect(deleteSession).not.toHaveBeenCalledWith('recovered-copy')
    await advanceLoadWindow()
    Object.assign(fake.cast.remote, { contentId: failedId, playerState: 'IDLE', idleReason: 'ERROR', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle(); await advanceLoadWindow()
    expect(fake.cast.stop).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
    Object.assign(fake.cast.remote, { contentId: recoveredId, playerState: 'PLAYING', idleReason: null, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fake.cast.stop.mockImplementation(() => { fake.cast.status.connected = false })
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle(); view.rerender(element()); await settle()
    expect(ended).toHaveBeenCalledOnce(); expect(fake.cast.stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
    expect(deleteSession).toHaveBeenCalledWith('recovered-copy')
  })
  it('keeps failed LOAD recovery suspended on identity-less receiver updates', async () => {
    const { view, element, ended } = await connectedCast()
    rejectReplacement('ERROR', 'missing')
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
    Object.assign(fake.cast.remote, { playerState: 'PLAYING', idleReason: null, isMediaLoaded: true, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'ERROR', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    expect(fake.cast.stop).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
  })
  for (const reason of ['FINISHED', 'CANCELLED']) {
    it(`handles a later ${reason} after a rejected LOAD without advancing uncertain media`, async () => {
      const { view, element, close, ended } = await connectedCast()
      rejectReplacement('ERROR', 'missing')
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
      fake.cast.stop.mockImplementation(() => { fake.cast.status.connected = false })
      Object.assign(fake.cast.remote, { idleReason: reason, updateSeq: fake.cast.remote.updateSeq + 1 })
      view.rerender(element()); await settle(); view.rerender(element()); await settle()
      expect(fake.cast.stop).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
      expect(deleteSession).toHaveBeenCalledWith('cast-copy')
    })
  }
  for (const reason of ['FINISHED', 'CANCELLED']) {
    it(`stops the active known rejected attempt on ${reason} without completing the committed title`, async () => {
      const { view, element, ended } = await connectedCast()
      rejectReplacement('ERROR', 'failed')
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
      Object.assign(fake.cast.remote, { idleReason: reason, clockContentId: null, updateSeq: fake.cast.remote.updateSeq + 1 })
      view.rerender(element()); await settle()
      expect(fake.cast.stop).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled()
    })
  }
  for (const end of ['explicit Stop', 'disconnect']) {
    it(`releases the retained committed copy on ${end} after a failed LOAD`, async () => {
      const { view, element, close } = await connectedCast()
      rejectReplacement('ERROR')
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
      fake.cast.stop.mockImplementation(() => { fake.cast.status.connected = false })
      if (end === 'explicit Stop') fireEvent.click(screen.getByRole('button', { name: 'Stop casting' }))
      else fake.cast.status.connected = false
      view.rerender(element()); await settle()
      expect(close).toHaveBeenCalledOnce(); expect(deleteSession).toHaveBeenCalledWith('cast-copy')
    })
  }
})

it('Review: rejected replacement LOAD retains the committed cast after its idle error', async () => {
  const { view, element, close, ended } = await connectedCast()
  rejectReplacement('ERROR')
  fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle()
  expect(deleteSession).toHaveBeenCalledWith('failed-copy')
  await advanceLoadWindow()
  expect(fake.cast.stop).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
  expect(deleteSession).not.toHaveBeenCalledWith('cast-copy')
})
async function reviewRejectUnique(id: string) {
  vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor(id))
  fake.cast.loadCurrent.mockImplementationOnce(async (at?: number) => {
    const load = await fake.getter?.(at) as CastLoadArgs
    Object.assign(fake.cast.remote, { contentId: load.contentUrl, playerState: 'IDLE', idleReason: 'ERROR', isMediaLoaded: false, updateSeq: fake.cast.remote.updateSeq + 1 })
    throw new CastMediaLoadError('LOAD_FAILED', load.contentUrl)
  })
  fireEvent.keyDown(screen.getByRole('slider', { name: 'Seek' }), { key: 'End' }); await settle()
}
it('Review: a late error from the first of two failed replacements does not end the committed cast', async () => {
  const { view, element } = await connectedCast()
  await reviewRejectUnique('failed-first'); view.rerender(element()); await settle(); await advanceLoadWindow()
  const firstId = fake.cast.remote.contentId
  await reviewRejectUnique('failed-second'); view.rerender(element()); await settle(); await advanceLoadWindow()
  expect(deleteSession).toHaveBeenCalledWith('failed-first'); expect(deleteSession).toHaveBeenCalledWith('failed-second')
  expect(fake.cast.stop).not.toHaveBeenCalled()
  Object.assign(fake.cast.remote, {contentId: firstId, playerState: 'IDLE', idleReason: 'ERROR', updateSeq: fake.cast.remote.updateSeq + 1 })
  view.rerender(element()); await settle(); await advanceLoadWindow()
  expect(fake.cast.stop).not.toHaveBeenCalled()
})
it('Review: committed receiver recovery inside the settling window restores genuine error handling', async () => {
  const { view, element, ended } = await connectedCast()
  const committedId = fake.cast.remote.contentId
  rejectReplacement('ERROR')
  fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle()
  Object.assign(fake.cast.remote, {contentId: committedId, clockContentId: committedId, mediaStatusSeq: fake.cast.remote.mediaStatusSeq + 1, playerState: 'PAUSED', idleReason: null, isMediaLoaded: true, isPaused: true, updateSeq: fake.cast.remote.updateSeq + 1 })
  view.rerender(element()); await settle()
  await advanceLoadWindow()
  Object.assign(fake.cast.remote, {contentId: committedId, playerState: 'IDLE', idleReason: 'ERROR', isMediaLoaded: false, updateSeq: fake.cast.remote.updateSeq + 1 })
  view.rerender(element()); await settle(); await advanceLoadWindow()
  expect(fake.cast.stop).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled()
})

it('Review: failed replacement cannot broadcast an unacknowledged receiver timeline to the party', async () => {
  const { view, close, ended } = await connectedCast()
  const party: PartySync = {isHost:true,currentUserId:7,partyMediaItemId:1,tickRef:{current:{abs_ms:100000,server_now_ms:Date.now(), running: false}},seekRef:{current:null},helloAbsMsRef:{current:100000},hlsStartSec:0,isPlaying:false,rev:1,requestPlay:vi.fn(),requestPause:vi.fn(),requestSeek:vi.fn()}
  const element = () =>  <VideoPlayer target={movie} onClose={close} onEnded={ended} party={party}/>
  Object.assign(fake.cast.remote, { isPaused: true, playerState: 'PAUSED' })
  view.rerender(element()); await settle()
  await act(async () => {vi.advanceTimersByTime(5200)}); await settle()
  vi.mocked(party.requestPause).mockClear(); vi.mocked(party.requestSeek).mockClear()
  await reviewRejectUnique('failed-party'); view.rerender(element()); await settle()
  const failedId = fake.cast.remote.contentId
  Object.assign(fake.cast.remote, {contentId: failedId, playerState: 'PAUSED', idleReason: null, isMediaLoaded: true, isPaused: true, currentTime: 50, updateSeq: fake.cast.remote.updateSeq + 1 })
  view.rerender(element()); await settle(); await advanceLoadWindow()
  expect(fake.cast.stop).not.toHaveBeenCalled()
  expect(party.requestPause).not.toHaveBeenCalled(); expect(party.requestSeek).not.toHaveBeenCalled()
})

describe('Rejected LOAD identity and clock recovery', () => {
  it('ignores errors from both rejected items after a successful ACK, then handles a genuine committed error', async () => {
    const { view, element, ended } = await connectedCast()
    await reviewRejectUnique('rejected-a'); view.rerender(element()); await settle(); await advanceLoadWindow()
    const firstId = fake.cast.remote.contentId
    await reviewRejectUnique('rejected-b'); view.rerender(element()); await settle(); await advanceLoadWindow()
    const secondId = fake.cast.remote.contentId
    vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('retry-ack', 500))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Seek' }), { key: 'End' }); await settle()
    const committedId = fake.cast.remote.contentId
    view.rerender(element()); await settle(); await advanceLoadWindow()
    expect(deleteSession).toHaveBeenCalledWith('cast-copy')
    for (const contentId of [firstId, secondId]) for (const idleReason of ['ERROR', 'INTERRUPTED', null]) {
      Object.assign(fake.cast.remote, { contentId, playerState: 'IDLE', idleReason, updateSeq: fake.cast.remote.updateSeq + 1 })
      view.rerender(element()); await settle(); await advanceLoadWindow()
    }
    expect(fake.cast.stop).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
    expect(deleteSession).not.toHaveBeenCalledWith('retry-ack')
    Object.assign(fake.cast.remote, { contentId: committedId, clockContentId: committedId, mediaStatusSeq: fake.cast.remote.mediaStatusSeq + 1, playerState: 'PLAYING', idleReason: null, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'ERROR', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    expect(fake.cast.stop).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled()
  })

  for (const reason of ['ERROR', 'FINISHED']) {
    it(`retains quiet committed PAUSED recovery even when ${reason} arrives before settling ends`, async () => {
      const { view, element, ended } = await connectedCast()
      const committedId = fake.cast.remote.contentId
      rejectReplacement('ERROR')
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle()
      Object.assign(fake.cast.remote, { contentId: committedId, clockContentId: committedId, mediaStatusSeq: fake.cast.remote.mediaStatusSeq + 1, playerState: 'PAUSED', isPaused: true, isMediaLoaded: true, idleReason: null, updateSeq: fake.cast.remote.updateSeq + 1 })
      view.rerender(element()); await settle()
      Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: reason, mediaStatusSeq: fake.cast.remote.mediaStatusSeq + 1, updateSeq: fake.cast.remote.updateSeq + 1 })
      view.rerender(element()); await settle(); await advanceLoadWindow()
      expect(fake.cast.stop).toHaveBeenCalledOnce()
      expect(ended).toHaveBeenCalledTimes(reason === 'FINISHED' ? 1 : 0)
    })
  }

  it('does not advance the committed title after identity-less PLAYING then FINISHED', async () => {
    const { view, element, ended } = await connectedCast()
    rejectReplacement('ERROR', 'missing')
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
    Object.assign(fake.cast.remote, { playerState: 'PLAYING', isPaused: false, isMediaLoaded: true, idleReason: null, currentTime: 20, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fake.cast.loadCurrent.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' }))
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Seek' }), { key: 'ArrowRight' })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Seek' }), { key: 'PageUp' }); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled(); expect(fake.cast.seek).not.toHaveBeenCalled()
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    expect(fake.cast.stop).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled()
  })

  it('promotes the receiver URI across a target change without promoting its old anchor', async () => {
    let target = movie
    const ended = vi.fn(async () => false)
    const element = () => <VideoPlayer target={target} onClose={() => {}} onEnded={ended} />
    const view = render(element()); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle(); view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    rejectReplacement('ERROR')
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
    vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('cross-epoch', 500))
    let acknowledge!: () => void
    fake.cast.loadCurrent.mockImplementationOnce(async (at?: number) => {
      const load = await fake.getter?.(at) as CastLoadArgs
      Object.assign(fake.cast.remote, { contentId: load.contentUrl, playerState: 'PLAYING', isMediaLoaded: true, idleReason: null, updateSeq: fake.cast.remote.updateSeq + 1 })
      await new Promise<void>(resolve => { acknowledge = resolve })
    })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Seek' }), { key: 'End' }); await settle()
    target = { ...movie, fileId: 11, title: 'Different target' }; view.rerender(element()); await bootHls()
    await act(async () => { acknowledge() }); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
    fireEvent.mouseMove(screen.getByRole('dialog', { name: 'Playing Different target' })); await settle()
    fake.cast.loadCurrent.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); fireEvent.keyDown(window, { key: 'ArrowRight' }); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'ERROR', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    expect(fake.cast.stop).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled()
  })

  function makeParty(isHost: boolean): PartySync {
    return { isHost, currentUserId: 7, partyMediaItemId: 1, partyEpisodeId: null, isPlaying: !isHost, rev: 1, hlsStartSec: 0,
      tickRef: { current: { abs_ms: 600000, server_now_ms: Date.now(), running: false, receivedAtMs: Date.now() } },
      seekRef: { current: null }, helloAbsMsRef: { current: 600000 }, requestPlay: vi.fn(), requestPause: vi.fn(), requestSeek: vi.fn() }
  }
  async function rejectPartyLoad(isHost: boolean) {
    const party = makeParty(isHost)
    const first = castTokenFor('party-original', 100); first.expires_at = 1
    vi.mocked(createCastToken).mockResolvedValueOnce(first)
    fake.cast.start.mockImplementation(async () => {
      const load = await fake.getter?.() as CastLoadArgs
      fake.cast.status.connected = true
      Object.assign(fake.cast.remote, { contentId: load.contentUrl, currentTime: load.startTime, playerState: isHost ? 'PAUSED' : 'PLAYING', isPaused: isHost, updateSeq: 1 })
    })
    const connected = await connectedCast(party)
    const committedId = fake.cast.remote.contentId
    await advanceLoadWindow()
    // A fresh rejected token must not mask the expired committed receiver URL.
    const failed = castTokenFor('party-failed', 580); failed.expires_at = 9999999999
    vi.mocked(createCastToken).mockResolvedValueOnce(failed)
    fake.cast.loadCurrent.mockImplementationOnce(async (at?: number) => {
      const load = await fake.getter?.(at) as CastLoadArgs
      expect(at).toBe(600); expect(load.startTime).toBe(20)
      Object.assign(fake.cast.remote, { contentId: load.contentUrl, currentTime: 20, playerState: isHost ? 'PAUSED' : 'PLAYING', isPaused: isHost, isMediaLoaded: true, updateSeq: 2 })
      throw new CastMediaLoadError('LOAD timed out', load.contentUrl)
    })
    // Both a host and guest may deliberately resume their receiver. The
    // canonical room position is the renewal intent; automatic actions wait.
    Object.assign(fake.cast.remote, { playerState: 'PAUSED', isPaused: true })
    connected.view.rerender(connected.element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle(); connected.view.rerender(connected.element()); await settle()
    vi.mocked(party.requestPlay).mockClear(); vi.mocked(party.requestPause).mockClear(); vi.mocked(party.requestSeek).mockClear()
    fake.cast.loadCurrent.mockClear(); fake.cast.playOrPause.mockClear(); fake.cast.seek.mockClear()
    return { ...connected, party, committedId }
  }

  it('keeps host broadcasts quiet, retries at canonical position, then trusts the acknowledged new anchor', async () => {
    const { view, element, party } = await rejectPartyLoad(true)
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(party.requestPause).not.toHaveBeenCalled(); expect(party.requestSeek).not.toHaveBeenCalled(); expect(party.requestPlay).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); fireEvent.keyDown(window, { key: 'ArrowRight' }); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('party-retry', 590))
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle(); view.rerender(element()); await settle()
    expect(fake.cast.loadCurrent).toHaveBeenLastCalledWith(600)
    Object.assign(fake.cast.remote, { currentTime: 10, playerState: 'PAUSED', isPaused: true, updateSeq: 3 }); view.rerender(element()); await settle()
    await act(async () => { vi.advanceTimersByTime(4000) }); await settle()
    vi.mocked(party.requestPause).mockClear()
    Object.assign(fake.cast.remote, { currentTime: 20, updateSeq: 4 }); view.rerender(element()); await settle()
    await act(async () => { vi.advanceTimersByTime(1000) }); await settle()
    expect(party.requestPause).toHaveBeenCalledWith(610000)
  })

  it('keeps guest corrections quiet through identity-less PLAYING, then recovers only at a fresh committed URI', async () => {
    const { view, element, party, committedId } = await rejectPartyLoad(false)
    const poll = async (count: number) => {
      for (let i = 0; i < count; i++) {
        party.tickRef.current = { abs_ms: 700000, server_now_ms: Date.now(), running: true, receivedAtMs: Date.now() }
        await act(async () => { vi.advanceTimersByTime(1000) }); await settle()
      }
    }
    await poll(10)
    expect(fake.cast.seek).not.toHaveBeenCalled(); expect(fake.cast.playOrPause).not.toHaveBeenCalled(); expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    Object.assign(fake.cast.remote, { contentId: null, updateSeq: 3 }); view.rerender(element()); await settle(); await poll(3)
    expect(fake.cast.seek).not.toHaveBeenCalled(); expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    Object.assign(fake.cast.remote, { contentId: committedId, clockContentId: committedId, mediaStatusSeq: fake.cast.remote.mediaStatusSeq + 1, currentTime: 500, updateSeq: 4 }); view.rerender(element()); await settle(); await poll(4)
    expect(fake.cast.loadCurrent.mock.calls.at(-1)?.[0]).toBeCloseTo(701, 0)
    expect(fake.cast.seek).not.toHaveBeenCalled()
  })

  it('does not renew from the unacknowledged clock when a party has no canonical tick', async () => {
    const { view, element, party } = await rejectPartyLoad(true)
    party.tickRef.current = null
    await advanceLoadWindow(); view.rerender(element()); await settle()
    fireEvent.keyDown(window, { key: 'k' }); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled(); expect(fake.cast.playOrPause).toHaveBeenCalledOnce()
  })

  for (const anchor of [undefined, NaN, -1]) {
    it(`declines clock-based actions for ${String(anchor)} anchor while acknowledged FINISHED still works`, async () => {
      const party = makeParty(true)
      const response = castTokenFor('unproven-anchor'); response.start_sec = anchor; response.expires_at = 1
      vi.mocked(createCastToken).mockResolvedValueOnce(response)
      const { view, element, ended } = await connectedCast(party)
      Object.assign(fake.cast.remote, { currentTime: 20, isPaused: true, playerState: 'PAUSED', updateSeq: 1 }); view.rerender(element()); await settle(); await advanceLoadWindow()
      expect(party.requestPause).not.toHaveBeenCalled(); expect(party.requestSeek).not.toHaveBeenCalled(); expect(fake.cast.seek).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); fireEvent.keyDown(window, { key: 'ArrowRight' }); await settle()
      expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
      party.tickRef.current = null
      fireEvent.keyDown(window, { key: 'k' }); await settle()
      expect(fake.cast.loadCurrent).not.toHaveBeenCalled(); expect(fake.cast.playOrPause).toHaveBeenCalledOnce()
      Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', updateSeq: 2 }); view.rerender(element()); await settle()
      expect(ended).toHaveBeenCalledOnce(); expect(fake.cast.stop).toHaveBeenCalledOnce()
    })
  }
  it('keeps a proven zero anchor usable for receiver-relative intent', async () => {
    vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('zero-anchor', 0))
    const { view, element } = await connectedCast()
    Object.assign(fake.cast.remote, { currentTime: 500, updateSeq: 1 }); view.rerender(element()); await settle()
    vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('zero-anchor-next', 500))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Seek' }), { key: 'ArrowRight' }); await settle()
    expect(fake.cast.loadCurrent).toHaveBeenLastCalledWith(510)
  })
  it('can replace an unproven-anchor cast using an explicit absolute zero intent', async () => {
    const legacy = castTokenFor('legacy-anchor'); delete legacy.start_sec
    vi.mocked(createCastToken).mockResolvedValueOnce(legacy)
    const { view, element } = await connectedCast(); await advanceLoadWindow()
    vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('proven-anchor', 0))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Seek' }), { key: 'Home' }); await settle(); view.rerender(element()); await settle()
    expect(fake.cast.loadCurrent).toHaveBeenLastCalledWith(0)
    expect(deleteSession).toHaveBeenCalledWith('legacy-anchor')
    expect(deleteSession).not.toHaveBeenCalledWith('proven-anchor')
  })
})

it('Independent 6c: committed idle error does not prove the clock of subsequent identity-less media', async()=>{
  const {view,element}=await connectedCast()
  const committedId=fake.cast.remote.contentId
  rejectReplacement('ERROR','committed')
  fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'})); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
  Object.assign(fake.cast.remote,{contentId:committedId,playerState:'IDLE',idleReason:'ERROR',isMediaLoaded:false,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element()); await settle()
  Object.assign(fake.cast.remote,{contentId:null,playerState:'PAUSED',idleReason:null,isMediaLoaded:true,isPaused:true,currentTime:50,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element()); await settle()
  fake.cast.loadCurrent.mockClear(); fake.cast.seek.mockClear()
  fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'})); await settle()
  expect(fake.cast.loadCurrent).not.toHaveBeenCalled(); expect(fake.cast.seek).not.toHaveBeenCalled()
})
it('Independent 6c: FINISHED for a load acknowledged across an epoch must not advance the new target', async()=>{
  let target=movie
  const ended=vi.fn(async()=>false)
  const element=()=> <VideoPlayer target={target} onClose={()=>{}} onEnded={ended}/>
  const view=render(element()); await bootHls()
  fireEvent.click(screen.getByRole('button',{name:'Cast'})); await settle(); view.rerender(element()); await settle()
  fireEvent.click(screen.getByRole('button',{name:'Expand player'})); await settle(); await advanceLoadWindow()
  vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('epoch-pending',500))
  let ack!:()=>void
  fake.cast.loadCurrent.mockImplementationOnce(async(at?:number)=>{
    const load=await fake.getter?.(at) as CastLoadArgs
    Object.assign(fake.cast.remote,{contentId:load.contentUrl,playerState:'PLAYING',isMediaLoaded:true,idleReason:null,updateSeq:fake.cast.remote.updateSeq+1})
    await new Promise<void>(resolve=>{ack=resolve})
  })
  fireEvent.keyDown(screen.getByRole('slider',{name:'Seek'}),{key:'End'}); await settle()
  target={...movie,mediaItemId:2,fileId:11,title:'Different target'}; view.rerender(element()); await bootHls()
  await act(async()=>{ack()}); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
  Object.assign(fake.cast.remote,{playerState:'PLAYING',updateSeq:fake.cast.remote.updateSeq+1});view.rerender(element());await settle()
  Object.assign(fake.cast.remote,{playerState:'IDLE',idleReason:'FINISHED',updateSeq:fake.cast.remote.updateSeq+1});view.rerender(element());await settle();await advanceLoadWindow()
  expect(ended).not.toHaveBeenCalled();expect(fake.cast.stop).toHaveBeenCalledOnce()
})

it('Independent 6c: idle URI cannot reopen automatic party correction for later unidentified media', async()=>{
  const {view,close,ended}=await connectedCast()
  const committedId=fake.cast.remote.contentId
  const party:PartySync={isHost:true,currentUserId:7,partyMediaItemId:1,tickRef:{current:{abs_ms:100000,server_now_ms:Date.now(),running:false}},seekRef:{current:null},helloAbsMsRef:{current:100000},hlsStartSec:0,isPlaying:false,rev:1,requestPlay:vi.fn(),requestPause:vi.fn(),requestSeek:vi.fn()}
  const element=()=> <VideoPlayer target={movie} onClose={close} onEnded={ended} party={party}/>
  Object.assign(fake.cast.remote,{isPaused:true,playerState:'PAUSED'})
  view.rerender(element()); await settle(); await act(async()=>{vi.advanceTimersByTime(5200)}); await settle()
  rejectReplacement('ERROR','committed')
  fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle();view.rerender(element());await settle();await advanceLoadWindow()
  Object.assign(fake.cast.remote,{contentId:committedId,playerState:'IDLE',idleReason:'ERROR',isMediaLoaded:false,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle()
  Object.assign(fake.cast.remote,{contentId:null,playerState:'PAUSED',idleReason:null,isMediaLoaded:true,isPaused:true,currentTime:50,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle()
  fake.cast.seek.mockClear();fake.cast.loadCurrent.mockClear();fake.cast.playOrPause.mockClear();vi.mocked(party.requestPause).mockClear();vi.mocked(party.requestSeek).mockClear()
  await act(async()=>{vi.advanceTimersByTime(6200)});await settle()
  expect(fake.cast.seek).not.toHaveBeenCalled();expect(fake.cast.loadCurrent).not.toHaveBeenCalled();expect(fake.cast.playOrPause).not.toHaveBeenCalled()
  expect(party.requestPause).not.toHaveBeenCalled();expect(party.requestSeek).not.toHaveBeenCalled()
})
it('Independent 6c: a loaded committed paused recovery legitimately restores relative controls', async()=>{
  const {view,element}=await connectedCast()
  const committedId=fake.cast.remote.contentId
  rejectReplacement('ERROR','committed')
  fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle();view.rerender(element());await settle();await advanceLoadWindow()
  Object.assign(fake.cast.remote,{contentId:committedId,clockContentId:committedId,mediaStatusSeq:fake.cast.remote.mediaStatusSeq+1,playerState:'PAUSED',idleReason:null,isMediaLoaded:true,isPaused:true,currentTime:50,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle();fake.cast.loadCurrent.mockClear()
  fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
  expect(fake.cast.loadCurrent).toHaveBeenCalledExactlyOnceWith(160)
})

describe('Acknowledged receiver ownership and expiry', () => {
  it('does not let a fresh rejected token mask the expired committed receiver URL', async () => {
    const first = castTokenFor('expired-committed', 100); first.expires_at = 1
    vi.mocked(createCastToken).mockResolvedValueOnce(first)
    const { view, element } = await connectedCast()
    const committedId = fake.cast.remote.contentId
    rejectReplacement('ERROR', 'committed')
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
    Object.assign(fake.cast.remote, { contentId: committedId, clockContentId: committedId, mediaStatusSeq: fake.cast.remote.mediaStatusSeq + 1, currentTime: 500, playerState: 'PAUSED', isPaused: true, isMediaLoaded: true, idleReason: null, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fake.cast.loadCurrent.mockClear(); fake.cast.playOrPause.mockClear()
    vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('renewed-ack', 585))
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle()
    expect(fake.cast.loadCurrent).toHaveBeenCalledExactlyOnceWith(600)
    expect(fake.cast.playOrPause).not.toHaveBeenCalled()
    view.rerender(element()); await settle(); await advanceLoadWindow()
    Object.assign(fake.cast.remote, { currentTime: 20, isPaused: true, playerState: 'PAUSED', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle()
    // The successfully acknowledged fresh token now permits native resume.
    expect(fake.cast.loadCurrent).toHaveBeenCalledTimes(1); expect(fake.cast.playOrPause).toHaveBeenCalledOnce()
  })

  for (const change of ['file', 'profile'] as const) {
    it(`does not complete a different ${change} owner when target change and FINISHED share a render`, async () => {
      let target = movie, profileId = 7
      const oldEnded = vi.fn(async () => false), newEnded = vi.fn(async () => false)
      let ended = oldEnded
      const element = () => <VideoPlayer target={target} profileId={profileId} onClose={() => {}} onEnded={ended} />
      const view = render(element()); await bootHls()
      fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
      if (change === 'file') target = { ...movie, mediaItemId: 2, fileId: 11, title: 'Next owner' }
      else profileId = 8
      ended = newEnded
      Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', updateSeq: fake.cast.remote.updateSeq + 1 })
      view.rerender(element()); await settle()
      expect(oldEnded).not.toHaveBeenCalled(); expect(newEnded).not.toHaveBeenCalled(); expect(fake.cast.stop).toHaveBeenCalledOnce()
    })
  }

  it('still completes the acknowledged source when only its display title changes', async () => {
    let target = movie
    const ended = vi.fn(async () => false)
    const element = () => <VideoPlayer target={target} onClose={() => {}} onEnded={ended} />
    const view = render(element()); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
    target = { ...movie, title: 'Updated display title' }
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    expect(ended).toHaveBeenCalledOnce(); expect(fake.cast.stop).toHaveBeenCalledOnce()
  })

  it('keeps deferred healthy identity proof for FINISHED without restoring an unloaded clock', async () => {
    const { view, element, ended } = await connectedCast()
    const committedId = fake.cast.remote.contentId
    rejectReplacement('ERROR')
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle()
    Object.assign(fake.cast.remote, { contentId: committedId, clockContentId: committedId, mediaStatusSeq: fake.cast.remote.mediaStatusSeq + 1, playerState: 'PAUSED', isPaused: true, isMediaLoaded: true, idleReason: null, currentTime: 50, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'ERROR', isMediaLoaded: false, mediaStatusSeq: fake.cast.remote.mediaStatusSeq + 1, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fake.cast.loadCurrent.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    // Positive loaded proof belongs to the committed media. Its subsequent
    // natural FINISHED can complete after settlement, even if CAF unloaded it.
    Object.assign(fake.cast.remote, { idleReason: 'FINISHED', mediaStatusSeq: fake.cast.remote.mediaStatusSeq + 1, updateSeq: fake.cast.remote.updateSeq + 1 }); view.rerender(element()); await settle(); await advanceLoadWindow()
    expect(ended).toHaveBeenCalledOnce(); expect(fake.cast.stop).toHaveBeenCalledOnce()
  })
})

describe('Successful ACK and receiver status association', () => {
  async function renewWithOutgoingStatus(inParty = false, identifyOutgoing = false, incomingBeforeAck: false | 'exact' | 'missing' = false) {
    const target = { ...movie, resumePositionMs: 600000 }
    const party: PartySync = {
      isHost: true, currentUserId: 7, partyMediaItemId: 1, partyEpisodeId: null,
      isPlaying: false, rev: 1, hlsStartSec: 0,
      tickRef: { current: { abs_ms: 600000, server_now_ms: Date.now(), running: false, receivedAtMs: Date.now() } },
      seekRef: { current: null }, helloAbsMsRef: { current: 600000 },
      requestPlay: vi.fn(), requestPause: vi.fn(), requestSeek: vi.fn(),
    }
    const first = castTokenFor('ack-old', 100); first.expires_at = 1
    const next = castTokenFor('ack-new', 580)
    const firstId = `http://localhost:3000${first.playlist}`
    const nextId = `http://localhost:3000${next.playlist}`
    vi.mocked(createCastToken).mockResolvedValueOnce(first)
    fake.cast.start.mockImplementationOnce(async () => {
      const load = await fake.getter?.() as CastLoadArgs
      expect(load.startTime).toBe(500)
      fake.cast.status.connected = true
      Object.assign(fake.cast.remote, { contentId: firstId, clockContentId: firstId, currentTime: 499, playerState: 'PLAYING', isPaused: false, updateSeq: 1 })
    })
    const ended = vi.fn(async () => false)
    const element = () => <VideoPlayer target={target} onClose={() => {}} onEnded={ended} party={inParty ? party : undefined} />
    const view = render(element()); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle(); view.rerender(element()); await settle()
    // The first load has already delivered a fresh, healthy receiver status.
    // Only the renewal below deliberately withholds its new status past ACK.
    Object.assign(fake.cast.remote, { currentTime: 500, playerState: 'PAUSED', isPaused: true, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle(); await advanceLoadWindow()
    let acknowledge!: () => void
    vi.mocked(createCastToken).mockResolvedValueOnce(next)
    fake.cast.loadCurrent.mockImplementationOnce(async (at?: number) => {
      const load = await fake.getter?.(at) as CastLoadArgs
      expect(at).toBe(600); expect(load.startTime).toBe(20)
      if (incomingBeforeAck) {
        Object.assign(fake.cast.remote, { contentId: incomingBeforeAck === 'exact' ? nextId : null, clockContentId: incomingBeforeAck === 'exact' ? nextId : null, currentTime: 20, playerState: 'PLAYING', isPaused: false, updateSeq: fake.cast.remote.updateSeq + 1 })
      } else {
        Object.assign(fake.cast.remote, { contentId: identifyOutgoing ? firstId : null, clockContentId: null })
      }
      await new Promise<void>(resolve => { acknowledge = resolve })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle()
    // LOAD succeeds before CAF publishes the incoming media status. The
    // unchanged PAUSED@500 snapshot still belongs to the outgoing anchor100.
    await act(async () => { acknowledge() }); await settle(); view.rerender(element()); await settle()
    fake.cast.loadCurrent.mockClear(); fake.cast.seek.mockClear()
    vi.mocked(party.requestPause).mockClear(); vi.mocked(party.requestSeek).mockClear(); vi.mocked(party.requestPlay).mockClear()
    return { view, element, party, ended, firstId, nextId }
  }

  for (const mode of ['button', 'keyboard', 'slider'] as const) {
    it(`declines ${mode} relative input against an unchanged outgoing optional-identity status after ACK`, async () => {
      await renewWithOutgoingStatus()
      fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
      const skip = () => {
        if (mode === 'button') fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' }))
        else if (mode === 'keyboard') fireEvent.keyDown(document, { key: 'ArrowRight' })
        else fireEvent.keyDown(screen.getByRole('slider', { name: 'Seek' }), { key: 'ArrowRight' })
      }
      skip(); await settle()
      expect(fake.cast.loadCurrent).not.toHaveBeenCalled(); expect(fake.cast.seek).not.toHaveBeenCalled()
      await advanceLoadWindow()
      skip(); await settle()
      // Elapsed load settlement alone cannot make the same status a new clock.
      expect(fake.cast.loadCurrent).not.toHaveBeenCalled(); expect(fake.cast.seek).not.toHaveBeenCalled()
    })
  }

  it('keeps host broadcasts and corrections quiet until the incoming media status arrives', async () => {
    const { party } = await renewWithOutgoingStatus(true)
    await act(async () => { vi.advanceTimersByTime(1000) }); await settle()
    expect(party.requestPause).not.toHaveBeenCalled(); expect(party.requestSeek).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(6000) }); await settle()
    expect(party.requestPause).not.toHaveBeenCalled(); expect(party.requestSeek).not.toHaveBeenCalled()
    expect(fake.cast.seek).not.toHaveBeenCalled(); expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
  })
  for (const role of ['host', 'guest'] as const) {
    it(`keeps ${role} party clocks and actions quiet when the incoming URI lacks a coherent clock`, async () => {
      const { view, element, party, nextId } = await renewWithOutgoingStatus(true)
      party.isHost = role === 'host'
      Object.assign(fake.cast.remote, { contentId: nextId, clockContentId: null, currentTime: 500, playerState: 'PLAYING', isPaused: false, updateSeq: fake.cast.remote.updateSeq + 1 })
      view.rerender(element()); await settle(); fake.cast.playOrPause.mockClear()
      for (let i = 0; i < 8; i++) {
        party.tickRef.current = { abs_ms: 600000, server_now_ms: Date.now(), running: false, receivedAtMs: Date.now() }
        await act(async () => { vi.advanceTimersByTime(1000) }); await settle()
      }
      expect(party.requestPause).not.toHaveBeenCalled(); expect(party.requestSeek).not.toHaveBeenCalled(); expect(party.requestPlay).not.toHaveBeenCalled()
      expect(fake.cast.seek).not.toHaveBeenCalled(); expect(fake.cast.loadCurrent).not.toHaveBeenCalled(); expect(fake.cast.playOrPause).not.toHaveBeenCalled()
    })
  }

  it('does not let volume-only ANY_CHANGE sequences bless the unchanged outgoing clock', async () => {
    const { view, element } = await renewWithOutgoingStatus()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    // useCast increments updateSeq for volume/mute mutations too, although
    // none of the media/clock fields in its atomic snapshot have changed.
    for (let i = 0; i < 3; i++) {
      fake.cast.remote.updateSeq += 1; view.rerender(element()); await settle(); await advanceLoadWindow()
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
      expect(fake.cast.loadCurrent).not.toHaveBeenCalled(); expect(fake.cast.seek).not.toHaveBeenCalled()
    }
  })

  it('does not let a delayed outgoing PLAYING clock become the incoming anchored clock', async () => {
    const { view, element } = await renewWithOutgoingStatus()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    Object.assign(fake.cast.remote, { currentTime: 500.1, playerState: 'PLAYING', isPaused: false, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle(); await advanceLoadWindow()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled(); expect(fake.cast.seek).not.toHaveBeenCalled()
  })

  it('also declines an existing TV clock discovered during the initial device picker', async () => {
    const target = { ...movie, resumePositionMs: 200000 }
    vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('picker-new', 100))
    fake.cast.start.mockImplementationOnce(async () => {
      const load = await fake.getter?.() as CastLoadArgs
      expect(load.startTime).toBe(100)
      // The pre-picker sender was disconnected. requestSession joined a TV
      // already playing another item, whose cached clock outlives this ACK.
      fake.cast.status.connected = true
      Object.assign(fake.cast.remote, { contentId: null, playerState: 'PAUSED', isPaused: true, currentTime: 500, updateSeq: 1 })
    })
    const element = () => <VideoPlayer target={target} onClose={() => {}} />
    const view = render(element()); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle(); view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    Object.assign(fake.cast.remote, { playerState: 'PLAYING', isPaused: false, currentTime: 500.1, updateSeq: 2 })
    view.rerender(element()); await settle(); await advanceLoadWindow()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    const incomingId = 'http://localhost:3000/api/stream/hls/picker-new/master.m3u8?token=cast'
    Object.assign(fake.cast.remote, { contentId: incomingId, clockContentId: incomingId, currentTime: 100, updateSeq: 3 })
    view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).toHaveBeenCalledExactlyOnceWith(210)
  })

  for (const identity of ['exact', 'missing'] as const) {
    it(`uses fresh healthy ${identity} incoming status only when the clock has coherent media identity`, async () => {
      const { view, element, nextId } = await renewWithOutgoingStatus()
      fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
      Object.assign(fake.cast.remote, { contentId: identity === 'exact' ? nextId : null, clockContentId: identity === 'exact' ? nextId : null, currentTime: 20, playerState: 'PLAYING', isPaused: false, updateSeq: fake.cast.remote.updateSeq + 1 })
      view.rerender(element()); await settle()
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
      if (identity === 'exact') expect(fake.cast.loadCurrent).toHaveBeenCalledExactlyOnceWith(610)
      else expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    })
  }

  it('accepts an exact healthy incoming URI whose status arrived before its ACK', async () => {
    await renewWithOutgoingStatus(false, false, 'exact')
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).toHaveBeenCalledExactlyOnceWith(610)
  })

  it('declines clocks when a later snapshot loses coherent media identity', async () => {
    const { view, element } = await renewWithOutgoingStatus(false, false, 'exact')
    Object.assign(fake.cast.remote, { contentId: null, clockContentId: null, currentTime: 20, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
  })

  it('does not associate a legacy unchanged clock near the request through volume or state-only updates', async () => {
    const { view, element } = await renewWithOutgoingStatus(false, false, 'missing')
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    fake.cast.remote.updateSeq += 1; view.rerender(element()); await settle(); await advanceLoadWindow()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    Object.assign(fake.cast.remote, { playerState: 'PAUSED', isPaused: true, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    Object.assign(fake.cast.remote, { currentTime: 20.25, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    const incomingId = 'http://localhost:3000/api/stream/hls/ack-new/master.m3u8?token=cast'
    Object.assign(fake.cast.remote, { contentId: incomingId, clockContentId: incomingId, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).toHaveBeenCalledExactlyOnceWith(610.25)
  })

  it('keeps acknowledged identity-only FINISHED independent of healthy clock association', async () => {
    const { view, element, ended, nextId } = await renewWithOutgoingStatus()
    // No incoming healthy clock snapshot ever arrived. Explicit completion
    // can still belong to the acknowledged media without a usable clock.
    Object.assign(fake.cast.remote, { contentId: nextId, clockContentId: null, playerState: 'IDLE', idleReason: 'FINISHED', isMediaLoaded: false, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle(); await advanceLoadWindow()
    expect(ended).toHaveBeenCalledOnce(); expect(fake.cast.stop).toHaveBeenCalledOnce()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
  })

  it('declines a known outgoing URI even after newer updates and restores controls for the incoming URI', async () => {
    const { view, element, firstId, nextId } = await renewWithOutgoingStatus(false, true)
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    Object.assign(fake.cast.remote, { contentId: firstId, currentTime: 500, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle(); await advanceLoadWindow()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
    Object.assign(fake.cast.remote, { contentId: nextId, clockContentId: nextId, currentTime: 20, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(fake.cast.loadCurrent).toHaveBeenCalledExactlyOnceWith(610)
  })
})

it('Independent 051 boundary: outgoing drift near the requested legacy start does not prove new clock association',async()=>{
  const {view,element}=await connectedCast()
  Object.assign(fake.cast.remote,{currentTime:19,playerState:'PLAYING',isPaused:false,isMediaLoaded:true,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle();await advanceLoadWindow()
  vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('near-start-new',164))
  let ack!:()=>void
  fake.cast.loadCurrent.mockImplementationOnce(async(at?:number)=>{
    const load=await fake.getter?.(at) as CastLoadArgs
    expect(at).toBe(179);expect(load.startTime).toBe(15)
    Object.assign(fake.cast.remote,{contentId:null})
    await new Promise<void>(resolve=>{ack=resolve})
  })
  fireEvent.keyDown(screen.getByRole('slider',{name:'Seek'}),{key:'PageUp'});await settle()
  await act(async()=>{ack()});await settle();view.rerender(element());await settle();await advanceLoadWindow()
  Object.assign(fake.cast.remote,{currentTime:19.25,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle();fake.cast.loadCurrent.mockClear()
  fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
  expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
})
it('Independent 051 boundary: incoming URI only cannot pair the outgoing clock with the new anchor',async()=>{
  const {view,element}=await connectedCast()
  Object.assign(fake.cast.remote,{currentTime:500,playerState:'PLAYING',isPaused:false,isMediaLoaded:true,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle();await advanceLoadWindow()
  vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('uri-only-new',645))
  let incomingId:string
  let ack!:()=>void
  fake.cast.loadCurrent.mockImplementationOnce(async(at?:number)=>{
    const load=await fake.getter?.(at) as CastLoadArgs
    expect(at).toBe(660);expect(load.startTime).toBe(15)
    incomingId=load.contentUrl
    await new Promise<void>(resolve=>{ack=resolve})
  })
  fireEvent.keyDown(screen.getByRole('slider',{name:'Seek'}),{key:'PageUp'});await settle()
  await act(async()=>{ack()});await settle();view.rerender(element());await settle()
  fake.cast.loadCurrent.mockClear()
  Object.assign(fake.cast.remote,{contentId:incomingId!,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle()
  fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
  expect(fake.cast.loadCurrent).not.toHaveBeenCalled()
})

for (const reason of ['FINISHED', 'ERROR', 'CANCELLED', 'INTERRUPTED', null] as const) it(`Independent 051 terminal boundary: stale outgoing ${reason} after a healthy successful replacement is ignored`,async()=>{
  const {view,element,ended}=await connectedCast()
  const oldId=fake.cast.remote.contentId
  Object.assign(fake.cast.remote,{currentTime:500,playerState:'PLAYING',isPaused:false,isMediaLoaded:true,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle();await advanceLoadWindow()
  vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('healthy-replacement',645))
  fireEvent.keyDown(screen.getByRole('slider',{name:'Seek'}),{key:'PageUp'});await settle();view.rerender(element());await settle();await advanceLoadWindow()
  expect(fake.cast.remote.contentId).not.toBe(oldId)
  expect(fake.cast.remote.currentTime).toBe(15)
  Object.assign(fake.cast.remote,{contentId:oldId,playerState:'IDLE',idleReason:reason,isMediaLoaded:false,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle();await advanceLoadWindow()
  expect(ended).not.toHaveBeenCalled();expect(fake.cast.stop).not.toHaveBeenCalled()
})
it('Independent 051 terminal inverse: genuine committed FINISHED without a healthy clock still ends the current item',async()=>{
  const {view,element,ended}=await connectedCast()
  Object.assign(fake.cast.remote,{currentTime:500,playerState:'PLAYING',isPaused:false,isMediaLoaded:true,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle();await advanceLoadWindow()
  vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('healthy-replacement',645))
  fireEvent.keyDown(screen.getByRole('slider',{name:'Seek'}),{key:'PageUp'});await settle();view.rerender(element());await settle();await advanceLoadWindow()
  Object.assign(fake.cast.remote,{playerState:'IDLE',idleReason:'FINISHED',isMediaLoaded:false,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle();await advanceLoadWindow()
  expect(ended).toHaveBeenCalledOnce();expect(fake.cast.stop).toHaveBeenCalledOnce()
})
it('Independent 051 recovery inverse: coherent Media PAUSED clock delivered before ACK survives an unchanged later snapshot',async()=>{
  const {view,element}=await connectedCast()
  Object.assign(fake.cast.remote,{currentTime:500,playerState:'PLAYING',isPaused:false,isMediaLoaded:true,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle();await advanceLoadWindow()
  vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('fresh-paused-legacy',645))
  let ack!:()=>void
  let incomingId!:string
  fake.cast.loadCurrent.mockImplementationOnce(async(at?:number)=>{
    const load=await fake.getter?.(at) as CastLoadArgs
    expect(at).toBe(660);expect(load.startTime).toBe(15)
    incomingId=load.contentUrl
    await new Promise<void>(resolve=>{ack=resolve})
  })
  fireEvent.keyDown(screen.getByRole('slider',{name:'Seek'}),{key:'PageUp'});await settle()
  Object.assign(fake.cast.remote,{contentId:incomingId,clockContentId:incomingId,currentTime:15,playerState:'PAUSED',isPaused:true,isMediaLoaded:true,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle()
  await act(async()=>{ack()});await settle();view.rerender(element());await settle();await advanceLoadWindow()
  fake.cast.loadCurrent.mockClear()
  fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle()
  expect(fake.cast.loadCurrent).toHaveBeenCalledExactlyOnceWith(670)
})

for(const reason of ['FINISHED','CANCELLED'] as const) it(`Independent 4cf retry terminal: the previous rejected ${reason} cannot stop a newer in-flight LOAD`,async()=>{
  const {view,element,ended}=await connectedCast()
  rejectReplacement('ERROR')
  fireEvent.click(screen.getByRole('button',{name:'Skip forward 10 seconds'}));await settle();view.rerender(element());await settle();await advanceLoadWindow()
  const failedURI=fake.cast.remote.contentId
  vi.mocked(createCastToken).mockResolvedValueOnce(castTokenFor('pending-newer-retry',645))
  let incomingURI!:string;let ack!:()=>void
  fake.cast.loadCurrent.mockImplementationOnce(async(at?:number)=>{
    const load=await fake.getter?.(at) as CastLoadArgs
    incomingURI=load.contentUrl
    await new Promise<void>(resolve=>{ack=resolve})
  })
  fireEvent.keyDown(screen.getByRole('slider',{name:'Seek'}),{key:'End'});await settle()
  expect(incomingURI).toContain('pending-newer-retry')
  Object.assign(fake.cast.remote,{contentId:failedURI,clockContentId:null,playerState:'IDLE',idleReason:reason,isMediaLoaded:false,updateSeq:fake.cast.remote.updateSeq+1})
  view.rerender(element());await settle()
  const stopsBeforeACK=fake.cast.stop.mock.calls.length
  Object.assign(fake.cast.remote,{contentId:incomingURI,clockContentId:incomingURI,currentTime:355,playerState:'PLAYING',idleReason:null,isMediaLoaded:true,updateSeq:fake.cast.remote.updateSeq+1})
  await act(async()=>{ack()});await settle();view.rerender(element());await settle();await advanceLoadWindow()
  expect(ended).not.toHaveBeenCalled();expect(stopsBeforeACK).toBe(0);expect(fake.cast.stop).not.toHaveBeenCalled()
})
for(const reason of ['FINISHED','CANCELLED'] as const) it(`Independent 4cf first ACK terminal: acknowledged ${reason} works without an earlier PLAYING clock`,async()=>{
  fake.cast.start.mockImplementationOnce(async()=>{
    const load=await fake.getter?.() as CastLoadArgs
    fake.cast.status.connected=true
    Object.assign(fake.cast.remote,{contentId:load.contentUrl,clockContentId:null,playerState:null,isMediaLoaded:true,updateSeq:1})
  })
  const {view,element,ended}=await connectedCast();await advanceLoadWindow()
  Object.assign(fake.cast.remote,{clockContentId:null,playerState:'IDLE',idleReason:reason,isMediaLoaded:false,updateSeq:2})
  view.rerender(element());await settle();await advanceLoadWindow()
  expect(ended).toHaveBeenCalledTimes(reason==='FINISHED'?1:0)
  expect(fake.cast.stop).toHaveBeenCalledOnce()
})
