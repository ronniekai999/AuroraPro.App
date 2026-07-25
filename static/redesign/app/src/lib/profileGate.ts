// "Who's watching?" gate — when it shows (Aurora Stage Phase 7b, D7).
//
// D7: first visit per device, then remembered; reachable any time from the
// profile switcher; and SKIPPED ENTIRELY when only one profile exists, because
// there is nothing to choose and a solo server should never be nagged.
//
// The decision is a pure function so it can be tested without a DOM — the
// alternative is a component that only reveals its policy by being rendered,
// and this policy has four inputs and two of them are easy to get backwards.

import { readPrefsSnapshot, writePrefKey } from './appearance'

/**
 * Per-DEVICE, not per-account: it lives in `aurora_prefs` (localStorage)
 * alongside the appearance dials, so signing in on a new browser asks again.
 * That is the intent — "who's watching" is a question about the person in front
 * of THIS screen, and the answer does not travel.
 */
export const PROFILE_GATE_SEEN_KEY = 'profile_gate_seen'

export function hasSeenProfileGate(): boolean {
  return readPrefsSnapshot()[PROFILE_GATE_SEEN_KEY] === true
}

export function markProfileGateSeen(): void {
  writePrefKey(PROFILE_GATE_SEEN_KEY, true)
}

/**
 * Whether the gate should be showing right now.
 *
 * `forced` is the switcher's "Who's watching?" entry point and outranks
 * everything except having something to choose between — opening it by hand
 * should work even after the flag is set, and even before profiles load if the
 * user is quick, hence the count check applying to it too.
 *
 * `profileCount < 2` short-circuits ahead of `seen` on purpose: a server that
 * grows a second profile later should then ask, which it would not if the flag
 * had been set by a visit made while there was only one.
 */
export function shouldShowProfileGate(opts: {
  profileCount: number
  seen: boolean
  forced: boolean
  /** Suppresses the gate while the app is still resolving who is signed in. */
  ready: boolean
}): boolean {
  if (!opts.ready) return false
  // Nothing to pick between — never show, forced or not.
  if (opts.profileCount < 2) return false
  if (opts.forced) return true
  return !opts.seen
}
