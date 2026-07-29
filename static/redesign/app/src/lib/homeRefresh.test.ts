import { describe, it, expect } from 'vitest'
import { shouldRefreshHome, shouldResetPersonalizedRails, HOME_STALE_MS } from './homeRefresh'

const base = { view: 'home', signedIn: true, lastAttemptAt: 0, now: 0 }

describe('shouldRefreshHome', () => {
  it('would refresh when nothing has ever loaded', () => {
    // lastAttemptAt 0 means no load has been attempted. Uses a realistic epoch
    // `now`, since any real clock is far beyond the window from 0.
    expect(shouldRefreshHome({ ...base, now: Date.now() })).toBe(true)
  })

  it('is suppressed once the initial load has stamped — no double-fetch on boot', () => {
    // App sets `user` twice on boot (cached blob, then the authoritative /me),
    // and the home effect runs on each. Because the effect stamps on ATTEMPT,
    // the gate sees a fresh timestamp and does not add a third fan-out.
    const now = Date.now()
    expect(shouldRefreshHome({ ...base, lastAttemptAt: now, now: now + 50 })).toBe(false)
  })

  it('does not refresh on a quick tab bounce', () => {
    // The whole point of the gate: leaving and coming straight back is free.
    const t = 1_000_000
    expect(shouldRefreshHome({ ...base, lastAttemptAt: t, now: t + 5_000 })).toBe(false)
  })

  it('refreshes once the window has passed', () => {
    const t = 1_000_000
    expect(shouldRefreshHome({ ...base, lastAttemptAt: t, now: t + HOME_STALE_MS + 1 })).toBe(true)
  })

  it('is exclusive at the boundary, so it cannot fire twice on the same tick', () => {
    const t = 1_000_000
    expect(shouldRefreshHome({ ...base, lastAttemptAt: t, now: t + HOME_STALE_MS })).toBe(false)
  })

  it('never fires off Home', () => {
    for (const view of ['movies', 'shows', 'settings', 'admin']) {
      expect(shouldRefreshHome({ ...base, view, now: 10 ** 9 })).toBe(false)
    }
  })

  it('never fires signed out', () => {
    expect(shouldRefreshHome({ ...base, signedIn: false, now: 10 ** 9 })).toBe(false)
  })

  it('a load in flight suppresses the next navigation — the starvation guard', () => {
    // THE regression this encodes. If the caller stamps only on SUCCESS, a slow
    // load leaves lastAttemptAt stale for its whole duration and every return
    // to Home re-triggers, aborting the in-flight fetch. Stamped on ATTEMPT,
    // the same navigations are correctly suppressed and the load completes.
    const start = 1_000_000
    const stampedOnAttempt = start
    for (const bounceAt of [start + 500, start + 2_000, start + 7_900]) {
      expect(shouldRefreshHome({ ...base, lastAttemptAt: stampedOnAttempt, now: bounceAt })).toBe(false)
    }
    // Whereas a caller that had not yet stamped would re-fire on every one.
    const notStamped = 0
    for (const bounceAt of [start + 500, start + 2_000, start + 7_900]) {
      expect(shouldRefreshHome({ ...base, lastAttemptAt: notStamped, now: bounceAt })).toBe(true)
    }
  })
})

describe('shouldResetPersonalizedRails', () => {
  it('resets before the first load, when there is nothing to preserve', () => {
    expect(shouldResetPersonalizedRails(undefined, 7)).toBe(true)
    expect(shouldResetPersonalizedRails(undefined, null)).toBe(true)
  })

  it('resets on a profile switch — the reason the reset exists', () => {
    // A kid profile must never splice the previous profile's picks.
    expect(shouldResetPersonalizedRails(7, 9)).toBe(true)
    expect(shouldResetPersonalizedRails(7, null)).toBe(true)
    expect(shouldResetPersonalizedRails(null, 7)).toBe(true)
  })

  it('does NOT reset on a same-profile refresh', () => {
    // The regression: wiping here tore every AI PICK / Discover / anchor rail
    // off the screen for a round-trip on the app's most-visited page, every
    // time the staleness gate or a scan fired.
    expect(shouldResetPersonalizedRails(7, 7)).toBe(false)
  })

  it('treats null as a real profile, not as "unset"', () => {
    // null means "the account default". Conflating it with undefined would
    // reset on every refresh for anyone who has not picked a profile.
    expect(shouldResetPersonalizedRails(null, null)).toBe(false)
  })
})
