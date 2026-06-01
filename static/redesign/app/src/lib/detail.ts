// Aurora V2 — DetailView pure helpers
//
// 2026-05-31 — Extracted alongside the "editorial split-view" DetailView
// redesign. These are small, total, side-effect-free functions: they take
// plain structural inputs and return plain data, so they're trivially
// correct and decoupled from App.tsx / the api.ts wire types (callers pass
// compatible shapes). Keeping the derivation logic here — not inline in the
// 8k-line App.tsx — is what makes the new detail components thin.

// Minimum scrubbed position before we treat playback as "resumable" rather
// than "not started". Mirrors RESUME_THRESHOLD_MS in App.tsx (a <5s scrub is
// noise, not progress). Defined here so the detail components can reuse it
// without importing App.tsx (imports are one-directional: components/lib
// never reach back into App).
export const RESUME_THRESHOLD_MS = 5000

/* ───────────────────────── quality chips ───────────────────────── */

// Map ffprobe color_transfer → an HDR chip label, or undefined for SDR.
//   smpte2084     → PQ (HDR10 / Dolby Vision base layer)
//   arib-std-b67  → HLG
//   bt709 / ''    → SDR (no chip)
export function formatHdr(colorTransfer?: string): 'HDR10' | 'HLG' | undefined {
  switch ((colorTransfer || '').toLowerCase()) {
    case 'smpte2084':
      return 'HDR10'
    case 'arib-std-b67':
      return 'HLG'
    default:
      return undefined
  }
}

const AUDIO_CODEC_NAMES: Record<string, string> = {
  eac3: 'E-AC3',
  ac3: 'AC3',
  truehd: 'TrueHD',
  dts: 'DTS',
  aac: 'AAC',
  flac: 'FLAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  mp3: 'MP3',
  mp2: 'MP2',
}

function channelLayout(channels?: number): string {
  switch (channels) {
    case 8:
      return '7.1'
    case 7:
      return '6.1'
    case 6:
      return '5.1'
    case 3:
      return '2.1'
    case 2:
      return '2.0'
    case 1:
      return 'Mono'
    default:
      return channels && channels > 0 ? `${channels}ch` : ''
  }
}

// Build an honest audio descriptor from codec + channel count, e.g.
// "TrueHD 7.1", "E-AC3 5.1", "DTS 5.1", "AAC 2.0". We have NO Atmos /
// Dolby Vision flag in the data model, so we never claim those.
export function formatAudioChip(codec?: string, channels?: number): string | undefined {
  if (!codec) return undefined
  const c = codec.toLowerCase()
  const name = AUDIO_CODEC_NAMES[c] ?? (c.startsWith('pcm') ? 'PCM' : codec.toUpperCase())
  const layout = channelLayout(channels)
  return layout ? `${name} ${layout}` : name
}

interface ResolutionLike {
  resolution?: string
  version_tag?: string
}

// Normalize a file's resolution/version into a display label. Handles both
// the ffprobe "1920x1080" WxH form and free-text tags ("4K", "2160p", "UHD").
export function resolutionLabel(file: ResolutionLike): string | undefined {
  const tag = (file.version_tag || '').toLowerCase()
  const res = (file.resolution || '').toLowerCase()
  const hay = `${tag} ${res}`
  if (/4320|\b8k\b/.test(hay)) return '4320p'
  if (/2160|\buhd\b|\b4k\b/.test(hay)) return '2160p'
  // ffprobe stores resolution as raw "WIDTHxHEIGHT". Anamorphic/scope
  // content (2.39:1) has a height below its quality tier (a 1080p scope
  // encode is 1920x800), so classify on width-OR-height to match the
  // backend's ClassifyVersion (internal/library/scanner.go) — height-only
  // would mislabel most movies a tier low.
  const m = res.match(/(\d{3,4})\s*x\s*(\d{3,4})/)
  if (m) {
    const w = parseInt(m[1], 10)
    const h = parseInt(m[2], 10)
    if (w >= 3840 || h >= 2160) return '2160p'
    if (w >= 2560 || h >= 1440) return '1440p'
    if (w >= 1920 || h >= 1080) return '1080p'
    if (w >= 1280 || h >= 720) return '720p'
    if (w >= 640 || h >= 480) return '480p'
    return `${h}p`
  }
  if (/1440/.test(hay)) return '1440p'
  if (/1080/.test(hay)) return '1080p'
  if (/720/.test(hay)) return '720p'
  if (/480/.test(hay)) return '480p'
  return file.version_tag || file.resolution || undefined
}

/* ──────────────────────── episode versions ──────────────────────── */

// One selectable file version for the episode-row "Play in 4K / 1080p"
// chips. Mirrors EpisodeVersion in components/detail/EpisodeRow but is
// defined here too so this lib stays free of component imports.
export interface EpisodeVersionVM {
  fileId: number
  label: string // "2160p", "1080p", …
  is4k: boolean
}

interface VersionFileLike extends ResolutionLike {
  id: number
}

// Build the version chips for an episode from its files. Returns
// undefined unless there are 2+ files with DISTINCT resolution labels —
// the common single-file episode renders no chips, and two files at the
// same tier (e.g. two 1080p rips) collapse to one chip pointing at the
// first. Order is preserved from the input, which the server already
// sorts 4K-first (queries_phase2 ORDER BY version_tag), so the 4K chip
// leads. This is what fixes "a show with a 1080p AND a 2160p only shows
// the 2160p" — both now appear and each plays its own file.
export function episodeVersions(files?: VersionFileLike[]): EpisodeVersionVM[] | undefined {
  if (!files || files.length < 2) return undefined
  const seen = new Set<string>()
  const out: EpisodeVersionVM[] = []
  for (const f of files) {
    const res = resolutionLabel(f) || f.version_tag || f.resolution || 'Unknown'
    const is4k = /2160|4320|\b4k\b|\buhd\b/i.test(res)
    // Dedupe by the resolution tier, then DISPLAY the 4K tier as "4K"
    // (not "2160p") to match the movie "Play in" chooser, which shows
    // the raw version_tag (usually literally "4K"). Keeps the two
    // surfaces consistent for the user.
    if (seen.has(res)) continue
    seen.add(res)
    out.push({ fileId: f.id, label: is4k ? '4K' : res, is4k })
  }
  return out.length > 1 ? out : undefined
}

// Distinct resolution-tier labels present in `files` OTHER than the tier
// of `primary`, for the descriptive quality strip's "also in 1080p" chips.
// Order is preserved from the input (server sorts files highest-first), so
// the result reads 2160p → 1080p → 720p. Dedupes by tier and excludes the
// primary so the strip never shows the same resolution twice. Returns []
// when the title has only one resolution tier (the common case) so the
// caller appends nothing. Labels use the same resolutionLabel() form as
// the primary res chip ("2160p", not "4K") so the two sit consistently —
// unlike the version chooser, which shows "4K" because it's actionable.
export function secondaryResolutionLabels(
  files: VersionFileLike[] | undefined,
  primary: ResolutionLike | undefined,
): string[] {
  if (!files || files.length < 2) return []
  const primaryTier = primary ? resolutionLabel(primary) : undefined
  const seen = new Set<string>()
  if (primaryTier) seen.add(primaryTier)
  const out: string[] = []
  for (const f of files) {
    const res = resolutionLabel(f)
    if (!res || seen.has(res)) continue
    seen.add(res)
    out.push(res)
  }
  return out
}

// Pull a release-source token out of version_tag ("BluRay", "WEB-DL",
// "Remux", …) so the primary chip can read "1080p BluRay" like the mockup.
// Returns undefined when the tag has no recognizable source.
export function sourceLabel(versionTag?: string): string | undefined {
  if (!versionTag) return undefined
  const m = versionTag.match(/\b(blu-?ray|bd-?rip|br-?rip|web-?dl|web-?rip|remux|hdtv|dvd-?rip|dvd|hd-?rip)\b/i)
  if (!m) return undefined
  const s = m[1].toLowerCase().replace(/-/g, '')
  if (s === 'bluray' || s === 'bdrip' || s === 'brrip') return 'BluRay'
  if (s === 'webdl') return 'WEB-DL'
  if (s === 'webrip') return 'WEBRip'
  if (s === 'remux') return 'Remux'
  if (s === 'hdtv') return 'HDTV'
  if (s === 'hdrip') return 'HDRip'
  if (s === 'dvd' || s === 'dvdrip') return 'DVD'
  return m[1]
}

export type QualityChipKind = 'res' | 'hdr' | 'audio' | 'subs'
export interface QualityChip {
  label: string
  kind: QualityChipKind
  primary?: boolean // first/highlight chip → purple style
}

interface QualityFileLike extends ResolutionLike {
  color_transfer?: string
  audio_codec?: string
  audio_tracks?: { codec: string; channels?: number; is_default?: boolean }[]
  subtitle_tracks?: unknown[]
}

// Build the descriptive quality-chip strip from a single file's metadata
// plus an aggregate subtitle count. Order: resolution (primary/purple),
// any OTHER available resolutions (e.g. a 1080p alongside the 2160p), HDR,
// audio, subtitle count. Returns [] when there's nothing to show so the
// caller can hide the strip entirely.
//
// `otherResolutions` lets the caller surface that the title also exists in
// lower tiers — passed pre-computed (via secondaryResolutionLabels) since
// only the caller has the full file pool (movie media_files / show
// episode_files); deriveQualityChips itself describes one file.
export function deriveQualityChips(
  file: QualityFileLike | undefined,
  subtitleCount = 0,
  otherResolutions: string[] = [],
): QualityChip[] {
  if (!file) return []
  const chips: QualityChip[] = []

  const res = resolutionLabel(file)
  if (res) {
    const src = sourceLabel(file.version_tag)
    // `src !== res` guards the edge where version_tag is a bare source word
    // and resolutionLabel fell back to it (avoids "BluRay BluRay").
    chips.push({ label: src && src !== res ? `${res} ${src}` : res, kind: 'res', primary: true })
    // Secondary resolution chips (non-primary styling) — "also in 1080p".
    for (const other of otherResolutions) {
      chips.push({ label: other, kind: 'res' })
    }
  }

  const hdr = formatHdr(file.color_transfer)
  if (hdr) chips.push({ label: hdr, kind: 'hdr' })

  // Prefer the default audio track; fall back to first, then file.audio_codec.
  const track = file.audio_tracks?.find((t) => t.is_default) ?? file.audio_tracks?.[0]
  const audio = track
    ? formatAudioChip(track.codec, track.channels)
    : formatAudioChip(file.audio_codec)
  if (audio) chips.push({ label: audio, kind: 'audio' })

  const subs = subtitleCount || file.subtitle_tracks?.length || 0
  if (subs > 0) chips.push({ label: `${subs} Subtitle${subs === 1 ? '' : 's'}`, kind: 'subs' })

  return chips
}

/* ──────────────────────── episode watch state ──────────────────────── */

export interface EpProgress {
  position_ms?: number
  duration_ms?: number
  completed?: boolean
}

export type EpisodeWatchState = 'watched' | 'in-progress' | 'unwatched'

// Choose the episode-row render state from its per-episode progress record.
// A <5s scrub counts as "not started" (mirrors the resume threshold).
export function episodeWatchState(p?: EpProgress | null): EpisodeWatchState {
  if (!p) return 'unwatched'
  if (p.completed) return 'watched'
  if ((p.position_ms ?? 0) >= RESUME_THRESHOLD_MS && (p.duration_ms ?? 0) > 0) {
    return 'in-progress'
  }
  return 'unwatched'
}

// 0–100 for the in-progress bar. Returns 0 when duration is unknown.
export function episodeProgressPct(p?: EpProgress | null): number {
  if (!p || !p.duration_ms || p.duration_ms <= 0) return 0
  return Math.min(100, Math.max(0, Math.round(((p.position_ms ?? 0) / p.duration_ms) * 100)))
}

/* ──────────────────────────── dates ──────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Format a TMDB ISO date ("YYYY-MM-DD") as "Jul 16, 1993" WITHOUT going
// through Date() (avoids the UTC-parse / local-render off-by-one-day shift).
// Falls back to the year, then the raw string.
export function formatReleaseDate(iso?: string): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return /^\d{4}/.test(iso) ? iso.slice(0, 4) : iso
  const mo = parseInt(m[2], 10)
  if (mo < 1 || mo > 12) return m[1]
  return `${MONTHS[mo - 1]} ${parseInt(m[3], 10)}, ${m[1]}`
}
