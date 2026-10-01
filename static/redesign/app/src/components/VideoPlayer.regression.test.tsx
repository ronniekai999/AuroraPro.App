// @vitest-environment jsdom
// Exercise the real player/controls; mock only delivery, telemetry and CAF.
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer, type PlayTarget, type PartySync } from './VideoPlayer'
import { createSession, getStreamInfo, keepalive } from '@/lib/streaming'
import { markWatched, reportProgress } from '@/lib/api'
const fake = vi.hoisted(() => ({
  getter: null as null | ((at?: number) => Promise<unknown>),
  cast: {
    status: { supported: true, available: true, connected: false, settling: false, deviceName: 'TV' },
    remote: { isMediaLoaded: true, isPaused: false, canSeek: true, currentTime: 0, duration: 1000, playerState: 'PLAYING' as string | null, idleReason: null as string | null, updateSeq: 0 },
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
  Object.assign(fake.cast.remote, { isMediaLoaded: true, isPaused: false, currentTime: 0, duration: 1000, playerState: 'PLAYING', idleReason: null, updateSeq: 0 })
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
