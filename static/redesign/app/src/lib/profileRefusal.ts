// What to tell a person when the server refuses a profile or account change.
//
// The profile routes send a stable `error.reason` beside a message written
// for logs ("this profile's content rating limit just changed; reload and try
// again"). The reason is what the app branches on, and these are the words it
// shows. A refusal with no reason this file knows keeps the server's message,
// which is still better than "failed".

import { APIError } from './api'

export type RefusalReason =
  | 'profile_restricted'
  | 'last_unrestricted_profile'
  | 'profile_changed'
  | 'profile_pin_required'
  | 'profile_pin_invalid'
  | 'profile_pin_locked'
  | 'session_unbound'
  | 'session_ended'
  | 'rate_limited'

const REASONS: readonly RefusalReason[] = [
  'profile_restricted', 'last_unrestricted_profile', 'profile_changed',
  'profile_pin_required', 'profile_pin_invalid', 'profile_pin_locked',
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

/** The sentence for a refusal. `fallback` is for an error with no message at
 *  all (never shown for one the server explained). */
export function refusalMessage(e: unknown, fallback: string): string {
  switch (refusalReason(e)) {
    case 'profile_restricted':
      return 'The profile you are watching as has a content limit, so it cannot change this. Switch to a profile without a limit first.'
    case 'last_unrestricted_profile':
      return 'One profile has to stay without a limit, so that someone can manage the others. Take the limit off another profile first.'
    case 'profile_changed':
      return 'This profile was changed on another device a moment ago. The list has been reloaded: check it, then try again.'
    case 'profile_pin_required':
      return 'This profile is locked. Enter its PIN, or the account password, and try again.'
    case 'profile_pin_invalid':
      return 'That PIN or password is not right.'
    case 'profile_pin_locked':
      return `Too many wrong attempts. Try again ${waitPhrase(retryAfter(e), 'in 15 minutes')}.`
    case 'session_unbound':
      return 'This session cannot hold a profile yet. Reload the page and try again.'
    case 'session_ended':
      return 'This device has been signed out. Sign in again to go on.'
    case 'rate_limited':
      return `Too many tries at changing a PIN in a short time. Try again ${waitPhrase(retryAfter(e), 'in a few minutes')}.`
    default:
      return e instanceof Error && e.message ? e.message : fallback
  }
}
