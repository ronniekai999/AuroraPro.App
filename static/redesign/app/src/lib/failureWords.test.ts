import { describe, expect, it } from 'vitest'
import { APIError } from './api'
import { SERVER_SAID_MAX, failureReason, failureWords, serverSaidForAdmin } from './failureWords'

// What the server and the browser say: none of it may reach a sentence.
const SERVER = 'pq: connection refused at 10.0.0.4 <b>not found</b>'
const refused = (status: number, reason?: string, retryAfterSec?: number) =>
  new APIError(status, SERVER, { error: { code: status, message: SERVER, ...(reason ? { reason } : {}) } }, retryAfterSec)
const lost = () => new TypeError('Failed to fetch')

describe('failureWords: the app\'s sentence by the kind of failure', () => {
  it.each([
    ['a lost connection', lost(), 'Could not reach the server. Check the connection and try again.'],
    ['a 401', refused(401), 'Your session has ended. Sign in again.'],
    ['a 403 for a restricted profile', refused(403, 'profile_restricted'), 'This profile is not allowed to do that.'],
    ['any other 403', refused(403), 'That is not allowed.'],
    ['a 404', refused(404), 'That is not available.'],
    ['a 409', refused(409), 'That changed in the meantime. Try again.'],
    ['a 429 with no wait given', refused(429), 'Too many tries. Wait a moment and try again.'],
    ['a 429 with a wait in seconds', refused(429, undefined, 30), 'Too many tries. Try again in 30 seconds.'],
    ['a 429 with a wait of one second', refused(429, undefined, 1), 'Too many tries. Try again in 1 second.'],
    ['a 429 with a wait in minutes', refused(429, undefined, 900), 'Too many tries. Try again in 15 minutes.'],
    ['a 500', refused(500), 'Could not play this title just now.'],
    ['a 502', refused(502), 'Could not play this title just now.'],
    ['an unexpected 4xx', refused(418), 'Could not play this title just now.'],
    ['an Error of the app\'s own', new Error('No file available to play'), 'Could not play this title just now.'],
    ['a thrown string', 'boom', 'Could not play this title just now.'],
    ['nothing at all', undefined, 'Could not play this title just now.'],
  ])('%s', (_kind, err, says) => {
    expect(failureWords(err, 'play this title')).toBe(says)
  })

  it('says nothing for a request abandoned on purpose', () => {
    expect(failureWords(new DOMException('The operation was aborted.', 'AbortError'), 'play this title')).toBeNull()
    const err = new Error('aborted'); err.name = 'AbortError'
    expect(failureWords(err, 'play this title')).toBeNull()
  })

  it('never returns the server\'s or the browser\'s text', () => {
    const kinds: unknown[] = [lost(), refused(401), refused(403, 'profile_restricted'), refused(403), refused(404), refused(409), refused(429), refused(500), new Error(SERVER), SERVER]
    for (const err of kinds) {
      const said = failureWords(err, 'save it') ?? ''
      for (const word of ['pq', 'refused', '10.0.0.4', '<b>', 'not found', 'Failed to fetch']) expect(said).not.toContain(word)
    }
  })

  it('takes a caller\'s sentence for a status or a reason, the reason first', () => {
    const own = { status: { 409: 'You already have a party.' }, reason: { profile_restricted: 'A kid\'s profile cannot start a party.' } }
    expect(failureWords(refused(409), 'start the party', own)).toBe('You already have a party.')
    expect(failureWords(refused(403, 'profile_restricted'), 'start the party', own)).toBe('A kid\'s profile cannot start a party.')
    // A reason with no sentence of the caller's falls to the status's.
    expect(failureWords(refused(409, 'something_else'), 'start the party', own)).toBe('You already have a party.')
    // Other statuses are not touched.
    expect(failureWords(refused(404), 'start the party', own)).toBe('That is not available.')
  })

  it('reads the server\'s reason from its answer, and nothing from anything else', () => {
    expect(failureReason(refused(403, 'profile_restricted'))).toBe('profile_restricted')
    expect(failureReason(refused(403))).toBeNull()
    expect(failureReason(new APIError(500, 'x', 'not json'))).toBeNull()
    expect(failureReason(new APIError(500, 'x', null))).toBeNull()
    expect(failureReason(lost())).toBeNull()
  })
})

describe('serverSaidForAdmin: the server\'s own text, for the Admin page only', () => {
  it('is a secondary line in plain text: control characters and runs of space collapsed, trimmed', () => {
    expect(serverSaidForAdmin(new APIError(500, '  pq:\tconnection\n\nrefused\u0000 ', null))).toBe('The server said: pq: connection refused')
  })

  it('is cut to its length', () => {
    const said = serverSaidForAdmin(new APIError(500, 'x'.repeat(1000), null))!
    expect(said.startsWith('The server said: ')).toBe(true)
    const text = said.slice('The server said: '.length)
    expect(text.length).toBe(SERVER_SAID_MAX)
    expect(text.endsWith('…')).toBe(true)
  })

  it('is nothing for an abort, an empty message or a thrown value that is not an error', () => {
    expect(serverSaidForAdmin(new DOMException('aborted', 'AbortError'))).toBeNull()
    expect(serverSaidForAdmin(new Error('   '))).toBeNull()
    expect(serverSaidForAdmin('boom')).toBeNull()
  })

  // Anywhere else it would put the server's words in front of a viewer.
  it('is used nowhere outside components/admin', () => {
    // Every source file of the app, as text (tests excluded).
    const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    expect(Object.keys(sources).length).toBeGreaterThan(50)
    // The page itself is among them, under the prefix the filter below reads.
    expect(Object.keys(sources)).toContain('../components/admin/AdminView.tsx')
    const users = Object.entries(sources).filter(([, text]) => text.includes('serverSaidForAdmin')).map(([file]) => file)
    expect(users.filter(f => f !== './failureWords.ts' && !f.startsWith('../components/admin/'))).toEqual([])
  })
})
