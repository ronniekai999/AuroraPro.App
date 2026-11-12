// @vitest-environment jsdom
//
// Tonight, against the whole App and a stubbed server: what leads the hero,
// what its filmstrip does, what is told to the recommender, and what the
// page says under its rails.
//
// Pinned by what happens (what the hero names, what plays and from where,
// what is posted), not by how the hero is laid out.

import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App'

// The player is replaced by a marker that says what it was asked to play.
vi.mock('@/components/VideoPlayer', async (original) => ({
  ...(await original<typeof import('@/components/VideoPlayer')>()),
  VideoPlayer: ({ target }: { target: { mediaItemId: number; resumePositionMs?: number } | null }) =>
    target ? <div data-test-player data-media={target.mediaItemId} data-resume={target.resumePositionMs ?? 0} /> : null,
}))

const NOW = '2026-10-01T00:00:00Z'
const PARENT = { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }
const KID = { id: 2, user_id: 1, name: 'Kid', is_default: false, created_at: NOW, updated_at: NOW, max_age_rating: 'PG' }
const item = (id: number, title: string, type = 'movie') => ({
  id, library_id: 1, type, title, year: 2020, rating: 7, overview: `${title}.`, added_at: NOW, updated_at: NOW,
})
const LEFT = item(710, 'Left Unfinished')
const PICK_A = item(701, 'Pick Alpha'), PICK_B = item(702, 'Pick Beta'), PICK_C = item(703, 'Pick Gamma')
const CATALOG = item(720, 'Only In The Catalog')
const DESCRIBED = item(730, 'Found By Description')
const A_MOVIE = item(740, 'A Movie On The Shelf'), A_SHOW = item(741, 'A Show On The Shelf', 'show')
const GEM = item(750, 'A Hidden Gem')
const SAVED = item(760, 'Saved By This Profile')
const LEFT_RECORD = { media_item_id: LEFT.id, title: LEFT.title, type: 'movie', year: 2020, position_ms: 1_800_000, duration_ms: 7_200_000, percent_complete: 25 }

interface Options {
  bound?: number
  /** Continue Watching, most recent first. */
  unfinished?: unknown[]
  picks?: ReturnType<typeof item>[]
  /** What a forced rebuild of the picks ("Refresh picks") answers with:
   *  other picks, or 'fails'. Unset, the same picks again. */
  refreshed?: ReturnType<typeof item>[] | 'fails'
  /** The profile's own list, as the server has it. */
  saved?: ReturnType<typeof item>[]
  /** The request for that list fails. */
  savedFails?: boolean
}
function stubServer({ bound = 1, unfinished = [LEFT_RECORD], picks = [PICK_A, PICK_B, PICK_C], refreshed, saved = [], savedFails = false }: Options = {}) {
  const me = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
  const exposures: { query: string; body: unknown }[] = []
  const parties: unknown[] = []
  const answered: string[] = []
  const searches: { q: string | null; mode: string | null }[] = []
  const holds = new Map<string, Promise<void>>()
  let signedIn = true
  let listFails = savedFails
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    const held = holds.get(p)
    if (held) await held
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    answered.push(p)
    if (p === '/api/auth/logout' && init?.method === 'POST') { signedIn = false; return new Response(null, { status: 204 }) }
    if (p === '/api/auth/login' && init?.method === 'POST') { signedIn = true; return json({ expires_in: 900, user: me }) }
    if (p === '/api/auth/oauth/providers') return json({ providers: [] })
    if (!signedIn) return json({ error: { code: 401, message: 'signed out' } }, 401)
    if (p === '/api/auth/me') return json(me)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: me })
    if (p === '/api/profiles') return json([PARENT, KID])
    if (p === '/api/profiles/active') return json(bound === 1 ? PARENT : KID)
    if (p === '/api/me/hero') {
      const rebuilt = url.searchParams.get('refresh') === '1' ? refreshed : undefined
      if (rebuilt === 'fails') return json({ error: 'unavailable' }, 503)
      return json({ picks: (rebuilt ?? picks).map((it, i) => ({ item: it, reason: `Because of ${i}` })), slate_token: rebuilt ? 'slate-new' : 'slate-xyz' })
    }
    if (p === '/api/me/recommendation-exposure' && init?.method === 'POST') {
      exposures.push({ query: url.search, body: JSON.parse(String(init.body)) })
      return new Response(null, { status: 204 })
    }
    if (p === '/api/media/search') {
      const mode = url.searchParams.get('mode')
      searches.push({ q: url.searchParams.get('q'), mode })
      // By title: what matches the words. By description: something the
      // words do not name. The server says which it ran.
      return new Response(JSON.stringify(mode === 'semantic' ? [DESCRIBED] : []), {
        status: 200, headers: { 'content-type': 'application/json', 'X-Search-Mode': mode === 'semantic' ? 'semantic' : 'literal' },
      })
    }
    if (/^\/api\/profiles\/\d+\/library$/.test(p)) {
      return listFails ? json({ error: 'unavailable' }, 503) : json(saved.map(it => ({ media_item_id: it.id, title: it.title, type: 'movie', year: 2020 })))
    }
    if (p === '/api/media/recent') return json({ data: [CATALOG] })
    if (p === '/api/media') {
      const type = url.searchParams.get('type')
      return json({ data: [type === 'show' ? A_SHOW : type === 'movie' ? A_MOVIE : CATALOG], page: 1, per_page: 30, total_items: 41, total_pages: 1 })
    }
    // One rail of the recommender's.
    if (p.startsWith('/api/me/discover')) return json({ rails: [{ title: 'Hidden gems for you', description: 'Picked for your taste', items: [GEM] }] })
    if (p === '/api/progress/continue') return json(unfinished)
    if (/^\/api\/media\/\d+\/files$/.test(p)) return json([{ id: 9001, media_item_id: Number(p.split('/')[3]), resolution: '1080p' }])
    const byId = p.match(/^\/api\/media\/(\d+)$/)
    if (byId) {
      const it = [LEFT, PICK_A, PICK_B, PICK_C, CATALOG].find(x => x.id === Number(byId[1]))
      return it ? json(it) : json({ error: { code: 404, message: 'not found' } }, 404)
    }
    if (p === '/api/parties' && init?.method === 'POST') {
      parties.push(JSON.parse(String(init.body)))
      return json({ code: 'NEWPARTY' }, 201)
    }
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    if (p === '/api/parties/active') return json({ parties: [] })
    return json([])
  })
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  // The hero is on screen: its observer says so as soon as it is asked.
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
    exposures, parties, answered, searches,
    /** From now on the profile's own list cannot be read. */
    failSaved() { listFails = true },
    hold(path: string) {
      let release!: () => void
      holds.set(path, new Promise<void>(done => { release = done }))
      return () => { holds.delete(path); release() }
    },
  }
}

interface Commit { heroTitle: string | null; skeleton: boolean; text: string }
function renderTonight(opts: Options = {}, keep = false) {
  if (!keep) localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify({ id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }))
  localStorage.setItem('aurora_prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('aurora_prefs') ?? '{}'), profile_gate_seen: true }))
  const server = stubServer(opts)
  const commits: Commit[] = []
  const onRender = () => commits.push({
    heroTitle: hero()?.querySelector('h2')?.textContent ?? null,
    skeleton: !!document.querySelector('main .stage-skel'),
    text: document.body.textContent ?? '',
  })
  render(<Profiler id="app" onRender={onRender}><MemoryRouter initialEntries={['/']}><App /></MemoryRouter></Profiler>)
  return { ...server, commits }
}

const find = { timeout: 5000 }
/** Tonight's hero: the first section of the page, under its heading. */
const hero = () => document.querySelector<HTMLElement>('section[data-hero-kind]')
const heroTitle = () => hero()?.querySelector('h2')?.textContent ?? null
const strip = () => screen.findByRole('list', { name: /picks from Aurora/ }, find)
const stripLabels = async () => within(await strip()).getAllByRole('button').map(b => b.getAttribute('aria-label'))
const player = () => document.querySelector<HTMLElement>('[data-test-player]')
const foot = () => document.querySelector('[data-tonight-foot]')?.textContent ?? null
/** The rotation's timer, if one is running: App's nine-second interval. */
function rotation(spy: MockInstance<typeof window.setInterval>) {
  const cleared = new Set<unknown>(clearSpy.mock.calls.map(c => c[0]))
  const live = spy.mock.calls
    .map((call, i) => ({ fn: call[0] as () => void, ms: call[1], id: spy.mock.results[i].value as unknown }))
    .filter(t => t.ms === 9000 && !cleared.has(t.id))
  return live.length ? live[live.length - 1] : null
}
let clearSpy: MockInstance<typeof window.clearInterval>

vi.setConfig({ testTimeout: 20_000 })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('what leads Tonight', () => {
  it('is the title left unfinished, to resume where it stopped, with Aurora\'s picks beside it', async () => {
    renderTonight()
    await screen.findByRole('button', { name: 'Details of Left Unfinished' }, find)
    expect(heroTitle()).toBe('Left Unfinished')
    expect(hero()!.textContent).toContain('Pick up where you left off')
    expect(hero()!.textContent).toContain('1 h 30 min left')
    // The strip is the picks: the title to resume is the hero's own, and
    // the first card of Continue Watching, and is not listed a third time.
    expect(await stripLabels()).toEqual(['Pick Alpha', 'Pick Beta', 'Pick Gamma'])
    const started = (await screen.findByRole('heading', { name: 'Continue Watching' }, find)).closest('section')!
    expect(within(started).getAllByText('Left Unfinished').length).toBeGreaterThan(0)

    fireEvent.click(within(hero()!).getByRole('button', { name: /^Resume/ }))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.dataset.media).toBe(String(LEFT.id))
    expect(player()!.dataset.resume).toBe('1800000')
  })

  it('is never one of the picks while the title to resume is still being asked for', async () => {
    const page = renderTonight()
    const release = page.hold('/api/progress/continue')
    // The picks and the rails have all landed; only Continue Watching is out.
    await waitFor(() => expect(page.answered).toContain('/api/me/hero'), find)
    await screen.findAllByText('Only In The Catalog', undefined, find)
    await new Promise(done => setTimeout(done, 150))
    expect(hero()).toBeNull()
    expect(page.commits.every(c => c.heroTitle === null)).toBe(true)
    // Not the settled "nothing here" card either: a hero is on its way.
    expect(page.commits[page.commits.length - 1].skeleton).toBe(true)
    expect(screen.getByRole('heading', { name: 'Welcome to Aurora' })).toHaveClass('sr-only')

    release()
    await screen.findByRole('button', { name: 'Details of Left Unfinished' }, find)
    // The hero opened on the title to resume: no commit showed a pick first.
    expect(page.commits.map(c => c.heroTitle).filter(Boolean).every(t => t === 'Left Unfinished')).toBe(true)
  })

  // The wait has a limit. A request that never answers (a stalled proxy, a
  // slow query on that one route) used to leave the hero a skeleton for
  // good, with the picks and the rails up around it.
  it('goes ahead with a pick when that request never answers, and lets the title to resume take over if it turns up', async () => {
    const page = renderTonight()
    const release = page.hold('/api/progress/continue')
    await screen.findAllByText('Only In The Catalog', undefined, find)
    await new Promise(done => setTimeout(done, 1500))
    // Still waiting: no hero yet.
    expect(hero()).toBeNull()
    // Then not waiting any more.
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, { timeout: 6000 })
    expect(hero()!.textContent).toContain('Picked by Aurora')
    expect(await stripLabels()).toEqual(['Pick Alpha, showing now', 'Pick Beta', 'Pick Gamma'])

    // The answer arrives after all, and nobody has touched the hero: it is
    // the title to resume, as it would have been.
    release()
    await screen.findByRole('button', { name: 'Details of Left Unfinished' }, find)
    expect(await stripLabels()).toEqual(['Pick Alpha', 'Pick Beta', 'Pick Gamma'])
  })

  it('does not take the hero from under a viewer who is already in it when the late answer arrives', async () => {
    const page = renderTonight()
    const release = page.hold('/api/progress/continue')
    const details = await screen.findByRole('button', { name: 'Details of Pick Alpha' }, { timeout: 8000 })
    // Keyboard focus is in the hero.
    fireEvent.focus(details)
    release()
    // The title to resume is there, one row down; the hero stays put.
    const started = (await screen.findByRole('heading', { name: 'Continue Watching' }, find)).closest('section')!
    expect(within(started).getAllByText('Left Unfinished').length).toBeGreaterThan(0)
    await new Promise(done => setTimeout(done, 200))
    expect(heroTitle()).toBe('Pick Alpha')
    expect(page.commits.map(c => c.heroTitle).filter(Boolean).every(t => t === 'Pick Alpha')).toBe(true)
    expect(await stripLabels()).toEqual(['Pick Alpha, showing now', 'Pick Beta', 'Pick Gamma'])
  })

  // That the wait ran out is one visit's fact. It used to be kept for the
  // user and profile for as long as the tab lived: signing in again as the
  // same person found the wait already over, so the hero put up a pick with
  // Continue Watching still out, and the title to resume then took the hero
  // over, also from under a viewer already in it.
  it('waits for the title to resume again after signing out and in, though that wait once ran out', async () => {
    const page = renderTonight()
    const release = page.hold('/api/progress/continue')
    // Not vacuous: the wait runs out, and a pick goes up.
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, { timeout: 8000 })
    release()
    await screen.findByRole('button', { name: 'Details of Left Unfinished' }, find)

    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    fireEvent.click(screen.getByRole('button', { name: /^Sign out/ }))
    const username = await screen.findByPlaceholderText('Enter username', {}, find)
    const releaseAgain = page.hold('/api/progress/continue')
    const since = page.commits.length
    const picks = page.answered.filter(p => p === '/api/me/hero').length
    fireEvent.change(username, { target: { value: 'ronnie' } })
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    // The picks and the rails have landed again; only Continue Watching is out.
    await waitFor(() => expect(page.answered.filter(p => p === '/api/me/hero').length).toBeGreaterThan(picks), find)
    await screen.findAllByText('Only In The Catalog', undefined, find)
    await new Promise(done => setTimeout(done, 300))
    expect(hero()).toBeNull()
    expect(page.commits.slice(since).filter(c => c.heroTitle !== null)).toEqual([])

    releaseAgain()
    await screen.findByRole('button', { name: 'Details of Left Unfinished' }, find)
    // The hero opened on the title to resume: no commit showed a pick first.
    expect(page.commits.slice(since).map(c => c.heroTitle).filter(Boolean).every(t => t === 'Left Unfinished')).toBe(true)
  })

  it('is the first pick when nothing is unfinished, and stops waiting when that request fails', async () => {
    renderTonight({ unfinished: [] })
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, find)
    expect(hero()!.textContent).toContain('Picked by Aurora')
    expect(hero()!.textContent).toContain('Because of 0')
    expect(await stripLabels()).toEqual(['Pick Alpha, showing now', 'Pick Beta', 'Pick Gamma'])
    cleanup()
    vi.unstubAllGlobals()

    const page = renderTonight()
    const fetchOk = globalThis.fetch
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) =>
      new URL(input, 'http://localhost').pathname === '/api/progress/continue'
        ? new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
        : fetchOk(input, init))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, find)
    expect(page.commits.map(c => c.heroTitle).filter(Boolean).every(t => t === 'Pick Alpha')).toBe(true)
  })

  it('does not lead with something finished, or not yet started far enough to resume', async () => {
    renderTonight({ unfinished: [
      { ...LEFT_RECORD, completed: true },
      { ...LEFT_RECORD, media_item_id: PICK_C.id, title: PICK_C.title, position_ms: 2_000 },
    ] })
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, find)
    expect(await stripLabels()).toEqual(['Pick Alpha, showing now', 'Pick Beta', 'Pick Gamma'])
  })
})

describe("the hero's filmstrip", () => {
  it('puts a chosen pick up, with why Aurora picked it, and plays that one', async () => {
    renderTonight()
    fireEvent.click(within(await strip()).getByRole('button', { name: 'Pick Beta' }))
    await screen.findByRole('button', { name: 'Details of Pick Beta' }, find)
    expect(heroTitle()).toBe('Pick Beta')
    expect(hero()!.textContent).toContain('Because of 1')
    expect(await stripLabels()).toEqual(['Pick Alpha', 'Pick Beta, showing now', 'Pick Gamma'])
    fireEvent.click(within(hero()!).getByRole('button', { name: 'Play Pick Beta' }))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.dataset.media).toBe(String(PICK_B.id))
    expect(player()!.dataset.resume).toBe('0')
  })

  // The strip hands App a place in the slate, and App reads the slate through
  // a ref. Mirrored in a passive effect, that ref still held the slate of the
  // commit before when a press landed in the frame the strip was drawn in:
  // the press put up another pick, or nothing. The observer presses in that
  // frame every time (its callback runs after the commit's DOM changes and
  // before the commit's passive effects), where a test that waits for the
  // strip first only lands there on a slow machine.
  it('puts up the pick that was pressed, also in the frame the strip is drawn in', async () => {
    let pressed = false
    const seen = new MutationObserver(() => {
      if (pressed) return
      const beta = document.querySelector<HTMLElement>('[data-hero-picks] button[aria-label="Pick Beta"]')
      if (!beta) return
      pressed = true
      fireEvent.click(beta)
    })
    seen.observe(document.body, { childList: true, subtree: true })
    try {
      renderTonight()
      await waitFor(() => expect(pressed).toBe(true), find)
      await screen.findByRole('button', { name: 'Details of Pick Beta' }, find)
      expect(heroTitle()).toBe('Pick Beta')
      expect(await stripLabels()).toEqual(['Pick Alpha', 'Pick Beta, showing now', 'Pick Gamma'])
    } finally {
      seen.disconnect()
    }
  })

  // Off the lead, on a pick: the title to resume is one row down, where it
  // resumes as it does from the hero.
  it('leaves the title to resume one row down once a pick is up, resuming from there', async () => {
    renderTonight()
    fireEvent.click(within(await strip()).getByRole('button', { name: 'Pick Gamma' }))
    await screen.findByRole('button', { name: 'Details of Pick Gamma' }, find)
    const started = (await screen.findByRole('heading', { name: 'Continue Watching' }, find)).closest('section')!
    fireEvent.click(within(started).getByRole('button', { name: 'Resume Left Unfinished' }))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.dataset.media).toBe(String(LEFT.id))
    expect(player()!.dataset.resume).toBe('1800000')
  })

  it('rotates through every entry in order, wraps, and can be seen doing it', async () => {
    const timers = vi.spyOn(window, 'setInterval')
    clearSpy = vi.spyOn(window, 'clearInterval')
    renderTonight()
    await strip()
    await waitFor(() => expect(rotation(timers)).not.toBeNull(), find)
    const shown: (string | null)[] = [heroTitle()]
    for (let i = 0; i < 4; i++) {
      act(() => { rotation(timers)!.fn() })
      shown.push(heroTitle())
    }
    expect(shown).toEqual(['Left Unfinished', 'Pick Alpha', 'Pick Beta', 'Pick Gamma', 'Left Unfinished'])
    // Back on the title to resume: none of the picks is showing.
    expect(await stripLabels()).toEqual(['Pick Alpha', 'Pick Beta', 'Pick Gamma'])
  })

  it('stops rotating when its pause button is pressed, and stays stopped on the next visit', async () => {
    const timers = vi.spyOn(window, 'setInterval')
    clearSpy = vi.spyOn(window, 'clearInterval')
    renderTonight()
    await strip()
    await waitFor(() => expect(rotation(timers)).not.toBeNull(), find)
    fireEvent.click(screen.getByRole('button', { name: 'Pause the rotation' }))
    await screen.findByRole('button', { name: 'Play the rotation' }, find)
    expect(rotation(timers)).toBeNull()

    // A new visit in the same browser.
    cleanup()
    vi.unstubAllGlobals()
    timers.mockClear(); clearSpy.mockClear()
    renderTonight({}, true)
    await strip()
    expect(await screen.findByRole('button', { name: 'Play the rotation' }, find)).toBeInTheDocument()
    await new Promise(done => setTimeout(done, 100))
    expect(rotation(timers)).toBeNull()
    // And running again once asked.
    fireEvent.click(screen.getByRole('button', { name: 'Play the rotation' }))
    await waitFor(() => expect(rotation(timers)).not.toBeNull(), find)
  })

  it('"Refresh picks" asks for new picks for the strip, and shows them', async () => {
    const page = renderTonight({ unfinished: [], refreshed: [PICK_C, PICK_B] })
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, find)
    fireEvent.click(within(hero()!).getByRole('button', { name: 'Refresh picks' }))
    await screen.findByRole('button', { name: 'Details of Pick Gamma' }, find)
    expect(await stripLabels()).toEqual(['Pick Gamma, showing now', 'Pick Beta'])
    // The new slate's first pick, reported under the new slate.
    await waitFor(() => expect(page.exposures.some(e => (e.body as { slate_token: string; media_item_id: number }).slate_token === 'slate-new')).toBe(true), find)
    expect(page.exposures[page.exposures.length - 1].body).toEqual({ slate_token: 'slate-new', media_item_id: PICK_C.id, position: 0, visible_ms: 1500 })
  })

  it('keeps the picks there are when the refresh fails', async () => {
    renderTonight({ unfinished: [], refreshed: 'fails' })
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, find)
    fireEvent.click(within(hero()!).getByRole('button', { name: 'Refresh picks' }))
    await new Promise(done => setTimeout(done, 300))
    expect(heroTitle()).toBe('Pick Alpha')
    expect(await stripLabels()).toEqual(['Pick Alpha, showing now', 'Pick Beta', 'Pick Gamma'])
  })

  // The hero used to remember the pick last put up beside the catalog's
  // stand-in. With the picks gone it then showed that pick, labelled as the
  // stand-in ("Recently added").
  it('falls back to the catalog\'s newest title, named as that, when a refresh leaves no picks', async () => {
    renderTonight({ unfinished: [], refreshed: [] })
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, find)
    fireEvent.click(within(await strip()).getByRole('button', { name: 'Pick Beta' }))
    await screen.findByRole('button', { name: 'Details of Pick Beta' }, find)
    fireEvent.click(within(hero()!).getByRole('button', { name: 'Refresh picks' }))
    await screen.findByRole('button', { name: 'Details of Only In The Catalog' }, find)
    expect(hero()!.textContent).toContain('Recently added')
    expect(hero()!.textContent).not.toContain('Pick Beta')
    expect(screen.queryByRole('list', { name: /picks from Aurora/ })).toBeNull()
  })

  it('"Surprise me" plays one of the picks, never the one that is up', async () => {
    renderTonight({ unfinished: [] })
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, find)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    fireEvent.click(within(hero()!).getByRole('button', { name: 'Surprise me' }))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    // The first of the others: Alpha is showing.
    expect(player()!.dataset.media).toBe(String(PICK_B.id))
  })

  it('"Watch together" starts a party on the title that is up', async () => {
    const page = renderTonight({ unfinished: [] })
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, find)
    fireEvent.click(within(hero()!).getByRole('button', { name: 'Watch Pick Alpha together' }))
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    const buttons = within(composer).getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(page.parties).toHaveLength(1), find)
    expect(page.parties[0]).toMatchObject({ media_item_id: PICK_A.id })
  })
})

describe('what Tonight tells the recommender', () => {
  it('reports a pick the viewer chose as seen, at its own place in Aurora\'s slate, and not the title to resume', async () => {
    const page = renderTonight()
    await screen.findByRole('button', { name: 'Details of Left Unfinished' }, find)
    await strip()
    // The title to resume is not one of the picks: however long it is up,
    // nothing is reported.
    await new Promise(done => setTimeout(done, 1800))
    expect(page.exposures).toEqual([])

    fireEvent.click(within(await strip()).getByRole('button', { name: 'Pick Gamma' }))
    await waitFor(() => expect(page.exposures).toHaveLength(1), find)
    expect(page.exposures[0]).toEqual({
      query: '?profile_id=1',
      body: { slate_token: 'slate-xyz', media_item_id: PICK_C.id, position: 2, visible_ms: 1500 },
    })
    await new Promise(done => setTimeout(done, 1800))
    expect(page.exposures).toHaveLength(1)
  })

  it('reports the first pick at position 0 when it leads, and each pick the rotation reaches at its own', async () => {
    const timers = vi.spyOn(window, 'setInterval')
    clearSpy = vi.spyOn(window, 'clearInterval')
    const page = renderTonight({ unfinished: [] })
    await screen.findByRole('button', { name: 'Details of Pick Alpha' }, find)
    await waitFor(() => expect(page.exposures).toHaveLength(1), find)
    expect(page.exposures[0].body).toEqual({ slate_token: 'slate-xyz', media_item_id: PICK_A.id, position: 0, visible_ms: 1500 })
    await waitFor(() => expect(rotation(timers)).not.toBeNull(), find)
    act(() => { rotation(timers)!.fn() })
    await waitFor(() => expect(page.exposures).toHaveLength(2), find)
    expect(page.exposures[1].body).toEqual({ slate_token: 'slate-xyz', media_item_id: PICK_B.id, position: 1, visible_ms: 1500 })
  })

  // The server credits what is watched afterwards to the exposure, and the
  // viewer was already watching this: Aurora did not cause it by picking it.
  it('does not report a title to resume as a pick that was seen, even when it is also one of the picks; the strip lists the others', async () => {
    const page = renderTonight({ unfinished: [{ ...LEFT_RECORD, media_item_id: PICK_B.id, title: PICK_B.title }] })
    await screen.findByRole('button', { name: 'Details of Pick Beta' }, find)
    expect(hero()!.textContent).toContain('Pick up where you left off')
    expect(await stripLabels()).toEqual(['Pick Alpha', 'Pick Gamma'])
    await new Promise(done => setTimeout(done, 1800))
    expect(page.exposures).toEqual([])
    // A pick chosen from the strip is reported at the place the server sent
    // it at: Gamma is third in Aurora's slate, second in this strip.
    fireEvent.click(within(await strip()).getByRole('button', { name: 'Pick Gamma' }))
    await waitFor(() => expect(page.exposures).toHaveLength(1), find)
    expect(page.exposures[0].body).toEqual({ slate_token: 'slate-xyz', media_item_id: PICK_C.id, position: 2, visible_ms: 1500 })
  })

  it('reports nothing for the catalog\'s stand-in when Aurora has no picks', async () => {
    const page = renderTonight({ unfinished: [], picks: [] })
    await screen.findByRole('button', { name: 'Details of Only In The Catalog' }, find)
    expect(hero()!.textContent).toContain('Recently added')
    expect(screen.queryByRole('list', { name: /picks from Aurora/ })).toBeNull()
    await new Promise(done => setTimeout(done, 1800))
    expect(page.exposures).toEqual([])
  })
})

describe('the page around the hero', () => {
  it('has no greeting; its last line counts the picks and the library, and leads to the library', async () => {
    renderTonight()
    await screen.findByRole('button', { name: 'Details of Left Unfinished' }, find)
    // Aurora's three picks and the one title on the recommender's rail.
    await waitFor(() => expect(foot()).toMatch(/^4 titles worth your time out of the 41 titles in your library\./), find)
    expect(document.body.textContent).not.toMatch(/Good (morning|afternoon|evening)|Welcome back/)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tonight')
    fireEvent.click(screen.getByRole('button', { name: 'Browse the library' }))
    await screen.findByRole('heading', { level: 1, name: 'Movies' }, find)
  })

  // "Describe a vibe" was a second search bar, between the hero and the
  // rails, with a rail of its own. Search takes a description now.
  it('has no search bar of its own: a description goes in the search field, and Enter asks for it', async () => {
    const page = renderTonight()
    await screen.findByRole('button', { name: 'Details of Left Unfinished' }, find)
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    const field = screen.getByRole('textbox', { name: 'Search titles' })
    expect(field).toHaveAttribute('placeholder', 'Search, or describe a mood')

    // Typing matches titles, and only titles: no model call per keystroke.
    fireEvent.change(field, { target: { value: 'a slow mystery' } })
    await screen.findByRole('heading', { name: /No title matches .a slow mystery./ }, find)
    expect(page.searches).toEqual([{ q: 'a slow mystery', mode: 'literal' }])

    // Enter asks for the search by description, once.
    fireEvent.keyDown(field, { key: 'Enter' })
    await screen.findAllByText('Found By Description', undefined, find)
    expect(screen.getByText('Smart search')).toBeInTheDocument()
    expect(page.searches).toEqual([{ q: 'a slow mystery', mode: 'literal' }, { q: 'a slow mystery', mode: 'semantic' }])

    // Editing the words is a new query: by title again, until asked.
    fireEvent.change(field, { target: { value: 'a slow mystery film' } })
    await screen.findByRole('heading', { name: /No title matches .a slow mystery film./ }, find)
    expect(page.searches.map(x => x.mode)).toEqual(['literal', 'semantic', 'literal'])
    // The page's own button asks too, for the words now in the field.
    fireEvent.click(screen.getByRole('button', { name: 'Search by description' }))
    await screen.findAllByText('Found By Description', undefined, find)
    expect(page.searches[3]).toEqual({ q: 'a slow mystery film', mode: 'semantic' })
    expect(page.searches).toHaveLength(4)

    // The words stay in the field on the title page a result opens; Enter
    // there goes back to the search page and asks again.
    fireEvent.click(screen.getAllByRole('button', { name: /^Found By Description/ })[0])
    await screen.findByRole('heading', { level: 1, name: 'Found By Description' }, find)
    expect(field).toHaveValue('a slow mystery film')
    fireEvent.keyDown(field, { key: 'Enter' })
    await screen.findByRole('heading', { level: 1, name: /Search Results/ }, find)
    await screen.findAllByText('Found By Description', undefined, find)
    expect(page.searches.slice(4)).toEqual([{ q: 'a slow mystery film', mode: 'semantic' }])
    page.searches.length = 4

    // Typing away and back to words that were asked about does not ask the
    // model again: an ask is spent once the field changes.
    fireEvent.change(field, { target: { value: 'a slow mystery fil' } })
    fireEvent.change(field, { target: { value: 'a slow mystery film' } })
    await screen.findByRole('heading', { name: /No title matches .a slow mystery film./ }, find)
    expect(page.searches.slice(4).map(x => x.mode)).toEqual(['literal'])
  })

  it("is the calmer one for a profile with a content limit: one title, two actions, the limit stated", async () => {
    const timers = vi.spyOn(window, 'setInterval')
    clearSpy = vi.spyOn(window, 'clearInterval')
    const page = renderTonight({ bound: 2 })
    await screen.findByRole('button', { name: 'Keep watching Left Unfinished' }, find)
    expect(within(hero()!).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual([
      'Keep watching Left Unfinished', 'More about Left Unfinished',
    ])
    await waitFor(() => expect(page.answered).toContain('/api/me/hero'), find)
    await waitFor(() => expect(foot()).toMatch(/^Showing the 41 titles in your library rated PG and under\./), find)
    // No filmstrip, nothing rotating, no pick count, no way to a party.
    expect(screen.queryByRole('list', { name: /picks from Aurora/ })).toBeNull()
    expect(rotation(timers)).toBeNull()
    expect(document.body.textContent).not.toContain('worth your time')
    expect(screen.queryByRole('button', { name: /together/i })).toBeNull()

    fireEvent.click(within(hero()!).getByRole('button', { name: 'Keep watching Left Unfinished' }))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.dataset.resume).toBe('1800000')

    fireEvent.click(screen.getByRole('button', { name: 'Switch profile' }))
    await screen.findByRole('dialog', { name: "Who's watching?" }, find)
  })

  const railNames = () => [...document.querySelectorAll('main section .rail-title')].map(h => h.textContent)

  it('shows everyone else every rail: Continue Watching, the catalog\'s three, and the recommender\'s', async () => {
    const page = renderTonight({ saved: [SAVED] })
    await screen.findByRole('heading', { name: 'Hidden gems for you' }, find)
    await screen.findByRole('heading', { name: 'Top Rated Shows' }, find)
    // Asked for, for a profile that is shown them.
    expect(page.answered.some(p => p.startsWith('/api/me/discover'))).toBe(true)
    expect(railNames()).toEqual(expect.arrayContaining(['Continue Watching', 'Recently Added', 'Top Rated Movies', 'Top Rated Shows', 'Hidden gems for you']))
    // The profile's own list is a page of its own for them, not a rail.
    expect(railNames()).not.toContain('Your list')
  })

  it("shows a profile with a limit two shelves, on larger cards, and nothing the recommender built", async () => {
    const page = renderTonight({ bound: 2 })
    await screen.findByRole('heading', { name: 'Shows' }, find)
    await waitFor(() => expect(page.answered).toContain('/api/me/hero'), find)
    await new Promise(done => setTimeout(done, 200))
    // The recommender's rails are not even asked for: building them is a
    // model call on the server, for rails this profile is never shown.
    expect(page.answered.filter(p => p.startsWith('/api/me/discover') || p.startsWith('/api/me/anchor') || p.startsWith('/api/me/engagement') || p.startsWith('/api/me/following'))).toEqual([])
    // One title in progress is the hero's: no rail repeats it. Nothing saved.
    expect(railNames()).toEqual(['Movies', 'Shows'])
    expect(document.body.textContent).not.toContain('A Hidden Gem')
    expect(document.body.textContent).not.toContain('Only In The Catalog')
    const movies = screen.getByRole('heading', { name: 'Movies' }).closest('section')!
    expect(within(movies).getAllByText('A Movie On The Shelf').length).toBeGreaterThan(0)
    expect(movies.querySelectorAll('.media-card-cinema.is-large').length).toBeGreaterThan(0)
    expect(movies.querySelectorAll('.media-card-cinema:not(.is-large)')).toHaveLength(0)
  })

  it("adds what it has started and its own list, in that order, when there is more than the hero's title", async () => {
    renderTonight({
      bound: 2, saved: [SAVED],
      unfinished: [LEFT_RECORD, { ...LEFT_RECORD, media_item_id: PICK_C.id, title: PICK_C.title }],
    })
    await screen.findByRole('heading', { name: 'Your list' }, find)
    await screen.findByRole('heading', { name: 'Shows' }, find)
    expect(railNames()).toEqual(['Keep watching', 'Your list', 'Movies', 'Shows'])
    const list = screen.getByRole('heading', { name: 'Your list' }).closest('section')!
    expect(within(list).getAllByText('Saved By This Profile').length).toBeGreaterThan(0)
    const started = screen.getByRole('heading', { name: 'Keep watching' }).closest('section')!
    expect(within(started).getAllByText('Left Unfinished').length).toBeGreaterThan(0)
    expect(within(started).getAllByText('Pick Gamma').length).toBeGreaterThan(0)
  })

  it('builds "Your list" from the server\'s answer only, never from what this browser kept', async () => {
    // A title saved on this browser before the profile had a limit: the
    // server no longer lists it, and here its request fails outright.
    localStorage.clear()
    localStorage.setItem('aurora_my_library:1:2', JSON.stringify([{ id: 999, title: 'Saved Before The Limit', year: 2019, rating: 8, duration: '', genre: '', type: 'movie', poster: '', backdrop: '', description: '' }]))
    const page = renderTonight({ bound: 2, savedFails: true }, true)
    await screen.findByRole('heading', { name: 'Shows' }, find)
    await waitFor(() => expect(page.answered).toContain('/api/profiles/2/library'), find)
    await new Promise(done => setTimeout(done, 200))
    expect(railNames()).toEqual(['Movies', 'Shows'])
    expect(page.commits.filter(c => c.text.includes('Saved Before The Limit'))).toEqual([])
  })

  // The same person signing in again on the tab, bound to the same profile:
  // the answer their list had before they signed out does not vouch for
  // what this browser holds now.
  it('does not take an answer from before a sign-out as an answer for the list after signing in again', async () => {
    const page = renderTonight({ bound: 2, saved: [SAVED] })
    // Not vacuous: answered, and shown.
    await screen.findByRole('heading', { name: 'Your list' }, find)
    page.failSaved()
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    fireEvent.click(screen.getByRole('button', { name: /^Sign out/ }))
    const username = await screen.findByPlaceholderText('Enter username', {}, find)
    localStorage.setItem('aurora_my_library:1:2', JSON.stringify([{ id: 999, title: 'Saved Before The Limit', year: 2019, rating: 8, duration: '', genre: '', type: 'movie', poster: '', backdrop: '', description: '' }]))
    const since = page.commits.length
    fireEvent.change(username, { target: { value: 'ronnie' } })
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
    await screen.findByRole('heading', { name: 'Shows' }, find)
    await new Promise(done => setTimeout(done, 300))
    expect(railNames()).toEqual(['Movies', 'Shows'])
    expect(page.commits.slice(since).filter(c => c.text.includes('Saved Before The Limit'))).toEqual([])
  })
})
