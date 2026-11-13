// @vitest-environment jsdom
//
// "Report a bug" in the app: an item in the identity panel and a row on the
// Me page, in place of a button that floated in the corner of every page.
//
// The dialog describes the page it is opened over: "Capture this page"
// draws the document behind it, and a report carries the address the tab is
// at when it is sent. From the panel that is the page under the panel. Me is
// a page of its own, so from Me the app first goes back to the page the
// person came from. What this pins, against the whole App, a stubbed server
// and the browser's own address bar (BrowserRouter, so the address a report
// reads is the one the app is at).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { BrowserRouter } from 'react-router'
import App from './App'
import { SESSION_EXPIRED_EVENT } from '@/lib/api'

const NOW = '2026-10-01T00:00:00Z'
const PARENT = { id: 10, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }
const KID = { id: 20, user_id: 1, name: 'Kid', is_default: false, created_at: NOW, updated_at: NOW, max_age_rating: 'PG' }
const USER = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }

/** `reports`: whether the server takes bug reports. `bound`: the profile the
 *  server says the session acts as; an activation rebinds it. `limit(id)`
 *  gives a profile a content limit from then on, as an edit made on another
 *  device does. */
function stubServer({ reports = true, bound = 10, role = 'user' } = {}) {
  const me = { ...USER, role }
  const limits = new Map<number, string>([[20, 'PG']])
  const profile = (p: typeof PARENT) => ({ ...p, max_age_rating: limits.get(p.id) })
  const sent: FormData[] = []
  let signedIn = true
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const p = new URL(input, 'http://localhost').pathname
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    if (p === '/api/auth/login' && init?.method === 'POST') { signedIn = true; return json({ expires_in: 900, user: me }) }
    if (!signedIn) return json({ error: { code: 401, message: 'signed out' } }, 401)
    if (p === '/api/auth/me') return json(me)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: me })
    if (p === '/api/profiles') return json([profile(PARENT), profile(KID)])
    if (p === '/api/profiles/active') return json(profile(bound === 10 ? PARENT : KID))
    const activate = p.match(/^\/api\/profiles\/(\d+)\/activate$/)
    if (activate && init?.method === 'POST') { bound = Number(activate[1]); return new Response(null, { status: 204 }) }
    if (p === '/api/feedback/config') return json({ enabled: reports })
    if (p === '/api/feedback' && init?.method === 'POST') {
      sent.push(init.body as FormData)
      return json({ issue_url: 'https://example.test/issues/512', issue_number: 512 })
    }
    if (p === '/api/me/hero') return json({ picks: [], slate_token: 's' })
    if (p === '/api/media/recent') return json({ data: [] })
    if (p === '/api/media') return json({ data: [], page: 1, per_page: 1, total_items: 0, total_pages: 1 })
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    if (p === '/api/parties/active') return json({ parties: [] })
    if (p === '/api/auth/oauth/providers') return json({ providers: [] })
    return json([])
  })
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
  return {
    sent,
    limit(id: number, rating: string) { limits.set(id, rating) },
    signOut() { signedIn = false },
    /** The session is bound to another profile, as a switch in another tab does. */
    bind(id: number) { bound = id },
    /** Whether the server takes reports, from the next time it is asked. */
    takeReports(on: boolean) { reports = on },
  }
}

const find = { timeout: 5000 }
const identity = () => document.querySelector<HTMLButtonElement>('[data-identity-trigger]')!
const shownAs = () => document.querySelector('[data-identity-name]')?.textContent
const address = () => window.location.pathname + window.location.search
/** The entry the browser's history is at, as react-router numbers them. */
const entry = () => (window.history.state as { idx?: number } | null)?.idx
// By its role alone: its name is "Report a bug" until a report is sent,
// and "Thanks, got it" after.
const dialog = () => screen.queryByRole('dialog')
const tab = (id: string) => document.querySelector<HTMLButtonElement>(`.stage-tabbar-item[data-nav="${id}"]`)!
const meRows = () => within(screen.getByRole('navigation', { name: 'Account' }))

async function open(at: string, as = 'Parent', role = 'user') {
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify({ ...USER, role }))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
  window.history.replaceState(null, '', at)
  render(<BrowserRouter><App /></BrowserRouter>)
  await waitFor(() => expect(shownAs()).toBe(as), find)
}
async function toMe() {
  fireEvent.click(tab('me'))
  await screen.findByRole('navigation', { name: 'Account' }, find)
  expect(address()).toBe('/me')
}
async function sendAReport() {
  const d = dialog()!
  fireEvent.change(within(d).getByLabelText(/^Title/), { target: { value: 'Wrong episode opens' } })
  fireEvent.change(within(d).getByLabelText(/^Description/), { target: { value: 'It opened episode 4, not 5.' } })
  fireEvent.click(within(d).getByRole('button', { name: 'Send report' }))
  await within(d).findByRole('button', { name: 'Done' }, find)
}

vi.setConfig({ testTimeout: 20_000 })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('where "Report a bug" is', () => {
  it('is an item in the identity panel and a row on the Me page when the server takes reports, and no button in the corner', async () => {
    stubServer()
    await open('/movies')
    fireEvent.click(identity())
    const panel = within(screen.getByRole('group', { name: 'Account and profiles' }))
    expect(await panel.findByRole('button', { name: 'Report a bug' }, find)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await toMe()
    expect(meRows().getByRole('button', { name: 'Report a bug' })).toBeInTheDocument()
    // Nothing floats over the page, and nothing marks the document for it.
    expect(screen.queryByRole('button', { name: 'Report bug' })).toBeNull()
    expect(document.querySelector('[title="Report a bug or share feedback"]')).toBeNull()
    expect(document.documentElement).not.toHaveAttribute('data-bug-launcher')
    expect(dialog()).toBeNull()
  })

  it('is in neither place when the server does not take reports', async () => {
    stubServer({ reports: false })
    await open('/movies')
    // The answer about reports has had every chance to arrive.
    await new Promise(done => setTimeout(done, 150))
    fireEvent.click(identity())
    expect(within(screen.getByRole('group', { name: 'Account and profiles' })).queryByRole('button', { name: 'Report a bug' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await toMe()
    expect(meRows().queryByRole('button', { name: 'Report a bug' })).toBeNull()
    // Not vacuous: the rows that are always there are.
    expect(meRows().getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('is in both places for a profile with a content limit', async () => {
    stubServer({ bound: 20 })
    localStorage.setItem('aurora_active_profile_id', '20')
    await open('/movies', 'Kid')
    fireEvent.click(identity())
    expect(await within(screen.getByRole('group', { name: 'Account and profiles' })).findByRole('button', { name: 'Report a bug' }, find)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await toMe()
    expect(meRows().getByRole('button', { name: 'Report a bug' })).toBeInTheDocument()
  })
})

describe('"Report a bug" from the identity panel', () => {
  it('opens the dialog over the page on screen, goes nowhere, and gives the focus back to the panel\'s control', async () => {
    const server = stubServer()
    await open('/movies?sort=title')
    const before = entry()
    fireEvent.click(identity())
    fireEvent.click(await within(screen.getByRole('group', { name: 'Account and profiles' })).findByRole('button', { name: 'Report a bug' }, find))
    expect(dialog()).toHaveAccessibleName('Report a bug')
    expect(address()).toBe('/movies?sort=title')
    expect(entry()).toBe(before)
    await sendAReport()
    expect(server.sent).toHaveLength(1)
    expect(server.sent[0].get('client_url')).toBe('/movies?sort=title')
    // The toast that stays when the dialog is closed.
    expect(await screen.findByText('Bug reported as issue #512. Thank you.', {}, find)).toBeInTheDocument()
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Done' }))
    expect(dialog()).toBeNull()
    expect(identity()).toHaveFocus()
  })
})

describe('"Report a bug" from the Me page', () => {
  it('goes back to the page the person came from, opens the dialog over it, and a report carries that page\'s address', async () => {
    const server = stubServer()
    await open('/movies')
    const movies = entry()
    await toMe()
    expect(entry()).toBe(movies! + 1)
    fireEvent.click(meRows().getByRole('button', { name: 'Report a bug' }))
    // Not over Me.
    expect(dialog()).toBeNull()
    // As soon as Movies is the page drawn: well inside the second and a
    // half after which the app would give up on going back and open the
    // dialog wherever it was.
    await waitFor(() => expect(dialog()).toBeInTheDocument(), { timeout: 1000 })
    expect(address()).toBe('/movies')
    // A step back in history, onto the entry the person left: the app
    // restores each entry's scroll, so the page is where they left it.
    expect(entry()).toBe(movies)
    expect(screen.queryByRole('navigation', { name: 'Account' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Movies' })).toBeInTheDocument()
    await sendAReport()
    expect(server.sent).toHaveLength(1)
    expect(server.sent[0].get('client_url')).toBe('/movies')
    expect(server.sent[0].get('title')).toBe('Wrong episode opens')
    // The row that was pressed is gone with the Me page: the focus goes to
    // the page's heading.
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Done' }))
    expect(dialog()).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Movies' })).toHaveFocus()
  })

  // On a phone Settings is reached through Me, and is part of the same
  // corner of the app: a report asked for on Me after a look at Settings is
  // still about the page before both.
  it('goes to that page by its address when a step back is not it, and does not take Settings opened from Me for it', async () => {
    const server = stubServer()
    await open('/movies')
    await toMe()
    fireEvent.click(meRows().getByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(address()).toMatch(/^\/settings/), find)
    await toMe()
    const me = entry()
    fireEvent.click(meRows().getByRole('button', { name: 'Report a bug' }))
    await waitFor(() => expect(dialog()).toBeInTheDocument(), find)
    expect(address()).toBe('/movies')
    // A step forward this time: one step back was Settings.
    expect(entry()).toBe(me! + 1)
    await sendAReport()
    expect(server.sent[0].get('client_url')).toBe('/movies')
  })

  it('opens over Me when the tab has shown no other page', async () => {
    const server = stubServer()
    await open('/me')
    await screen.findByRole('navigation', { name: 'Account' }, find)
    const row = await meRows().findByRole('button', { name: 'Report a bug' }, find)
    const before = entry()
    row.focus()
    fireEvent.click(row)
    expect(dialog()).toBeInTheDocument()
    expect(address()).toBe('/me')
    expect(entry()).toBe(before)
    await sendAReport()
    expect(server.sent[0].get('client_url')).toBe('/me')
    // The row is still there, and takes the focus back.
    fireEvent.click(within(dialog()!).getByRole('button', { name: 'Done' }))
    expect(meRows().getByRole('button', { name: 'Report a bug' })).toHaveFocus()
  })

  it('does not go back to a page the previous profile was on', async () => {
    stubServer()
    await open('/movies')
    await toMe()
    fireEvent.click(screen.getByRole('button', { name: /^Switch to Kid/ }))
    await waitFor(() => expect(shownAs()).toBe('Kid'), find)
    expect(address()).toBe('/me')
    const before = entry()
    fireEvent.click(meRows().getByRole('button', { name: 'Report a bug' }))
    expect(dialog()).toBeInTheDocument()
    // Still here a moment later: nothing was on its way.
    await new Promise(done => setTimeout(done, 150))
    expect(address()).toBe('/me')
    expect(entry()).toBe(before)
  })

  // The profile is the same one, but its limit was set on another device
  // while the tab sat on Me: Together is no longer a page this session's
  // routes show it.
  it('does not send a session to a page its routes would not show it now', async () => {
    const server = stubServer()
    await open('/together')
    await screen.findByRole('heading', { name: 'Together' }, find)
    await toMe()
    server.limit(10, 'PG')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(document.querySelector('header [data-profile-summary]')?.textContent).toMatch(/^Up to PG/), find)
    const before = entry()
    fireEvent.click(meRows().getByRole('button', { name: 'Report a bug' }))
    expect(dialog()).toBeInTheDocument()
    await new Promise(done => setTimeout(done, 150))
    expect(address()).toBe('/me')
    expect(entry()).toBe(before)
  })
})

describe('an open dialog and the session', () => {
  // The app stays mounted when a session ends, so "open" must not be
  // waiting for the next person to sign in on the tab.
  it('closes when the session ends, and is closed for the next sign-in', async () => {
    const server = stubServer()
    await open('/movies')
    fireEvent.click(identity())
    fireEvent.click(await within(screen.getByRole('group', { name: 'Account and profiles' })).findByRole('button', { name: 'Report a bug' }, find))
    expect(dialog()).toBeInTheDocument()
    server.signOut()
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    await screen.findByLabelText('Username', {}, find)
    expect(dialog()).toBeNull()
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ronnie' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(shownAs()).toBe('Parent'), find)
    await new Promise(done => setTimeout(done, 150))
    expect(dialog()).toBeNull()
  })

  // A parent opens the dialog over a page; another tab switches the session
  // to the child; this tab follows at its next look. What the dialog holds
  // was the parent's, and Send would file it from the child's session.
  it('closes when the session changes profile, and says why', async () => {
    const server = stubServer()
    await open('/movies')
    fireEvent.click(identity())
    fireEvent.click(await within(screen.getByRole('group', { name: 'Account and profiles' })).findByRole('button', { name: 'Report a bug' }, find))
    expect(dialog()).toBeInTheDocument()
    server.bind(20)
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(shownAs()).toBe('Kid'), find)
    await waitFor(() => expect(dialog()).toBeNull(), find)
    expect(await screen.findByText('The bug report was closed because this tab is now on another profile.', {}, find)).toBeInTheDocument()
    // And it is closed, not waiting: the entry opens an ordinary one.
    fireEvent.click(identity())
    fireEvent.click(await within(screen.getByRole('group', { name: 'Account and profiles' })).findByRole('button', { name: 'Report a bug' }, find))
    expect(dialog()).toBeInTheDocument()
    await new Promise(done => setTimeout(done, 150))
    expect(dialog()).toBeInTheDocument()
  })

  // The config is asked for again as the dialog opens, and again whenever
  // the session's admin powers change. "Open" must not outlive a "no".
  it('closes when the server stops taking reports, and does not come back by itself when it takes them again', async () => {
    const server = stubServer({ role: 'admin' })
    await open('/movies', 'Parent', 'admin')
    fireEvent.click(identity())
    const entry = await within(screen.getByRole('group', { name: 'Account and profiles' })).findByRole('button', { name: 'Report a bug' }, find)
    // The server has stopped by the time the dialog asks again.
    server.takeReports(false)
    fireEvent.click(entry)
    await waitFor(() => expect(dialog()).toBeNull(), find)
    // Reports are taken again, and the config is asked for anew (the
    // session's admin powers change with the profile).
    server.takeReports(true)
    server.bind(20)
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(shownAs()).toBe('Kid'), find)
    fireEvent.click(identity())
    await within(screen.getByRole('group', { name: 'Account and profiles' })).findByRole('button', { name: 'Report a bug' }, find)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialog()).toBeNull()
    // It was closed long before the switch, so nothing says it was closed by it.
    expect(screen.queryByText(/bug report was closed/)).toBeNull()
  })
})
