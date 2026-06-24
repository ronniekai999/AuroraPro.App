import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// withToken → identity so the direct-play warm URL is easy to assert.
// apiFetchResponse → route through the global fetch stub so the pre-encode GET's
// URL + abort signal are assertable exactly like the direct-play fetch.
vi.mock('./api', () => ({
  withToken: (u: string) => u,
  apiFetchResponse: (path: string, opts: { signal?: AbortSignal } = {}) =>
    fetch(path, { signal: opts.signal, credentials: 'same-origin' }),
}))

// Keep the PURE helpers (buildSessionRequest / sessionRequestKey) real — the
// reuse-key match they produce is exactly what we're testing — but stub the
// I/O calls the pre-warm module makes.
vi.mock('./streaming', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./streaming')>()
  return {
    ...actual,
    getStreamInfo: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
  }
})

import {
  buildSessionRequest,
  createSession,
  deleteSession,
  getStreamInfo,
  sessionRequestKey,
  type StreamDecision,
} from './streaming'
import { cancelPrewarm, prewarm, prewarmEnabled, takeWarmedSession } from './prewarm'

const mockGetStreamInfo = vi.mocked(getStreamInfo)
const mockCreateSession = vi.mocked(createSession)
const mockDeleteSession = vi.mocked(deleteSession)

// A bare transcode decision — buildSessionRequest reads only optional fields,
// so this exercises the undefined-field path too.
const TRANSCODE = { decision: 'transcode' } as StreamDecision
const reqFor = (fileId: number, startSec: number) =>
  buildSessionRequest(TRANSCODE, { fileId, fileType: 'media', startSec })

// A full 4K ABR ladder (highest-first), as CreateSession returns it.
const PROFILES = [
  { name: '2160p', width: 3840, height: 2160, bandwidth: 18_000_000 },
  { name: '1080p', width: 1920, height: 1080, bandwidth: 7_500_000 },
  { name: '720p', width: 1280, height: 720, bandwidth: 4_500_000 },
  { name: '480p', width: 854, height: 480, bandwidth: 2_200_000 },
]
const fetchCalls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so per-test mockResolvedValueOnce queues
  // never bleed across tests.
  vi.resetAllMocks()
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('#EXTM3U') }))
})

afterEach(() => {
  cancelPrewarm() // reset the module's single-slot state between tests
  vi.unstubAllGlobals()
})

describe('sessionRequestKey', () => {
  it('is order-independent and treats absent == present-but-undefined', () => {
    const a = { file_id: 1, file_type: 'media', remux: false, start_sec: undefined } as never
    const b = { start_sec: undefined, remux: false, file_type: 'media', file_id: 1 } as never
    const c = { file_id: 1, file_type: 'media', remux: false } as never
    expect(sessionRequestKey(a)).toBe(sessionRequestKey(b))
    expect(sessionRequestKey(a)).toBe(sessionRequestKey(c))
  })

  it('changes when any field changes (e.g. resume position)', () => {
    expect(sessionRequestKey(reqFor(1, 0))).not.toBe(sessionRequestKey(reqFor(1, 30)))
    expect(sessionRequestKey(reqFor(1, 0))).not.toBe(sessionRequestKey(reqFor(2, 0)))
  })
})

describe('prewarm / takeWarmedSession', () => {
  it('pre-creates a session and the player adopts it on an exact match (consume-once)', async () => {
    mockGetStreamInfo.mockResolvedValue({ stream: TRANSCODE } as never)
    mockCreateSession.mockResolvedValue({
      session_id: 'sess1',
      master_playlist: '/api/stream/hls/sess1/master.m3u8',
      start_sec: 0,
    } as never)

    await prewarm({ fileId: 7, fileType: 'media', startSec: 0 })
    expect(mockCreateSession).toHaveBeenCalledTimes(1)

    const taken = takeWarmedSession(reqFor(7, 0))
    expect(taken).toEqual({
      sessionId: 'sess1',
      masterPlaylist: '/api/stream/hls/sess1/master.m3u8',
      startSec: 0,
    })
    // consume-once: the player now owns teardown; a second take finds nothing.
    expect(takeWarmedSession(reqFor(7, 0))).toBeNull()
  })

  it('does NOT adopt a warmed session when the request differs', async () => {
    mockGetStreamInfo.mockResolvedValue({ stream: TRANSCODE } as never)
    mockCreateSession.mockResolvedValue({
      session_id: 'sess1',
      master_playlist: '/m',
      start_sec: 0,
    } as never)

    await prewarm({ fileId: 7, fileType: 'media', startSec: 0 })
    // Different resume position → different key → fall back to a fresh session,
    // and the now-unusable warm is discarded (not leaked).
    expect(takeWarmedSession(reqFor(7, 99))).toBeNull()
    expect(mockDeleteSession).toHaveBeenCalledWith('sess1')
  })

  it('is single-slot: a new target discards the previous warmed session', async () => {
    mockGetStreamInfo.mockResolvedValue({ stream: TRANSCODE } as never)
    mockCreateSession
      .mockResolvedValueOnce({ session_id: 'sessA', master_playlist: '/a', start_sec: 0 } as never)
      .mockResolvedValueOnce({ session_id: 'sessB', master_playlist: '/b', start_sec: 0 } as never)

    await prewarm({ fileId: 1, fileType: 'media', startSec: 0 })
    await prewarm({ fileId: 2, fileType: 'media', startSec: 0 })

    // The superseded warm is torn down; only the most recent one survives and
    // is adoptable. (Don't take(reqFor(1)) here — a miss would cancel B too.)
    expect(mockDeleteSession).toHaveBeenCalledWith('sessA')
    expect(takeWarmedSession(reqFor(2, 0))?.sessionId).toBe('sessB')
  })

  it('discards a stale warm past WARM_TTL_MS instead of adopting it', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    mockGetStreamInfo.mockResolvedValue({ stream: TRANSCODE } as never)
    mockCreateSession.mockResolvedValue({ session_id: 'sessStale', master_playlist: '/s', start_sec: 0 } as never)

    await prewarm({ fileId: 9, fileType: 'media', startSec: 0 })
    nowSpy.mockReturnValue(1_000_000 + 61_000) // advance past the 60s TTL

    expect(takeWarmedSession(reqFor(9, 0))).toBeNull()
    expect(mockDeleteSession).toHaveBeenCalledWith('sessStale')
    nowSpy.mockRestore()
  })

  it('deletes an in-flight session that resolves after its target was superseded', async () => {
    mockGetStreamInfo.mockResolvedValue({ stream: TRANSCODE } as never)
    // First createSession stays pending (deferred); the second resolves at once.
    let resolveA!: (v: unknown) => void
    const deferredA = new Promise((res) => { resolveA = res })
    mockCreateSession
      .mockReturnValueOnce(deferredA as never)
      .mockResolvedValueOnce({ session_id: 'sessB', master_playlist: '/b', start_sec: 0 } as never)

    const pA = prewarm({ fileId: 1, fileType: 'media', startSec: 0 }) // A starts
    // Let A advance PAST its getStreamInfo checkpoint and park on the pending
    // createSession — otherwise B's supersede would abort A at that checkpoint
    // before createSession is ever called.
    await new Promise((r) => setTimeout(r, 0))
    await prewarm({ fileId: 2, fileType: 'media', startSec: 0 })       // supersedes A mid-createSession
    resolveA({ session_id: 'sessA', master_playlist: '/a', start_sec: 0 }) // A resolves late
    await pA

    // A was superseded before it could be stored → it must be deleted, not leaked.
    expect(mockDeleteSession).toHaveBeenCalledWith('sessA')
    expect(takeWarmedSession(reqFor(2, 0))?.sessionId).toBe('sessB')
  })

  it('treats direct_play with no stream_url as a clean no-op', async () => {
    mockGetStreamInfo.mockResolvedValue({ stream: { decision: 'direct_play' } } as never)
    await prewarm({ fileId: 7, fileType: 'media', startSec: 0 })
    expect(fetch).not.toHaveBeenCalled()
    expect(mockCreateSession).not.toHaveBeenCalled()
  })

  it('warms direct_play via a ranged fetch and creates no session', async () => {
    mockGetStreamInfo.mockResolvedValue({
      stream: { decision: 'direct_play', stream_url: '/api/stream/7/direct' },
    } as never)

    await prewarm({ fileId: 7, fileType: 'media', startSec: 0 })

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('/api/stream/7/direct')
    expect((opts as { headers: Record<string, string> }).headers.Range).toMatch(/^bytes=0-/)
  })

  it('cancelPrewarm deletes an unconsumed warmed session', async () => {
    mockGetStreamInfo.mockResolvedValue({ stream: TRANSCODE } as never)
    mockCreateSession.mockResolvedValue({ session_id: 'sessX', master_playlist: '/x', start_sec: 0 } as never)

    await prewarm({ fileId: 5, fileType: 'media', startSec: 0 })
    cancelPrewarm()

    expect(mockDeleteSession).toHaveBeenCalledWith('sessX')
    expect(takeWarmedSession(reqFor(5, 0))).toBeNull()
  })

  it('is a no-op when disabled via the localStorage kill switch', async () => {
    localStorage.setItem('aurora.prewarm', 'off')
    expect(prewarmEnabled()).toBe(false)

    await prewarm({ fileId: 7, fileType: 'media', startSec: 0 })
    expect(mockGetStreamInfo).not.toHaveBeenCalled()
  })
})

describe('Phase 2: first-segment pre-encode', () => {
  const warmTranscode = (sessionId: string, profiles?: typeof PROFILES) => {
    mockGetStreamInfo.mockResolvedValue({ stream: TRANSCODE } as never)
    mockCreateSession.mockResolvedValue({
      session_id: sessionId,
      master_playlist: `/api/stream/hls/${sessionId}/master.m3u8`,
      start_sec: 0,
      profiles,
    } as never)
  }

  it('full mode pre-encodes the predicted tier (default 8 Mbps seed → 1080p)', async () => {
    warmTranscode('sx', PROFILES)
    await prewarm({ fileId: 3, fileType: 'media', startSec: 0 })
    // Exactly one variant-playlist fetch, targeting 1080p (7.5M ≤ 8M < 18M).
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetchCalls()[0][0]).toBe('/api/stream/hls/sx/1080p/stream.m3u8')
  })

  it('pre-encodes 2160p when the saved bandwidth seed is high', async () => {
    localStorage.setItem('aurora_bw_estimate', String(25_000_000))
    warmTranscode('sy', PROFILES)
    await prewarm({ fileId: 4, fileType: 'media', startSec: 0 })
    expect(fetchCalls()[0][0]).toBe('/api/stream/hls/sy/2160p/stream.m3u8')
  })

  it('light mode pre-creates the session but does NOT pre-encode', async () => {
    localStorage.setItem('aurora.prewarm', 'light')
    warmTranscode('sz', PROFILES)
    await prewarm({ fileId: 5, fileType: 'media', startSec: 0 })
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('skips pre-encode when the response carries no profiles', async () => {
    warmTranscode('sw', undefined)
    await prewarm({ fileId: 6, fileType: 'media', startSec: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('aborts the in-flight pre-encode when the warm is discarded', async () => {
    warmTranscode('sa', PROFILES)
    await prewarm({ fileId: 8, fileType: 'media', startSec: 0 })
    const signal = fetchCalls()[0][1].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    cancelPrewarm()
    expect(signal.aborted).toBe(true)
    expect(mockDeleteSession).toHaveBeenCalledWith('sa')
  })

  it('adopts the pre-encoded session and aborts the now-redundant encode GET', async () => {
    warmTranscode('sb', PROFILES)
    await prewarm({ fileId: 9, fileType: 'media', startSec: 0 })
    const signal = fetchCalls()[0][1].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    expect(takeWarmedSession(reqFor(9, 0))?.sessionId).toBe('sb')
    // The player will open its own variant fetch; our speculative GET is released.
    expect(signal.aborted).toBe(true)
  })

  it('caps the predicted tier to the player size (small window → 720p despite high bandwidth)', async () => {
    localStorage.setItem('aurora_bw_estimate', String(25_000_000))
    vi.stubGlobal('innerWidth', 1280)
    vi.stubGlobal('innerHeight', 720)
    vi.stubGlobal('devicePixelRatio', 1)
    warmTranscode('sc', PROFILES)
    await prewarm({ fileId: 10, fileType: 'media', startSec: 0 })
    expect(fetchCalls()[0][0]).toBe('/api/stream/hls/sc/720p/stream.m3u8')
  })

  it('predicts 2160p on a large HiDPI viewport even though screen/window height < 2160', async () => {
    // Regression for the height-only-cap bug: Retina laptop, big window, fast link.
    // hls.js caps by max(w,h)*dpr vs level WIDTH-or-height, so 2160p is allowed.
    localStorage.setItem('aurora_bw_estimate', String(30_000_000))
    vi.stubGlobal('innerWidth', 1440)
    vi.stubGlobal('innerHeight', 900)
    vi.stubGlobal('devicePixelRatio', 2)
    warmTranscode('sd', PROFILES)
    await prewarm({ fileId: 13, fileType: 'media', startSec: 0 })
    expect(fetchCalls()[0][0]).toBe('/api/stream/hls/sd/2160p/stream.m3u8')
  })

  it('returns no pre-encode for an empty profile ladder', async () => {
    warmTranscode('se', [])
    await prewarm({ fileId: 11, fileType: 'media', startSec: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('falls back to the lowest tier when bandwidth fits nothing', async () => {
    localStorage.setItem('aurora_bw_estimate', String(1_000_000)) // clamps to 1M, below 480p=2.2M
    warmTranscode('sf', PROFILES)
    await prewarm({ fileId: 12, fileType: 'media', startSec: 0 })
    expect(fetchCalls()[0][0]).toBe('/api/stream/hls/sf/480p/stream.m3u8')
  })
})
