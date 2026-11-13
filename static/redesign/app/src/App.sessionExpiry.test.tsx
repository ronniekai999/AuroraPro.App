// @vitest-environment jsdom
//
// A session that expires must not hand what App kept for its user to whoever
// signs in next on the tab.
//
// An expiry (api.ts's SESSION_EXPIRED_EVENT, fired when the server rejects a
// refresh) used to be a bare setUser(false): the sign-in page went up and
// everything App held for the user stayed in its state. On an account with
// profiles the profile going to null ran the switch's resets, which covered
// some of it; on an account the app knew no profile for nothing changed, and
// the next account to sign in was shown the previous one's grids and their
// totals, the title it had open, its requests, its unread count and its
// Home, had the previous one's title booted in the player, and was in its
// watch party. (The grids were never even asked again: their effect fetches
// only an empty list.)
//
// The whole App renders, against a fetch stub that answers for whichever
// account is signed in, as the server does. Everything the first account
// (Avery) has is named "Averyonly…", its catalog totals 4,321 titles, and
// it has five unread notifications; the second account (Blake) has its own
// "Blakeonly…" titles, a total of 2 and nothing unread, and cannot see
// Avery's open title. Blake's answers take a moment, as a server's do, so a
// commit drawn before they land shows whatever App kept. The page is sampled
// at every commit (a Profiler's onRender runs in the commit, after the DOM is
// written), and no commit after Blake signs in may show anything of Avery's.
//
// Where the user was is kept on purpose: the address (and the grids' sorts)
// survive an expiry, so the same person signing in again is back on the page
// they were on, with its data asked for again; and a link followed at a cold
// load whose stored session turns out to be dead (the expiry fires then too)
// still opens after the sign-in.

import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import App from './App'
import { pageText } from '@/test/pageText'

// The player is replaced by a marker that says what it was asked to play.
vi.mock('@/components/VideoPlayer', async (original) => ({
  ...(await original<typeof import('@/components/VideoPlayer')>()),
  VideoPlayer: ({ target }: { target: { mediaItemId: number } | null }) =>
    target ? <div data-test-player data-media={target.mediaItemId} /> : null,
}))

const NOW = '2026-10-01T00:00:00Z'
const item = (id: number, title: string, type = 'movie') => ({
  id, library_id: 1, type, title, year: 2020, rating: 7, overview: `${title}.`, added_at: NOW, updated_at: NOW,
})
type Item = ReturnType<typeof item>
interface Account {
  user: { id: number; username: string; email: string; role: string }
  pick: Item; recent: Item; movie: Item; show: Item; title: Item; resume: Item; gem: Item
  request: string; notice: string; total: number; unread: number
}
const account = (id: number, username: string, name: string, total: number, unread: number): Account => ({
  user: { id, username, email: `${username}@example.test`, role: 'user' },
  pick: item(id * 100 + 1, `${name}only Pick`), recent: item(id * 100 + 2, `${name}only Recent`),
  movie: item(id * 100 + 3, `${name}only Movie`), show: item(id * 100 + 4, `${name}only Show`, 'show'),
  title: item(id * 100 + 5, `${name}only Title`), resume: item(id * 100 + 6, `${name}only Resume`),
  gem: item(id * 100 + 7, `${name}only Gem`),
  request: `${name}only Request`, notice: `${name}only Notice`, total, unread,
})
const AVERY = account(1, 'avery', 'Avery', 4321, 5)
const BLAKE = account(2, 'blake', 'Blake', 2, 0)
const ACCOUNTS: Record<number, Account> = { 1: AVERY, 2: BLAKE }
/** A socket the test drives: the party's room socket is opened and spoken
 *  to by hand; every other socket (the event socket) just sits there. */
class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  sent: { type: string }[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readonly url: string
  constructor(url: string) { this.url = url; FakeSocket.all.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  addEventListener() {}
  removeEventListener() {}
  open() { this.readyState = 1; this.onopen?.() }
  receive(type: string, payload?: unknown) { this.onmessage?.({ data: JSON.stringify({ type, payload }) }) }
}
const PARTY_CODE = 'AVPRTY'
/** Answers the stub has not given yet. Blake's are delayed, so a test can end
 *  with some out; they are let land before the page's window goes (see
 *  afterEach), or a component's handler runs after it and React, setting
 *  state, finds no window. */
const inFlight = new Set<Promise<Response>>()

/** Blake's one profile, when `blakeProfile` gives Blake's account one. */
const BLAKE_PROFILE = { id: 20, user_id: 2, name: 'Blakes', is_default: true, created_at: NOW, updated_at: NOW }

/** `signedIn`: the account the server's session is for at the start (null:
 *  the stored session is dead, and every request but a sign-in is refused).
 *  `blakeProfile`: Blake's account has a profile (Avery's never does).
 *
 *  `gridAsks` lists each request for a browse grid's page, as `<type>-<account>`;
 *  `titleReads`, each read of a title by id, as `<id>-<account>`. */
function stubServer({ signedIn: startAs = 1 as number | null, blakeProfile = false, partySockets = false } = {}) {
  let signedIn = startAs
  const gridAsks: string[] = []
  const titleReads: string[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const refused = () => json({ error: { code: 401, message: 'session ended' } }, 401)
  const answer = async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    if (p === '/api/auth/oauth/providers') return json({ providers: [] })
    if (p === '/api/auth/login' && init?.method === 'POST') {
      const { username } = JSON.parse(String(init.body)) as { username: string }
      const who = Object.values(ACCOUNTS).find(a => a.user.username === username)
      if (!who) return json({ error: { code: 401, message: 'invalid credentials' } }, 401)
      signedIn = who.user.id
      return json({ expires_in: 900, user: who.user })
    }
    if (signedIn === null) return refused()
    const asked = signedIn
    const a = ACCOUNTS[asked]
    // Blake's answers take a moment. Answered at once, they could land in the
    // same render as the sign-in and hide state that was kept: Avery's would
    // never be committed beside Blake's session for this to see.
    if (asked === 2) await new Promise(done => setTimeout(done, 120))
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    // The session ended while this was out: refused, as the server would.
    if (signedIn !== asked) return refused()
    if (p === '/api/auth/me') return json(a.user)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: a.user })
    const hasProfile = asked === 2 && blakeProfile
    if (p === '/api/profiles') return json(hasProfile ? [BLAKE_PROFILE] : [])
    if (p === '/api/profiles/active') {
      return hasProfile ? json(BLAKE_PROFILE) : json({ error: { code: 404, message: 'no profile' } }, 404)
    }
    if (p === '/api/me/hero') return json({ picks: [{ item: a.pick, reason: 'Picked for you' }], slate_token: `slate-${asked}` })
    if (p.startsWith('/api/me/discover')) {
      return json({ rails: [{ title: 'Hidden gems for you', description: 'Picked for your taste', items: [a.gem] }] })
    }
    if (p === '/api/progress/continue') {
      const r = a.resume
      return json([{ media_item_id: r.id, title: r.title, type: 'movie', year: 2020, position_ms: 600_000, duration_ms: 6_000_000, percent_complete: 10 }])
    }
    if (p === '/api/media/recent') return json({ data: [a.recent] })
    if (p === '/api/media') {
      const type = url.searchParams.get('type')
      if (type) gridAsks.push(`${type}-${asked}`)
      const data = type === 'show' ? a.show : type === 'movie' ? a.movie : a.recent
      return json({ data: [data], page: 1, per_page: 1, total_items: a.total, total_pages: a.total })
    }
    if (/^\/api\/media\/\d+\/files$/.test(p)) return json([{ id: 9000 + Number(p.split('/')[3]), media_item_id: Number(p.split('/')[3]), resolution: '1080p' }])
    const byId = p.match(/^\/api\/media\/(\d+)$/)
    if (byId) {
      titleReads.push(`${byId[1]}-${asked}`)
      const it = [a.pick, a.recent, a.movie, a.show, a.title, a.resume, a.gem].find(x => x.id === Number(byId[1]))
      return it ? json(it) : json({ error: { code: 404, message: 'not found' } }, 404)
    }
    if (p === '/api/requests') {
      return json([{
        id: asked * 10, user_id: asked, media_type: 'movie', tmdb_id: asked * 1000, title: a.request, poster_path: '',
        overview: '', year: 2020, status: 'pending', quality_1080p: true, quality_4k: false, requested_at: NOW, updated_at: NOW,
      }])
    }
    if (p === '/api/requests/config') return json({ enabled: true, has_radarr: true, has_sonarr: true })
    if (p === '/api/me/notifications') {
      return json({
        notifications: Array.from({ length: a.unread }, (_, i) => ({
          id: asked * 100 + i, user_id: asked, type: 'request_available', title: a.notice, created_at: NOW, read_at: null,
        })),
        unread: a.unread,
      })
    }
    if (p === `/api/code/${PARTY_CODE}/info`) return json({ type: 'active', code: PARTY_CODE })
    if (p === '/api/parties/active') return json({ parties: [] })
    if (p === '/api/me/party-invites') return json({ invites: [] })
    return json([])
  }
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const answered = answer(input, init)
    inFlight.add(answered)
    answered.then(() => inFlight.delete(answered), () => inFlight.delete(answered))
    return answered
  })
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', partySockets ? FakeSocket : class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  type Seen = (entries: { isIntersecting: boolean; intersectionRatio: number }[]) => void
  vi.stubGlobal('IntersectionObserver', class {
    private live = true
    private cb: Seen
    constructor(cb: Seen) { this.cb = cb }
    observe() { queueMicrotask(() => { if (this.live) this.cb([{ isIntersecting: true, intersectionRatio: 1 }]) }) }
    unobserve() {}
    disconnect() { this.live = false }
  })
  return {
    gridAsks,
    titleReads,
    /** The server ends the session: every request is refused until the next
     *  sign-in, and the app is told so, as api.ts tells it when a refresh is
     *  rejected (endSession clears the stored user, then fires the event). */
    expire() {
      signedIn = null
      act(() => {
        localStorage.removeItem('aurora_user')
        window.dispatchEvent(new Event('aurora:session-expired'))
      })
    },
  }
}

interface Commit {
  /** Whose app is drawn: the account menu's "Signed in as …", or null on
   *  the sign-in page. */
  signedInAs: string | null
  /** Anything of Avery's: a title, a request or a notification in the page's
   *  text or in a label that names one. */
  avery: boolean
  /** Avery's catalog total (4,321; 4,320 left to load), anywhere. */
  averyTotal: boolean
  /** Avery's unread count, which the account menu says to assistive tech. */
  averyUnread: boolean
  /** The title the player is up for, if it is. */
  player: string | null
}

/** Where the app is, without putting the address in the page's text. */
function Where() {
  const loc = useLocation()
  return <div data-test-where={`${loc.pathname}${loc.search}`} hidden />
}
const where = () => document.querySelector('[data-test-where]')?.getAttribute('data-test-where') ?? null

function renderApp(path: string, opts: Parameters<typeof stubServer>[0] = {}) {
  localStorage.clear()
  // The stored user is the sign-in a fresh tab renders with at once.
  localStorage.setItem('aurora_user', JSON.stringify(AVERY.user))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
  const server = stubServer(opts)
  const commits: Commit[] = []
  const onRender = () => {
    const text = pageText()
    const named = [...document.querySelectorAll('[aria-label], img[alt], [title]')]
      .map(el => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('alt') ?? ''} ${el.getAttribute('title') ?? ''}`)
      .join(' ')
    commits.push({
      signedInAs: document.querySelector('[data-identity-trigger]')?.getAttribute('title') ?? null,
      avery: `${text} ${named}`.includes('Averyonly'),
      averyTotal: /4,?32[01]/.test(`${text} ${named}`),
      averyUnread: /\b5 unread notification/.test(text),
      player: document.querySelector('[data-test-player]')?.getAttribute('data-media') ?? null,
    })
  }
  render(
    <Profiler id="app" onRender={onRender}>
      <MemoryRouter initialEntries={[path]}><App /><Where /></MemoryRouter>
    </Profiler>,
  )
  return { ...server, commits }
}

const find = { timeout: 5000 }

async function signInAs(who: Account) {
  const username = await screen.findByLabelText('Username', {}, find)
  fireEvent.change(username, { target: { value: who.user.username } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

/** What each page shows an account once its own answers are in. */
const PAGES: { path: string; shows: (a: Account) => string }[] = [
  { path: '/', shows: a => a.recent.title },
  { path: '/movies', shows: a => a.movie.title },
  { path: '/shows', shows: a => a.show.title },
  // Blake cannot see the title Avery had open: the hydration under Blake's
  // session is refused, and the app leaves it for Home.
  { path: `/title/${AVERY.title.id}`, shows: a => (a === AVERY ? a.title.title : a.recent.title) },
  { path: '/requests', shows: a => a.request },
]

afterEach(async () => {
  cleanup()
  // What was out when the test ended lands now, on the unmounted app, while
  // there is still a window; the handlers it runs may ask for more.
  while (inFlight.size) await Promise.allSettled([...inFlight])
  await new Promise(done => setTimeout(done, 0))
  vi.unstubAllGlobals()
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe.each([
  { blakeProfile: false, label: 'an account with no profile either' },
  { blakeProfile: true, label: 'an account with a profile' },
])('a session that expires on an account with no profile, then a sign-in as $label', ({ blakeProfile }) => {
  it.each(PAGES)('shows nothing of the previous account on $path', async ({ path, shows }) => {
    const page = renderApp(path, { blakeProfile })
    // Not vacuous: Avery's page, total (on the grids) and unread count are up.
    await screen.findAllByText(shows(AVERY), undefined, find)
    await waitFor(() => expect(page.commits.at(-1)!.averyUnread).toBe(true), find)
    if (path === '/movies' || path === '/shows') expect(page.commits.at(-1)!.averyTotal).toBe(true)
    expect(page.commits.at(-1)!.avery).toBe(true)

    page.expire()
    await signInAs(BLAKE)
    const since = page.commits.length
    await screen.findAllByText(shows(BLAKE), undefined, find)
    // A moment more, for anything still to land.
    await act(() => new Promise(done => setTimeout(done, 400)))
    expect(screen.queryByLabelText('Username')).toBeNull()
    const after = page.commits.slice(since)
    expect(after.some(c => c.signedInAs === 'Signed in as blake')).toBe(true)
    expect(after.filter(c => c.avery)).toEqual([])
    expect(after.filter(c => c.averyTotal)).toEqual([])
    expect(after.filter(c => c.averyUnread)).toEqual([])
  }, 20_000)
})

describe('a session that expires, then a sign-in as the same account', () => {
  it('is back on the grid it was on, asked for again', async () => {
    const page = renderApp('/movies')
    await screen.findAllByText(AVERY.movie.title, undefined, find)
    const asked = page.gridAsks.filter(x => x === 'movie-1').length

    page.expire()
    await signInAs(AVERY)
    await waitFor(() => expect(page.gridAsks.filter(x => x === 'movie-1').length).toBeGreaterThan(asked), find)
    await screen.findAllByText(AVERY.movie.title, undefined, find)
    expect(where()).toBe('/movies')
  }, 20_000)

  it('is back on the title it had open, read again under the new session', async () => {
    const page = renderApp(`/title/${AVERY.title.id}`)
    await screen.findAllByText(AVERY.title.title, undefined, find)
    const reads = page.titleReads.length

    page.expire()
    await signInAs(AVERY)
    await waitFor(() => expect(page.titleReads.length).toBeGreaterThan(reads), find)
    await screen.findAllByText(AVERY.title.title, undefined, find)
    expect(where()).toBe(`/title/${AVERY.title.id}`)
  }, 20_000)
})

describe('the player across an expiry', () => {
  it.each([
    { next: BLAKE, label: 'another account' },
    { next: AVERY, label: 'the same account' },
  ])('is closed, and not booted again for $label', async ({ next }) => {
    const page = renderApp('/')
    // Tonight's hero leads with the title Avery left unfinished.
    await screen.findAllByText(AVERY.resume.title, undefined, find)
    const hero = await waitFor(() => {
      const section = document.querySelector<HTMLElement>('section[data-hero-kind]')
      expect(section).not.toBeNull()
      return section!
    }, find)
    fireEvent.click(within(hero).getByRole('button', { name: /^Resume/ }))
    await waitFor(() => expect(page.commits.at(-1)!.player).toBe(String(AVERY.resume.id)), find)

    page.expire()
    await signInAs(next)
    const since = page.commits.length
    await screen.findAllByText(next.recent.title, undefined, find)
    await act(() => new Promise(done => setTimeout(done, 400)))
    expect(page.commits.slice(since).filter(c => c.player !== null)).toEqual([])
  }, 20_000)
})

// The party hook lives above the sign-in page, so its sockets, opened under
// the session that ended, stayed in the room through an expiry: the tab sat
// on the sign-in page as a participant, and whoever signed in next was in
// the room as the previous account. An expiry now leaves it, as a sign-out
// does.
describe('a watch party across an expiry', () => {
  it('is left, and not handed to the next account', async () => {
    // A party link, as the server redirects /p/{code} to it. The magic-link
    // join reads the browser's address, not the router's.
    window.history.replaceState({}, '', `/p/${PARTY_CODE}`)
    const page = renderApp('/', { partySockets: true })
    const room = await waitFor(() => {
      const found = FakeSocket.all.find(x => x.url.includes('/ws/party-room'))
      expect(found).toBeDefined()
      return found!
    }, find)
    act(() => {
      room.open()
      room.receive('party-state', {
        party: {
          code: PARTY_CODE, revision: 1, media_item_id: AVERY.recent.id, episode_id: null, party_name: 'Averyonly Party',
          host_user_id: 9, media_title: AVERY.recent.title, current_time_ms: 0, is_playing: false,
          scheduled_start_at: null, started_at: null,
        },
        participants: [], chat_history: [],
      })
    })
    // Not vacuous: the party is up in the tab.
    await screen.findAllByText('Averyonly Party', undefined, find)

    page.expire()
    // The room is told, and its socket closed.
    expect(room.sent).toContainEqual({ type: 'leave-party' })
    expect(room.readyState).toBe(3)

    await signInAs(BLAKE)
    const since = page.commits.length
    await screen.findAllByText(BLAKE.recent.title, undefined, find)
    await act(() => new Promise(done => setTimeout(done, 400)))
    expect(page.commits.slice(since).filter(c => c.avery)).toEqual([])
    expect(screen.queryByText('Averyonly Party')).toBeNull()
  }, 20_000)
})

// The expiry also fires at a cold load whose stored session turns out to be
// dead: the tab renders at once for the stored user, its first requests are
// refused, and so is the refresh. The address there is a link just followed,
// and the sign-in that follows opens it, as it did before an expiry cleared
// anything; a sign-out's trip to Home would lose it.
describe('a link followed at a cold load with a dead session', () => {
  it('opens after the sign-in', async () => {
    renderApp(`/title/${BLAKE.title.id}`, { signedIn: null })
    await signInAs(BLAKE)
    const heading = await screen.findByRole('heading', { name: BLAKE.title.title }, find)
    expect(heading).toBeInTheDocument()
    expect(where()).toBe(`/title/${BLAKE.title.id}`)
  }, 20_000)

  it('keeps a TV\'s code in the address for the device page', async () => {
    renderApp('/device?code=ABCD12', { signedIn: null })
    await signInAs(BLAKE)
    await waitFor(() => expect(screen.queryByLabelText('Username')).toBeNull(), find)
    expect(where()).toBe('/device?code=ABCD12')
    const field = await screen.findByDisplayValue('ABCD12', undefined, find)
    expect(within(document.body).getByDisplayValue('ABCD12')).toBe(field)
  }, 20_000)
})
