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
// binding opens, a search by description on screen, the grids' totals in
// Tonight's closing line, and requests the previous profile started that
// answer after the switch (a Load More, a first grid page, a search by
// description).
// What no commit shows is not pinned: the grids' next-page resets are
// replaced by the next first page before a Load More can run.
//
// Home's own library count, in the closing line under its rails ("N titles
// worth your time out of the T titles in your library"; it used to open the
// page, in a greeting), is held to the profile the app acts as on every
// commit, from the start: after the startup load re-selects the profile this
// browser last showed (not a switch), after a switch, and when the previous
// profile's answer arrives after one. It is asked for once per profile, not
// again when the user object is replaced.
//
// Tonight's hero leads with the title the profile left unfinished
// ("…Resume"), with Aurora's picks ("…Hero", "…Second") in the filmstrip
// beside it. The Kid has a content limit, so its Tonight is the calmer one:
// that title, two actions, no filmstrip, and a closing line that states the
// limit instead of counting picks. `kidUnrestricted` gives the Kid the same
// page as the Parent, so a pick or a count kept from the Parent would show.

import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App'
import { pageText } from '@/test/pageText'

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
 *  `homeCountFails`: Home's own library count fails, so its closing line falls
 *  back to the browse grids' totals. The Parent's catalog totals 37 titles
 *  and the Kid's 2, so a total tells them apart.
 *
 *  `hold(key)` keeps one answer back until the returned release is called;
 *  a browse page's key is `<type>-p<page>-<bound profile>`, a search's
 *  `search-<bound profile>`, Home's own library count's
 *  `count-<bound profile>`, Continue Watching's `continue-<bound profile>`,
 *  the signed-in user's (`/api/auth/me`) `me`. An
 *  aborted request rejects as fetch's does, once its answer would have
 *  arrived.
 *
 *  `counts` lists the profile the session was bound to when each request for
 *  Home's own library count was sent; `activations`, each profile bound;
 *  `profileLists`, how many times the profile list was asked for;
 *  `heroPools`, the profile each answered request for Aurora's picks was
 *  answered for; `searches`, the profile each search was asked under and
 *  how it was asked for (`literal`: by title; `semantic`: by description,
 *  which costs the server a model call). */
function stubServer({ bindingUnreadable = false, homeCountFails = false, kidUnrestricted = false } = {}) {
  // `kidUnrestricted`: the Kid profile has no content limit. A restricted
  // profile is not shown My Library at all, so a switch on that page is held
  // to the rule between two profiles that both may open it.
  const profiles = kidUnrestricted ? PROFILES.map(p => ({ ...p, max_age_rating: undefined })) : PROFILES
  let bound = 1
  const holds = new Map<string, Promise<void>>()
  const counts: number[] = []
  const activations: number[] = []
  const heroPools: number[] = []
  // Profiles whose own list ("My Library") the server fails to answer for.
  const listFails = new Set<number>()
  const searches: { asked: number; mode: string | null }[] = []
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
    if (p === '/api/media/search') searches.push({ asked, mode: url.searchParams.get('mode') })
    if (p === '/api/profiles') profileLists++
    const held = holds.get(p === '/api/auth/me' ? 'me'
      : p === '/api/media/search' ? `search-${asked}`
        : p === '/api/progress/continue' ? `continue-${asked}`
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
    if (p === '/api/profiles') return json(profiles)
    if (p === '/api/profiles/active') {
      return bindingUnreadable ? json({ error: 'unavailable' }, 503) : json(profiles.find(x => x.id === bound))
    }
    const activate = p.match(/^\/api\/profiles\/(\d+)\/activate$/)
    if (activate && init?.method === 'POST') {
      bound = Number(activate[1])
      activations.push(bound)
      return new Response(null, { status: 204 })
    }
    if (/^\/api\/profiles\/\d+\/library$/.test(p)) {
      if (listFails.has(asked)) return json({ error: 'unavailable' }, 503)
      return json([{ media_item_id: sees.saved.id, title: sees.saved.title, type: 'movie', year: 2020 }])
    }
    if (p === '/api/me/hero') {
      heroPools.push(asked)
      return json({ picks: sees.hero.map(it => ({ item: it, reason: 'Picked for you' })), slate_token: `slate-${asked}` })
    }
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
    // One live party, hosted by someone else, that only the Parent may be
    // shown (the server judges a party's title against the session's limit).
    if (p === '/api/parties/active') {
      return json({ parties: asked === 1 ? [{
        code: 'PARTY1', host_user_id: 9, party_name: '', media_title: 'Parentonly Party', media_poster: '',
        participant_count: 3, max_participants: 0, is_playing: true, started_at: NOW,
      }] : [] })
    }
    // One invitation nobody has answered. Invitations are the ACCOUNT's, so
    // the server lists it whichever profile is bound: what keeps it off the
    // Kid's Tonight is that a profile with a limit is shown no live strip.
    // (Not with kidUnrestricted, where it would be shown, rightly, under
    // either name, and the Parent-only probe would count it.)
    if (p === '/api/me/party-invites') {
      return json({ invites: kidUnrestricted ? [] : [{
        invite_id: 7, party_code: 'INVITE1', media_title: 'Parentonly Invite', host_username: 'jonah', rsvp: 'pending',
        scheduled_start_at: '2099-01-01T20:00:00Z', started_at: null, created_at: NOW,
      }] })
    }
    return json([])
  })
  // The event socket, and two browser APIs App's layout uses that jsdom lacks.
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  return {
    counts,
    activations,
    heroPools,
    searches,
    /** From now on the server fails to answer for this profile's own list. */
    failListFor(profile: number) { listFails.add(profile) },
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
  /** The Parent's pick count in Tonight's closing line. */
  parentCount: boolean
  /** The hero's no-pick card (an empty library), not its loading skeleton. */
  noPickCard: boolean
  /** Home's rails are up, or their skeleton is. */
  railsOrSkeleton: boolean
  /** My Library's empty-state message. */
  libraryEmpty: boolean
  /** The Parent's catalog total in Tonight's closing line. */
  parentTotal: boolean
  /** The title Tonight's hero names, when it is up. */
  heroTitle: string | null
}

/** The name on the top bar's identity control: the profile the app says it
 *  is acting as. It is the one place the bar names a profile. */
const identityName = () => document.querySelector('[data-identity-name]')?.textContent ?? null

/** Switches profile through the top bar: the identity control's menu. */
function pickInTopBar(name: RegExp) {
  fireEvent.click(document.querySelector('[data-identity-trigger]')!)
  fireEvent.click(within(screen.getByRole('group', { name: 'Watching as' })).getByRole('button', { name }))
}

/** Samples the page at every commit. */
function renderApp(path: string) {
  const commits: Commit[] = []
  const onRender = () => {
    const text = pageText()
    const named = [...document.querySelectorAll('[aria-label], img[alt], [title]')]
      .map(el => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('alt') ?? ''} ${el.getAttribute('title') ?? ''}`)
    commits.push({
      label: identityName(),
      parentTitles: `${text} ${named.join(' ')}`.includes('Parentonly'),
      parentCount: /\b2 titles worth your time/.test(text),
      // The skeleton keeps this heading too, but only for assistive tech.
      noPickCard: [...document.querySelectorAll('h2')].some(h => h.textContent === 'Welcome to Aurora' && !h.classList.contains('sr-only')),
      railsOrSkeleton: !!document.querySelector('.rail-title') || text.includes('Loading your library…'),
      libraryEmpty: text.includes('No saved titles yet'),
      parentTotal: /\b37 titles in your library/.test(text),
      heroTitle: document.querySelector('section[data-hero-kind] h2')?.textContent ?? null,
    })
  }
  render(<Profiler id="app" onRender={onRender}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></Profiler>)
  return commits
}

function switchToKid() {
  pickInTopBar(/Kid/)
}

/** Types a description into the top bar's search field and asks for the
 *  search by description (Enter). */
function describeInTopBar(words: string) {
  const field = screen.getByRole('textbox', { name: 'Search titles' })
  fireEvent.change(field, { target: { value: words } })
  fireEvent.keyDown(field, { key: 'Enter' })
}

/** Tonight's hero is up for the Parent, all of it: the title they left
 *  unfinished leads, and Aurora's two picks are in the filmstrip beside it. */
async function parentHeroUp() {
  await screen.findByRole('button', { name: 'Details of Parentonly Resume' }, { timeout: 5000 })
  const strip = await screen.findByRole('list', { name: /picks from Aurora/ }, { timeout: 5000 })
  expect(within(strip).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Parentonly Hero', 'Parentonly Second'])
}

/** Tonight's hero is up for the Kid, and everything it is made from has
 *  been answered: the title the Kid left unfinished, and Aurora's picks for
 *  the Kid. A profile with a limit is shown no filmstrip, so for it the
 *  picks' arrival is read from the server; with no limit the one pick is in
 *  the strip. A moment more then lets whatever that answer changed commit. */
async function kidHeroUp() {
  const hero = await screen.findByRole('button', { name: /^(More about|Details of) Kidonly Resume$/ }, { timeout: 5000 })
  await waitFor(() => expect(server.heroPools).toContain(2), { timeout: 5000 })
  if (hero.getAttribute('aria-label')!.startsWith('Details of')) {
    await screen.findByRole('button', { name: 'Kidonly Hero' }, { timeout: 5000 })
  } else {
    await new Promise(done => setTimeout(done, 50))
    expect(screen.queryByRole('list', { name: /picks from Aurora/ })).toBeNull()
  }
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

  // Into a profile with a limit (the calmer Tonight: no filmstrip, no pick
  // count) and into one without (the Parent's own page, where a kept pick or
  // count would have somewhere to show).
  it.each([
    ['into a profile with a limit', false],
    ['into a profile with none', true],
  ])('on Home: the hero, its picks, the rails and Continue Watching, %s', async (_how, kidUnrestricted) => {
    vi.unstubAllGlobals()
    server = stubServer({ kidUnrestricted })
    const commits = renderApp('/')
    await parentHeroUp()
    await screen.findAllByText('Parentonly Catalog', undefined, { timeout: 5000 })
    // Not vacuous: the Parent's name stood over the Parent's titles and count.
    expect(commits.some(c => c.label === 'Parent' && c.parentTitles)).toBe(true)
    await waitFor(() => expect(commits.some(c => c.label === 'Parent' && c.parentCount)).toBe(true), { timeout: 5000 })

    switchToKid()
    await kidHeroUp()
    await screen.findAllByText('Kidonly Catalog', undefined, { timeout: 5000 })
    // The Kid's own closing line is up: its own count, and for a profile
    // with no limit its own number of picks.
    await waitFor(() => expect(document.querySelector('[data-tonight-foot]')?.textContent).toMatch(
      kidUnrestricted ? /^1 titles worth your time out of the 2 titles in your library\./ : /^Showing the 2 titles in your library rated PG and under\./,
    ), { timeout: 5000 })
    expect(kidOverParent(commits)).toBe(0)
    expect(kid(commits).filter(c => c.parentCount)).toEqual([])
    expect(kid(commits).filter(c => c.noPickCard)).toEqual([])
    expect(kid(commits).filter(c => !c.railsOrSkeleton)).toEqual([])
  })

  // The hero remembers that the viewer moved off the title to resume, onto
  // a pick, and which pick. That is the previous profile's glance at the
  // previous profile's slate: the new profile's Tonight opens on its own
  // unfinished title, as a first visit does.
  it('on Home: the new profile\'s hero opens on its own unfinished title, not where the last one had moved to', async () => {
    vi.unstubAllGlobals()
    server = stubServer({ kidUnrestricted: true })
    const commits = renderApp('/')
    await parentHeroUp()
    fireEvent.click(screen.getByRole('button', { name: 'Parentonly Second' }))
    // Not vacuous: the Parent's hero moved to the second pick.
    await screen.findByRole('button', { name: 'Details of Parentonly Second' }, { timeout: 5000 })

    switchToKid()
    await kidHeroUp()
    const strip = screen.getByRole('list', { name: /picks from Aurora/ })
    // On its own title to resume, with its one pick beside it, not showing.
    expect(document.querySelector('section[data-hero-kind] h2')?.textContent).toBe('Kidonly Resume')
    expect(within(strip).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Kidonly Hero'])
    // And no commit under the Kid's name had the pick up instead.
    expect(kid(commits).filter(c => c.heroTitle !== null && c.heroTitle !== 'Kidonly Resume')).toEqual([])
    expect(kidOverParent(commits)).toBe(0)
  })

  // The hero waits for Continue Watching for four seconds at most, and that
  // the wait ran out is one visit's fact. It used to be kept for the user
  // and profile for as long as the tab lived: after a switch away and back
  // the wait was already over, so the hero put up a pick with Continue
  // Watching still out, and the title to resume then took the hero over,
  // also from under a viewer already in it.
  it('on Home: the hero waits for the title to resume again after a switch away and back, though that wait once ran out', async () => {
    vi.unstubAllGlobals()
    server = stubServer({ kidUnrestricted: true })
    const release = server.hold('continue-1')
    const commits = renderApp('/')
    // Not vacuous: the Parent's wait runs out, and a pick goes up.
    await screen.findByRole('button', { name: 'Details of Parentonly Hero' }, { timeout: 8000 })
    release()
    await parentHeroUp()

    switchToKid()
    await kidHeroUp()
    // Back to the Parent, whose Continue Watching is out again.
    const again = server.hold('continue-1')
    const since = commits.length
    const pools = server.heroPools.filter(asked => asked === 1).length
    pickInTopBar(/Parent/)
    // The Parent's picks and rails have landed; only Continue Watching is out.
    await waitFor(() => expect(server.heroPools.filter(asked => asked === 1).length).toBeGreaterThan(pools), { timeout: 5000 })
    await screen.findAllByText('Parentonly Catalog', undefined, { timeout: 5000 })
    await new Promise(done => setTimeout(done, 300))
    const back = () => commits.slice(since).filter(c => c.label === 'Parent')
    expect(back().length).toBeGreaterThan(0)
    expect(back().filter(c => c.heroTitle !== null)).toEqual([])

    again()
    await parentHeroUp()
    // The hero opened on the title to resume: no commit showed a pick first.
    expect(back().filter(c => c.heroTitle !== null && c.heroTitle !== 'Parentonly Resume')).toEqual([])
    // Longer than the default: the first wait alone is four seconds.
  }, 20_000)

  // A profile with a limit has its own list as a rail on Tonight. This
  // browser keeps a snapshot of each profile's list, and the Kid's can hold
  // a title saved before the limit was set, which the server no longer
  // lists. The rail is the server's answer for the Kid, on every commit:
  // not the snapshot, and not on the strength of the Parent's answer.
  it('on Home, into a profile with a limit: its list is the server\'s, never this browser\'s snapshot', async () => {
    localStorage.setItem('aurora_my_library:1:2', JSON.stringify([{
      id: 108, title: 'Parentonly Saved Before The Limit', year: 2020, rating: 7, duration: '', genre: '', type: 'movie', poster: '', backdrop: '', description: '',
    }]))
    const commits = renderApp('/')
    await parentHeroUp()
    switchToKid()
    await kidHeroUp()
    const list = (await screen.findByRole('heading', { name: 'Your list' }, { timeout: 5000 })).closest('section')!
    expect(within(list).getAllByText('Kidonly Saved').length).toBeGreaterThan(0)
    expect(screen.queryByText('Parentonly Saved Before The Limit')).toBeNull()
    expect(kid(commits).length).toBeGreaterThan(0)
    expect(kidOverParent(commits)).toBe(0)
  })

  // The rail is the server's answer for the Kid "this time": an answer the
  // Kid's list had on an earlier visit does not vouch for what this browser
  // holds now. Kid, then Parent, then Kid again, with the Kid's list
  // unanswered the second time and the snapshot changed meanwhile (another
  // tab wrote it, or the limit was lowered from another device since).
  it('on Home, back into a profile with a limit: an earlier answer for its list does not vouch for the snapshot', async () => {
    const commits = renderApp('/')
    await parentHeroUp()
    switchToKid()
    await kidHeroUp()
    // Not vacuous: the Kid's list was answered once, and shown.
    const first = (await screen.findByRole('heading', { name: 'Your list' }, { timeout: 5000 })).closest('section')!
    expect(within(first).getAllByText('Kidonly Saved').length).toBeGreaterThan(0)

    server.failListFor(1)
    server.failListFor(2)
    pickInTopBar(/Parent/)
    await parentHeroUp()
    // What this browser holds for the Kid now.
    localStorage.setItem('aurora_my_library:1:2', JSON.stringify([{
      id: 108, title: 'Parentonly Saved Before The Limit', year: 2020, rating: 7, duration: '', genre: '', type: 'movie', poster: '', backdrop: '', description: '',
    }]))
    const since = commits.length
    switchToKid()
    await kidHeroUp()
    await screen.findAllByText('Kidonly Catalog', undefined, { timeout: 5000 })
    await new Promise(done => setTimeout(done, 300))
    // No answer for the list this time: no rail, on any commit.
    expect(screen.queryByRole('heading', { name: 'Your list' })).toBeNull()
    expect(screen.queryByText('Parentonly Saved Before The Limit')).toBeNull()
    expect(commits.slice(since).filter(c => c.label === 'Kid').length).toBeGreaterThan(0)
    expect(kidOverParent(commits)).toBe(0)
  })

  it('in the top bar: the live-presence pill', async () => {
    const commits = renderApp('/')
    const pill = () => document.querySelector('[data-presence]')?.textContent ?? null
    // Not vacuous: the bar named the Parent's live party under the Parent's name.
    await waitFor(() => expect(pill()).toContain('3 watching Parentonly Party'), { timeout: 5000 })
    expect(commits.some(c => c.label === 'Parent' && c.parentTitles)).toBe(true)

    switchToKid()
    await kidHeroUp()
    expect(kidOverParent(commits)).toBe(0)
    // A restricted session is not shown other people's parties at all.
    expect(pill()).toBeNull()
  })

  // Tonight's live strip: the Parent's running party and the account's open
  // invitation. A profile with a limit is offered no way to watch together,
  // so the strip is not drawn for the Kid at all, on any commit.
  it('on Home: the live strip', async () => {
    const commits = renderApp('/')
    const strip = () => document.querySelector('[data-tonight-live]')?.textContent ?? null
    // Not vacuous: both rows are up for the Parent.
    await waitFor(() => {
      expect(strip()).toContain('3 watching Parentonly Party')
      expect(strip()).toContain('jonah invited you to watch Parentonly Invite')
    }, { timeout: 5000 })
    switchToKid()
    await kidHeroUp()
    expect(kid(commits).length).toBeGreaterThan(0)
    expect(kidOverParent(commits)).toBe(0)
    expect(strip()).toBeNull()
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
      const label = identityName
      await waitFor(() => expect(label()).toBe('Parent'), { timeout: 5000 })
      switchToKid()
      await waitFor(() => expect(label()).toBe('Kid'), { timeout: 5000 })
      release()
      await screen.findAllByText('Kidonly Catalog', undefined, { timeout: 5000 })
      expect(kidOverParent(commits)).toBe(0)
    })

  // The card menu holds the previous profile's Resume record and closures
  // over its id (Add, the thumbs, Mark as watched): a pick made after a
  // switch would act for the profile the session no longer is. It is named
  // for its title, so a commit that drew it under the Kid's name is seen by
  // the same probe as any other Parent-only title.
  it('closes an open card menu', async () => {
    const commits = renderApp('/')
    await parentHeroUp()
    fireEvent.click((await screen.findAllByRole('button', { name: /^More actions for Parentonly/ }, { timeout: 5000 }))[0])
    // Not vacuous: the menu is up, and named for a Parent-only title.
    expect(screen.getByRole('menu').getAttribute('aria-label')).toMatch(/^Actions for Parentonly/)
    switchToKid()
    await kidHeroUp()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(kid(commits).length).toBeGreaterThan(0)
    expect(kidOverParent(commits)).toBe(0)
  })

  // A search by description is the search page's now (it was a bar on Home
  // with a rail of its own). The words stay in the field across a switch,
  // and the page searches them again for the new profile, by title: nobody
  // asked the model anything on the new profile's behalf.
  it('drops a search by description that was in flight', async () => {
    const commits = renderApp('/')
    await parentHeroUp()
    const release = server.hold('search-1')
    describeInTopBar('cozy')
    await screen.findByText('Looking for titles like "cozy"…', undefined, { timeout: 5000 })
    // Not vacuous: the search that is out is the Parent's, by description.
    await waitFor(() => expect(server.searches).toContainEqual({ asked: 1, mode: 'semantic' }), { timeout: 5000 })
    switchToKid()
    await screen.findAllByText('Kidonly Vibe', undefined, { timeout: 5000 })
    release()
    await new Promise(done => setTimeout(done, 100))
    expect(screen.queryAllByText('Parentonly Vibe')).toEqual([])
    // Nor is the Kid's page left saying the Parent's search is still running.
    expect(screen.queryByText(/Looking for titles like/)).toBeNull()
    expect(server.searches.filter(x => x.asked === 2).map(x => x.mode)).toEqual(['literal'])
    expect(kid(commits).length).toBeGreaterThan(0)
    expect(kidOverParent(commits)).toBe(0)
  })

  // Tonight's closing line counts the library from its own fetch, or, when
  // that failed, from the browse grids' totals, which are the Parent's until
  // the switch clears them. One grid each, so the line's total is that grid's.
  it.each([['Movies', '/movies'], ['Shows', '/shows']])(
    "does not count the Parent's library in Tonight's closing line from the %s total", async (_grid, path) => {
      vi.unstubAllGlobals()
      server = stubServer({ homeCountFails: true })
      const commits = renderApp(path)
      await screen.findAllByText('Parentonly Catalog', undefined, { timeout: 5000 })
      fireEvent.click(document.querySelector('header .stage-tab[data-nav="home"]')!)
      // Not vacuous: the fallback did put the Parent's total in the line.
      await waitFor(() => expect(pageText()).toMatch(/\b37 titles in your library/), { timeout: 5000 })
      switchToKid()
      await kidHeroUp()
      expect(kid(commits).filter(c => c.parentTotal)).toEqual([])
      expect(kidOverParent(commits)).toBe(0)
    })

  it('clears the results of a search by description', async () => {
    const commits = renderApp('/')
    await parentHeroUp()
    describeInTopBar('cozy')
    // Not vacuous: the Parent's results are up, and marked as the model's.
    await screen.findAllByText('Parentonly Vibe', undefined, { timeout: 5000 })
    expect(server.searches).toContainEqual({ asked: 1, mode: 'semantic' })
    switchToKid()
    await screen.findAllByText('Kidonly Vibe', undefined, { timeout: 5000 })
    expect(server.searches.filter(x => x.asked === 2).map(x => x.mode)).toEqual(['literal'])
    expect(kid(commits).length).toBeGreaterThan(0)
    expect(kidOverParent(commits)).toBe(0)
  })

  it('on My Library', async () => {
    // Between two profiles that may both open My Library: a restricted
    // profile is not shown the page at all (the next case).
    vi.unstubAllGlobals()
    server = stubServer({ kidUnrestricted: true })
    const commits = renderApp('/library')
    await screen.findAllByText('Parentonly Saved', undefined, { timeout: 5000 })
    switchToKid()
    await screen.findAllByText('Kidonly Saved', undefined, { timeout: 5000 })
    expect(kidOverParent(commits)).toBe(0)
    expect(kid(commits).filter(c => c.libraryEmpty)).toEqual([])
  })

  it('on My Library, into a restricted profile: the page goes with the switch', async () => {
    const commits = renderApp('/library')
    await screen.findAllByText('Parentonly Saved', undefined, { timeout: 5000 })
    switchToKid()
    // A restricted profile sees Tonight, Movies and Shows: it lands on Tonight.
    await kidHeroUp()
    expect(kidOverParent(commits)).toBe(0)
    expect(kid(commits).filter(c => c.libraryEmpty)).toEqual([])
    expect(kid(commits).length).toBeGreaterThan(0)
  })

  it('on an open title the new profile may not see', async () => {
    const commits = renderApp('/title/101')
    await screen.findAllByText('Parentonly Hero', undefined, { timeout: 5000 })
    switchToKid()
    // The hydration asks again, is refused, and goes Home.
    await kidHeroUp()
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

// Tonight's closing line counts the library from its own fetch ("N titles in
// your library"), and the server counts what the session's profile may see: the
// Parent's catalog totals 37 titles and the Kid's 2. No commit may show one
// profile's count while the app acts as another.
describe('Home’s library count is the acting profile’s', () => {
  beforeEach(signedIn)
  afterEach(() => { vi.unstubAllGlobals() })

  const total = (n: number) => new RegExp(`\\b${n} titles in your library`)
  const lineCounts = (n: number) =>
    waitFor(() => expect(pageText()).toMatch(total(n)), { timeout: 5000 })

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
    await lineCounts(2)
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
    expect(pageText()).toMatch(total(2))
  })

  it.each([
    ['through the top bar', false],
    ['through the picker an unreadable binding opens', true],
  ])('after a switch %s', async (_how, bindingUnreadable) => {
    vi.unstubAllGlobals()
    server = stubServer({ bindingUnreadable })
    const commits = renderApp('/')
    // Not vacuous: the line counted the Parent's library first (with the
    // binding unreadable, behind the picker, under the binding the server
    // does have).
    await lineCounts(37)
    if (bindingUnreadable) {
      const picker = await screen.findByRole('dialog', { name: "Who's watching?" }, { timeout: 5000 })
      fireEvent.click(within(picker).getByRole('radio', { name: /Kid/ }))
    } else {
      switchToKid()
    }
    await lineCounts(2)
    expect(kid(commits).length).toBeGreaterThan(0)
    expect(kid(commits).filter(c => c.parentTotal)).toEqual([])
    // Once for each profile.
    expect(server.counts).toEqual([1, 2])
  })

  it('drops an answer for the previous profile that arrives after a switch', async () => {
    const release = server.hold('count-1')
    const commits = renderApp('/')
    await parentHeroUp()
    await waitFor(() => expect(server.counts).toEqual([1]), { timeout: 5000 })
    switchToKid()
    await lineCounts(2)
    release()
    await new Promise(done => setTimeout(done, 100))
    expect(pageText()).toMatch(total(2))
    expect(commits.filter(c => c.parentTotal)).toEqual([])
  })

  // Back on the Parent before the Kid's count landed, the line waits for
  // the Parent's new answer rather than showing the one from before the
  // switch: kept, the same user and profile coming back (a sign-out and
  // sign-in in this tab, say) would show an answer from another session.
  it('asks again after a switch away and back, showing no earlier answer', async () => {
    const commits = renderApp('/')
    await lineCounts(37)
    const releaseKid = server.hold('count-2')
    switchToKid()
    await waitFor(() => expect(server.counts).toEqual([1, 2]), { timeout: 5000 })
    const release = server.hold('count-1')
    // Every commit from the click back on, until the Parent's new answer.
    const since = commits.length
    pickInTopBar(/Parent/)
    await waitFor(() => expect(server.counts).toEqual([1, 2, 1]), { timeout: 5000 })
    expect(commits[commits.length - 1].label).toBe('Parent')
    await new Promise(done => setTimeout(done, 100))
    expect(commits.slice(since).filter(c => c.parentTotal)).toEqual([])
    release()
    await lineCounts(37)
    releaseKid()
  })
})
