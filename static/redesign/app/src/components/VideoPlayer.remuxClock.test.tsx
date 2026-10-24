// @vitest-environment jsdom
// The remux playback clock through the real VideoPlayer (lib/mediaStart.ts):
// a remux's media time 0 is the key frame BEFORE start_sec, and the variant
// playlist reports where that is. Every consumer of the media clock must use
// the reported origin; the whole-second start_sec keeps the subtitle shift and
// the receiver fallback. Mocks only delivery, telemetry and CAF.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer, type PlayTarget, type PartySync } from './VideoPlayer'
import { createCastToken, createSession, getStreamInfo, keepalive } from '@/lib/streaming'
import { reportProgress } from '@/lib/api'

const fake = vi.hoisted(() => ({
  getter: null as null | ((at?: number) => Promise<unknown>),
  cast: {
    status: { supported: true, available: true, connected: false, settling: false, deviceName: 'TV' },
    remote: { contentId: null as string | null, clockContentId: null as string | null, mediaStatusSeq: 0, isMediaLoaded: true, isPaused: false, canSeek: true, currentTime: 0, duration: 1000, playerState: 'PLAYING' as string | null, idleReason: null as string | null, updateSeq: 0 },
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
  createCastToken: vi.fn(), createDirectCastToken: vi.fn(),
}))
vi.mock('@/lib/api', async original => ({
  ...await original<typeof import('@/lib/api')>(), reportProgress: vi.fn(async () => {}), markWatched: vi.fn(async () => ({})),
}))
vi.mock('@/lib/prewarm', () => ({ prewarmEnabled: () => false, takeWarmedSession: () => null }))
vi.mock('@/lib/playbackQoE', () => ({ attachPlaybackQoE: () => new Proxy({}, { get: (_target, name) => name === 'isFinished' ? () => false : () => {} }) }))

// What the Chromium run measured for a 25 s resume on a 10 s-GOP Matroska file:
// the copy began at the key frame at 20 s, whose audio leads it to 19.946 s.
const START_SEC = 25
const ORIGIN = 19.946009
const ALIGNED = START_SEC - ORIGIN

const movie: PlayTarget = { mediaItemId: 1, fileId: 10, fileType: 'media', title: 'Movie', resumePositionMs: START_SEC * 1000 }
function info(decision: 'direct_stream' | 'transcode') {
  return {
    stream: {
      decision, remux: decision === 'direct_stream', stream_url: '/file.mkv', duration_ms: 1_000_000,
      video_codec: 'h264', audio_codec: 'aac', audio_codec_out: 'aac', container: 'matroska', resolution: '1920x1080', width: 1920, height: 1080,
    },
    audio_tracks: [{ index: 0, title: 'English', codec: 'aac' }],
    subtitles: [{ index: 2, language: 'eng', title: 'English subs', codec: 'subrip' }],
    markers: [{ kind: 'intro', start_ms: 20_000, end_ms: 24_000 }],
  }
}
// The level playlist as hls.js parses it: the server's comment line lands on
// the first fragment's tagList.
function levelDetails(mediaStart: string | null, fragments = 2) {
  return {
    live: true,
    fragments: Array.from({ length: fragments }, (_, i) => ({
      start: i * 10, duration: 10,
      tagList: i === 0 && mediaStart !== null ? [['AURORA-MEDIA-START', mediaStart], ['INF', '10.000000']] : [['INF', '10.000000']],
    })),
  }
}

const paused = new WeakMap<HTMLMediaElement, boolean>()
const play = vi.fn(function(this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve() })
async function settle() { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }) }
function video() { return document.querySelector('video')! }
// Boot the way hls.js does: MANIFEST_PARSED completes the boot, then the first
// level load fires LEVEL_UPDATED (inside hls.js's own handler) and LEVEL_LOADED.
async function bootHls(mediaStart: string | null = ORIGIN.toFixed(6), fragments = 2) {
  await settle()
  await act(async () => { fake.hls.at(-1)!.emit('MANIFEST_PARSED') }); await settle()
  const details = levelDetails(mediaStart, fragments)
  await act(async () => {
    fake.hls.at(-1)!.emit('LEVEL_UPDATED', { details, level: 0 })
    fake.hls.at(-1)!.emit('LEVEL_LOADED', { details, level: 0 })
  }); await settle()
}
function party(overrides: Partial<PartySync>): PartySync {
  return {
    isHost: true, currentUserId: 1, partyMediaItemId: 1, partyEpisodeId: null, isPlaying: true, rev: 1, hlsStartSec: 0,
    tickRef: { current: null }, seekRef: { current: null }, helloAbsMsRef: { current: 0 },
    requestPlay: vi.fn(), requestPause: vi.fn(), requestSeek: vi.fn(), ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.clearAllMocks(); fake.hls.length = 0; localStorage.clear()
  Object.assign(fake.cast.status, { connected: false, settling: false })
  Object.assign(fake.cast.remote, { contentId: null, clockContentId: null, mediaStatusSeq: 0, isMediaLoaded: true, isPaused: false, currentTime: 0, duration: 1000, playerState: 'PLAYING', idleReason: null, updateSeq: 0 })
  fake.cast.start.mockReset().mockImplementation(async () => {
    const load = await fake.getter?.() as { contentUrl: string; startTime?: number } | null
    if (load) Object.assign(fake.cast.remote, { contentId: load.contentUrl, clockContentId: load.contentUrl, currentTime: load.startTime ?? 0, updateSeq: 1, mediaStatusSeq: 1 })
    fake.cast.status.connected = true
  })
  vi.mocked(createCastToken).mockReset().mockResolvedValue({ playlist: '/api/stream/hls/cast-clone/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: 12 })
  vi.mocked(getStreamInfo).mockReset().mockResolvedValue(info('direct_stream') as Awaited<ReturnType<typeof getStreamInfo>>)
  vi.mocked(createSession).mockReset().mockImplementation(async request => ({ session_id: `session-${fake.hls.length}`, master_playlist: '/api/stream/session/master.m3u8', start_sec: request.start_sec ?? 0 } as Awaited<ReturnType<typeof createSession>>))
  vi.mocked(keepalive).mockReset().mockResolvedValue('ok')
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

describe('remux clock: media time 0 is the measured key frame, not start_sec', () => {
  it('starts the element at start_sec inside the session, so the clock still reads start_sec', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ start_sec: START_SEC, remux: true }), expect.anything())
    expect(video().currentTime).toBeCloseTo(ALIGNED, 6)
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuenow', String(START_SEC))
  })

  it('starts at the key frame, on the true clock, when only the first segment is out', async () => {
    // Aligning 5 s into the only published 10 s segment would play 4.9 s and
    // then stall until hls.js's next reload lists segment 1.
    render(<VideoPlayer target={movie} onClose={() => {}} profileId={7} />); await bootHls(ORIGIN.toFixed(6), 1)
    expect(video().currentTime).toBe(0)
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuenow', String(Math.floor(ORIGIN)))
    video().currentTime = 7
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: Math.round((ORIGIN + 7) * 1000) }), expect.any(AbortSignal))
  })

  it('writes progress on the true clock', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} profileId={7} />); await bootHls()
    video().currentTime = 7
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: Math.round((ORIGIN + 7) * 1000) }), expect.any(AbortSignal))
  })

  it('shows the true position and fires skip markers on it', async () => {
    const rebuild = vi.fn()
    render(<VideoPlayer target={movie} onClose={() => {}} onSeekRebuild={rebuild} />); await bootHls()
    // 2 s into the media is 21.9 s of the film: inside the 20-24 s intro. The
    // start_sec clock called it 27 s and never offered the skip.
    video().currentTime = 2; fireEvent.timeUpdate(video())
    expect(screen.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuenow', String(Math.floor(ORIGIN + 2)))
    fireEvent.click(screen.getByRole('button', { name: 'Skip Intro' })); await settle()
    // 24 s is inside what this session produced (19.9-39.9 s): a plain seek,
    // not a rebuild for a position "before the anchor".
    expect(rebuild).not.toHaveBeenCalled()
    expect(video().currentTime).toBeCloseTo(24 - ORIGIN, 6)
  })

  it('serves a backward seek between the key frame and start_sec from the same session', async () => {
    const rebuild = vi.fn()
    render(<VideoPlayer target={movie} onClose={() => {}} onSeekRebuild={rebuild} />); await bootHls()
    fireEvent.keyDown(document, { key: 'ArrowLeft' }); await settle()
    // 25 - 10 = 15 s is before the key frame (19.9 s): only that rebuilds.
    expect(rebuild).toHaveBeenCalledWith(15)
  })

  it('hands the cast clone the true position (?at=)', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    video().currentTime = 7
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    expect(createCastToken).toHaveBeenCalledWith(expect.any(String), { atSec: ORIGIN + 7 })
    // The receiver conversion still subtracts the clone's own start_sec.
    expect(fake.cast.remote.currentTime).toBeCloseTo(ORIGIN + 7 - 12, 6)
  })

  it('keeps the legacy receiver fallback on the session start_sec', async () => {
    // A cast-token response without start_sec (an older server, or a session
    // gone mid-mint) falls back to the LOCAL session's -ss anchor, as before.
    vi.mocked(createCastToken).mockResolvedValue({ playlist: '/api/stream/hls/old/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    video().currentTime = 7
    fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle()
    expect(fake.cast.remote.currentTime).toBeCloseTo(ORIGIN + 7 - START_SEC, 6)
  })

  it('keeps the whole-second start_sec for the subtitle cue shift', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }))
    fireEvent.click(screen.getByRole('button', { name: /English subs/ })); await settle()
    // The endpoint Atoi()s `start`; a fractional origin there would disable
    // the shift entirely.
    expect(document.querySelector('track')!.getAttribute('src')).toContain(`start=${START_SEC}&remux=1`)
  })

  it('broadcasts a host pause on the true clock, and not the boot alignment as a seek', async () => {
    const host = party({ isHost: true })
    render(<VideoPlayer target={movie} onClose={() => {}} party={host} />); await bootHls()
    fireEvent(video(), new Event('seeked'))
    expect(host.requestSeek).not.toHaveBeenCalled()
    video().currentTime = 7; video().pause(); await settle()
    expect(host.requestPause).toHaveBeenCalledWith(Math.round((ORIGIN + 7) * 1000))
  })

  it('drifts a guest onto the room clock in true media time', async () => {
    const tick = () => ({ abs_ms: 40_000, server_now_ms: Date.now(), running: true, receivedAtMs: Date.now() })
    const guest = party({ isHost: false, tickRef: { current: tick() } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} />); await bootHls()
    guest.tickRef.current = tick()
    await act(async () => { vi.advanceTimersByTime(250) }); await settle()
    // Room at 40 s: 40 - 19.946 into this session (the start_sec clock put
    // the guest at 15 s of media, i.e. 35.1 s of film, five seconds behind).
    expect(video().currentTime).toBeGreaterThan(40 - ORIGIN - 0.01)
    expect(video().currentTime).toBeLessThan(40 - ORIGIN + 0.6)
  })
})

describe('remux clock: what must not move', () => {
  it('leaves a transcode on start_sec even if its playlist carried a start', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('transcode') as Awaited<ReturnType<typeof getStreamInfo>>)
    render(<VideoPlayer target={movie} onClose={() => {}} profileId={7} />); await bootHls()
    expect(video().currentTime).toBe(0)
    video().currentTime = 7
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: (START_SEC + 7) * 1000 }), expect.any(AbortSignal))
  })

  it('keeps start_sec for a remux whose playlist reports nothing (older server)', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} profileId={7} />); await bootHls(null)
    expect(video().currentTime).toBe(0)
    video().currentTime = 7
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: (START_SEC + 7) * 1000 }), expect.any(AbortSignal))
  })

  it('does not jump a playhead that already moved before the playlist arrived', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} profileId={7} />)
    await settle()
    await act(async () => { fake.hls.at(-1)!.emit('MANIFEST_PARSED') }); await settle()
    video().currentTime = 3
    const details = levelDetails(ORIGIN.toFixed(6))
    await act(async () => { fake.hls.at(-1)!.emit('LEVEL_UPDATED', { details, level: 0 }) }); await settle()
    expect(video().currentTime).toBe(3)
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: Math.round((ORIGIN + 3) * 1000) }), expect.any(AbortSignal))
  })
})
