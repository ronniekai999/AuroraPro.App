// What to tell a person when the server refuses a profile or account change.
//
// The profile routes send a stable `error.reason` beside a message written
// for logs ("this profile's content rating limit just changed; reload and try
// again"). The reason is what the app branches on, and these are the words it
// shows. A refusal with no reason this file knows is said by its kind
// (lib/failureWords) when the caller says what it was doing, else in the
// caller's own fallback sentence: never in the server's words.

import { APIError } from './api'
import { failureWords, type FailureOverrides } from './failureWords'

export type RefusalReason =
  | 'profile_restricted'
  | 'last_unrestricted_profile'
  | 'profile_changed'
  | 'profile_pin_required'
  | 'profile_pin_invalid'
  | 'profile_pin_locked'
  | 'profile_locked'
  | 'session_unbound'
  | 'session_ended'
  | 'rate_limited'

const REASONS: readonly RefusalReason[] = [
  'profile_restricted', 'last_unrestricted_profile', 'profile_changed',
  'profile_pin_required', 'profile_pin_invalid', 'profile_pin_locked', 'profile_locked',
  'session_unbound', 'session_ended', 'rate_limited',
]

/** The reason a refusal carries, or null for an error that carries none
 *  (a network failure, a plain 400, a reason from a newer server). */
export function refusalReason(e: unknown): RefusalReason | null {
  if (!(e instanceof APIError)) return null
  const body = e.body
  if (!body || typeof body !== 'object') return null
  const errField = (body as Record<string, unknown>).error
  if (!errField || typeof errField !== 'object') return null
  const reason = (errField as Record<string, unknown>).reason
  return REASONS.find(r => r === reason) ?? null
}

/** "in about 12 minutes", from a Retry-After in seconds. The server's figure
 *  for a spent password budget is the whole window, not the time left, so
 *  this never promises to the minute. Without one: `fallback`. */
export function waitPhrase(retryAfterSec: number | undefined, fallback: string): string {
  if (!retryAfterSec || retryAfterSec <= 0) return fallback
  const minutes = Math.ceil(retryAfterSec / 60)
  return minutes <= 1 ? 'in about a minute' : `in about ${minutes} minutes`
}

const retryAfter = (e: unknown) => (e instanceof APIError ? e.retryAfterSec : undefined)

/** The sentence for a refusal. A reason this file knows has its own
 *  sentence; any other failure is said by its kind (failureWords) with
 *  `doing` ("add the profile"), or, without `doing` or for an abandoned
 *  request, as `fallback`. `overrides` are failureWords' (a status this
 *  caller knows more about). `reloaded: false` is for a page with no list
 *  of profiles that it reloads after a refusal. */
export function refusalMessage(
  e: unknown,
  fallback: string,
  { reloaded = true, doing, overrides }: { reloaded?: boolean; doing?: string; overrides?: FailureOverrides } = {},
): string {
  switch (refusalReason(e)) {
    case 'profile_restricted':
      return 'The profile you are watching as has a content limit, so it cannot change this. Switch to a profile without a limit first.'
    case 'last_unrestricted_profile':
      return 'One profile has to stay without a limit, so that someone can manage the others. Take the limit off another profile first.'
    case 'profile_changed':
      return reloaded
        ? 'This profile was changed on another device a moment ago. The list has been reloaded: check it, then try again.'
        : 'This profile was changed on another device a moment ago. Try again.'
    case 'profile_pin_required':
      return 'This profile is locked. Enter its PIN, or the account password, and try again.'
    case 'profile_pin_invalid':
      return 'That PIN or password is not right.'
    case 'profile_pin_locked':
      return `Too many wrong attempts. Try again ${waitPhrase(retryAfter(e), 'in 15 minutes')}.`
    case 'profile_locked':
      // Pairing a TV: a device cannot be put on a profile past its PIN.
      return 'Every profile on this account has a PIN, so a TV cannot be approved from here. Sign in on the TV with the account password instead.'
    case 'session_unbound':
      return 'This session cannot hold a profile yet. Reload the page and try again.'
    case 'session_ended':
      return 'This device has been signed out. Sign in again to go on.'
    case 'rate_limited':
      return `Too many tries at changing a PIN in a short time. Try again ${waitPhrase(retryAfter(e), 'in a few minutes')}.`
    default:
      return (doing ? failureWords(e, doing, overrides) : null) ?? fallback
  }
}
