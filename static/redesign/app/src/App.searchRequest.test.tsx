// @vitest-environment jsdom
//
// Requesting, against the whole App: it has no tab, and is where a search
// that finds nothing in the library ends. The search page lists the titles
// that can be asked for and takes the request there; the requests page then
// has it. A profile with a content limit is offered no requests anywhere,
// here included.

import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import App from './App'
import { forgetDescribedAnswer } from '@/lib/describedSearch'

vi.mock('@/components/VideoPlayer', async (original) => ({
  ...(await original<typeof import('@/components/VideoPlayer')>()),
  VideoPlayer: () => null,
}))

// The router's address after each commit, and its Back button.
const where = { path: '', back: () => {}, forward: () => {} }
function Where() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  useEffect(() => { where.path = pathname; where.back = () => navigate(-1); where.forward = () => navigate(1) }, [pathname, navigate])
  return null
}

const NOW = '2026-10-01T00:00:00Z'
const PARENT = { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }
const KID = { id: 2, user_id: 1, name: 'Kid', is_default: false, created_at: NOW, updated_at: NOW, max_age_rating: 'PG' }
const HARBOR = { id: 77, library_id: 1, type: 'movie', title: 'Harbor Lights', year: 2022, rating: 8, overview: 'A harbor.', added_at: NOW, updated_at: NOW }

/** `bindingUnreadable`: the server cannot say which profile the session acts
 *  as, so the app knows none (it opens the profile picker over the page). */
function renderApp(bound = 1, keep = false, { bindingUnreadable = false, noProfiles = false, kidFree = false, requests = [] as Record<string, unknown>[] } = {}) {
  const me = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
  /** What was looked up outside the library (the server asks TMDB). */
  const lookups: string[] = []
  /** The requests made, as the server was sent them, and as it lists them. */
  const posted: Record<string, unknown>[] = []
  // `requests`: what the account had asked for before this page was opened.
  const listed: Record<string, unknown>[] = [...requests]
  /** How many times the list of collections was asked for. */
  const collectionLists = { n: 0 }
  const heroAsks = { n: 0 }
  /** How each search asked to be run (`mode`), or null where it did not say. */
  const searchModes: (string | null)[] = []
  /** The profile the session acts as (a switch moves it). */
  const acting = { id: bound }
  /** Holds the answer to the next request made until let go. */
  const held: { answer: Promise<void> | null } = { answer: null }
  const TOWNS = { id: 5, owner_user_id: 1, name: 'Harbor towns', kind: 'manual', is_public: false, item_count: 1, created_at: NOW, updated_at: NOW }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    if (p === '/api/auth/me') return json(me)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: me })
    // `noProfiles`: an account that has made none (the server acts as a stand-in).
    // `kidFree`: the second profile has no content limit, so both may request.
    const kid = kidFree ? { ...KID, max_age_rating: undefined } : KID
    if (p === '/api/profiles') return json(noProfiles ? [] : [PARENT, kid])
    const activate = p.match(/^\/api\/profiles\/(\d+)\/activate$/)
    if (activate && init?.method === 'POST') { acting.id = Number(activate[1]); return new Response(null, { status: 204 }) }
    if (p === '/api/profiles/active' && noProfiles) return json({ error: 'no profile' }, 404)
    if (p === '/api/profiles/active') return bindingUnreadable ? json({ error: 'unavailable' }, 503) : json(acting.id === 1 ? PARENT : kid)
    // Asked for only once the app knows who it is showing Tonight to.
    if (p === '/api/me/hero') { heroAsks.n++; return json({ picks: [], slate_token: 's' }) }
    if (p === '/api/media/recent') return json({ data: [] })
    if (p === '/api/media') return json({ data: [], page: 1, per_page: 30, total_items: 0, total_pages: 1 })
    // Nothing in the library matches anything, but "harbor".
    if (p === '/api/media/search') {
      searchModes.push(url.searchParams.get('mode'))
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
      if (held.answer) await held.answer
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
  render(<MemoryRouter initialEntries={['/']}><Where /><App /></MemoryRouter>)
  return {
    lookups, collectionLists, heroAsks, posted, searchModes,
    holdRequest() {
      let release!: () => void
      held.answer = new Promise<void>(done => { release = done })
      return () => { held.answer = null; release() }
    },
  }
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
// A described search's answer is kept for the life of the page (one entry,
// lib/describedSearch); a test's ask must not be answered by the last one's.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); forgetDescribedAnswer() })

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
    await waitFor(() => expect(document.querySelector('.search-req-state')?.textContent).toBe('Requested · waiting to be sent to the downloader'), find)
    expect(await screen.findByText('Requested "The Lost Reel"', undefined, find)).toBeInTheDocument()
    // The way on is the requests page, which has it.
    fireEvent.click(screen.getByRole('button', { name: 'See my requests' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'My requests' }, find)).toBeInTheDocument()
    expect(await screen.findByText('The Lost Reel', undefined, find)).toBeInTheDocument()
  })

  // L6 of review 21. A request's answer can come back after the tab has
  // moved on to someone else. It was told to the app whoever that was: a
  // toast, and a row in whatever requests list the tab then held.
  it('tells the app nothing about a request answered after the session moved to another profile', async () => {
    const server = renderApp(1, false, { kidFree: true })
    await screen.findByText('Parent', undefined, find)
    await searchFor('the lost reel')
    const release = server.holdRequest()
    fireEvent.click(await screen.findByRole('button', { name: 'Request The Lost Reel (2025)' }, find))
    await waitFor(() => expect(server.posted).toHaveLength(1), find)
    // Another profile, while the answer is still out.
    fireEvent.click(document.querySelector<HTMLElement>('[data-identity-trigger]')!)
    fireEvent.click(within(screen.getByRole('group', { name: 'Watching as' })).getByRole('button', { name: /Kid/ }))
    await waitFor(() => expect(document.querySelector('[data-identity-name]')?.textContent).toBe('Kid'), find)
    release()
    await new Promise(done => setTimeout(done, 400))
    expect(screen.queryByText('Requested "The Lost Reel"')).toBeNull()
  })

  // The same answer, with nothing moved: it is told.
  it('tells the app about a request answered late while the session is still the one that made it', async () => {
    const server = renderApp(1, false, { kidFree: true })
    await screen.findByText('Parent', undefined, find)
    await searchFor('the lost reel')
    const release = server.holdRequest()
    fireEvent.click(await screen.findByRole('button', { name: 'Request The Lost Reel (2025)' }, find))
    await waitFor(() => expect(server.posted).toHaveLength(1), find)
    await new Promise(done => setTimeout(done, 300))
    release()
    expect(await screen.findByText('Requested "The Lost Reel"', undefined, find)).toBeInTheDocument()
  })

  // The requests page makes no request itself: its first row opens the
  // search page with the field ready, and a request that has arrived is
  // found by searching for its title.
  it('is where the requests page sends someone who wants to ask, and to find what has arrived', async () => {
    renderApp()
    await screen.findByText('Parent', undefined, find)
    await searchFor('the lost reel')
    fireEvent.click(await screen.findByRole('button', { name: 'Request The Lost Reel (2025)' }, find))
    await waitFor(() => expect(document.querySelector('.search-req-state')).not.toBeNull(), find)
    fireEvent.click(screen.getByRole('button', { name: 'See my requests' }))
    await screen.findByRole('heading', { level: 1, name: 'My requests' }, find)
    // No composer on the page.
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Ask for a movie or show that is not in the library' }, find))
    // The search page, with a search field holding the focus: the bar's
    // from md up, the page's own on a phone (only one of the two is drawn
    // at any width; with no stylesheet here both exist, and the page's,
    // focused last, has it).
    await waitFor(() => expect(document.querySelector('[data-search-results]')).not.toBeNull(), find)
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Search titles'), find)
    expect(document.activeElement?.tagName).toBe('INPUT')
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
    // With the bar's field emptied the search page stays, and lists them.
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

// Review 23, against the whole App.
describe('the requests page, from the account menu', () => {
  const asked = (id: number, title: string, status: string) =>
    ({ id, user_id: 1, media_type: 'movie', tmdb_id: 500 + id, title, poster_path: '', overview: '', year: 2022, status, quality_1080p: true, quality_4k: false, requested_at: NOW, updated_at: NOW })
  async function openRequests() {
    fireEvent.click(document.querySelector<HTMLElement>('[data-identity-trigger]')!)
    fireEvent.click(await screen.findByRole('button', { name: /My requests/ }, find))
    await screen.findByRole('heading', { level: 1, name: 'My requests' }, find)
  }

  // "Find it" went through the navigation helper, which ends by clearing
  // the search words: it opened an empty search page.
  it('finds a request that has arrived: the search page, with its title in the field and the title\'s results', async () => {
    renderApp(1, false, { requests: [asked(5, 'Harbor Lights', 'available')] })
    await screen.findByText('Parent', undefined, find)
    await openRequests()
    fireEvent.click(await screen.findByRole('button', { name: 'Find Harbor Lights in the library' }, find))
    await waitFor(() => expect(document.querySelector('[data-search-results]')).not.toBeNull(), find)
    expect(document.querySelector<HTMLInputElement>('.stage-navsearch input')!.value).toBe('Harbor Lights')
    const result = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-search-results] .mlr-title, [data-search-results] .search-best-title, [data-search-results] .cc-title')
      if (!el) throw new Error('no result yet')
      return el
    }, find)
    expect(result.textContent).toBe('Harbor Lights')
  })

  // A retry's answer after the tab has moved to another profile is not told
  // to whoever is there now (the search page's requests are stamped the same).
  it('tells the app nothing about a retry answered after the session moved to another profile', async () => {
    const server = renderApp(1, false, { kidFree: true, requests: [asked(6, 'Paper Lanterns', 'failed')] })
    await screen.findByText('Parent', undefined, find)
    await openRequests()
    const release = server.holdRequest()
    fireEvent.click(await screen.findByRole('button', { name: 'Ask for Paper Lanterns again' }, find))
    await waitFor(() => expect(server.posted).toHaveLength(1), find)
    fireEvent.click(document.querySelector<HTMLElement>('[data-identity-trigger]')!)
    fireEvent.click(within(screen.getByRole('group', { name: 'Watching as' })).getByRole('button', { name: /Kid/ }))
    await waitFor(() => expect(document.querySelector('[data-identity-name]')?.textContent).toBe('Kid'), find)
    release()
    await new Promise(done => setTimeout(done, 400))
    expect(screen.queryByText('Requested "Paper Lanterns"')).toBeNull()
  })

  it('tells the app about a retry answered while the session is still the one that made it', async () => {
    const server = renderApp(1, false, { kidFree: true, requests: [asked(6, 'Paper Lanterns', 'failed')] })
    await screen.findByText('Parent', undefined, find)
    await openRequests()
    const release = server.holdRequest()
    fireEvent.click(await screen.findByRole('button', { name: 'Ask for Paper Lanterns again' }, find))
    await waitFor(() => expect(server.posted).toHaveLength(1), find)
    release()
    expect(await screen.findByText('Requested "Paper Lanterns"', undefined, find)).toBeInTheDocument()
  })
})

// The keyboard. There was a palette on Ctrl or Cmd K: a modal with a field
// and a list of its own, which searched on every key without saying how.
// There is one field and one page now: the key puts the focus in the field,
// the arrows move through the page's results, a result opens as the button
// it is, and Escape clears the field, then leaves it.
describe('searching from the keyboard', () => {
  const field = () => document.querySelector<HTMLInputElement>('.stage-navsearch input')!
  const focused = () => document.activeElement as HTMLElement
  /** True when the key was taken (its default prevented). */
  const press = (on: Element, init: KeyboardEventInit) => !fireEvent.keyDown(on, init)
  async function ready() {
    const server = renderApp()
    await screen.findByText('Parent', undefined, find)
    await waitFor(() => expect(field()).not.toBeNull(), find)
    return server
  }

  it('puts the focus in the search field on Ctrl or Cmd K, and opens nothing over the page', async () => {
    await ready()
    expect(focused()).not.toBe(field())
    const focus = vi.spyOn(field(), 'focus')
    expect(press(document.body, { key: 'k', metaKey: true })).toBe(true)
    expect(focused()).toBe(field())
    expect(screen.queryByRole('dialog')).toBeNull()
    // The bar is sticky: focused plainly, the browser scrolls the page to
    // the top, where the bar sits in the document. The page is left alone.
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    focus.mockRestore()
    field().blur()
    expect(press(document.body, { key: 'k', ctrlKey: true })).toBe(true)
    expect(focused()).toBe(field())
    // From the field itself: still the field, with what is in it selected.
    fireEvent.change(field(), { target: { value: 'harbor' } })
    expect(press(field(), { key: 'k', metaKey: true })).toBe(true)
    expect(focused()).toBe(field())
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 6])
    // A plain "k" is a letter.
    expect(press(document.body, { key: 'k' })).toBe(false)
  })

  it('leaves the key alone from another text field, under a modal dialog, and while the profile picker is over the page', async () => {
    await ready()
    const other = document.createElement('input')
    document.body.append(other)
    other.focus()
    expect(press(other, { key: 'k', metaKey: true })).toBe(false)
    expect(focused()).toBe(other)
    other.remove()
    // Nor under a modal dialog: the field is in the page behind it.
    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    expect(press(document.body, { key: 'k', metaKey: true })).toBe(false)
    expect(focused()).not.toBe(field())
    modal.remove()
    // Nor while the page the field is in is hidden from assistive tech or
    // inert (how a dialog that says nothing of being modal covers the page).
    const bar = field().closest('header')!
    bar.setAttribute('aria-hidden', 'true')
    expect(press(document.body, { key: 'k', metaKey: true })).toBe(false)
    bar.removeAttribute('aria-hidden')
    bar.setAttribute('inert', '')
    expect(press(document.body, { key: 'k', metaKey: true })).toBe(false)
    bar.removeAttribute('inert')
    expect(press(document.body, { key: 'k', metaKey: true })).toBe(true)
    expect(focused()).toBe(field())
    field().blur()
    cleanup()
    vi.unstubAllGlobals()
    renderApp(1, false, { bindingUnreadable: true })
    await screen.findByRole('heading', { name: /Who.s watching/ }, find)
    await waitFor(() => expect(field()).not.toBeNull(), find)
    expect(press(document.body, { key: 'k', metaKey: true })).toBe(false)
    expect(focused()).not.toBe(field())
  })

  it('moves from the field through the results with the arrows and back, and opens the one in focus', async () => {
    await ready()
    press(document.body, { key: 'k', metaKey: true })
    fireEvent.change(field(), { target: { value: 'harbor' } })
    await screen.findByRole('button', { name: /^Harbor Lights/ }, find)
    await waitFor(() => expect(document.querySelector('[data-search-collections] .search-colrow')).not.toBeNull(), find)
    // Down: out of the field, onto the first result.
    expect(press(field(), { key: 'ArrowDown' })).toBe(true)
    expect(focused().textContent).toContain('Harbor Lights')
    expect(focused().tagName).toBe('BUTTON')
    expect(press(focused(), { key: 'ArrowDown' })).toBe(true)
    expect(focused().textContent).toContain('Harbor towns')
    press(focused(), { key: 'ArrowUp' })
    expect(focused().textContent).toContain('Harbor Lights')
    // Up from the first: a search field again.
    press(focused(), { key: 'ArrowUp' })
    expect(focused().getAttribute('aria-label')).toBe('Search titles')
    // A result is a button: Enter is its press. It opens the title.
    press(field(), { key: 'ArrowDown' })
    fireEvent.click(focused())
    expect(await screen.findByRole('heading', { level: 1, name: 'Harbor Lights' }, find)).toBeInTheDocument()
  })

  it('does nothing with Down in the field while there is nothing to go to', async () => {
    await ready()
    field().focus()
    expect(press(field(), { key: 'ArrowDown' })).toBe(false)
    expect(focused()).toBe(field())
  })

  it('clears the field on Escape, with the focus kept in it and the page still up, then goes back to where the viewer was', async () => {
    await ready()
    press(document.body, { key: 'k', metaKey: true })
    fireEvent.change(field(), { target: { value: 'harbor' } })
    await screen.findByRole('button', { name: /^Harbor Lights/ }, find)
    await waitFor(() => expect(where.path).toBe('/search'), find)
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field().value).toBe('')
    expect(focused()).toBe(field())
    // The page stays for the next try (it used to drop to Tonight).
    expect(document.querySelector('[data-search-results]')).not.toBeNull()
    expect(where.path).toBe('/search')
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(focused()).not.toBe(field())
    await waitFor(() => expect(where.path).toBe('/'), find)
    await waitFor(() => expect(document.querySelector('[data-search-results]')).toBeNull(), find)
  })

  it('only leaves the field on Escape anywhere else, and keeps what is typed on a title opened from a search', async () => {
    await ready()
    fireEvent.change(field(), { target: { value: 'harbor' } })
    fireEvent.click(await screen.findByRole('button', { name: /^Harbor Lights/ }, find))
    await screen.findByRole('heading', { level: 1, name: 'Harbor Lights' }, find)
    await waitFor(() => expect(where.path).toBe('/title/77'), find)
    field().focus()
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(focused()).not.toBe(field())
    expect(field().value).toBe('harbor')
    expect(where.path).toBe('/title/77')
    // With the field left, Escape is the title page's own: back to the results.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(where.path).toBe('/search'), find)
    expect(await screen.findByRole('button', { name: /^Harbor Lights/ }, find)).toBeInTheDocument()
  })

  it('clears on Escape from a result too, and puts the focus back in the field', async () => {
    await ready()
    field().focus()
    fireEvent.change(field(), { target: { value: 'harbor' } })
    await screen.findByRole('button', { name: /^Harbor Lights/ }, find)
    press(field(), { key: 'ArrowDown' })
    expect(focused()).not.toBe(field())
    fireEvent.keyDown(focused(), { key: 'Escape' })
    expect(field().value).toBe('')
    expect(focused()).toBe(field())
  })

  // The palette asked the server on every key without naming how to search,
  // which leaves the server to decide whether to spend a model call.
  it('names how to search on every request: by title as it is typed, by description when asked', async () => {
    const server = await ready()
    press(document.body, { key: 'k', metaKey: true })
    fireEvent.change(field(), { target: { value: 'har' } })
    fireEvent.change(field(), { target: { value: 'harbor' } })
    await screen.findByRole('button', { name: /^Harbor Lights/ }, find)
    fireEvent.keyDown(field(), { key: 'Enter' })
    await waitFor(() => expect(server.searchModes).toContain('semantic'), find)
    expect(server.searchModes.every(m => m === 'literal' || m === 'semantic')).toBe(true)
    expect(server.searchModes.filter(m => m === 'semantic')).toHaveLength(1)
  })
})

// The search page used to be drawn over whatever address the viewer was
// typing at: Back from a result skipped the results and left the words in
// the bar over another page.
describe('the search page has its own address', () => {
  const field = () => document.querySelector<HTMLInputElement>('.stage-navsearch input')!
  const results = () => document.querySelector('[data-search-results]')
  async function ready(options: Parameters<typeof renderApp>[2] = {}) {
    const server = renderApp(1, false, options)
    await screen.findByText('Parent', undefined, find)
    await waitFor(() => expect(field()).not.toBeNull(), find)
    return server
  }
  const back = async (to: string) => {
    where.back()
    await waitFor(() => expect(where.path).toBe(to), find)
  }

  it('takes it on the first key, once, and Back from a result is the results again, then where the viewer was', async () => {
    await ready()
    expect(where.path).toBe('/')
    fireEvent.change(field(), { target: { value: 'har' } })
    fireEvent.change(field(), { target: { value: 'harbor' } })
    await waitFor(() => expect(where.path).toBe('/search'), find)
    fireEvent.click(await screen.findByRole('button', { name: /^Harbor Lights/ }, find))
    await waitFor(() => expect(where.path).toBe('/title/77'), find)
    // The words stay in the bar on the title: they are what Back returns to.
    expect(field().value).toBe('harbor')
    await back('/search')
    expect(field().value).toBe('harbor')
    expect(await screen.findByRole('button', { name: /^Harbor Lights/ }, find)).toBeInTheDocument()
    // Forward to the title and Back once more: still its results.
    where.forward()
    await waitFor(() => expect(where.path).toBe('/title/77'), find)
    expect(field().value).toBe('harbor')
    await back('/search')
    expect(field().value).toBe('harbor')
    // One entry for the page, however many keys were typed: Back again is Tonight,
    await back('/')
    await waitFor(() => expect(results()).toBeNull(), find)
    // and the words went with the results they were for.
    expect(field().value).toBe('')
  })

  it('stays, with nothing typed, when the words are deleted or cleared, and the cursor stays in the field', async () => {
    await ready()
    fireEvent.change(field(), { target: { value: 'harbor' } })
    await waitFor(() => expect(where.path).toBe('/search'), find)
    fireEvent.change(field(), { target: { value: '' } })
    expect(results()).not.toBeNull()
    expect(where.path).toBe('/search')
    fireEvent.change(field(), { target: { value: 'harbor' } })
    await screen.findByRole('button', { name: /^Harbor Lights/ }, find)
    fireEvent.click(within(field().closest('.stage-navsearch') as HTMLElement).getByRole('button', { name: 'Clear search' }))
    expect(field().value).toBe('')
    expect(document.activeElement).toBe(field())
    expect(results()).not.toBeNull()
    expect(where.path).toBe('/search')
    // Still the one entry: Back is where the typing began.
    await back('/')
  })

  it('is not dismissed by a press elsewhere on the page', async () => {
    await ready()
    fireEvent.change(field(), { target: { value: 'harbor' } })
    await screen.findByRole('button', { name: /^Harbor Lights/ }, find)
    fireEvent.mouseDown(document.querySelector('header.stage-topnav')!)
    fireEvent.mouseDown(document.querySelector('main') ?? document.body)
    expect(field().value).toBe('harbor')
    expect(results()).not.toBeNull()
    expect(where.path).toBe('/search')
  })

  it('takes it for a search by description asked for from another page', async () => {
    const server = await ready()
    fireEvent.change(field(), { target: { value: 'harbor' } })
    fireEvent.click(await screen.findByRole('button', { name: /^Harbor Lights/ }, find))
    await waitFor(() => expect(where.path).toBe('/title/77'), find)
    // On the title, with the words still in the bar: Enter asks by description.
    fireEvent.keyDown(field(), { key: 'Enter' })
    await waitFor(() => expect(where.path).toBe('/search'), find)
    await waitFor(() => expect(server.searchModes.filter(m => m === 'semantic')).toHaveLength(1), find)
    await back('/title/77')
  })

  it('keeps the words when the page itself sends the viewer on, so Back from a collection is its results', async () => {
    await ready()
    fireEvent.change(field(), { target: { value: 'harbor' } })
    fireEvent.click(await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-search-collections] .search-colrow')
      if (!el) throw new Error('no collection yet')
      return el
    }, find))
    await waitFor(() => expect(where.path).toBe('/collections'), find)
    expect(field().value).toBe('harbor')
    await back('/search')
    expect(field().value).toBe('harbor')
    expect(await screen.findByRole('button', { name: /^Harbor Lights/ }, find)).toBeInTheDocument()
    // Any other way off the page drops them: a destination in the bar.
    fireEvent.click(document.querySelector<HTMLElement>('header.stage-topnav [data-nav="home"]')!)
    await waitFor(() => expect(where.path).toBe('/home'), find)
    expect(field().value).toBe('')
  })

  it('keeps them on the way to My requests from a search that found nothing, so Back is the list being asked from', async () => {
    await ready()
    fireEvent.change(field(), { target: { value: 'lost reel' } })
    fireEvent.click(await screen.findByRole('button', { name: 'See my requests' }, find))
    await waitFor(() => expect(where.path).toBe('/requests'), find)
    expect(field().value).toBe('lost reel')
    await back('/search')
    expect(field().value).toBe('lost reel')
    expect(await screen.findByRole('button', { name: 'See my requests' }, find)).toBeInTheDocument()
  })

  it('is where "Find it" on a request goes, and Back from it is the request', async () => {
    const asked = { id: 5, user_id: 1, media_type: 'movie', tmdb_id: 505, title: 'Harbor Lights', poster_path: '', overview: '', year: 2022, status: 'available', quality_1080p: true, quality_4k: false, requested_at: NOW, updated_at: NOW }
    await ready({ requests: [asked] })
    fireEvent.click(document.querySelector<HTMLElement>('[data-identity-trigger]')!)
    fireEvent.click(await screen.findByRole('button', { name: /My requests/ }, find))
    await waitFor(() => expect(where.path).toBe('/requests'), find)
    fireEvent.click(await screen.findByRole('button', { name: 'Find Harbor Lights in the library' }, find))
    await waitFor(() => expect(where.path).toBe('/search'), find)
    expect(field().value).toBe('Harbor Lights')
    await back('/requests')
    await screen.findByRole('heading', { level: 1, name: 'My requests' }, find)
    expect(field().value).toBe('')
  })
})
