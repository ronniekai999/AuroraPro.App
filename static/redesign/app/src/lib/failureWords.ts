// What the app says when something it tried did not work: its own sentence,
// chosen by the KIND of failure, never the server's or the browser's words.
//
// The server's error text is written for whoever runs the server ("pq:
// connection refused", "failed to resolve library"), the browser's for a
// developer ("Failed to fetch"), and a 404's for neither: under a profile's
// rating limit a missing title and one above the limit get the same 404, and
// the words on the page must not tell them apart either. So the kind is read
// from the failure itself (lib/api's APIError: its status and the reason the
// server put in `error.reason`; a TypeError from fetch is a lost connection;
// an abort is nobody's failure) and turned into one of a few sentences, each
// true of every caller. A caller that knows more about a status (a party's
// "you already have one") passes its own sentence for that status or reason.
//
// The sign-in pages keep their own list (AuthView): they word particular
// server sentences on purpose.

import { APIError } from './api'

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
  const reason = body && typeof body === 'object' ? body.error?.reason : undefined
  return typeof reason === 'string' && reason ? reason : null
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError'
}

function waitWords(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return 'Wait a moment and try again.'
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
  if (reason && overrides.reason?.[reason]) return overrides.reason[reason]
  if (err instanceof APIError) {
    const own = overrides.status?.[err.status]
    if (own) return own
    switch (err.status) {
      case 401: return 'Your session has ended. Sign in again.'
      case 403: return reason === 'profile_restricted' ? 'This profile is not allowed to do that.' : 'That is not allowed.'
      // One sentence whether or not the thing exists: the server answers a
      // missing id and one above the profile's limit alike.
      case 404: return 'That is not available.'
      case 409: return 'That changed in the meantime. Try again.'
      case 429: return `Too many tries. ${waitWords(err.retryAfterSec)}`
    }
    return `Could not ${doing} just now.`
  }
  // fetch rejects with a TypeError when the request never got an answer.
  if (err instanceof TypeError) return 'Could not reach the server. Check the connection and try again.'
  return `Could not ${doing} just now.`
}

/** Longest server text the Admin page shows. */
export const SERVER_SAID_MAX = 200

/**
 * FOR THE ADMIN PAGE ONLY (components/admin): the server's own text, as a
 * secondary line under the app's sentence, for the person who runs the
 * server. Plain text: control characters dropped, whitespace collapsed,
 * trimmed and cut to SERVER_SAID_MAX characters. Null when there is none.
 * Anywhere else it would put the server's words in front of a viewer, which
 * failureWords exists to prevent (failureWords.test.ts reads the sources).
 */
export function serverSaidForAdmin(err: unknown): string | null {
  if (isAbort(err) || !(err instanceof Error)) return null
  // eslint-disable-next-line no-control-regex
  const text = err.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  const cut = text.length > SERVER_SAID_MAX ? `${text.slice(0, SERVER_SAID_MAX - 1).trimEnd()}…` : text
  return `The server said: ${cut}`
}
