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
    remote: { title: 'Receiver title', contentId: null as string | null, isMediaLoaded: true, isPaused: false, canSeek: true, currentTime: 0, duration: 1000, playerState: 'PLAYING' as string | null, idleReason: null as string | null, updateSeq: 0 },
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
  Object.assign(fake.cast.remote, { title: 'Receiver title', contentId: null, isMediaLoaded: true, isPaused: false, currentTime: 0, duration: 1000, playerState: 'PLAYING', idleReason: null, updateSeq: 0 })
  fake.cast.stop.mockReset()
  fake.cast.start.mockImplementation(async () => {
    const load = await fake.getter?.() as CastLoadArgs | null
    fake.cast.status.connected = true
    fake.cast.remote.contentId = load?.contentUrl ?? null
  })
  fake.cast.loadCurrent.mockImplementation(async (at?: number) => {
    const load = await fake.getter?.(at) as CastLoadArgs | null
    if (!load) throw new Error('CAST_NO_MEDIA_ERROR')
    Object.assign(fake.cast.remote, { contentId: load.contentUrl, playerState: 'PLAYING', idleReason: null, isMediaLoaded: true, updateSeq: fake.cast.remote.updateSeq + 1 })
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
async function connectedCast() {
  const close = vi.fn(), ended = vi.fn(async () => false)
  const element = () => <VideoPlayer target={movie} onClose={close} onEnded={ended} />
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
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle()
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
  it('recovers error handling after an identity-less receiver resumes the committed media', async () => {
    const { view, element, ended } = await connectedCast()
    rejectReplacement('ERROR', 'missing')
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle(); view.rerender(element()); await settle(); await advanceLoadWindow()
    Object.assign(fake.cast.remote, { playerState: 'PLAYING', idleReason: null, isMediaLoaded: true, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'ERROR', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    expect(fake.cast.stop).toHaveBeenCalledOnce(); expect(ended).not.toHaveBeenCalled()
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
