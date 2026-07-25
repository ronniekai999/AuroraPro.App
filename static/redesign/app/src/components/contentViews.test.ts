// Aurora Stage Phase 6 — tests for the pure logic the content views grew.
//
// Two functions, both extracted specifically so they could be tested:
//   collectionStrips  — the three-branch image fallback for the stacked-poster
//                       collection card
//   groupDateParts    — the split-apart calendar date formatter, which exists
//                       because the list header renders "Today" as a pill and
//                       must not also render it as words
//
// Both are exercised for the cases that would ship a visible bug, not just the
// happy path: an empty collection, a server that predates poster_paths, a
// year boundary, and the today/tomorrow/weekday branch split.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { collectionStrips } from './CollectionsView'
import { groupDateParts } from './CalendarView'

// The suite runs under TZ=America/New_York (set in package.json's `test`
// script, NOT in vite.config.ts — putting a `test` block there requires
// defineConfig from `vitest/config`, which ships its own nested vite and makes
// the react plugin's types unassignable, so `tsc -b` fails).
//
// It has to be a non-UTC zone or the UTC-consistency assertions below are
// vacuous: this container and CI both run with TZ unset, i.e. UTC, where a
// local-time implementation and a UTC one are indistinguishable. Mutating
// todayUTC() to getFullYear/getMonth/getDate left the whole suite green before
// this was pinned.
if (new Date('2026-05-29T01:30:00Z').getDate() === 29) {
  throw new Error(
    'contentViews.test.ts must run in a non-UTC zone (TZ=America/New_York). ' +
    'Run it via `npm test`; the UTC-vs-local assertions cannot fail under UTC.',
  )
}

describe('collectionStrips', () => {
  it('prefers member posters and preserves their order', () => {
    const out = collectionStrips({ poster_paths: ['/a.jpg', '/b.jpg', '/c.jpg'] })
    expect(out).toHaveLength(3)
    expect(out[0]).toContain('/a.jpg')
    expect(out[1]).toContain('/b.jpg')
    expect(out[2]).toContain('/c.jpg')
  })

  it('requests w185, not a size derived from the array index', () => {
    // Regression guard for the `.map(posterURL)` bug tsc caught: map passes
    // (value, index), and posterURL's second parameter is `size`, so the
    // point-free version asked TMDB for sizes "0", "1", "2".
    const out = collectionStrips({ poster_paths: ['/a.jpg', '/b.jpg'] })
    for (const url of out) expect(url).toContain('w185')
    expect(out.join(' ')).not.toMatch(/\/w?[012]\//)
  })

  it('prefers poster_paths over cover_path when BOTH are present', () => {
    // Precedence is the entire point of the function, and it is the common
    // case in production: the server auto-populates cover_path on first add,
    // so almost every collection has both. Without this case, swapping the
    // two `if`s left the suite green.
    const out = collectionStrips({ poster_paths: ['/member.jpg'], cover_path: '/cover.jpg' })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('/member.jpg')
    expect(out[0]).not.toContain('/cover.jpg')
  })

  it('falls back to cover_path when the server sends no poster_paths', () => {
    // The rolling-deploy case: frontend shipped ahead of the backend field.
    const out = collectionStrips({ cover_path: '/cover.jpg' })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('/cover.jpg')
  })

  it('treats an empty poster_paths array as absent, not as zero strips', () => {
    // A collection whose members all lack poster art returns `[]` from the
    // query, which must not beat a usable cover_path.
    const out = collectionStrips({ poster_paths: [], cover_path: '/cover.jpg' })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('/cover.jpg')
  })

  it('returns nothing for a genuinely empty collection', () => {
    expect(collectionStrips({})).toEqual([])
    expect(collectionStrips({ poster_paths: [], cover_path: '' })).toEqual([])
  })

  it('never returns more strips than it was given', () => {
    // The card lays out 1..4 strips with flex-1; the LIMIT 4 lives in SQL, so
    // this asserts the client doesn't pad or truncate on its own.
    expect(collectionStrips({ poster_paths: ['/a.jpg'] })).toHaveLength(1)
    expect(collectionStrips({ poster_paths: ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'] })).toHaveLength(4)
  })
})

describe('groupDateParts', () => {
  // Fixed clock: the function compares against "today", so a real clock makes
  // every relative-label assertion time-dependent.
  const at = (iso: string) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(iso))
  }
  afterEach(() => { vi.useRealTimers() })

  it('flags today and sets relative to Today', () => {
    at('2026-05-28T15:00:00Z')
    const p = groupDateParts('2026-05-28')
    expect(p.isToday).toBe(true)
    expect(p.relative).toBe('Today')
  })

  it('labels tomorrow without flagging it as today', () => {
    at('2026-05-28T15:00:00Z')
    const p = groupDateParts('2026-05-29')
    expect(p.relative).toBe('Tomorrow')
    expect(p.isToday).toBe(false)
  })

  it('uses a weekday name beyond tomorrow', () => {
    at('2026-05-28T15:00:00Z')
    const p = groupDateParts('2026-05-30')
    expect(p.relative).not.toBe('Today')
    expect(p.relative).not.toBe('Tomorrow')
    expect(p.relative.length).toBeGreaterThan(2)
    expect(p.isToday).toBe(false)
  })

  it('keeps relative and monthDay separate so a pill cannot duplicate the word', () => {
    // The whole reason this function was split out of formatGroupDate: the
    // list header draws `relative` as a pill and must not get "Today · May 28"
    // back as one string, or it renders "Today Today · May 28".
    at('2026-05-28T15:00:00Z')
    const p = groupDateParts('2026-05-28')
    expect(p.monthDay).not.toContain('Today')
    expect(p.monthDay).not.toContain('·')
  })

  it('accepts a full timestamp as well as a bare date', () => {
    // Callers pass both: ep.air_date is a timestamp, the drill-down panel
    // builds `${selectedDay}T00:00:00Z`.
    at('2026-05-28T15:00:00Z')
    expect(groupDateParts('2026-05-28T00:00:00Z').isToday).toBe(true)
    expect(groupDateParts('2026-05-28').isToday).toBe(true)
  })

  it('includes the year only when it differs from the current year', () => {
    at('2026-05-28T15:00:00Z')
    expect(groupDateParts('2026-12-31').monthDay).not.toContain('2026')
    expect(groupDateParts('2027-01-03').monthDay).toContain('2027')
  })

  it('is computed in UTC, not in the local zone', () => {
    // Audit M3's invariant, and the reason vite.config.ts pins TZ to
    // America/New_York for the suite: at 01:30Z on May 29 it is still
    // 21:30 on May 28 in New York. "Today" must be the 29th (UTC).
    //
    // An earlier version of this test used 23:30Z and passed under any
    // implementation, because the runner's TZ is UTC where local and UTC
    // agree — a mutation to getFullYear/getMonth/getDate left it green.
    at('2026-05-29T01:30:00Z')
    expect(groupDateParts('2026-05-29').isToday).toBe(true)
    expect(groupDateParts('2026-05-28').isToday).toBe(false)
    expect(groupDateParts('2026-05-30').relative).toBe('Tomorrow')
  })

  it('ignores the time of day in the input, not just in the clock', () => {
    // Both call sites pass different shapes (a timestamp from ep.air_date, a
    // synthesised midnight from the drill-down panel); a date's grouping must
    // not depend on which.
    at('2026-05-28T12:00:00Z')
    const early = groupDateParts('2026-05-30T00:30:00Z')
    const late = groupDateParts('2026-05-30T23:30:00Z')
    expect(early).toEqual(late)
  })
})
