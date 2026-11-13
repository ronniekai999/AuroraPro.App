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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import App from './App'

// The player is replaced by a marker that says what it was asked to play.
vi.mock('@/components/VideoPlayer', async (original) => ({
  ...(await original<typeof import('@/components/VideoPlayer')>()),
  VideoPlayer: ({ target }: { target: { mediaItemId: number; resumePositionMs?: number; episodeId?: number; seasonNumber?: number } | null }) =>
    target ? <div data-test-player data-media={target.mediaItemId} data-resume={target.resumePositionMs ?? 0} data-episode={target.episodeId ?? ''} data-season={target.seasonNumber ?? ''} /> : null,
}))

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

function stubServer({ bound = 1, role = 'user' } = {}) {
  const me = { id: 1, username: 'ronnie', email: 'r@example.test', role }
  const asks: string[] = []
  const parties: unknown[] = []
  const holds = new Map<string, Promise<void>>()
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    asks.push(p)
    // A held answer waits to be let go; a request abandoned meanwhile
    // rejects when its answer would have arrived, as fetch's does.
    const held = holds.get(p)
    if (held) await held
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (p === '/api/auth/me') return json(me)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: me })
    if (p === '/api/profiles') return json([PARENT, KID])
    if (p === '/api/profiles/active') return json(bound === 1 ? PARENT : KID)
    if (/^\/api\/profiles\/\d+\/library$/.test(p)) return json([{ media_item_id: SAVED.id, title: SAVED.title, type: 'movie', year: 2020 }])
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
      const it = [HALF, FRESH, SHOW, TWO, SPECIALS, PRUNED, AHEAD].find(x => x.id === Number(byId[1]))
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
    if (p === '/api/parties/active') return json({ parties: [] })
    return json([])
  })
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  return {
    asks, parties,
    hold(path: string) {
      let release!: () => void
      holds.set(path, new Promise<void>(done => { release = done }))
      return () => { holds.delete(path); release() }
    },
  }
}

function renderAt(path: string, opts: { bound?: number; role?: string; prefs?: Record<string, unknown> } = {}) {
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify({ id: 1, username: 'ronnie', email: 'r@example.test', role: opts.role ?? 'user' }))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true, ...opts.prefs }))
  const server = stubServer(opts)
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
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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
