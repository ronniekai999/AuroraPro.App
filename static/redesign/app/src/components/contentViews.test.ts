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

// The suite runs under TZ=America/New_York, pinned in vitest.config.ts — see
// that file for why a non-UTC zone is required and why the pin lives in config
// rather than in the npm script.
//
// This guard is a belt-and-braces check that the pin actually took effect. It
// is a module-scope throw, which is a blunt instrument: vitest reports it as a
// COLLECTION error, so these tests count as absent rather than failed and the
// summary line reads "55 passed" — green-looking, with the non-zero exit code
// as the only real signal. That is acceptable as a backstop precisely because
// the config pin means it should never fire; if it ever does, something removed
// the pin and every UTC assertion below has quietly stopped meaning anything.
if (new Date('2026-05-29T01:30:00Z').getDate() === 29) {
  throw new Error(
    'contentViews.test.ts must run in a non-UTC zone. vitest.config.ts pins ' +
    'TZ=America/New_York; something has bypassed it. The UTC-vs-local ' +
    'assertions in this file cannot fail under UTC, so they would pass ' +
    'vacuously rather than protect anything.',
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

  it('falls back to cover_path as a BACKDROP, not a poster', () => {
    // The rolling-deploy case: frontend shipped ahead of the backend field.
    //
    // The size assertion is the point. cover_path fills a full-width 118px
    // band, so it needs the wide `original` backdrop URL — swapping
    // backdropURL for posterURL(…, 'w185') stretches a 2:3 portrait across it,
    // and a test that only checked the path contained '/cover.jpg' passed
    // happily through that mutation.
    const out = collectionStrips({ cover_path: '/cover.jpg' })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('/cover.jpg')
    expect(out[0]).toContain('original')
    expect(out[0]).not.toContain('w185')
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

  it('neither pads nor truncates the list it is given', () => {
    // The card lays out 1..4 strips with flex-1; the LIMIT 4 lives in SQL, so
    // the client must not second-guess the count.
    expect(collectionStrips({ poster_paths: ['/a.jpg'] })).toHaveLength(1)
    expect(collectionStrips({ poster_paths: ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'] })).toHaveLength(4)
    // Five is the case that actually proves "no truncation" — the earlier
    // version of this test only checked 1→1 and 4→4, so a client-side
    // `.slice(0, 4)` would have satisfied a test whose name forbade it.
    expect(collectionStrips({ poster_paths: ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg', '/e.jpg'] })).toHaveLength(5)
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

  // EXACT-VALUE assertions, and the reason they replaced the negative ones.
  //
  // The first pass asserted `relative.length > 2` and `monthDay` "does not
  // contain 'Today'". Both are satisfied by wrong output: 'Wednesday' passes a
  // test meant to pin 'Saturday', and `monthDay === ''` passes a not-contain
  // check. A mutation review found five survivors behind exactly that gap —
  // dropping `timeZone: 'UTC'` from either formatter (which renders every date
  // a day early for anyone west of UTC), dropping `day: 'numeric'` (which drops
  // the day of month entirely), and switching `month` short→long. Pinning the
  // whole object at a fixed clock kills all five at once, because there is
  // nowhere left for a wrong value to hide.
  //
  // These literals assume the en-US default the suite's TZ pin implies. If the
  // runner's locale ever changes, THIS is the test that should fail loudly
  // rather than the behaviour silently drifting.
  it('returns exact parts for a weekday beyond tomorrow', () => {
    at('2026-05-28T15:00:00Z')
    expect(groupDateParts('2026-05-30')).toEqual({
      relative: 'Saturday',
      monthDay: 'May 30',
      isToday: false,
    })
  })

  it('returns exact parts for today and for tomorrow', () => {
    at('2026-05-28T15:00:00Z')
    expect(groupDateParts('2026-05-28')).toEqual({
      relative: 'Today',
      monthDay: 'May 28',
      isToday: true,
    })
    expect(groupDateParts('2026-05-29')).toEqual({
      relative: 'Tomorrow',
      monthDay: 'May 29',
      isToday: false,
    })
  })

  it('keeps relative and monthDay separate so a pill cannot duplicate the word', () => {
    // The whole reason this function was split out of formatGroupDate: the
    // list header draws `relative` as a pill and must not get "Today · May 28"
    // back as one string, or it renders "Today Today · May 28".
    at('2026-05-28T15:00:00Z')
    const p = groupDateParts('2026-05-28')
    expect(p.monthDay).toBe('May 28')
    expect(p.monthDay).not.toContain('Today')
    expect(p.monthDay).not.toContain('·')
  })

  it('renders a past date without claiming it is today', () => {
    // Unreachable through the API today (the calendar handler clamps `from` to
    // midnight-UTC-today), but goPrev() lets a user navigate to arbitrary past
    // months, so the function had zero coverage for the whole backward half of
    // its domain. Guards `diffDays === 0` against being relaxed to `<= 0`,
    // which would render every past day as "Today".
    at('2026-05-28T15:00:00Z')
    expect(groupDateParts('2026-05-20')).toEqual({
      relative: 'Wednesday',
      monthDay: 'May 20',
      isToday: false,
    })
    expect(groupDateParts('2026-05-27').isToday).toBe(false)
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
    // Exact, not substring: `"Jan 2027"` (a formatter that lost `day`) passes a
    // `.toContain('2027')` check while having dropped the date.
    expect(groupDateParts('2026-12-31').monthDay).toBe('Dec 31')
    expect(groupDateParts('2027-01-03').monthDay).toBe('Jan 3, 2027')
    // A PAST year must also be disambiguated — `!==` here, not `>`.
    expect(groupDateParts('2025-12-31').monthDay).toBe('Dec 31, 2025')
  })

  it('is computed in UTC, not in the local zone', () => {
    // Audit M3's invariant, and the reason the suite is pinned to
    // America/New_York: at 01:30Z on May 29 it is still
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
    //
    // The offset here is deliberate. An earlier version compared two timestamps
    // TWO DAYS out and asserted only `toEqual(early, late)` — a purely
    // relational check with no expected value, which pinned nothing and, worse,
    // picked the one offset where the bug it was written for is invisible: at
    // +2 days the internal diffDays differs (2 vs 3) but `relative` is read
    // from the weekday, which is the same either way, so the mutation was
    // masked. On the clock's OWN date the two straddle the Today/Tomorrow
    // boundary, which is where dropping the midnight normalisation actually
    // shows up. Both are pinned to exact values.
    at('2026-05-28T12:00:00Z')
    const early = groupDateParts('2026-05-28T00:30:00Z')
    const late = groupDateParts('2026-05-28T23:30:00Z')
    expect(early).toEqual({ relative: 'Today', monthDay: 'May 28', isToday: true })
    expect(early).toEqual(late)
  })
})
