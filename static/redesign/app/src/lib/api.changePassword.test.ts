// changePassword and the Retry-After an APIError carries.
//
// A 401 from the change-password route is how the server says the CURRENT
// password is wrong. The client's usual answer to a 401 (refresh the session,
// send the request again) would make every wrong try twice: counted twice
// against the route's limit and logged twice as a failed attempt.

import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response
const refused = (status: number, message: string, reason?: string) => res(status, { error: { code: status, message, ...(reason ? { reason } : {}) } })
const paths = () => fetchMock.mock.calls.map(c => String(c[0]))

afterEach(() => {
  fetchMock.mockReset()
  vi.resetModules()
})

describe('changePassword', () => {
  it('sends both passwords once and resolves on success', async () => {
    fetchMock.mockResolvedValue(res(200, { message: 'password updated' }))
    const { changePassword } = await import('./api')
    await expect(changePassword('old secret', 'a longer secret')).resolves.toBeUndefined()
    expect(paths()).toEqual(['/api/auth/change-password'])
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ current_password: 'old secret', new_password: 'a longer secret' })
    expect(init.credentials).toBe('same-origin')
  })

  it('does not refresh the session or try again when the current password is wrong', async () => {
    fetchMock.mockResolvedValue(refused(401, 'current password is incorrect'))
    const { changePassword, APIError, WRONG_CURRENT_PASSWORD } = await import('./api')
    const err = await changePassword('wrong', 'a longer secret').catch(e => e)
    expect(err).toBeInstanceOf(APIError)
    expect(err.status).toBe(401)
    expect(err.message).toBe(WRONG_CURRENT_PASSWORD)
    expect(paths()).toEqual(['/api/auth/change-password'])
  })

  it('refreshes and tries once more for a 401 that is an expired access token', async () => {
    fetchMock
      .mockResolvedValueOnce(refused(401, 'not authenticated'))
      .mockResolvedValueOnce(res(200, { expires_in: 900, user: { id: 1, username: 'test', role: 'user' } }))
      .mockResolvedValueOnce(res(200, { message: 'password updated' }))
    const { changePassword } = await import('./api')
    await expect(changePassword('old secret', 'a longer secret')).resolves.toBeUndefined()
    expect(paths()).toEqual(['/api/auth/change-password', '/api/auth/refresh', '/api/auth/change-password'])
  })

  it('rejects with the server\'s message for anything else, without a retry', async () => {
    fetchMock.mockResolvedValue(refused(400, 'new password must be at least 8 characters'))
    const { changePassword } = await import('./api')
    await expect(changePassword('old secret', 'short')).rejects.toMatchObject({ status: 400, message: 'new password must be at least 8 characters' })
    expect(paths()).toEqual(['/api/auth/change-password'])
  })
})

describe('an APIError', () => {
  it('carries a Retry-After given in seconds, and none for anything else', async () => {
    const { apiFetch } = await import('./api')
    fetchMock.mockResolvedValueOnce(res(429, { error: { code: 429, message: 'too many wrong attempts; try again later', reason: 'profile_pin_locked' } }, { 'Retry-After': '540' }))
    await expect(apiFetch('/api/profiles/2/activate', { method: 'POST' })).rejects.toMatchObject({ status: 429, retryAfterSec: 540 })
    fetchMock.mockResolvedValueOnce(res(429, { error: 'slow down' }, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }))
    await expect(apiFetch('/api/x')).rejects.toMatchObject({ status: 429, retryAfterSec: undefined })
    fetchMock.mockResolvedValueOnce(res(409, { error: 'conflict' }))
    await expect(apiFetch('/api/x')).rejects.toMatchObject({ status: 409, retryAfterSec: undefined })
  })
})

describe('profile calls that carry an option', () => {
  it('creates a profile with a limit in the same request, and without one sends only the name', async () => {
    const { createProfile } = await import('./api')
    fetchMock.mockResolvedValue(res(201, { id: 9 }))
    await createProfile('Robin', { max_age_rating: 'TV-G' })
    await createProfile('Sam')
    expect(fetchMock.mock.calls.map(c => JSON.parse(String((c[1] as RequestInit).body)))).toEqual([{ name: 'Robin', max_age_rating: 'TV-G' }, { name: 'Sam' }])
  })

  it('sends the PIN or password with a re-default only when it is given', async () => {
    const { setDefaultProfile } = await import('./api')
    fetchMock.mockResolvedValue(res(200, {}))
    await setDefaultProfile(3)
    await setDefaultProfile(4, { password: 'hunter22' })
    const [plain, locked] = fetchMock.mock.calls.map(c => c[1] as RequestInit)
    expect(plain.body).toBeUndefined()
    expect(JSON.parse(String(locked.body))).toEqual({ password: 'hunter22' })
    expect(paths()).toEqual(['/api/profiles/3/default', '/api/profiles/4/default'])
  })
})
