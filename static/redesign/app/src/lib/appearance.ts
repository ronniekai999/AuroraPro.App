// Shared appearance (typeface + glow) persistence + live-apply.
//
// This mirrors the canonical logic in Settings → Appearance (App.tsx): a choice
// is persisted to localStorage `aurora_prefs` and applied live by toggling a
// `data-font` / `data-glow` attribute on <html>, which the design tokens in
// index.css (and the pre-paint shim in main.tsx) read. The onboarding
// "Make it yours" step reuses these helpers so a choice made there persists and
// renders identically to one made in Settings.
//
// The two defaults — font 'nova' and glow 'aurora' — are intentionally
// ATTRIBUTE-LESS: they map to the unprefixed :root tokens, so we REMOVE the
// attribute rather than set it (keeps a clean DOM for users who never changed
// the setting, and matches main.tsx which only honors the non-default values).

export type FontChoice = 'nova' | 'current' | 'eclipse' | 'halo'
export type GlowChoice = 'subtle' | 'aurora' | 'heavy'

export interface FontOption {
  id: FontChoice
  label: string
  desc: string
  /** A representative display font stack for live previewing this typeface. */
  font: string
}
export interface GlowOption {
  id: GlowChoice
  label: string
  desc: string
}

// Order + copy intentionally match Settings → Appearance.
export const FONT_OPTIONS: readonly FontOption[] = [
  { id: 'nova', label: 'Nova', desc: 'Futuristic · default', font: "'Sora', sans-serif" },
  { id: 'eclipse', label: 'Eclipse', desc: 'Editorial', font: "'Bricolage Grotesque', sans-serif" },
  { id: 'halo', label: 'Halo', desc: 'Polished', font: "'Outfit', sans-serif" },
  { id: 'current', label: 'Classic', desc: 'Original', font: "'Space Grotesk', sans-serif" },
]

export const GLOW_OPTIONS: readonly GlowOption[] = [
  { id: 'subtle', label: 'Subtle', desc: 'Faint white edge' },
  { id: 'aurora', label: 'Aurora', desc: 'White + purple' },
  { id: 'heavy', label: 'Heavy', desc: 'Bright bloom' },
]

const PREFS_KEY = 'aurora_prefs'

function readPrefs(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    }
  } catch {
    /* corrupt prefs → start from {} (the bad blob gets overwritten on next write) */
  }
  return {}
}

// writePref reads the full prefs object, sets one key, and writes it back — so a
// single appearance change never clobbers the other persisted prefs (autoplay,
// hdr, subtitle langs, …) the way a naive overwrite would.
function writePref(key: string, value: string): void {
  const prefs = readPrefs()
  prefs[key] = value
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* quota / denied — the live attribute still applied below, just not persisted */
  }
}

/** The stored typeface choice, defaulting to 'nova' when unset/invalid. */
export function currentFont(): FontChoice {
  const v = readPrefs().font_choice
  return v === 'current' || v === 'eclipse' || v === 'halo' ? v : 'nova'
}

/** The stored glow choice, defaulting to 'aurora' when unset/invalid. */
export function currentGlow(): GlowChoice {
  const v = readPrefs().glow_intensity
  return v === 'subtle' || v === 'heavy' ? v : 'aurora'
}

export type QualityChoice = 'auto' | '1080p' | '4k'

/**
 * The stored playback-quality preference, defaulting to 'auto' (1080p-preferred)
 * when unset/invalid. Reads the same `aurora_prefs` bucket Settings writes to —
 * the single source of truth for the `preferQuality` used by the play handlers
 * and the details-page pre-warm.
 */
export function currentPreferredQuality(): QualityChoice {
  const v = readPrefs().preferred_quality
  return v === '4k' || v === '1080p' ? v : 'auto'
}

/** Persist + live-apply a typeface choice ('nova' is the attribute-less default). */
export function applyFont(id: FontChoice): void {
  writePref('font_choice', id)
  if (id === 'nova') document.documentElement.removeAttribute('data-font')
  else document.documentElement.setAttribute('data-font', id)
}

/** Persist + live-apply a glow choice ('aurora' is the attribute-less default). */
export function applyGlow(id: GlowChoice): void {
  writePref('glow_intensity', id)
  if (id === 'aurora') document.documentElement.removeAttribute('data-glow')
  else document.documentElement.setAttribute('data-glow', id)
}
