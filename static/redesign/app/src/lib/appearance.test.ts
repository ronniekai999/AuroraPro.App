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

const {
  ATTRIBUTED_FONTS,
  DEFAULT_FONT,
  FONT_CHOICES,
  FONT_OPTIONS,
  GLOW_OPTIONS,
  applyFont,
  applyGlow,
  applyPreferredQuality,
  currentFont,
  currentGlow,
  currentPreferredQuality,
  readPrefsSnapshot,
} = await import('./appearance')

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
    // Seed a STALE attribute first. Asserting `!attrs.has(...)` from a clean
    // slate was vacuous — it passed even with the removeAttribute() call
    // deleted (proved by mutation in the Phase 2 debug review). Removal is
    // the whole job of that branch: a user sitting on data-font="nova" who
    // picks Eclipse must switch immediately, not on next reload.
    attrs.set('data-font', 'nova')
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

  // The default is encoded in THREE places: applyFont/currentFont here, the
  // pre-paint shim in main.tsx, and SettingsView's radiogroup. Only this file
  // was under test, so flipping the shim's allowlist back to 'eclipse' would
  // have re-broken every explicit-Nova user on first paint with a green
  // suite. All three now consume ATTRIBUTED_FONTS, so pinning it here pins
  // them.
  it('exports an allowlist that is exactly the non-default systems', () => {
    expect([...ATTRIBUTED_FONTS].sort()).toEqual(['current', 'halo', 'nova'])
    expect(ATTRIBUTED_FONTS).not.toContain(DEFAULT_FONT)
    // Every system is either the default or attributed — no orphans.
    expect([...ATTRIBUTED_FONTS, DEFAULT_FONT].sort()).toEqual(
      FONT_OPTIONS.map(o => o.id).sort(),
    )
  })

  it('agrees with FONT_OPTIONS about which system is the default', () => {
    const flagged = FONT_OPTIONS.filter(o => o.desc.includes('default'))
    expect(flagged.map(o => o.id)).toEqual([DEFAULT_FONT])
  })

  it('round-trips every system through applyFont → currentFont', () => {
    for (const id of [...ATTRIBUTED_FONTS, DEFAULT_FONT]) {
      applyFont(id)
      expect(currentFont(), `round-trip ${id}`).toBe(id)
    }
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

// ── Aurora Stage Phase 7a — the Settings consolidation ──────────────────────
//
// SettingsView used to carry its own copy of the option lists, its own default
// fallback, and its own remove-attribute-when-default branch. It now imports
// all of it from here, which makes this file the ONLY encoding of that logic
// outside main.tsx's pre-paint shim. These tests cover the parts the
// consolidation newly depends on.

describe('FONT_CHOICES vs ATTRIBUTED_FONTS', () => {
  it('has exactly ONE attribute-less system, which is what makes currentFont safe', () => {
    // Read this one carefully, because the obvious test for it is vacuous.
    //
    // currentFont() used to validate against ATTRIBUTED_FONTS, which excludes
    // 'eclipse'. A stored 'eclipse' therefore failed validation and fell back
    // to DEFAULT_FONT — which IS 'eclipse'. Right answer, wrong reason. And
    // because it is the right answer, no assertion on currentFont()'s OUTPUT
    // can tell the two implementations apart: I wrote
    // `store font_choice='eclipse'; expect(currentFont()).toBe('eclipse')` and
    // a mutation reverting the validation left it green.
    //
    // The difference only becomes observable once a SECOND attribute-less
    // system exists, at which point the old code would resolve it to 'eclipse'
    // instead of itself. So the honest test is the structural precondition
    // rather than the behaviour: the set difference between all systems and the
    // attributed ones must be exactly the default. Add a second attribute-less
    // system and this fails, pointing at currentFont's validation.
    const attributeLess = FONT_CHOICES.filter(f => !ATTRIBUTED_FONTS.includes(f))
    expect(attributeLess).toEqual([DEFAULT_FONT])
  })

  it('resolves an explicitly-stored default to itself', () => {
    // Weak by necessity (see above) but not worthless: it pins that storing the
    // default is a valid, recognised state rather than one that gets discarded.
    store.set('aurora_prefs', JSON.stringify({ font_choice: 'eclipse' }))
    expect(currentFont()).toBe('eclipse')
    expect(attrs.get('data-font')).toBeUndefined()
  })

  it('covers every option the Settings radiogroup renders', () => {
    // The radiogroup maps FONT_OPTIONS and compares each id against
    // currentFont(). If FONT_CHOICES missed an id, that chip could never show
    // as checked — the "every chip unselected" bug the old inline comment
    // described, reintroduced from the other direction.
    for (const opt of FONT_OPTIONS) expect(FONT_CHOICES).toContain(opt.id)
    expect(FONT_CHOICES).toHaveLength(FONT_OPTIONS.length)
  })

  it('still rejects values that are not systems at all', () => {
    store.set('aurora_prefs', JSON.stringify({ font_choice: 'comic-sans' }))
    expect(currentFont()).toBe(DEFAULT_FONT)
  })
})

describe('GLOW_OPTIONS backs the Settings radiogroup', () => {
  it('offers exactly the three systems, with aurora as the attribute-less one', () => {
    expect(GLOW_OPTIONS.map(o => o.id)).toEqual(['subtle', 'aurora', 'heavy'])
    applyGlow('aurora')
    expect(attrs.get('data-glow')).toBeUndefined()
  })

  it('round-trips every option through applyGlow -> currentGlow', () => {
    for (const opt of GLOW_OPTIONS) {
      applyGlow(opt.id)
      expect(currentGlow()).toBe(opt.id)
    }
  })
})

describe('readPrefsSnapshot', () => {
  it('returns a spreadable object for every bad input', () => {
    // SettingsView spreads this as its merge base on every write, so a throw
    // or a non-object here would either crash the persist effect or produce
    // `{...null}` and silently drop every unrelated key.
    expect(readPrefsSnapshot()).toEqual({})
    store.set('aurora_prefs', 'not json{')
    expect(readPrefsSnapshot()).toEqual({})
    store.set('aurora_prefs', 'null')
    expect(readPrefsSnapshot()).toEqual({})
    store.set('aurora_prefs', '"a string"')
    expect(readPrefsSnapshot()).toEqual({})
    store.set('aurora_prefs', '42')
    expect(readPrefsSnapshot()).toEqual({})
  })

  it('reads FRESH, so a concurrent writer is never lost', () => {
    // The clobber this replaced: SettingsView cached the blob at mount and
    // merged over the cache, so a volume written by VideoPlayer mid-session
    // was reverted by Settings' next write. A snapshot taken at write time
    // cannot do that.
    store.set('aurora_prefs', JSON.stringify({ autoplay: true }))
    const before = readPrefsSnapshot()
    expect(before.volume).toBeUndefined()
    // Another writer lands.
    store.set('aurora_prefs', JSON.stringify({ autoplay: true, volume: 0.3 }))
    expect(readPrefsSnapshot().volume).toBe(0.3)
  })
})

describe('applyPreferredQuality', () => {
  it('round-trips and defaults to auto', () => {
    expect(currentPreferredQuality()).toBe('auto')
    applyPreferredQuality('4k')
    expect(currentPreferredQuality()).toBe('4k')
    applyPreferredQuality('1080p')
    expect(currentPreferredQuality()).toBe('1080p')
    applyPreferredQuality('auto')
    expect(currentPreferredQuality()).toBe('auto')
  })

  it('does not clobber the appearance dials', () => {
    // All three now share one read-modify-write helper; before, Settings wrote
    // quality with its own localStorage.setItem over a cached blob.
    applyFont('nova')
    applyGlow('heavy')
    applyPreferredQuality('4k')
    expect(prefs()).toMatchObject({ font_choice: 'nova', glow_intensity: 'heavy', preferred_quality: '4k' })
    expect(currentFont()).toBe('nova')
    expect(currentGlow()).toBe('heavy')
  })

  it('preserves keys written by other components', () => {
    store.set('aurora_prefs', JSON.stringify({ volume: 0.42, muted: true, subtitleLang: 'fr' }))
    applyPreferredQuality('1080p')
    applyFont('halo')
    expect(prefs()).toMatchObject({ volume: 0.42, muted: true, subtitleLang: 'fr', preferred_quality: '1080p', font_choice: 'halo' })
  })
})
