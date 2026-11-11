import { beforeEach, describe, expect, it, vi } from 'vitest'

// The `aurora_prefs` blob: its guarded read, its one read-modify-write, and
// the device-level dials stored in it.
//
// The app once offered four typeface systems and three glow strengths, stored
// here as `font_choice` and `glow_intensity` and applied as `data-font` /
// `data-glow` on <html>. Both settings are gone. What these tests pin about
// them is that a blob written by such a build is harmless: nothing reads the
// two keys, nothing writes an attribute for them, and other writers carry
// them through untouched instead of crashing on or deleting them.
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

const appearance = await import('./appearance')
const {
  applyDensity,
  applyPreferredQuality,
  applyReduceEffects,
  currentDensity,
  currentPreferredQuality,
  currentReduceEffects,
  readPrefsSnapshot,
  reflectReduceEffects,
} = appearance

const prefs = () => JSON.parse(store.get('aurora_prefs') ?? '{}') as Record<string, unknown>

beforeEach(() => {
  store.clear()
  attrs.clear()
})

describe('a typeface or glow choice stored by an older build', () => {
  it('has no reader or writer left in the module', () => {
    const names = Object.keys(appearance)
    expect(names.filter(n => /font|glow/i.test(n))).toEqual([])
  })

  it('is ignored: no attribute is written for it, whatever it holds', () => {
    for (const blob of [
      { font_choice: 'nova', glow_intensity: 'heavy' },
      { font_choice: 'halo', glow_intensity: 'subtle' },
      { font_choice: 42, glow_intensity: { nested: true } },
      { font_choice: null, glow_intensity: [] },
    ]) {
      store.set('aurora_prefs', JSON.stringify(blob))
      attrs.clear()
      // Everything the startup path and Settings read on such a blob.
      expect(currentReduceEffects()).toBe(false)
      expect(currentDensity()).toBeNull()
      expect(currentPreferredQuality()).toBe('auto')
      reflectReduceEffects(currentReduceEffects())
      expect([...attrs.keys()]).toEqual([])
    }
  })

  it('round-trips through later writes instead of being dropped or rewritten', () => {
    store.set('aurora_prefs', JSON.stringify({ font_choice: 'nova', glow_intensity: 'heavy', player_volume: 0.4 }))
    applyReduceEffects(true)
    applyDensity('compact')
    expect(prefs()).toEqual({
      font_choice: 'nova',
      glow_intensity: 'heavy',
      player_volume: 0.4,
      reduce_effects: true,
      library_density: 'compact',
    })
    expect(attrs.has('data-font')).toBe(false)
    expect(attrs.has('data-glow')).toBe(false)
  })
})

describe('reduce effects', () => {
  it('is off, with no attribute, until chosen', () => {
    expect(currentReduceEffects()).toBe(false)
    reflectReduceEffects(currentReduceEffects())
    expect(attrs.has('data-effects')).toBe(false)
  })

  it('persists and writes data-effects="reduced", and clears both when turned off', () => {
    applyReduceEffects(true)
    expect(prefs().reduce_effects).toBe(true)
    expect(attrs.get('data-effects')).toBe('reduced')
    expect(currentReduceEffects()).toBe(true)
    applyReduceEffects(false)
    expect(prefs().reduce_effects).toBe(false)
    expect(attrs.has('data-effects')).toBe(false)
    expect(currentReduceEffects()).toBe(false)
  })

  it('reads anything but a stored true as off, including a corrupt blob', () => {
    for (const v of ['true', 1, 'reduced', null, {}]) {
      store.set('aurora_prefs', JSON.stringify({ reduce_effects: v }))
      expect(currentReduceEffects(), JSON.stringify(v)).toBe(false)
    }
    store.set('aurora_prefs', 'not json{')
    expect(currentReduceEffects()).toBe(false)
  })
})

describe('library density', () => {
  it('is null until chosen, so the library can pick by size', () => {
    expect(currentDensity()).toBeNull()
    store.set('aurora_prefs', JSON.stringify({ library_density: 'list' }))
    expect(currentDensity()).toBeNull()
  })

  it('round-trips both choices', () => {
    applyDensity('compact')
    expect(currentDensity()).toBe('compact')
    applyDensity('comfortable')
    expect(currentDensity()).toBe('comfortable')
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
    // All three share one read-modify-write helper; before, Settings wrote
    // quality with its own localStorage.setItem over a cached blob.
    applyReduceEffects(true)
    applyDensity('compact')
    applyPreferredQuality('4k')
    expect(prefs()).toMatchObject({ reduce_effects: true, library_density: 'compact', preferred_quality: '4k' })
    expect(currentReduceEffects()).toBe(true)
    expect(currentDensity()).toBe('compact')
  })

  it('preserves keys written by other components and adds nothing else', () => {
    // toEqual, not toMatchObject. The subject of this test is "does not corrupt
    // a blob with other writers", and toMatchObject is satisfied by a superset —
    // it let a mutation that wrote an extra junk key straight through. Exact
    // equality is the only assertion that actually pins the write surface.
    store.set('aurora_prefs', JSON.stringify({ volume: 0.42, muted: true, subtitleLang: 'fr' }))
    applyPreferredQuality('1080p')
    applyDensity('comfortable')
    expect(prefs()).toEqual({
      volume: 0.42,
      muted: true,
      subtitleLang: 'fr',
      preferred_quality: '1080p',
      library_density: 'comfortable',
    })
  })
})

// ── OAuth provider list (Aurora Stage Phase 7a) ─────────────────────────────
//
// The sign-in tiles derive from one list, replacing five hand-written render
// blocks plus a five-term `||` in the section guard. tsc proves each `flag` is a
// VALID key of SetupStatus (it is used as `setupStatus?.[p.flag]`), but nothing
// proved the list is COMPLETE — a sixth provider added server-side would simply
// never render a tile, silently, with no type error and no test failure.
describe('OAUTH_SIGN_IN_PROVIDERS', () => {
  it('covers every oauth_*_enabled flag the server exposes', async () => {
    const { OAUTH_SIGN_IN_PROVIDERS } = await import('./oauth')
    // Sourced from the SetupStatus type in lib/api.ts, which mirrors
    // auth_handlers.go's setup-status payload. If a provider is added there,
    // this list has to grow with it.
    const serverFlags = [
      'oauth_google_enabled',
      'oauth_discord_enabled',
      'oauth_twitch_enabled',
      'oauth_facebook_enabled',
      'oauth_twitter_enabled',
    ]
    expect([...OAUTH_SIGN_IN_PROVIDERS.map(p => p.flag)].sort()).toEqual([...serverFlags].sort())
  })

  it('has one entry per provider, with no duplicate keys or labels', async () => {
    const { OAUTH_SIGN_IN_PROVIDERS } = await import('./oauth')
    const providers = OAUTH_SIGN_IN_PROVIDERS.map(p => p.provider)
    expect(new Set(providers).size).toBe(providers.length)
    const labels = OAUTH_SIGN_IN_PROVIDERS.map(p => p.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const p of OAUTH_SIGN_IN_PROVIDERS) expect(p.label.length).toBeGreaterThan(0)
  })

  it('keeps `twitter` as the provider key even though the label is X', async () => {
    const { OAUTH_SIGN_IN_PROVIDERS } = await import('./oauth')
    // The key is the server's route segment (/api/auth/oauth/twitter/start).
    // Renaming it to match the rebrand would 404.
    const x = OAUTH_SIGN_IN_PROVIDERS.find(p => p.label === 'X')
    expect(x?.provider).toBe('twitter')
  })
})
