// Unit tests for the watch-party invite helpers. The date math here
// decides which calendar cell a party lands on and which quick-pick chips
// the composer offers — the two places a timezone bug would ship a party
// on the wrong day.

import { describe, expect, it } from 'vitest'
import {
  MAX_MEMBER_RESULTS,
  MIN_MEMBER_QUERY_CHARS,
  buildQuickChips,
  countMemberMatches,
  countdownLabel,
  matchMembersWithTotal,
  formatPartyTime,
  inviteCodeFromLink,
  localDateKey,
  plannedStartLabel,
  plannedStartLine,
  startHasPassed,
  todayOrTonight,
  matchMembers,
  memberQueryReady,
  normalizeMemberQuery,
  skipReasonCopy,
} from './partyInvites'

describe('buildQuickChips', () => {
  it('offers tonight 8 and 9 PM in the afternoon', () => {
    const now = new Date(2026, 7, 6, 14, 0) // Aug 6, 2:00 PM local
    const chips = buildQuickChips(now)
    expect(chips.map(c => c.label)).toEqual([
      expect.stringContaining('Tonight'),
      expect.stringContaining('Tonight'),
      expect.stringContaining('Tomorrow'),
    ])
    // Chips resolve to instants at 20:00 / 21:00 local.
    expect(new Date(chips[0].iso).getHours()).toBe(20)
    expect(new Date(chips[1].iso).getHours()).toBe(21)
  })

  it('drops tonight chips that are in the past or imminent', () => {
    const now = new Date(2026, 7, 6, 20, 50) // 8:50 PM — 9 PM is <20m out
    const labels = buildQuickChips(now).map(c => c.label)
    expect(labels.every(l => !l.startsWith('Tonight'))).toBe(true)
    // Always at least two options.
    expect(labels.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps tonight 9 PM when 8 PM has passed', () => {
    const now = new Date(2026, 7, 6, 20, 10) // 8:10 PM
    const labels = buildQuickChips(now).map(c => c.label)
    expect(labels[0]).toContain('Tonight')
    expect(new Date(buildQuickChips(now)[0].iso).getHours()).toBe(21)
  })
})

describe('inviteCodeFromLink', () => {
  it('extracts the code from a /p/ deep link', () => {
    expect(inviteCodeFromLink('/p/PMPKIN')).toBe('PMPKIN')
    expect(inviteCodeFromLink('/p/ab12cd')).toBe('AB12CD')
    expect(inviteCodeFromLink('/p/PMPKIN/')).toBe('PMPKIN')
  })
  it('rejects everything else', () => {
    expect(inviteCodeFromLink(undefined)).toBeNull()
    expect(inviteCodeFromLink('')).toBeNull()
    expect(inviteCodeFromLink('/p/TOOLONG1')).toBeNull()
    expect(inviteCodeFromLink('/parties/PMPKIN')).toBeNull()
    expect(inviteCodeFromLink('https://evil.example/p/PMPKIN')).toBeNull()
    expect(inviteCodeFromLink('/p/AB CD1')).toBeNull()
  })
})

describe('localDateKey', () => {
  it('keys an instant by the LOCAL calendar day, not UTC', () => {
    // 11 PM local on Aug 6. In any timezone west of UTC the UTC date is
    // already Aug 7 — the local key must still say Aug 6. Construct via
    // local-time parts so the test is timezone-independent.
    const lateLocal = new Date(2026, 7, 6, 23, 30)
    expect(localDateKey(lateLocal.toISOString())).toBe('2026-08-06')
  })
})

describe('formatPartyTime', () => {
  const now = new Date(2026, 7, 6, 14, 0)
  it('labels today as Tonight and tomorrow as Tomorrow', () => {
    const tonight = new Date(2026, 7, 6, 20, 0)
    const tomorrow = new Date(2026, 7, 7, 20, 0)
    expect(formatPartyTime(tonight.toISOString(), now)).toContain('Tonight')
    expect(formatPartyTime(tomorrow.toISOString(), now)).toContain('Tomorrow')
  })
  it('falls back to a weekday date beyond tomorrow', () => {
    const saturday = new Date(2026, 7, 8, 20, 0)
    const label = formatPartyTime(saturday.toISOString(), now)
    expect(label).not.toContain('Tonight')
    expect(label).not.toContain('Tomorrow')
    expect(label).toContain('·')
  })
})

// A time today is "Tonight" only from five in the afternoon. It used to be
// "Tonight" at any hour, so a party planned for eight in the morning read
// "Tonight · 8:00 AM".
describe('today or tonight', () => {
  const day = (h: number, m = 0) => new Date(2026, 7, 6, h, m)
  it('turns at five in the afternoon, local, to the minute', () => {
    expect(todayOrTonight(day(16, 59))).toBe('Today')
    expect(todayOrTonight(day(17, 0))).toBe('Tonight')
    expect(todayOrTonight(day(0, 0))).toBe('Today')
    expect(todayOrTonight(day(8, 0))).toBe('Today')
    expect(todayOrTonight(day(12, 0))).toBe('Today')
    expect(todayOrTonight(day(23, 59))).toBe('Tonight')
  })
  it('is the word formatPartyTime gives a time today', () => {
    const now = day(7, 0)
    expect(formatPartyTime(day(8, 0).toISOString(), now)).toBe('Today · 8:00 AM')
    expect(formatPartyTime(day(16, 59).toISOString(), now)).toBe('Today · 4:59 PM')
    expect(formatPartyTime(day(17, 0).toISOString(), now)).toBe('Tonight · 5:00 PM')
    expect(formatPartyTime(day(20, 0).toISOString(), now)).toBe('Tonight · 8:00 PM')
    // Whatever the hour it is asked at: the word is the time's own.
    expect(formatPartyTime(day(8, 0).toISOString(), day(22, 0))).toBe('Today · 8:00 AM')
    expect(formatPartyTime(day(20, 0).toISOString(), day(22, 0))).toBe('Tonight · 8:00 PM')
  })
  it('leaves other days as they were', () => {
    const now = day(7, 0)
    expect(formatPartyTime(new Date(2026, 7, 7, 8, 0).toISOString(), now)).toBe('Tomorrow · 8:00 AM')
    expect(formatPartyTime(new Date(2026, 7, 8, 8, 0).toISOString(), now)).toBe('Sat, Aug 8 · 8:00 AM')
  })
  it('is the word on the quick picks, which are for the evening', () => {
    const labels = buildQuickChips(day(9, 0)).map(c => c.label)
    expect(labels).toEqual(['Tonight · 8:00 PM', 'Tonight · 9:00 PM', 'Tomorrow · 8:00 PM'])
  })
})

// A party can sit unstarted past its planned time: its start was blocked,
// or nobody came. The server keeps it for a while, longer while someone is
// in its lobby, and a line that went on saying "Starts" promised something
// already missed.
describe('a planned start that has passed', () => {
  const now = new Date(2026, 7, 6, 14, 0)
  const at = (h: number, m = 0, d = 6) => new Date(2026, 7, d, h, m).toISOString()
  it('has passed from its own minute on', () => {
    expect(startHasPassed(at(14, 1), now)).toBe(false)
    expect(startHasPassed(at(14, 0), now)).toBe(true)
    expect(startHasPassed(at(13, 59), now)).toBe(true)
  })
  it('reads "Starts" while it is to come, and "Was planned for" after', () => {
    expect(plannedStartLine(at(20), now)).toBe('Starts Tonight · 8:00 PM')
    expect(plannedStartLine(at(15), now)).toBe('Starts Today · 3:00 PM')
    expect(plannedStartLine(at(10), now)).toBe('Was planned for Today · 10:00 AM')
    expect(plannedStartLine(at(20, 0, 5), now)).toBe('Was planned for Wed, Aug 5 · 8:00 PM')
    // An evening time that has gone by is still that evening's.
    expect(plannedStartLine(at(18), new Date(2026, 7, 6, 21, 0))).toBe('Was planned for Tonight · 6:00 PM')
  })
  it('stands alone as the time while it is to come, and says so once it is not', () => {
    expect(plannedStartLabel(at(20), now)).toBe('Tonight · 8:00 PM')
    expect(plannedStartLabel(at(20, 0, 7), now)).toBe('Tomorrow · 8:00 PM')
    expect(plannedStartLabel(at(10), now)).toBe('Was planned for Today · 10:00 AM')
  })
})

describe('countdownLabel', () => {
  it('renders m:ss under an hour and h:mm:ss above', () => {
    expect(countdownLabel(41 * 60_000 + 32_000)).toBe('41:32')
    expect(countdownLabel(2 * 3_600_000 + 5 * 60_000 + 9_000)).toBe('2:05:09')
    expect(countdownLabel(9_000)).toBe('0:09')
  })
  it('clamps at zero', () => {
    expect(countdownLabel(-5_000)).toBe('0:00')
  })
})

describe('skipReasonCopy', () => {
  it('maps the stable server reasons and passes unknowns through', () => {
    expect(skipReasonCopy('rating_restricted')).toContain('rating ceiling')
    expect(skipReasonCopy('already_invited')).toBe('already invited')
    expect(skipReasonCopy('not_found')).toContain('no member')
    expect(skipReasonCopy('self')).toContain('you')
    expect(skipReasonCopy('mystery_reason')).toBe('mystery_reason')
  })
})

// The composer's people picker shows nobody until these say so, so the
// threshold and the ranking are what the host actually experiences as
// "search". Both are asserted here rather than in the modal, which has no
// business re-deciding either.
describe('normalizeMemberQuery', () => {
  it('trims, lowercases, and drops a typed @handle prefix', () => {
    expect(normalizeMemberQuery('  Sam  ')).toBe('sam')
    expect(normalizeMemberQuery('@Ronnie')).toBe('ronnie')
    expect(normalizeMemberQuery('@@dee')).toBe('dee')
  })
  it('re-trims after the @ so the query never starts with whitespace', () => {
    expect(normalizeMemberQuery('@ sam')).toBe('sam')
  })
})

describe('memberQueryReady', () => {
  it('needs the threshold in real characters, not whitespace or @', () => {
    expect(memberQueryReady('')).toBe(false)
    expect(memberQueryReady('sa')).toBe(false)
    expect(memberQueryReady('  sa  ')).toBe(false)
    expect(memberQueryReady('@sa')).toBe(false)
    expect(memberQueryReady('sam')).toBe(true)
    expect(memberQueryReady('@sam')).toBe(true)
  })
  it('agrees with the exported threshold', () => {
    expect(memberQueryReady('x'.repeat(MIN_MEMBER_QUERY_CHARS - 1))).toBe(false)
    expect(memberQueryReady('x'.repeat(MIN_MEMBER_QUERY_CHARS))).toBe(true)
  })
})

describe('matchMembers', () => {
  const roster = [
    { username: 'samir', display_name: 'Samir P', is_following: false },
    { username: 'dee', display_name: 'Samantha Dee', is_following: false },
    { username: 'kass', display_name: 'Kass', is_following: true },
    { username: 'rosam', display_name: 'Ro', is_following: true },
    { username: 'sammy', display_name: 'Sammy', is_following: true },
  ]

  it('shows nobody until the query hits the threshold', () => {
    expect(matchMembers(roster, '')).toEqual([])
    expect(matchMembers(roster, 'sa')).toEqual([])
    expect(matchMembers(roster, 'sam').length).toBeGreaterThan(0)
  })

  // A blind 3-char floor makes some members permanently unreachable: OAuth
  // signup derives usernames from an email local-part with no length floor
  // (jd@gmail.com -> "jd"), display names have no minimum at all, and plenty
  // of CJK names are exactly two characters. They are invitable through the
  // API and visible in /members, so a picker that can never surface them is
  // a client-side lockout, not a tidier list.
  describe('short names stay reachable', () => {
    const shortRoster = [
      { username: 'jd', display_name: 'JD' },
      { username: 'k_9f2a1b', display_name: '田中' },
      { username: 'sammy', display_name: 'Sammy' },
      { username: 'j', display_name: 'J' },
    ]

    it('finds a member whose whole name the query already spells out', () => {
      expect(matchMembers(shortRoster, 'jd').map(m => m.username)).toEqual(['jd'])
      expect(matchMembers(shortRoster, 'JD').map(m => m.username)).toEqual(['jd'])
      expect(matchMembers(shortRoster, '@jd').map(m => m.username)).toEqual(['jd'])
      expect(matchMembers(shortRoster, '田中').map(m => m.username)).toEqual(['k_9f2a1b'])
      expect(matchMembers(shortRoster, 'j').map(m => m.username)).toEqual(['j'])
    })

    it('still refuses to list people from a partial short query', () => {
      // "sa" is a prefix of Sammy, but it is nobody's WHOLE name — so the
      // threshold still applies and the wall of names stays away.
      expect(matchMembers(shortRoster, 'sa')).toEqual([])
      expect(matchMembers(shortRoster, 'k_')).toEqual([])
    })
  })

  it('matches username or display name, case-insensitively', () => {
    expect(matchMembers(roster, 'SAMANTHA').map(m => m.username)).toEqual(['dee'])
    expect(matchMembers(roster, 'kass').map(m => m.username)).toEqual(['kass'])
  })

  it('ranks prefix matches above mid-word ones, follows above strangers', () => {
    // 'sammy' and 'samir' and 'dee' (Samantha) all start with "sam";
    // 'rosam' only contains it, so it sorts last however well-connected.
    expect(matchMembers(roster, 'sam').map(m => m.username))
      .toEqual(['sammy', 'dee', 'samir', 'rosam'])
  })

  it('honors the result cap', () => {
    expect(matchMembers(roster, 'sam', 2).map(m => m.username)).toEqual(['sammy', 'dee'])
    expect(matchMembers(roster, 'sam', 0)).toEqual([])
  })

  it('returns empty rather than everything when nothing matches', () => {
    expect(matchMembers(roster, 'zzz')).toEqual([])
    expect(matchMembers([], 'sam')).toEqual([])
  })

  it('tolerates members with no display name', () => {
    expect(matchMembers([{ username: 'samwise' }], 'sam').map(m => m.username))
      .toEqual(['samwise'])
  })

  // The DEFAULT cap, not just an explicitly-passed limit — the picker never
  // passes one, so this is the number users actually hit.
  it('caps at MAX_MEMBER_RESULTS by default', () => {
    const many = Array.from({ length: MAX_MEMBER_RESULTS + 4 }, (_, i) => ({
      username: `sam${String(i).padStart(2, '0')}`,
    }))
    expect(matchMembers(many, 'sam')).toHaveLength(MAX_MEMBER_RESULTS)
  })
})

// The count the picker announces. Announcing the RENDERED row count once the
// cap bites isn't an omission, it's false — and because the results box
// scrolls, a truncated list and a long one look identical.
describe('countMemberMatches', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ username: `sam${i}` }))

  it('counts every match, past the render cap', () => {
    expect(matchMembers(many, 'sam')).toHaveLength(MAX_MEMBER_RESULTS)
    expect(countMemberMatches(many, 'sam')).toBe(12)
  })

  it('equals the rendered count when nothing is truncated', () => {
    expect(countMemberMatches(many, 'sam3')).toBe(1)
    expect(matchMembers(many, 'sam3')).toHaveLength(1)
    expect(countMemberMatches(many, 'nobody')).toBe(0)
    expect(countMemberMatches(many, 'sa')).toBe(0)
  })
})

// Both public entry points delegate to one ranked pass, so they cannot
// disagree about what matched — and the picker takes both from a single
// call rather than scanning and sorting the roster twice per keystroke.
describe('matchMembersWithTotal', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ username: `sam${i}` }))

  it('returns the capped rows and the uncapped total together', () => {
    const { matches, total } = matchMembersWithTotal(many, 'sam')
    expect(matches).toHaveLength(MAX_MEMBER_RESULTS)
    expect(total).toBe(12)
  })

  it('agrees with the single-purpose helpers exactly', () => {
    for (const q of ['sam', 'sam1', 'nobody', 'sa', '']) {
      const { matches, total } = matchMembersWithTotal(many, q)
      expect(matches).toEqual(matchMembers(many, q))
      expect(total).toBe(countMemberMatches(many, q))
    }
  })
})
