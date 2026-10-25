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
import { getSyncSamples } from '@/lib/syncDebug'

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

// A later level load, as hls.js delivers a live playlist reload.
async function levelUpdate(mediaStart: string | null, fragments: number) {
  const details = levelDetails(mediaStart, fragments)
  await act(async () => { fake.hls.at(-1)!.emit('LEVEL_UPDATED', { details, level: 0 }) }); await settle()
}
const playing = () => fireEvent(video(), new Event('playing'))
const roomTick = (absMs: number) => ({ abs_ms: absMs, server_now_ms: Date.now(), running: true, receivedAtMs: Date.now() })

describe('remux clock H1: an alignment that had no runway', () => {
  it('is retried on a later playlist load while the playhead is short of start_sec', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls(ORIGIN.toFixed(6), 1)
    expect(video().currentTime).toBe(0)
    playing(); video().currentTime = 1.2
    await levelUpdate(ORIGIN.toFixed(6), 2)
    expect(video().currentTime).toBeCloseTo(ALIGNED, 6)
  })

  it('is not retried once playback has passed start_sec', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls(ORIGIN.toFixed(6), 1)
    playing(); video().currentTime = 6
    await levelUpdate(ORIGIN.toFixed(6), 3)
    expect(video().currentTime).toBe(6)
  })

  it('never jumps away from a scrub', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} onSeekRebuild={vi.fn()} />); await bootHls(ORIGIN.toFixed(6), 1)
    playing(); video().currentTime = 2; fireEvent.timeUpdate(video())
    fireEvent.click(screen.getByRole('button', { name: 'Skip Intro' })); await settle()
    expect(video().currentTime).toBeCloseTo(24 - ORIGIN, 6)
    await levelUpdate(ORIGIN.toFixed(6), 3)
    expect(video().currentTime).toBeCloseTo(24 - ORIGIN, 6)
  })

  it('makes an unaligned party host re-anchor the room on its true position, once', async () => {
    const host = party({ isHost: true, isPlaying: true, tickRef: { current: roomTick(START_SEC * 1000) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={host} />); await bootHls(ORIGIN.toFixed(6), 1)
    playing(); video().currentTime = 0.5
    host.tickRef.current = roomTick(START_SEC * 1000 + 500)
    fireEvent.timeUpdate(video())
    expect(host.requestSeek).toHaveBeenCalledTimes(1)
    expect(host.requestSeek).toHaveBeenCalledWith(Math.round((ORIGIN + 0.5) * 1000))
    // No loop: later ticks and the seek's own echo (which comes back over
    // the sync socket; the host does not seek locally) send nothing more, and
    // the host no longer jumps to start_sec when runway appears.
    video().currentTime = 0.75; fireEvent.timeUpdate(video())
    host.seekRef.current = { abs_ms: Math.round((ORIGIN + 0.5) * 1000), by: 1, sequence: 1, rev: 2, running: true, receivedAtMs: Date.now() }
    await act(async () => { vi.advanceTimersByTime(250) }); await settle()
    fireEvent.timeUpdate(video())
    await levelUpdate(ORIGIN.toFixed(6), 3)
    expect(video().currentTime).toBe(0.75)
    expect(host.requestSeek).toHaveBeenCalledTimes(1)
  })

  it('waits while a newer canonical Pause holds the room, and sends no play', async () => {
    const paused = party({ isHost: true, isPlaying: false, tickRef: { current: { ...roomTick(START_SEC * 1000), running: false } } })
    const view = render(<VideoPlayer target={movie} onClose={() => {}} party={paused} />); await bootHls(ORIGIN.toFixed(6), 1)
    const playsBefore = vi.mocked(paused.requestPlay).mock.calls.length
    playing(); video().currentTime = 0.5; fireEvent.timeUpdate(video())
    expect(paused.requestSeek).not.toHaveBeenCalled()
    expect(vi.mocked(paused.requestPlay).mock.calls.length).toBe(playsBefore)
    // The host plays the room again: now the room runs from its anchor, a gap
    // ahead of the host's picture, and the re-anchor goes out.
    const resumed = { ...paused, isPlaying: true, tickRef: { current: roomTick(START_SEC * 1000) } }
    view.rerender(<VideoPlayer target={movie} onClose={() => {}} party={resumed} />); await settle()
    video().currentTime = 0.6; fireEvent.timeUpdate(video())
    expect(resumed.requestSeek).toHaveBeenCalledTimes(1)
    expect(resumed.requestSeek).toHaveBeenCalledWith(Math.round((ORIGIN + 0.6) * 1000))
  })

  it('sends nothing when the room already agrees with the host', async () => {
    const host = party({ isHost: true, isPlaying: true, tickRef: { current: roomTick(Math.round((ORIGIN + 0.5) * 1000)) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={host} />); await bootHls(ORIGIN.toFixed(6), 1)
    playing(); video().currentTime = 0.5; fireEvent.timeUpdate(video())
    expect(host.requestSeek).not.toHaveBeenCalled()
  })

  it('is never needed by an aligned host', async () => {
    const host = party({ isHost: true, isPlaying: true, tickRef: { current: roomTick(START_SEC * 1000) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={host} />); await bootHls()
    playing(); video().currentTime = ALIGNED + 0.3; fireEvent.timeUpdate(video())
    expect(host.requestSeek).not.toHaveBeenCalled()
  })

  it('is never applied to a guest, whose drift loop owns the position', async () => {
    const guest = party({ isHost: false, isPlaying: false })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} />); await bootHls()
    expect(video().currentTime).toBe(0)
    fireEvent.timeUpdate(video())
    expect(guest.requestSeek).not.toHaveBeenCalled()
  })
})

// MANIFEST_PARSED completes the boot; the first level load is separate.
async function manifestOnly() {
  await settle()
  await act(async () => { fake.hls.at(-1)!.emit('MANIFEST_PARSED') }); await settle()
}
async function firstLevel(mediaStart: string | null, fragments = 2) {
  const details = levelDetails(mediaStart, fragments)
  await act(async () => {
    fake.hls.at(-1)!.emit('LEVEL_UPDATED', { details, level: 0 })
    fake.hls.at(-1)!.emit('LEVEL_LOADED', { details, level: 0 })
  }); await settle()
}
const partyTick = async (ms = 250) => { await act(async () => { vi.advanceTimersByTime(ms) }); await settle() }
// A host's explicit seek as useParty stores it (the host is user 2).
const hostSeek = (absMs: number, sequence = 1) => ({ abs_ms: absMs, by: 2, sequence, rev: 2, running: true, receivedAtMs: Date.now() })
// A host's re-anchor: its key frame plus 0.35 s, just before start_sec.
const REANCHOR_MS = Math.round((ORIGIN + 0.35) * 1000)

describe("remux clock: a guest's room positions wait for its first level load", () => {
  it("holds a host's re-anchor until the first level load, then serves it in the window", async () => {
    const rebuild = vi.fn()
    const guest = party({ isHost: false, tickRef: { current: roomTick(REANCHOR_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={rebuild} />); await manifestOnly()
    guest.seekRef.current = hostSeek(REANCHOR_MS)
    guest.tickRef.current = roomTick(REANCHOR_MS)
    await partyTick()
    // On start_sec alone the target reads as before this session.
    expect(rebuild).not.toHaveBeenCalled()
    expect(video().currentTime).toBe(0)
    await firstLevel(ORIGIN.toFixed(6))
    // The pending seek, not the boot alignment, decides where the guest goes.
    expect(video().currentTime).toBe(0)
    guest.tickRef.current = roomTick(REANCHOR_MS)
    await partyTick()
    expect(rebuild).not.toHaveBeenCalled()
    expect(video().currentTime).toBeCloseTo(REANCHOR_MS / 1000 - ORIGIN, 6)
    expect(guest.requestSeek).not.toHaveBeenCalled()
  })

  it('leaves a guest that applied a party seek nothing to re-anchor if it becomes host', async () => {
    const guest = party({ isHost: false, tickRef: { current: roomTick(REANCHOR_MS) } })
    const view = render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={vi.fn()} />); await manifestOnly()
    guest.seekRef.current = hostSeek(REANCHOR_MS)
    await firstLevel(ORIGIN.toFixed(6))
    guest.tickRef.current = roomTick(REANCHOR_MS)
    await partyTick()
    expect(video().currentTime).toBeCloseTo(REANCHOR_MS / 1000 - ORIGIN, 6)
    playing()
    // Promoted with a room clock 2 s off its picture (mid rate-adjust, or a
    // stale tick): the room already follows the seek this player applied.
    const promoted = { ...guest, isHost: true, tickRef: { current: roomTick(REANCHOR_MS + 2000) } }
    view.rerender(<VideoPlayer target={movie} onClose={() => {}} party={promoted} onSeekRebuild={vi.fn()} />); await settle()
    // Past the applied seek's echo suppression, so a send would go out.
    await partyTick(400)
    promoted.tickRef.current = roomTick(REANCHOR_MS + 2000)
    video().currentTime = REANCHOR_MS / 1000 - ORIGIN + 0.25; fireEvent.timeUpdate(video())
    expect(promoted.requestSeek).not.toHaveBeenCalled()
  })

  it('rebuilds as before when the first level load reports no start', async () => {
    const rebuild = vi.fn()
    const guest = party({ isHost: false, tickRef: { current: roomTick(REANCHOR_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={rebuild} />); await manifestOnly()
    guest.seekRef.current = hostSeek(REANCHOR_MS)
    await partyTick()
    expect(rebuild).not.toHaveBeenCalled()
    await firstLevel(null)
    await partyTick()
    expect(rebuild).toHaveBeenCalledWith(REANCHOR_MS / 1000)
  })

  it('holds for a bounded time only', async () => {
    const rebuild = vi.fn()
    const guest = party({ isHost: false, tickRef: { current: roomTick(REANCHOR_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={rebuild} />); await manifestOnly()
    guest.seekRef.current = hostSeek(REANCHOR_MS)
    await partyTick()
    await partyTick(3500)
    expect(rebuild).not.toHaveBeenCalled()
    await partyTick(500)
    expect(rebuild).toHaveBeenCalledWith(REANCHOR_MS / 1000)
  })

  it('holds the drift loop too: no backward rebuild for a room inside the gap', async () => {
    const rebuild = vi.fn()
    const guest = party({ isHost: false, tickRef: { current: roomTick(REANCHOR_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={rebuild} />); await manifestOnly()
    guest.tickRef.current = roomTick(REANCHOR_MS)
    await partyTick()
    expect(rebuild).not.toHaveBeenCalled()
    guest.tickRef.current = roomTick(REANCHOR_MS)
    await firstLevel(ORIGIN.toFixed(6))
    // The first level load starts the guest at the room instead.
    expect(video().currentTime).toBeCloseTo(REANCHOR_MS / 1000 - ORIGIN, 6)
    guest.tickRef.current = roomTick(REANCHOR_MS)
    await partyTick()
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('never holds a transcode guest', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('transcode') as Awaited<ReturnType<typeof getStreamInfo>>)
    const rebuild = vi.fn()
    const guest = party({ isHost: false, tickRef: { current: roomTick(REANCHOR_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={rebuild} />); await manifestOnly()
    guest.seekRef.current = hostSeek(REANCHOR_MS)
    await partyTick()
    expect(rebuild).toHaveBeenCalledWith(REANCHOR_MS / 1000)
  })
})

describe('remux clock: a guest starts at the room, not at the key frame', () => {
  // An aligned host: the room runs from start_sec. Every guest on the same
  // start_sec used to begin at the key frame, as its host did, and agree only
  // because both clocks read high by the same gap.
  const ROOM_MS = START_SEC * 1000 + 300
  const decisionsSince = (before: number) => getSyncSamples().slice(before).map(s => s.decision)
  beforeEach(() => { window.__auroraSyncDebug = true })
  afterEach(() => { window.__auroraSyncDebug = false })

  it('aligns a same-start guest to the room before it plays: no snap, nothing sent', async () => {
    const guest = party({ isHost: false, tickRef: { current: roomTick(ROOM_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={vi.fn()} />); await bootHls()
    expect(video().currentTime).toBeCloseTo(ROOM_MS / 1000 - ORIGIN, 6)
    fireEvent(video(), new Event('seeked'))
    // It plays on from there, and the room moves with it.
    playing(); video().currentTime = ROOM_MS / 1000 - ORIGIN + 0.25
    guest.tickRef.current = roomTick(ROOM_MS)
    const before = getSyncSamples().length
    await partyTick()
    expect(decisionsSince(before)).toEqual(['ignore'])
    expect(video().currentTime).toBeCloseTo(ROOM_MS / 1000 - ORIGIN + 0.25, 6)
    expect(guest.requestSeek).not.toHaveBeenCalled()
    expect(guest.requestPause).not.toHaveBeenCalled()
  })

  it('falls back to the drift loop without runway, as before', async () => {
    const guest = party({ isHost: false, tickRef: { current: roomTick(ROOM_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={vi.fn()} />); await bootHls(ORIGIN.toFixed(6), 1)
    expect(video().currentTime).toBe(0)
    playing(); video().currentTime = 0.25
    guest.tickRef.current = roomTick(ROOM_MS)
    const before = getSyncSamples().length
    await partyTick()
    expect(decisionsSince(before)).toEqual(['hard-seek'])
    expect(video().currentTime).toBeCloseTo((ROOM_MS + 250) / 1000 - ORIGIN, 6)
  })

  it('leaves a guest that has played to the drift loop', async () => {
    const guest = party({ isHost: false, tickRef: { current: roomTick(ROOM_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={vi.fn()} />); await bootHls(ORIGIN.toFixed(6), 1)
    playing(); video().currentTime = 1
    guest.tickRef.current = roomTick(ROOM_MS)
    await levelUpdate(ORIGIN.toFixed(6), 3)
    expect(video().currentTime).toBe(1)
  })

  it('aligns to a paused room without playing it', async () => {
    const guest = party({ isHost: false, isPlaying: false, tickRef: { current: { ...roomTick(ROOM_MS), running: false } } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={vi.fn()} />); await manifestOnly()
    const plays = play.mock.calls.length
    await firstLevel(ORIGIN.toFixed(6))
    expect(video().currentTime).toBeCloseTo(ROOM_MS / 1000 - ORIGIN, 6)
    expect(play.mock.calls.length).toBe(plays)
    await partyTick()
    expect(video().paused).toBe(true)
    expect(video().currentTime).toBeCloseTo(ROOM_MS / 1000 - ORIGIN, 6)
    expect(guest.requestSeek).not.toHaveBeenCalled()
    expect(guest.requestPlay).not.toHaveBeenCalled()
  })

  it('does not align a guest whose party is on another episode', async () => {
    const episode: PlayTarget = { ...movie, episodeId: 5 }
    const guest = party({ isHost: false, partyEpisodeId: 6, tickRef: { current: roomTick(ROOM_MS) } })
    render(<VideoPlayer target={episode} onClose={() => {}} party={guest} onSeekRebuild={vi.fn()} />); await bootHls()
    expect(video().currentTime).toBe(0)
  })
})

describe('remux clock L2: the alignment seek is not a scrub, however late it lands', () => {
  it('consumes exactly the alignment seeked, by position, after any time window', async () => {
    const host = party({ isHost: true, isPlaying: true })
    render(<VideoPlayer target={movie} onClose={() => {}} party={host} />); await bootHls()
    // A first fragment slower than the old 10 s window.
    await act(async () => { vi.advanceTimersByTime(15000) }); await settle()
    fireEvent(video(), new Event('seeked'))
    expect(host.requestSeek).not.toHaveBeenCalled()
    // One-shot: a later seeked at the same spot is the host's again.
    fireEvent(video(), new Event('seeked'))
    expect(host.requestSeek).toHaveBeenCalledWith(START_SEC * 1000)
  })
})

describe('remux clock M2: a start that appears late', () => {
  it('is refused once the element has played: the clock stays on start_sec', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} profileId={7} />); await bootHls(null, 1)
    playing(); video().currentTime = 9.8
    await levelUpdate(ORIGIN.toFixed(6), 2)
    expect(video().currentTime).toBe(9.8)
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: (START_SEC + 9.8) * 1000 }), expect.any(AbortSignal))
  })

  it('is adopted if it arrives before anything played', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} profileId={7} />); await bootHls(null, 1)
    await levelUpdate(ORIGIN.toFixed(6), 2)
    expect(video().currentTime).toBeCloseTo(ALIGNED, 6)
    video().currentTime = 7
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    expect(reportProgress).toHaveBeenLastCalledWith(1, expect.objectContaining({ position_ms: Math.round((ORIGIN + 7) * 1000) }), expect.any(AbortSignal))
  })
})

describe('remux clock M1: native HLS (Safari/iOS path; unverified on WebKit)', () => {
  const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=20000000\nsource/stream.m3u8\n'
  const variant = (line: string | null) => [
    '#EXTM3U', '#EXT-X-START:TIME-OFFSET=0,PRECISE=YES', '#EXT-X-TARGETDURATION:10', '#EXT-X-MAP:URI="init.mp4"',
    ...(line === null ? [] : [line]), '#EXTINF:10.000000,', 'seg_00000.m4s', '#EXTINF:10.000000,', 'seg_00001.m4s', '',
  ].join('\n')
  let readyState = 4
  const fetchMock = vi.fn()
  function serve(variantBody: string | Promise<string> | Error) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/master.m3u8')) return { ok: true, text: async () => MASTER }
      if (variantBody instanceof Error) throw variantBody
      return { ok: true, text: async () => await variantBody }
    })
  }
  beforeEach(() => {
    readyState = 4
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15')
    vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue('maybe')
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockImplementation(() => readyState)
  })
  afterEach(() => { vi.unstubAllGlobals() })
  async function bootNative(profileId = 7) {
    render(<VideoPlayer target={movie} onClose={() => {}} profileId={profileId} />)
    await settle(); await settle()
  }
  async function progressAfter(sec: number) {
    video().currentTime = sec
    await act(async () => { vi.advanceTimersByTime(10000) }); await settle()
    return vi.mocked(reportProgress).mock.calls.at(-1)?.[1].position_ms
  }

  it('fetches the variant once, beside the unchanged src load, and adopts and aligns at loadedmetadata', async () => {
    readyState = 0
    serve(variant(`#AURORA-MEDIA-START:${ORIGIN.toFixed(6)}`))
    await bootNative()
    // Safari still loads exactly what it loaded before: the AirPlay-capable
    // cast-token master URL on src.
    expect(video().src).toContain('/api/stream/hls/cast-clone/master.m3u8?token=cast')
    expect(fetchMock.mock.calls.map(c => new URL(c[0]).pathname)).toEqual(['/api/stream/session/master.m3u8', '/api/stream/session/source/stream.m3u8'])
    expect(video().currentTime).toBe(0)
    readyState = 1
    fireEvent(video(), new Event('loadedmetadata')); await settle()
    expect(video().currentTime).toBeCloseTo(ALIGNED, 6)
    expect(await progressAfter(7)).toBe(Math.round((ORIGIN + 7) * 1000))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['the fetch fails', () => serve(new TypeError('Failed to fetch'))],
    ['the line is missing', () => serve(variant(null))],
    ['the value is implausible', () => serve(variant('#AURORA-MEDIA-START:27'))],
    ['the value is not seconds', () => serve(variant('#AURORA-MEDIA-START:soon'))],
  ])('behaves exactly as before when %s', async (_name, setup) => {
    setup()
    await bootNative()
    expect(video().currentTime).toBe(0)
    expect(await progressAfter(7)).toBe((START_SEC + 7) * 1000)
  })

  it('retries the alignment from the element’s seekable window once it leaves runway', async () => {
    const oneSegment = variant(`#AURORA-MEDIA-START:${ORIGIN.toFixed(6)}`).replace('#EXTINF:10.000000,\nseg_00001.m4s\n', '')
    serve(oneSegment)
    await bootNative()
    expect(video().currentTime).toBe(0)
    playing(); video().currentTime = 1
    let seekableEnd = 10
    vi.spyOn(HTMLMediaElement.prototype, 'seekable', 'get').mockImplementation(
      () => ({ length: 1, start: () => 0, end: () => seekableEnd }) as unknown as TimeRanges)
    fireEvent(video(), new Event('progress')); await settle()
    expect(video().currentTime).toBe(1)
    seekableEnd = 30
    fireEvent(video(), new Event('progress')); await settle()
    expect(video().currentTime).toBeCloseTo(ALIGNED, 6)
  })

  it('refuses a start that arrives after playback began', async () => {
    let release!: (body: string) => void
    serve(new Promise<string>(resolve => { release = resolve }))
    await bootNative()
    playing(); video().currentTime = 4
    release(variant(`#AURORA-MEDIA-START:${ORIGIN.toFixed(6)}`)); await settle(); await settle()
    expect(video().currentTime).toBe(4)
    expect(await progressAfter(4)).toBe((START_SEC + 4) * 1000)
  })

  it("holds a guest's party seek until the fetched start is applied", async () => {
    readyState = 0
    serve(variant(`#AURORA-MEDIA-START:${ORIGIN.toFixed(6)}`))
    const rebuild = vi.fn()
    const guest = party({ isHost: false, tickRef: { current: roomTick(REANCHOR_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={rebuild} />)
    await settle(); await settle()
    guest.seekRef.current = hostSeek(REANCHOR_MS)
    await partyTick()
    expect(rebuild).not.toHaveBeenCalled()
    readyState = 1
    fireEvent(video(), new Event('loadedmetadata')); await settle()
    await partyTick()
    expect(rebuild).not.toHaveBeenCalled()
    expect(video().currentTime).toBeCloseTo(REANCHOR_MS / 1000 - ORIGIN, 6)
  })

  it('stops holding a guest once its fetch has failed', async () => {
    serve(new TypeError('Failed to fetch'))
    const rebuild = vi.fn()
    const guest = party({ isHost: false, tickRef: { current: roomTick(REANCHOR_MS) } })
    render(<VideoPlayer target={movie} onClose={() => {}} party={guest} onSeekRebuild={rebuild} />)
    await settle(); await settle()
    guest.seekRef.current = hostSeek(REANCHOR_MS)
    await partyTick()
    expect(rebuild).toHaveBeenCalledWith(REANCHOR_MS / 1000)
  })

  it('never fetches for a transcode', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info('transcode') as Awaited<ReturnType<typeof getStreamInfo>>)
    serve(variant(`#AURORA-MEDIA-START:${ORIGIN.toFixed(6)}`))
    await bootNative()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await progressAfter(7)).toBe((START_SEC + 7) * 1000)
  })
})
