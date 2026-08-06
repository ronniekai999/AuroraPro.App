// Unit tests for the watch-party invite helpers. The date math here
// decides which calendar cell a party lands on and which quick-pick chips
// the composer offers — the two places a timezone bug would ship a party
// on the wrong day.

import { describe, expect, it } from 'vitest'
import {
  buildQuickChips,
  countdownLabel,
  formatPartyTime,
  inviteCodeFromLink,
  localDateKey,
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
