// What the app can truthfully say about an error that stopped a page: the
// error screen shows it under "What the app saw", and a report sent from
// that screen carries the same lines, as shown.
//
// It is the error's message, never its stack: a stack is file paths and
// line numbers the person has not been shown. The message is cleaned the
// way the diagnostic log cleans what it keeps (credentials masked), the
// server's own address is taken out of it, and it is cut to a length that
// fits on the screen it is shown on.
//
// Nothing here may throw, whatever was thrown: this is read by the screen
// that stands in for the app, and a throw here would leave a blank page.

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
  /** The same lines as a report carries them: each as an inline code span,
   *  so that the issue tracker shows the characters and acts on none of
   *  them (a link, an issue number, an @name). */
  text: string
}

/** The thrown value's message, when it has one that is text. Anything can
 *  be thrown, and a message can be anything, or a getter that throws. */
export function messageOf(error: unknown): string {
  try {
    if (typeof error === 'string') return error
    const message = (error as { message?: unknown } | null | undefined)?.message
    return typeof message === 'string' ? message : ''
  } catch {
    return ''
  }
}

/** A line as a Markdown code span: delimited by a run of backticks longer
 *  than any in the line, and padded with a space when the line starts or
 *  ends with one (the renderer takes one space off each side). Rendered, it
 *  is the line's own characters. */
export function codeSpan(line: string): string {
  const longest = Math.max(0, ...Array.from(line.matchAll(/`+/g), m => m[0].length))
  const fence = '`'.repeat(longest + 1)
  const pad = line.startsWith('`') || line.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${line}${pad}${fence}`
}

/** The page's address as path and query, never with the host: the
 *  redaction hands back a whole URL once it has masked something. */
function pathAndQuery(path: string, origin: string): string {
  const redacted = redactURL(path)
  if (redacted === path) return path
  try {
    const u = new URL(redacted)
    return u.pathname + u.search + u.hash
  } catch {
    return origin && redacted.startsWith(origin) ? redacted.slice(origin.length) : redacted
  }
}

/** The message as it may be shown and sent: one line, no host, credentials
 *  masked, no longer than fits. */
export function cleanErrorText(raw: string, origin: string): string | null {
  let text = raw
  if (origin) text = text.split(origin).join('')
  text = redactConsoleMessage(text).replace(/\s+/g, ' ').trim()
  if (!text) return null
  // Cut by characters, never inside one (a surrogate pair split in two is
  // sent as a replacement character, and would differ from what is shown).
  const chars = Array.from(text)
  return chars.length > MAX_ERROR_TEXT ? `${chars.slice(0, MAX_ERROR_TEXT - 1).join('')}…` : text
}

export function describeCaughtError(
  error: unknown,
  at: Date,
  where: { location: Pick<Location, 'pathname' | 'search' | 'origin'>; document: Document } = { location: window.location, document },
): AppSaw {
  const raw = messageOf(error)
  let stale = false
  try { stale = isStaleBundleError(raw) } catch { /* not claimed */ }
  // A chunk that did not load: an update of the app deletes the files of
  // the build before it, and a dropped connection fails the same request,
  // so neither is claimed.
  const summary = stale
    ? 'A part of the app did not load: the app was updated while this tab was open, or the connection dropped.'
    : 'The page stopped while it was being drawn.'
  let message: string | null = null
  try { message = cleanErrorText(raw, where.location.origin) } catch { /* none to show */ }
  let page = where.location.pathname
  try { page = pathAndQuery(where.location.pathname + (where.location.search || ''), where.location.origin) } catch { /* the path alone */ }
  let time = ''
  try { time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) } catch { /* left out */ }
  let build: string | null = null
  try { build = readBuildId(where.document) } catch { /* unknown */ }
  const facts = [`Page: ${page}`, ...(time ? [time] : []), ...(build ? [`build ${build}`] : [])].join(' · ')
  const lines = [summary, ...(message ? [message] : []), facts]
  return { summary, message, page, time, build, lines, text: `What the app saw:\n${lines.map(codeSpan).join('\n')}` }
}
