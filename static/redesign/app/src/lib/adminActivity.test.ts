// Regression tests for the admin Activity tab rendering "No recent activity."
// while the server was returning rows.
//
// GET /api/admin/activity used to answer with a hand-rolled `{items, total}`
// envelope; listAdminActivity only unwrapped `.data` and fell through to its
// `|| []` fallback, so every entry was discarded in the browser. The server now
// emits the canonical `.data` envelope — these pin the unwrap against both
// shapes so a bundle running ahead of (or behind) the binary still renders
// rows instead of silently blanking the tab.

import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

const jsonResponse = (body: unknown): Response => ({
  ok: true,
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
  text: async () => JSON.stringify(body),
}) as unknown as Response

const entry = (id: number, event_type: string) => ({
  id, event_type, created_at: '2026-08-10T00:00:00Z',
})

afterEach(() => {
  fetchMock.mockReset()
  vi.resetModules()
})

describe('listAdminActivity', () => {
  it('unwraps the canonical paginated `data` envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: [entry(2, 'user_login'), entry(1, 'scan_completed')],
      page: 1, per_page: 50, total_items: 2, total_pages: 1,
    }))
    const { listAdminActivity } = await import('./api')

    const rows = await listAdminActivity()
    expect(rows.map(r => r.event_type)).toEqual(['user_login', 'scan_completed'])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/activity?per_page=50')
  })

  it('still unwraps a legacy `items` envelope', async () => {
    // The exact body the server used to send. Before the fix this resolved to
    // [] and the tab claimed there was no activity.
    fetchMock.mockResolvedValue(jsonResponse({
      items: [entry(1, 'user_login')],
      page: 1, per_page: 50, total: 1, total_pages: 1,
    }))
    const { listAdminActivity } = await import('./api')

    expect(await listAdminActivity()).toHaveLength(1)
  })

  it('accepts a bare array', async () => {
    fetchMock.mockResolvedValue(jsonResponse([entry(1, 'user_logout')]))
    const { listAdminActivity } = await import('./api')

    expect(await listAdminActivity()).toHaveLength(1)
  })

  it('returns [] for a genuinely empty log and for an unrecognised shape', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: [], page: 1, per_page: 50, total_items: 0, total_pages: 0,
    }))
    const { listAdminActivity } = await import('./api')
    expect(await listAdminActivity()).toEqual([])

    fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }))
    expect(await listAdminActivity()).toEqual([])

    // Envelope present but the payload isn't an array — the pre-fix unwrap
    // returned these straight through to `activity.map(…)` in AdminView.
    fetchMock.mockResolvedValue(jsonResponse({ data: null }))
    expect(await listAdminActivity()).toEqual([])
    fetchMock.mockResolvedValue(jsonResponse({ data: { nope: 1 } }))
    expect(await listAdminActivity()).toEqual([])
  })

  // apiFetch returns a STRING for any non-JSON 200 and null when JSON parsing
  // fails, so the unwrap must not reach an `in` check on a primitive. A proxy
  // with a lapsed SSO session serving an HTML login page is the realistic
  // trigger; it must degrade to the empty state, not a TypeError banner.
  it('returns [] for non-object bodies instead of throwing', async () => {
    const { listAdminActivity } = await import('./api')

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => { throw new Error('not json') },
      text: async () => '<!doctype html><title>Sign in</title>',
    } as unknown as Response)
    await expect(listAdminActivity()).resolves.toEqual([])

    // Content-typed JSON that fails to parse → apiFetch yields null.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => { throw new Error('bad json') },
      text: async () => 'oops',
    } as unknown as Response)
    await expect(listAdminActivity()).resolves.toEqual([])
  })

  it('passes the requested page size through', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: [], page: 1, per_page: 10, total_items: 0, total_pages: 0,
    }))
    const { listAdminActivity } = await import('./api')

    await listAdminActivity(10)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/activity?per_page=10')
  })
})
