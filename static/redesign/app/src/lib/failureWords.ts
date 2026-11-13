// What the app says when something it tried did not work: its own sentence,
// chosen by the KIND of failure, never the server's or the browser's words.
//
// The server's error text is written for whoever runs the server ("pq:
// connection refused", "failed to resolve library"), the browser's for a
// developer ("Failed to fetch"), and a 404's for neither: under a profile's
// rating limit a missing title and one above the limit get the same 404, and
// the words on the page must not tell them apart either. So the kind is read
// from the failure itself and turned into one of a few sentences, each true
// of every caller:
//   - lib/api's NetworkError: the request got no answer (fetch rejected). A
//     TypeError of any other kind is the app's own slip after an answer came
//     (a null list mapped, a proxy's HTML page read as data) and gets the
//     general sentence, never "could not reach the server";
//   - lib/api's APIError: its status, and the reason the server put in
//     `error.reason`;
//   - an AbortError: the caller abandoned the request on purpose, and
//     nothing is said (null). A caller that aborts its own controller from a
//     timer has to word that slowness itself; an `abort(reason)` with a
//     custom reason is not recognised as an abort. A TimeoutError (from
//     AbortSignal.timeout) is a failure and gets the general sentence.
// "Just now" (a retry may work) is said only of a 5xx, a lost connection
// and the app's own failure; a refusal (a 400, a 409, a 422, any 4xx
// without a sentence of its own) is the same next time and says so by
// saying nothing about trying again. A caller that knows more about a
// status or a reason (a 409 that IS a race, a party's "you already have
// one") passes its own sentence for it.
//
// The sign-in pages keep their own list (AuthView): they word particular
// server sentences on purpose.

import { APIError, NetworkError } from './api'

/** Sentences a caller knows better than these, by status or by the server's
 *  `error.reason`. A reason wins over a status. Never by the server's words. */
export interface FailureOverrides {
  status?: Partial<Record<number, string>>
  reason?: Record<string, string>
}

/** The server's `error.reason`, when its answer carried one. */
export function failureReason(err: unknown): string | null {
  if (!(err instanceof APIError)) return null
  const body = err.body as { error?: { reason?: unknown } } | null | undefined
  const reason = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error.reason : undefined
  return typeof reason === 'string' && reason ? reason : null
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError'
}

/** A caller's own sentence, read from its own keys only. */
function own(table: Record<string | number, string | undefined> | undefined, key: string | number): string | null {
  if (!table || !Object.hasOwn(table, key)) return null
  const said = table[key]
  return typeof said === 'string' && said ? said : null
}

/** Longest wait said in figures; past it, "a while". */
const WAIT_SAID_UP_TO = 60 * 60

function waitWords(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return 'Wait a moment and try again.'
  if (seconds > WAIT_SAID_UP_TO) return 'Wait a while and try again.'
  if (seconds < 60) return `Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
  const minutes = Math.ceil(seconds / 60)
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

/**
 * The app's sentence for a failure, or null when there is nothing to say
 * (the request was abandoned on purpose).
 *
 * `doing` completes "Could not …": "play this title", "save the list".
 */
export function failureWords(err: unknown, doing: string, overrides: FailureOverrides = {}): string | null {
  if (isAbort(err)) return null
  const reason = failureReason(err)
  const byReason = reason ? own(overrides.reason, reason) : null
  if (byReason) return byReason
  if (err instanceof NetworkError) return 'Could not reach the server. Check the connection and try again.'
  if (err instanceof APIError) {
    const byStatus = own(overrides.status, err.status)
    if (byStatus) return byStatus
    if (err.status >= 500) return `Could not ${doing} just now.`
    switch (err.status) {
      // The refresh after a 401 failed: the session has ended, or the server
      // could not say (a refresh answered 5xx or 429 does not end it).
      case 401: return `Could not ${doing}. You may need to sign in again.`
      case 403: return reason === 'profile_restricted' ? 'This profile is not allowed to do that.' : 'That is not allowed.'
      // One sentence whether or not the thing exists: the server answers a
      // missing id and one above the profile's limit alike.
      case 404: return 'That is not available.'
      case 429: return `Too many tries. ${waitWords(err.retryAfterSec)}`
    }
    return `Could not ${doing}.`
  }
  return `Could not ${doing} just now.`
}

/** Longest server text the Admin page shows, in characters (code points). */
export const SERVER_SAID_MAX = 200

/**
 * FOR THE ADMIN PAGE ONLY (components/admin): the server's own text, as a
 * secondary line under the app's sentence, for the person who runs the
 * server. Only an APIError's (the browser's or the app's own words are not
 * the server's). Plain text: control characters, bidirectional overrides and
 * isolates and zero-width characters dropped, whitespace collapsed, trimmed
 * and cut to SERVER_SAID_MAX code points. Null when there is none. The text
 * can hold a long unbroken token (a path, a file name): the line's CSS must
 * wrap it (`overflow-wrap: anywhere`).
 * Anywhere else it would put the server's words in front of a viewer, which
 * failureWords exists to prevent (failureWords.test.ts reads the sources).
 */
export function serverSaidForAdmin(err: unknown): string | null {
  if (!(err instanceof APIError) || typeof err.message !== 'string') return null
  const text = err.message
    .replace(/[\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  const points = Array.from(text)
  const cut = points.length > SERVER_SAID_MAX ? `${points.slice(0, SERVER_SAID_MAX - 1).join('').trimEnd()}…` : text
  return `The server said: ${cut}`
}
