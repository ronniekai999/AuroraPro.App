// The admin dashboard showed "8,177 / 8,177 Skip Markers" beside "846
// Media File Entries" and looked like a 10x counting bug. It wasn't: the
// skip figure counts video files (episode_files + movie media_files),
// the 846 counts title rows (media_items of type movie/show, episodes
// excluded). These pin the arithmetic and the wording that now says so.

import { describe, expect, it } from 'vitest'
import { formatSkipMarkers, skipCoverage, skipMarkerTotals } from './adminDashboardTiles'
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
    expect(c).toEqual({ analyzed: 8177, total: 8177, behind: false })
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
    expect(skipCoverage(status())).toEqual({ analyzed: 0, total: 0, behind: false })
  })
})

describe('skipMarkerTotals', () => {
  it('totals the three kinds and keeps manual separate', () => {
    // manual is counted by detector, not kind — it overlaps the kinds
    // rather than adding to them, so total must exclude it.
    expect(skipMarkerTotals(status({
      intro_markers: 6210, recap_markers: 1003, credits_markers: 4830, manual_markers: 12,
    }))).toEqual({ intro: 6210, recap: 1003, credits: 4830, manual: 12, total: 12043 })
  })
})

describe('formatSkipMarkers', () => {
  it('leads with the total and breaks down by kind', () => {
    expect(formatSkipMarkers({ intro: 6210, recap: 1003, credits: 4830, manual: 12, total: 12043 }))
      .toBe('12,043 markers · 6,210 intro · 1,003 recap · 4,830 credits · 12 manual')
  })

  it('drops zero kinds so a movies-only library reads cleanly', () => {
    expect(formatSkipMarkers({ intro: 0, recap: 0, credits: 340, manual: 0, total: 340 }))
      .toBe('340 markers · 340 credits')
  })

  it('returns empty when nothing was detected, so no sub-line renders', () => {
    expect(formatSkipMarkers({ intro: 0, recap: 0, credits: 0, manual: 0, total: 0 })).toBe('')
  })

  it('singularizes one marker', () => {
    expect(formatSkipMarkers({ intro: 1, recap: 0, credits: 0, manual: 0, total: 1 }))
      .toBe('1 marker · 1 intro')
  })
})
