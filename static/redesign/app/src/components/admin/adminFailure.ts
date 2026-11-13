// What the admin page says when something it asked of the server did not
// happen: the app's own sentence (lib/failureWords, chosen by the failure's
// kind, never by the server's wording), with the Admin page's own sentences
// where it knows more about a route's status; and, because the person
// reading runs the server, the server's own text as a second line
// (serverSaidForAdmin). The server's line is never the only thing said.

import { APIError, NetworkError } from '@/lib/api'
import { failureReason, failureWords, serverSaidForAdmin } from '@/lib/failureWords'

export interface Failure {
  /** The page's words. */
  says: string
  /** "The server said: …", when the server sent any text beyond a bare
   *  status. Plain text, capped. */
  server: string | null
}

/** What a route knows of its own statuses (the retype's 409, a room's 403),
 *  by status or by the server's `error.reason`, never by its words; and
 *  sentences of its own for the cases that are not a status. */
export type FailureOverrides = Partial<Record<number, string>> & {
  reason?: Record<string, string>
  /** A request that got no answer. Without it a write says NO_ANSWER_WRITE:
   *  a connection can drop after the server has acted, so "could not reach
   *  the server" may be false of it. */
  noAnswer?: string
  /** The request only reads: no answer is the shared "could not reach the
   *  server". */
  read?: boolean
  /** A 5xx, or a failure that is not an answer at all, when the route has a
   *  truer sentence than "Could not … just now." */
  otherwise?: string
}

/** A write's "no answer": it may have happened. */
export const NO_ANSWER_WRITE = 'No answer came back from the server, so this may or may not have happened. Check the connection and look again before trying again.'

const bareStatus = /^HTTP \d{3}$/

/** What the Admin page knows better than the shared words: the person
 *  reading can act on this one (the admin routes refuse a session acting as
 *  a profile with a content limit). */
const ADMIN_REASONS: Record<string, string> = {
  profile_restricted: 'The profile you are watching as has a content limit, so it cannot do this. Switch to a profile without a limit first.',
}

/** The one place the admin page turns a failure into words. `doing`
 *  completes "Could not …" ("delete the library"). No request on the page
 *  is made with an abort signal; were an abort to reach here, it is said as
 *  a general failure rather than as nothing. */
export function adminFailure(e: unknown, doing: string, overrides: FailureOverrides = {}): Failure {
  const { reason, noAnswer, otherwise, read, ...status } = overrides
  const server = e instanceof APIError && bareStatus.test(e.message.trim()) ? null : serverSaidForAdmin(e)
  if (e instanceof NetworkError) return { says: noAnswer ?? (read ? failureWords(e, doing) : null) ?? NO_ANSWER_WRITE, server: null }
  const r = failureReason(e)
  const named = e instanceof APIError && (Object.hasOwn(status, e.status) || (!!r && (Object.hasOwn(ADMIN_REASONS, r) || (!!reason && Object.hasOwn(reason, r)))))
  if (otherwise && !named && (!(e instanceof APIError) || e.status >= 500)) return { says: otherwise, server }
  return { says: failureWords(e, doing, { status, reason: { ...ADMIN_REASONS, ...reason } }) ?? `Could not ${doing} just now.`, server }
}

/** The server's account of a restore that failed (its record's message), as
 *  the Admin page's second line. Admin page only, as every server line is. */
export function restoreServerLine(st: { state: string; message?: string } | null): string | null {
  return st && st.state === 'failed' && st.message ? serverSaidForAdmin(new APIError(500, st.message, null)) : null
}
