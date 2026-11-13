// @vitest-environment jsdom
//
// The card menu, against the whole App and a stubbed server.
//
// A card's Play and Add buttons are pointer conveniences: out of the tab
// order, and not drawn on a touch screen. Everything else a card can do, and
// those two for a keyboard or a phone, is in the menu its More button opens.
// So this pins, for every page that draws a card (Tonight's rails, the Movies
// grid, My Library, Search, a collection):
//
//   - the card has a More button in the tab order, and it opens the menu with
//     Play or Resume and Add or Remove in it;
//
// and for the menu itself:
//
//   - what it offers follows the session: no "Watch together" for a profile
//     with a content limit, "Refresh metadata" only with admin powers (an
//     admin account acting as a restricted profile has none);
//   - "Watch together" on a show starts the party on an episode (the first
//     with a file when there is nothing to resume), the choice the title
//     page makes, because a party with no episode cannot be joined once it
//     is playing;
//   - Play on the poster and the menu's first row agree: with a position
//     saved, both resume, on any rail, not only Continue Watching.

import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import App from './App'
import { SESSION_EXPIRED_EVENT } from '@/lib/api'

// The party hook, as it is, unless a test puts the session in a party of
// its own (`partyStub.code`) or answers its joins (`partyStub.join`).
const partyStub = vi.hoisted(() => ({
  code: null as string | null,
  calls: [] as string[],
  join: null as null | ((code: string) => Promise<{ ok: boolean; error?: string }>),
}))
vi.mock('@/hooks/useParty', async (original) => {
  const real = await original<typeof import('@/hooks/useParty')>()
  return {
    ...real,
    useParty: (...args: Parameters<typeof real.useParty>) => {
      const party = real.useParty(...args)
      const join = partyStub.join
      if (!partyStub.code && !join) return party
      return {
        ...party,
        state: partyStub.code ? { ...party.state, code: partyStub.code } : party.state,
        leave: () => { partyStub.calls.push('leave') },
        join: async (code: string) => { partyStub.calls.push(`join ${code}`); return join ? join(code) : { ok: true } },
      }
    },
  }
})

// The player is replaced by a marker that says what it was asked to play.
// Its root carries what the real one's does (VideoPlayer.tsx): a modal
// dialog whose Escape layers are its own, except while it is minimised
// during a cast, when it is hidden and inert and claims nothing.
vi.mock('@/components/VideoPlayer', async (original) => {
  const { useState } = await import('react')
  return {
    ...(await original<typeof import('@/components/VideoPlayer')>()),
    VideoPlayer: ({ target, onSurfaceChange, onRemoteActiveChange }: { target: { mediaItemId: number; resumePositionMs?: number; episodeId?: number; seasonNumber?: number } | null; onSurfaceChange?: (s: 'theater' | 'fullscreen' | 'minimized' | null) => void; onRemoteActiveChange?: (active: boolean) => void }) => {
      const [minimized, setMinimized] = useState(false)
      const [remote, setRemote] = useState(false)
      // The real player tells App how it is presenting itself, and whether
      // it casts; a test says it for this one.
      playerShell.report = (s) => { setMinimized(s === 'minimized'); onSurfaceChange?.(s) }
      playerShell.casting = (active) => { setRemote(active); onRemoteActiveChange?.(active) }
      const minimizedActive = minimized && remote
      return target ? (
        <div
          data-test-player data-media={target.mediaItemId} data-resume={target.resumePositionMs ?? 0} data-episode={target.episodeId ?? ''} data-season={target.seasonNumber ?? ''}
          role={minimizedActive ? undefined : 'dialog'}
          aria-modal={minimizedActive ? undefined : true}
          aria-hidden={minimizedActive || undefined}
          data-escape-layers=""
        />
      ) : null
    },
  }
})
const playerShell = vi.hoisted(() => ({ report: null as ((s: 'theater' | 'fullscreen' | 'minimized' | null) => void) | null, casting: null as ((active: boolean) => void) | null }))

const NOW = '2026-10-01T00:00:00Z'
const PARENT = { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }
const KID = { id: 2, user_id: 1, name: 'Kid', is_default: false, created_at: NOW, updated_at: NOW, max_age_rating: 'PG' }
const item = (id: number, title: string, type = 'movie') => ({
  id, library_id: 1, type, title, year: 2020, rating: 7, overview: `${title}.`, added_at: NOW, updated_at: NOW,
})
const HALF = item(301, 'Half Watched')
const FRESH = item(303, 'Never Started')
const SHOW = item(302, 'Harbor Lights', 'show')
// A show part-way through two episodes at once, and one with Specials.
const TWO = item(304, 'Two Episodes', 'show')
const SPECIALS = item(305, 'Has Specials', 'show')
// Its first season's files are gone; only a Special can be played.
const PRUNED = item(306, 'Pruned First', 'show')
// Part-way through an episode of season 2; season 1's files are gone.
const AHEAD = item(307, 'Second Season In', 'show')
const FOUND = item(401, 'Found By Search')
const SAVED = item(501, 'Saved Title')
const COLLECTED = item(601, 'In A Collection')

function stubServer({ bound: boundAt = 1, role = 'user' } = {}) {
  let bound = boundAt
  /** Parties the server lists as live (Tonight's strip). */
  const live: unknown[] = []
  const me = { id: 1, username: 'ronnie', email: 'r@example.test', role }
  const asks: string[] = []
  /** What was written to a profile's library, in the order the server was asked. */
  const writes: string[] = []
  /** Library writes can be kept back, and failed: `waiting` are the answers
   *  kept back, `failing` how many of the next writes the server refuses
   *  (decided as each is asked). */
  const libraryWrites = { holding: false, waiting: [] as (() => void)[], failing: 0 }
  /** The titles in the profile's library, as the server has them. */
  const saved = new Set([SAVED.id])
  const libraryReads = { n: 0 }
  /** Requests the server fails, by path: with a status and the server's own
   *  words, or with the connection lost (fetch rejects). */
  /** Each removal of a title from the library, by its path. */
  const mediaDeletes: string[] = []
  const failing: { path: RegExp; how: { status: number; words: string } | 'network' }[] = []
  const parties: unknown[] = []
  const holds = new Map<string, Promise<void>>()
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    asks.push(p)
    // An admin's removal of a title from the library.
    if (init?.method === 'DELETE' && /^\/api\/media\/\d+$/.test(p)) {
      mediaDeletes.push(p)
      const kept = holds.get('media-delete')
      if (kept) await kept
      return json({ message: 'media deleted' })
    }
    // A switch binds the session to the profile it names.
    const activate = p.match(/^\/api\/profiles\/(\d+)\/activate$/)
    if (activate && init?.method === 'POST') { bound = Number(activate[1]); return new Response(null, { status: 204 }) }
    const failed = failing.find(f => f.path.test(p))?.how
    if (failed === 'network') throw new TypeError('Failed to fetch')
    if (failed) return json({ error: { code: failed.status, message: failed.words } }, failed.status)
    // The profile's lists, for the add-to-list sheet.
    if (/^\/api\/profiles\/\d+\/watchlists$/.test(p)) return json([{ id: 5, profile_id: 1, name: 'Weekend', created_at: NOW }])
    if (/^\/api\/profiles\/\d+\/library(\/\d+)?$/.test(p) && init?.method && init.method !== 'GET') {
      writes.push(`${init.method} ${p}`)
      const fails = libraryWrites.failing > 0
      if (fails) libraryWrites.failing--
      if (libraryWrites.holding) await new Promise<void>(done => { libraryWrites.waiting.push(done) })
      if (fails) return json({ error: { code: 500, message: 'failed to resolve library' } }, 500)
      // What the server keeps: the list a later read answers with.
      if (init.method === 'POST') saved.add(JSON.parse(String(init.body)).media_item_id)
      else saved.delete(Number(p.split('/').pop()))
      return new Response(null, { status: 204 })
    }
    // A held answer waits to be let go; a request abandoned meanwhile
    // rejects when its answer would have arrived, as fetch's does.
    const held = holds.get(p)
    if (held) await held
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (p === '/api/auth/me') return json(me)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: me })
    if (p === '/api/auth/login' && init?.method === 'POST') return json({ expires_in: 900, user: me })
    if (p === '/api/auth/setup-status') return json({ has_users: true })
    if (p === '/api/profiles') return json([PARENT, KID])
    if (p === '/api/profiles/active') return json(bound === 1 ? PARENT : KID)
    if (/^\/api\/profiles\/\d+\/library$/.test(p)) {
      libraryReads.n++
      return json([SAVED, HALF, FRESH, SHOW].filter(x => saved.has(x.id)).map(x => ({ media_item_id: x.id, title: x.title, type: x.type, year: 2020 })))
    }
    if (p === '/api/me/hero') return json({ picks: [], slate_token: 's' })
    if (p === '/api/media/recent') return json({ data: [HALF, FRESH, SHOW, SPECIALS, PRUNED] })
    if (p === '/api/media') {
      const type = url.searchParams.get('type')
      const data = type === 'show' ? [SHOW] : [HALF, FRESH]
      return json({ data, page: 1, per_page: 30, total_items: data.length, total_pages: 1 })
    }
    if (p === '/api/media/search') return json([FOUND])
    if (p === '/api/progress/continue') {
      return json([
        { media_item_id: HALF.id, title: HALF.title, type: 'movie', year: 2020, position_ms: 600_000, duration_ms: 6_000_000, percent_complete: 10 },
        { media_item_id: TWO.id, episode_id: 3041, season_number: 1, episode_number: 1, title: TWO.title, type: 'show', year: 2020, position_ms: 300_000, duration_ms: 3_000_000, percent_complete: 10 },
        { media_item_id: TWO.id, episode_id: 3042, season_number: 1, episode_number: 2, title: TWO.title, type: 'show', year: 2020, position_ms: 900_000, duration_ms: 3_000_000, percent_complete: 30 },
        { media_item_id: AHEAD.id, episode_id: 3072, season_number: 2, episode_number: 5, title: AHEAD.title, type: 'show', year: 2020, position_ms: 900_000, duration_ms: 3_000_000, percent_complete: 30 },
      ])
    }
    if (p === `/api/media/${TWO.id}/seasons/1/episodes`) {
      return json([3041, 3042].map((id, i) => ({ id, season_id: 1, media_item_id: TWO.id, episode_number: i + 1, files: [{ id: id + 5000, resolution: '1080p' }] })))
    }
    // Where the show starts (season 1), where this viewer is (season 2), and
    // a season with nothing to play (season 3): three different answers.
    if (p === `/api/media/${AHEAD.id}/seasons`) return json([{ id: 71, media_item_id: AHEAD.id, season_number: 1 }, { id: 72, media_item_id: AHEAD.id, season_number: 2 }, { id: 73, media_item_id: AHEAD.id, season_number: 3 }])
    if (p === `/api/media/${AHEAD.id}/seasons/1/episodes`) return json([{ id: 3071, season_id: 71, media_item_id: AHEAD.id, episode_number: 1, files: [{ id: 8071, resolution: '1080p' }] }])
    if (p === `/api/media/${AHEAD.id}/seasons/2/episodes`) return json([{ id: 3072, season_id: 72, media_item_id: AHEAD.id, episode_number: 5, files: [{ id: 8072, resolution: '1080p' }] }])
    if (p === `/api/media/${AHEAD.id}/seasons/3/episodes`) return json([{ id: 3073, season_id: 73, media_item_id: AHEAD.id, episode_number: 1, files: [] }])
    if (p === `/api/media/${PRUNED.id}/seasons`) return json([{ id: 60, media_item_id: PRUNED.id, season_number: 0 }, { id: 61, media_item_id: PRUNED.id, season_number: 1 }])
    if (p === `/api/media/${PRUNED.id}/seasons/1/episodes`) return json([{ id: 3061, season_id: 61, media_item_id: PRUNED.id, episode_number: 1, files: [] }])
    if (p === `/api/media/${PRUNED.id}/seasons/0/episodes`) return json([{ id: 3060, season_id: 60, media_item_id: PRUNED.id, episode_number: 1, files: [{ id: 8060, resolution: '1080p' }] }])
    // The title page's own record of a title.
    const byId = p.match(/^\/api\/media\/(\d+)$/)
    if (byId) {
      const it = [HALF, FRESH, SHOW, TWO, SPECIALS, PRUNED, AHEAD, FOUND].find(x => x.id === Number(byId[1]))
      return it ? json(it) : json({ error: { code: 404, message: 'not found' } }, 404)
    }
    // Season 0 is listed first, as the lowest number.
    if (p === `/api/media/${SPECIALS.id}/seasons`) return json([{ id: 50, media_item_id: SPECIALS.id, season_number: 0 }, { id: 51, media_item_id: SPECIALS.id, season_number: 1 }])
    const specials = p.match(new RegExp(`^/api/media/${SPECIALS.id}/seasons/(\\d)/episodes$`))
    if (specials) {
      const season = Number(specials[1])
      return json([{ id: 3050 + season, season_id: 50 + season, media_item_id: SPECIALS.id, episode_number: 1, files: [{ id: 8050 + season, resolution: '1080p' }] }])
    }
    if (p === '/api/collections') return json([{ id: 7, owner_user_id: 1, name: 'Rainy Day', kind: 'manual', is_public: false, item_count: 1 }])
    if (p === '/api/collections/7') return json({ collection: { id: 7, owner_user_id: 1, name: 'Rainy Day', kind: 'manual', is_public: false }, items: [COLLECTED] })
    if (p === `/api/media/${SHOW.id}/seasons`) return json([{ id: 1, media_item_id: SHOW.id, season_number: 1 }])
    if (p === `/api/media/${SHOW.id}/seasons/1/episodes`) {
      return json([
        { id: 3021, season_id: 1, media_item_id: SHOW.id, episode_number: 1, files: [] },
        { id: 3022, season_id: 1, media_item_id: SHOW.id, episode_number: 2, files: [{ id: 1, resolution: '1080p' }] },
      ])
    }
    if (/^\/api\/media\/\d+\/files$/.test(p)) return json([{ id: 9001, media_item_id: Number(p.split('/')[3]), resolution: '1080p' }])
    if (p === '/api/parties' && init?.method === 'POST') {
      parties.push(JSON.parse(String(init.body)))
      return json({ code: 'NEWPARTY' }, 201)
    }
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    if (p === '/api/parties/active') return json({ parties: live })
    return json([])
  })
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  return {
    asks, parties, writes, mediaDeletes, live,
    /** Keeps the answer to every library write back until the returned
     *  function is called; writes asked after that are answered at once. */
    holdLibraryWrites() {
      libraryWrites.holding = true
      return () => {
        libraryWrites.holding = false
        for (const answer of libraryWrites.waiting.splice(0)) answer()
      }
    },
    /** The server refuses the next `n` library writes. */
    failLibraryWrites(n = 1) { libraryWrites.failing = n },
    /** Answers the oldest library write kept back, and goes on keeping back the rest. */
    releaseOneLibraryWrite() { libraryWrites.waiting.shift()?.() },
    /** How often the profile's library has been read. */
    get libraryReads() { return libraryReads.n },
    /** The title page's read of a title fails from now on (see `failing`). */
    failDetail(how: { status: number; words: string } | 'network') { failing.push({ path: /^\/api\/media\/\d+$/, how }) },
    /** Requests to `path` fail from now on (see `failing`). */
    failAt(path: RegExp, how: { status: number; words: string } | 'network') { failing.push({ path, how }) },
    hold(path: string) {
      let release!: () => void
      holds.set(path, new Promise<void>(done => { release = done }))
      return () => { holds.delete(path); release() }
    },
  }
}

function renderAt(path: string, opts: { bound?: number; role?: string; prefs?: Record<string, unknown>; before?: (server: ReturnType<typeof stubServer>) => void } = {}) {
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify({ id: 1, username: 'ronnie', email: 'r@example.test', role: opts.role ?? 'user' }))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true, ...opts.prefs }))
  const server = stubServer(opts)
  opts.before?.(server)
  render(<MemoryRouter initialEntries={[path]}><GoBack /><App /></MemoryRouter>)
  return server
}
/** The browser's Back button. */
const browser = { back: () => {} }
function GoBack() {
  const navigate = useNavigate()
  useEffect(() => { browser.back = () => navigate(-1) }, [navigate])
  return null
}

const find = { timeout: 5000 }
/** Opens a card's menu from its More button and returns the rows' labels. */
async function openMenu(title: string, within_: HTMLElement = document.body) {
  const more = (await within(within_).findAllByRole('button', { name: `More actions for ${title}` }, find))[0]
  // The keyboard's way in: More is a tab stop.
  expect(more.tabIndex).toBe(0)
  fireEvent.click(more)
  const menu = await screen.findByRole('menu', { name: `Actions for ${title}` }, find)
  return { more, menu, rows: within(menu).getAllByRole('menuitem').map(r => r.textContent ?? '') }
}
/** A rail on Tonight, by its heading. */
const rail = async (name: string) => (await screen.findByRole('heading', { name }, find)).closest('section') as HTMLElement

vi.setConfig({ testTimeout: 20_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); partyStub.code = null; partyStub.join = null; partyStub.calls = [] })

describe('every page that draws a card gives it the menu', () => {
  it('Tonight\'s rails', async () => {
    renderAt('/')
    const { rows, more } = await openMenu('Never Started', await rail('Recently Added'))
    expect(rows).toContain('Play')
    expect(rows).toContain('Add to My Library')
    expect(more.getAttribute('aria-expanded')).toBe('true')
  })

  it('the Movies grid', async () => {
    renderAt('/movies')
    const { rows } = await openMenu('Never Started')
    expect(rows).toContain('Play')
    expect(rows).toContain('Add to My Library')
  })

  // The list layout is a kept choice, for both grids. Its rows are not
  // cards, and had none of this: no More button, no long press, no Play.
  it('the Movies grid as a list', async () => {
    renderAt('/movies', { prefs: { library_view: 'list' } })
    await screen.findByText('Never Started', {}, find)
    expect(document.querySelector('[data-browse-layout="list"]')).not.toBeNull()
    const { rows, menu } = await openMenu('Never Started')
    expect(rows).toContain('Play')
    expect(rows).toContain('Add to My Library')
    fireEvent.keyDown(menu, { key: 'Escape' })
    // A title with a saved position: the row's own button and the menu's
    // first row both say Resume, and the button resumes.
    expect((await openMenu('Half Watched')).rows[0]).toMatch(/^Resume/)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Resume Half Watched' }))
    await waitFor(() => expect(document.querySelector('[data-test-player]')).not.toBeNull(), find)
    expect(document.querySelector('[data-test-player]')!.getAttribute('data-resume')).toBe('600000')
  })

  // The only way a keyboard or a phone takes a title back out of My Library.
  it('My Library', async () => {
    renderAt('/library')
    const { rows } = await openMenu('Saved Title')
    expect(rows).toContain('Play')
    expect(rows).toContain('Remove from My Library')
  })

  // A title removed by mistake is one press from being back.
  it('My Library: a removal says so with an Undo, which puts the title back and says nothing more', async () => {
    const server = renderAt('/library')
    const { menu } = await openMenu('Saved Title')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from My Library' }))
    const said = await screen.findByText('Removed Saved Title from My Library.', {}, find)
    await waitFor(() => expect(document.querySelector('[data-library-empty]')).not.toBeNull(), find)
    expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`])
    fireEvent.click(within(said.closest('.toast') as HTMLElement).getByRole('button', { name: 'Undo' }))
    // Back in the list, saved again on the server.
    await screen.findAllByRole('button', { name: 'More actions for Saved Title' }, find)
    expect(document.querySelector('[data-library-empty]')).toBeNull()
    expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`, 'POST /api/profiles/1/library'])
    // The Undo's own toast leaves, and the title coming back is not announced as a new save.
    await waitFor(() => expect(screen.queryByText('Removed Saved Title from My Library.')).toBeNull(), find)
    expect(screen.queryByText(/^Saved Saved Title/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  // Undo was the toggle called again, which flips whatever the list says by
  // then. A removal the server refused had already been taken back on
  // screen, so its Undo sent the removal a second time.
  it('My Library: a removal the server refuses takes back its own toast, and the Undo with it', async () => {
    const server = renderAt('/library')
    const { menu } = await openMenu('Saved Title')
    server.failLibraryWrites()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from My Library' }))
    await screen.findByText('Couldn\'t remove "Saved Title" — try again', {}, find)
    // The title is back, and nothing on the page still says it was removed or offers to undo that.
    await screen.findAllByRole('button', { name: 'More actions for Saved Title' }, find)
    expect(screen.queryByText('Removed Saved Title from My Library.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`])
  })

  it('My Library: a save the server refuses takes back its own toast too', async () => {
    const server = renderAt('/movies')
    const { menu } = await openMenu('Never Started')
    server.failLibraryWrites()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add to My Library' }))
    await screen.findByText('Couldn\'t save "Never Started" — try again', {}, find)
    expect(screen.queryByText('Saved Never Started to My Library.')).toBeNull()
    expect((await openMenu('Never Started')).rows).toContain('Add to My Library')
  })

  // Pressed while the removal is still out, Undo sent a POST that nothing
  // ordered after the DELETE: whichever the server took last won.
  it('My Library: an Undo pressed while its removal is still out puts the title back at once, and is sent after the removal', async () => {
    const server = renderAt('/library')
    const { menu } = await openMenu('Saved Title')
    const release = server.holdLibraryWrites()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from My Library' }))
    const said = await screen.findByText('Removed Saved Title from My Library.', {}, find)
    await waitFor(() => expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`]), find)
    fireEvent.click(within(said.closest('.toast') as HTMLElement).getByRole('button', { name: 'Undo' }))
    // Back on screen without waiting for the server,
    await screen.findAllByRole('button', { name: 'More actions for Saved Title' }, find)
    // and nothing more is asked of the server until the removal has been answered.
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`])
    release()
    await waitFor(() => expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`, 'POST /api/profiles/1/library']), find)
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    expect(screen.getAllByRole('button', { name: 'More actions for Saved Title' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('My Library: and when that removal then fails, the title stays and nobody is asked to remove it again', async () => {
    const server = renderAt('/library')
    const { menu } = await openMenu('Saved Title')
    const release = server.holdLibraryWrites()
    server.failLibraryWrites()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from My Library' }))
    const said = await screen.findByText('Removed Saved Title from My Library.', {}, find)
    fireEvent.click(within(said.closest('.toast') as HTMLElement).getByRole('button', { name: 'Undo' }))
    await screen.findAllByRole('button', { name: 'More actions for Saved Title' }, find)
    release()
    // The save still goes to the server, after the removal it follows: it is what was asked for last.
    await waitFor(() => expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`, 'POST /api/profiles/1/library']), find)
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    expect(screen.getAllByRole('button', { name: 'More actions for Saved Title' }).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Couldn't/)).toBeNull()
    expect(document.querySelector('[data-library-empty]')).toBeNull()
  })

  // Each write's in-flight mark is its own. Cleared by its value, the first
  // removal's answer cleared the mark of a second removal still waiting, and
  // a read of the list in between (here another tab's sign-in record
  // changing, which reads /me and the list again) put the title back on
  // screen while that removal was still on its way.
  it('My Library: a removal waiting behind others is still on screen as made when the list is read again', async () => {
    const server = renderAt('/library')
    const remove = async () => fireEvent.click(within((await openMenu('Saved Title')).menu).getByRole('menuitem', { name: 'Remove from My Library' }))
    const DELETE = `DELETE /api/profiles/1/library/${SAVED.id}`
    const POST = 'POST /api/profiles/1/library'
    server.holdLibraryWrites()
    await remove()
    const said = await screen.findByText('Removed Saved Title from My Library.', {}, find)
    await waitFor(() => expect(server.writes).toEqual([DELETE]), find)
    fireEvent.click(within(said.closest('.toast') as HTMLElement).getByRole('button', { name: 'Undo' }))
    await screen.findAllByRole('button', { name: 'More actions for Saved Title' }, find)
    await remove()
    await waitFor(() => expect(document.querySelector('[data-library-empty]')).not.toBeNull(), find)
    // The first removal is answered; then the save behind it. The second
    // removal is on its way, and the server still has the title.
    act(() => server.releaseOneLibraryWrite())
    await waitFor(() => expect(server.writes).toEqual([DELETE, POST]), find)
    act(() => server.releaseOneLibraryWrite())
    await waitFor(() => expect(server.writes).toEqual([DELETE, POST, DELETE]), find)
    const reads = server.libraryReads
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'aurora_user', newValue: localStorage.getItem('aurora_user') })) })
    await waitFor(() => expect(server.libraryReads).toBeGreaterThan(reads), find)
    await act(async () => { await new Promise(done => setTimeout(done, 100)) })
    expect(document.querySelector('[data-library-empty]')).not.toBeNull()
    expect(screen.queryAllByRole('button', { name: 'More actions for Saved Title' })).toHaveLength(0)
  })

  // A failure in the middle of a title's writes: the first removal is
  // refused, the save and the second removal are taken. Taking the refused
  // removal back on screen, after the second removal had been made there,
  // put the title back; the server no longer had it. The queue ends with
  // the server's own list.
  it('My Library: when a write in the middle of a title\'s writes is refused, the list on screen ends as the server has it', async () => {
    const server = renderAt('/library')
    const remove = async () => fireEvent.click(within((await openMenu('Saved Title')).menu).getByRole('menuitem', { name: 'Remove from My Library' }))
    const release = server.holdLibraryWrites()
    server.failLibraryWrites()
    await remove()
    const said = await screen.findByText('Removed Saved Title from My Library.', {}, find)
    fireEvent.click(within(said.closest('.toast') as HTMLElement).getByRole('button', { name: 'Undo' }))
    await screen.findAllByRole('button', { name: 'More actions for Saved Title' }, find)
    await remove()
    const reads = server.libraryReads
    // The read the queue ends with is kept back: until it is in, the screen
    // is what the viewer made, not the refused removal taken back on it.
    const releaseRead = server.hold('/api/profiles/1/library')
    release()
    await waitFor(() => expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`, 'POST /api/profiles/1/library', `DELETE /api/profiles/1/library/${SAVED.id}`]), find)
    await act(async () => { await new Promise(done => setTimeout(done, 100)) })
    expect(document.querySelector('[data-library-empty]')).not.toBeNull()
    expect(screen.queryAllByRole('button', { name: 'More actions for Saved Title' })).toHaveLength(0)
    releaseRead()
    await waitFor(() => expect(server.libraryReads).toBeGreaterThan(reads), find)
    await act(async () => { await new Promise(done => setTimeout(done, 100)) })
    expect(document.querySelector('[data-library-empty]')).not.toBeNull()
    expect(screen.queryByText(/Couldn't/)).toBeNull()
  })

  // Two refusals in a row: the removal, then the Undo queued behind it.
  // Taking the Undo back on screen removed the title there; the server
  // still had it, and the list said otherwise until it was next read.
  it('My Library: a removal and its Undo both refused leave the title on screen, as the server has it', async () => {
    const server = renderAt('/library')
    const release = server.holdLibraryWrites()
    server.failLibraryWrites(2)
    fireEvent.click(within((await openMenu('Saved Title')).menu).getByRole('menuitem', { name: 'Remove from My Library' }))
    const said = await screen.findByText('Removed Saved Title from My Library.', {}, find)
    fireEvent.click(within(said.closest('.toast') as HTMLElement).getByRole('button', { name: 'Undo' }))
    await screen.findAllByRole('button', { name: 'More actions for Saved Title' }, find)
    const reads = server.libraryReads
    release()
    await waitFor(() => expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`, 'POST /api/profiles/1/library']), find)
    await waitFor(() => expect(server.libraryReads).toBeGreaterThan(reads), find)
    await act(async () => { await new Promise(done => setTimeout(done, 100)) })
    expect(screen.queryAllByRole('button', { name: 'More actions for Saved Title' }).length).toBeGreaterThan(0)
    expect(document.querySelector('[data-library-empty]')).toBeNull()
  })

  // "Couldn't" is said of the last thing asked for a title only: a save the
  // server refused, after which its viewer removed the title by hand, is
  // not one to try again.
  it('My Library: a refused save its viewer has undone by hand since is not said to have failed', async () => {
    const server = renderAt('/movies')
    const pick = async (row: string) => fireEvent.click(within((await openMenu('Never Started')).menu).getByRole('menuitem', { name: row }))
    const release = server.holdLibraryWrites()
    server.failLibraryWrites()
    await pick('Add to My Library')
    await pick('Remove from My Library')
    release()
    await waitFor(() => expect(server.writes).toEqual(['POST /api/profiles/1/library', `DELETE /api/profiles/1/library/${FRESH.id}`]), find)
    await act(async () => { await new Promise(done => setTimeout(done, 100)) })
    expect(screen.queryByText(/Couldn't/)).toBeNull()
    expect((await openMenu('Never Started')).rows).toContain('Add to My Library')
  })

  // The title page's read of a title failed, and the page printed the
  // server's own words under the stars ("not found", a 5xx's text, "Failed
  // to fetch"). Anything but a 404 keeps the page, said in its own words.
  it.each([
    ['a 500', { status: 500, words: 'pq: connection refused' }, 'Could not load this title\'s details just now.', /pq: connection refused/],
    ['a lost connection', 'network' as const, 'Could not reach the server. Check the connection and try again.', /Failed to fetch/],
  ])('the title page says %s in its own words, and stays', async (_how, how, says, raw) => {
    const server = renderAt('/movies')
    await screen.findAllByRole('button', { name: 'More actions for Never Started' }, find)
    server.failDetail(how)
    fireEvent.click(document.querySelector(`[data-media-id="${FRESH.id}"] .card-open`)!)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: FRESH.title })).toBeInTheDocument(), find)
    await screen.findByText(says, {}, find)
    expect(screen.queryByText(raw)).toBeNull()
  })

  // A 404 (the title is gone, or above the profile's limit: the server
  // answers both alike) leaves the page: kept up, it offered Play, saving
  // and a party for a title none of them could reach, beside the card's
  // description. Back to where the viewer was, and said there.
  it('the title page is left on a 404: Back to the grid, said there, nothing of the title on screen', async () => {
    const server = renderAt('/movies')
    await screen.findAllByRole('button', { name: 'More actions for Never Started' }, find)
    server.failDetail({ status: 404, words: 'not found' })
    fireEvent.click(document.querySelector(`[data-media-id="${FRESH.id}"] .card-open`)!)
    await screen.findByText('This title is not available.', {}, find)
    await waitFor(() => expect(screen.queryByRole('heading', { level: 1, name: FRESH.title })).toBeNull(), find)
    // Back on the grid it was opened from.
    expect(await screen.findAllByRole('button', { name: 'More actions for Never Started' }, find)).not.toHaveLength(0)
    expect(screen.queryByText(`${FRESH.title}.`)).toBeNull()
    expect(screen.queryByText(/not found/)).toBeNull()
  })

  it('the title page is left on a 404 for a title opened from a search: Back to the results, the words still in the bar', async () => {
    const server = renderAt('/')
    await rail('Recently Added')
    const input = document.querySelector<HTMLInputElement>('.stage-navsearch input')!
    fireEvent.change(input, { target: { value: 'found' } })
    const result = await screen.findByRole('button', { name: /^Found By Search/ }, find)
    server.failDetail({ status: 404, words: 'not found' })
    fireEvent.click(result)
    await screen.findByText('This title is not available.', {}, find)
    await waitFor(() => expect(document.querySelector('[data-search-results]')).not.toBeNull(), find)
    expect(screen.queryByRole('heading', { level: 1, name: FOUND.title })).toBeNull()
    expect(input.value).toBe('found')
    expect(screen.queryByText(`${FOUND.title}.`)).toBeNull()
  })

  // Play's failure was a toast of the server's own words.
  it('Play that fails says so in the app\'s words', async () => {
    const server = renderAt('/movies')
    await screen.findAllByRole('button', { name: 'More actions for Never Started' }, find)
    server.failAt(/^\/api\/media\/\d+\/files$/, { status: 500, words: 'pq: connection refused' })
    fireEvent.click(await screen.findByRole('button', { name: 'Play Never Started' }, find))
    await screen.findByText('Could not play this title just now.', {}, find)
    expect(screen.queryByText(/pq: connection refused/)).toBeNull()
    expect(document.querySelector('[data-test-player]')).toBeNull()
  })

  // A card menu's action that failed opened the browser's own box with the
  // server's words ("Failed: …"). It is a toast in the app's words.
  it('a card menu\'s action that fails is a toast in the app\'s words, not a native box', async () => {
    const native = vi.spyOn(window, 'alert').mockImplementation(() => {})
    try {
      const server = renderAt('/movies')
      server.failAt(/^\/api\/progress\/\d+\/watched$/, { status: 500, words: 'pq: connection refused' })
      fireEvent.click(within((await openMenu('Never Started')).menu).getByRole('menuitem', { name: 'Mark as watched' }))
      await screen.findByText('Could not mark it as watched just now.', {}, find)
      expect(screen.queryByText(/pq: connection refused/)).toBeNull()
      expect(native).not.toHaveBeenCalled()
    } finally {
      native.mockRestore()
    }
  })

  // Tonight's cold load that failed showed the server's words under
  // "Couldn't load your library".
  it('Tonight\'s cold load that fails says so in the app\'s words', async () => {
    renderAt('/', { before: server => server.failAt(/^\/api\/media\/recent$/, { status: 500, words: 'pq: connection refused' }) })
    expect((await screen.findByText('Could not load Tonight just now.', {}, find)).closest('[role="alert"]')).not.toBeNull()
    expect(screen.queryByText(/pq: connection refused/)).toBeNull()
  })

  // The add-to-list sheet's failure was the browser's own box with the
  // server's words. It is said in the sheet.
  it('the add-to-list sheet says a failed add in the sheet, in the app\'s words', async () => {
    const native = vi.spyOn(window, 'alert').mockImplementation(() => {})
    try {
      renderAt('/movies', { before: server => server.failAt(/^\/api\/profiles\/\d+\/watchlists\/\d+\/items$/, { status: 500, words: 'pq: connection refused' }) })
      fireEvent.click(within((await openMenu('Never Started')).menu).getByRole('menuitem', { name: 'Add to a list…' }))
      const sheet = await screen.findByRole('dialog', { name: /Add "Never Started" to a watchlist/ }, find)
      fireEvent.click(await within(sheet).findByRole('button', { name: 'Weekend' }, find))
      expect((await within(sheet).findByRole('alert', {}, find)).textContent).toBe('Could not add it to "Weekend" just now.')
      expect(screen.queryByText(/pq: connection refused/)).toBeNull()
      expect(native).not.toHaveBeenCalled()
    } finally {
      native.mockRestore()
    }
  })

  // An admin's "Remove from library" asked with the browser's own box. It
  // asks with the app's dialog; one press sends one request.
  it('an admin\'s remove from library asks with the app\'s dialog, not a native box, and sends one request', async () => {
    const native = vi.spyOn(window, 'confirm').mockImplementation(() => true)
    try {
      const server = renderAt(`/title/${FRESH.id}`, { role: 'admin' })
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: FRESH.title })).toBeInTheDocument(), find)
      fireEvent.click(await screen.findByRole('button', { name: /^Manage/ }, find))
      fireEvent.click(await screen.findByRole('button', { name: 'Remove from library' }, find))
      const dialog = await screen.findByRole('alertdialog', {}, find)
      expect(dialog.textContent).toContain(`Remove "${FRESH.title}" from Aurora?`)
      const remove = within(dialog).getByRole('button', { name: 'Remove' })
      fireEvent.click(remove)
      fireEvent.click(remove)
      await screen.findByText(`Removed "${FRESH.title}" from the library`, {}, find)
      expect(server.mediaDeletes).toEqual([`/api/media/${FRESH.id}`])
      expect(native).not.toHaveBeenCalled()
    } finally {
      native.mockRestore()
    }
  })

  // Saved again by hand while "Removed … Undo" was still up, the title was
  // removed by that Undo, with nothing said.
  it('My Library: an Undo does nothing to a title its viewer has saved again since', async () => {
    const server = renderAt('/movies')
    const pick = async (row: string) => fireEvent.click(within((await openMenu('Never Started')).menu).getByRole('menuitem', { name: row }))
    await pick('Add to My Library')
    await pick('Remove from My Library')
    const said = await screen.findByText('Removed Never Started from My Library.', {}, find)
    await pick('Add to My Library')
    await waitFor(() => expect(server.writes).toEqual(['POST /api/profiles/1/library', `DELETE /api/profiles/1/library/${FRESH.id}`, 'POST /api/profiles/1/library']), find)
    fireEvent.click(within(said.closest('.toast') as HTMLElement).getByRole('button', { name: 'Undo' }))
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    expect(server.writes).toHaveLength(3)
    // Still saved: its menu offers to remove it.
    expect((await openMenu('Never Started')).rows).toContain('Remove from My Library')
  })

  it('My Library: an Undo pressed twice puts the title back once', async () => {
    const server = renderAt('/library')
    const { menu } = await openMenu('Saved Title')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from My Library' }))
    const said = await screen.findByText('Removed Saved Title from My Library.', {}, find)
    const undo = within(said.closest('.toast') as HTMLElement).getByRole('button', { name: 'Undo' })
    fireEvent.click(undo)
    fireEvent.click(undo)
    await screen.findAllByRole('button', { name: 'More actions for Saved Title' }, find)
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    expect(server.writes).toEqual([`DELETE /api/profiles/1/library/${SAVED.id}`, 'POST /api/profiles/1/library'])
    expect(document.querySelector('[data-library-empty]')).toBeNull()
  })

  // A save and a removal made one after the other could pass each other on
  // the way: each was sent as it was pressed, and the server kept whichever
  // it took last.
  it('My Library: a save and a removal in quick succession reach the server in the order they were made', async () => {
    const server = renderAt('/movies')
    const pick = async (row: string) => fireEvent.click(within((await openMenu('Never Started')).menu).getByRole('menuitem', { name: row }))
    const release = server.holdLibraryWrites()
    await pick('Add to My Library')
    await pick('Remove from My Library')
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    // The removal waits for the save's answer.
    expect(server.writes).toEqual(['POST /api/profiles/1/library'])
    release()
    await waitFor(() => expect(server.writes).toEqual(['POST /api/profiles/1/library', `DELETE /api/profiles/1/library/${FRESH.id}`]), find)
    expect((await openMenu('Never Started')).rows).toContain('Add to My Library')
  })

  // With nothing saved the page offers what to do next, in place.
  it('My Library: emptied, it offers a search for something to save and the two catalogs, and each goes there', async () => {
    renderAt('/library')
    const emptied = async () => {
      const { menu } = await openMenu('Saved Title')
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from My Library' }))
      return await waitFor(() => {
        const el = document.querySelector<HTMLElement>('[data-library-empty]')
        if (!el) throw new Error('not empty yet')
        return el
      }, find)
    }
    fireEvent.click(within(await emptied()).getByRole('button', { name: 'Browse movies' }))
    // The Movies grid, with a title of the catalog on it.
    await screen.findAllByRole('button', { name: /Never Started/ }, find)
    expect(document.querySelector('[data-library-empty]')).toBeNull()
    cleanup()
    renderAt('/library')
    const field = within(await emptied()).getByRole('searchbox', { name: 'Find something to save' })
    fireEvent.change(field, { target: { value: 'found' } })
    fireEvent.submit(field.closest('form')!)
    // The search page, with the words in the bar's field and their result.
    await screen.findByRole('button', { name: /^Found By Search/ }, find)
    expect(document.querySelector('[data-search-results]')).not.toBeNull()
    expect((document.querySelector('.stage-navsearch input') as HTMLInputElement).value).toBe('found')
  })

  it('My Library: saving a title says so, with nothing to undo', async () => {
    renderAt('/movies')
    const { menu } = await openMenu('Never Started')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add to My Library' }))
    const said = await screen.findByText('Saved Never Started to My Library.', {}, find)
    expect(within(said.closest('.toast') as HTMLElement).queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(within(said.closest('.toast') as HTMLElement).getByRole('button', { name: 'Dismiss notification' })).toBeInTheDocument()
  })

  it('My Library\'s Continue Watching, where it resumes', async () => {
    renderAt('/library')
    const { rows } = await openMenu('Half Watched')
    expect(rows.some(r => r.startsWith('Resume'))).toBe(true)
  })

  // A show can have a card per episode there. The menu opened from a card
  // resumes THAT card's episode, as its own Play does, not the first record
  // found for the show.
  it('My Library\'s Continue Watching resumes the card\'s own episode from its menu', async () => {
    renderAt('/library')
    const mores = await screen.findAllByRole('button', { name: 'More actions for Two Episodes' }, find)
    expect(mores).toHaveLength(2)
    fireEvent.click(mores[1])
    const menu = await screen.findByRole('menu', { name: 'Actions for Two Episodes' }, find)
    fireEvent.click(within(menu).getAllByRole('menuitem')[0])
    await waitFor(() => expect(document.querySelector('[data-test-player]')).not.toBeNull(), find)
    const player = document.querySelector('[data-test-player]')!
    expect(player.getAttribute('data-episode')).toBe('3042')
    expect(player.getAttribute('data-resume')).toBe('900000')
  })

  it('and the first card\'s menu resumes the first', async () => {
    renderAt('/library')
    const mores = await screen.findAllByRole('button', { name: 'More actions for Two Episodes' }, find)
    fireEvent.click(mores[0])
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Actions for Two Episodes' }, find)).getAllByRole('menuitem')[0])
    await waitFor(() => expect(document.querySelector('[data-test-player]')).not.toBeNull(), find)
    expect(document.querySelector('[data-test-player]')!.getAttribute('data-episode')).toBe('3041')
  })

  it('Search results', async () => {
    renderAt('/')
    fireEvent.change(await screen.findByRole('searchbox', {}, find).catch(() => screen.getByPlaceholderText(/Search/)), { target: { value: 'found' } })
    const { rows } = await openMenu('Found By Search')
    expect(rows).toContain('Play')
    expect(rows).toContain('Add to My Library')
  })

  it('a collection', async () => {
    renderAt('/collections')
    fireEvent.click(await screen.findByText('Rainy Day', {}, find))
    const { rows } = await openMenu('In A Collection')
    expect(rows).toContain('Play')
    expect(rows).toContain('Add to My Library')
  })
})

describe('what the menu offers follows the session', () => {
  // A profile with a content limit has the calmer Tonight: two shelves,
  // "Movies" and "Shows", and no "Recently Added".
  const offered = async (opts: { bound?: number; role?: string }) => {
    renderAt('/', opts)
    return (await openMenu('Never Started', await rail(opts.bound === 2 ? 'Movies' : 'Recently Added'))).rows
  }

  it('an unrestricted profile, not an admin: Watch together, no Refresh metadata', async () => {
    const rows = await offered({ bound: 1, role: 'user' })
    expect(rows).toContain('Watch together')
    expect(rows.some(r => r.startsWith('Refresh metadata'))).toBe(false)
  })

  it('an unrestricted profile on an admin account: both', async () => {
    const rows = await offered({ bound: 1, role: 'admin' })
    expect(rows).toContain('Watch together')
    expect(rows.some(r => r.startsWith('Refresh metadata'))).toBe(true)
  })

  it('a profile with a content limit: neither, on a user account', async () => {
    const rows = await offered({ bound: 2, role: 'user' })
    expect(rows).not.toContain('Watch together')
    expect(rows.some(r => r.startsWith('Refresh metadata'))).toBe(false)
    // What it keeps: playing, and its own list.
    expect(rows).toContain('Play')
    expect(rows).toContain('Add to My Library')
  })

  it('a profile with a content limit on an admin account: still neither', async () => {
    const rows = await offered({ bound: 2, role: 'admin' })
    expect(rows).not.toContain('Watch together')
    expect(rows.some(r => r.startsWith('Refresh metadata'))).toBe(false)
  })
})

describe('Watch together, from a card', () => {
  it('starts a show\'s party on its first episode with a file, as the title page does', async () => {
    const server = renderAt('/')
    const { menu } = await openMenu('Harbor Lights', await rail('Recently Added'))
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Watch together' }))
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    // The episodes were read to make the choice.
    expect(server.asks).toContain(`/api/media/${SHOW.id}/seasons`)
    expect(server.asks).toContain(`/api/media/${SHOW.id}/seasons/1/episodes`)
    const buttons = within(composer).getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(server.parties).toHaveLength(1), find)
    expect(server.parties[0]).toMatchObject({ media_item_id: SHOW.id, episode_id: 3022 })
  })

  it('starts a show with Specials on its first regular episode, and says it is working meanwhile', async () => {
    const server = renderAt('/')
    const { menu } = await openMenu('Has Specials', await rail('Recently Added'))
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Watch together' }))
    // Nothing else changes on screen while the episodes are read.
    await screen.findByText(/Getting "Has Specials" ready to watch together/, {}, find)
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    const buttons = within(composer).getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(server.parties).toHaveLength(1), find)
    expect(server.parties[0]).toMatchObject({ media_item_id: SPECIALS.id, episode_id: 3051 })
    expect(server.asks).not.toContain(`/api/media/${SPECIALS.id}/seasons/0/episodes`)
  })

  // The card and the title page must choose the SAME episode, and the page
  // must list the season its Play starts. The page used to open on the
  // lowest season number, which is Specials, while the card tried them last.
  it('the title page of a show with Specials opens on its first regular season, and its party opens on the card\'s episode', async () => {
    const server = renderAt(`/title/${SPECIALS.id}`)
    const seasons = await screen.findByRole('group', { name: 'Season' }, find)
    // Listed in number order (season 0 is named Specials); the regular
    // season is the one showing.
    const buttons = within(seasons).getAllByRole('button')
    expect(buttons.map(b => b.textContent)).toEqual(['Specials', 'Season 1'])
    expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
    expect(server.asks).toContain(`/api/media/${SPECIALS.id}/seasons/1/episodes`)
    expect(server.asks).not.toContain(`/api/media/${SPECIALS.id}/seasons/0/episodes`)
    fireEvent.click(await screen.findByRole('button', { name: 'Watch together' }, find))
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    const actions = within(composer).getAllByRole('button')
    fireEvent.click(actions[actions.length - 1])
    await waitFor(() => expect(server.parties).toHaveLength(1), find)
    // 3051: the episode the card's "Watch together" posts for this show, above.
    expect(server.parties[0]).toMatchObject({ media_item_id: SPECIALS.id, episode_id: 3051 })
  })

  // A show whose first season's files are gone but whose Specials can be
  // played. The page used to open on that first season: every row listed
  // had nothing to play, its Play started a Special it was not showing, and
  // its party was created with no episode, which nobody can join.
  it('the title page of a show whose first season has nothing to play opens on the season that does, and its party gets that episode', async () => {
    const server = renderAt(`/title/${PRUNED.id}`)
    const seasons = await screen.findByRole('group', { name: 'Season' }, find)
    // Season 0 is listed first and is the one showing.
    await waitFor(() => expect(within(seasons).getAllByRole('button').map(b => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']), find)
    expect(server.asks).toContain(`/api/media/${PRUNED.id}/seasons/1/episodes`)
    expect(server.asks).toContain(`/api/media/${PRUNED.id}/seasons/0/episodes`)
    fireEvent.click(await screen.findByRole('button', { name: 'Watch together' }, find))
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    const actions = within(composer).getAllByRole('button')
    fireEvent.click(actions[actions.length - 1])
    await waitFor(() => expect(server.parties).toHaveLength(1), find)
    // 3060: what the card's Play starts for this show, below.
    expect(server.parties[0]).toMatchObject({ media_item_id: PRUNED.id, episode_id: 3060 })
  })

  it('and when the viewer has moved the page to a season with nothing to play, the party still gets the show\'s episode', async () => {
    const server = renderAt(`/title/${PRUNED.id}`)
    const seasons = await screen.findByRole('group', { name: 'Season' }, find)
    await waitFor(() => expect(within(seasons).getAllByRole('button').map(b => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']), find)
    const before = server.asks.filter(a => a === `/api/media/${PRUNED.id}/seasons/1/episodes`).length
    fireEvent.click(within(seasons).getAllByRole('button')[1])
    await waitFor(() => expect(within(seasons).getAllByRole('button').map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']), find)
    // The page now lists season 1, whose one episode has no file.
    await waitFor(() => expect(server.asks.filter(a => a === `/api/media/${PRUNED.id}/seasons/1/episodes`).length).toBeGreaterThan(before), find)
    await new Promise(done => setTimeout(done, 50))
    fireEvent.click(await screen.findByRole('button', { name: 'Watch together' }, find))
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    const actions = within(composer).getAllByRole('button')
    fireEvent.click(actions[actions.length - 1])
    await waitFor(() => expect(server.parties).toHaveLength(1), find)
    expect(server.parties[0]).toMatchObject({ media_item_id: PRUNED.id, episode_id: 3060 })
  })

  // The viewer's own place in the show, wherever the page has been moved to.
  it('and the party of a show the viewer is part-way through opens on their episode, from any season of the page', async () => {
    const server = renderAt(`/title/${AHEAD.id}`)
    const seasons = await screen.findByRole('group', { name: 'Season' }, find)
    // The page opens on the season they are in.
    await waitFor(() => expect(within(seasons).getByRole('button', { name: 'Season 2' }).getAttribute('aria-pressed')).toBe('true'), find)
    // They look at season 3, where nothing can be played.
    fireEvent.click(within(seasons).getByRole('button', { name: 'Season 3' }))
    await waitFor(() => expect(within(seasons).getByRole('button', { name: 'Season 3' }).getAttribute('aria-pressed')).toBe('true'), find)
    await waitFor(() => expect(server.asks).toContain(`/api/media/${AHEAD.id}/seasons/3/episodes`), find)
    await new Promise(done => setTimeout(done, 50))
    fireEvent.click(await screen.findByRole('button', { name: 'Watch together' }, find))
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    const actions = within(composer).getAllByRole('button')
    fireEvent.click(actions[actions.length - 1])
    await waitFor(() => expect(server.parties).toHaveLength(1), find)
    // Their episode: not the show's first (3071), and not no episode.
    expect(server.parties[0]).toMatchObject({ media_item_id: AHEAD.id, episode_id: 3072 })
  })

  it('starts a movie\'s party with no episode, and reads none', async () => {
    const server = renderAt('/')
    const { menu } = await openMenu('Never Started', await rail('Recently Added'))
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Watch together' }))
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    const buttons = within(composer).getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => expect(server.parties).toHaveLength(1), find)
    expect(server.parties[0]).toMatchObject({ media_item_id: FRESH.id })
    expect((server.parties[0] as { episode_id?: number }).episode_id).toBeUndefined()
    expect(server.asks.some(a => a.endsWith('/seasons'))).toBe(false)
  })
})

describe('Play on the poster and the menu agree', () => {
  const player = () => document.querySelector('[data-test-player]')

  it('resumes a title with a saved position from a rail that is not Continue Watching', async () => {
    renderAt('/')
    const recent = await rail('Recently Added')
    // The menu's first row says Resume for it,
    const { rows } = await openMenu('Half Watched', recent)
    expect(rows[0]).toMatch(/^Resume/)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    // and so does the button on its poster, which then resumes.
    fireEvent.click(within(recent).getByRole('button', { name: 'Resume Half Watched' }))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.getAttribute('data-media')).toBe(String(HALF.id))
    expect(player()!.getAttribute('data-resume')).toBe('600000')
  })

  it('does the same on the Movies grid', async () => {
    renderAt('/movies')
    fireEvent.click((await screen.findAllByRole('button', { name: 'Resume Half Watched' }, find))[0])
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.getAttribute('data-resume')).toBe('600000')
  })

  // The search page takes its address (/search) as its viewer types. Every
  // other change of address closes a player; a minimized one has always
  // gone on playing while its viewer typed in the bar.
  it('a player that is on stays on while its viewer types a search, and goes when they open a result', async () => {
    renderAt('/movies')
    fireEvent.click((await screen.findAllByRole('button', { name: 'Resume Half Watched' }, find))[0])
    await waitFor(() => expect(player()).not.toBeNull(), find)
    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'found' } })
    const result = await screen.findByRole('button', { name: /^Found By Search/ }, find)
    // The page is the search page now, at its own address, and the player is still there.
    expect(document.querySelector('[data-search-results]')).not.toBeNull()
    expect(player()).not.toBeNull()
    fireEvent.click(result)
    await waitFor(() => expect(player()).toBeNull(), find)
  })

  // The add-to-list sheet is over the page, and over a player minimized on
  // it. Escape closed the player first and left the sheet up, and when it
  // did close the sheet the focus fell to the page body.
  it('Escape closes the add-to-list sheet before a player that is on, and hands the focus back to the button that opened its menu', async () => {
    renderAt('/movies')
    fireEvent.click((await screen.findAllByRole('button', { name: 'Resume Half Watched' }, find))[0])
    await waitFor(() => expect(player()).not.toBeNull(), find)
    const { more, menu } = await openMenu('Half Watched')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add to a list…' }))
    const sheet = () => screen.queryByRole('dialog', { name: 'Add "Half Watched" to a watchlist' })
    await waitFor(() => expect(sheet()).not.toBeNull(), find)
    // The viewer is in the sheet, on one of its buttons.
    const cancel = within(sheet()!).getByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(sheet()).toBeNull()
    expect(player()).not.toBeNull()
    expect(document.activeElement).toBe(more)
    // With the sheet gone the next Escape is the player's.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(player()).toBeNull(), find)
  })

  // A player that casts is not closed by Escape (that would end the cast),
  // and its surface in the window is a modal dialog over an inert page. The
  // key stays the title page's under it, as it always was: Back, with the
  // cast playing on. (A title page goes Back only from under nothing else.)
  it('Escape under a player that casts in the window still takes the title page Back, and leaves the player', async () => {
    renderAt(`/title/${FRESH.id}`)
    const title = () => screen.queryByRole('heading', { level: 1, name: FRESH.title })
    await waitFor(() => expect(title()).not.toBeNull(), find)
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    act(() => { playerShell.report!('theater'); playerShell.casting!(true) })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(title()).toBeNull(), find)
    expect(player()).not.toBeNull()
  })

  // The first key typed into the bar sets the view to the search page and
  // then moves the address there. A new user object for the same account
  // (another tab's sign-in record changing, which reads /me again) landing
  // with that key re-ran the effect that follows the address, between the
  // two: it read the address still on Tonight as a Back out of the search
  // page, put the view back and cleared the word just typed.
  it('the first key typed into the bar is kept when the account is read again in the same moment', async () => {
    const server = renderAt('/')
    await rail('Recently Added')
    const input = document.querySelector<HTMLInputElement>('.stage-navsearch input')!
    const release = server.hold('/api/auth/me')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'aurora_user', newValue: localStorage.getItem('aurora_user') })) })
    await act(async () => {
      release()
      await new Promise(done => setTimeout(done, 20))
      fireEvent.change(input, { target: { value: 'f' } })
    })
    await screen.findByRole('button', { name: /^Found By Search/ }, find)
    expect(input.value).toBe('f')
    expect(document.querySelector('[data-search-results]')).not.toBeNull()
  })

  // Minimised, a cast covers nothing: the page is the viewer's, and a dialog
  // opened over it answers its own Escape. An admin's "Fix match" is a Radix
  // dialog, which says it is modal only by hiding the page (no aria-modal),
  // and does not keep the key to itself: while a cast was up, its Escape
  // also sent the title page behind it Back.
  it('Escape in a dialog over a title page closes the dialog only, while a cast plays minimised', async () => {
    renderAt(`/title/${FRESH.id}`, { role: 'admin' })
    const title = () => screen.queryByRole('heading', { level: 1, name: FRESH.title })
    await waitFor(() => expect(title()).not.toBeNull(), find)
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    act(() => { playerShell.casting!(true); playerShell.report!('minimized') })
    // The minimised cast claims nothing over the page.
    expect(player()).not.toHaveAttribute('aria-modal')
    fireEvent.click(await screen.findByRole('button', { name: /^Manage/ }, find))
    fireEvent.click(await screen.findByRole('button', { name: 'Fix match' }, find))
    const dialog = await screen.findByRole('dialog', {}, find)
    expect(dialog).not.toHaveAttribute('aria-modal')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), find)
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    expect(title()).not.toBeNull()
    expect(player()).not.toBeNull()
  })

  // The sheet is painted above the player (z-[70] over z-[60]), also when a
  // player opens after it: the viewer leaves the sheet up and starts the
  // title from the page behind it (nothing holds the focus in the sheet),
  // or a party's player opens by itself. The sheet is what they see on top,
  // so it is what Escape closes; the player under it plays on.
  it('Escape closes a sheet that a player has opened under, and leaves the player', async () => {
    for (const surface of ['theater', 'fullscreen'] as const) {
      renderAt(`/title/${FRESH.id}`)
      fireEvent.click(await screen.findByRole('button', { name: 'List' }, find))
      const sheet = () => screen.queryByRole('dialog', { name: 'Add "Never Started" to a watchlist' })
      await waitFor(() => expect(sheet()).not.toBeNull(), find)
      // No player yet: it opens with the sheet already up.
      expect(player()).toBeNull()
      const play = screen.getByRole('button', { name: 'Play' })
      play.focus()
      fireEvent.click(play)
      await waitFor(() => expect(player()).not.toBeNull(), find)
      act(() => playerShell.report!(surface))
      expect(sheet()).not.toBeNull()
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(sheet()).toBeNull()
      expect(player()).not.toBeNull()
      // With the sheet gone the next Escape is the player's.
      fireEvent.keyDown(document.body, { key: 'Escape' })
      await waitFor(() => expect(player()).toBeNull(), find)
      cleanup()
      vi.unstubAllGlobals()
    }
  })

  it('hands the focus to the title\'s own card when no control opened the sheet (a right click), and from Cancel too', async () => {
    renderAt('/movies')
    const card = (await screen.findAllByRole('button', { name: 'Resume Half Watched' }, find))[0].closest('[data-media-id]') as HTMLElement
    const open = card.querySelector<HTMLElement>('.card-open')!
    const sheet = () => screen.queryByRole('dialog', { name: 'Add "Half Watched" to a watchlist' })
    const openSheet = async () => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      fireEvent.contextMenu(card)
      fireEvent.click(within(await screen.findByRole('menu', { name: 'Actions for Half Watched' }, find)).getByRole('menuitem', { name: 'Add to a list…' }))
      await waitFor(() => expect(sheet()).not.toBeNull(), find)
      within(sheet()!).getByRole('button', { name: 'Cancel' }).focus()
    }
    await openSheet()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(open)
    await openSheet()
    fireEvent.click(within(sheet()!).getByRole('button', { name: 'Cancel' }))
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(open)
    // A press on the scrim moves no focus: the pointer has said where the viewer is.
    await openSheet()
    const before = document.activeElement
    fireEvent.click(sheet()!.parentElement!)
    expect(sheet()).toBeNull()
    expect(document.activeElement === open && before !== open).toBe(false)
  })

  // The button that opened the sheet can be gone by the time it closes (the
  // grid redrawn under it): the focus goes to the title's card as it is now.
  it('hands the focus to the title\'s card when the button that opened the sheet is no longer on the page', async () => {
    renderAt('/movies')
    await screen.findAllByRole('button', { name: 'Resume Half Watched' }, find)
    const { more, menu } = await openMenu('Half Watched')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Add to a list…' }))
    const sheet = () => screen.queryByRole('dialog', { name: 'Add "Half Watched" to a watchlist' })
    await waitFor(() => expect(sheet()).not.toBeNull(), find)
    // The grid becomes a list while the sheet is up: every card is a new row.
    fireEvent.click(screen.getAllByRole('button', { name: 'List' })[0])
    await waitFor(() => expect(document.querySelector('[data-browse-layout="list"]')).not.toBeNull(), find)
    expect(more.isConnected).toBe(false)
    within(sheet()!).getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(sheet()).toBeNull()
    const row = document.querySelector(`[data-media-id="${HALF.id}"] .mlr-main`)
    expect(row).not.toBeNull()
    expect(document.activeElement).toBe(row)
  })

  // Only the address change the typing itself made is let off: coming Back
  // to the search page later is a change of address like any other.
  it('and one started on a title opened from a search goes when the viewer goes Back to the results', async () => {
    renderAt('/movies')
    fireEvent.change(await screen.findByPlaceholderText(/Search/, undefined, find), { target: { value: 'found' } })
    fireEvent.click(await screen.findByRole('button', { name: /^Found By Search/ }, find))
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    browser.back()
    await waitFor(() => expect(document.querySelector('[data-search-results]')).not.toBeNull(), find)
    await waitFor(() => expect(player()).toBeNull(), find)
  })

  // Season 0 is Specials: the lowest number, and not where a show starts.
  it('starts a show nobody has begun on season 1, not on a Special', async () => {
    renderAt('/')
    const recent = await rail('Recently Added')
    fireEvent.click(await within(recent).findByRole('button', { name: 'Play Has Specials' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.getAttribute('data-season')).toBe('1')
    expect(player()!.getAttribute('data-episode')).toBe('3051')
  })

  it('and the title page\'s Play starts the season it is showing', async () => {
    renderAt(`/title/${SPECIALS.id}`)
    const seasons = await screen.findByRole('group', { name: 'Season' }, find)
    await waitFor(() => expect(within(seasons).getByRole('button', { name: 'Season 1' }).getAttribute('aria-pressed')).toBe('true'), find)
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.getAttribute('data-season')).toBe('1')
    expect(player()!.getAttribute('data-episode')).toBe('3051')
  })

  // A season whose files are gone is passed over rather than failing the
  // play: the show still has something to start on. The viewer is told, or
  // they are dropped into a Special with no word of why.
  it('starts a show whose first season has no files on what it does have, and says so', async () => {
    renderAt('/')
    const recent = await rail('Recently Added')
    fireEvent.click(await within(recent).findByRole('button', { name: 'Play Pruned First' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.getAttribute('data-season')).toBe('0')
    expect(player()!.getAttribute('data-episode')).toBe('3060')
    expect(screen.getByText('Earlier episodes of "Pruned First" are not available. Starting at the Specials, episode 1.')).toBeInTheDocument()
  })

  it('starts a show whose first episode has no file on the next, and says which', async () => {
    renderAt('/')
    const recent = await rail('Recently Added')
    fireEvent.click(await within(recent).findByRole('button', { name: 'Play Harbor Lights' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.getAttribute('data-episode')).toBe('3022')
    expect(screen.getByText('Episode 1 of "Harbor Lights" is not available. Starting at episode 2.')).toBeInTheDocument()
  })

  // The title page's own Play is the same handler: the same word of why.
  it('says so from the title page\'s Play as well', async () => {
    const server = renderAt(`/title/${SHOW.id}`)
    // The page has its episodes (one season: no season chips to wait for).
    await waitFor(() => expect(server.asks).toContain(`/api/media/${SHOW.id}/seasons/1/episodes`), find)
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.getAttribute('data-episode')).toBe('3022')
    expect(screen.getByText('Episode 1 of "Harbor Lights" is not available. Starting at episode 2.')).toBeInTheDocument()
  })

  it('says nothing of the kind when a show starts at its first episode', async () => {
    renderAt('/')
    const recent = await rail('Recently Added')
    fireEvent.click(await within(recent).findByRole('button', { name: 'Play Has Specials' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(screen.queryByText(/not available/)).toBeNull()
  })

  // Hovering Play warms the stream it would start, which for a show means
  // reading its seasons until one has something to play. Those reads are
  // the hover's: they stop when the viewer leaves the page.
  it('stops looking for the episode to warm once the viewer has left the title page', async () => {
    const server = renderAt(`/title/${PRUNED.id}`)
    const seasons = await screen.findByRole('group', { name: 'Season' }, find)
    await waitFor(() => expect(within(seasons).getAllByRole('button').map(b => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']), find)
    await new Promise(done => setTimeout(done, 50))
    server.asks.length = 0
    const release = server.hold(`/api/media/${PRUNED.id}/seasons/1/episodes`)
    fireEvent.mouseEnter(await screen.findByRole('button', { name: 'Play' }, find))
    // Not vacuous: the warm's lookup is out, at the first season.
    await waitFor(() => expect(server.asks).toContain(`/api/media/${PRUNED.id}/seasons/1/episodes`), find)
    fireEvent.click(document.querySelector('header .stage-tab[data-nav="home"]')!)
    await rail('Recently Added')
    release()
    await new Promise(done => setTimeout(done, 150))
    // The next season was never read for it.
    expect(server.asks).not.toContain(`/api/media/${PRUNED.id}/seasons/0/episodes`)
  })

  it('plays a title with no position from the start', async () => {
    renderAt('/')
    const recent = await rail('Recently Added')
    fireEvent.click(await within(recent).findByRole('button', { name: 'Play Never Started' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.getAttribute('data-media')).toBe(String(FRESH.id))
    expect(player()!.getAttribute('data-resume')).toBe('0')
  })
})

// The app's confirmation is state, where the browser's own box blocked the
// page: a question left open must not outlive the session it was asked of.
describe('a question asked with the app\'s dialog', () => {
  const askRemove = async () => {
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: FRESH.title })).toBeInTheDocument(), find)
    fireEvent.click(await screen.findByRole('button', { name: /^Manage/ }, find))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from library' }, find))
    return screen.findByRole('alertdialog', {}, find)
  }
  const signInAgain = () => act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'aurora_user', newValue: localStorage.getItem('aurora_user') })) })

  it('goes when the session expires, and is not there for the next sign-in', async () => {
    const server = renderAt(`/title/${FRESH.id}`, { role: 'admin' })
    await askRemove()
    act(() => { window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT)) })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), find)
    signInAgain()
    await waitFor(() => expect(document.querySelector('[data-identity-trigger]')).not.toBeNull(), find)
    await act(async () => { await new Promise(done => setTimeout(done, 100)) })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(server.mediaDeletes).toEqual([])
  })

  it('goes with a sign-out, and is not there for the next sign-in', async () => {
    const server = renderAt(`/title/${FRESH.id}`, { role: 'admin' })
    await askRemove()
    // Driven behind the question (it hides the page), as a sign-out made
    // in another tab of the same session reaches this one.
    fireEvent.click(document.querySelector<HTMLElement>('[data-identity-trigger]')!)
    fireEvent.click(await screen.findByRole('button', { name: /^Sign out/, hidden: true }, find))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), find)
    // Signed in again on the tab, by the sign-in page.
    fireEvent.change(await screen.findByLabelText('Username', {}, find), { target: { value: 'ronnie' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(document.querySelector('[data-identity-trigger]')).not.toBeNull(), find)
    await act(async () => { await new Promise(done => setTimeout(done, 200)) })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(server.mediaDeletes).toEqual([])
  })

  it('goes with a profile switch, and nothing is sent', async () => {
    const server = renderAt(`/title/${FRESH.id}`, { role: 'admin' })
    await askRemove()
    // Behind the question, as a switch's binding read can land from another
    // tab's switch.
    fireEvent.click(document.querySelector<HTMLElement>('[data-identity-trigger]')!)
    fireEvent.click(within(await screen.findByRole('group', { name: 'Watching as', hidden: true }, find)).getByRole('button', { name: /Kid/, hidden: true }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), find)
    await act(async () => { await new Promise(done => setTimeout(done, 100)) })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(server.mediaDeletes).toEqual([])
  })

  // While a removal is out, the title's Remove is not asked again: the
  // question would send a second request for the same title.
  it('Remove from library sends one request while one is out', async () => {
    const server = renderAt(`/title/${FRESH.id}`, { role: 'admin' })
    const release = server.hold('media-delete')
    fireEvent.click(within(await askRemove()).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(server.mediaDeletes).toHaveLength(1), find)
    fireEvent.click(screen.getByRole('button', { name: 'Remove from library' }))
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    release()
    await screen.findByText(`Removed "${FRESH.title}" from the library`, {}, find)
    expect(server.mediaDeletes).toEqual([`/api/media/${FRESH.id}`])
  })

  // "Leave and join", from Tonight's strip: asked while the session is in
  // another party; leave, then join, on the confirm only.
  it.each([
    ['Leave and join', ['leave', 'join MOON42']],
    ['Cancel', []],
    ['Escape', []],
  ])('Tonight\'s Join while in another party asks first: %s', async (answer, calls) => {
    partyStub.code = 'OLD123'
    renderAt('/', { before: server => server.live.push({ code: 'MOON42', host_user_id: 9, party_name: '', media_title: 'Night Train', media_poster: '', participant_count: 2, max_participants: 0, is_playing: true, started_at: NOW }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Join the party watching Night Train' }, find))
    const dialog = await screen.findByRole('alertdialog', {}, find)
    expect(dialog.textContent).toContain('Leave your party and join MOON42?')
    if (answer === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' })
    else fireEvent.click(within(dialog).getByRole('button', { name: answer }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), find)
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    expect(partyStub.calls).toEqual(calls)
  })

  // The same from a party's link (/p/<code>).
  it.each([
    ['Leave and join', ['leave', 'join NEWONE']],
    ['Cancel', []],
  ])('a party link while in another party asks first: %s', async (answer, calls) => {
    partyStub.code = 'OLD123'
    window.history.replaceState(null, '', '/p/NEWONE')
    renderAt('/')
    const dialog = await screen.findByRole('alertdialog', {}, find)
    expect(dialog.textContent).toContain('Leave party OLD123 and join NEWONE?')
    fireEvent.click(within(dialog).getByRole('button', { name: answer }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), find)
    await act(async () => { await new Promise(done => setTimeout(done, 50)) })
    // The link's own join leaves the party by joining the new one.
    expect(partyStub.calls).toEqual(calls.filter(c => c !== 'leave'))
  })
})

describe('what the app says when it cannot', () => {
  // The composer said the server's words, matched on them for one case.
  it.each([
    ['a refused creation', { status: 409, words: 'you already have an active party' }, 'Could not start the party. If you already have one, a scheduled one included, end it from Together first; otherwise try again.'],
    ['a server failure', { status: 500, words: 'pq: connection refused' }, 'Could not start the party just now.'],
  ])('the party composer says %s in its own words', async (_how, how, says) => {
    const server = renderAt('/', { before: server => server.failAt(/^\/api\/parties$/, how) })
    void server
    const { menu } = await openMenu('Never Started', await rail('Recently Added'))
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Watch together' }))
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    const buttons = within(composer).getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])
    expect((await within(composer).findByRole('alert', {}, find)).textContent).toBe(says)
    expect(document.body.textContent).not.toContain(how.words)
  })

  it('the party composer says a party made but not joined, with its code and nothing of the join\'s words', async () => {
    partyStub.join = async () => ({ ok: false, error: 'pq: room vanished' })
    renderAt('/')
    const { menu } = await openMenu('Never Started', await rail('Recently Added'))
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Watch together' }))
    const composer = await screen.findByRole('dialog', { name: 'Plan a watch party' }, find)
    const buttons = within(composer).getAllByRole('button')
    fireEvent.click(buttons[buttons.length - 1])
    expect((await within(composer).findByRole('alert', {}, find)).textContent).toBe('The party was made (code NEWPARTY), but joining it did not work. Open it from Together.')
    expect(document.body.textContent).not.toContain('room vanished')
  })

  // A deep link to a title that cannot be read said "Title not found",
  // whatever had failed.
  it.each([
    ['a 404', { status: 404, words: 'not found' }, 'This title is not available.'],
    ['a server failure', { status: 500, words: 'pq: connection refused' }, 'Could not open this title just now.'],
  ])('a deep link to a title says %s in the app\'s words, and goes to Tonight', async (_how, how, says) => {
    renderAt(`/title/${FRESH.id}`, { before: server => server.failDetail(how) })
    await screen.findByText(says, {}, find)
    expect(document.body.textContent).not.toContain(how.words)
    expect(screen.queryByRole('heading', { level: 1, name: FRESH.title })).toBeNull()
  })

  // The add-to-list sheet's failure line is the failure of that opening:
  // closed and opened again, the sheet starts clean.
  it('the add-to-list sheet does not say an old failure when opened again', async () => {
    renderAt('/movies', { before: server => server.failAt(/^\/api\/profiles\/\d+\/watchlists\/\d+\/items$/, { status: 500, words: 'pq: connection refused' }) })
    const open = async () => {
      fireEvent.click(within((await openMenu('Never Started')).menu).getByRole('menuitem', { name: 'Add to a list…' }))
      return screen.findByRole('dialog', { name: /Add "Never Started" to a watchlist/ }, find)
    }
    let sheet = await open()
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Weekend' }, find))
    await within(sheet).findByRole('alert', {}, find)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /watchlist/ })).toBeNull(), find)
    sheet = await open()
    await within(sheet).findByRole('button', { name: 'Weekend' }, find)
    expect(within(sheet).queryByRole('alert')).toBeNull()
  })
})
