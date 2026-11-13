import { afterEach, describe, expect, it, vi } from 'vitest'
import { APIError, NetworkError, apiFetch } from './api'
import { SERVER_SAID_MAX, failureReason, failureWords, serverSaidForAdmin } from './failureWords'

// What the server and the browser say: none of it may reach a sentence.
const SERVER = 'pq: connection refused at 10.0.0.4 <b>not found</b>'
const refused = (status: number, reason?: string, retryAfterSec?: number) =>
  new APIError(status, SERVER, { error: { code: status, message: SERVER, ...(reason ? { reason } : {}) } }, retryAfterSec)
const lost = () => new NetworkError('Failed to fetch')

describe('failureWords: the app\'s sentence by the kind of failure', () => {
  it.each([
    ['a lost connection', lost(), 'Could not reach the server. Check the connection and try again.'],
    ['a 401', refused(401), 'Could not play this title. You may need to sign in again.'],
    ['a 403 for a restricted profile', refused(403, 'profile_restricted'), 'This profile is not allowed to do that.'],
    ['any other 403', refused(403), 'That is not allowed.'],
    ['a 404', refused(404), 'That is not available.'],
    ['a 400', refused(400), 'Could not play this title.'],
    ['a 409', refused(409), 'Could not play this title.'],
    ['a 422', refused(422), 'Could not play this title.'],
    ['a 429 with no wait given', refused(429), 'Too many tries. Wait a moment and try again.'],
    ['a 429 with a wait in seconds', refused(429, undefined, 30), 'Too many tries. Try again in 30 seconds.'],
    ['a 429 with a wait of one second', refused(429, undefined, 1), 'Too many tries. Try again in 1 second.'],
    ['a 429 with a wait in minutes', refused(429, undefined, 900), 'Too many tries. Try again in 15 minutes.'],
    ['a 429 with a wait of 59 seconds', refused(429, undefined, 59), 'Too many tries. Try again in 59 seconds.'],
    ['a 429 with a wait of 60 seconds', refused(429, undefined, 60), 'Too many tries. Try again in 1 minute.'],
    ['a 429 with a wait of 61 seconds', refused(429, undefined, 61), 'Too many tries. Try again in 2 minutes.'],
    ['a 429 with a wait of an hour', refused(429, undefined, 3600), 'Too many tries. Try again in 60 minutes.'],
    ['a 429 with a wait of an hour and a second', refused(429, undefined, 3601), 'Too many tries. Wait a while and try again.'],
    ['a 429 with an absurd wait', refused(429, undefined, 999999999), 'Too many tries. Wait a while and try again.'],
    ['a 429 with a wait of 0', refused(429, undefined, 0), 'Too many tries. Wait a moment and try again.'],
    ['a 429 with an endless wait', refused(429, undefined, Infinity), 'Too many tries. Wait a while and try again.'],
    ['a 500', refused(500), 'Could not play this title just now.'],
    ['a 502', refused(502), 'Could not play this title just now.'],
    ['an unlisted 4xx', refused(418), 'Could not play this title.'],
    // The app's own slip after an answer came (a null list mapped): not a
    // lost connection.
    ['a TypeError of the app\'s own', new TypeError('Cannot read properties of null (reading \'map\')'), 'Could not play this title just now.'],
    ['a fetch rejection that was never tagged', new TypeError('Failed to fetch'), 'Could not play this title just now.'],
    ['a timeout', new DOMException('signal timed out', 'TimeoutError'), 'Could not play this title just now.'],
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
    // Only the caller's own keys: a reason named like a property every
    // object has is not a sentence.
    expect(failureWords(refused(403, 'constructor'), 'start the party', own)).toBe('That is not allowed.')
    expect(failureWords(refused(403, 'toString'), 'start the party', own)).toBe('That is not allowed.')
    // Nor a sentence an override table only inherits.
    const inherited = { reason: Object.create({ teapot: 'Inherited, not the caller\'s.' }) as Record<string, string> }
    expect(failureWords(refused(403, 'teapot'), 'start the party', inherited)).toBe('That is not allowed.')
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
    expect(failureReason(new APIError(500, 'x', { error: 'flat string' }))).toBeNull()
  })
})

describe('serverSaidForAdmin: the server\'s own text, for the Admin page only', () => {
  it('is a secondary line in plain text: control characters and runs of space collapsed, trimmed', () => {
    expect(serverSaidForAdmin(new APIError(500, '  pq:\tconnection\n\nrefused\u0000 ', null))).toBe('The server said: pq: connection refused')
  })

  it('drops bidirectional overrides and isolates and zero-width characters', () => {
    expect(serverSaidForAdmin(new APIError(500, 'file \u202ecod.exe\u202c and \u2066x\u2069 a\u200bb\ufeff', null))).toBe('The server said: file cod.exe and x ab')
  })

  it('drops directional marks and invisible operators, and a joiner except inside an emoji sequence', () => {
    expect(serverSaidForAdmin(new APIError(500, 'a\u200eb\u200fc\u061cd e\u2060f\u2064g h\u200di', null))).toBe('The server said: abcd efg hi')
    // A family emoji keeps its joiners.
    expect(serverSaidForAdmin(new APIError(500, 'it is 👩\u200d👩\u200d👧', null))).toBe('The server said: it is 👩\u200d👩\u200d👧')
    // So do sequences with a skin tone or the presentation selector before
    // the joiner.
    for (const seq of ['👨🏽\u200d💻', '❤️\u200d🔥', '🏳️\u200d🌈']) {
      expect(serverSaidForAdmin(new APIError(500, seq, null))).toBe(`The server said: ${seq}`)
    }
  })

  it('is cut on whole characters', () => {
    const said = serverSaidForAdmin(new APIError(500, '😀'.repeat(300), null))!
    const text = said.slice('The server said: '.length)
    expect(Array.from(text).length).toBe(SERVER_SAID_MAX)
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  it('is only ever the server\'s: not the browser\'s or the app\'s own words, and never throws', () => {
    expect(serverSaidForAdmin(new NetworkError('Failed to fetch'))).toBeNull()
    expect(serverSaidForAdmin(new Error('No file available to play'))).toBeNull()
    const odd = new APIError(500, 'x', null)
    Object.defineProperty(odd, 'message', { value: { not: 'a string' } })
    expect(serverSaidForAdmin(odd)).toBeNull()
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
    expect(serverSaidForAdmin(new APIError(500, '   ', null))).toBeNull()
    expect(serverSaidForAdmin('boom')).toBeNull()
  })

  // Anywhere else it would put the server's words in front of a viewer.
  // A read of the text, not of the imports: a re-export under another name
  // from a file under components/admin, a namespace import read with a built
  // name, or a .js file would get past it.
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

// The tag is put on where fetch itself rejects, and nowhere else.
describe('lib/api: a request that got no answer', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('is a NetworkError (still a TypeError, with fetch\'s message), said as a lost connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const err = await apiFetch('/api/media').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NetworkError)
    expect(err).toBeInstanceOf(TypeError)
    expect((err as Error).message).toBe('Failed to fetch')
    expect(failureWords(err, 'load this page')).toBe('Could not reach the server. Check the connection and try again.')
  })

  it('leaves an abort with a reason of its own as it was', async () => {
    const ac = new AbortController()
    ac.abort('superseded')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { throw init.signal?.reason }))
    const err = await apiFetch('/api/media', { signal: ac.signal }).catch((e: unknown) => e)
    expect(err).toBe('superseded')
    expect(err).not.toBeInstanceOf(NetworkError)
  })

  it('leaves an abort and a timeout as they were', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal('fetch', vi.fn(async () => { throw abort }))
    expect(await apiFetch('/api/media').catch((e: unknown) => e)).toBe(abort)
    const timeout = new DOMException('signal timed out', 'TimeoutError')
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout }))
    expect(await apiFetch('/api/media').catch((e: unknown) => e)).toBe(timeout)
  })

  it('is not what a page read wrongly after an answer came: that is the app\'s own failure', async () => {
    // A proxy's page answered 200: apiFetch hands back its text, and the
    // caller's slip on it is a TypeError that is not a NetworkError.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } })))
    const err = await apiFetch<{ items: unknown[] }>('/api/media').then(r => r.items.map(x => x)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(err).not.toBeInstanceOf(NetworkError)
    expect(failureWords(err, 'load this page')).toBe('Could not load this page just now.')
  })
})
