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
import { maturityLeanLabel, MATURITY_OPTIONS, MATURITY_AUTO } from '@/lib/maturity'
import { nextRadioIndex } from '@/lib/radiogroup'
import { shouldShowProfileGate } from '@/lib/profileGate'

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

// ── Aurora Stage Phase 7a ────────────────────────────────────────────────────

describe('maturityLeanLabel', () => {
  // These tests replace a set that asserted an INVENTED domain. The first
  // version read maturity_pref as an AGE and checked boundaries at 0/7/8/13/
  // 14/16/17/21 — none of which the column can hold. It is
  // `CHECK (maturity_pref BETWEEN -1 AND 2)`, so the only reachable values are
  // -1/0/1/2, and the old mapping returned "Kids-safe" for every one of them
  // while its other three labels were unreachable. A profile set to Mature
  // displayed as Kids-safe, and the tests passed — they were exercising a
  // fiction, and mutation-testing the fiction proved nothing.
  //
  // Lesson encoded below: iterate the DOMAIN, don't pick boundaries.

  it('covers the whole domain the database permits, and nothing else', () => {
    expect(MATURITY_OPTIONS.map(o => o.v)).toEqual([-1, 0, 1, 2])
  })

  it('labels each explicit lean with the same word the Settings dial uses', () => {
    // Settings → Content Tone WRITES this field; the switcher only reports it.
    // If these drifted, one surface would call a value Teen and the other
    // something else — which is exactly what happened.
    expect(maturityLeanLabel(0)).toBe('Family lean')
    expect(maturityLeanLabel(1)).toBe('Teen lean')
    expect(maturityLeanLabel(2)).toBe('Mature lean')
  })

  it('says nothing for Auto rather than reporting a lean nobody picked', () => {
    // -1 is Auto: the recommender infers the lean server-side. Naming a tier
    // here would attribute a preference the user never expressed.
    expect(maturityLeanLabel(MATURITY_AUTO)).toBeNull()
    expect(maturityLeanLabel(-1)).toBeNull()
    expect(maturityLeanLabel(undefined)).toBeNull()
  })

  it('says nothing for values outside the CHECK constraint', () => {
    // Tampered or migrated-badly data must not fall through to a label.
    for (const v of [-2, 3, 7, 13, 16, 99, 0.5, NaN]) {
      expect(maturityLeanLabel(v)).toBeNull()
    }
  })

  it('never describes the lean as a restriction', () => {
    // The field is a SOFT recall bias; the hard ceiling is max_age_rating.
    // "Kids-safe" / "safe" / "only" would all misreport what the dial does —
    // and "Kids-safe" is precisely what the broken version rendered.
    for (const o of MATURITY_OPTIONS) {
      const l = maturityLeanLabel(o.v)
      if (l === null) continue
      expect(l.toLowerCase()).not.toContain('safe')
      expect(l.toLowerCase()).not.toContain('only')
      expect(l).toContain('lean')
    }
  })

  it('never returns an empty string, which would render as a blank line', () => {
    for (const v of [undefined, -1, 0, 1, 2, 99]) {
      const l = maturityLeanLabel(v)
      expect(l === null || l.length > 0).toBe(true)
    }
  })
})

describe('nextRadioIndex', () => {
  // The APG radiogroup movement arithmetic, extracted so it is testable at all.
  // Four radiogroups in Settings share it; four hand-written copies would have
  // been four chances to get a wrap wrong, and none of them was testable inside
  // a component (the project has no jsdom).

  it('moves forward on both Right and Down, wrapping at the end', () => {
    expect(nextRadioIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextRadioIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextRadioIndex('ArrowRight', 2, 3)).toBe(0)
    expect(nextRadioIndex('ArrowDown', 2, 3)).toBe(0)
  })

  it('moves backward on both Left and Up, wrapping at the start', () => {
    // The `+ length` in the modulo is what stops this being -1: JS's % keeps
    // the sign of the dividend, so `(0 - 1) % 3` is -1, not 2.
    expect(nextRadioIndex('ArrowLeft', 0, 3)).toBe(2)
    expect(nextRadioIndex('ArrowUp', 0, 3)).toBe(2)
    expect(nextRadioIndex('ArrowLeft', 2, 3)).toBe(1)
  })

  it('handles Home and End', () => {
    expect(nextRadioIndex('Home', 2, 4)).toBe(0)
    expect(nextRadioIndex('End', 0, 4)).toBe(3)
  })

  it('returns null for keys it does not own, so the caller leaves them alone', () => {
    // Critically includes Tab and Enter: swallowing Tab would trap focus in the
    // group, and swallowing Enter/Space would break native button activation.
    for (const k of ['Tab', 'Enter', ' ', 'Escape', 'a', 'PageDown', 'ArrowRightt']) {
      expect(nextRadioIndex(k, 0, 3)).toBeNull()
    }
  })

  it('never returns an out-of-range index for any key or position', () => {
    for (const len of [1, 2, 3, 4, 10]) {
      for (let i = 0; i < len; i++) {
        for (const k of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
          const n = nextRadioIndex(k, i, len)
          expect(n).not.toBeNull()
          expect(n!).toBeGreaterThanOrEqual(0)
          expect(n!).toBeLessThan(len)
        }
      }
    }
  })

  it('is a no-op for an empty group rather than returning NaN', () => {
    // A radiogroup can legitimately render zero options (the avatar picker
    // before profiles load). `% 0` is NaN, which would then be passed to an
    // array index and focus nothing while claiming to have moved.
    for (const k of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(nextRadioIndex(k, 0, 0)).toBeNull()
    }
  })

  it('stays in range when the current index is out of range', () => {
    // `values.indexOf(value)` returns -1 when the stored value is not in the
    // list — a tampered pref, or a value from a newer build. The caller clamps
    // to 0, but the helper must not produce a negative index if it does not.
    expect(nextRadioIndex('ArrowRight', 0, 3)).toBe(1)
    const n = nextRadioIndex('ArrowLeft', 0, 3)
    expect(n).toBe(2)
  })
})

describe('shouldShowProfileGate', () => {
  // D7's policy, as a pure function — a component that only reveals its policy
  // by being rendered is untestable here (no jsdom), and this policy has four
  // inputs of which two are easy to get backwards.

  it('shows on a first visit when there is a choice to make', () => {
    expect(shouldShowProfileGate({ profileCount: 3, seen: false, forced: false, ready: true })).toBe(true)
  })

  it('stays away once seen on this device', () => {
    expect(shouldShowProfileGate({ profileCount: 3, seen: true, forced: false, ready: true })).toBe(false)
  })

  it('never shows for a solo server, seen or not', () => {
    // The whole point of D7 choosing "first visit per device" over "every
    // login": a one-profile server has nothing to pick and must never be nagged.
    for (const seen of [true, false]) {
      expect(shouldShowProfileGate({ profileCount: 1, seen, forced: false, ready: true })).toBe(false)
      expect(shouldShowProfileGate({ profileCount: 0, seen, forced: false, ready: true })).toBe(false)
    }
  })

  it('opens on demand even after being seen', () => {
    // The switcher's "See all profiles" entry point has to work forever, not
    // only until the flag is set.
    expect(shouldShowProfileGate({ profileCount: 2, seen: true, forced: true, ready: true })).toBe(true)
  })

  it('refuses to open on demand when there is still nothing to choose', () => {
    // `forced` outranks `seen`, but not the count — an empty picker is a dead
    // end with no way to make progress.
    expect(shouldShowProfileGate({ profileCount: 1, seen: true, forced: true, ready: true })).toBe(false)
  })

  it('waits until the profile list has loaded', () => {
    // Without this the gate evaluates `profileCount < 2` against an empty array
    // on first paint, decides it is unnecessary, and never appears — the flag
    // is not even involved. `ready` outranks `forced` for the same reason.
    expect(shouldShowProfileGate({ profileCount: 0, seen: false, forced: false, ready: false })).toBe(false)
    expect(shouldShowProfileGate({ profileCount: 3, seen: false, forced: false, ready: false })).toBe(false)
    expect(shouldShowProfileGate({ profileCount: 3, seen: true, forced: true, ready: false })).toBe(false)
  })

  it('asks again if a server grows a second profile after the flag was set', () => {
    // The count check short-circuits ahead of `seen`, so a flag set during the
    // solo era does not permanently suppress the gate. Adding a second profile
    // makes the question meaningful for the first time.
    expect(shouldShowProfileGate({ profileCount: 1, seen: false, forced: false, ready: true })).toBe(false)
    expect(shouldShowProfileGate({ profileCount: 2, seen: false, forced: false, ready: true })).toBe(true)
  })
})
