import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two delivery preferences (September 2026 playback pass) reach the server
// on two requests that MUST agree: `?max_bps`/`?audio_lang` on stream-info and
// `max_bps` in the session body. The details-page pre-warm and the player both
// build the session body through buildSessionRequest, and the warmed session is
// adopted only when the request keys match — so the omission and rounding rules
// here are what keep a pre-warm from being thrown away.

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
  apiFetchResponse: vi.fn(),
  withToken: (u: string) => u,
}))

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

const { buildSessionRequest, playbackPrefsQuery, sessionRequestKey } = await import('./streaming')
const {
  applyMaxStreamBps,
  applyPreferredAudioLanguage,
  currentMaxStreamBps,
  currentPreferredAudioLanguage,
} = await import('./appearance')
type StreamDecision = import('./streaming').StreamDecision

const TRANSCODE = { decision: 'transcode' } as StreamDecision
const prefs = () => JSON.parse(store.get('aurora_prefs') ?? '{}') as Record<string, unknown>

beforeEach(() => {
  store.clear()
})

describe('max_stream_bps preference', () => {
  it('defaults to 0 (no limit) and rejects invalid stored values', () => {
    expect(currentMaxStreamBps()).toBe(0)
    for (const bad of [-1, 0, NaN, 'abc', 1_000_000_001, null, {}]) {
      store.set('aurora_prefs', JSON.stringify({ max_stream_bps: bad }))
      expect(currentMaxStreamBps()).toBe(0)
    }
  })

  it('round-trips, accepts a numeric string, and rounds', () => {
    applyMaxStreamBps(8_000_000)
    expect(currentMaxStreamBps()).toBe(8_000_000)
    store.set('aurora_prefs', JSON.stringify({ max_stream_bps: '4000000' }))
    expect(currentMaxStreamBps()).toBe(4_000_000)
    store.set('aurora_prefs', JSON.stringify({ max_stream_bps: 2_000_000.6 }))
    expect(currentMaxStreamBps()).toBe(2_000_001)
    applyMaxStreamBps(0)
    expect(currentMaxStreamBps()).toBe(0)
  })

  it('preserves the other keys in the prefs blob', () => {
    store.set('aurora_prefs', JSON.stringify({ volume: 0.42, preferred_quality: '4k' }))
    applyMaxStreamBps(20_000_000)
    expect(prefs()).toEqual({ volume: 0.42, preferred_quality: '4k', max_stream_bps: 20_000_000 })
  })
})

describe('preferred_audio_language preference', () => {
  it('defaults to auto and rejects unknown codes', () => {
    expect(currentPreferredAudioLanguage()).toBe('auto')
    store.set('aurora_prefs', JSON.stringify({ preferred_audio_language: 'tlh' }))
    expect(currentPreferredAudioLanguage()).toBe('auto')
    store.set('aurora_prefs', JSON.stringify({ preferred_audio_language: 42 }))
    expect(currentPreferredAudioLanguage()).toBe('auto')
  })

  it('round-trips a supported code', () => {
    applyPreferredAudioLanguage('ja')
    expect(currentPreferredAudioLanguage()).toBe('ja')
    expect(prefs()).toEqual({ preferred_audio_language: 'ja' })
    applyPreferredAudioLanguage('auto')
    expect(currentPreferredAudioLanguage()).toBe('auto')
  })
})

describe('playbackPrefsQuery', () => {
  it('is empty at the no-preference values so older servers see the old request', () => {
    expect(playbackPrefsQuery()).toBe('')
    applyMaxStreamBps(0)
    applyPreferredAudioLanguage('auto')
    expect(playbackPrefsQuery()).toBe('')
  })

  it('carries each preference only when set, in bits per second', () => {
    applyMaxStreamBps(8_000_000)
    expect(playbackPrefsQuery()).toBe('&max_bps=8000000')
    applyPreferredAudioLanguage('ja')
    expect(playbackPrefsQuery()).toBe('&max_bps=8000000&audio_lang=ja')
    applyMaxStreamBps(0)
    expect(playbackPrefsQuery()).toBe('&audio_lang=ja')
  })

  it('reads fresh on every call (a Settings change applies to the next play)', () => {
    expect(playbackPrefsQuery()).toBe('')
    store.set('aurora_prefs', JSON.stringify({ max_stream_bps: 4_000_000 }))
    expect(playbackPrefsQuery()).toBe('&max_bps=4000000')
  })
})

describe('buildSessionRequest max_bps', () => {
  const base = { fileId: 7, fileType: 'media' as const, startSec: 0 }

  it('omits max_bps at 0/undefined/negative so absent and no-limit hash identically', () => {
    const absent = buildSessionRequest(TRANSCODE, base)
    const zero = buildSessionRequest(TRANSCODE, { ...base, maxBps: 0 })
    const negative = buildSessionRequest(TRANSCODE, { ...base, maxBps: -5 })
    expect(absent.max_bps).toBeUndefined()
    expect(zero.max_bps).toBeUndefined()
    expect(negative.max_bps).toBeUndefined()
    expect(sessionRequestKey(absent)).toBe(sessionRequestKey(zero))
    expect(sessionRequestKey(absent)).toBe(sessionRequestKey(negative))
  })

  it('carries a rounded positive ceiling and changes the request key', () => {
    const capped = buildSessionRequest(TRANSCODE, { ...base, maxBps: 8_000_000.4 })
    expect(capped.max_bps).toBe(8_000_000)
    expect(sessionRequestKey(capped)).not.toBe(sessionRequestKey(buildSessionRequest(TRANSCODE, base)))
    // Same ceiling from the pre-warm and the player → same key.
    expect(sessionRequestKey(buildSessionRequest(TRANSCODE, { ...base, maxBps: 8_000_000 })))
      .toBe(sessionRequestKey(capped))
  })
})
