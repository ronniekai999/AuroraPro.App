// @vitest-environment jsdom
//
// A profile switch must never COMMIT the new profile's name over what App kept
// for the previous one.
//
// The defect: the commit that changes `activeProfileId` puts the new name in
// the top bar, while the hero, the rails, the grids, My Library and an open
// title are cleared only in that commit's passive effects. A switch lands from
// a resolved promise, so React may paint in between, and in the built app the
// previous profile's hero showed under the new profile's name for a frame on
// about half of all switches. Whether a paint falls in that gap depends on
// timing, so this does not try to catch a paint. It samples the DOM at every
// commit (a Profiler's onRender runs in the commit, after the DOM is written)
// and requires that no commit shows the new name beside the previous
// profile's titles. Without the fix the gap is a commit every time, so this
// fails every time, not half of the time.
//
// The whole App renders, against a fetch stub that answers for whichever
// profile the session is bound to, as the server does. Every title the Parent
// profile can see is named "Parentonly…", and the Kid profile cannot see any
// of them.
//
// The views are also held to what their cold load shows in that commit, a
// loading hero and rail skeletons on Home and the grid skeleton on My Library,
// rather than the permanent no-pick card or the empty-library message, which
// would be a new one-frame flash of their own.
//
// The same requirement holds for every commit after it, so a reset that
// cleared nothing fails here too: the switch through the picker an unreadable
// binding opens, a conversational search on screen, the grids' totals in
// Home's greeting, and requests the previous profile started that answer
// after the switch (a Load More, a first grid page, a vibe search). What no
// commit shows is not pinned: the grids' next-page resets are replaced by the
// next first page before a Load More can run.
//
// Home's own library count, in its greeting, is held to the profile the app
// acts as on every commit, from the start: after the startup load re-selects
// the profile this browser last showed (not a switch), after a switch, and
// when the previous profile's answer arrives after one. It is asked for once
// per profile, not again when the user object is replaced.

import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App'

const NOW = '2026-10-01T00:00:00Z'
const item = (id: number, title: string) => ({
  id, library_id: 1, type: 'movie', title, year: 2020, rating: 7, overview: `${title}.`, added_at: NOW, updated_at: NOW,
})
const PROFILES = [
  { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW },
  { id: 2, user_id: 1, name: 'Kid', is_default: false, created_at: NOW, updated_at: NOW, max_age_rating: 'PG' },
]
const USER = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
// What each profile may see. The server filters every list by the session's
// profile, so the mock answers from the bound one.
// The Parent's hero pool has two picks and the Kid's one, so Home's "N titles
// worth your time" count tells them apart too.
type Item = ReturnType<typeof item>
// A browse grid has two pages, so Load More has something to fetch.
const SEES: Record<number, { hero: Item[]; catalog: Item; page2: Item; vibe: Item; resume: Item; saved: Item }> = {
  1: {
    hero: [item(101, 'Parentonly Hero'), item(105, 'Parentonly Second')], catalog: item(102, 'Parentonly Catalog'),
    page2: item(106, 'Parentonly Page Two'), vibe: item(107, 'Parentonly Vibe'),
    resume: item(103, 'Parentonly Resume'), saved: item(104, 'Parentonly Saved'),
  },
  2: {
    hero: [item(201, 'Kidonly Hero')], catalog: item(202, 'Kidonly Catalog'),
    page2: item(206, 'Kidonly Page Two'), vibe: item(207, 'Kidonly Vibe'),
    resume: item(203, 'Kidonly Resume'), saved: item(204, 'Kidonly Saved'),
  },
}

/** `bindingUnreadable`: GET /api/profiles/active fails, every time, as it can
 *  when the session's row is briefly unreachable. The server still has a
 *  binding (the Parent) and answers for it.
 *
 *  `homeCountFails`: Home's own library count fails, so its greeting falls
 *  back to the browse grids' totals. The Parent's catalog totals 37 titles
 *  and the Kid's 2, so a total tells them apart.
 *
 *  `hold(key)` keeps one answer back until the returned release is called;
 *  a browse page's key is `<type>-p<page>-<bound profile>`, a vibe search's
 *  `search-<bound profile>`, Home's own library count's
 *  `count-<bound profile>`, the signed-in user's (`/api/auth/me`) `me`. An
 *  aborted request rejects as fetch's does, once its answer would have
 *  arrived.
 *
 *  `counts` lists the profile the session was bound to when each request for
 *  Home's own library count was sent; `activations`, each profile bound;
 *  `profileLists`, how many times the profile list was asked for. */
function stubServer({ bindingUnreadable = false, homeCountFails = false } = {}) {
  let bound = 1
  const holds = new Map<string, Promise<void>>()
  const counts: number[] = []
  const activations: number[] = []
  let profileLists = 0
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    // A list is answered for the binding it was asked under, even when the
    // answer arrives after a switch.
    const asked = bound
    const sees = SEES[asked]
    const page = Number(url.searchParams.get('page') ?? 1)
    // Home's own count is the one catalog list asked for with no type.
    const isCount = p === '/api/media' && !url.searchParams.has('type')
    if (isCount) counts.push(asked)
    if (p === '/api/profiles') profileLists++
    const held = holds.get(p === '/api/auth/me' ? 'me'
      : p === '/api/media/search' ? `search-${asked}`
        : p !== '/api/media' ? ''
          : isCount ? `count-${asked}` : `${url.searchParams.get('type')}-p${page}-${asked}`)
    // The Kid's answers take a moment, as a server's do. Answered at once, they
    // land in the same render as the switch's resets and would hide a reset
    // that cleared nothing: the previous profile's titles would never be
    // committed beside the Kid's name for this to see. Well over one render of
    // App: at 25ms, a slow render sometimes let them land together.
    if (bound === 2 && init?.method !== 'POST') await new Promise(done => setTimeout(done, 120))
    if (held) await held
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (p === '/api/auth/me') return json(USER)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: USER })
    if (p === '/api/profiles') return json(PROFILES)
    if (p === '/api/profiles/active') {
      return bindingUnreadable ? json({ error: 'unavailable' }, 503) : json(PROFILES.find(x => x.id === bound))
    }
    const activate = p.match(/^\/api\/profiles\/(\d+)\/activate$/)
    if (activate && init?.method === 'POST') {
      bound = Number(activate[1])
      activations.push(bound)
      return new Response(null, { status: 204 })
    }
    if (/^\/api\/profiles\/\d+\/library$/.test(p)) {
      return json([{ media_item_id: sees.saved.id, title: sees.saved.title, type: 'movie', year: 2020 }])
    }
    if (p === '/api/me/hero') return json({ picks: sees.hero.map(it => ({ item: it, reason: 'Picked for you' })), slate_token: `slate-${bound}` })
    if (p === '/api/media/recent') return json({ data: [sees.catalog] })
    if (isCount && homeCountFails) return json({ error: 'unavailable' }, 503)
    if (p === '/api/media') {
      return json({ data: [page === 1 ? sees.catalog : sees.page2], page, per_page: 1, total_items: asked === 1 ? 37 : 2, total_pages: 2 })
    }
    if (p === '/api/media/search') return json([sees.vibe])
    if (p === '/api/progress/continue') {
      const r = sees.resume
      return json([{ media_item_id: r.id, title: r.title, type: 'movie', year: 2020, position_ms: 600_000, duration_ms: 6_000_000, percent_complete: 10 }])
    }
    const title = p.match(/^\/api\/media\/(\d+)$/)
    if (title) {
      const it = [...sees.hero, sees.catalog, sees.page2, sees.vibe, sees.resume, sees.saved].find(x => x.id === Number(title[1]))
      return it ? json(it) : json({ error: { code: 404, message: 'not found' } }, 404)
    }
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    return json([])
  })
  // The event socket, and two browser APIs App's layout uses that jsdom lacks.
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  return {
    counts,
    activations,
    get profileLists() { return profileLists },
    hold(key: string) {
      let release!: () => void
      holds.set(key, new Promise<void>(done => { release = done }))
      return () => { holds.delete(key); release() }
    },
  }
}
let server: ReturnType<typeof stubServer>

interface Commit {
  /** The top bar's profile name. */
  label: string | null
  /** Any Parent-only title, in the page's text or in a label that names one. */
  parentTitles: boolean
  /** The Parent's pick count in Home's greeting. */
  parentCount: boolean
  /** The hero's no-pick card (an empty library), not its loading skeleton. */
  noPickCard: boolean
  /** Home's rails are up, or their skeleton is. */
  railsOrSkeleton: boolean
  /** My Library's empty-state message. */
  libraryEmpty: boolean
  /** The Parent's catalog total in Home's greeting. */
  parentTotal: boolean
}

/** Samples the page at every commit. */
function renderApp(path: string) {
  const commits: Commit[] = []
  const onRender = () => {
    const text = document.body.textContent ?? ''
    const named = [...document.querySelectorAll('[aria-label], img[alt], [title]')]
      .map(el => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('alt') ?? ''} ${el.getAttribute('title') ?? ''}`)
    commits.push({
      label: document.querySelector('button[title^="Switch profile"] span.truncate')?.textContent ?? null,
      parentTitles: `${text} ${named.join(' ')}`.includes('Parentonly'),
      parentCount: text.includes('2 titles worth your time'),
      // The skeleton keeps this heading too, but only for assistive tech.
      noPickCard: [...document.querySelectorAll('h2')].some(h => h.textContent === 'Welcome to Aurora' && !h.classList.contains('sr-only')),
      railsOrSkeleton: !!document.querySelector('.rail-title') || text.includes('Loading your library…'),
      libraryEmpty: text.includes('No saved titles yet'),
      parentTotal: /\b37 titles in your library/.test(text),
    })
  }
  render(<Profiler id="app" onRender={onRender}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Profiler>)
  return commits
}

function switchToKid() {
  fireEvent.click(document.querySelector('button[title^="Switch profile"]')!)
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Kid/ }))
}

/** The commits that showed the Kid profile's name over a Parent-only title. */
const kidOverParent = (commits: Commit[]) => commits.filter(c => c.label === 'Kid' && c.parentTitles).length
const kid = (commits: Commit[]) => commits.filter(c => c.label === 'Kid')

function signedIn() {
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify(USER))
  // The "Who's watching?" gate opens on a first visit to a multi-profile account.
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
  server = stubServer()
}

describe('a profile switch never commits the new name over the previous profile’s titles', () => {
  beforeEach(signedIn)
  afterEach(() => { vi.unstubAllGlobals() })

  it('on Home: the hero, the rails and Continue Watching', async () => {
    const commits = renderApp('/')
    await screen.findByLabelText('More info about Parentonly Hero', undefined, { timeout: 5000 })
    await screen.findAllByText('Parentonly Resume', undefined, { timeout: 5000 })
    // Not vacuous: the Parent's name stood over the Parent's titles and count.
    expect(commits.some(c => c.label === 'Parent' && c.parentTitles)).toBe(true)
    expect(commits.some(c => c.label === 'Parent' && c.parentCount)).toBe(true)

    switchToKid()
    await screen.findByLabelText('More info about Kidonly Hero', undefined, { timeout: 5000 })
    await screen.findAllByText('Kidonly Resume', undefined, { timeout: 5000 })
    expect(kidOverParent(commits)).toBe(0)
    expect(kid(commits).filter(c => c.parentCount)).toEqual([])
    expect(kid(commits).filter(c => c.noPickCard)).toEqual([])
    expect(kid(commits).filter(c => !c.railsOrSkeleton)).toEqual([])
  })

  it.each([['Movies', '/movies'], ['TV Shows', '/shows']])('on the %s grid', async (_name, path) => {
    const commits = renderApp(path)
    await screen.findAllByText('Parentonly Catalog', undefined, { timeout: 5000 })
    switchToKid()
    await screen.findAllByText('Kidonly Catalog', undefined, { timeout: 5000 })
    expect(kid(commits).length).toBeGreaterThan(0)
    expect(kidOverParent(commits)).toBe(0)
  })

  // What a switch must also stop: a request the previous profile started that
  // answers after it. Each is held until the switch is done, then let go.
  it.each([['Movies', '/movies', 'movie'], ['TV Shows', '/shows', 'show']])(
    'drops a %s Load More that was in flight', async (_name, path, type) => {
      const commits = renderApp(path)
      await screen.findAllByText('Parentonly Catalog', undefined, { timeout: 5000 })
      const release = server.hold(`${type}-p2-1`)
      fireEvent.click(screen.getByRole('button', { name: /^Load \d+ more$/ }))
      switchToKid()
      await screen.findAllByText('Kidonly Catalog', undefined, { timeout: 5000 })
      release()
      await new Promise(done => setTimeout(done, 100))
      expect(screen.queryAllByText('Parentonly Page Two')).toEqual([])
      expect(kidOverParent(commits)).toBe(0)
      // The Kid's own Load More is not left spinning: the Parent's handler no
      // longer owns the loading flag, so only the switch's reset clears it.
      expect(screen.getByRole('button', { name: 'Load 1 more' })).toBeEnabled()
    })

  it.each([['Movies', '/movies', 'movie'], ['TV Shows', '/shows', 'show']])(
    'drops a first %s page that was in flight, and asks again', async (_name, path, type) => {
      const release = server.hold(`${type}-p1-1`)
      const commits = renderApp(path)
      const label = () => document.querySelector('button[title^="Switch profile"] span.truncate')?.textContent
      await waitFor(() => expect(label()).toBe('Parent'), { timeout: 5000 })
      switchToKid()
      await waitFor(() => expect(label()).toBe('Kid'), { timeout: 5000 })
      release()
      await screen.findAllByText('Kidonly Catalog', undefined, { timeout: 5000 })
      expect(kidOverParent(commits)).toBe(0)
    })

  it('drops a vibe search that was in flight', async () => {
    const commits = renderApp('/')
    await screen.findByLabelText('More info about Parentonly Hero', undefined, { timeout: 5000 })
    const release = server.hold('search-1')
    fireEvent.change(screen.getByLabelText('Describe a vibe to search by'), { target: { value: 'cozy' } })
    fireEvent.click(document.querySelector('.convo-search button[aria-label="Search"]')!)
    await screen.findByText('Sensing the vibe...', undefined, { timeout: 5000 })
    switchToKid()
    await screen.findByLabelText('More info about Kidonly Hero', undefined, { timeout: 5000 })
    await screen.findAllByText('Kidonly Resume', undefined, { timeout: 5000 })
    release()
    await new Promise(done => setTimeout(done, 100))
    expect(screen.queryAllByText('Parentonly Vibe')).toEqual([])
    // Nor is the Kid's Home left showing the search as still running.
    expect(screen.queryByText('Sensing the vibe...')).toBeNull()
    expect(kidOverParent(commits)).toBe(0)
  })

  // Home's greeting counts the library from its own fetch, or, when that
  // failed, from the browse grids' totals, which are the Parent's until the
  // switch clears them. One grid each, so the greeting's total is that grid's.
  it.each([['Movies', '/movies'], ['Shows', '/shows']])(
    "does not count the Parent's library in Home's greeting from the %s total", async (_grid, path) => {
      vi.unstubAllGlobals()
      server = stubServer({ homeCountFails: true })
      const commits = renderApp(path)
      await screen.findAllByText('Parentonly Catalog', undefined, { timeout: 5000 })
      fireEvent.click([...document.querySelectorAll('button.stage-tab')].find(b => b.textContent === 'Home')!)
      // Not vacuous: the fallback did put the Parent's total in the greeting.
      await waitFor(() => expect(document.body.textContent).toMatch(/\b37 titles in your library/), { timeout: 5000 })
      switchToKid()
      await screen.findByLabelText('More info about Kidonly Hero', undefined, { timeout: 5000 })
      expect(kid(commits).filter(c => c.parentTotal)).toEqual([])
      expect(kidOverParent(commits)).toBe(0)
    })

  it('clears a conversational search', async () => {
    const commits = renderApp('/')
    await screen.findByLabelText('More info about Parentonly Hero', undefined, { timeout: 5000 })
    fireEvent.change(screen.getByLabelText('Describe a vibe to search by'), { target: { value: 'cozy' } })
    fireEvent.click(document.querySelector('.convo-search button[aria-label="Search"]')!)
    await screen.findAllByText('Parentonly Vibe', undefined, { timeout: 5000 })
    switchToKid()
    await screen.findByLabelText('More info about Kidonly Hero', undefined, { timeout: 5000 })
    await screen.findAllByText('Kidonly Resume', undefined, { timeout: 5000 })
    expect(kidOverParent(commits)).toBe(0)
  })

  it('on My Library', async () => {
    const commits = renderApp('/library')
    await screen.findAllByText('Parentonly Saved', undefined, { timeout: 5000 })
    switchToKid()
    await screen.findAllByText('Kidonly Saved', undefined, { timeout: 5000 })
    expect(kidOverParent(commits)).toBe(0)
    expect(kid(commits).filter(c => c.libraryEmpty)).toEqual([])
  })

  it('on an open title the new profile may not see', async () => {
    const commits = renderApp('/title/101')
    await screen.findAllByText('Parentonly Hero', undefined, { timeout: 5000 })
    switchToKid()
    // The hydration asks again, is refused, and goes Home.
    await screen.findByLabelText('More info about Kidonly Hero', undefined, { timeout: 5000 })
    expect(kidOverParent(commits)).toBe(0)
  })

  // The binding could not be read at startup, so the app knows no profile and
  // forces the picker. The catalog loads behind it anyway, under the binding
  // the server does have (here the Parent's). A pick from the picker is a
  // switch away from that, not the startup binding arriving.
  it.each([['Home', '/', 'Parentonly Catalog'], ['the Movies grid', '/movies', 'Parentonly Catalog']])(
    'on %s, after a pick from the picker the unreadable binding opened', async (_name, path, parentTitle) => {
      vi.unstubAllGlobals()
      server = stubServer({ bindingUnreadable: true })
      const commits = renderApp(path)
      await screen.findAllByText(parentTitle, undefined, { timeout: 5000 })
      const picker = await screen.findByRole('dialog', { name: "Who's watching?" }, { timeout: 5000 })
      fireEvent.click(within(picker).getByRole('radio', { name: /Kid/ }))
      await screen.findAllByText('Kidonly Catalog', undefined, { timeout: 5000 })
      expect(kid(commits).length).toBeGreaterThan(0)
      expect(kidOverParent(commits)).toBe(0)
    })
})

// Home's greeting counts the library from its own fetch ("N titles in your
// library"), and the server counts what the session's profile may see: the
// Parent's catalog totals 37 titles and the Kid's 2. No commit may show one
// profile's count while the app acts as another.
describe('Home’s library count is the acting profile’s', () => {
  beforeEach(signedIn)
  afterEach(() => { vi.unstubAllGlobals() })

  const total = (n: number) => new RegExp(`\\b${n} titles in your library`)
  const greetingCounts = (n: number) =>
    waitFor(() => expect(document.body.textContent).toMatch(total(n)), { timeout: 5000 })

  // A fresh sign-in on a browser the Kid last used: the server binds the
  // default (the Parent), then the startup load re-selects the Kid. That is
  // not a switch, and resets nothing, so a count asked before it would stay
  // the Parent's.
  it('after the startup load re-selects the remembered profile', async () => {
    localStorage.setItem('aurora_active_profile_id', '2')
    // A cold start shows the cached user at once and replaces it with the
    // server's answer for /me, held here until the startup load has settled.
    const releaseUser = server.hold('me')
    const commits = renderApp('/')
    await greetingCounts(2)
    // Not vacuous: the session was the Parent's until the re-selection.
    expect(server.activations).toEqual([2])
    expect(commits.filter(c => c.parentTotal)).toEqual([])
    // Asked once, after the startup load settled.
    expect(server.counts).toEqual([2])
    // The new user object changes neither the session nor its profile, so the
    // count is not asked again. The profile load, keyed on the user object,
    // asks for the list again in the effects of the commit that replaced it,
    // so once it has, a count keyed on the user object would have been asked
    // too.
    const lists = server.profileLists
    releaseUser()
    await waitFor(() => expect(server.profileLists).toBe(lists + 1), { timeout: 5000 })
    expect(server.counts).toEqual([2])
    expect(document.body.textContent).toMatch(total(2))
  })

  it.each([
    ['through the top bar', false],
    ['through the picker an unreadable binding opens', true],
  ])('after a switch %s', async (_how, bindingUnreadable) => {
    vi.unstubAllGlobals()
    server = stubServer({ bindingUnreadable })
    const commits = renderApp('/')
    // Not vacuous: the greeting counted the Parent's library first (with the
    // binding unreadable, behind the picker, under the binding the server
    // does have).
    await greetingCounts(37)
    if (bindingUnreadable) {
      const picker = await screen.findByRole('dialog', { name: "Who's watching?" }, { timeout: 5000 })
      fireEvent.click(within(picker).getByRole('radio', { name: /Kid/ }))
    } else {
      switchToKid()
    }
    await greetingCounts(2)
    expect(kid(commits).length).toBeGreaterThan(0)
    expect(kid(commits).filter(c => c.parentTotal)).toEqual([])
    // Once for each profile.
    expect(server.counts).toEqual([1, 2])
  })

  it('drops an answer for the previous profile that arrives after a switch', async () => {
    const release = server.hold('count-1')
    const commits = renderApp('/')
    await screen.findByLabelText('More info about Parentonly Hero', undefined, { timeout: 5000 })
    await waitFor(() => expect(server.counts).toEqual([1]), { timeout: 5000 })
    switchToKid()
    await greetingCounts(2)
    release()
    await new Promise(done => setTimeout(done, 100))
    expect(document.body.textContent).toMatch(total(2))
    expect(commits.filter(c => c.parentTotal)).toEqual([])
  })

  // Back on the Parent before the Kid's count landed, the greeting waits for
  // the Parent's new answer rather than showing the one from before the
  // switch: kept, the same user and profile coming back (a sign-out and
  // sign-in in this tab, say) would show an answer from another session.
  it('asks again after a switch away and back, showing no earlier answer', async () => {
    const commits = renderApp('/')
    await greetingCounts(37)
    const releaseKid = server.hold('count-2')
    switchToKid()
    await waitFor(() => expect(server.counts).toEqual([1, 2]), { timeout: 5000 })
    const release = server.hold('count-1')
    // Every commit from the click back on, until the Parent's new answer.
    const since = commits.length
    fireEvent.click(document.querySelector('button[title^="Switch profile"]')!)
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Parent/ }))
    await waitFor(() => expect(server.counts).toEqual([1, 2, 1]), { timeout: 5000 })
    expect(commits[commits.length - 1].label).toBe('Parent')
    await new Promise(done => setTimeout(done, 100))
    expect(commits.slice(since).filter(c => c.parentTotal)).toEqual([])
    release()
    await greetingCounts(37)
    releaseKid()
  })
})
