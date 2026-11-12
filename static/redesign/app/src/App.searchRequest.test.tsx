// @vitest-environment jsdom
//
// Requesting, against the whole App: it has no tab, and is where a search
// that finds nothing in the library ends. The search page offers it, and the
// requests page opens with its composer up and the words already looked up.
// A profile with a content limit is offered no requests anywhere, here
// included.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App'

vi.mock('@/components/VideoPlayer', async (original) => ({
  ...(await original<typeof import('@/components/VideoPlayer')>()),
  VideoPlayer: () => null,
}))

const NOW = '2026-10-01T00:00:00Z'
const PARENT = { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }
const KID = { id: 2, user_id: 1, name: 'Kid', is_default: false, created_at: NOW, updated_at: NOW, max_age_rating: 'PG' }

function renderApp(bound = 1) {
  const me = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
  /** What the requests page looked up on TMDB. */
  const lookups: string[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    if (p === '/api/auth/me') return json(me)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: me })
    if (p === '/api/profiles') return json([PARENT, KID])
    if (p === '/api/profiles/active') return json(bound === 1 ? PARENT : KID)
    if (p === '/api/me/hero') return json({ picks: [], slate_token: 's' })
    if (p === '/api/media/recent') return json({ data: [] })
    if (p === '/api/media') return json({ data: [], page: 1, per_page: 30, total_items: 0, total_pages: 1 })
    // Nothing in the library matches anything.
    if (p === '/api/media/search') return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'X-Search-Mode': 'literal' } })
    if (p === '/api/requests/search') { lookups.push(url.searchParams.get('q') ?? ''); return json({ results: [] }) }
    if (p === '/api/requests') return json([])
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    if (p === '/api/parties/active') return json({ parties: [] })
    return json([])
  })
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify(me))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
  if (bound !== 1) localStorage.setItem('aurora_active_profile_id', String(bound))
  render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
  return { lookups }
}

const find = { timeout: 8000 }
async function searchFor(words: string) {
  const field = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('.stage-navsearch input')
    if (!el) throw new Error('no search field yet')
    return el
  }, find)
  fireEvent.change(field, { target: { value: words } })
  await screen.findByRole('heading', { name: `No title matches “${words}”` }, find)
}

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a search that finds nothing in the library', () => {
  it('ends in a request: the requests page opens with its composer up and the words looked up', async () => {
    const server = renderApp()
    await screen.findByText('Parent', undefined, find)
    await searchFor('the lost reel')
    fireEvent.click(screen.getByRole('button', { name: 'Request it' }))
    const field = await screen.findByPlaceholderText('Search TMDB for title…', undefined, find) as HTMLInputElement
    expect(field.value).toBe('the lost reel')
    await waitFor(() => expect(server.lookups).toEqual(['the lost reel']), find)
    expect(await screen.findByRole('heading', { level: 1, name: 'My requests' }, find)).toBeInTheDocument()
  })

  it('offers no request to a profile with a content limit', async () => {
    renderApp(2)
    await screen.findByText('Kid', undefined, find)
    await searchFor('the lost reel')
    expect(screen.queryByRole('button', { name: 'Request it' })).toBeNull()
    expect(document.querySelector('[data-search-request]')).toBeNull()
  })
})
