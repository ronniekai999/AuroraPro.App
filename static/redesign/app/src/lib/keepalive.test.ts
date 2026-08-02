import { afterEach, describe, expect, it, vi } from 'vitest'

// Guards the keepalive failure semantics behind the "silently dead player"
// bug (2026-08-02 production logs).
//
// keepalive() used to swallow every failure, so a session destroyed by a
// deploy restart left the client pinging a corpse every 10s forever — 370
// pings across 62 minutes in one observed case — while the viewer stared at a
// frozen frame with no error. The distinction that makes recovery possible is
// narrow and easy to regress: 404 means "this session is gone, stop and
// rebuild", everything else means "transient, keep pinging".
//
// Getting it backwards is costly in both directions. Treating a blip as
// 'gone' tears down healthy playback on every flaky network moment; treating
// a 404 as transient restores the original bug.

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

// Vitest's default environment is `node` (no jsdom in devDependencies), and
// the 401-refresh path writes the cached user to localStorage.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

// streaming.ts pulls in hls.js at module scope; stub it so this stays a
// dependency-free unit test of the keepalive contract.
vi.mock('hls.js', () => ({ default: class {} }))

// Minimal Response stand-in. `json` matters for the refresh leg: tryRefresh
// parses the token payload, and a fixture without it fails the refresh for
// the wrong reason.
const res = (status: number, body: unknown = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response

const refreshOK = () =>
  res(200, { expires_in: 900, user: { id: 1, username: 'test', role: 'user' } })

async function keepaliveOnce(sessionId = 'abc123') {
  const { keepalive } = await import('./streaming')
  return keepalive(sessionId)
}

afterEach(() => {
  fetchMock.mockReset()
  vi.resetModules()
})

describe('keepalive', () => {
  it('reports ok on 200', async () => {
    fetchMock.mockResolvedValue(res(200))
    await expect(keepaliveOnce()).resolves.toBe('ok')
  })

  it('reports gone on 404 so the caller stops and rebuilds', async () => {
    fetchMock.mockResolvedValue(res(404))
    await expect(keepaliveOnce()).resolves.toBe('gone')
  })

  it.each([500, 502, 503, 400, 429])(
    'treats %i as transient, not gone',
    async (status) => {
      fetchMock.mockResolvedValue(res(status))
      await expect(keepaliveOnce()).resolves.toBe('error')
    },
  )

  it('treats a network throw as transient — a blip must not kill playback', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(keepaliveOnce()).resolves.toBe('error')
  })

  it('treats an aborted request as transient', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    await expect(keepaliveOnce()).resolves.toBe('error')
  })

  it('POSTs to the session-scoped keepalive path', async () => {
    fetchMock.mockResolvedValue(res(200))
    await keepaliveOnce('deadbeef')
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/stream/sessions/deadbeef/keepalive')
    expect(init.method).toBe('POST')
  })

  // apiFetchResponse transparently refreshes on 401 and replays the request.
  // The keepalive result must reflect the FINAL response, so a post-refresh
  // 404 is still a real "session gone" and a post-refresh 200 is still ok —
  // otherwise an expired access token would masquerade as a dead session and
  // trigger a spurious rebuild.
  it('reports ok when a 401 is resolved by the refresh retry', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401))   // keepalive
      .mockResolvedValueOnce(refreshOK()) // POST /api/auth/refresh
      .mockResolvedValueOnce(res(200))   // replayed keepalive
    await expect(keepaliveOnce()).resolves.toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports gone when the replayed request 404s', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(refreshOK())
      .mockResolvedValueOnce(res(404))
    await expect(keepaliveOnce()).resolves.toBe('gone')
  })

  // A 401 that survives the refresh is an auth problem, not a dead session.
  // Rebuilding would fail identically, so it must not be reported as 'gone'.
  it('does not report gone when auth itself is broken', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401))   // keepalive
      .mockResolvedValueOnce(res(401))   // refresh also fails
    await expect(keepaliveOnce()).resolves.toBe('error')
  })
})
