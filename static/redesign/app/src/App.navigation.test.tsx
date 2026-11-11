// @vitest-environment jsdom
//
// Where things live. Three destinations (Tonight, Library, Together) replaced
// a row of eight tabs, and the pages behind the old tabs became scopes of
// Library or entries of the identity menu. What this pins, against the whole
// App and a stubbed server:
//
//   - every URL the old tabs had still opens its page, under the destination
//     and scope it now belongs to, and the new URLs open theirs;
//   - the destinations and scopes a session is offered follow the profile the
//     SERVER has bound, not the one this browser remembers;
//   - a session known to act as a restricted profile sees Tonight, Movies and
//     Shows: Together, requests, the member pages, the profile page,
//     Collections, My Library and Upcoming are not RENDERED for it on any
//     commit (the redirect runs after a commit, so the page itself is held
//     back), nor while startup has yet to say who the session is, nor while
//     the picker is asking; and a session whose profile cannot be learned at
//     all is not locked out of them;
//   - a phone, which has no search field in its bar, can still type a query
//     and get the results page.

import { Profiler, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import App from './App'

const NOW = '2026-10-01T00:00:00Z'
const PARENT = { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }
const KID = { id: 2, user_id: 1, name: 'Kid', is_default: false, created_at: NOW, updated_at: NOW, max_age_rating: 'PG' }
const USER = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }

/** `bound`: the profile the server says this session acts as (an activation
 *  rebinds it, as the server does). `bindingUnreadable`: GET
 *  /api/profiles/active fails every time. `parentLocked`: the Parent profile
 *  has a PIN, so nothing re-selects it without one. `listFails`: GET
 *  /api/profiles fails every time. `role`: the account's role. `hold(key)`
 *  keeps one answer back until the returned release is called; the keys are
 *  `binding` (GET /api/profiles/active) and `parties-<bound profile>`. */
function stubServer({ bound = 1, bindingUnreadable = false, parentLocked = false, listFails = false, role = 'user' } = {}) {
  const parent = { ...PARENT, has_pin: parentLocked }
  const me = { ...USER, role }
  const holds = new Map<string, Promise<void>>()
  const searches: string[] = []
  // Every path asked for, in order.
  const asks: string[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    asks.push(p)
    const asked = bound
    const held = holds.get(p === '/api/profiles/active' ? 'binding' : p === '/api/parties/active' ? `parties-${asked}` : '')
    if (held) await held
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (p === '/api/auth/me') return json(me)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: me })
    if (p === '/api/profiles') return listFails ? json({ error: 'unavailable' }, 503) : json([parent, KID])
    if (p === '/api/profiles/active') return bindingUnreadable ? json({ error: 'unavailable' }, 503) : json(bound === 1 ? parent : KID)
    const activate = p.match(/^\/api\/profiles\/(\d+)\/activate$/)
    if (activate && init?.method === 'POST') {
      bound = Number(activate[1])
      return new Response(null, { status: 204 })
    }
    if (p === '/api/me/hero') return json({ picks: [], slate_token: 's' })
    if (p === '/api/media/recent') return json({ data: [] })
    if (p === '/api/media') return json({ data: [], page: 1, per_page: 1, total_items: 0, total_pages: 1 })
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    // One live party hosted by someone else, named for the profile asked for.
    if (p === '/api/parties/active') {
      return json({ parties: [{
        code: `P${asked}`, host_user_id: 9, party_name: '', media_title: asked === 1 ? 'Parentonly Party' : 'Kidonly Party', media_poster: '',
        participant_count: 3, max_participants: 0, is_playing: true, started_at: NOW,
      }] })
    }
    if (p === '/api/media/search') {
      searches.push(url.searchParams.get('q') ?? '')
      return json([{ id: 501, library_id: 1, type: 'movie', title: 'Found By Search', year: 2020, rating: 7, overview: '', added_at: NOW, updated_at: NOW }])
    }
    if (p === '/api/auth/oauth/links') return json({ linked: [], available: [], hasPassword: true, canUnlinkAny: false })
    if (p === '/api/me/gamification') {
      return json({ xp: { xp: 0, level: 1, current_streak: 0, longest_streak: 0, total_watches: 0, next_level_total: 100, prev_level_total: 0 }, unlocked: [], achievement_catalog: [] })
    }
    return json([])
  })
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  return {
    searches,
    asks,
    hold(key: string) {
      let release!: () => void
      holds.set(key, new Promise<void>(done => { release = done }))
      return () => { holds.delete(key); release() }
    },
  }
}

// The router's current pathname, recorded after each commit.
const where = { path: '' }
function Where() {
  const { pathname } = useLocation()
  useEffect(() => { where.path = pathname }, [pathname])
  return null
}
interface Commit {
  /** The bar's destinations. */
  destinations: (string | null)[]
  /** The name on the identity control: who the app says is watching. */
  identity: string | null
  /** The page a restricted session is not shown that is on screen, if any
   *  (App marks each with data-hidden-page), whatever it renders. */
  hidden: string | null
  /** The presence pill's text. */
  pill: string | null
}

/** Renders the App at a URL, sampling the page at every commit. */
function renderAt(at: string, { remembered, role = 'user' }: { remembered?: number; role?: string } = {}) {
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify({ ...USER, role }))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
  if (remembered) localStorage.setItem('aurora_active_profile_id', String(remembered))
  const commits: Commit[] = []
  const onRender = () => {
    if (!document.querySelector('header.stage-topnav')) return
    commits.push({
      destinations: destinations(),
      identity: identity(),
      hidden: document.querySelector('[data-hidden-page]')?.getAttribute('data-hidden-page') ?? null,
      pill: document.querySelector('[data-presence]')?.textContent ?? null,
    })
  }
  render(<Profiler id="app" onRender={onRender}><MemoryRouter initialEntries={[at]}><App /><Where /></MemoryRouter></Profiler>)
  return commits
}

const bar = () => document.querySelector('header.stage-topnav')!
const destinations = () => [...bar().querySelectorAll('.stage-tab')].map(b => b.textContent)
const currentDestination = () => bar().querySelector('.stage-tab[aria-current="page"]')?.textContent ?? null
const currentScope = () => document.querySelector('.stage-scope[aria-current="page"]')?.textContent ?? null
const identity = () => document.querySelector('[data-identity-name]')?.textContent ?? null
const hiddenPage = () => document.querySelector('[data-hidden-page]')?.getAttribute('data-hidden-page') ?? null
const pickInTopBar = (name: RegExp) => {
  fireEvent.click(document.querySelector('[data-identity-trigger]')!)
  fireEvent.click(within(screen.getByRole('group', { name: 'Watching as' })).getByRole('button', { name }))
}
/** The pages a restricted session is not shown, by URL, and the name App
 *  marks each with. */
const HIDDEN: [string, string][] = [
  ['/together', 'together'], ['/requests', 'requests'], ['/members', 'members'], ['/user/someone', 'member'],
  ['/profile', 'profile'], ['/collections', 'collections'], ['/library', 'library'], ['/calendar', 'calendar'], ['/upcoming', 'calendar'],
]
/** Wait for the startup profile load: the bar names the bound profile. */
const settled = (name: string) => waitFor(() => expect(identity()).toBe(name), { timeout: 5000 })

// The whole App mounts in every test, lazy views included.
vi.setConfig({ testTimeout: 20_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('every old tab URL still opens its page, in its new place', () => {
  beforeEach(() => stubServer())

  it.each([
    ['/movies', 'Movies'],
    ['/shows', 'TV Shows'],
    ['/collections', 'Collections'],
    ['/library', 'My Library'],
    ['/calendar', 'Upcoming'],
    ['/upcoming', 'Upcoming'],
  ])('%s is the %s scope of Library', async (url, scope) => {
    renderAt(url)
    await settled('Parent')
    expect(currentDestination()).toBe('Library')
    expect(currentScope()).toBe(scope)
    expect(where.path).toBe(url)
  })

  it('/ and /home are Tonight', async () => {
    renderAt('/home')
    await settled('Parent')
    expect(currentDestination()).toBe('Tonight')
    expect(currentScope()).toBeNull()
  })

  it('/requests is the My requests page, reached from the identity menu and no longer a tab', async () => {
    renderAt('/requests')
    await settled('Parent')
    expect(where.path).toBe('/requests')
    expect(currentDestination()).toBeNull()
    expect(destinations()).not.toContain('Requests')
    // A member's own requests, and the heading says so.
    await screen.findByRole('heading', { name: 'My requests' }, { timeout: 10_000 })
  })

  it('/together is the Together hub', async () => {
    renderAt('/together')
    await settled('Parent')
    expect(currentDestination()).toBe('Together')
    await screen.findByRole('heading', { name: 'Together' }, { timeout: 5000 })
  })

  it('/settings and /settings/<pane> are Settings', async () => {
    renderAt('/settings/profiles')
    await settled('Parent')
    expect(where.path).toBe('/settings/profiles')
    await screen.findByRole('heading', { name: 'Settings' }, { timeout: 5000 })
  })
})

describe('moving between places', () => {
  beforeEach(() => stubServer())

  it('the Library destination opens Movies, and EVERY scope in the row opens its own page at its old URL', async () => {
    renderAt('/')
    await settled('Parent')
    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Library' }))
    await waitFor(() => expect(where.path).toBe('/movies'))
    const scopes = () => screen.getByRole('navigation', { name: 'Library' })
    expect([...scopes().querySelectorAll('button')].map(b => b.textContent)).toEqual(['Movies', 'TV Shows', 'Collections', 'My Library', 'Upcoming'])
    // Each one, from each of the others' pages, in an order that leaves and
    // returns to Movies. My Library is the one whose id the Library
    // destination once shared: a click on it went nowhere.
    for (const [label, url] of [
      ['My Library', '/library'], ['Upcoming', '/calendar'], ['Collections', '/collections'],
      ['TV Shows', '/shows'], ['My Library', '/library'], ['Movies', '/movies'],
    ]) {
      fireEvent.click(within(scopes()).getByRole('button', { name: label }))
      await waitFor(() => expect(where.path).toBe(url), { timeout: 5000 })
      await waitFor(() => expect(currentScope()).toBe(label))
      expect(currentDestination()).toBe('Library')
    }
  })

  it('the Library destination, pressed while inside Library, stays on the scope it is on', async () => {
    renderAt('/library')
    await settled('Parent')
    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Library' }))
    expect(where.path).toBe('/library')
    expect(currentScope()).toBe('My Library')
  })

  it('the Library destination returns to the scope last looked at', async () => {
    renderAt('/shows')
    await settled('Parent')
    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Tonight' }))
    await waitFor(() => expect(currentDestination()).toBe('Tonight'))
    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Library' }))
    await waitFor(() => expect(where.path).toBe('/shows'))
  })

  it('Together\'s "pick something" goes to the Library destination, which on a session that has not browsed yet is Movies', async () => {
    // The Library destination's id is not My Library's view id; a caller
    // that passed the view id always landed on the saved list. The
    // destination opens the library scope last used (My Library included,
    // if that was it), and Movies when none has been.
    renderAt('/together')
    await settled('Parent')
    fireEvent.click(await screen.findByRole('button', { name: 'Pick something to watch together' }, { timeout: 10_000 }))
    await waitFor(() => expect(where.path).toBe('/movies'), { timeout: 5000 })
    expect(currentScope()).toBe('Movies')
  })

  it('My requests and Your profile open from the identity menu', async () => {
    renderAt('/')
    await settled('Parent')
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    fireEvent.click(screen.getByRole('button', { name: 'My requests' }))
    await waitFor(() => expect(where.path).toBe('/requests'))
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Your profile' }))
    await waitFor(() => expect(where.path).toBe('/profile'))
  })
})

describe('what a session is offered follows the profile the server has bound', () => {
  it('a session the server binds to a restricted profile never sees Together, though this browser remembers an unrestricted one', async () => {
    // The browser last showed the Parent, which is locked, so startup cannot
    // re-select it; the server says this session is the Kid.
    stubServer({ bound: 2, parentLocked: true })
    const commits = renderAt('/', { remembered: 1 })
    await settled('Kid')
    expect(destinations()).toEqual(['Tonight', 'Movies', 'Shows'])
    // Not at any commit on the way there, either: no Together, and the
    // remembered Parent's name never stood on the control.
    expect(commits.length).toBeGreaterThan(0)
    expect(commits.filter(c => c.destinations.includes('Together'))).toEqual([])
    expect(commits.filter(c => c.identity === 'Parent')).toEqual([])
  })

  it('a session the server binds to an unrestricted profile is not restricted by a remembered one it cannot re-select', async () => {
    const kidLocked = { ...KID, has_pin: true }
    stubServer({ bound: 1 })
    // Same stub, but the Kid is the locked one this time.
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const p = new URL(input, 'http://localhost').pathname
      if (p === '/api/profiles') return new Response(JSON.stringify([PARENT, kidLocked]), { status: 200, headers: { 'content-type': 'application/json' } })
      return realFetch(input, init)
    })
    const commits = renderAt('/', { remembered: 2 })
    await settled('Parent')
    expect(destinations()).toEqual(['Tonight', 'Library', 'Together'])
    // The remembered Kid restyled nothing on the way: never the children's bar.
    expect(commits.filter(c => c.destinations.includes('Movies'))).toEqual([])
    expect(commits.filter(c => c.identity === 'Kid')).toEqual([])
  })

  it('shows a restricted session no Together, no requests and no scopes beyond Movies and Shows', async () => {
    stubServer({ bound: 2 })
    renderAt('/movies', { remembered: 2 })
    await settled('Kid')
    expect(destinations()).toEqual(['Tonight', 'Movies', 'Shows'])
    expect(currentDestination()).toBe('Movies')
    // No Library scope row: Movies and Shows are in the bar itself.
    expect(screen.queryByRole('navigation', { name: 'Library' })).toBeNull()
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    expect(screen.queryByRole('button', { name: 'My requests' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Your profile' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Admin' })).toBeNull()
  })

  it('does not ask the server for the requests list on behalf of a restricted session that opens /requests', async () => {
    const server = stubServer({ bound: 2 })
    renderAt('/requests', { remembered: 2 })
    await settled('Kid')
    await waitFor(() => expect(where.path).toBe('/'), { timeout: 5000 })
    expect(server.asks.filter(p => p === '/api/requests')).toEqual([])
  })

  it('does ask for it for an unrestricted session, once the session is known', async () => {
    const server = stubServer({ bound: 1 })
    renderAt('/requests', { remembered: 1 })
    await settled('Parent')
    await waitFor(() => expect(server.asks.filter(p => p === '/api/requests')).toHaveLength(1), { timeout: 5000 })
  })

  it.each(HIDDEN)('never renders %s for a restricted session, and sends it to Tonight', async (url) => {
    stubServer({ bound: 2 })
    const commits = renderAt(url, { remembered: 2 })
    await settled('Kid')
    await waitFor(() => expect(where.path).toBe('/'), { timeout: 5000 })
    await waitFor(() => expect(currentDestination()).toBe('Tonight'))
    // Not on any commit: before the binding was read, on the commit that
    // learned it, or after.
    expect(commits.length).toBeGreaterThan(0)
    expect(commits.filter(c => c.hidden !== null)).toEqual([])
    expect(hiddenPage()).toBeNull()
  })

  it.each(HIDDEN)('renders %s for an unrestricted session, but not before the server has said who it is', async (url, name) => {
    const server = stubServer({ bound: 1 })
    // Hold the binding back: startup has not settled, the session is unknown.
    const release = server.hold('binding')
    const commits = renderAt(url, { remembered: 1 })
    await waitFor(() => expect(commits.length).toBeGreaterThan(2))
    expect(identity()).toBe('ronnie')
    expect(commits.filter(c => c.hidden !== null)).toEqual([])
    release()
    await settled('Parent')
    // Not vacuous: the same page does render once the session is known.
    await waitFor(() => expect(hiddenPage()).toBe(name), { timeout: 10_000 })
    expect(where.path).toBe(url)
    // And never under any name but the Parent's.
    expect(commits.filter(c => c.hidden !== null && c.identity !== 'Parent')).toEqual([])
  })

  it.each([['/collections', 'collections'], ['/together', 'together'], ['/requests', 'requests'], ['/members', 'members'], ['/library', 'library']])(
    'takes %s off the screen on the very commit that switches into a restricted profile', async (url, name) => {
      stubServer({ bound: 1 })
      const commits = renderAt(url, { remembered: 1 })
      await settled('Parent')
      await waitFor(() => expect(hiddenPage()).toBe(name), { timeout: 10_000 })
      pickInTopBar(/Kid/)
      await settled('Kid')
      await waitFor(() => expect(where.path).toBe('/'), { timeout: 5000 })
      // No commit shows the Kid's name with the page still up, not even the
      // one before the redirect effect ran.
      expect(commits.filter(c => c.identity === 'Kid' && c.hidden !== null)).toEqual([])
      expect(commits.some(c => c.identity === 'Kid')).toBe(true)
    },
  )

  it('leaves an unrestricted session where it asked to be', async () => {
    stubServer({ bound: 1 })
    renderAt('/together', { remembered: 1 })
    await screen.findByRole('heading', { name: 'Together' }, { timeout: 5000 })
    expect(where.path).toBe('/together')
  })

  it('offers nothing extra, renders no hidden page, and bounces nobody, while the picker is asking who this is', async () => {
    // This browser remembers the Parent, an unrestricted profile. It is
    // locked, so startup cannot re-select it through the server (an unlocked
    // one would be, and that is a confirmed binding, not a guess).
    stubServer({ bindingUnreadable: true, parentLocked: true })
    const commits = renderAt('/requests', { remembered: 1 })
    // The picker opens over the page; the bar behind it must not have guessed
    // from the remembered profile, at this commit or any before it.
    await screen.findByRole('dialog', { name: "Who's watching?" }, { timeout: 10_000 })
    expect(destinations()).toEqual(['Tonight', 'Library'])
    expect(identity()).toBe('ronnie')
    expect(commits.filter(c => c.destinations.includes('Together'))).toEqual([])
    expect(commits.filter(c => c.identity === 'Parent')).toEqual([])
    // The page behind the picker is not rendered, and the URL is kept for
    // when the pick answers the question.
    expect(commits.filter(c => c.hidden !== null)).toEqual([])
    expect(where.path).toBe('/requests')
  })

  it('does not lock an unrestricted user out when the picker answers the question', async () => {
    stubServer({ bindingUnreadable: true, bound: 1 })
    const commits = renderAt('/requests')
    const picker = await screen.findByRole('dialog', { name: "Who's watching?" }, { timeout: 10_000 })
    expect(hiddenPage()).toBeNull()
    fireEvent.click(within(picker).getByRole('radio', { name: /Parent/ }))
    await settled('Parent')
    await waitFor(() => expect(hiddenPage()).toBe('requests'), { timeout: 10_000 })
    expect(where.path).toBe('/requests')
    expect(commits.filter(c => c.hidden !== null && c.identity !== 'Parent')).toEqual([])
  })

  it('does not lock anyone out when the profile list cannot be loaded at all: nothing on screen could answer the question', async () => {
    stubServer({ listFails: true, bound: 1 })
    const commits = renderAt('/together')
    // Startup settles with nothing learned. No picker can open (there is no
    // list to pick from), so the page renders: the server still answers for
    // whatever profile it has bound.
    await waitFor(() => expect(hiddenPage()).toBe('together'), { timeout: 10_000 })
    expect(identity()).toBe('ronnie')
    // The page it is let onto works: the parties are asked for and listed.
    // (They were polled only for a session known to be offered Together, so
    // this one sat on "Looking for parties…" for ever, with no request out.)
    await screen.findByText(/Live now · 3 watching Parentonly Party/, {}, { timeout: 10_000 })
    expect(screen.queryByText('Looking for parties…')).toBeNull()
    // The bar still offers no way in, and says nothing about who is
    // watching: that is for a session known to be offered Together.
    expect(destinations()).toEqual(['Tonight', 'Library'])
    expect(commits.filter(c => c.pill !== null)).toEqual([])
    expect(where.path).toBe('/together')
  })
})

describe('the admin entries, in the whole app', () => {
  it('shows an admin acting as an unrestricted profile the Admin and Server status rows, and "Requests" for everyone\'s', async () => {
    stubServer({ bound: 1, role: 'admin' })
    renderAt('/', { remembered: 1, role: 'admin' })
    await settled('Parent')
    expect(destinations()).toEqual(['Tonight', 'Library', 'Together'])
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    const menu = within(screen.getByRole('group', { name: 'Account and profiles' }))
    expect(menu.getByRole('button', { name: 'Admin' })).toBeTruthy()
    expect(menu.getByRole('button', { name: 'Server status' })).toBeTruthy()
    // An admin is listed every member's requests, and the entry says so.
    expect(menu.getByRole('button', { name: 'Requests' })).toBeTruthy()
    expect(menu.queryByRole('button', { name: 'My requests' })).toBeNull()
    fireEvent.click(menu.getByRole('button', { name: 'Requests' }))
    await screen.findByRole('heading', { name: 'Requests' }, { timeout: 10_000 })
  })

  it('shows the same admin account none of them while its session acts as a restricted profile, on any commit', async () => {
    stubServer({ bound: 2, role: 'admin' })
    const commits = renderAt('/', { remembered: 2, role: 'admin' })
    await settled('Kid')
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    const menu = within(screen.getByRole('group', { name: 'Account and profiles' }))
    for (const name of ['Admin', 'Server status', 'Requests', 'My requests']) expect(menu.queryByRole('button', { name })).toBeNull()
    expect(commits.filter(c => c.destinations.includes('Together') || c.destinations.includes('Admin'))).toEqual([])
  })

  it('does not show them before the server has said which profile an admin\'s session acts as', async () => {
    const server = stubServer({ bound: 1, role: 'admin' })
    const release = server.hold('binding')
    renderAt('/', { remembered: 1, role: 'admin' })
    await waitFor(() => expect(document.querySelector('[data-identity-trigger]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    const menu = within(screen.getByRole('group', { name: 'Account and profiles' }))
    expect(menu.queryByRole('button', { name: 'Admin' })).toBeNull()
    expect(menu.queryByRole('button', { name: 'Server status' })).toBeNull()
    release()
    await settled('Parent')
  })
})

describe('the live-party list belongs to the profile it was asked for', () => {
  it('never shows one profile\'s party under another\'s name, though both may watch together', async () => {
    // Two unrestricted profiles, so the poll runs for both and only the
    // owner key stands between one's list and the other's name.
    const second = { ...KID, name: 'Second', max_age_rating: '' }
    const server = stubServer({ bound: 1 })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const p = new URL(input, 'http://localhost').pathname
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (p === '/api/profiles') return json([PARENT, second])
      if (p === '/api/profiles/active') {
        const r = await realFetch(input, init)
        const body = await r.json() as { id: number }
        return json(body.id === 2 ? second : PARENT)
      }
      return realFetch(input, init)
    })
    const commits = renderAt('/', { remembered: 1 })
    await settled('Parent')
    await waitFor(() => expect(document.querySelector('[data-presence]')?.textContent).toContain('Parentonly Party'), { timeout: 5000 })
    // The second profile's own list is slow to arrive: the Parent's list is
    // all there is in state when the switch commits.
    const release = server.hold('parties-2')
    pickInTopBar(/Second/)
    await settled('Second')
    expect(commits.filter(c => c.identity === 'Second' && c.pill?.includes('Parentonly'))).toEqual([])
    expect(document.querySelector('[data-presence]')).toBeNull()
    release()
    await waitFor(() => expect(document.querySelector('[data-presence]')?.textContent).toContain('Kidonly Party'), { timeout: 5000 })
    expect(commits.filter(c => c.identity === 'Second' && c.pill?.includes('Parentonly'))).toEqual([])
  })
})

describe('search on a phone, whose bar has no search field', () => {
  it('the Search tab opens the results page, whose own field takes the query and gets results', async () => {
    const server = stubServer()
    renderAt('/')
    await settled('Parent')
    fireEvent.click(document.querySelector('nav.stage-tabbar [data-nav="search"]')!)
    await waitFor(() => expect(where.path).toBe('/search'))
    // The page's own field: not the bar's (the bar's is hidden below md).
    const page = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-search-results]')
      expect(el).not.toBeNull()
      return el!
    }, { timeout: 10_000 })
    const field = within(page).getByRole('searchbox', { name: 'Search titles' })
    // The tab was just pressed: the field takes focus, so typing can start.
    await waitFor(() => expect(document.activeElement).toBe(field))
    fireEvent.change(field, { target: { value: 'cozy mystery' } })
    await within(page).findByText('Found By Search', undefined, { timeout: 10_000 })
    expect(server.searches).toContain('cozy mystery')
    // Clearing the page's field stays on the page; it does not jump home.
    fireEvent.click(within(page).getByRole('button', { name: 'Clear search' }))
    expect(where.path).toBe('/search')
    expect((within(page).getByRole('searchbox', { name: 'Search titles' }) as HTMLInputElement).value).toBe('')
    expect(document.querySelector('nav.stage-tabbar [aria-current="page"]')?.getAttribute('data-nav')).toBe('search')
  })

  it('does not take focus when the page is opened any other way, so Back from a title does not reopen the keyboard', async () => {
    stubServer()
    renderAt('/search')
    await settled('Parent')
    const page = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-search-results]')
      expect(el).not.toBeNull()
      return el!
    }, { timeout: 10_000 })
    const field = within(page).getByRole('searchbox', { name: 'Search titles' })
    expect(document.activeElement).not.toBe(field)
    // Pressing the tab while already on the page does focus it.
    fireEvent.click(document.querySelector('nav.stage-tabbar [data-nav="search"]')!)
    await waitFor(() => expect(document.activeElement).toBe(field))
  })
})
