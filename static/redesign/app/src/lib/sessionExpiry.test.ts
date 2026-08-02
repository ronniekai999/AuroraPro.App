// @vitest-environment jsdom
//
// jsdom because the expiry signal is a window CustomEvent — the whole point is
// that App can hear it and drop to the auth screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Guards the transient-vs-definitive split behind the 2026-07-24 polling storm.
//
// Nothing ended a session except an explicit logout: clearTokens() was
// reachable only from logout(), and /api/auth/me is validated once at mount.
// So a long-lived tab whose refresh token expired kept rendering as
// logged-in and kept polling with dead credentials — 8,562 requests at
// user_id=0, scan/status ×4,364 and /ws ×1,932, running for hours.
//
// The fix hinges entirely on classifying refresh failures correctly, and it is
// costly in BOTH directions:
//
//   - Too eager (treating a 500 or a network blip as expiry) logs every user
//     out whenever the server hiccups.
//   - Too lax (treating a 401 as transient) restores the original storm.
//
// These tests pin the boundary.

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

const res = (status: number, body: unknown = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response

const tokenBody = { expires_in: 900, user: { id: 1, username: 'test', role: 'user' } }

async function importApi() {
  return import('./api')
}

// Drive a refresh and report whether the session-expired event fired.
async function refreshAndWatch(status: number, opts: { throws?: boolean } = {}) {
  const api = await importApi()
  if (opts.throws) {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
  } else {
    fetchMock.mockResolvedValue(res(status, status === 200 ? tokenBody : {}))
  }

  let fired = false
  const onExpired = () => { fired = true }
  window.addEventListener(api.SESSION_EXPIRED_EVENT, onExpired)

  // Seed a cached user so we can observe it being cleared.
  store.set('aurora_user', JSON.stringify({ id: 1, username: 'test' }))

  const ok = await api.refreshAccessToken()
  window.removeEventListener(api.SESSION_EXPIRED_EVENT, onExpired)
  return { ok, fired, userStillCached: store.has('aurora_user') }
}

beforeEach(() => {
  store.clear()
})

afterEach(() => {
  fetchMock.mockReset()
  vi.resetModules()
})

describe('refresh failure classification', () => {
  it('401 ends the session — the refresh token is gone for good', async () => {
    const r = await refreshAndWatch(401)
    expect(r.ok).toBe(false)
    expect(r.fired).toBe(true)
    expect(r.userStillCached).toBe(false)
  })

  // The server used to answer 400 for a browser refresh with no cookie and no
  // body (734 of them in two weeks). That is fixed server-side, but old
  // servers still answer 400 and it means the same thing: session over.
  it('400 ends the session', async () => {
    const r = await refreshAndWatch(400)
    expect(r.fired).toBe(true)
  })

  it('403 ends the session', async () => {
    const r = await refreshAndWatch(403)
    expect(r.fired).toBe(true)
  })

  it.each([500, 502, 503, 504])(
    '%i does NOT end the session — the server is unwell, not the session',
    async (status) => {
      const r = await refreshAndWatch(status)
      expect(r.ok).toBe(false)
      expect(r.fired).toBe(false)
      expect(r.userStillCached).toBe(true)
    },
  )

  it('429 does NOT end the session — rate limiting is transient', async () => {
    const r = await refreshAndWatch(429)
    expect(r.fired).toBe(false)
    expect(r.userStillCached).toBe(true)
  })

  it('a network throw does NOT end the session', async () => {
    const r = await refreshAndWatch(0, { throws: true })
    expect(r.ok).toBe(false)
    expect(r.fired).toBe(false)
    expect(r.userStillCached).toBe(true)
  })

  it('a successful refresh ends nothing', async () => {
    const r = await refreshAndWatch(200)
    expect(r.ok).toBe(true)
    expect(r.fired).toBe(false)
  })
})

describe('session-expired event', () => {
  it('fires once even when many requests 401 at the same time', async () => {
    const api = await importApi()
    fetchMock.mockResolvedValue(res(401))

    let count = 0
    const onExpired = () => { count++ }
    window.addEventListener(api.SESSION_EXPIRED_EVENT, onExpired)

    // The wave that used to hammer the server: N pollers all 401 at once.
    await Promise.all(Array.from({ length: 8 }, () => api.refreshAccessToken()))

    window.removeEventListener(api.SESSION_EXPIRED_EVENT, onExpired)
    expect(count).toBe(1)
  })

  // register() starts a session just as login() does. Missing the re-arm there
  // left a tab that had already seen one expiry permanently deaf to the next.
  it('re-arms after register() too, not just login()', async () => {
    const api = await importApi()

    fetchMock.mockResolvedValue(res(401))
    let count = 0
    const onExpired = () => { count++ }
    window.addEventListener(api.SESSION_EXPIRED_EVENT, onExpired)

    await api.refreshAccessToken()
    expect(count).toBe(1)

    fetchMock.mockResolvedValue(res(200, tokenBody))
    await api.register({ username: 'u', password: 'p', email: 'u@t.test' } as never)

    fetchMock.mockResolvedValue(res(401))
    await api.refreshAccessToken()

    window.removeEventListener(api.SESSION_EXPIRED_EVENT, onExpired)
    expect(count).toBe(2)
  })

  it('re-arms after a successful login so a SECOND expiry still fires', async () => {
    const api = await importApi()

    fetchMock.mockResolvedValue(res(401))
    let count = 0
    const onExpired = () => { count++ }
    window.addEventListener(api.SESSION_EXPIRED_EVENT, onExpired)

    await api.refreshAccessToken()
    expect(count).toBe(1)

    // Log back in — without re-arming, the latch would swallow every later
    // expiry and put us straight back to polling forever.
    fetchMock.mockResolvedValue(res(200, tokenBody))
    await api.login('u', 'p')

    fetchMock.mockResolvedValue(res(401))
    await api.refreshAccessToken()

    window.removeEventListener(api.SESSION_EXPIRED_EVENT, onExpired)
    expect(count).toBe(2)
  })
})
