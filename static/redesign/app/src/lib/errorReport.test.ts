// @vitest-environment jsdom
//
// What the error screen shows under "What the app saw", which is also what a
// report sent from that screen carries: so it must be true, it must be only
// what the person can read on the page, and it must not hold what the
// diagnostic log would have masked.

import { afterEach, describe, expect, it } from 'vitest'
import { MAX_ERROR_TEXT, cleanErrorText, describeCaughtError } from './errorReport'

const at = new Date(2026, 9, 1, 20, 14)
const where = (pathname: string, search = '') => {
  const doc = document.implementation.createHTMLDocument('')
  return { location: { pathname, search, origin: 'https://aurora.example' }, document: doc }
}
const withBuild = (id: string) => {
  const w = where('/v2/collections')
  const meta = w.document.createElement('meta')
  meta.name = 'aurora-build'
  meta.content = id
  w.document.head.appendChild(meta)
  return w
}

afterEach(() => { document.head.querySelector('meta[name="aurora-build"]')?.remove() })

describe('what the app saw', () => {
  it('is the kind of failure, the error\'s own message, and where and when', () => {
    const saw = describeCaughtError(new TypeError("Cannot read properties of undefined (reading 'map')"), at, withBuild('1a2b3c4d5e'))
    expect(saw.lines).toEqual([
      'The page stopped while it was being drawn.',
      "Cannot read properties of undefined (reading 'map')",
      'Page: /v2/collections · 8:14 PM · build 1a2b3c4d5e',
    ])
    // A report carries the same lines, under a heading of their own.
    expect(saw.text).toBe(`What the app saw:\n${saw.lines.join('\n')}`)
    expect(saw.page).toBe('/v2/collections')
  })

  // The build is an id the page was stamped with, when it was: the dev
  // server stamps none, and the line then says nothing about it.
  it('leaves the build out when the page carries none', () => {
    const saw = describeCaughtError(new Error('nope'), at, where('/v2/'))
    expect(saw.build).toBeNull()
    expect(saw.lines[2]).toBe('Page: /v2/ · 8:14 PM')
  })

  // A deploy deletes the files of the build before it, and a dropped
  // connection fails the same request: neither is claimed.
  it('does not claim an update for a part of the app that did not load', () => {
    const gone = new TypeError('Failed to fetch dynamically imported module: https://aurora.example/v2/assets/AdminView-old.js')
    const saw = describeCaughtError(gone, at, where('/v2/admin'))
    expect(saw.summary).toBe('A part of the app did not load: the app was updated while this tab was open, or the connection dropped.')
    // The server's own address is not part of what is shown or sent.
    expect(saw.message).toBe('Failed to fetch dynamically imported module: /v2/assets/AdminView-old.js')
    expect(saw.text).not.toContain('aurora.example')
  })

  // The message, never the stack: file paths and line numbers the person
  // has not been shown.
  it('never carries the stack', () => {
    const e = new Error('It broke')
    e.stack = 'Error: It broke\n    at Collections (https://aurora.example/v2/assets/index-abc.js:10:4321)\n    at renderWithHooks (…)'
    const saw = describeCaughtError(e, at, where('/v2/collections'))
    expect(saw.text).not.toMatch(/index-abc|renderWithHooks| at /)
    expect(saw.lines).toHaveLength(3)
  })

  it('names the page without what its address must not give away', () => {
    const saw = describeCaughtError(new Error('x'), at, where('/v2/title/123', '?token=abcdef123456&tab=episodes'))
    expect(saw.page).toContain('/v2/title/123')
    expect(saw.page).toContain('tab=episodes')
    expect(saw.page).not.toContain('abcdef123456')
    expect(saw.lines[2]).toContain(saw.page)
  })

  it('has two lines for an error with no message, or for something thrown that is not an error', () => {
    expect(describeCaughtError(new Error(''), at, where('/v2/')).lines).toHaveLength(2)
    expect(describeCaughtError({ odd: true }, at, where('/v2/')).message).toBeNull()
    expect(describeCaughtError('a string was thrown', at, where('/v2/')).message).toBe('a string was thrown')
  })

  it('reads the page and the build of the tab when told nothing else', () => {
    const meta = document.createElement('meta')
    meta.name = 'aurora-build'
    meta.content = 'feedface01'
    document.head.appendChild(meta)
    const saw = describeCaughtError(new Error('x'), at)
    expect(saw.build).toBe('feedface01')
    expect(saw.page).toBe(window.location.pathname + window.location.search)
  })
})

describe('the error text as it may be shown and sent', () => {
  it('is one line', () => {
    expect(cleanErrorText('first\n  second\tthird ', '')).toBe('first second third')
  })

  it('is cut to what fits, and says so', () => {
    const long = 'x'.repeat(MAX_ERROR_TEXT + 50)
    const cut = cleanErrorText(long, '')!
    expect(cut).toHaveLength(MAX_ERROR_TEXT)
    expect(cut.endsWith('…')).toBe(true)
    expect(cleanErrorText('x'.repeat(MAX_ERROR_TEXT), '')).toHaveLength(MAX_ERROR_TEXT)
  })

  // The diagnostic log masks these before it keeps a line; so does this.
  it('masks what looks like a credential', () => {
    const text = cleanErrorText('Request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2lnbmF0dXJl for /api/x?token=supersecretvalue', '')!
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(text).not.toContain('supersecretvalue')
    expect(text).toContain('Request failed')
  })

  it('is nothing for an empty message', () => {
    expect(cleanErrorText('   \n ', '')).toBeNull()
  })
})
