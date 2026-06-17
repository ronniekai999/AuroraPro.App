// Small date/format helpers shared across views. Extracted from App.tsx
// (2026-06-17 app split) so view modules can import them without reaching
// back into App. formatRequestDate is pure; the resume helpers (added
// Phase 2.4) type against ContinueWatchingItem from @/lib/api — no cycle
// (api doesn't import this module).

import { type ContinueWatchingItem } from '@/lib/api'

export function formatRequestDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!t) return ''
  const diff = Date.now() - t
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(iso).toLocaleDateString()
}

const RESUME_THRESHOLD_MS = 5000

// isResumable — true when a Continue Watching record represents
// meaningful playback worth offering Resume for. All call sites that
// gate Resume UI (Hero label, card pill, detail view CTA) should use
// this helper rather than open-coding the threshold check.
export function isResumable(c: ContinueWatchingItem | undefined | null): c is ContinueWatchingItem {
  return !!c && c.position_ms >= RESUME_THRESHOLD_MS
}

// formatResumeTime: takes a position in ms and returns a colon-separated
// MM:SS for sub-hour resumes or H:MM:SS for longer ones. Zero-pads
// minutes/seconds so the string stays a fixed width per duration class
// (4:07 not 4:7, 1:02:03 not 1:2:3).
export function formatResumeTime(positionMs: number): string {
  const totalSec = Math.max(0, Math.floor(positionMs / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
// formatResumeAriaLabel: spelled-out form of formatResumeTime for
// screen readers. The colon-separated visible label ("Resume at 4:07")
// is read as "four colon zero seven" or "four-oh-seven" depending on
// engine — neither is great. The aria-label uses words.
export function formatResumeAriaLabel(c: ContinueWatchingItem): string {
  const totalSec = Math.max(0, Math.floor(c.position_ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`)
  if (m > 0) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  if (s > 0 || parts.length === 0) parts.push(`${s} second${s === 1 ? '' : 's'}`)
  const time = parts.join(' ')
  // Use `!== undefined` (not truthy) so episode 0 / season 0 (pilots,
  // specials) still get the show prefix. season_number could be 0 in
  // some libraries; same for episode_number.
  if (c.type === 'show' && c.season_number !== undefined && c.episode_number !== undefined) {
    return `Resume Season ${c.season_number} Episode ${c.episode_number} at ${time}`
  }
  return `Resume from ${time}`
}
// formatResumeLabel: builds the human-readable visible label. Movies
// get "Resume at MM:SS"; shows get "Resume S2E5 · MM:SS" so the user
// sees which episode the click will resume.
//
// Why `!== undefined` instead of truthy: episode_number === 0 (a
// "special" / pilot) is a real value in some libraries; the previous
// truthy check rejected it and silently fell back to the movie-style
// "Resume at MM:SS" label, losing the show context. Same for
// season_number on shows that number from 0.
export function formatResumeLabel(c: ContinueWatchingItem): string {
  const time = formatResumeTime(c.position_ms)
  if (c.type === 'show' && c.season_number !== undefined && c.episode_number !== undefined) {
    return `Resume S${c.season_number}E${c.episode_number} · ${time}`
  }
  return `Resume at ${time}`
}
