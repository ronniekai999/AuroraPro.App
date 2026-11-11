// @vitest-environment jsdom
// The player's chrome, through the real VideoPlayer: the controls the viewer
// is offered, and above all the cases where one must NOT be offered or must
// not touch the stream (speed in a party or on a cast, picture in picture on
// a cast, the boxed layout outside a party). Delivery, telemetry and the Cast
// SDK are mocked; nothing else is.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VideoPlayer, type PlayTarget, type PartySync } from './VideoPlayer'
import { createSession, getStreamInfo, keepalive } from '@/lib/streaming'
import { getAdminSkipMarkers, reportProgress } from '@/lib/api'
import { DOUBLE_TAP_MS } from '@/lib/playerChrome'

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
  createCastToken: vi.fn(async () => ({ playlist: '/api/stream/cast/master.m3u8?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999, start_sec: 0 })),
  createDirectCastToken: vi.fn(async () => ({ url: '/api/stream/direct/media/10?token=cast', token: 'eyJhbGciOiJub25lIn0.eyJzY29wZSI6InN0cmVhbTpjYXN0In0.x', expires_at: 9999999999 })),
}))
vi.mock('@/lib/api', async original => ({
  ...await original<typeof import('@/lib/api')>(),
  reportProgress: vi.fn(async () => {}),
  getAdminSkipMarkers: vi.fn(async () => []),
}))
vi.mock('@/lib/prewarm', () => ({ prewarmEnabled: () => false, takeWarmedSession: () => null }))
vi.mock('@/lib/playbackQoE', () => ({ attachPlaybackQoE: () => new Proxy({}, { get: (_target, name) => name === 'isFinished' ? () => false : () => {} }) }))

type Info = Awaited<ReturnType<typeof getStreamInfo>>
function info(over: Record<string, unknown> = {}) {
  return {
    stream: { decision: 'transcode', stream_url: '/file.mp4', duration_ms: 1_000_000, video_codec: 'h264', audio_codec: 'aac', audio_codec_out: 'aac', container: 'mp4', width: 1920, height: 1080 },
    audio_tracks: [{ index: 0, title: 'English', codec: 'aac', channels: 6 }, { index: 1, title: 'French', codec: 'aac', channels: 2 }],
    subtitles: [{ index: 2, language: 'eng', title: 'English subs', codec: 'subrip' }],
    markers: [],
    ...over,
  } as unknown as Info
}
const paused = new WeakMap<HTMLMediaElement, boolean>()
const play = vi.fn(function(this: HTMLMediaElement) { paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve() })
async function settle() { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }) }
async function bootHls() { await settle(); await act(async () => { fake.hls.at(-1)!.emit('MANIFEST_PARSED') }); await settle() }
function video() { return document.querySelector('video')! }
const surface = () => screen.getByRole('dialog', { name: /^Playing / })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.clearAllMocks(); fake.hls.length = 0; localStorage.clear()
  Object.assign(fake.cast.status, { supported: true, available: true, connected: false, settling: false })
  Object.assign(fake.cast.remote, { isMediaLoaded: true, isPaused: false, currentTime: 0, duration: 1000, playerState: 'PLAYING', idleReason: null, updateSeq: 0 })
  fake.cast.start.mockImplementation(async () => { await fake.getter?.(); fake.cast.status.connected = true })
  fake.cast.loadCurrent.mockImplementation(async (at?: number) => { await fake.getter?.(at) })
  vi.mocked(getStreamInfo).mockResolvedValue(info())
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
// The boxed layout is honoured from 1024px; `wide` says which side this
// "window" is on. jsdom has no layout, so the query is answered here.
let wide = true
const mediaListeners = new Set<() => void>()
function setWide(next: boolean) { wide = next; act(() => { mediaListeners.forEach(fn => fn()) }) }
beforeEach(() => {
  wide = true; mediaListeners.clear()
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    get matches() { return /min-width:\s*1024px/.test(query) ? wide : false },
    media: query, onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    addEventListener: (_: string, fn: () => void) => { mediaListeners.add(fn) },
    removeEventListener: (_: string, fn: () => void) => { mediaListeners.delete(fn) },
  }) as unknown as MediaQueryList)
})
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks()
  delete (document as unknown as Record<string, unknown>).pictureInPictureEnabled
  delete (document as unknown as Record<string, unknown>).pictureInPictureElement
  delete (document as unknown as Record<string, unknown>).exitPictureInPicture
  delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestPictureInPicture
  document.documentElement.removeAttribute('data-player-layout')
})

const movie: PlayTarget = { mediaItemId: 1, fileId: 10, fileType: 'media', title: 'Movie' }
const otherMovie: PlayTarget = { mediaItemId: 2, fileId: 20, fileType: 'media', title: 'Other movie' }
const episode: PlayTarget = { mediaItemId: 3, fileId: 30, fileType: 'episode', episodeId: 31, title: 'Series', subtitle: 'S1 · E1', seasonNumber: 1, episodeNumber: 1 }
function partyOf(overrides: Partial<PartySync> = {}): PartySync {
  return {
    isHost: true, currentUserId: 1, partyMediaItemId: 1,
    isPlaying: true, rev: 1, hlsStartSec: 0,
    tickRef: { current: null }, seekRef: { current: null }, helloAbsMsRef: { current: 0 },
    requestPlay: vi.fn(), requestPause: vi.fn(), requestSeek: vi.fn(), ...overrides,
  }
}
const speedButton = () => screen.getByRole('button', { name: /^Playback speed/ })
async function pickSpeed(label: string | RegExp) {
  fireEvent.click(speedButton())
  fireEvent.click(screen.getByRole('menuitemradio', { name: label })); await settle()
}
async function castAndExpand(view: ReturnType<typeof render>, element: () => React.ReactElement) {
  fireEvent.click(screen.getByRole('button', { name: 'Cast' })); await settle(); view.rerender(element()); await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
}

describe('playback speed', () => {
  it('applies the chosen rate to the element and shows it on the button', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(speedButton()).toHaveAccessibleName('Playback speed, 1x')
    await pickSpeed('1.5x')
    expect(video().playbackRate).toBe(1.5)
    expect(speedButton()).toHaveAccessibleName('Playback speed, 1.5x')
    // The menu closed with the pick.
    expect(screen.queryByRole('dialog', { name: 'Playback speed' })).toBeNull()
    await pickSpeed(/^Normal/)
    expect(video().playbackRate).toBe(1)
  })

  const lockedInParty = () => screen.getByRole('button', { name: 'Playback speed, 1x. Locked to the party' })

  it.each([['host', true], ['guest', false]])('is locked for a party %s; the control stays reachable and says why when pressed', async (_who, isHost) => {
    render(<VideoPlayer target={movie} party={partyOf({ isHost })} onClose={() => {}} />); await bootHls()
    const btn = lockedInParty()
    // Reachable by keyboard and by touch: aria-disabled, never `disabled`.
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).not.toBeDisabled()
    // The name still contains what is printed on it.
    expect(btn).toHaveTextContent('1x')
    fireEvent.click(btn)
    const note = screen.getByRole('dialog', { name: 'Playback speed' })
    expect(note).toHaveTextContent(/Everyone in a watch party plays at the same speed/)
    // An explanation, not a choice: no rate can be picked from it.
    expect(within(note).queryByRole('menuitemradio')).toBeNull()
    expect(video().playbackRate).toBe(1)
    expect(screen.queryByRole('button', { name: /^Playback speed, \d[\d.]*x$/ })).toBeNull()
  })

  it('is locked in a party room even while this player shows unrelated content', async () => {
    // The room can start controlling this media at any moment; a rate left
    // behind would then be read by the drift loop as drift.
    render(<VideoPlayer target={movie} party={partyOf({ partyMediaItemId: 999 })} onClose={() => {}} />); await bootHls()
    expect(lockedInParty()).toHaveAttribute('aria-disabled', 'true')
  })

  it('leaving a party mid drift-correction puts the element back at the rate the control shows', async () => {
    // The drift loop can leave 0.95 or 1.05 behind when the viewer leaves
    // mid-correction. The control would then read 1x over a rate that is not.
    const view = render(<VideoPlayer target={movie} party={partyOf({ isHost: false })} onClose={() => {}} />); await bootHls()
    video().playbackRate = 1.05
    view.rerender(<VideoPlayer target={movie} onClose={() => {}} />); await settle()
    expect(speedButton()).toHaveAccessibleName('Playback speed, 1x')
    expect(video().playbackRate).toBe(1)
  })

  it('never writes the element\'s rate in a party when no speed was ever chosen', async () => {
    const view = render(<VideoPlayer target={movie} party={partyOf({ isHost: false })} onClose={() => {}} />); await bootHls()
    // What the drift loop does to pull a guest back to the host's clock.
    video().playbackRate = 1.03
    view.rerender(<VideoPlayer target={movie} party={partyOf({ isHost: false, rev: 2 })} onClose={() => {}} />); await settle()
    fireEvent.loadedMetadata(video()); await settle()
    expect(video().playbackRate).toBe(1.03)
    expect(video().defaultPlaybackRate).toBe(1)
  })

  it('drops a chosen speed the moment a party begins, and gives the rate back to party sync', async () => {
    const view = render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    await pickSpeed('2x')
    expect(video().playbackRate).toBe(2)
    view.rerender(<VideoPlayer target={movie} party={partyOf()} onClose={() => {}} />); await settle()
    expect(video().playbackRate).toBe(1)
    expect(video().defaultPlaybackRate).toBe(1)
    // From here the element is party sync's again: a drift nudge must stick.
    video().playbackRate = 0.97
    fireEvent.loadedMetadata(video()); await settle()
    expect(video().playbackRate).toBe(0.97)
    // And leaving the party does not bring 2x back.
    view.rerender(<VideoPlayer target={movie} onClose={() => {}} />); await settle()
    expect(speedButton()).toHaveAccessibleName('Playback speed, 1x')
  })

  it('is locked while casting, and a chosen speed is dropped', async () => {
    const element = () => <VideoPlayer target={movie} onClose={() => {}} />
    const view = render(element()); await bootHls()
    await pickSpeed('1.25x')
    await castAndExpand(view, element)
    const btn = screen.getByRole('button', { name: 'Playback speed, 1x. Not available on another screen' })
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(btn)
    expect(screen.getByRole('dialog', { name: 'Playback speed' })).toHaveTextContent(/playing on another screen/)
    expect(video().playbackRate).toBe(1)
    expect(video().defaultPlaybackRate).toBe(1)
  })

  it('does not carry into the next title', async () => {
    const view = render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    await pickSpeed('1.5x')
    view.rerender(<VideoPlayer target={otherMovie} onClose={() => {}} />); await bootHls()
    expect(speedButton()).toHaveAccessibleName('Playback speed, 1x')
    expect(video().playbackRate).toBe(1)
    expect(video().defaultPlaybackRate).toBe(1)
  })

  it('survives a rebuild of the same title (an audio switch), including the element reset a new source causes', async () => {
    const view = render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    await pickSpeed('1.5x')
    view.rerender(<VideoPlayer target={{ ...movie, audioTrackIndex: 1, resumePositionMs: 5000 }} onClose={() => {}} />); await bootHls()
    expect(speedButton()).toHaveAccessibleName('Playback speed, 1.5x')
    // Loading a new source resets playbackRate to defaultPlaybackRate; an
    // engine that reset it to 1 instead is put right at loadedmetadata.
    expect(video().defaultPlaybackRate).toBe(1.5)
    video().playbackRate = 1
    fireEvent.loadedMetadata(video()); await settle()
    expect(video().playbackRate).toBe(1.5)
  })
})

describe('picture in picture', () => {
  const enablePip = () => {
    const request = vi.fn(async () => ({}))
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, writable: true, value: request })
    return request
  }

  it('is not offered where the browser cannot do it', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(screen.queryByRole('button', { name: /picture in picture/i })).toBeNull()
  })

  it('asks the element to enter, and follows the element\'s own events', async () => {
    const request = enablePip()
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    const btn = screen.getByRole('button', { name: 'Picture in picture' })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(btn)
    expect(request).toHaveBeenCalledOnce()
    await act(async () => { video().dispatchEvent(new Event('enterpictureinpicture')) })
    const exit = vi.fn(async () => {})
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: video() })
    Object.defineProperty(document, 'exitPictureInPicture', { configurable: true, value: exit })
    fireEvent.click(screen.getByRole('button', { name: 'Exit picture in picture' }))
    expect(exit).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledOnce()
    // Closed from the PiP window itself.
    await act(async () => { video().dispatchEvent(new Event('leavepictureinpicture')) })
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('is hidden while casting, and an open PiP window is closed when the cast begins', async () => {
    enablePip()
    const exit = vi.fn(async () => {})
    Object.defineProperty(document, 'exitPictureInPicture', { configurable: true, value: exit })
    const element = () => <VideoPlayer target={movie} onClose={() => {}} />
    const view = render(element()); await bootHls()
    Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: video() })
    await castAndExpand(view, element)
    expect(exit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /picture in picture/i })).toBeNull()
  })

  it('stays available in a watch party', async () => {
    enablePip()
    render(<VideoPlayer target={movie} party={partyOf()} onClose={() => {}} />); await bootHls()
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toBeInTheDocument()
  })
})

describe('double tap to seek', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }
  const tap = (x: number) => {
    fireEvent.pointerUp(video(), { pointerType: 'touch', clientX: x })
    fireEvent.click(video(), { clientX: x })
  }
  async function bootDirect(node: React.ReactElement) {
    vi.mocked(getStreamInfo).mockResolvedValue(info({ stream: { decision: 'direct_play', stream_url: '/file.mp4', duration_ms: 1_000_000, video_codec: 'h264', audio_codec: 'aac', audio_codec_out: 'aac', container: 'mp4' } }))
    const view = render(node); await settle()
    fireEvent.canPlay(video()); await settle()
    vi.spyOn(video(), 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
    return view
  }

  it('seeks exactly as the skip buttons do: ten seconds on at the right, ten back at the left', async () => {
    await bootDirect(<VideoPlayer target={movie} onClose={() => {}} />)
    video().currentTime = 100; fireEvent.timeUpdate(video())
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); await settle()
    const afterButton = video().currentTime
    expect(afterButton).toBe(110)
    video().currentTime = 100; fireEvent.timeUpdate(video())
    tap(800); tap(800); await settle()
    expect(video().currentTime).toBe(afterButton)
    expect(document.querySelector('.player-tap-flash')).toHaveTextContent('Forward 10 seconds')
    await act(async () => { vi.advanceTimersByTime(DOUBLE_TAP_MS + 1) })
    tap(100); tap(100); await settle()
    expect(video().currentTime).toBe(100)
    expect(document.querySelector('.player-tap-flash')).toHaveTextContent('Back 10 seconds')
  })

  it('every further quick tap seeks ten more: an odd count never ends in a pause', async () => {
    await bootDirect(<VideoPlayer target={movie} onClose={() => {}} />)
    video().currentTime = 100; fireEvent.timeUpdate(video())
    play.mockClear()
    tap(800); tap(800); tap(800); await settle()
    expect(video().currentTime).toBe(120)
    await act(async () => { vi.advanceTimersByTime(DOUBLE_TAP_MS * 3) })
    expect(video().paused).toBe(false)
    expect(video().currentTime).toBe(120)
  })

  it('a tap held for its window is dropped when the title changes, instead of pausing the next one', async () => {
    const view = await bootDirect(<VideoPlayer target={movie} onClose={() => {}} />)
    tap(800)
    view.rerender(<VideoPlayer target={otherMovie} onClose={() => {}} />); await settle()
    fireEvent.canPlay(video()); await settle()
    const before = video().paused
    await act(async () => { vi.advanceTimersByTime(DOUBLE_TAP_MS * 3) })
    expect(video().paused).toBe(before)
  })

  it('a party host\'s double tap is broadcast to the room exactly as the skip button\'s seek is', async () => {
    const viaButton = partyOf()
    const first = await bootDirect(<VideoPlayer target={movie} party={viaButton} onClose={() => {}} />)
    video().currentTime = 100; fireEvent.timeUpdate(video())
    fireEvent.click(screen.getByRole('button', { name: 'Skip forward 10 seconds' })); fireEvent.seeked(video()); await settle()
    const sent = vi.mocked(viaButton.requestSeek).mock.calls.map(c => c[0])
    first.unmount()
    const viaTap = partyOf()
    await bootDirect(<VideoPlayer target={movie} party={viaTap} onClose={() => {}} />)
    video().currentTime = 100; fireEvent.timeUpdate(video())
    tap(800); tap(800); fireEvent.seeked(video()); await settle()
    expect(vi.mocked(viaTap.requestSeek).mock.calls.map(c => c[0])).toEqual(sent)
  })

  it('does not pause or play: the first tap\'s own action is cancelled by the second', async () => {
    await bootDirect(<VideoPlayer target={movie} onClose={() => {}} />)
    const before = video().paused
    play.mockClear()
    tap(800); tap(800); await settle()
    await act(async () => { vi.advanceTimersByTime(DOUBLE_TAP_MS * 3) })
    expect(video().paused).toBe(before)
    expect(play).not.toHaveBeenCalled()
  })

  it('a single tap still toggles playback, once the double-tap window has passed', async () => {
    await bootDirect(<VideoPlayer target={movie} onClose={() => {}} />)
    expect(video().paused).toBe(false)
    tap(800)
    expect(video().paused).toBe(false)
    await act(async () => { vi.advanceTimersByTime(DOUBLE_TAP_MS + 1) })
    expect(video().paused).toBe(true)
  })

  it('two slow taps are two single taps, not a seek', async () => {
    await bootDirect(<VideoPlayer target={movie} onClose={() => {}} />)
    video().currentTime = 100; fireEvent.timeUpdate(video())
    tap(800)
    await act(async () => { vi.advanceTimersByTime(DOUBLE_TAP_MS + 1) })
    tap(800)
    await act(async () => { vi.advanceTimersByTime(DOUBLE_TAP_MS + 1) })
    expect(video().currentTime).toBe(100)
    expect(video().paused).toBe(false)
  })

  it('a mouse click is never delayed', async () => {
    await bootDirect(<VideoPlayer target={movie} onClose={() => {}} />)
    fireEvent.pointerUp(video(), { pointerType: 'mouse', clientX: 800 })
    fireEvent.click(video(), { clientX: 800 })
    expect(video().paused).toBe(true)
  })

  it('is refused for a party guest exactly as the buttons are: no seek, no broadcast, and the reason shown', async () => {
    const party = partyOf({ isHost: false })
    await bootDirect(<VideoPlayer target={movie} party={party} onClose={() => {}} />)
    video().currentTime = 100; fireEvent.timeUpdate(video())
    tap(800); tap(800); await settle()
    expect(video().currentTime).toBe(100)
    expect(party.requestSeek).not.toHaveBeenCalled()
    expect(document.querySelector('[data-player-notice-visible]')).toHaveTextContent('Only the party host can seek')
    // Nothing moved, so nothing claims it did.
    expect(document.querySelector('.player-tap-flash')).toBeNull()
  })
})

describe('the timeline draws the ranges the stream reports', () => {
  it('draws intro and credits where they fall, and nothing for a suppressed marker', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info({ markers: [
      { kind: 'intro', start_ms: 50_000, end_ms: 100_000 },
      { kind: 'credits', start_ms: 900_000, end_ms: 1_000_000 },
      { kind: 'recap', start_ms: 0, end_ms: 0 },
    ] }))
    render(<VideoPlayer target={episode} onClose={() => {}} />); await bootHls()
    const ranges = [...document.querySelectorAll<HTMLElement>('.stage-scrub-range')]
    expect(ranges.map(r => r.dataset.range)).toEqual(['intro', 'credits'])
    expect(ranges[0].style.left).toBe('5%'); expect(ranges[0].style.width).toBe('5%')
    expect(ranges[1].style.left).toBe('90%'); expect(ranges[1].style.width).toBe('10%')
    // Inside the slider's track, so they move and scale with it.
    expect(ranges[0].closest('[role="slider"]')).toBe(screen.getByRole('slider', { name: 'Seek' }))
  })

  it('draws none when the stream reports none', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(document.querySelector('.stage-scrub-range')).toBeNull()
  })
})

describe('one Audio and subtitles sheet', () => {
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Audio and subtitles' }))
  // A key press where the keyboard's focus is, as a browser delivers it.
  const press = (key: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key })

  it('lists audio and subtitles together, with the current subtitle choice marked', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(screen.queryByRole('button', { name: 'Subtitles' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Audio tracks' })).toBeNull()
    open()
    const sheet = screen.getByRole('dialog', { name: 'Audio and subtitles' })
    const audio = within(sheet).getByRole('group', { name: 'Audio' })
    expect(within(audio).getAllByRole('menuitemradio').map(o => o.textContent)).toEqual(['EnglishAAC 5.1', 'FrenchAAC stereo'])
    const subs = within(sheet).getByRole('group', { name: 'Subtitles' })
    expect(within(subs).getByRole('menuitemradio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true')
    expect(within(subs).getByRole('menuitemradio', { name: 'English subs' })).toHaveAttribute('aria-checked', 'false')
  })

  const checkedAudio = () =>
    within(screen.getByRole('group', { name: 'Audio' })).getAllByRole('menuitemradio', { checked: true }).map(o => o.textContent)

  it('marks the audio track that is playing: the file\'s default until the stream decision or the viewer says otherwise', async () => {
    // No decision index and no flagged track: every player starts the first.
    const view = render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    open()
    expect(checkedAudio()).toEqual(['EnglishAAC 5.1'])
    open()
    // The viewer's pick wins.
    view.rerender(<VideoPlayer target={{ ...movie, audioTrackIndex: 1 }} onClose={() => {}} />); await bootHls()
    open()
    expect(checkedAudio()).toEqual(['FrenchAAC stereo'])
  })

  it('marks the track the stream decision chose (a preferred language), and the flagged default when it chose none', async () => {
    const base = info()
    vi.mocked(getStreamInfo).mockResolvedValue({ ...base, stream: { ...base.stream, audio_track_index: 1 } } as Info)
    const first = render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    open()
    expect(checkedAudio()).toEqual(['FrenchAAC stereo'])
    first.unmount()
    vi.mocked(getStreamInfo).mockResolvedValue(info({
      stream: { ...base.stream, audio_track_index: -1 },
      audio_tracks: [{ index: 0, title: 'English', codec: 'aac', channels: 6 }, { index: 1, title: 'French', codec: 'aac', channels: 2, is_default: true }],
    }))
    render(<VideoPlayer target={otherMovie} onClose={() => {}} />); await bootHls()
    open()
    expect(checkedAudio()).toEqual(['FrenchAAC stereo'])
  })

  it('an audio pick asks the parent to rebuild at the live position and closes the sheet', async () => {
    const onChangeAudioTrack = vi.fn()
    render(<VideoPlayer target={movie} onChangeAudioTrack={onChangeAudioTrack} onClose={() => {}} />); await bootHls()
    video().currentTime = 42; fireEvent.timeUpdate(video())
    open()
    fireEvent.click(screen.getByRole('menuitemradio', { name: /French/ })); await settle()
    expect(onChangeAudioTrack).toHaveBeenCalledExactlyOnceWith(1, 42_000)
    expect(screen.queryByRole('dialog', { name: 'Audio and subtitles' })).toBeNull()
  })

  it.each([
    ['with focus in the sheet', () => screen.getByRole('dialog', { name: 'Audio and subtitles' })],
    ['with focus elsewhere in the player', () => screen.getByRole('button', { name: 'Close player' })],
    ['with focus on the page', () => document.body],
  ])('Escape closes the sheet and nothing else, %s', async (_where, target) => {
    const onClose = vi.fn()
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    render(<VideoPlayer target={movie} onClose={onClose} />); await bootHls()
    open()
    expect(screen.getByRole('dialog', { name: 'Audio and subtitles' })).toHaveFocus()
    const el = target(); if (el !== document.body) el.focus()
    fireEvent.keyDown(el, { key: 'Escape' })
    window.removeEventListener('keydown', outer)
    expect(screen.queryByRole('dialog', { name: 'Audio and subtitles' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // The app's own Escape handler (which closes the player) lives on window.
    expect(outer.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape')).toHaveLength(0)
  })

  it('gives focus back to the button that opened it, after a pick and after Escape', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    const trigger = screen.getByRole('button', { name: 'Audio and subtitles' })
    trigger.focus(); fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Audio and subtitles' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' }); await settle()
    expect(trigger).toHaveFocus()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'English subs' })); await settle()
    expect(trigger).toHaveFocus()
    // And the speed menu to its own button.
    const speed = speedButton()
    speed.focus(); fireEvent.click(speed)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '1.25x' })); await settle()
    expect(speedButton()).toHaveFocus()
  })

  it('moves between its items with the arrow keys, Home and End, wrapping at the ends', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    open()
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map(i => i.textContent)).toEqual(['EnglishAAC 5.1', 'FrenchAAC stereo', 'Off', 'English subs'])
    press('ArrowDown'); expect(items[0]).toHaveFocus()
    press('ArrowDown'); press('ArrowDown'); expect(items[2]).toHaveFocus()
    press('ArrowUp'); expect(items[1]).toHaveFocus()
    press('End'); expect(items[3]).toHaveFocus()
    press('ArrowDown'); expect(items[0]).toHaveFocus()
    press('ArrowUp'); expect(items[3]).toHaveFocus()
    press('Home'); expect(items[0]).toHaveFocus()
  })

  it('no key pressed inside it reaches the player\'s shortcuts: no volume change, no seek, no broadcast, no play or pause', async () => {
    const party = partyOf()
    render(<VideoPlayer target={movie} party={party} onClose={() => {}} />); await bootHls()
    video().currentTime = 200; fireEvent.timeUpdate(video())
    video().volume = 0.5
    const wasPaused = video().paused
    vi.mocked(party.requestSeek).mockClear(); vi.mocked(party.requestPause).mockClear(); vi.mocked(party.requestPlay).mockClear()
    open()
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'k', 'm', ' ']) press(key)
    await settle()
    expect(video().volume).toBe(0.5)
    expect(video().muted).toBe(false)
    expect(video().currentTime).toBe(200)
    expect(video().paused).toBe(wasPaused)
    expect(party.requestSeek).not.toHaveBeenCalled()
    expect(party.requestPause).not.toHaveBeenCalled()
    expect(party.requestPlay).not.toHaveBeenCalled()
    // The same keys do reach them once the sheet is closed (so the check
    // above is not passing because the shortcuts are dead in this harness).
    fireEvent.keyDown(window, { key: 'Escape' }); await settle()
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(video().volume).toBeCloseTo(0.55)
  })

  it('the marker editor is the exception: the arrow keys keep scrubbing while it is open', async () => {
    await (async () => {
      vi.mocked(getStreamInfo).mockResolvedValue(info({ stream: { decision: 'direct_play', stream_url: '/file.mp4', duration_ms: 1_000_000, video_codec: 'h264', audio_codec: 'aac', audio_codec_out: 'aac', container: 'mp4' } }))
      render(<VideoPlayer target={movie} isAdmin onClose={() => {}} />); await settle()
      fireEvent.canPlay(video()); await settle()
    })()
    video().currentTime = 100; fireEvent.timeUpdate(video())
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit skip markers/ })); await settle()
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Edit skip markers' }), { key: 'ArrowRight' }); await settle()
    expect(video().currentTime).toBe(110)
  })

  it('re-arms the auto-hide when it closes, with no further input', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    open()
    await act(async () => { vi.advanceTimersByTime(10_000) })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'English subs' })); await settle()
    const band = screen.getByRole('slider', { name: 'Seek' }).closest('[data-player-chrome]')!
    expect(band).not.toHaveAttribute('inert')
    // Focus went back to the opener by the keyboard-less path, so it does not pin the bars.
    ;(document.activeElement as HTMLElement | null)?.blur()
    await act(async () => { vi.advanceTimersByTime(3100) })
    expect(band).toHaveAttribute('inert')
  })

  it('a press on the picture closes the sheet without toggling playback', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    const wasPaused = video().paused
    open()
    fireEvent.click(video()); await settle()
    expect(screen.queryByRole('dialog', { name: 'Audio and subtitles' })).toBeNull()
    expect(video().paused).toBe(wasPaused)
  })

  it('is not offered when there is nothing to choose', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info({ audio_tracks: [{ index: 0, title: 'English' }], subtitles: [] }))
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(screen.queryByRole('button', { name: 'Audio and subtitles' })).toBeNull()
  })

  it('keeps the controls up for as long as a sheet is open', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(video().paused).toBe(false)
    open()
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(screen.getByRole('dialog', { name: 'Audio and subtitles' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Seek' }).closest('[data-player-chrome]')).not.toHaveAttribute('inert')
  })
})

describe('playback details and notices', () => {
  it('keeps the codec line out of the title bar and puts it in the overflow menu', async () => {
    vi.mocked(getStreamInfo).mockResolvedValue(info({ stream: { decision: 'direct_play', stream_url: '/file.mp4', duration_ms: 1_000_000, video_codec: 'h264', audio_codec: 'aac', audio_codec_out: 'aac', container: 'mp4' } }))
    render(<VideoPlayer target={episode} onClose={() => {}} />); await settle()
    fireEvent.canPlay(video()); await settle()
    expect(screen.getByRole('heading', { name: 'Series' })).toBeInTheDocument()
    expect(screen.getByText('S1 · E1')).toBeInTheDocument()
    expect(screen.queryByText(/Direct Play/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(within(screen.getByRole('dialog', { name: 'More' })).getByText('Direct play · H.264 / AAC')).toBeInTheDocument()
  })

  it('shows what the player is doing under the title, and says it where a screen reader can hear it', async () => {
    // Stream info that never answers: the boot stays at its first notice.
    vi.mocked(getStreamInfo).mockReturnValue(new Promise(() => {}))
    render(<VideoPlayer target={movie} onClose={() => {}} />); await settle()
    const visible = document.querySelector('[data-player-notice-visible]')!
    expect(visible).toHaveTextContent('Loading…')
    expect(visible.closest('[data-player-chrome]')).toBe(screen.getByRole('heading', { name: 'Movie' }).closest('[data-player-chrome]'))
    // The live region is NOT in the auto-hiding bar: that goes `inert`, and a
    // live region inside `inert` is never announced.
    const live = document.querySelector('[data-player-notice]')!
    expect(live).toHaveAttribute('role', 'status')
    expect(live).toHaveTextContent('Loading…')
    expect(live.closest('[data-player-chrome]')).toBeNull()
    expect(live.closest('[inert]')).toBeNull()
  })

  it('a notice that arrives while the bars are hidden brings them back', async () => {
    const party = partyOf({ isHost: false })
    render(<VideoPlayer target={movie} party={party} onClose={() => {}} />); await bootHls()
    const topBar = screen.getByRole('button', { name: 'Close player' }).closest('[data-player-chrome]')!
    await act(async () => { vi.advanceTimersByTime(3100) })
    expect(topBar).toHaveAttribute('inert')
    // A guest's seek is refused with a notice; the keyboard path does not
    // itself reveal anything before the refusal.
    await act(async () => { screen.getByRole('slider', { name: 'Seek', hidden: true }).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })) })
    await settle()
    expect(document.querySelector('[data-player-notice]')).toHaveTextContent('Only the party host can seek')
    expect(topBar).not.toHaveAttribute('inert')
  })
})

describe('the overflow menu', () => {
  const openMore = () => fireEvent.click(screen.getByRole('button', { name: 'More' }))

  it('offers the skip-marker editor to an admin watching alone, and it stays open across a press on the picture', async () => {
    render(<VideoPlayer target={movie} isAdmin onClose={() => {}} />); await bootHls()
    // No longer a button on the bar.
    expect(screen.queryByRole('button', { name: 'Edit skip markers' })).toBeNull()
    openMore()
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit skip markers/ })); await settle()
    expect(screen.getByRole('dialog', { name: 'Edit skip markers' })).toBeInTheDocument()
    expect(getAdminSkipMarkers).toHaveBeenCalledWith(10, 'media', expect.anything())
    // Setting a marker means pausing on a frame with the editor open.
    const wasPaused = video().paused
    fireEvent.click(video()); await settle()
    expect(video().paused).toBe(!wasPaused)
    expect(screen.getByRole('dialog', { name: 'Edit skip markers' })).toBeInTheDocument()
  })

  it('has no menu at all for a viewer with no actions, only the playback details', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    openMore()
    const sheet = screen.getByRole('dialog', { name: 'More' })
    expect(within(sheet).queryByRole('menu')).toBeNull()
    expect(within(sheet).queryByRole('menuitem')).toBeNull()
    expect(sheet).toHaveTextContent('Playback details')
  })

  it('keeps an unsaved marker draft across closing the editor to scrub', async () => {
    render(<VideoPlayer target={movie} isAdmin onClose={() => {}} />); await bootHls()
    video().currentTime = 42; fireEvent.timeUpdate(video())
    openMore()
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit skip markers/ })); await settle()
    // By attribute: a hidden element has no accessible name to be found by.
    const editor = () => document.querySelector<HTMLElement>('[data-player-sheet][aria-label="Edit skip markers"]')!
    fireEvent.click(within(editor()).getAllByRole('button', { name: 'End = now' })[1])
    expect(editor()).toHaveTextContent('0:00 to 0:42')
    fireEvent.keyDown(window, { key: 'Escape' }); await settle()
    expect(screen.queryByRole('dialog', { name: 'Edit skip markers' })).toBeNull()
    expect(editor()).toHaveAttribute('hidden')
    openMore()
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit skip markers/ })); await settle()
    expect(screen.getByRole('dialog', { name: 'Edit skip markers' })).toHaveTextContent('0:00 to 0:42')
    // Fetched once: reopening did not start over.
    expect(getAdminSkipMarkers).toHaveBeenCalledTimes(1)
  })

  it('closes the editor, and stops pinning the bars, when the viewer joins a party with it open', async () => {
    const view = render(<VideoPlayer target={movie} isAdmin onClose={() => {}} />); await bootHls()
    openMore()
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit skip markers/ })); await settle()
    view.rerender(<VideoPlayer target={movie} isAdmin party={partyOf()} onClose={() => {}} />); await settle()
    expect(document.querySelector('[data-player-sheet][aria-label="Edit skip markers"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false')
    await act(async () => { vi.advanceTimersByTime(3100) })
    expect(screen.getByRole('slider', { name: 'Seek', hidden: true }).closest('[data-player-chrome]')).toHaveAttribute('inert')
  })

  it('does not offer the editor to a member, or to an admin in a party', async () => {
    const view = render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    openMore()
    expect(screen.queryByRole('menuitem', { name: /Edit skip markers/ })).toBeNull()
    view.unmount()
    render(<VideoPlayer target={movie} isAdmin party={partyOf()} onClose={() => {}} />); await bootHls()
    openMore()
    expect(screen.queryByRole('menuitem', { name: /Edit skip markers/ })).toBeNull()
  })
})

describe('edge to edge by default, boxed only beside a party', () => {
  it('fills the window when watching alone, whatever was chosen in a party before', async () => {
    localStorage.setItem('aurora_player_boxed', '1')
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(surface()).toHaveAttribute('data-player-layout', 'fill')
    expect(document.documentElement.dataset.playerLayout).toBe('fill')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('menuitem', { name: /party chat/ })).toBeNull()
  })

  it('a party viewer can box the picture beside the chat, and the choice is remembered', async () => {
    const view = render(<VideoPlayer target={movie} party={partyOf()} onClose={() => {}} />); await bootHls()
    expect(surface()).toHaveAttribute('data-player-layout', 'fill')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Show beside the party chat/ })); await settle()
    expect(surface()).toHaveAttribute('data-player-layout', 'boxed')
    expect(document.documentElement.dataset.playerLayout).toBe('boxed')
    expect(localStorage.getItem('aurora_player_boxed')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Fill the window/ })); await settle()
    expect(document.documentElement.dataset.playerLayout).toBe('fill')
    expect(localStorage.getItem('aurora_player_boxed')).toBeNull()
    view.unmount()
    expect(document.documentElement.hasAttribute('data-player-layout')).toBe(false)
  })

  it('is neither offered nor applied in a window too narrow for it, and comes back when the window widens', async () => {
    localStorage.setItem('aurora_player_boxed', '1')
    wide = false
    render(<VideoPlayer target={movie} party={partyOf()} onClose={() => {}} />); await bootHls()
    expect(document.documentElement.dataset.playerLayout).toBe('fill')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('menuitem', { name: /party chat|Fill the window/ })).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    setWide(true); await settle()
    expect(document.documentElement.dataset.playerLayout).toBe('boxed')
    // The stored choice was not thrown away by the narrow spell.
    expect(localStorage.getItem('aurora_player_boxed')).toBe('1')
  })

  it('is not applied in browser fullscreen, where the party panel is not on screen', async () => {
    localStorage.setItem('aurora_player_boxed', '1')
    render(<VideoPlayer target={movie} party={partyOf()} onClose={() => {}} />); await bootHls()
    expect(document.documentElement.dataset.playerLayout).toBe('boxed')
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => surface() })
    await act(async () => { document.dispatchEvent(new Event('fullscreenchange')) })
    expect(document.documentElement.dataset.playerLayout).toBe('fill')
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('menuitem', { name: /party chat|Fill the window/ })).toBeNull()
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null })
    await act(async () => { document.dispatchEvent(new Event('fullscreenchange')) })
    expect(document.documentElement.dataset.playerLayout).toBe('boxed')
    delete (document as unknown as Record<string, unknown>).fullscreenElement
  })

  it('reports the in-window surface to the app either way, so the app behind stays inert', async () => {
    localStorage.setItem('aurora_player_boxed', '1')
    const onSurfaceChange = vi.fn()
    render(<VideoPlayer target={movie} party={partyOf()} onSurfaceChange={onSurfaceChange} onClose={() => {}} />); await bootHls()
    expect(document.documentElement.dataset.playerLayout).toBe('boxed')
    expect(onSurfaceChange).toHaveBeenLastCalledWith('theater')
  })
})

describe('the bars fade away in the window, not only in fullscreen', () => {
  it('hides the title bar and the control band together after three idle seconds of playback, and a pause brings them back', async () => {
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    const topBar = screen.getByRole('button', { name: 'Close player' }).closest('[data-player-chrome]')!
    const band = screen.getByRole('slider', { name: 'Seek' }).closest('[data-player-chrome]')!
    expect(topBar).not.toHaveAttribute('inert')
    await act(async () => { vi.advanceTimersByTime(3100) })
    expect(topBar).toHaveAttribute('inert')
    expect(band).toHaveAttribute('inert')
    await act(async () => { video().pause() })
    expect(topBar).not.toHaveAttribute('inert')
    expect(band).not.toHaveAttribute('inert')
  })
})

describe('where the timeline is, for everything placed above it', () => {
  // jsdom lays nothing out and has no ResizeObserver; both are supplied so
  // the test drives the same publish the browser does.
  const sizes = { band: 184, scrubTop: 56 }
  let observers: Array<{ fire: () => void; disconnected: boolean }> = []
  beforeEach(() => {
    observers = []
    sizes.band = 184; sizes.scrubTop = 56
    vi.stubGlobal('ResizeObserver', class {
      disconnected = false
      private readonly callback: () => void
      constructor(callback: () => void) { this.callback = callback; observers.push(this as never) }
      fire() { this.callback() }
      observe() {} unobserve() {}
      disconnect() { this.disconnected = true }
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('player-band') ? sizes.band : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'slider' && this.getAttribute('aria-label') === 'Seek' ? sizes.scrubTop : 0
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })
  const published = () => document.documentElement.style.getPropertyValue('--player-timeline-top')

  it('publishes the measured figure, follows the band when its rows wrap, and withdraws it when the player closes', async () => {
    const view = render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(published()).toBe('128px')
    // The transport row wraps to two (the party rail narrows the band).
    sizes.band = 226
    act(() => { observers.forEach(o => o.fire()) })
    expect(published()).toBe('170px')
    view.unmount()
    expect(published()).toBe('')
    expect(observers.every(o => o.disconnected)).toBe(true)
  })

  it('publishes nothing for a band with no layout, so the stylesheet figure stands', async () => {
    sizes.band = 0; sizes.scrubTop = 0
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(published()).toBe('')
  })
})

describe('next episode', () => {
  it('advances through the same path as the Up next card, forced past the autoplay setting', async () => {
    const onEnded = vi.fn(async () => true)
    render(<VideoPlayer target={episode} onEnded={onEnded} onClose={() => {}} />); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Next episode' })); await settle()
    expect(onEnded).toHaveBeenCalledExactlyOnceWith({ force: true })
  })

  it('says so when there is no next episode', async () => {
    const onEnded = vi.fn(async () => false)
    render(<VideoPlayer target={episode} onEnded={onEnded} onClose={() => {}} />); await bootHls()
    fireEvent.click(screen.getByRole('button', { name: 'Next episode' })); await settle()
    expect(screen.getByText(/That's the last episode/)).toBeInTheDocument()
  })

  it('is not offered on a film', async () => {
    render(<VideoPlayer target={movie} onEnded={vi.fn()} onClose={() => {}} />); await bootHls()
    expect(screen.queryByRole('button', { name: /^Next episode/ })).toBeNull()
  })

  it.each([['host', true], ['guest', false]])('is not offered to a party %s: advancing a room stays with the Up next card', async (_who, isHost) => {
    // A party advance marks the outgoing episode watched for the host and
    // moves every guest. That is right at the credits, where the Up next
    // card offers it in so many words, and wrong from a transport button
    // that can be pressed two minutes in.
    const advance = vi.fn(async () => 'advanced' as const)
    const onEnded = vi.fn(async () => true)
    const party = partyOf({ isHost, partyMediaItemId: 3, partyEpisodeId: 31 })
    render(<VideoPlayer target={episode} party={party} onEnded={onEnded} onPartyAdvance={advance} onClose={() => {}} />); await bootHls()
    video().currentTime = 120; fireEvent.timeUpdate(video())
    expect(screen.queryByRole('button', { name: /^Next episode/ })).toBeNull()
    expect(advance).not.toHaveBeenCalled()
    expect(onEnded).not.toHaveBeenCalled()
  })

  it('the host still advances the room from the Up next card, near the end', async () => {
    const advance = vi.fn(async () => 'advanced' as const)
    const party = partyOf({ partyMediaItemId: 3, partyEpisodeId: 31 })
    render(<VideoPlayer target={episode} party={party} onPartyAdvance={advance} onClose={() => {}} />); await bootHls()
    video().currentTime = 900; fireEvent.timeUpdate(video())
    expect(screen.queryByRole('button', { name: /^Next episode/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Play for all' })); await settle()
    expect(advance).toHaveBeenCalledOnce()
  })

  it('is not offered while casting, where the receiver owns the end of the episode', async () => {
    const element = () => <VideoPlayer target={episode} onEnded={vi.fn()} onClose={() => {}} />
    const view = render(element()); await bootHls()
    await castAndExpand(view, element)
    expect(screen.queryByRole('button', { name: /^Next episode/ })).toBeNull()
  })
})

describe('Resync to host', () => {
  const tick = { abs_ms: 300_000, server_now_ms: 0, running: true, rev: 1, receivedAtMs: 0 }
  const guest = (over: Partial<PartySync> = {}) => partyOf({ isHost: false, tickRef: { current: { ...tick, server_now_ms: Date.now() } } as PartySync['tickRef'], ...over })

  it('is a guest\'s control at every width: nothing breakpoint-gated hides it', async () => {
    render(<VideoPlayer target={movie} party={guest()} onClose={() => {}} />); await bootHls()
    const btn = screen.getByRole('button', { name: 'Resync to host' })
    for (let el: HTMLElement | null = btn; el && !el.hasAttribute('data-player-chrome'); el = el.parentElement) {
      expect(el.className, el.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    }
  })

  it('snaps the guest to the host\'s projected position at normal speed, without broadcasting', async () => {
    const party = guest()
    render(<VideoPlayer target={movie} party={party} onClose={() => {}} />); await bootHls()
    video().currentTime = 10; video().playbackRate = 1.05
    vi.mocked(party.requestSeek).mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Resync to host' })); fireEvent.seeked(video()); await settle()
    expect(video().currentTime).toBeCloseTo(300, 0)
    expect(video().playbackRate).toBe(1)
    expect(party.requestSeek).not.toHaveBeenCalled()
  })

  it('refuses a tick that belongs to another title', async () => {
    const party = guest({ partyMediaItemId: 999 })
    render(<VideoPlayer target={movie} party={party} onClose={() => {}} />); await bootHls()
    // The party does not control this media, so the control is not offered at all.
    expect(screen.queryByRole('button', { name: 'Resync to host' })).toBeNull()
  })

  it('is not offered to the host, or outside a party', async () => {
    const view = render(<VideoPlayer target={movie} party={partyOf()} onClose={() => {}} />); await bootHls()
    expect(screen.queryByRole('button', { name: 'Resync to host' })).toBeNull()
    view.unmount()
    render(<VideoPlayer target={movie} onClose={() => {}} />); await bootHls()
    expect(screen.queryByRole('button', { name: 'Resync to host' })).toBeNull()
  })
})

describe('AirPlay', () => {
  async function airplaying(node: React.ReactElement) {
    vi.mocked(getStreamInfo).mockResolvedValue(info({ stream: { decision: 'direct_play', stream_url: '/file.mp4', duration_ms: 1_000_000, video_codec: 'h264', audio_codec: 'aac', audio_codec_out: 'aac', container: 'mp4' } }))
    const view = render(node); await settle()
    fireEvent.canPlay(video()); await settle()
    Object.defineProperty(video(), 'webkitCurrentPlaybackTargetIsWireless', { configurable: true, value: true })
    await act(async () => { video().dispatchEvent(new Event('webkitcurrentplaybacktargetiswirelesschanged')) })
    view.rerender(node); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Expand player' })); await settle()
    return view
  }

  it('locks speed and hides picture in picture, as a Chromecast does', async () => {
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', { configurable: true, writable: true, value: vi.fn(async () => ({})) })
    await airplaying(<VideoPlayer target={movie} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: 'Playback speed, 1x. Not available on another screen' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('button', { name: /picture in picture/i })).toBeNull()
  })
})
