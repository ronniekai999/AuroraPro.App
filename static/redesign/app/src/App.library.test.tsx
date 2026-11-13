// @vitest-environment jsdom
//
// A Library grid (Movies), against the whole App and a stubbed server that
// pages a catalog the way the real one does: a hundred titles a request, in
// the order asked for.
//
// What this pins is App's wiring of the Library header and the A to Z strip
// (their parts have their own tests):
//
//   - the header is App's, above the grid, and stays mounted while the grid
//     reloads: a new sort keeps the control that chose it, and its focus;
//   - a library of more than a few hundred titles opens compact, a small one
//     comfortable, and a layout that is chosen is kept, for both grids;
//   - under the title sort, a list that fits in the pages a grid keeps live
//     has an A to Z strip, and a longer one has none. A letter with a loaded
//     title goes to its first with no request. A letter not seen yet asks
//     for the next pages in order, as "Load more" would, never past the
//     last, and the grid is still refreshed afterwards. A letter with no
//     titles says so, and keeps the focus. A jump still loading is dropped
//     when the list it was asked of goes.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App'

vi.mock('@/components/VideoPlayer', async (original) => ({
  ...(await original<typeof import('@/components/VideoPlayer')>()),
  VideoPlayer: () => null,
}))

const NOW = '2026-10-01T00:00:00Z'
const PARENT = { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }

// 340 films: four that start with a digit, then fourteen under each letter
// but Q and X. In title order a page of a hundred ends inside G, the first M
// is on the second page, the first R on the third, and Z is on the fourth.
const LETTERS = [...'ABCDEFGHIJKLMNOPRSTUVWYZ']
const TITLES = [
  ...['12 Bells', '1989', '3 Days', '45 Years'],
  ...LETTERS.flatMap(letter => Array.from({ length: 14 }, (_, n) => `${letter} Film ${String(n + 1).padStart(2, '0')}`)),
]
const film = (title: string, at: number) => ({
  id: 1000 + at, library_id: 1, type: 'movie', title, sort_title: title, year: 2000 + (at % 20), rating: 5 + (at % 40) / 10,
  genres: [at % 2 ? 'Drama' : 'Comedy'], overview: `${title}.`, added_at: NOW, updated_at: NOW,
})
const BIG = TITLES.map(film)
const SMALL = ['Alien', 'Brazil', 'Memento'].map(film)

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
/** The server says a scan added titles, on every socket the app has open. */
function scanAdded() {
  act(() => {
    for (const s of FakeSocket.opened) {
      s.onmessage?.({ data: JSON.stringify({ type: 'library_update', data: { library_id: 1, library_name: 'Movies', new_items: 1, action: 'items_added' } }) })
    }
  })
}

function stubServer(catalog: ReturnType<typeof film>[], shows: ReturnType<typeof film>[] = []) {
  const me = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
  /** Each request for a page of films: its page, sort and genre. */
  const pages: { page: number; sort: string; genre: string; type: string }[] = []
  const holds = new Map<number, Promise<void>>()
  const fails = new Set<number>()
  let signedIn = true
  let genresFail = false
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    if (p === '/api/auth/logout' && init?.method === 'POST') { signedIn = false; return new Response(null, { status: 204 }) }
    if (p === '/api/auth/login' && init?.method === 'POST') { signedIn = true; return json({ expires_in: 900, user: me }) }
    if (p === '/api/auth/oauth/providers') return json({ providers: [] })
    if (!signedIn) return json({ error: { code: 401, message: 'signed out' } }, 401)
    if (p === '/api/auth/me') return json(me)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: me })
    if (p === '/api/profiles') return json([PARENT])
    if (p === '/api/profiles/active') return json(PARENT)
    if (p === '/api/me/hero') return json({ picks: [], slate_token: 's' })
    if (p === '/api/media/genres') return genresFail ? json({ error: 'unavailable' }, 503) : json({ genres: ['Comedy', 'Drama'] })
    if (p === '/api/media/recent') return json({ data: catalog.slice(0, 3) })
    if (p === '/api/media') {
      const q = url.searchParams
      const per = Number(q.get('per_page') ?? 20)
      const page = Number(q.get('page') ?? 1)
      const sort = q.get('sort_by') ?? ''
      const genre = q.get('genre') ?? ''
      const type = q.get('type')
      // The whole catalog's count: none of this file's.
      if (!type) return json({ data: catalog.slice(0, per), page: 1, per_page: per, total_items: catalog.length, total_pages: 1 })
      const titles = type === 'movie' ? catalog : shows
      if (per === 100) pages.push({ page, sort, genre, type })
      const held = per === 100 ? holds.get(page) : undefined
      if (held) await held
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      if (per === 100 && fails.has(page)) return json({ error: 'unavailable' }, 503)
      let list = genre ? titles.filter(m => m.genres.includes(genre)) : titles
      // Title order is the catalog's own; any other sort is some other order.
      if (sort !== 'title') list = [...list].reverse()
      return json({ data: list.slice((page - 1) * per, page * per), page, per_page: per, total_items: list.length, total_pages: Math.ceil(list.length / per) })
    }
    // Part-way through one film of the catalog.
    if (p === '/api/progress/continue') {
      return json([{ media_item_id: 1004, title: 'A Film 01', type: 'movie', year: 2004, position_ms: 30 * 60000, duration_ms: 120 * 60000, percent_complete: 25 }])
    }
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    if (p === '/api/parties/active') return json({ parties: [] })
    return json([])
  })
  FakeSocket.opened = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  return {
    pages,
    /** Holds the answer to a page of films until let go. */
    hold(page: number) {
      let release!: () => void
      holds.set(page, new Promise<void>(done => { release = done }))
      return () => { holds.delete(page); release() }
    },
    fail(page: number) { fails.add(page) },
    /** The library's genre list cannot be read. */
    failGenres() { genresFail = true },
  }
}

/** The titles the grid was scrolled to, in order. (The Library header also
 *  scrolls its own strip of scope names; that is not the grid's.) */
let scrolledTo: string[] = []
function renderMovies(catalog = BIG, prefs: Record<string, unknown> = {}, at = '/movies', shows: ReturnType<typeof film>[] = []) {
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify({ id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true, ...prefs }))
  const server = stubServer(catalog, shows)
  scrolledTo = []
  Element.prototype.scrollIntoView = function (this: Element) {
    if (!this.closest('[data-browse-layout]')) return
    scrolledTo.push(this.querySelector('.cc-title, .mlr-title')?.textContent ?? this.textContent ?? '')
  }
  render(<MemoryRouter initialEntries={[at]}><App /></MemoryRouter>)
  return server
}

const find = { timeout: 8000 }
const strip = () => screen.findByRole('toolbar', { name: 'Jump to letter' }, find)
const letter = async (l: string) => within(await strip()).getByRole('button', { name: l })
const grid = () => document.querySelector<HTMLElement>('[data-browse-layout]')!
const cards = () => [...grid().querySelectorAll('.cc-title')].map(el => el.textContent)
const count = () => document.querySelector('[data-browse-count]')?.textContent ?? ''
const status = async () => within(await strip()).getByRole('status').textContent
/** The card that holds the keyboard's focus, by its title. */
const focusedCard = () => document.activeElement?.closest('[data-media-id]')?.querySelector('.cc-title')?.textContent ?? null
const pagesAsked = (server: ReturnType<typeof stubServer>, type = 'movie') => server.pages.filter(p => p.type === type).map(p => p.page)

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a Library grid opens', () => {
  it('compact when the library is large, under the header, with its count and the first page', async () => {
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    expect(grid().dataset.browseLayout).toBe('compact')
    expect(count()).toMatch(/^340 movies/)
    expect(cards()).toHaveLength(100)
    expect(pagesAsked(server)).toEqual([1])
    // The header is not the grid's: it sits above it, with the controls in it.
    const header = document.querySelector<HTMLElement>('[data-library-header]')!
    expect(header.contains(grid())).toBe(false)
    expect(within(header).getByRole('combobox', { name: 'Sort titles' })).toBeInTheDocument()
    expect(header.compareDocumentPosition(grid()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('comfortable when it is small', async () => {
    renderMovies(SMALL)
    await screen.findByText('Alien', undefined, find)
    expect(grid().dataset.browseLayout).toBe('comfortable')
    expect(count()).toMatch(/^3 movies/)
  })

  it('as the viewer last chose, whatever its size, and keeps a new choice for both grids', async () => {
    renderMovies(BIG, { library_density: 'comfortable' })
    await screen.findByText('12 Bells', undefined, find)
    expect(grid().dataset.browseLayout).toBe('comfortable')
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    await waitFor(() => expect(grid().dataset.browseLayout).toBe('list'))
    expect(JSON.parse(localStorage.getItem('aurora_prefs')!)).toMatchObject({ library_view: 'list', library_density: 'comfortable' })
    // The Shows grid's control says the same.
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-library-header]')!).getByRole('button', { name: 'TV Shows' }))
    await waitFor(() => expect(count()).toMatch(/^0 shows/), find)
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('the genres, when the library\'s own list cannot be read', () => {
  // They used to be derived from the loaded titles in that case; the new
  // header drew no genre control at all.
  it('are those of the titles the grid holds, and still filter', async () => {
    localStorage.clear()
    const server = stubServer(BIG)
    server.failGenres()
    scrolledTo = []
    localStorage.setItem('aurora_user', JSON.stringify({ id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }))
    localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
    render(<MemoryRouter initialEntries={['/movies']}><App /></MemoryRouter>)
    await screen.findByText('12 Bells', undefined, find)
    const genres = await screen.findByRole('group', { name: 'Genre' }, find)
    expect(within(genres).getAllByRole('button').map(b => b.textContent)).toEqual(['All genres', 'Comedy', 'Drama'])
    fireEvent.click(within(genres).getByRole('button', { name: 'Drama' }))
    await waitFor(() => expect(count()).toMatch(/^170 Drama movies/), find)
    // The one that is on is still offered, to turn off.
    expect(within(screen.getByRole('group', { name: 'Genre' })).getByRole('button', { name: 'Drama' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('signing out and in again on the tab', () => {
  // The reset on sign-out put the sort on "Top rated", which is no longer
  // what a grid opens with: no strip, and Filters saying something was
  // applied that nobody chose.
  it('opens the grid as it first opened: by title, with nothing applied', async () => {
    renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    fireEvent.click(screen.getByRole('button', { name: /^Sign out/ }))
    fireEvent.change(await screen.findByLabelText('Username', {}, find), { target: { value: 'ronnie' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    // Signed in again, on Tonight; back to the Library, which opens on Movies.
    const library = await waitFor(() => {
      const tab = document.querySelector<HTMLElement>('header .stage-tab[data-nav="catalog"]')
      if (!tab) throw new Error('no Library tab yet')
      return tab
    }, find)
    fireEvent.click(library)
    const sort = await screen.findByRole('combobox', { name: 'Sort titles' }, find) as HTMLSelectElement
    await waitFor(() => expect(count()).toMatch(/^340 movies/), find)
    expect(sort.value).toBe('title')
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
    expect(await strip()).toBeInTheDocument()
  })
})

describe('the list layout', () => {
  it('says where the viewer is in a title they have started, and nothing for the rest', async () => {
    renderMovies(BIG, { library_view: 'list' })
    await screen.findByText('12 Bells', undefined, find)
    expect(grid().dataset.browseLayout).toBe('list')
    const where = (title: string) =>
      [...grid().querySelectorAll('.media-list-row')].find(r => r.querySelector('.mlr-title')?.textContent === title)!.querySelector('.mlr-where')!.textContent
    await waitFor(() => expect(where('A Film 01')).toBe('1 h 30 min left'), find)
    expect(where('A Film 02')).toBe('')
  })
})

describe('the header stays while the grid reloads', () => {
  it('keeps the sort control, and the focus in it, across a change of sort', async () => {
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    const sort = screen.getByRole('combobox', { name: 'Sort titles' }) as HTMLSelectElement
    sort.focus()
    const release = server.hold(1)
    fireEvent.change(sort, { target: { value: 'rating' } })
    // The grid is reloading: nothing of it is drawn.
    await waitFor(() => expect(document.querySelector('[data-browse-layout]')).toBeNull())
    expect(screen.getByRole('combobox', { name: 'Sort titles' })).toBe(sort)
    expect(document.activeElement).toBe(sort)
    expect(sort.value).toBe('rating')
    // Still compact while it loads, not back to comfortable skeletons.
    expect(document.querySelector('.poster-grid.is-compact')).not.toBeNull()
    release()
    await screen.findByText('Z Film 14', undefined, find)
    expect(screen.getByRole('combobox', { name: 'Sort titles' })).toBe(sort)
    expect(document.activeElement).toBe(sort)
    expect(server.pages[server.pages.length - 1]).toEqual({ page: 1, sort: 'rating', genre: '', type: 'movie' })
  })
})

describe('the A to Z strip', () => {
  it('is there under the title sort only', async () => {
    renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    expect(await strip()).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort titles' }), { target: { value: 'rating' } })
    await screen.findByText('Z Film 14', undefined, find)
    expect(screen.queryByRole('toolbar', { name: 'Jump to letter' })).toBeNull()
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort titles' }), { target: { value: 'title' } })
    await screen.findByText('12 Bells', undefined, find)
    expect(await strip()).toBeInTheDocument()
  })

  // The list is 340 titles: it fits in the five pages a grid keeps live.
  // A list one title over that has no strip at all, and one exactly at it has.
  it('is drawn for a list that fits in the pages a grid keeps live, and not for one title more', async () => {
    const titles = (n: number) => Array.from({ length: n }, (_, i) => film(`Film ${String(i + 1).padStart(4, '0')}`, i))
    renderMovies(titles(500))
    await screen.findByText('Film 0001', undefined, find)
    expect(count()).toMatch(/^500 movies/)
    expect(await strip()).toBeInTheDocument()
    cleanup()
    vi.unstubAllGlobals()
    renderMovies(titles(501))
    await screen.findByText('Film 0001', undefined, find)
    expect(count()).toMatch(/^501 movies/)
    await new Promise(done => setTimeout(done, 100))
    expect(screen.queryByRole('toolbar', { name: 'Jump to letter' })).toBeNull()
    // Nothing in its place: no disabled strip, no hint.
    expect(document.querySelector('[data-letter-strip]')).toBeNull()
  })

  it('knows the letters of the pages it has, and leaves the rest open until the whole list is loaded', async () => {
    renderMovies(BIG.filter(m => !m.title.startsWith('C ')))
    await screen.findByText('12 Bells', undefined, find)
    const state = async (l: string) => (await letter(l)).dataset.state
    expect(await state('Numbers and symbols')).toBe('here')
    expect(await state('A')).toBe('here')
    expect(await state('H')).toBe('here')
    // No C in this library. The first page is past where it would be in an
    // alphabet, but nothing is read into the server's order: it is open.
    expect(await state('C')).toBe('further')
    expect(await state('M')).toBe('further')
    expect(await letter('M')).not.toHaveAttribute('aria-disabled')
  })

  it('goes to a loaded letter\'s first title at once, with the keyboard, and asks for nothing', async () => {
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    fireEvent.click(await letter('D'))
    await waitFor(() => expect(scrolledTo).toEqual(['D Film 01']))
    expect(focusedCard()).toBe('D Film 01')
    expect(pagesAsked(server)).toEqual([1])
    expect(await status()).toBe('')
  })

  it('loads the next page for a letter that is on it, says so meanwhile, and goes no further', async () => {
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    const release = server.hold(2)
    fireEvent.click(await letter('M'))
    await waitFor(async () => expect(await status()).toBe('Loading titles to find M… 100 of 340'))
    expect(await letter('M')).toHaveAttribute('aria-busy', 'true')
    expect(scrolledTo).toEqual([])
    release()
    await waitFor(() => expect(scrolledTo).toEqual(['M Film 01']), find)
    expect(focusedCard()).toBe('M Film 01')
    expect(pagesAsked(server)).toEqual([1, 2])
    expect(cards()).toHaveLength(200)
    expect(await status()).toBe('')
    expect((await letter('M')).dataset.state).toBe('here')
    expect((await letter('Z')).dataset.state).toBe('further')
  })

  it('loads page after page, in order, for a letter at the end', async () => {
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    fireEvent.click(await letter('Z'))
    await waitFor(() => expect(scrolledTo).toEqual(['Z Film 01']), find)
    expect(pagesAsked(server)).toEqual([1, 2, 3, 4])
    expect(cards()).toHaveLength(340)
    expect(focusedCard()).toBe('Z Film 01')
  })

  // Pressed from the keyboard. The letter used to be disabled as the
  // answer came, while it held the focus, and the focus fell to the page.
  it('loads the rest of the list for a letter with no titles, says so, and leaves the focus on the letter', async () => {
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    const q = await letter('Q')
    q.focus()
    fireEvent.click(q)
    await waitFor(async () => expect(await status()).toBe('No titles under Q.'), find)
    // Every page of the list, and never one past the last.
    expect(pagesAsked(server)).toEqual([1, 2, 3, 4])
    expect(cards()).toHaveLength(340)
    expect(scrolledTo).toEqual([])
    expect(q).toHaveAttribute('aria-disabled', 'true')
    expect(document.activeElement).toBe(q)
    // The whole list is loaded: every letter is now exact.
    expect((await letter('X')).dataset.state).toBe('none')
    expect((await letter('Z')).dataset.state).toBe('here')
    // Pressing it again asks for nothing.
    fireEvent.click(q)
    await new Promise(done => setTimeout(done, 100))
    expect(pagesAsked(server)).toEqual([1, 2, 3, 4])
  })

  // The point of drawing the strip only for a list this short: the grid is
  // still within the pages a catalog update refreshes.
  it('leaves the grid refreshed by a catalog update after a jump to the end', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    fireEvent.click(await letter('Z'))
    await waitFor(() => expect(scrolledTo).toEqual(['Z Film 01']), find)
    expect(pagesAsked(server)).toEqual([1, 2, 3, 4])
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0), find)
    scanAdded()
    // Every loaded page is asked for again.
    await waitFor(() => expect([...pagesAsked(server).slice(4)].sort()).toEqual([1, 2, 3, 4]), { timeout: 12_000 })
    vi.restoreAllMocks()
  })

  // The strip is gone once the list no longer fits: a catalog update can do
  // that while a letter holds the keyboard's focus, and focus must not fall
  // to the page (the next Tab would start from the top of the document).
  it('hands the focus to the list when a catalog update takes the list past the strip\'s limit', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const titles = Array.from({ length: 500 }, (_, i) => film(`Film ${String(i + 1).padStart(4, '0')}`, i))
    renderMovies(titles)
    await screen.findByText('Film 0001', undefined, find)
    const f = await letter('F')
    f.focus()
    expect(document.activeElement).toBe(f)
    titles.push(film('Film 0501', 500))
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0), find)
    scanAdded()
    await waitFor(() => expect(document.querySelector('[data-letter-strip]')).toBeNull(), { timeout: 12_000 })
    expect(count()).toMatch(/^501 movies/)
    expect(focusedCard()).toBe('Film 0001')
    vi.restoreAllMocks()
  })

  // Focus that is somewhere else stays where it is.
  it('leaves the focus alone when the strip goes and no letter had it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const titles = Array.from({ length: 500 }, (_, i) => film(`Film ${String(i + 1).padStart(4, '0')}`, i))
    renderMovies(titles)
    await screen.findByText('Film 0001', undefined, find)
    await strip()
    const sort = screen.getByRole('combobox', { name: 'Sort titles' })
    sort.focus()
    titles.push(film('Film 0501', 500))
    await waitFor(() => expect(FakeSocket.opened.length).toBeGreaterThan(0), find)
    scanAdded()
    await waitFor(() => expect(document.querySelector('[data-letter-strip]')).toBeNull(), { timeout: 12_000 })
    expect(document.activeElement).toBe(sort)
    vi.restoreAllMocks()
  })

  it('stops when a page cannot be loaded, and can be asked again', async () => {
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    server.fail(2)
    fireEvent.click(await letter('M'))
    await screen.findByText('Failed to load more movies', undefined, find)
    await waitFor(async () => expect(await status()).toBe(''))
    await new Promise(done => setTimeout(done, 200))
    // One request for the page, not a stream of them.
    expect(pagesAsked(server)).toEqual([1, 2])
    expect(scrolledTo).toEqual([])
    expect((await letter('M')).dataset.state).toBe('further')
  })

  it('drops a jump that is still loading when the genre changes under it', async () => {
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    const release = server.hold(2)
    fireEvent.click(await letter('M'))
    await waitFor(async () => expect(await status()).toMatch(/^Loading titles to find M…/))
    fireEvent.click(screen.getByRole('button', { name: 'Drama' }))
    release()
    await waitFor(() => expect(count()).toMatch(/^170 Drama movies/), find)
    await new Promise(done => setTimeout(done, 200))
    expect(scrolledTo).toEqual([])
    expect(await status()).toBe('')
    // The Drama list's own first page, and nothing asked for on M's behalf.
    expect(server.pages.filter(p => p.genre === 'Drama')).toEqual([{ page: 1, sort: 'title', genre: 'Drama', type: 'movie' }])
  })

  // The grid's pages are App's, and outlive the page: a jump left running
  // would go on asking for them behind another screen.
  it('drops a jump that is still loading when the viewer leaves the grid', async () => {
    const server = renderMovies()
    await screen.findByText('12 Bells', undefined, find)
    const release = server.hold(2)
    fireEvent.click(await letter('Z'))
    await waitFor(async () => expect(await status()).toMatch(/^Loading titles to find Z…/))
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-library-header]')!).getByRole('button', { name: 'TV Shows' }))
    await waitFor(() => expect(count()).toMatch(/^0 shows/), find)
    release()
    await new Promise(done => setTimeout(done, 300))
    // The page that was already asked for, and none after it.
    expect(pagesAsked(server)).toEqual([1, 2])
    expect(scrolledTo).toEqual([])
  })

  it('works the same on the TV Shows grid', async () => {
    const shows = BIG.map(m => ({ ...m, id: m.id + 5000, type: 'show' }))
    const server = renderMovies(SMALL, {}, '/shows', shows)
    await screen.findByText('12 Bells', undefined, find)
    expect(count()).toMatch(/^340 shows/)
    fireEvent.click(await letter('M'))
    await waitFor(() => expect(scrolledTo).toEqual(['M Film 01']), find)
    expect(focusedCard()).toBe('M Film 01')
    expect(pagesAsked(server, 'show')).toEqual([1, 2])
  })
})
