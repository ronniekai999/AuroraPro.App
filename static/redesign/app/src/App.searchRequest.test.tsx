// @vitest-environment jsdom
//
// Requesting, against the whole App: it has no tab, and is where a search
// that finds nothing in the library ends. The search page lists the titles
// that can be asked for and takes the request there; the requests page then
// has it. A profile with a content limit is offered no requests anywhere,
// here included.

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
const HARBOR = { id: 77, library_id: 1, type: 'movie', title: 'Harbor Lights', year: 2022, rating: 8, overview: 'A harbor.', added_at: NOW, updated_at: NOW }

/** `bindingUnreadable`: the server cannot say which profile the session acts
 *  as, so the app knows none (it opens the profile picker over the page). */
function renderApp(bound = 1, keep = false, { bindingUnreadable = false, noProfiles = false } = {}) {
  const me = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
  /** What was looked up outside the library (the server asks TMDB). */
  const lookups: string[] = []
  /** The requests made, as the server was sent them, and as it lists them. */
  const posted: Record<string, unknown>[] = []
  const listed: Record<string, unknown>[] = []
  /** How many times the list of collections was asked for. */
  const collectionLists = { n: 0 }
  const heroAsks = { n: 0 }
  const TOWNS = { id: 5, owner_user_id: 1, name: 'Harbor towns', kind: 'manual', is_public: false, item_count: 1, created_at: NOW, updated_at: NOW }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    if (p === '/api/auth/me') return json(me)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: me })
    // `noProfiles`: an account that has made none (the server acts as a stand-in).
    if (p === '/api/profiles') return json(noProfiles ? [] : [PARENT, KID])
    if (p === '/api/profiles/active' && noProfiles) return json({ error: 'no profile' }, 404)
    if (p === '/api/profiles/active') return bindingUnreadable ? json({ error: 'unavailable' }, 503) : json(bound === 1 ? PARENT : KID)
    // Asked for only once the app knows who it is showing Tonight to.
    if (p === '/api/me/hero') { heroAsks.n++; return json({ picks: [], slate_token: 's' }) }
    if (p === '/api/media/recent') return json({ data: [] })
    if (p === '/api/media') return json({ data: [], page: 1, per_page: 30, total_items: 0, total_pages: 1 })
    // Nothing in the library matches anything, but "harbor".
    if (p === '/api/media/search') {
      const found = (url.searchParams.get('q') ?? '').toLowerCase().includes('harbor') ? [HARBOR] : []
      return new Response(JSON.stringify(found), { status: 200, headers: { 'content-type': 'application/json', 'X-Search-Mode': 'literal' } })
    }
    if (p === `/api/media/${HARBOR.id}`) return json(HARBOR)
    if (p === '/api/requests/config') return json({ enabled: true, has_radarr: true, has_sonarr: true })
    if (p === '/api/requests/search') {
      lookups.push(url.searchParams.get('q') ?? '')
      return json({ results: [{ id: 501, media_type: 'movie', title: 'The Lost Reel', release_date: '2025-03-01', overview: 'A reel goes missing.' }] })
    }
    if (p === '/api/requests' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posted.push(body)
      const made = { id: 31, user_id: 1, ...body, status: 'pending', requested_at: NOW, updated_at: NOW }
      listed.unshift(made)
      return json(made, 201)
    }
    if (p === '/api/requests') return json(listed)
    if (p === '/api/collections') { collectionLists.n++; return json([TOWNS]) }
    if (p === '/api/collections/5') return json({ collection: TOWNS, items: [HARBOR] })
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    if (p === '/api/parties/active') return json({ parties: [] })
    return json([])
  })
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  if (!keep) localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify(me))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
  if (bound !== 1) localStorage.setItem('aurora_active_profile_id', String(bound))
  else localStorage.removeItem('aurora_active_profile_id')
  render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
  return { lookups, collectionLists, heroAsks, posted }
}

const find = { timeout: 8000 }
async function searchFor(words: string) {
  const field = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>('.stage-navsearch input')
    if (!el) throw new Error('no search field yet')
    return el
  }, find)
  fireEvent.change(field, { target: { value: words } })
  await screen.findByRole('heading', { name: 'Not in your library yet' }, find)
  expect(document.querySelector('.search-none-lead')!.textContent).toContain(`Nothing here matches “${words}”.`)
}

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a search that finds nothing in the library', () => {
  it('ends in a request, made on the search page: the title is looked up, asked for where it stands, and is then on the requests page', async () => {
    const server = renderApp()
    await screen.findByText('Parent', undefined, find)
    await searchFor('the lost reel')
    // Looked up outside the library, once, for the words searched for.
    const ask = await screen.findByRole('button', { name: 'Request The Lost Reel (2025)' }, find)
    expect(server.lookups).toEqual(['the lost reel'])
    fireEvent.click(ask)
    await waitFor(() => expect(server.posted).toHaveLength(1), find)
    expect(server.posted[0]).toMatchObject({ media_type: 'movie', tmdb_id: 501, title: 'The Lost Reel', year: 2025, quality_1080p: true, quality_4k: false })
    // The row says what became of it, and the app says so too.
    await waitFor(() => expect(document.querySelector('.search-req-state')?.textContent).toBe('Requested · sent, nothing found yet'), find)
    expect(await screen.findByText('Requested "The Lost Reel"', undefined, find)).toBeInTheDocument()
    // The way on is the requests page, which has it.
    fireEvent.click(screen.getByRole('button', { name: 'See my requests' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'My requests' }, find)).toBeInTheDocument()
    expect(await screen.findByText('The Lost Reel', undefined, find)).toBeInTheDocument()
  })

  it('offers no request to a profile with a content limit', async () => {
    const server = renderApp(2)
    await screen.findByText('Kid', undefined, find)
    await searchFor('the lost reel')
    await new Promise(done => setTimeout(done, 900))
    expect(document.querySelector('[data-search-request]')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Request / })).toBeNull()
    // Nothing was looked up on its behalf, and the page does not speak of requesting.
    expect(server.lookups).toEqual([])
    expect(document.querySelector('[data-search-empty]')!.textContent).not.toMatch(/request/i)
  })
})

// While the app does not know which profile the session acts as, it is
// offered nothing a profile with a content limit lacks: the session may be a
// child's. Requests are one of those things.
describe('a search that finds nothing, while the session\'s profile is not known', () => {
  it('offers no request, and looks nothing up outside the library', async () => {
    const server = renderApp(1, false, { bindingUnreadable: true })
    // The picker is up (the binding could not be read); the page is behind it.
    await screen.findByRole('heading', { name: /Who.s watching/ }, find)
    const field = await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('.stage-navsearch input')
      if (!el) throw new Error('no search field yet')
      return el
    }, find)
    fireEvent.change(field, { target: { value: 'the lost reel' } })
    await waitFor(() => expect(document.querySelector('[data-search-empty]')).not.toBeNull(), find)
    await new Promise(done => setTimeout(done, 900))
    expect(document.querySelector('[data-search-request]')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Request / })).toBeNull()
    expect(server.lookups).toEqual([])
    expect(document.querySelector('[data-search-empty]')!.textContent).not.toMatch(/request/i)
  })
})

// What a profile searched for is offered to it again, in this browser, and
// to no other profile.
describe('recent searches', () => {
  const field = () => document.querySelector<HTMLInputElement>('.stage-navsearch input')!
  const recent = () => [...document.querySelectorAll('[data-search-recent] li button')].map(b => b.textContent)
  async function typeInBar(words: string) {
    await waitFor(() => expect(field()).not.toBeNull(), find)
    fireEvent.change(field(), { target: { value: words } })
  }

  it('remembers a search once a result is opened, not while it is typed, and offers it again', async () => {
    renderApp()
    await screen.findByText('Parent', undefined, find)
    await typeInBar('harbor')
    const card = await screen.findByRole('button', { name: /^Harbor Lights/ }, find)
    // Typed and answered, and nothing done with it yet: not remembered.
    expect(JSON.parse(localStorage.getItem('aurora_recent_searches:1:1') ?? '[]')).toEqual([])
    fireEvent.click(card)
    await waitFor(() => expect(JSON.parse(localStorage.getItem('aurora_recent_searches:1:1') ?? '[]')).toEqual(['harbor']), find)
  })

  it('lists them on the search page while nothing is typed, and picking one searches for it', async () => {
    localStorage.clear()
    localStorage.setItem('aurora_recent_searches:1:1', JSON.stringify(['harbor', 'night train']))
    renderApp(1, true)
    await screen.findByText('Parent', undefined, find)
    await typeInBar('x')
    await typeInBar('')
    // Clearing the bar's field leaves the search page; the phone's tab is the way to it with nothing typed.
    fireEvent.click(document.querySelector('nav.stage-tabbar [data-nav="search"]')!)
    await waitFor(() => expect(recent()).toEqual(['harbor', 'night train']), find)
    fireEvent.click(screen.getByRole('button', { name: 'harbor' }))
    expect(await screen.findByRole('button', { name: /^Harbor Lights/ }, find)).toBeInTheDocument()
  })

  it('shows one profile nothing of what another searched for', async () => {
    localStorage.clear()
    localStorage.setItem('aurora_recent_searches:1:1', JSON.stringify(['grown-up thriller']))
    localStorage.setItem('aurora_recent_searches:1:2', JSON.stringify(['dinosaurs']))
    renderApp(2, true)
    await screen.findByText('Kid', undefined, find)
    fireEvent.click(document.querySelector('nav.stage-tabbar [data-nav="search"]')!)
    await waitFor(() => expect(recent()).toEqual(['dinosaurs']), find)
    expect(document.body.textContent).not.toContain('grown-up thriller')
  })

  it('forgets them when asked, for that profile alone', async () => {
    localStorage.clear()
    localStorage.setItem('aurora_recent_searches:1:1', JSON.stringify(['harbor']))
    localStorage.setItem('aurora_recent_searches:1:2', JSON.stringify(['dinosaurs']))
    renderApp(1, true)
    await screen.findByText('Parent', undefined, find)
    fireEvent.click(document.querySelector('nav.stage-tabbar [data-nav="search"]')!)
    await waitFor(() => expect(recent()).toEqual(['harbor']), find)
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(document.querySelector('[data-search-recent]')).toBeNull())
    expect(localStorage.getItem('aurora_recent_searches:1:1')).toBeNull()
    expect(JSON.parse(localStorage.getItem('aurora_recent_searches:1:2')!)).toEqual(['dinosaurs'])
  })
})

// How long they are kept: until that profile clears them, or the account
// signs out of this browser. And never in the one bucket every profile of an
// account would share while the app does not know which of them it is.
describe('recent searches, signing out, and a session whose profile is not known', () => {
  const field = () => document.querySelector<HTMLInputElement>('.stage-navsearch input')!

  it('forgets every profile\'s searches for the account on an explicit sign-out, and no other account\'s', async () => {
    localStorage.clear()
    localStorage.setItem('aurora_recent_searches:1:1', JSON.stringify(['harbor']))
    localStorage.setItem('aurora_recent_searches:1:2', JSON.stringify(['dinosaurs']))
    localStorage.setItem('aurora_recent_searches:2:1', JSON.stringify(['someone else']))
    renderApp(1, true)
    await screen.findByText('Parent', undefined, find)
    fireEvent.click(document.querySelector<HTMLElement>('[data-identity-trigger]')!)
    fireEvent.click(await screen.findByRole('button', { name: /Sign out/ }, find))
    await waitFor(() => expect(localStorage.getItem('aurora_recent_searches:1:1')).toBeNull(), find)
    expect(localStorage.getItem('aurora_recent_searches:1:2')).toBeNull()
    expect(JSON.parse(localStorage.getItem('aurora_recent_searches:2:1')!)).toEqual(['someone else'])
  })

  // An account with no profile at all has no one to keep them apart from:
  // its searches are its own.
  it('remembers for an account that has no profile', async () => {
    localStorage.clear()
    const server = renderApp(1, true, { noProfiles: true })
    // Until the list of profiles is in, the app does not know the account has none.
    await waitFor(() => expect(server.heroAsks.n).toBeGreaterThan(0), find)
    await waitFor(() => expect(field()).not.toBeNull(), find)
    fireEvent.change(field(), { target: { value: 'harbor' } })
    fireEvent.click(await screen.findByRole('button', { name: /^Harbor Lights/ }, find))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('aurora_recent_searches:1:none') ?? '[]')).toEqual(['harbor']), find)
  })

  it('neither shows nor adds to the account\'s no-profile bucket while a profile exists and is not known', async () => {
    localStorage.clear()
    localStorage.setItem('aurora_recent_searches:1:none', JSON.stringify(['left by whoever was here']))
    renderApp(1, true, { bindingUnreadable: true })
    await screen.findByRole('heading', { name: /Who.s watching/ }, find)
    await waitFor(() => expect(field()).not.toBeNull(), find)
    fireEvent.change(field(), { target: { value: 'harbor' } })
    const card = await screen.findByRole('button', { name: /^Harbor Lights/ }, find)
    expect(document.querySelector('[data-search-recent]')).toBeNull()
    expect(document.body.textContent).not.toContain('left by whoever was here')
    fireEvent.click(card)
    await screen.findByRole('heading', { level: 1, name: 'Harbor Lights' }, find)
    expect(JSON.parse(localStorage.getItem('aurora_recent_searches:1:none')!)).toEqual(['left by whoever was here'])
    expect(Object.keys(localStorage).filter(k => k.startsWith('aurora_recent_searches:'))).toEqual(['aurora_recent_searches:1:none'])
  })
})

// What a search finds besides titles, against the whole App: the collections
// that hold the words, and a watch party with the best match. Both belong to
// a session offered the Library's Collections and Together, which a profile
// with a content limit is not.
describe('what a search offers besides titles', () => {
  const field = () => document.querySelector<HTMLInputElement>('.stage-navsearch input')!
  async function typeInBar(words: string) {
    await waitFor(() => expect(field()).not.toBeNull(), find)
    fireEvent.change(field(), { target: { value: words } })
  }

  it('lists a collection that holds the words, and opens Collections on it', async () => {
    renderApp()
    await screen.findByText('Parent', undefined, find)
    await typeInBar('harbor')
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-search-collections] .search-colrow')
      if (!el) throw new Error('no collection listed yet')
      return el
    }, find)
    expect(row.querySelector('.search-colrow-name')!.textContent).toBe('Harbor towns')
    expect(screen.getByRole('button', { name: 'Start a watch party with Harbor Lights' })).toBeInTheDocument()
    fireEvent.click(row)
    // The collection's own page, under the Library's Collections.
    expect(await screen.findByRole('heading', { level: 1, name: 'Harbor towns' }, find)).toBeInTheDocument()
    expect(document.querySelector('[data-library-header] [aria-current="page"]')!.textContent).toBe('Collections')
    // Something was done with the search: it is remembered.
    expect(JSON.parse(localStorage.getItem('aurora_recent_searches:1:1') ?? '[]')).toEqual(['harbor'])
    fireEvent.click(screen.getByRole('button', { name: 'Back to collections' }))
    await waitFor(() => expect(document.querySelector('.stage-colcard-open')).not.toBeNull(), find)
    // Coming back to Collections later shows the index, not that collection
    // again: the ask was taken once, and forgotten.
    const scope = (name: string) => [...document.querySelectorAll<HTMLElement>('[data-library-header] .stage-scope')].find(b => b.textContent === name)!
    fireEvent.click(scope('My Library'))
    await waitFor(() => expect(document.querySelector('[data-library-header] [aria-current="page"]')!.textContent).toBe('My Library'), find)
    fireEvent.click(scope('Collections'))
    await waitFor(() => expect(document.querySelector('.stage-colcard-open')).not.toBeNull(), find)
    expect(screen.queryByRole('heading', { level: 1, name: 'Harbor towns' })).toBeNull()
  })

  // The nav's rewind counter is one for the whole app. Pressing a nav item
  // again anywhere used to leave every later visit to Collections on its
  // index, a picked collection included.
  it('opens Collections on the collection though a nav item was pressed again earlier', async () => {
    renderApp()
    await screen.findByText('Parent', undefined, find)
    const tonight = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('header .stage-tab[data-nav="home"]')
      if (!el) throw new Error('no nav yet')
      return el
    }, find)
    fireEvent.click(tonight)
    fireEvent.click(tonight)
    await typeInBar('harbor')
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-search-collections] .search-colrow')
      if (!el) throw new Error('no collection listed yet')
      return el
    }, find)
    fireEvent.click(row)
    expect(await screen.findByRole('heading', { level: 1, name: 'Harbor towns' }, find)).toBeInTheDocument()
    await new Promise(done => setTimeout(done, 200))
    expect(screen.getByRole('heading', { level: 1, name: 'Harbor towns' })).toBeInTheDocument()
  })

  it('lists no collection and offers no party to a profile with a content limit, and asks for no collections', async () => {
    const server = renderApp(2)
    await screen.findByText('Kid', undefined, find)
    await typeInBar('harbor')
    await screen.findByRole('button', { name: /^Harbor Lights/ }, find)
    await new Promise(done => setTimeout(done, 200))
    expect(document.querySelector('[data-search-collections]')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Start a watch party/ })).toBeNull()
    expect(document.querySelector('[data-search-actions]')).toBeNull()
    expect(server.collectionLists.n).toBe(0)
  })
})
