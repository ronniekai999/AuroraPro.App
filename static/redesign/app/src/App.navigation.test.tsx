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
//   - a session known to act as a restricted profile is not shown Together,
//     requests or the profile page even when it opens their URL, and a session
//     whose profile is not known yet is not bounced anywhere.

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
 *  has a PIN, so nothing re-selects it without one. */
function stubServer({ bound = 1, bindingUnreadable = false, parentLocked = false } = {}) {
  const parent = { ...PARENT, has_pin: parentLocked }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const p = new URL(input, 'http://localhost').pathname
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (p === '/api/auth/me') return json(USER)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: USER })
    if (p === '/api/profiles') return json([parent, KID])
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
    if (p === '/api/parties/active') return json({ parties: [] })
    if (p === '/api/auth/oauth/links') return json({ linked: [], available: [], hasPassword: true, canUnlinkAny: false })
    if (p === '/api/me/gamification') {
      return json({ xp: { xp: 0, level: 1, current_streak: 0, longest_streak: 0, total_watches: 0, next_level_total: 100, prev_level_total: 0 }, unlocked: [], achievement_catalog: [] })
    }
    return json([])
  })
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
}

// The router's current pathname, recorded after each commit.
const where = { path: '' }
function Where() {
  const { pathname } = useLocation()
  useEffect(() => { where.path = pathname }, [pathname])
  return null
}
/** Renders the App at a URL. Returns what the bar offered at every commit:
 *  its destinations, and the name on the identity control. */
function renderAt(at: string, { remembered }: { remembered?: number } = {}) {
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify(USER))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
  if (remembered) localStorage.setItem('aurora_active_profile_id', String(remembered))
  const commits: { destinations: (string | null)[]; identity: string | null }[] = []
  const onRender = () => {
    if (document.querySelector('header.stage-topnav')) commits.push({ destinations: destinations(), identity: identity() })
  }
  render(<Profiler id="app" onRender={onRender}><MemoryRouter initialEntries={[at]}><App /><Where /></MemoryRouter></Profiler>)
  return commits
}

const bar = () => document.querySelector('header.stage-topnav')!
const destinations = () => [...bar().querySelectorAll('.stage-tab')].map(b => b.textContent)
const currentDestination = () => bar().querySelector('.stage-tab[aria-current="page"]')?.textContent ?? null
const currentScope = () => document.querySelector('.stage-scope[aria-current="page"]')?.textContent ?? null
const identity = () => document.querySelector('[data-identity-name]')?.textContent ?? null
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
    await screen.findByRole('heading', { name: 'Requests' }, { timeout: 10_000 })
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

  it('the Library destination opens Movies, and the scope row moves between scopes by their old URLs', async () => {
    renderAt('/')
    await settled('Parent')
    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Library' }))
    await waitFor(() => expect(where.path).toBe('/movies'))
    const scopes = screen.getByRole('navigation', { name: 'Library' })
    expect([...scopes.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Movies', 'TV Shows', 'Collections', 'My Library', 'Upcoming'])
    fireEvent.click(within(scopes).getByRole('button', { name: 'Upcoming' }))
    await waitFor(() => expect(where.path).toBe('/calendar'))
    expect(currentScope()).toBe('Upcoming')
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Library' })).getByRole('button', { name: 'Collections' }))
    await waitFor(() => expect(where.path).toBe('/collections'))
  })

  it('the Library destination returns to the scope last looked at', async () => {
    renderAt('/shows')
    await settled('Parent')
    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Tonight' }))
    await waitFor(() => expect(currentDestination()).toBe('Tonight'))
    fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Library' }))
    await waitFor(() => expect(where.path).toBe('/shows'))
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

  it.each(['/together', '/requests', '/members', '/profile'])('sends a restricted session that opens %s to Tonight', async (url) => {
    stubServer({ bound: 2 })
    renderAt(url, { remembered: 2 })
    await settled('Kid')
    await waitFor(() => expect(where.path).toBe('/'), { timeout: 5000 })
    await waitFor(() => expect(currentDestination()).toBe('Tonight'))
    expect(screen.queryByRole('heading', { name: 'Together' })).toBeNull()
  })

  it('leaves an unrestricted session where it asked to be', async () => {
    stubServer({ bound: 1 })
    renderAt('/together', { remembered: 1 })
    await screen.findByRole('heading', { name: 'Together' }, { timeout: 5000 })
    expect(where.path).toBe('/together')
  })

  it('offers nothing extra, and bounces nobody, while the binding cannot be read', async () => {
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
    expect(where.path).toBe('/requests')
  })
})
