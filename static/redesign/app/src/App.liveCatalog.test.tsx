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
// Home refetches only its catalog rails and library count, under the
// personalized rails already on screen, and its count stays up until the new
// one lands. The hero, Continue Watching and the personalized rails are not
// asked for again: running the whole Home load per update reset the hero
// carousel to its first pick every ten seconds of an import.

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

function stubServer({ empty = false } = {}) {
  const catalog: Item[] = empty ? [] : [item(1, 'Old Movie')]
  // Each browse-grid request (Home's Top Rated rails ask for 20 a type).
  const gridRequests: string[] = []
  // Requests per path.
  const asked: Record<string, number> = {}
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    asked[p] = (asked[p] ?? 0) + 1
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
    if (p === '/api/me/hero') {
      if (empty) return json({ picks: [] })
      return json({ picks: [item(80, 'Hero One'), item(81, 'Hero Two')].map(it => ({ item: it, reason: 'Picked for you' })), slate_token: 'slate' })
    }
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
    asked,
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
    // No jitter: an update's refresh comes after the 1.5 s delay alone.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    server = stubServer()
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

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

  it('gives an empty library its first hero when a scan adds titles', async () => {
    vi.unstubAllGlobals()
    server = stubServer({ empty: true })
    renderApp('/')
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0), { timeout: 5000 })
    await screen.findByText(ANCHOR_RAIL, undefined, { timeout: 5000 })
    expect(screen.queryByLabelText('More info about First Import')).toBeNull()
    server.add(item(5, 'First Import'))
    scanAdded(1)
    await screen.findByLabelText('More info about First Import', undefined, { timeout: 5000 })
  })

  it('refreshes Home with its personalized rails and library count kept on screen', async () => {
    const page = renderApp('/')
    await screen.findByText(ANCHOR_RAIL, undefined, { timeout: 5000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/\b1 titles in your library/), { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    // Everything Home's startup asked for has landed.
    await new Promise(done => setTimeout(done, 300))
    const before = { ...server.asked }
    page.on()
    server.add(item(2, 'New Movie'))
    scanAdded(1)
    await screen.findAllByText('New Movie', undefined, { timeout: 5000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/\b2 titles in your library/), { timeout: 5000 })
    await new Promise(done => setTimeout(done, 300))
    // Only the catalog rails and the count were asked for again.
    for (const p of ['/api/me/hero', '/api/progress/continue', '/api/me/anchor-rails', '/api/me/discover']) {
      expect([p, server.asked[p] ?? 0]).toEqual([p, before[p] ?? 0])
    }
    expect(server.asked['/api/media/recent']).toBe((before['/api/media/recent'] ?? 0) + 1)
    expect(page.commits.length).toBeGreaterThan(0)
    expect(page.commits.filter(c => !c.text.includes(ANCHOR_RAIL))).toEqual([])
    expect(page.commits.filter(c => !/\b[12] titles in your library/.test(c.text))).toEqual([])
  })
})

// Two profiles, Parent bound at first and Kid restricted. Every answer is for
// the profile bound when it was asked, from the catalog as it was then.
const PROFILES2 = [
  { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW },
  { id: 2, user_id: 1, name: 'Kid', is_default: false, created_at: NOW, updated_at: NOW, max_age_rating: 'PG' },
]

function stubTwoProfiles() {
  let bound = 1
  const sees: Record<number, Item[]> = { 1: [item(1, 'Parentonly Old')], 2: [item(2, 'Kidonly Old')] }
  const holds: { match: (u: URL, bound: number) => boolean; gate: Promise<void>; captured: number; every: boolean }[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    const asked = bound
    // Answered from the catalog as it was when asked, as a query is.
    const list = [...sees[asked]].reverse()
    const hold = holds.find(h => (h.every || h.captured === 0) && h.match(url, asked))
    if (hold) { hold.captured++; await hold.gate }
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (p === '/api/auth/me') return json(USER)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: USER })
    if (p === '/api/profiles') return json(PROFILES2)
    if (p === '/api/profiles/active') return json(PROFILES2.find(x => x.id === bound))
    const activate = p.match(/^\/api\/profiles\/(\d+)\/activate$/)
    if (activate && init?.method === 'POST') { bound = Number(activate[1]); return new Response(null, { status: 204 }) }
    if (p === '/api/me/hero') return json({ picks: [] })
    if (p === '/api/media/recent') return json({ data: list })
    if (p === '/api/media') {
      const page = Number(url.searchParams.get('page') ?? 1)
      return json({ data: page === 1 ? list : [], page, per_page: 100, total_items: list.length, total_pages: 1 })
    }
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    return json([])
  })
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  return {
    addForParent(it: Item) { sees[1].push(it) },
    /** Holds the next request `match` accepts (with `every`, each one until
     *  released); returns the release and whether one was sent. */
    hold(match: (u: URL, bound: number) => boolean, { every = false } = {}) {
      let release!: () => void
      const h = { match, gate: new Promise<void>(done => { release = done }), captured: 0, every }
      holds.push(h)
      return { release, sent: () => h.captured > 0 }
    },
  }
}


// A live refresh still out when the profile switches must not land the
// previous profile's titles under the new profile's name. Each answer here is
// the one the server gave for the profile bound when it was asked, held until
// the switch is done. What holds it off is a combination: the refresh's abort
// on an owner change, its stand-down on a switch's first commit
// (profileSwitchPending) and, on Home, the owner check when it lands; this
// fails only when none of them does.
describe('a live refresh out during a profile switch', () => {
  const label = () => document.querySelector('button[title^="Switch profile"] span.truncate')?.textContent ?? null
  function renderSampled(path: string) {
    const commits: { label: string | null; parent: boolean }[] = []
    const onRender = () => commits.push({ label: label(), parent: (document.body.textContent ?? '').includes('Parentonly') })
    render(<Profiler id="app" onRender={onRender}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Profiler>)
    return commits
  }
  function switchToKid() {
    fireEvent.click(document.querySelector('button[title^="Switch profile"]')!)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Kid/ }))
  }

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('aurora_user', JSON.stringify(USER))
    localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
    FakeSocket.opened = []
    // No jitter: an update's refresh comes after the 1.5 s delay alone.
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('on Home, before the new profile’s rails have landed', async () => {
    // The previous profile's refresh answers while the new profile's first
    // load is still out. Its abort is one guard; the rails' owner, cleared on
    // the switch, is the other, and this holds with either alone.
    const server = stubTwoProfiles()
    const commits = renderSampled('/')
    await screen.findAllByText('Parentonly Old', undefined, { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    const held = server.hold((u, b) => b === 1 && u.pathname === '/api/media/recent')
    const kidLoad = server.hold((u, b) => b === 2 && u.pathname === '/api/media/recent', { every: true })
    server.addForParent(item(3, 'Parentonly New'))
    scanAdded(1)
    await waitFor(() => expect(held.sent()).toBe(true), { timeout: 5000 })
    switchToKid()
    await waitFor(() => expect(label()).toBe('Kid'), { timeout: 5000 })
    await waitFor(() => expect(kidLoad.sent()).toBe(true), { timeout: 5000 })
    held.release()
    await new Promise(done => setTimeout(done, 200))
    kidLoad.release()
    await screen.findAllByText('Kidonly Old', undefined, { timeout: 5000 })
    await new Promise(done => setTimeout(done, 200))
    expect(screen.queryAllByText('Parentonly New')).toEqual([])
    expect(commits.filter(c => c.label === 'Kid' && c.parent)).toEqual([])
  })

  it.each([
    ['the Movies grid', '/movies', (u: URL, b: number) => b === 1 && u.pathname === '/api/media' && u.searchParams.get('per_page') === '100'],
    ['Home', '/', (u: URL, b: number) => b === 1 && u.pathname === '/api/media/recent'],
  ])('on %s', async (_name, path, match) => {
    const server = stubTwoProfiles()
    const commits = renderSampled(path)
    await screen.findAllByText('Parentonly Old', undefined, { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    const held = server.hold(match)
    server.addForParent(item(3, 'Parentonly New'))
    scanAdded(1)
    await waitFor(() => expect(held.sent()).toBe(true), { timeout: 5000 })
    switchToKid()
    await screen.findAllByText('Kidonly Old', undefined, { timeout: 5000 })
    held.release()
    await new Promise(done => setTimeout(done, 200))
    expect(screen.queryAllByText('Parentonly New')).toEqual([])
    expect(commits.filter(c => c.label === 'Kid').length).toBeGreaterThan(0)
    expect(commits.filter(c => c.label === 'Kid' && c.parent)).toEqual([])
  })
})

describe('an update while Home is still loading', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('aurora_user', JSON.stringify(USER))
    localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
    FakeSocket.opened = []
    // No jitter: an update's refresh comes after the 1.5 s delay alone.
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('is caught up once the load lands, not dropped', async () => {
    // A cold load whose queries ran before the scan wrote, answering after
    // the update: its rails are behind, and the live refresh must follow.
    const server = stubTwoProfiles()
    // Every startup load (the profile becoming known re-runs it) is held.
    const first = server.hold((u, b) => b === 1 && u.pathname === '/api/media/recent', { every: true })
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
    await waitFor(() => expect(first.sent()).toBe(true), { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    // Let the startup loads all be asked before the scan writes.
    await new Promise(done => setTimeout(done, 300))
    server.addForParent(item(3, 'Parentonly New'))
    scanAdded(1)
    await new Promise(done => setTimeout(done, 2000))
    first.release()
    await screen.findAllByText('Parentonly Old', undefined, { timeout: 5000 })
    await screen.findAllByText('Parentonly New', undefined, { timeout: 5000 })
  })
})

// A full Home load (the staleness gate) and the live catalog refresh can be
// out at once and land in either order. Home must end on the newest catalog
// and the newest count either way.
describe('a full Home load and a live refresh overlapping', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('aurora_user', JSON.stringify(USER))
    localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
    FakeSocket.opened = []
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  /** Moves the clock the staleness gate reads past its 30 s window. */
  function staleClock() {
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31_000)
  }
  const main = () => document.querySelector('main')?.textContent ?? ''

  it('updates the greeting count when the full load lands before the live refresh', async () => {
    // Returning to Home after a scan runs both at the same version; the count
    // comes only with the live refresh, which must not be dropped for it.
    const server = stubTwoProfiles()
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
    await screen.findAllByText('Parentonly Old', undefined, { timeout: 5000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/\b1 titles in your library/), { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    await new Promise(done => setTimeout(done, 300))
    goTo('Movies')
    await waitFor(() => expect(main()).toContain('Parentonly Old'), { timeout: 5000 })
    server.addForParent(item(3, 'Parentonly New'))
    scanAdded(1)
    await waitFor(() => expect(main()).toContain('Parentonly New'), { timeout: 5000 })
    const count = server.hold((u, b) => b === 1 && u.pathname === '/api/media' && u.searchParams.get('per_page') === '1')
    staleClock()
    goTo('Home')
    await waitFor(() => expect(count.sent()).toBe(true), { timeout: 5000 })
    await waitFor(() => expect(main()).toContain('Parentonly New'), { timeout: 5000 })
    await new Promise(done => setTimeout(done, 300))
    count.release()
    await waitFor(() => expect(document.body.textContent).toMatch(/\b2 titles in your library/), { timeout: 5000 })
  })

  it('lands a newer live refresh that was out when an older full load landed', async () => {
    const server = stubTwoProfiles()
    const page = renderApp('/')
    await screen.findAllByText('Parentonly Old', undefined, { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    await new Promise(done => setTimeout(done, 500))
    const fullLoad = server.hold((u, b) => b === 1 && u.pathname === '/api/media' &&
      u.searchParams.get('type') === 'show' && u.searchParams.get('per_page') === '20')
    staleClock()
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(fullLoad.sent()).toBe(true), { timeout: 5000 })
    server.addForParent(item(3, 'Alpha New'))
    scanAdded(1)
    await waitFor(() => expect(main()).toContain('Alpha New'), { timeout: 5000 })
    // From here the older full load must never put its rails, which lack
    // Alpha, back over the newer ones.
    page.on()
    const second = server.hold((u, b) => b === 1 && u.pathname === '/api/media/recent')
    server.addForParent(item(4, 'Bravo New'))
    scanAdded(2)
    await waitFor(() => expect(second.sent()).toBe(true), { timeout: 15000 })
    fullLoad.release()
    await new Promise(done => setTimeout(done, 300))
    second.release()
    await waitFor(() => expect(main()).toContain('Bravo New'), { timeout: 5000 })
    expect(page.commits.length).toBeGreaterThan(0)
    expect(page.commits.filter(c => !c.text.includes('Alpha New'))).toEqual([])
  }, 30000)

  it('does not land a refresh started before a full load that landed first', async () => {
    // Same version, different moments: the full load asked later and saw a
    // title written after the refresh asked (one not announced yet). The
    // refresh's rails, landing last, must not take it away.
    const server = stubTwoProfiles()
    const page = renderApp('/')
    await screen.findAllByText('Parentonly Old', undefined, { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    await new Promise(done => setTimeout(done, 500))
    const r = server.hold((u, b) => b === 1 && u.pathname === '/api/media/recent')
    server.addForParent(item(3, 'Alpha New'))
    scanAdded(1)
    await waitFor(() => expect(r.sent()).toBe(true), { timeout: 5000 })
    server.addForParent(item(4, 'Unannounced New'))
    staleClock()
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(main()).toContain('Unannounced New'), { timeout: 5000 })
    await new Promise(done => setTimeout(done, 300))
    // Counted, not just found: the catalog-fallback hero also shows the
    // newest title, so presence alone survives the rails losing it.
    const copies = (text: string) => text.split('Unannounced New').length - 1
    const before = copies(document.body.textContent ?? '')
    expect(before).toBeGreaterThan(1)
    page.on()
    r.release()
    await new Promise(done => setTimeout(done, 500))
    expect(page.commits.length).toBeGreaterThan(0)
    expect(page.commits.filter(c => copies(c.text) < before)).toEqual([])
  })

  it('brings the count up to date when the refresh that carried it was dropped', async () => {
    // R (v1) is out; v2 arrives; a full load at v2 lands first; R's rails are
    // dropped. The count comes only from a live refresh, so it must ask again.
    const server = stubTwoProfiles()
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
    await screen.findAllByText('Parentonly Old', undefined, { timeout: 5000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/\b1 titles in your library/), { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    await new Promise(done => setTimeout(done, 500))
    const r = server.hold((u, b) => b === 1 && u.pathname === '/api/media/recent')
    server.addForParent(item(3, 'Alpha New'))
    scanAdded(1)
    await waitFor(() => expect(r.sent()).toBe(true), { timeout: 5000 })
    server.addForParent(item(4, 'Bravo New'))
    scanAdded(2)
    // The second update waits out the scheduler's 10 s gap.
    await new Promise(done => setTimeout(done, 11_000))
    staleClock()
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(main()).toContain('Bravo New'), { timeout: 5000 })
    r.release()
    await waitFor(() => expect(document.body.textContent).toMatch(/\b3 titles in your library/), { timeout: 5000 })
  }, 30000)

  it('runs again when a live refresh lands older than a full load and is dropped', async () => {
    // R (v1) is out; the next update (v2) waits on it; a full load starts at
    // v2; a third update (v3) arrives; the full load lands at v2, then R lands
    // older than it and is dropped. Nothing else changes, so without the
    // retry Home stays at v2 and never shows the third title.
    const server = stubTwoProfiles()
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
    await screen.findAllByText('Parentonly Old', undefined, { timeout: 5000 })
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0))
    await new Promise(done => setTimeout(done, 500))
    const r = server.hold((u, b) => b === 1 && u.pathname === '/api/media/recent')
    server.addForParent(item(3, 'Alpha New'))
    scanAdded(1)
    await waitFor(() => expect(r.sent()).toBe(true), { timeout: 5000 })
    server.addForParent(item(4, 'Bravo New'))
    scanAdded(2)
    // The second update's refresh waits out the scheduler's 10 s gap.
    await new Promise(done => setTimeout(done, 11_000))
    const fullLoad = server.hold((u, b) => b === 1 && u.pathname === '/api/media' &&
      u.searchParams.get('type') === 'show' && u.searchParams.get('per_page') === '20')
    staleClock()
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(fullLoad.sent()).toBe(true), { timeout: 5000 })
    // staleClock's jump also clears the scheduler's 10 s gap (it reads the
    // same clock), so this third update flushes after the 1.5 s delay alone.
    server.addForParent(item(5, 'Charlie New'))
    scanAdded(3)
    await new Promise(done => setTimeout(done, 2500))
    fullLoad.release()
    await waitFor(() => expect(main()).toContain('Bravo New'), { timeout: 5000 })
    await new Promise(done => setTimeout(done, 300))
    r.release()
    await waitFor(() => expect(main()).toContain('Charlie New'), { timeout: 5000 })
  }, 40000)
})
