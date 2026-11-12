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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
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
const FOUND = item(401, 'Found By Search')
const SAVED = item(501, 'Saved Title')
const COLLECTED = item(601, 'In A Collection')

function stubServer({ bound = 1, role = 'user' } = {}) {
  const me = { id: 1, username: 'ronnie', email: 'r@example.test', role }
  const asks: string[] = []
  const parties: unknown[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const p = url.pathname
    asks.push(p)
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
      ])
    }
    if (p === `/api/media/${TWO.id}/seasons/1/episodes`) {
      return json([3041, 3042].map((id, i) => ({ id, season_id: 1, media_item_id: TWO.id, episode_number: i + 1, files: [{ id: id + 5000, resolution: '1080p' }] })))
    }
    if (p === `/api/media/${PRUNED.id}/seasons`) return json([{ id: 60, media_item_id: PRUNED.id, season_number: 0 }, { id: 61, media_item_id: PRUNED.id, season_number: 1 }])
    if (p === `/api/media/${PRUNED.id}/seasons/1/episodes`) return json([{ id: 3061, season_id: 61, media_item_id: PRUNED.id, episode_number: 1, files: [] }])
    if (p === `/api/media/${PRUNED.id}/seasons/0/episodes`) return json([{ id: 3060, season_id: 60, media_item_id: PRUNED.id, episode_number: 1, files: [{ id: 8060, resolution: '1080p' }] }])
    // The title page's own record of a title.
    const byId = p.match(/^\/api\/media\/(\d+)$/)
    if (byId) {
      const it = [HALF, FRESH, SHOW, TWO, SPECIALS, PRUNED].find(x => x.id === Number(byId[1]))
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
  return { asks, parties }
}

function renderAt(path: string, opts: { bound?: number; role?: string } = {}) {
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify({ id: 1, username: 'ronnie', email: 'r@example.test', role: opts.role ?? 'user' }))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
  const server = stubServer(opts)
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)
  return server
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
  const offered = async (opts: { bound?: number; role?: string }) => {
    renderAt('/', opts)
    return (await openMenu('Never Started', await rail('Recently Added'))).rows
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
  // play: the show still has something to start on.
  it('starts a show whose first season has no files on what it does have', async () => {
    renderAt('/')
    const recent = await rail('Recently Added')
    fireEvent.click(await within(recent).findByRole('button', { name: 'Play Pruned First' }, find))
    await waitFor(() => expect(player()).not.toBeNull(), find)
    expect(player()!.getAttribute('data-season')).toBe('0')
    expect(player()!.getAttribute('data-episode')).toBe('3060')
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
