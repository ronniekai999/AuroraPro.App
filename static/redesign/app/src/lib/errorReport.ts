// What the app can truthfully say about an error that stopped a page: the
// error screen shows it under "What the app saw", and a report sent from
// that screen carries the same lines, as shown.
//
// It is the error's message, never its stack: a stack is file paths and
// line numbers the person has not been shown. The message is cleaned the
// way the diagnostic log cleans what it keeps (credentials masked), the
// server's own address is taken out of it, and it is cut to a length that
// fits on the screen it is shown on.

import { isStaleBundleError, readBuildId } from '@/lib/buildUpdate'
import { redactConsoleMessage, redactURL } from '@/lib/diagnosticBuffer'

/** The page's own reload, which keeps its address. Held here so that what
 *  the error screen's button does can be watched. */
export const thisPage = {
  reload(): void { window.location.reload() },
}

/** The longest message shown and sent. */
export const MAX_ERROR_TEXT = 300

export interface AppSaw {
  /** The kind of failure, in plain words. */
  summary: string
  /** The error's own message, cleaned; null when it has none. */
  message: string | null
  /** The address of the page that stopped (path and query, no host). */
  page: string
  /** When it stopped, as a time of day. */
  time: string
  /** The build this tab is running, when it knows. */
  build: string | null
  /** The lines as shown on the screen, top to bottom. */
  lines: string[]
  /** The same lines as a report carries them. */
  text: string
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

/** The message as it may be shown and sent: one line, no host, credentials
 *  masked, no longer than fits. */
export function cleanErrorText(raw: string, origin: string): string | null {
  let text = raw
  if (origin) text = text.split(origin).join('')
  text = redactConsoleMessage(text).replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT - 1)}…` : text
}

export function describeCaughtError(
  error: unknown,
  at: Date,
  where: { location: Pick<Location, 'pathname' | 'search' | 'origin'>; document: Document } = { location: window.location, document },
): AppSaw {
  const stale = isStaleBundleError(error)
  // A chunk that did not load: an update of the app deletes the files of
  // the build before it, and a dropped connection fails the same request,
  // so neither is claimed.
  const summary = stale
    ? 'A part of the app did not load: the app was updated while this tab was open, or the connection dropped.'
    : 'The page stopped while it was being drawn.'
  const message = cleanErrorText(messageOf(error), where.location.origin)
  const page = redactURL(where.location.pathname + (where.location.search || ''))
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const build = readBuildId(where.document)
  const facts = [`Page: ${page}`, time, ...(build ? [`build ${build}`] : [])].join(' · ')
  const lines = [summary, ...(message ? [message] : []), facts]
  return { summary, message, page, time, build, lines, text: `What the app saw:\n${lines.join('\n')}` }
}
