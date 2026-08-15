// Derivations behind the admin dashboard's stat tiles.
//
// These live outside AdminView because the tiles read as one row of
// comparable numbers while their denominators are nothing alike: the
// skip-marker tile counts VIDEO FILES (episode_files + movie
// media_files), the media tile counts TITLE ROWS (media_items of type
// movie or show, episodes excluded entirely). On a library with 74
// shows that is 8,177 next to 846 — a 10x gap that looks like a bug and
// is not one. The labels each function feeds are the fix; keeping the
// arithmetic here means it is unit-testable rather than buried in a
// 2,700-line component.

import type { SkipMarkerStatus } from './api'

export type SkipCoverage = {
  analyzed: number
  total: number
  /** Worker still owes files, or is mid-sweep — drives the amber tint. */
  behind: boolean
  /** No files to analyze at all. Distinct from "fully covered": a fresh
   *  install has nothing to be complete ABOUT, and a confident green
   *  0 / 0 claims otherwise. */
  empty: boolean
}

/**
 * Files the current detector has analyzed, over files that exist.
 *
 * This is COVERAGE, not marker count: a file the detector scanned and
 * found nothing in still lands in `analyzed`. Fields are optional
 * because a bundle can run ahead of the binary that serves them.
 */
export function skipCoverage(s: SkipMarkerStatus): SkipCoverage {
  const analyzed = (s.episode_files_analyzed ?? 0) + (s.movie_files_analyzed ?? 0)
  const total = (s.episode_files_total ?? 0) + (s.movie_files_total ?? 0)
  return {
    analyzed,
    total,
    behind: analyzed < total || !!s.worker?.running,
    empty: total === 0,
  }
}

export type SkipMarkerTotals = {
  intro: number
  recap: number
  credits: number
  /** Admin-authored markers — a SUBSET of the three above, sharing their
   *  visibility filter, so it is contained in `total` rather than adding
   *  to it. The server counts it that way on purpose: counting every
   *  manual row instead folded in suppressions, which are not markers,
   *  and printed a "manual" figure disjoint from the total beside it. */
  manual: number
  /** Zero-length manual rows — migration 043's "admin suppressed this
   *  marker". A hidden window, not a skippable one, so it is disjoint
   *  from every other count here and never folded into `total`. */
  suppressed: number
  /** intro + recap + credits. `manual` is inside this; `suppressed` is not. */
  total: number
}

export function skipMarkerTotals(s: SkipMarkerStatus): SkipMarkerTotals {
  const intro = s.intro_markers ?? 0
  const recap = s.recap_markers ?? 0
  const credits = s.credits_markers ?? 0
  return {
    intro,
    recap,
    credits,
    manual: s.manual_markers ?? 0,
    suppressed: s.suppressed_markers ?? 0,
    total: intro + recap + credits,
  }
}

/**
 * One-line marker breakdown for under the coverage figure, e.g.
 * "12,043 markers · 6,210 intro · 1,003 recap · 4,830 credits · 12 manual".
 *
 * The leading total partitions into intro/recap/credits; `manual` is a
 * subset of those and `suppressed` is outside them entirely, so both are
 * phrased to read as annotations rather than further addends.
 *
 * Zero-count kinds are dropped so a movies-only library doesn't advertise
 * "0 intro · 0 recap". Returns '' only when there is genuinely nothing to
 * say — callers render no sub-line rather than an empty one.
 */
export function formatSkipMarkers(t: SkipMarkerTotals): string {
  // Guard on suppressed too, not just total: suppressions exist without a
  // single positive-length marker (an operator hiding false positives on a
  // library the detector found nothing else in), and this is the only
  // surface that reports them. Testing total alone silently dropped them.
  if (t.total === 0 && t.suppressed === 0) return ''
  const n = (v: number) => v.toLocaleString()
  const parts: string[] = []
  if (t.total > 0) {
    parts.push(`${n(t.total)} marker${t.total === 1 ? '' : 's'}`)
    if (t.intro > 0) parts.push(`${n(t.intro)} intro`)
    if (t.recap > 0) parts.push(`${n(t.recap)} recap`)
    if (t.credits > 0) parts.push(`${n(t.credits)} credits`)
    if (t.manual > 0) parts.push(`${n(t.manual)} hand-edited`)
  }
  if (t.suppressed > 0) parts.push(`${n(t.suppressed)} suppressed`)
  return parts.join(' · ')
}
