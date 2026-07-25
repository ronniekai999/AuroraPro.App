// Shared appearance (typeface + glow) persistence + live-apply.
//
// This mirrors the canonical logic in Settings → Appearance (App.tsx): a choice
// is persisted to localStorage `aurora_prefs` and applied live by toggling a
// `data-font` / `data-glow` attribute on <html>, which the design tokens in
// index.css (and the pre-paint shim in main.tsx) read. The onboarding
// "Make it yours" step reuses these helpers so a choice made there persists and
// renders identically to one made in Settings.
//
// The two defaults — font 'eclipse' and glow 'aurora' — are intentionally
// ATTRIBUTE-LESS: they map to the unprefixed :root tokens, so we REMOVE the
// attribute rather than set it (keeps a clean DOM for users who never changed
// the setting, and matches main.tsx which only honors the non-default values).
//
// 2026-07-25 (Aurora Stage Phase 0) — the default font flipped 'nova' →
// 'eclipse' (Bricolage + Inter), so 'nova' became an attributed system. An
// explicit Nova choice SURVIVES the flip because the choice is persisted to
// aurora_prefs.font_choice whether or not an attribute was written, and
// currentFont() below only falls back to the default when nothing valid is
// stored. Three places encode the default and must agree: this file, the
// pre-paint shim in main.tsx, and the inline radiogroup in SettingsView.

export type FontChoice = 'nova' | 'current' | 'eclipse' | 'halo'
export type GlowChoice = 'subtle' | 'aurora' | 'heavy'

/**
 * Every typeface system EXCEPT the attribute-less default — i.e. exactly the
 * values that get written to `<html data-font>`.
 *
 * Exported so the pre-paint shim in main.tsx and the Settings radiogroup can
 * consume this list instead of re-typing it. Those two plus applyFont() below
 * are the three places that have to agree on which system is the default; a
 * literal in each is how they silently drift (and neither of the other two is
 * covered by appearance.test.ts, so the drift would be invisible).
 */
export const ATTRIBUTED_FONTS: readonly FontChoice[] = ['nova', 'current', 'halo']
/** The attribute-less default — the system the :root tokens in index.css hold. */
export const DEFAULT_FONT: FontChoice = 'eclipse'
/**
 * Every valid stored value, attributed or not. Distinct from ATTRIBUTED_FONTS
 * on purpose: that list answers "does this get written to `<html data-font>`",
 * this one answers "is this a value we recognise at all".
 *
 * currentFont() validates against THIS. It used to validate against
 * ATTRIBUTED_FONTS, which happened to produce the right answer only because
 * 'eclipse' is the sole attribute-less system — an explicitly-stored 'eclipse'
 * failed the check and then fell back to DEFAULT_FONT, which is 'eclipse'. Same
 * result, wrong reason, and it would have broken silently the moment a second
 * attribute-less system existed.
 */
export const FONT_CHOICES: readonly FontChoice[] = ['eclipse', 'nova', 'current', 'halo']

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
  { id: 'eclipse', label: 'Eclipse', desc: 'Editorial · default', font: "'Bricolage Grotesque', sans-serif" },
  { id: 'nova', label: 'Nova', desc: 'Futuristic', font: "'Sora', sans-serif" },
  { id: 'halo', label: 'Halo', desc: 'Polished', font: "'Outfit', sans-serif" },
  { id: 'current', label: 'Classic', desc: 'Original', font: "'Space Grotesk', sans-serif" },
]

export const GLOW_OPTIONS: readonly GlowOption[] = [
  { id: 'subtle', label: 'Subtle', desc: 'Faint white edge' },
  { id: 'aurora', label: 'Aurora', desc: 'White + purple' },
  { id: 'heavy', label: 'Heavy', desc: 'Bright bloom' },
]

const PREFS_KEY = 'aurora_prefs'

/**
 * A guarded snapshot of the whole `aurora_prefs` blob.
 *
 * Exported (Aurora Stage Phase 7a) because SettingsView needs the SAME guarded
 * parse as its merge base, and because it must read FRESH rather than from a
 * cached ref. `aurora_prefs` has more than one writer: VideoPlayer persists
 * volume/muted/autoplay into it during playback, and applyFont/applyGlow below
 * write it too. Any component that caches the blob at mount and later writes
 * `{...cached, ...mine}` silently reverts every key another writer touched in
 * between — which is what SettingsView was doing.
 *
 * Returns `{}` for missing, non-object, or corrupt values, so callers can
 * always spread it.
 */
export function readPrefsSnapshot(): Record<string, unknown> {
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

// Internal alias kept so the call sites below read as they did before.
const readPrefs = readPrefsSnapshot

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

/** The stored typeface choice, defaulting to 'eclipse' when unset/invalid. */
export function currentFont(): FontChoice {
  const v = readPrefs().font_choice
  return FONT_CHOICES.includes(v as FontChoice) ? (v as FontChoice) : DEFAULT_FONT
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

/** Persist + live-apply a typeface choice ('eclipse' is the attribute-less default). */
export function applyFont(id: FontChoice): void {
  // The write happens for EVERY choice, including the attribute-less
  // default. That is what makes "explicitly chose the default" recoverable
  // and distinguishable from "never chose" — the invariant the nova →
  // eclipse default flip rests on. Do not "optimize" it away.
  writePref('font_choice', id)
  if (id === DEFAULT_FONT) document.documentElement.removeAttribute('data-font')
  else document.documentElement.setAttribute('data-font', id)
}

/** Persist + live-apply a glow choice ('aurora' is the attribute-less default). */
export function applyGlow(id: GlowChoice): void {
  writePref('glow_intensity', id)
  if (id === 'aurora') document.documentElement.removeAttribute('data-glow')
  else document.documentElement.setAttribute('data-glow', id)
}

/**
 * Persist the playback-quality preference. No attribute to apply — the value is
 * read at play time by currentPreferredQuality() — but it goes through the same
 * read-modify-write as the appearance dials so Settings does not need its own
 * localStorage call (and its own chance to clobber a concurrent writer).
 */
export function applyPreferredQuality(q: QualityChoice): void {
  writePref('preferred_quality', q)
}
