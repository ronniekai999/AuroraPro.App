// @vitest-environment jsdom
// Exercise the real player/controls; mock only delivery, telemetry and CAF.
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer, type PlayTarget, type PartySync } from './VideoPlayer'
import { createCastToken, createDirectCastToken, createSession, deleteSession, getStreamInfo, keepalive } from '@/lib/streaming'
import { markWatched, reportProgress } from '@/lib/api'
import { CastMediaLoadError } from '@/lib/cast'
const fake = vi.hoisted(() => ({
  getter: null as null | ((at?: number) => Promise<unknown>),
  cast: {
    status: { supported: true, available: true, connected: false, settling: false, deviceName: 'TV' },
    remote: { contentId: null as string | null, isMediaLoaded: true, isPaused: false, canSeek: true, currentTime: 0, duration: 1000, playerState: 'PLAYING' as string | null, idleReason: null as string | null, updateSeq: 0 },
    start: vi.fn(), stop: vi.fn(), loadCurrent: vi.fn(), seek: vi.fn(), playOrPause: vi.fn(),
  },
  hls: [] as Array<{ emit: (name: string, data?: unknown) => void }>,
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
    constructor() { fake.hls.push(this) }
    on(name: string, callback: (name: string, data: unknown) => void) { this.handlers.set(name, [...this.handlers.get(name) ?? [], callback]) }
    emit(name: string, data: unknown = {}) { this.handlers.get(name)?.forEach(fn => fn(name, data)) }
    loadSource() {} attachMedia() {} startLoad() {} stopLoad() {} recoverMediaError() {} swapAudioCodec() {}
    destroy() { this.handlers.clear() }
  }
  return { default: FakeHls }
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
function video() { return document.querySelector('video')! }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function RebuildHarness({ onSeek = vi.fn(), onAudio = vi.fn(), party }: { onSeek?: (seconds: number) => void; onAudio?: (index: number, resumeMs: number) => void; party?: PartySync }) {
  const [target, setTarget] = useState(movie)
  return <VideoPlayer target={target} onClose={() => {}} profileId={7} party={party}
    onSeekRebuild={seconds => { onSeek(seconds); setTarget(current => ({ ...current, resumePositionMs: seconds * 1000 })) }}
    onChangeAudioTrack={(index, resumeMs) => { onAudio(index, resumeMs); setTarget(current => ({ ...current, audioTrackIndex: index, resumePositionMs: resumeMs })) }} />
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.clearAllMocks(); fake.hls.length = 0; localStorage.clear()
  Object.assign(fake.cast.status, { connected: false, settling: false })
  Object.assign(fake.cast.remote, { contentId: null, isMediaLoaded: true, isPaused: false, currentTime: 0, duration: 1000, playerState: 'PLAYING', idleReason: null, updateSeq: 0 })
  fake.cast.start.mockImplementation(async () => { await fake.getter?.(); fake.cast.status.connected = true })
  fake.cast.loadCurrent.mockImplementation(async (at?: number) => { await fake.getter?.(at) })
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

describe('WEB regressions through the real VideoPlayer', () => {
  it('attributes browser progress to the active profile', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} profileId={7} />); await bootHls(); video().currentTime = 45
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 45000, duration_ms: 1000000, profile_id: 7 }), expect.any(AbortSignal))
  })
  it('keeps rapid relative seeks and the slider on the logical clock', async () => {
    const seek = vi.fn(); render(<RebuildHarness onSeek={seek} />); await bootHls(); video().currentTime = 25
    const pending = deferred<Awaited<ReturnType<typeof getStreamInfo>>>(); vi.mocked(getStreamInfo).mockImplementation(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuenow', '35')
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    expect(seek.mock.calls.map(call => call[0])).toEqual([35, 45])
    fireEvent.keyDown(document, { key: 'ArrowRight' }); await settle(); expect(seek).toHaveBeenLastCalledWith(55)
  })
  it('keeps a pending seek position through consecutive audio picks', async () => {
    const audio = vi.fn(); render(<RebuildHarness onAudio={audio} />); await bootHls(); video().currentTime = 25
    const pending = deferred<Awaited<ReturnType<typeof getStreamInfo>>>(); vi.mocked(getStreamInfo).mockImplementation(() => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Audio/ })); fireEvent.click(screen.getByRole('button', { name: /French/ })); await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Audio/ })); fireEvent.click(screen.getByRole('button', { name: /English/ })); await settle()
    expect(audio.mock.calls).toEqual([[1, 35000], [0, 35000]])
  })
  it.each(['close then open', 'replace target while error visible'])('binds listeners after an error: %s', async mode => {
    vi.mocked(getStreamInfo).mockRejectedValueOnce(new Error('session cap'))
    const ended = vi.fn(); const element = (target: PlayTarget | null) => <VideoPlayer target={target} onClose={() => {}} onEnded={ended} />
    const view = render(element(movie)); await settle(); expect(screen.getByText('session cap')).toBeInTheDocument()
    if (mode === 'close then open') { view.rerender(element(null)); await settle() }
    localStorage.setItem('aurora_prefs', JSON.stringify({ player_volume: 0.4 }))
    view.rerender(element({ ...movie, mediaItemId: 2, fileId: 20, title: 'Next' })); await bootHls()
    const v = video(); expect(v.volume).toBe(0.4); expect(v).toBeTruthy(); v.currentTime = 70; fireEvent.timeUpdate(v)
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuenow', '70')
    fireEvent.pause(v); expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    fireEvent.ended(v); expect(ended).toHaveBeenCalledOnce()
    Object.defineProperty(v, 'webkitCurrentPlaybackTargetIsWireless', { value: true, configurable: true })
    fireEvent(v, new Event('webkitcurrentplaybacktargetiswirelesschanged'))
    expect(screen.getByText('Playing via AirPlay')).toBeInTheDocument()
  })
  it.each([true, false])('preserves paused=%s through a dead-session recovery', async wasPaused => {
    render(<RebuildHarness />); await bootHls(); video().currentTime = 80; if (wasPaused) video().pause()
    play.mockClear(); vi.mocked(keepalive).mockResolvedValue('gone')
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle(); await bootHls()
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ start_sec: 80 }), expect.anything())
    expect(video().paused).toBe(wasPaused); expect(play.mock.calls.length).toBe(wasPaused ? 0 : 1)
  })
  it.each([true, false])('preserves paused=%s through direct-play recovery', async wasPaused => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
    const seek = vi.fn(); const view = render(<RebuildHarness onSeek={seek} />); await settle()
    fireEvent.canPlay(video()); await settle(); video().currentTime = 90; if (wasPaused) video().pause()
    play.mockClear(); vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 61000)
    Object.defineProperty(video(), 'error', { value: { code: 2 }, configurable: true })
    fireEvent.error(video()); await settle(); fireEvent.canPlay(video()); await settle()
    expect(seek).toHaveBeenCalledWith(90); expect(video().paused).toBe(wasPaused)
    expect(play.mock.calls.length).toBe(wasPaused ? 0 : 1); view.unmount()
  })

  it('reports receiver absolute progress while the local cast video is paused', async () => {
    const element = <VideoPlayer target={movie} profileId={7} onClose={() => {}} />
    const view = render(element); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(<VideoPlayer target={movie} profileId={7} onClose={() => {}} />); await settle()
    expect(video().paused).toBe(true)
    fake.cast.remote.currentTime = 30; fake.cast.remote.updateSeq++
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 130000, duration_ms: 1000000, profile_id: 7 }), expect.any(AbortSignal))
  })

  it('awaits FINISHED completion before advancing, even when CAF clears the clock', async () => {
    const ended = vi.fn(() => false)
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} onEnded={ended} />
    const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    const finalWrite = deferred<void>(); vi.mocked(reportProgress).mockImplementation(() => finalWrite.promise)
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 1 })
    view.rerender(element()); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000, duration_ms: 1000000, profile_id: 7 }), expect.any(AbortSignal))
    expect(ended).not.toHaveBeenCalled(); expect(fake.cast.stop).not.toHaveBeenCalled()
    finalWrite.resolve(); await settle(); expect(ended).toHaveBeenCalledOnce(); expect(fake.cast.stop).toHaveBeenCalledOnce()
  })

  it('explicitly marks FINISHED watched when source duration is unknown', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('transcode', 0) as Awaited<ReturnType<typeof getStreamInfo>>)
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} />
    const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 1 })
    view.rerender(element()); await settle()
    expect(markWatched).toHaveBeenCalledWith(1, { profile_id: 7, episode_id: undefined }, expect.any(AbortSignal))
    expect(fake.cast.stop).toHaveBeenCalledOnce()
  })

  it('flushes disconnect progress to the acknowledged old item/profile and never advances a new one', async () => {
    const oldEpisode = { ...movie, fileType: 'episode' as const, episodeId: 11 }
    const ended = vi.fn(); const element = (target: PlayTarget, profileId: number) => <VideoPlayer target={target} profileId={profileId} onClose={() => {}} onEnded={ended} />
    const view = render(element(oldEpisode, 7)); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element(oldEpisode, 7)); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    Object.assign(fake.cast.remote, { currentTime: 120, updateSeq: 1 }); view.rerender(element(oldEpisode, 7)); await settle()
    const nextEpisode = { ...oldEpisode, fileId: 20, episodeId: 12 }
    view.rerender(element(nextEpisode, 9)); await settle(); await bootHls()
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 2 })
    view.rerender(element(nextEpisode, 9)); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000, episode_id: 11, profile_id: 7 }), expect.any(AbortSignal))
    expect(ended).not.toHaveBeenCalled()
    fake.cast.status.connected = false; Object.assign(fake.cast.remote, { currentTime: 0, updateSeq: 3 })
    view.rerender(element(nextEpisode, 9)); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: 1000000, episode_id: 11, profile_id: 7 }), expect.any(AbortSignal))
    expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ episode_id: 12 }), expect.anything())
  })

  it('keeps Stop responsive while progress networking hangs', async () => {
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} />
    const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    Object.assign(fake.cast.remote, { currentTime: 44, updateSeq: 1 }); view.rerender(element()); await settle()
    vi.mocked(reportProgress).mockImplementation(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Stop and close' })); await settle()
    expect(fake.cast.stop).toHaveBeenCalledOnce()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 144000 }), expect.any(AbortSignal))
  })

  it('broadcasts consecutive rapid host seeks on the logical clock', async () => {
    const requestSeek = vi.fn()
    const party: PartySync = { isHost: true, currentUserId: 1, partyMediaItemId: 1, partyEpisodeId: null, isPlaying: true, rev: 1, hlsStartSec: 0, tickRef: { current: null }, seekRef: { current: null }, helloAbsMsRef: { current: 0 }, requestPlay: vi.fn(), requestPause: vi.fn(), requestSeek }
    render(<RebuildHarness party={party} />); await bootHls(); video().currentTime = 25
    const pending = deferred<Awaited<ReturnType<typeof getStreamInfo>>>(); vi.mocked(getStreamInfo).mockImplementation(() => pending.promise)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' }))
      fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' }))
    }); await settle()
    expect(requestSeek.mock.calls.map(call => call[0])).toEqual([35000, 45000])
  })

  it('retains a native-HLS terminal error until the target changes', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Safari')
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue('maybe')
    render(<VideoPlayer target={movie} onClose={() => {}} />); await settle()
    Object.defineProperty(video(), 'error', { value: { code: 4 }, configurable: true })
    fireEvent.error(video()); await settle()
    expect(screen.getByText('Playback failed — this stream format is not supported by your browser')).toBeInTheDocument()
    expect(getStreamInfo).toHaveBeenCalledOnce()
    expect(document.querySelector('video')).toBeNull()
  })

  it('flushes the last receiver sample on disconnect even after CAF resets its clock', async () => {
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} />
    const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    Object.assign(fake.cast.remote, { currentTime: 55, updateSeq: 1 }); view.rerender(element()); await settle()
    fake.cast.status.connected = false; Object.assign(fake.cast.remote, { currentTime: 0, playerState: null, updateSeq: 2 })
    view.rerender(element()); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 155000, profile_id: 7 }), expect.any(AbortSignal))
    expect(markWatched).not.toHaveBeenCalled()
  })

  it('keeps AirPlay progress on the local absolute clock', async () => {
    render(<VideoPlayer target={{ ...movie, resumePositionMs: 100000 }} profileId={7} onClose={() => {}} />); await bootHls()
    Object.defineProperty(video(), 'webkitCurrentPlaybackTargetIsWireless', { value: true, configurable: true })
    fireEvent(video(), new Event('webkitcurrentplaybacktargetiswirelesschanged'))
    video().currentTime = 30
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(video().paused).toBe(false)
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 130000, profile_id: 7 }), expect.any(AbortSignal))
  })

  it('keeps pending loads from misattributing the receiver clock', async () => {
    const loaded = deferred<void>()
    fake.cast.start.mockImplementation(async () => { await fake.getter?.(); fake.cast.status.connected = true; await loaded.promise })
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} />
    const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); fake.cast.remote.currentTime = 500
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle(); expect(reportProgress).not.toHaveBeenCalled()
    loaded.resolve(); await settle(); fake.cast.remote.currentTime = 12; fake.cast.remote.updateSeq++
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 112000 }), expect.any(AbortSignal))
  })

  it('saves direct-cast progress with a zero anchor', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} />
    const view = render(element()); await settle(); fireEvent.canPlay(video()); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle(); view.rerender(element()); await settle()
    fake.cast.remote.currentTime = 55
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 55000, profile_id: 7 }), expect.any(AbortSignal))
  })

  it('does not mark a receiver cancellation watched or advance', async () => {
    const ended = vi.fn(); const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} onEnded={ended} />
    const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    Object.assign(fake.cast.remote, { currentTime: 44, updateSeq: 1 }); view.rerender(element()); await settle()
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'CANCELLED', currentTime: 0, updateSeq: 2 }); view.rerender(element()); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 144000 }), expect.any(AbortSignal))
    expect(markWatched).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled(); expect(fake.cast.stop).toHaveBeenCalledOnce()
  })

  it('bounds a hung FINISHED write and reports its failure before advancing', async () => {
    const ended = vi.fn(() => false); const toast = vi.fn()
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} onEnded={ended} onToast={toast} />
    const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    vi.mocked(reportProgress).mockImplementation((_id, _body, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 1 })
    view.rerender(element()); await settle(); expect(ended).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(5000) }); await settle()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Could not save watched status'), 'error')
    expect(ended).toHaveBeenCalledOnce(); expect(fake.cast.stop).toHaveBeenCalledOnce()
  })

})

describe('Independent adversarial timing checks', () => {
  it('keeps the direct-play logical position through paused audio reload before canplay', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
    const audio = vi.fn(); render(<RebuildHarness onAudio={audio} />); await settle()
    fireEvent.canPlay(video()); await settle(); video().currentTime = 80; video().pause()
    fireEvent.click(screen.getByRole('button', { name: /^Audio/ })); fireEvent.click(screen.getByRole('button', { name: /French/ })); await settle()
    // The new file is not loadable yet; the resume listener is still pending.
    expect(video().currentTime).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /^Audio/ })); fireEvent.click(screen.getByRole('button', { name: /English/ })); await settle()
    expect(audio.mock.calls).toEqual([[1, 80000], [0, 80000]])
  })
  it('rebinds party broadcasts after a direct target replacement while an error is visible', async () => {
    vi.mocked(getStreamInfo).mockRejectedValueOnce(new Error('session cap'))
    const requestPause = vi.fn()
    const baseParty: PartySync = { isHost: true, currentUserId: 1, partyMediaItemId: 1, partyEpisodeId: null, isPlaying: true, rev: 1, hlsStartSec: 0, tickRef: { current: null }, seekRef: { current: null }, helloAbsMsRef: { current: 0 }, requestPlay: vi.fn(), requestPause, requestSeek: vi.fn() }
    const view = render(<VideoPlayer target={movie} party={baseParty} onClose={() => {}} />); await settle()
    expect(screen.getByText('session cap')).toBeInTheDocument()
    const next = { ...movie, mediaItemId: 2, fileId: 20, title: 'Next' }
    const nextParty = { ...baseParty, partyMediaItemId: 2 }
    view.rerender(<VideoPlayer target={next} party={nextParty} onClose={() => {}} />); await bootHls()
    requestPause.mockClear(); video().currentTime = 80; video().pause(); await settle()
    expect(requestPause).toHaveBeenCalledWith(80000)
  })
})


describe('Independent cast acknowledgement race', () => {
  it('keeps receiver progress on the item acknowledged across a local retarget', async () => {
    const oldEpisode = { ...movie, fileType: 'episode' as const, episodeId: 11, title: 'A' }
    const nextEpisode = { ...oldEpisode, fileId: 20, episodeId: 12, title: 'B' }
    const thirdEpisode = { ...oldEpisode, fileId: 30, episodeId: 13, title: 'C' }
    const loaded = deferred<void>(); const loads: unknown[] = []
    fake.cast.loadCurrent.mockImplementation(async (at?: number) => {
      loads.push(await fake.getter?.(at)); await loaded.promise
    })
    let view: ReturnType<typeof render>
    const ended = vi.fn(async () => { view.rerender(element(nextEpisode)); return true })
    const element = (target: PlayTarget) => <VideoPlayer target={target} profileId={7} onClose={() => {}} onEnded={ended} />
    view = render(element(oldEpisode)); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element(oldEpisode)); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 1 })
    view.rerender(element(oldEpisode)); await settle()
    expect(loads).toEqual([expect.objectContaining({ title: 'B' })])
    // While the receiver is loading B, the party retargets the sender to C.
    view.rerender(element(thirdEpisode)); await settle()
    Object.assign(fake.cast.remote, { playerState: 'PLAYING', idleReason: null, currentTime: 12, updateSeq: 2 })
    loaded.resolve(); await settle(); view.rerender(element(thirdEpisode)); await settle()
    vi.mocked(reportProgress).mockClear()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ episode_id: 12, position_ms: 112000 }), expect.any(AbortSignal))
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 3 })
    view.rerender(element(thirdEpisode)); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ episode_id: 12, position_ms: 1000000 }), expect.any(AbortSignal))
    expect(ended).toHaveBeenCalledOnce() // A advanced; B must not advance C.
    expect(fake.cast.stop).toHaveBeenCalledOnce()
  })
})


describe('Independent paused direct fallback', () => {
  it('keeps an early direct-play transcode recovery paused', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
    function FallbackHarness() {
      const [target, setTarget] = useState(movie)
      return <VideoPlayer target={target} profileId={7} onClose={() => {}} onFallbackToTranscode={resume => {
        setTarget(current => ({ ...current, forceTranscode: true, resumePositionMs: resume }))
      }} />
    }
    render(<FallbackHarness />); await settle(); fireEvent.canPlay(video()); await settle()
    video().currentTime = 80; video().pause(); play.mockClear()
    Object.defineProperty(video(), 'error', { value: { code: 2 }, configurable: true })
    fireEvent.error(video()); await settle(); await bootHls()
    expect(video().paused).toBe(true); expect(play).not.toHaveBeenCalled()
  })
})


describe('Independent missing cast anchor', () => {
  it('does not infer a progress conversion from the local anchor without start_sec', async () => {
    vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: '/api/stream/cast/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })
    const target = { ...movie, resumePositionMs: 200000 }
    const element = () => <VideoPlayer target={target} profileId={7} onClose={() => {}} />
    const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); fake.cast.remote.currentTime = 30
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
  })
})

it('binds the guest mirror to the replacement element after an error', async () => {
  vi.mocked(getStreamInfo).mockRejectedValueOnce(new Error('session cap'))
  const party: PartySync = { isHost: false, currentUserId: 2, partyMediaItemId: 1, partyEpisodeId: null, isPlaying: true, rev: 1, hlsStartSec: 0, tickRef: { current: null }, seekRef: { current: null }, helloAbsMsRef: { current: 0 }, requestPlay: vi.fn(), requestPause: vi.fn(), requestSeek: vi.fn() }
  const view = render(<VideoPlayer target={movie} party={party} onClose={() => {}} />); await settle()
  const next = { ...movie, mediaItemId: 2, fileId: 20, title: 'Next' }
  const nextParty = { ...party, partyMediaItemId: 2 }
  view.rerender(<VideoPlayer target={next} party={nextParty} onClose={() => {}} />); await bootHls()
  Object.assign(nextParty.tickRef, { current: { abs_ms: 0, server_now_ms: Date.now(), receivedAtMs: Date.now(), running: true, rev: 1 } })
  video().pause(); play.mockClear()
  await act(async () => { vi.advanceTimersByTime(250) }); await settle()
  expect(video().paused).toBe(false); expect(play).toHaveBeenCalledOnce()
})

it.each([null, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid receiver progress anchor %s', async anchor => {
  vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: '/api/stream/cast/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: anchor as number })
  const target = { ...movie, resumePositionMs: 200000 }
  const element = () => <VideoPlayer target={target} profileId={7} onClose={() => {}} />
  const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
  view.rerender(element()); await settle(); fake.cast.remote.currentTime = 30
  await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
  expect(reportProgress).not.toHaveBeenCalled()
})

it('applies relative seek intent made during a paused direct resume before canplay', async () => {
  vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
  const audio = vi.fn(); render(<RebuildHarness onAudio={audio} />); await settle(); fireEvent.canPlay(video()); await settle()
  video().currentTime = 80; video().pause()
  fireEvent.click(screen.getByRole('button', { name: /^Audio/ })); fireEvent.click(screen.getByRole('button', { name: /French/ })); await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
  fireEvent.canPlay(video()); await settle()
  expect(video().currentTime).toBe(90); expect(video().paused).toBe(true)
})

describe('Second independent adversarial review', () => {
  it('records progress when CAF publishes an update before initial connection is established', async () => {
    const picker = deferred<void>()
    fake.cast.start.mockImplementation(async () => {
      await picker.promise
      await fake.getter?.()
      fake.cast.status.connected = true
    })
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} />
    const view = render(element()); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    fake.cast.remote.updateSeq++
    view.rerender(element()); await settle()
    picker.resolve(); await settle(); view.rerender(element()); await settle()
    fake.cast.remote.currentTime = 30; fake.cast.remote.updateSeq++
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 130000, profile_id: 7 }), expect.any(AbortSignal))
  })
  it('casts from the latest logical seek before direct resume canplay', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
    render(<RebuildHarness />); await settle(); fireEvent.canPlay(video()); await settle()
    video().currentTime = 80; video().pause()
    fireEvent.click(screen.getByRole('button', { name: /^Audio/ })); fireEvent.click(screen.getByRole('button', { name: /French/ })); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    let loaded: unknown
    fake.cast.start.mockImplementation(async () => { loaded = await fake.getter?.(); fake.cast.status.connected = true })
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    expect(loaded).toEqual(expect.objectContaining({ startTime: 90 }))
  })
  it('saves FINISHED completion even when the acknowledged response omitted its anchor', async () => {
    vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: '/api/stream/cast/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })
    const ended = vi.fn(() => false)
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} onEnded={ended} />
    const view = render(element()); await bootHls(); fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 1 })
    view.rerender(element()); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000, duration_ms: 1000000, profile_id: 7 }), expect.any(AbortSignal))
    expect(ended).toHaveBeenCalledOnce()
  })

  it.each(['disconnect', 'Stop'])('invalidates a slow initial mint after a real cast %s', async mode => {
    const mint = deferred<Awaited<ReturnType<typeof createCastToken>>>()
    vi.mocked(createCastToken).mockReturnValueOnce(mint.promise)
    fake.cast.start.mockImplementation(async () => {
      fake.cast.status.connected = true
      await fake.getter?.()
    })
    const ended = vi.fn()
    const element = () => <VideoPlayer target={movie} profileId={7} onClose={() => {}} onEnded={ended} />
    const view = render(element()); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle() // A real connection was established.
    if (mode === 'Stop') fireEvent.click(screen.getByRole('button', { name: 'Stop and close' }))
    fake.cast.status.connected = false; fake.cast.remote.updateSeq++
    if (mode === 'disconnect') { view.rerender(element()); await settle() }
    // The stopped receiver's mint/load settles after its end. Stop invalidates
    // synchronously, even before connected=false is rendered.
    mint.resolve({ playlist: '/api/stream/hls/ended-clone/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: 100 })
    await settle(); view.rerender(element()); await settle()
    expect(deleteSession).toHaveBeenCalledWith('ended-clone')
    // Rejoining a receiver with no acknowledged load must not resurrect that
    // old identity or keep the orphan clone alive.
    fake.cast.status.connected = true
    Object.assign(fake.cast.remote, { currentTime: 30, updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
    expect(keepalive).not.toHaveBeenCalledWith('ended-clone')
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', updateSeq: fake.cast.remote.updateSeq + 1 })
    view.rerender(element()); await settle()
    expect(markWatched).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
  })

  it('marks unknown-duration FINISHED on the acknowledged profile/item without an anchor', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('transcode', 0) as Awaited<ReturnType<typeof getStreamInfo>>)
    vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: '/api/stream/cast/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: -1 })
    const old = { ...movie, fileType: 'episode' as const, episodeId: 11 }
    const next = { ...old, fileId: 20, episodeId: 12 }
    const ended = vi.fn()
    const element = (target: PlayTarget, profileId: number) => <VideoPlayer target={target} profileId={profileId} onClose={() => {}} onEnded={ended} />
    const view = render(element(old, 7)); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element(old, 7)); await settle()
    fake.cast.remote.currentTime = 30
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
    view.rerender(element(next, 9)); await bootHls()
    const finalWrite = deferred<{}>(); vi.mocked(markWatched).mockReturnValueOnce(finalWrite.promise)
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 1 })
    view.rerender(element(next, 9)); await settle()
    expect(markWatched).toHaveBeenCalledWith(1, { profile_id: 7, episode_id: 11 }, expect.any(AbortSignal))
    expect(fake.cast.stop).not.toHaveBeenCalled()
    finalWrite.resolve({}); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ profile_id: 7, episode_id: 11, position_ms: 0, duration_ms: 0 }), expect.any(AbortSignal))
    expect(ended).not.toHaveBeenCalled(); expect(fake.cast.stop).toHaveBeenCalledOnce()
  })

  it('casts an exact pending direct zero seek made while its token mint is in flight', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('direct_play') as Awaited<ReturnType<typeof getStreamInfo>>)
    render(<RebuildHarness />); await settle(); fireEvent.canPlay(video()); await settle()
    video().currentTime = 80; video().pause()
    fireEvent.click(screen.getByRole('button', { name: /^Audio/ })); fireEvent.click(screen.getByRole('button', { name: /French/ })); await settle()
    const mint = deferred<Awaited<ReturnType<typeof createDirectCastToken>>>()
    vi.mocked(createDirectCastToken).mockReturnValueOnce(mint.promise)
    let loaded: unknown
    fake.cast.start.mockImplementation(async () => { loaded = await fake.getter?.(); fake.cast.status.connected = true })
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    for (let i = 0; i < 8; i++) fireEvent.keyDown(document, { key: 'ArrowLeft' })
    await settle(); expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuenow', '0')
    mint.resolve({ url: '/api/stream/direct/media/10?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 }); await settle()
    expect(loaded).toEqual(expect.objectContaining({ startTime: 0 }))
  })
})

describe('Receiver LOAD rejection preserves only proven progress', () => {
  const token = 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x'
  const firstURL = '/api/stream/hls/first/master.m3u8?token=cast'
  const failedURL = '/api/stream/hls/renewed/master.m3u8?token=cast'
  const oldEpisode = { ...movie, fileType: 'episode' as const, episodeId: 11, resumePositionMs: 200000 }
  async function renew(failure: 'receiver' | 'mint' = 'receiver') {
    vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: firstURL, token, expires_at: 1, start_sec: 100 })
    const ended = vi.fn(() => false)
    const element = (target: PlayTarget = oldEpisode, profileId = 7) => <VideoPlayer target={target} profileId={profileId} onClose={() => {}} onEnded={ended} />
    const view = render(element()); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    view.rerender(element()); await settle(); await act(async () => { vi.advanceTimersByTime(3000) })
    Object.assign(fake.cast.remote, { contentId: new URL(firstURL, location.href).href, currentTime: 500, isPaused: true, updateSeq: 1 })
    view.rerender(element()); await settle()
    if (failure === 'mint') vi.mocked(createCastToken).mockRejectedValueOnce(new Error('mint unavailable'))
    else {
      vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: failedURL, token, expires_at: 1, start_sec: 580 })
      fake.cast.loadCurrent.mockImplementationOnce(async (at?: number) => {
        const loaded = await fake.getter?.(at) as { contentUrl: string; startTime: number }
        expect(loaded.startTime).toBe(20)
        // Real useCast marks only SDK session.loadMedia rejections this way.
        // LOAD reached the receiver; its clock changed before CAF timed out.
        Object.assign(fake.cast.remote, { contentId: loaded.contentUrl, currentTime: 20, isPaused: false, updateSeq: 2 })
        throw new CastMediaLoadError('receiver LOAD timed out', loaded.contentUrl)
      })
    }
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle()
    view.rerender(element()); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: 600000, episode_id: 11, profile_id: 7 }), expect.any(AbortSignal))
    vi.mocked(reportProgress).mockClear()
    return { view, element, ended }
  }

  it('does not apply a previous acknowledged anchor after a receiver LOAD timeout changed its clock', async () => {
    const { view, element } = await renew()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
    // Missing identity and newer PLAYING readings cannot prove which source
    // clock the failed LOAD left behind either.
    Object.assign(fake.cast.remote, { contentId: null, currentTime: 25, updateSeq: 3 })
    view.rerender(element()); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
  })

  it.each(['Stop', 'disconnect'])('flushes the trusted outgoing sample on %s after an unacknowledged LOAD', async mode => {
    const { view, element } = await renew()
    await act(async () => { vi.advanceTimersByTime(3000) }); await settle()
    if (mode === 'Stop') fireEvent.click(screen.getByRole('button', { name: 'Stop and close' }))
    else {
      fake.cast.status.connected = false
      Object.assign(fake.cast.remote, { currentTime: 0, contentId: null, updateSeq: 3 })
      view.rerender(element())
    }
    await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: 600000, episode_id: 11, profile_id: 7 }), expect.any(AbortSignal))
    expect(markWatched).not.toHaveBeenCalled()
  })

  it('does not complete the previous item or advance a new target on an unacknowledged FINISHED', async () => {
    const { view, element, ended } = await renew()
    const next = { ...oldEpisode, fileId: 20, episodeId: 12, resumePositionMs: 0 }
    view.rerender(element(next, 9)); await bootHls()
    await act(async () => { vi.advanceTimersByTime(3000) }); await settle()
    Object.assign(fake.cast.remote, { playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 3 })
    view.rerender(element(next, 9)); await settle()
    expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 1000000 }), expect.anything())
    expect(reportProgress).not.toHaveBeenCalledWith(1, expect.objectContaining({ episode_id: 12 }), expect.anything())
    expect(markWatched).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled()
    expect(fake.cast.stop).toHaveBeenCalledOnce()
  })

  it('keeps the old clock valid when a token mint fails before receiver LOAD', async () => {
    const { view, element } = await renew('mint')
    Object.assign(fake.cast.remote, { currentTime: 510, updateSeq: 2 }); view.rerender(element()); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 610000, episode_id: 11, profile_id: 7 }), expect.any(AbortSignal))
  })

  it('restores progress and FINISHED after fresh identity proves the acknowledged media survived', async () => {
    const { view, element, ended } = await renew()
    Object.assign(fake.cast.remote, { contentId: new URL(firstURL, location.href).href, currentTime: 510, updateSeq: 3 })
    view.rerender(element()); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 610000, profile_id: 7 }), expect.any(AbortSignal))
    vi.mocked(reportProgress).mockClear()
    Object.assign(fake.cast.remote, { contentId: new URL(failedURL, location.href).href, currentTime: 20, updateSeq: 4 })
    view.rerender(element()); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).not.toHaveBeenCalled()
    Object.assign(fake.cast.remote, { contentId: new URL(firstURL, location.href).href, playerState: 'IDLE', idleReason: 'FINISHED', currentTime: 0, updateSeq: 5 })
    view.rerender(element()); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: 1000000, episode_id: 11, profile_id: 7 }), expect.any(AbortSignal))
    expect(ended).toHaveBeenCalledOnce()
  })

  it('restores the new anchor after a later receiver load actually acknowledges', async () => {
    const { view, element } = await renew()
    fake.cast.remote.isPaused = true; fake.cast.remote.updateSeq++
    view.rerender(element()); await settle()
    vi.mocked(createCastToken).mockResolvedValueOnce({ playlist: '/api/stream/hls/retry/master.m3u8?token=cast', token, expires_at: 9999999999, start_sec: 590 })
    fireEvent.click(screen.getByRole('button', { name: 'Play' })); await settle()
    Object.assign(fake.cast.remote, { contentId: 'http://localhost:3000/api/stream/hls/retry/master.m3u8?token=cast', currentTime: 15, isPaused: false, updateSeq: 4 })
    view.rerender(element()); await settle()
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenCalledWith(1, expect.objectContaining({ position_ms: 605000, episode_id: 11, profile_id: 7 }), expect.any(AbortSignal))
  })
})
