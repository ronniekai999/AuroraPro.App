import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// withToken → identity so the direct-play warm URL is easy to assert.
vi.mock('./api', () => ({ withToken: (u: string) => u }))

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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
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
