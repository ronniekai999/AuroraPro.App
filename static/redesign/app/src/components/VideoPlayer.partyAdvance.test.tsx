// @vitest-environment jsdom
// Exercise the real player/controls; mock only delivery, telemetry and CAF.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { VideoPlayer, type PlayTarget, type PartySync } from './VideoPlayer'
import { createSession, getStreamInfo, keepalive } from '@/lib/streaming'
import { reportProgress } from '@/lib/api'
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
  getStreamInfo: vi.fn(), createSession: vi.fn(), deleteSession: vi.fn(async () => {}), keepalive: vi.fn(async () => 'alive'),
  createCastToken: vi.fn(async () => ({ playlist: '/api/stream/cast/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: 100 })),
  createDirectCastToken: vi.fn(async () => ({ url: '/api/stream/direct/media/10?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })),
}))
vi.mock('@/lib/api', async original => ({
  ...await original<typeof import('@/lib/api')>(), reportProgress: vi.fn(async () => {}),
}))
vi.mock('@/lib/prewarm', () => ({ prewarmEnabled: () => false, takeWarmedSession: () => null }))
vi.mock('@/lib/playbackQoE', () => ({ attachPlaybackQoE: () => new Proxy({}, { get: (_target, name) => name === 'isFinished' ? () => false : () => {} }) }))
function info(decision: 'transcode' | 'direct_play' = 'transcode', duration = 1000000) {
  return { stream: { decision, stream_url: '/file.mp4', duration_ms: duration, video_codec: 'h264', audio_codec: 'aac', audio_codec_out: 'aac', container: 'mp4', width: 1920, height: 1080 }, audio_tracks: [{ index: 0, title: 'English', codec: 'aac' }, { index: 1, title: 'French', codec: 'aac' }], subtitles: [], markers: [] }
}
const paused = new WeakMap<HTMLMediaElement, boolean>()
const play = vi.fn(function(this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve() })
async function settle() { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }) }
async function bootHls() { await settle(); await act(async () => { fake.hls.at(-1)!.emit('MANIFEST_PARSED') }); await settle() }
function video() { return document.querySelector('video')! }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
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
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) { paused.set(this, true); this.dispatchEvent(new Event('pause')) })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function(this: HTMLMediaElement) { this.currentTime = 0 })
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('')
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function(this: HTMLMediaElement) { return paused.get(this) ?? true })
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

const oldEpisode: PlayTarget = { mediaItemId: 1, fileId: 10, fileType: 'episode', episodeId: 11, title: 'Series', seasonNumber: 1, episodeNumber: 1 }
const nextEpisode: PlayTarget = { ...oldEpisode, fileId: 20, episodeId: 12, episodeNumber: 2, partyRecoveryBoot: true, partyPlayOnBootRevision: 2 }
function host(overrides: Partial<PartySync> = {}): PartySync {
  return {
    isHost: true, currentUserId: 1, partyMediaItemId: 1, partyEpisodeId: 11,
    isPlaying: true, rev: 1, hlsStartSec: 0,
    tickRef: { current: null }, seekRef: { current: null }, helloAbsMsRef: { current: 0 },
    requestPlay: vi.fn(), requestPause: vi.fn(), requestSeek: vi.fn(), ...overrides,
  }
}

it('Play for all waits for the new episode to boot and broadcasts exactly one Play', async () => {
  let party = host()
  const advance = vi.fn(async () => 'advanced' as const)
  const player = (target: PlayTarget) => <VideoPlayer target={target} party={party} onClose={() => {}} onPartyAdvance={advance} />
  const view = render(player(oldEpisode))
  await bootHls()
  video().currentTime = 900
  fireEvent.timeUpdate(video())
  fireEvent.click(screen.getByRole('button', { name: 'Play for all' }))
  await settle()
  expect(advance).toHaveBeenCalledOnce()
  vi.mocked(party.requestPlay).mockClear()
  vi.mocked(party.requestPause).mockClear()
  vi.mocked(party.requestSeek).mockClear()
  party = { ...party, partyEpisodeId: 12, isPlaying: false, rev: 2 }
  view.rerender(player(oldEpisode))
  await settle()
  expect(video().paused).toBe(true)
  expect(party.requestPlay).not.toHaveBeenCalled()
  fireEvent.play(video()); fireEvent.pause(video()); fireEvent.seeked(video())
  expect(party.requestPlay).not.toHaveBeenCalled()
  expect(party.requestPause).not.toHaveBeenCalled()
  expect(party.requestSeek).not.toHaveBeenCalled()

  const pending = deferred<Awaited<ReturnType<typeof getStreamInfo>>>()
  vi.mocked(getStreamInfo).mockImplementation(() => pending.promise)
  view.rerender(player(nextEpisode))
  await settle()
  await act(async () => { vi.advanceTimersByTime(750) })
  expect(party.requestPlay).not.toHaveBeenCalled()
  pending.resolve(info() as Awaited<ReturnType<typeof getStreamInfo>>)
  await settle()
  expect(party.requestPlay).not.toHaveBeenCalled()
  await bootHls()
  expect(video().paused).toBe(false)
  expect(party.requestPlay).toHaveBeenCalledOnce()
  // A rebind before the server echo cannot replay host race recovery.
  party = { ...party, isHost: false }; view.rerender(player(nextEpisode)); await settle()
  party = { ...party, isHost: true }; view.rerender(player(nextEpisode)); await settle()
  expect(party.requestPlay).toHaveBeenCalledOnce()
})

it('a newer canonical Pause wins over the host advance while its boot is pending', async () => {
  let party = host({ partyEpisodeId: 12, isPlaying: false, rev: 2 })
  const player = () => <VideoPlayer target={nextEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await settle()
  party = { ...party, rev: 3, isPlaying: false }
  view.rerender(player())
  await bootHls()
  expect(video().paused).toBe(true)
  expect(party.requestPlay).not.toHaveBeenCalled()
})

it.each([false, true])('a delayed successful boot play respects a newer canonical Pause (muted fallback: %s)', async mutedFallback => {
  let finishPlay!: () => void
  if (mutedFallback) play.mockRejectedValueOnce(new DOMException('Autoplay policy refused sounded playback', 'NotAllowedError'))
  play.mockImplementationOnce(function(this: HTMLMediaElement) {
    const element = this
    paused.set(element, false)
    return new Promise<void>(resolve => {
      finishPlay = () => { element.dispatchEvent(new Event('play')); resolve() }
    })
  })
  let party = host({ partyEpisodeId: 12, isPlaying: false, rev: 2 })
  const player = () => <VideoPlayer target={nextEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await bootHls()
  party = { ...party, rev: 3, isPlaying: false }
  view.rerender(player()); await settle()
  finishPlay(); await settle()
  expect(party.requestPlay).not.toHaveBeenCalled()
  expect(party.requestPause).not.toHaveBeenCalled()
  expect(video().paused).toBe(true)
  expect(video().muted).toBe(false)
  expect(screen.queryByRole('button', { name: /sound/i })).toBeNull()
})

it('revalidates async boot success without an event and ignores its later queued play event', async () => {
  const completion = deferred<void>()
  play.mockImplementationOnce(function(this: HTMLMediaElement) {
    paused.set(this, false)
    return completion.promise
  })
  let party = host({ partyEpisodeId: 12, isPlaying: false, rev: 2 })
  const player = () => <VideoPlayer target={nextEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await bootHls()
  party = { ...party, rev: 3, isPlaying: false }
  view.rerender(player()); await settle()
  completion.resolve(); await settle()
  expect(video().paused).toBe(true)
  fireEvent.play(video())
  expect(party.requestPlay).not.toHaveBeenCalled()
  expect(party.requestPause).not.toHaveBeenCalled()
  // An actual host click must still work inside the stale-echo suppression
  // window created by that rejected automatic play.
  fireEvent.click(video())
  await settle()
  expect(video().paused).toBe(false)
  expect(party.requestPlay).toHaveBeenCalledOnce()
})

it('a newer explicit host Play supersedes the pending boot so its completion cannot pause the host', async () => {
  const completion = deferred<void>()
  play.mockImplementationOnce(function(this: HTMLMediaElement) {
    paused.set(this, false)
    return completion.promise
  })
  let party = host({ partyEpisodeId: 12, isPlaying: false, rev: 2 })
  const player = () => <VideoPlayer target={nextEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await bootHls()
  party = { ...party, rev: 3, isPlaying: false }
  view.rerender(player()); await settle()
  await act(async () => { vi.advanceTimersByTime(250) })
  expect(video().paused).toBe(true)
  expect(party.requestPlay).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  await settle()
  expect(video().paused).toBe(false)
  expect(party.requestPlay).toHaveBeenCalledOnce()
  completion.resolve(); await settle()
  expect(video().paused).toBe(false)
  expect(party.requestPlay).toHaveBeenCalledOnce()
})

it('host-role recovery cannot broadcast an automatic boot superseded by Pause', async () => {
  const completion = deferred<void>()
  play.mockImplementationOnce(function(this: HTMLMediaElement) {
    paused.set(this, false)
    return completion.promise
  })
  let party = host({ isHost: false, partyEpisodeId: 12, isPlaying: false, rev: 2 })
  const player = () => <VideoPlayer target={nextEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await bootHls()
  party = { ...party, isHost: true, rev: 3, isPlaying: false }
  view.rerender(player()); await settle()
  expect(video().paused).toBe(true)
  expect(party.requestPlay).not.toHaveBeenCalled()
  completion.resolve(); await settle()
  expect(party.requestPlay).not.toHaveBeenCalled()
})

it('a slow outgoing-episode boot cannot autoplay after the room has moved', async () => {
  const pending = deferred<Awaited<ReturnType<typeof getStreamInfo>>>()
  vi.mocked(getStreamInfo).mockImplementation(() => pending.promise)
  let party = host()
  const player = () => <VideoPlayer target={oldEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await settle()
  party = { ...party, partyEpisodeId: 12, isPlaying: false, rev: 2 }
  view.rerender(player())
  pending.resolve(info() as Awaited<ReturnType<typeof getStreamInfo>>)
  await bootHls()
  expect(video().paused).toBe(true)
  expect(party.requestPlay).not.toHaveBeenCalled()
})

it('a guest holds the old episode instead of seeking it to the new episode position', async () => {
  let party = host({ isHost: false })
  const player = () => <VideoPlayer target={oldEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await bootHls()
  video().currentTime = 900
  party = { ...party, partyEpisodeId: 12, isPlaying: false, rev: 2 }
  party.tickRef.current = { abs_ms: 0, running: false, server_now_ms: Date.now(), rev: 2, receivedAtMs: Date.now() }
  view.rerender(player())
  await act(async () => { vi.advanceTimersByTime(1_000) })
  expect(video().paused).toBe(true)
  expect(video().currentTime).toBe(900)
  expect(party.requestPlay).not.toHaveBeenCalled()
  expect(party.requestPause).not.toHaveBeenCalled()
})

it('still recovers a legitimate initial host-role race on the matching episode', async () => {
  let party = host({ isHost: false })
  const player = () => <VideoPlayer target={oldEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await bootHls()
  expect(video().paused).toBe(false)
  party = { ...party, isHost: true, isPlaying: false }
  view.rerender(player()); await settle()
  expect(party.requestPlay).toHaveBeenCalledOnce()
})

it('does not restart the outgoing episode when pausing aborts a pending autoplay', async () => {
  let rejectPlay!: (error: Error) => void
  play.mockImplementationOnce(function(this: HTMLMediaElement) {
    paused.set(this, false)
    this.dispatchEvent(new Event('play'))
    return new Promise<void>((_resolve, reject) => { rejectPlay = reject })
  })
  let party = host()
  const player = () => <VideoPlayer target={oldEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await bootHls()
  vi.mocked(party.requestPlay).mockClear()
  party = { ...party, partyEpisodeId: 12, isPlaying: false, rev: 2 }
  view.rerender(player()); await settle()
  expect(video().paused).toBe(true)
  rejectPlay(new DOMException('The play() request was interrupted by pause()', 'AbortError'))
  await settle()
  expect(play).toHaveBeenCalledOnce()
  expect(video().paused).toBe(true)
  expect(video().muted).toBe(false)
  expect(party.requestPlay).not.toHaveBeenCalled()
  // Hold throughout the pending lookup even if another browser callback
  // starts the old element without emitting a play event.
  paused.set(video(), false)
  await act(async () => { vi.advanceTimersByTime(250) })
  expect(video().paused).toBe(true)
})

it('rejects a delayed muted retry after the boot target has become the outgoing episode', async () => {
  let rejectPlay!: (error: Error) => void
  play.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject }))
  let party = host()
  const player = () => <VideoPlayer target={oldEpisode} party={party} onClose={() => {}} />
  const view = render(player())
  await bootHls()
  party = { ...party, partyEpisodeId: 12, isPlaying: false, rev: 2 }
  view.rerender(player()); await settle()
  rejectPlay(new DOMException('Autoplay policy refused sounded playback', 'NotAllowedError'))
  await settle()
  expect(play).toHaveBeenCalledOnce()
  expect(video().paused).toBe(true)
  expect(video().muted).toBe(false)
  expect(party.requestPlay).not.toHaveBeenCalled()
})

it('still retries a current party autoplay-policy refusal with muted playback', async () => {
  play.mockRejectedValueOnce(new DOMException('Autoplay policy refused sounded playback', 'NotAllowedError'))
  const party = host()
  render(<VideoPlayer target={oldEpisode} party={party} onClose={() => {}} />)
  await bootHls()
  expect(play).toHaveBeenCalledTimes(2)
  expect(video().paused).toBe(false)
  expect(video().muted).toBe(true)
  expect(party.requestPlay).toHaveBeenCalledOnce()
})

it.each([
  { partyEpisodeId: null, targetEpisodeId: 11 },
  { partyEpisodeId: undefined, targetEpisodeId: 11 },
  { partyEpisodeId: 11, targetEpisodeId: undefined },
])('preserves host authority when either episode ID is unknown: %j', async ids => {
  const party = host({ partyEpisodeId: ids.partyEpisodeId, isPlaying: false })
  render(<VideoPlayer target={{ ...oldEpisode, episodeId: ids.targetEpisodeId }} party={party} onClose={() => {}} />)
  await bootHls()
  expect(video().paused).toBe(false)
  expect(party.requestPlay).toHaveBeenCalledOnce()
})

it('boots unrelated local content while joined to a party on another series', async () => {
  const party = host({ isPlaying: false })
  render(<VideoPlayer target={{ ...oldEpisode, mediaItemId: 2, episodeId: 21 }} party={party} onClose={() => {}} />)
  await bootHls()
  expect(video().paused).toBe(false)
  expect(party.requestPlay).not.toHaveBeenCalled()
})
