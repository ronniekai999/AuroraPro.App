// Owner of the `aurora_prefs` localStorage blob: the one guarded read, the
// one read-modify-write, and the typed accessors for the device-level
// preferences stored in it (reduce effects, library density, playback
// quality and delivery).
//
// The app has one typeface system and one level of edge and shadow. Older
// builds stored `font_choice` and `glow_intensity` in the same blob. They are
// left where they are (other writers spread the whole blob back) and are
// ignored, with one exception: `glow_intensity: 'subtle'` was that build's
// lever for weak graphics hardware, and is read as reduced effects until the
// viewer makes an explicit choice (see currentReduceEffects).

export type DensityChoice = 'comfortable' | 'compact'

const PREFS_KEY = 'aurora_prefs'

/**
 * A guarded snapshot of the whole `aurora_prefs` blob.
 *
 * Exported because SettingsView needs the SAME guarded parse as its merge
 * base, and because it must read FRESH rather than from a cached ref.
 * `aurora_prefs` has more than one writer: VideoPlayer persists
 * volume/muted/autoplay into it during playback, and the accessors below
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

/**
 * Reads the full prefs object, sets one key, and writes it back — so a single
 * change never clobbers the other persisted prefs (autoplay, hdr, subtitle
 * langs, player_volume, …) the way a naive overwrite would.
 *
 * Exported (Aurora Stage Phase 7b) because `aurora_prefs` should have exactly
 * ONE read-modify-write implementation. Every caller that rolled its own was a
 * chance to clobber a concurrent writer, which is precisely the bug Phase 7a
 * found in SettingsView. Not appearance-specific despite living here; this
 * module is the blob's owner.
 *
 * The PR that exported it claimed the consolidation was complete apart from
 * VideoPlayer's volume writer. It wasn't — SettingsView's persist effect was a
 * third implementation. Both now route through here or through `writePrefs`
 * below, so the claim is true as of this pass.
 */
export function writePrefKey(key: string, value: string | number | boolean): void {
  writePrefs({ [key]: value })
}

/**
 * Merge several keys at once over a FRESH read. Same contract as
 * `writePrefKey` — which is now a one-key call into this — and the same reason
 * for existing: the read has to happen at write time, not at mount time, or a
 * concurrent writer's keys get reverted by the next save.
 */
export function writePrefs(patch: Record<string, unknown>): void {
  const prefs = { ...readPrefs(), ...patch }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* quota / denied — any live attribute still applied, just not persisted */
  }
}

// Internal alias, kept so the call sites below read as they did.
const writePref = writePrefKey

/**
 * Reduce effects: no backdrop blur behind chrome. Stored as a boolean and
 * applied as `<html data-effects="reduced">`, which index.css keys its
 * flat-fill rules on. Off (no attribute) by default.
 *
 * Carried over from older builds: their "Subtle" glow setting was the same
 * lever (it dropped the blur over playing video for weak graphics hardware),
 * so a blob that still holds `glow_intensity: 'subtle'` and no explicit
 * `reduce_effects` reads as ON. People who chose it for performance keep it.
 * An explicit `reduce_effects`, true or false, always wins, so turning it
 * off sticks; no other old value is read.
 */
export function currentReduceEffects(): boolean {
  const prefs = readPrefs()
  if (typeof prefs.reduce_effects === 'boolean') return prefs.reduce_effects
  return prefs.glow_intensity === 'subtle'
}

/** Set or clear the attribute for a stored value; shared with the pre-paint shim. */
export function reflectReduceEffects(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-effects', 'reduced')
  else document.documentElement.removeAttribute('data-effects')
}

/** Persist + live-apply Reduce effects. */
export function applyReduceEffects(on: boolean): void {
  writePref('reduce_effects', on)
  reflectReduceEffects(on)
}

/**
 * The stored library density ('comfortable' or 'compact'), or null when
 * nothing valid is stored.
 */
export function currentDensity(): DensityChoice | null {
  const v = readPrefs().library_density
  return v === 'comfortable' || v === 'compact' ? v : null
}

export function applyDensity(d: DensityChoice): void {
  writePref('library_density', d)
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

/**
 * Persist the playback-quality preference. No attribute to apply — the value is
 * read at play time by currentPreferredQuality() — but it goes through the same
 * read-modify-write as every other key so Settings does not need its own
 * localStorage call (and its own chance to clobber a concurrent writer).
 */
export function applyPreferredQuality(q: QualityChoice): void {
  writePref('preferred_quality', q)
}

// ---------------------------------------------------------------------------
// Playback delivery preferences (September 2026 playback pass). Both ride the
// same `aurora_prefs` bucket and are read at play time — by getStreamInfo and
// buildSessionRequest in lib/streaming.ts — so the details-page pre-warm and
// the player send byte-identical requests and the warmed session is adopted.
// ---------------------------------------------------------------------------

/**
 * Preferred spoken language for the audio track the server picks by default.
 * 'auto' = no preference (the file's default track, as before). Codes are
 * ISO 639-1; the server folds them onto the 639-2 tags ffprobe reports
 * (`en` matches "eng", `de` matches both "ger" and "deu", …). The in-player
 * track picker remains the per-title override.
 */
export type AudioLanguageChoice =
  | 'auto' | 'en' | 'ja' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'ru' | 'zh' | 'ko' | 'hi' | 'ar'

export const AUDIO_LANGUAGE_OPTIONS: readonly { id: AudioLanguageChoice; label: string }[] = [
  { id: 'auto', label: 'Auto (file default)' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: 'Japanese' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'it', label: 'Italian' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'ru', label: 'Russian' },
  { id: 'zh', label: 'Chinese' },
  { id: 'ko', label: 'Korean' },
  { id: 'hi', label: 'Hindi' },
  { id: 'ar', label: 'Arabic' },
]

/** The stored audio-language preference, 'auto' when unset/invalid. */
export function currentPreferredAudioLanguage(): AudioLanguageChoice {
  const v = readPrefs().preferred_audio_language
  return AUDIO_LANGUAGE_OPTIONS.some(o => o.id === v) ? (v as AudioLanguageChoice) : 'auto'
}

export function applyPreferredAudioLanguage(l: AudioLanguageChoice): void {
  writePref('preferred_audio_language', l)
}

/**
 * Streaming bitrate ceiling in bits per second, 0 = no limit.
 *
 * This is the remote-viewer knob every peer server has and Aurora lacked: a
 * source above the ceiling can neither direct-play nor remux (both deliver
 * the source bitrate verbatim, and a single-rendition stream has nothing to
 * adapt down to), so the server transcodes it onto an ABR ladder capped at
 * the ceiling. Below the ceiling nothing changes. Self-limiting by design —
 * the worst a wrong value does is give THIS browser a smaller ladder.
 */
export const MAX_STREAM_BITRATE_OPTIONS: readonly { bps: number; label: string }[] = [
  { bps: 0, label: 'No limit (LAN)' },
  { bps: 40_000_000, label: '40 Mbps' },
  { bps: 20_000_000, label: '20 Mbps' },
  { bps: 8_000_000, label: '8 Mbps' },
  { bps: 4_000_000, label: '4 Mbps' },
  { bps: 2_000_000, label: '2 Mbps' },
]

// Mirrors the server's clampMaxBPS: anything above a gigabit is a unit
// mix-up or garbage, and reads as "no limit" on both sides.
const MAX_STREAM_BPS_CEILING = 1_000_000_000

/** The stored bitrate ceiling in bps, 0 when unset/invalid/no limit. */
export function currentMaxStreamBps(): number {
  const v = readPrefs().max_stream_bps
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_STREAM_BPS_CEILING) return 0
  return Math.round(n)
}

export function applyMaxStreamBps(bps: number): void {
  const n = Number.isFinite(bps) && bps > 0 && bps <= MAX_STREAM_BPS_CEILING ? Math.round(bps) : 0
  writePref('max_stream_bps', n)
}
