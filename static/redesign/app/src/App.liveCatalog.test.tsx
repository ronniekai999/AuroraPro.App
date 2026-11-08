// @vitest-environment jsdom
//
// A scan's new titles appear without a reload.
//
// The server sends `library_update` on /ws while a scan adds files and when
// it ends (internal/api/library_updates.go). Every catalog view used to load
// once and keep its data, so new titles showed only after a page reload. The
// whole App renders here against a fetch stub whose catalog the test grows,
// and a fake socket the test speaks for.
//
// What is pinned: an on-screen grid refetches in place and never blanks; an
// off-screen grid waits for its next visit rather than fetching for nobody;
// Home refetches with its personalized rails kept on screen (a background
// refresh used to set the core rails alone and drop every AI rail until its
// fetch came back, which a scan now does every ten seconds), and its library
// count stays up until the new one lands.

import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App'

const NOW = '2026-11-01T00:00:00Z'
const item = (id: number, title: string) => ({
  id, library_id: 1, type: 'movie', title, year: 2020, rating: 7, overview: `${title}.`, added_at: NOW, updated_at: NOW,
})
type Item = ReturnType<typeof item>
const PROFILES = [{ id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }]
const USER = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
const ANCHOR_RAIL = 'Because you watched Something Earlier'

class FakeSocket {
  static opened: FakeSocket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() { FakeSocket.opened.push(this) }
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
}

/** Sends a library_update on every socket the app has open. */
function scanAdded(newItems: number) {
  act(() => {
    for (const s of FakeSocket.opened) {
      s.onmessage?.({ data: JSON.stringify({
        type: 'library_update',
        data: { library_id: 1, library_name: 'Movies', new_items: newItems, action: 'items_added' },
      }) })
    }
  })
}

function stubServer() {
  const catalog: Item[] = [item(1, 'Old Movie')]
  // Each browse-grid request (Home's Top Rated rails ask for 20 a type).
  const gridRequests: string[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    if (p === '/api/media' && url.searchParams.get('per_page') === '100') gridRequests.push(url.search)
    // The personalized rails answer a moment after the core ones, as a
    // vector query does; answered at once they would land in the same render
    // and hide a refresh that took them off the page.
    if (p === '/api/me/anchor-rails') await new Promise(done => setTimeout(done, 150))
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (p === '/api/auth/me') return json(USER)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: USER })
    if (p === '/api/profiles') return json(PROFILES)
    if (p === '/api/profiles/active') return json(PROFILES[0])
    if (p === '/api/me/hero') return json({ picks: [] })
    const newestFirst = [...catalog].reverse()
    if (p === '/api/media/recent') return json({ data: newestFirst })
    if (p === '/api/media') {
      const page = Number(url.searchParams.get('page') ?? 1)
      return json({ data: page === 1 ? newestFirst : [], page, per_page: 100, total_items: catalog.length, total_pages: 1 })
    }
    if (p === '/api/me/anchor-rails') {
      return json({ rails: [{ anchor: { title: 'Something Earlier', type: 'movie' }, items: [item(90, 'Anchored Pick')] }] })
    }
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    return json([])
  })
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  return {
    add(it: Item) { catalog.push(it) },
    gridRequests,
  }
}
let server: ReturnType<typeof stubServer>

/** Samples the page at every commit once `on()` is called. */
function renderApp(path: string) {
  const commits: { text: string }[] = []
  let sampling = false
  const onRender = () => { if (sampling) commits.push({ text: document.body.textContent ?? '' }) }
  render(<Profiler id="app" onRender={onRender}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Profiler>)
  return { commits, on: () => { sampling = true } }
}

function goTo(label: string) {
  const tab = [...document.querySelectorAll('button.stage-tab')].find(b => b.textContent?.startsWith(label))
  if (!tab) throw new Error(`no ${label} tab`)
  fireEvent.click(tab)
}

describe('a scan’s new titles appear without a reload', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('aurora_user', JSON.stringify(USER))
    localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
    FakeSocket.opened = []
    server = stubServer()
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('refreshes the Movies grid on screen in place', async () => {
    const page = renderApp('/movies')
    await screen.findAllByText('Old Movie', undefined, { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    page.on()
    server.add(item(2, 'New Movie'))
    scanAdded(1)
    await screen.findAllByText('New Movie', undefined, { timeout: 5000 })
    // Not vacuous, and never blanked to a skeleton on the way.
    expect(page.commits.length).toBeGreaterThan(0)
    expect(page.commits.filter(c => !c.text.includes('Old Movie'))).toEqual([])
  })

  it('leaves an off-screen grid for its next visit, then refreshes it', async () => {
    renderApp('/movies')
    await screen.findAllByText('Old Movie', undefined, { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    goTo('Home')
    await screen.findByText(ANCHOR_RAIL, undefined, { timeout: 5000 })
    const before = server.gridRequests.length
    server.add(item(2, 'New Movie'))
    scanAdded(1)
    // Home shows it (Recently Added) once the coalesced update lands...
    await screen.findAllByText('New Movie', undefined, { timeout: 5000 })
    // ...and the grid behind it has not been asked for.
    expect(server.gridRequests.length).toBe(before)
    goTo('Movies')
    await waitFor(() => expect(server.gridRequests.length).toBeGreaterThan(before), { timeout: 5000 })
    await waitFor(() => expect(document.querySelector('main')?.textContent).toContain('New Movie'), { timeout: 5000 })
  })

  it('refreshes Home with its personalized rails and library count kept on screen', async () => {
    const page = renderApp('/')
    await screen.findByText(ANCHOR_RAIL, undefined, { timeout: 5000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/\b1 titles in your library/), { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    page.on()
    server.add(item(2, 'New Movie'))
    scanAdded(1)
    await screen.findAllByText('New Movie', undefined, { timeout: 5000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/\b2 titles in your library/), { timeout: 5000 })
    // Let the personalized rails' refetch land too.
    await new Promise(done => setTimeout(done, 300))
    expect(page.commits.length).toBeGreaterThan(0)
    expect(page.commits.filter(c => !c.text.includes(ANCHOR_RAIL))).toEqual([])
    expect(page.commits.filter(c => !/\b[12] titles in your library/.test(c.text))).toEqual([])
  })
})
