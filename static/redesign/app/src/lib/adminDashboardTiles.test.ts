// The admin dashboard showed "8,177 / 8,177 Skip Markers" beside "846
// Media File Entries" and looked like a 10x counting bug. It wasn't: the
// skip figure counts video files (episode_files + movie media_files),
// the 846 counts title rows (media_items of type movie/show, episodes
// excluded). These pin the arithmetic and the wording that now says so.

import { describe, expect, it } from 'vitest'
import { formatSkipMarkers, skipCoverage, skipMarkerTotals } from './adminDashboardTiles'
import type { SkipMarkerTotals } from './adminDashboardTiles'
import type { SkipMarkerStatus } from './api'

const status = (over: Partial<SkipMarkerStatus> = {}): SkipMarkerStatus =>
  ({ enabled: true, ...over }) as SkipMarkerStatus

describe('skipCoverage', () => {
  it('sums episode and movie files across both sides', () => {
    // The live library that prompted this: 7,405 episode files +
    // 772 movie files = 8,177, all analyzed.
    const c = skipCoverage(status({
      episode_files_total: 7405, episode_files_analyzed: 7405,
      movie_files_total: 772, movie_files_analyzed: 772,
    }))
    expect(c).toEqual({ analyzed: 8177, total: 8177, behind: false, empty: false })
  })

  it('is behind while files are outstanding', () => {
    expect(skipCoverage(status({
      episode_files_total: 100, episode_files_analyzed: 40,
      movie_files_total: 10, movie_files_analyzed: 10,
    })).behind).toBe(true)
  })

  it('is behind while the worker sweeps, even at full coverage', () => {
    expect(skipCoverage(status({
      episode_files_total: 10, episode_files_analyzed: 10,
      worker: { running: true } as SkipMarkerStatus['worker'],
    })).behind).toBe(true)
  })

  it('treats missing fields as zero so an old binary cannot NaN the tile', () => {
    expect(skipCoverage(status())).toEqual({ analyzed: 0, total: 0, behind: false, empty: true })
  })

  it('marks an empty library empty rather than fully covered', () => {
    // 0 / 0 is not an accomplishment — a fresh install has nothing to be
    // complete about, and the tile must not tint it the same green as a
    // finished sweep.
    const c = skipCoverage(status({ episode_files_total: 0, movie_files_total: 0 }))
    expect(c.empty).toBe(true)
    expect(c.behind).toBe(false)
    expect(skipCoverage(status({ episode_files_total: 10, episode_files_analyzed: 10 })).empty).toBe(false)
  })
})

describe('skipMarkerTotals', () => {
  it('totals the three kinds, with manual a subset and suppressed outside', () => {
    // The server counts manual with the same visibility filter as the
    // kinds, so it is CONTAINED in total; suppressions (zero-length manual
    // rows, migration 043) are not markers and are outside it entirely.
    expect(skipMarkerTotals(status({
      intro_markers: 6210, recap_markers: 1003, credits_markers: 4830,
      manual_markers: 12, suppressed_markers: 4,
    }))).toEqual({ intro: 6210, recap: 1003, credits: 4830, manual: 12, suppressed: 4, total: 12043 })
  })
})

describe('formatSkipMarkers', () => {
  const t = (over: Partial<SkipMarkerTotals> = {}): SkipMarkerTotals =>
    ({ intro: 0, recap: 0, credits: 0, manual: 0, suppressed: 0, total: 0, ...over })

  it('leads with the total and breaks down by kind', () => {
    // Grouping separators come from toLocaleString, so the expected string is
    // built the same way rather than hardcoded: under LC_ALL=de_DE this read
    // '12.043' and the case failed on a correct implementation.
    const n = (v: number) => v.toLocaleString()
    expect(formatSkipMarkers(t({
      intro: 6210, recap: 1003, credits: 4830, manual: 12, total: 12043,
    }))).toBe(`${n(12043)} markers · ${n(6210)} intro · ${n(1003)} recap · ${n(4830)} credits · ${n(12)} hand-edited`)
  })

  it('drops zero kinds so a movies-only library reads cleanly', () => {
    expect(formatSkipMarkers(t({ credits: 340, total: 340 }))).toBe('340 markers · 340 credits')
  })

  it('reports suppressions even when no marker was ever detected', () => {
    // Regression, HIGH: the guard tested `total === 0` alone, and manual
    // rows are excluded from total — so an operator who had suppressed
    // false positives on a library with no positive-length markers saw
    // their edits vanish from the only surface that reports them.
    expect(formatSkipMarkers(t({ suppressed: 5 }))).toBe('5 suppressed')
  })

  it('appends suppressions after the breakdown they are not part of', () => {
    expect(formatSkipMarkers(t({ credits: 10, manual: 2, suppressed: 3, total: 10 })))
      .toBe('10 markers · 10 credits · 2 hand-edited · 3 suppressed')
  })

  it('returns empty only when there is genuinely nothing to say', () => {
    expect(formatSkipMarkers(t())).toBe('')
  })

  it('singularizes one marker', () => {
    expect(formatSkipMarkers(t({ intro: 1, total: 1 }))).toBe('1 marker · 1 intro')
  })
})
