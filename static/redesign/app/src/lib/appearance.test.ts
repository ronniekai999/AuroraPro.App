import { beforeEach, describe, expect, it, vi } from 'vitest'

// Aurora Stage Phase 0 — guards the typeface DEFAULT FLIP (nova → eclipse).
//
// The flip is only safe because of one invariant: a user who explicitly picked
// Nova keeps Nova, because the choice is persisted to aurora_prefs.font_choice
// even when no data-font attribute is written. If someone later "simplifies"
// applyFont to skip the write for the default, or moves the fallback back to
// 'nova', every one of those users silently changes typeface. These tests fail
// loudly in that case.
//
// Runs in vitest's default `node` environment (no jsdom in devDependencies), so
// localStorage and document.documentElement are stubbed to the minimum surface
// appearance.ts actually touches.

const store = new Map<string, string>()
const attrs = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

vi.stubGlobal('document', {
  documentElement: {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  },
})

const { FONT_OPTIONS, applyFont, applyGlow, currentFont, currentGlow } = await import('./appearance')

const prefs = () => JSON.parse(store.get('aurora_prefs') ?? '{}') as Record<string, unknown>

beforeEach(() => {
  store.clear()
  attrs.clear()
})

describe('typeface default (Aurora Stage Phase 0)', () => {
  it('defaults to eclipse when nothing is stored', () => {
    expect(currentFont()).toBe('eclipse')
  })

  it('defaults to eclipse when the stored value is invalid or corrupt', () => {
    store.set('aurora_prefs', JSON.stringify({ font_choice: 'bricolage' }))
    expect(currentFont()).toBe('eclipse')

    store.set('aurora_prefs', '{not json')
    expect(currentFont()).toBe('eclipse')
  })

  it('leaves the DOM attribute-less for eclipse so :root tokens apply', () => {
    applyFont('eclipse')
    expect(attrs.has('data-font')).toBe(false)
  })

  it('persists eclipse even though it writes no attribute', () => {
    // The load-bearing assertion for the flip: "no attribute" must not mean
    // "no record of the choice".
    applyFont('eclipse')
    expect(prefs().font_choice).toBe('eclipse')
  })

  it.each(['nova', 'halo', 'current'] as const)('attributes non-default system %s', (id) => {
    applyFont(id)
    expect(attrs.get('data-font')).toBe(id)
    expect(prefs().font_choice).toBe(id)
  })

  it('keeps Nova for a user who explicitly chose it before the flip', () => {
    // Simulates pre-flip storage: Nova was the attribute-less default then, so
    // only the pref was written. That pref is the whole reason the flip is
    // non-destructive.
    store.set('aurora_prefs', JSON.stringify({ font_choice: 'nova' }))
    expect(currentFont()).toBe('nova')
  })

  it('offers exactly the four systems index.css defines, eclipse first', () => {
    expect(FONT_OPTIONS.map(o => o.id)).toEqual(['eclipse', 'nova', 'halo', 'current'])
    expect(FONT_OPTIONS[0].desc).toContain('default')
    // Only one option may claim to be the default.
    expect(FONT_OPTIONS.filter(o => o.desc.includes('default'))).toHaveLength(1)
  })

  it('does not clobber unrelated prefs', () => {
    store.set('aurora_prefs', JSON.stringify({ preferred_quality: '4k', autoplay: false }))
    applyFont('halo')
    expect(prefs()).toMatchObject({ preferred_quality: '4k', autoplay: false, font_choice: 'halo' })
  })
})

describe('glow default (unchanged by Phase 0)', () => {
  it('defaults to aurora and stays attribute-less', () => {
    expect(currentGlow()).toBe('aurora')
    applyGlow('aurora')
    expect(attrs.has('data-glow')).toBe(false)
    expect(prefs().glow_intensity).toBe('aurora')
  })

  it.each(['subtle', 'heavy'] as const)('attributes non-default glow %s', (id) => {
    applyGlow(id)
    expect(attrs.get('data-glow')).toBe(id)
  })
})
