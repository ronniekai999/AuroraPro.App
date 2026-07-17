// Shared appearance (typeface + glow + grain) persistence + live-apply.
//
// This mirrors the canonical logic in Settings → Appearance (App.tsx): a choice
// is persisted to localStorage `aurora_prefs` and applied live by toggling a
// `data-font` / `data-glow` / `data-grain` attribute on <html>, which the
// design tokens in index.css (and the pre-paint call in main.tsx) read. The
// onboarding "Make it yours" step reuses these helpers so a choice made there
// persists and renders identically to one made in Settings.
//
// The defaults — font 'nova', glow 'aurora', grain 'off' — are intentionally
// ATTRIBUTE-LESS: they map to the unprefixed :root tokens, so we REMOVE the
// attribute rather than set it (keeps a clean DOM for users who never changed
// the setting, and matches applyStoredAppearance which only honors the
// non-default values).

export type FontChoice = 'nova' | 'current' | 'eclipse' | 'halo' | 'velvet'
export type GlowChoice = 'subtle' | 'aurora' | 'heavy'
// 2026-07-16 (Aurea Phase A) — film-grain overlay. Two states only: the
// attribute-less default 'off' and 'film' (html[data-grain="film"] paints the
// fixed noise layer in index.css). Not a free-form scale — the CSS force-off
// under data-glow="subtle" / prefers-reduced-motion is the only other lever.
export type GrainChoice = 'off' | 'film'

export interface FontOption {
  id: FontChoice
  label: string
  desc: string
  /** A representative display font stack for live previewing this typeface. */
  font: string
  /** Preview in italic — VELVET's editorial serif is italic-only by design. */
  italic?: boolean
}
export interface GlowOption {
  id: GlowChoice
  label: string
  desc: string
}

// Order + copy intentionally match Settings → Appearance.
// 2026-07-16 (Aurea Phase A) — VELVET: NOVA's body/display faces plus a
// Fraunces serif-italic for the hero title + rail headings (the
// html[data-font="velvet"] overrides in index.css). Opt-in per the
// aurea-cinema-elements plan (decision 1) — 'nova' stays the default.
export const FONT_OPTIONS: readonly FontOption[] = [
  { id: 'nova', label: 'Nova', desc: 'Futuristic · default', font: "'Sora', sans-serif" },
  { id: 'eclipse', label: 'Eclipse', desc: 'Editorial', font: "'Bricolage Grotesque', sans-serif" },
  { id: 'halo', label: 'Halo', desc: 'Polished', font: "'Outfit', sans-serif" },
  { id: 'current', label: 'Classic', desc: 'Original', font: "'Space Grotesk', sans-serif" },
  { id: 'velvet', label: 'Velvet', desc: 'Cinema serif headlines', font: "'Fraunces', 'Iowan Old Style', 'Palatino', Georgia, serif", italic: true },
]

export const GLOW_OPTIONS: readonly GlowOption[] = [
  { id: 'subtle', label: 'Subtle', desc: 'Faint white edge' },
  { id: 'aurora', label: 'Aurora', desc: 'White + purple' },
  { id: 'heavy', label: 'Heavy', desc: 'Bright bloom' },
]

// ── Pure validators ─────────────────────────────────────────────────
// Single source of truth for "is this stored value a real choice?" —
// shared by the getters below AND applyStoredAppearance (main.tsx's
// pre-paint call), so adding a new option is one edit here instead of a
// scavenger hunt across duplicated allowlists. Pure (no DOM/storage) so
// they're unit-testable in a node environment.

/** Coerce an unknown stored value to a FontChoice, defaulting to 'nova'. */
export function normalizeFont(v: unknown): FontChoice {
  return v === 'current' || v === 'eclipse' || v === 'halo' || v === 'velvet' ? v : 'nova'
}

/** Coerce an unknown stored value to a GlowChoice, defaulting to 'aurora'. */
export function normalizeGlow(v: unknown): GlowChoice {
  return v === 'subtle' || v === 'heavy' ? v : 'aurora'
}

/** Coerce an unknown stored value to a GrainChoice, defaulting to 'off'. */
export function normalizeGrain(v: unknown): GrainChoice {
  return v === 'film' ? v : 'off'
}

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
  return normalizeFont(readPrefs().font_choice)
}

/** The stored glow choice, defaulting to 'aurora' when unset/invalid. */
export function currentGlow(): GlowChoice {
  return normalizeGlow(readPrefs().glow_intensity)
}

/** The stored film-grain choice, defaulting to 'off' when unset/invalid. */
export function currentGrain(): GrainChoice {
  return normalizeGrain(readPrefs().grain_overlay)
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

/** Persist + live-apply the film-grain overlay ('off' is the attribute-less default). */
export function applyGrain(id: GrainChoice): void {
  writePref('grain_overlay', id)
  if (id === 'off') document.documentElement.removeAttribute('data-grain')
  else document.documentElement.setAttribute('data-grain', id)
}

/**
 * Apply every stored appearance choice to <html> in one shot — called by
 * main.tsx BEFORE first paint so panels, type, and grain render correctly on
 * the very first frame (no flash of the defaults). Defaults REMOVE their
 * attribute rather than skip it (review 2026-07-17): pre-paint the removal
 * is a no-op, but it makes the function honestly idempotent for any future
 * caller re-syncing after a prefs reset or a cross-tab storage event —
 * set-only would leave a stale data-font="velvet" / data-grain="film" on
 * <html> while storage says defaults. Storage/JSON failures fall through to
 * the defaults, same as the old inline shims this replaces.
 */
export function applyStoredAppearance(): void {
  const prefs = readPrefs()
  const el = document.documentElement
  const font = normalizeFont(prefs.font_choice)
  if (font === 'nova') el.removeAttribute('data-font')
  else el.setAttribute('data-font', font)
  const glow = normalizeGlow(prefs.glow_intensity)
  if (glow === 'aurora') el.removeAttribute('data-glow')
  else el.setAttribute('data-glow', glow)
  const grain = normalizeGrain(prefs.grain_overlay)
  if (grain === 'off') el.removeAttribute('data-grain')
  else el.setAttribute('data-grain', grain)
}
