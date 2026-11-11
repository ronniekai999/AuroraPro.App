// @vitest-environment jsdom
//
// The invitation list is one account's. Two people can use one tab in turn
// (sign out, sign in, no reload), and the Together page shows the list as it
// is: so nothing of the first person's may be drawn once they have signed
// out, neither the list they had loaded nor an answer to their request that
// arrives after the second person is in.

import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App'

const NOW = '2026-10-01T00:00:00Z'
const ALICE = { id: 1, username: 'alice', email: 'a@example.test', role: 'user' }
const BOB = { id: 2, username: 'bob', email: 'b@example.test', role: 'user' }
const profileOf = (u: typeof ALICE) => ({ id: u.id * 10, user_id: u.id, name: u.id === 1 ? 'Alice' : 'Bob', is_default: true, created_at: NOW, updated_at: NOW })

/** Answers for whoever is signed in when a request is SENT. `hold(key)`
 *  keeps every answer for `invites-<user id>` back until released. */
function stubServer() {
  let current: typeof ALICE | null = ALICE
  const holds = new Map<string, Promise<void>>()
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const p = new URL(input, 'http://localhost').pathname
    const asked = current
    if (p === '/api/auth/logout' && init?.method === 'POST') { current = null; return new Response(null, { status: 204 }) }
    if (p === '/api/auth/login' && init?.method === 'POST') { current = BOB; return json({ expires_in: 900, user: BOB }) }
    if (!asked) return json({ error: { code: 401, message: 'signed out' } }, 401)
    if (p === '/api/me/party-invites') {
      const held = holds.get(`invites-${asked.id}`)
      if (held) await held
      return json({ invites: [{
        invite_id: asked.id, party_code: `P${asked.id}`, media_title: asked.id === 1 ? 'Aliceonly Invite' : 'Bobonly Invite',
        host_username: 'host', rsvp: 'pending', scheduled_start_at: '2099-01-01T20:00:00Z', created_at: NOW,
      }] })
    }
    if (p === '/api/auth/me') return json(asked)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: asked })
    if (p === '/api/profiles') return json([profileOf(asked)])
    if (p === '/api/profiles/active') return json(profileOf(asked))
    if (/^\/api\/profiles\/\d+\/activate$/.test(p)) return new Response(null, { status: 204 })
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
    hold(key: string) {
      let release!: () => void
      holds.set(key, new Promise<void>(done => { release = done }))
      return () => { holds.delete(key); release() }
    },
  }
}

interface Commit { identity: string | null; alices: boolean }
function renderTogether() {
  localStorage.clear()
  localStorage.setItem('aurora_user', JSON.stringify(ALICE))
  localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
  const commits: Commit[] = []
  const onRender = () => commits.push({
    identity: document.querySelector('[data-identity-name]')?.textContent ?? null,
    alices: (document.body.textContent ?? '').includes('Aliceonly'),
  })
  render(<Profiler id="app" onRender={onRender}><MemoryRouter initialEntries={['/together']}><App /></MemoryRouter></Profiler>)
  return commits
}
const find = { timeout: 5000 }
async function signOutAndInAsBob() {
  fireEvent.click(document.querySelector('[data-identity-trigger]')!)
  fireEvent.click(screen.getByRole('button', { name: /^Sign out/ }))
  fireEvent.change(await screen.findByPlaceholderText('Enter username', {}, find), { target: { value: 'bob' } })
  fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
  await waitFor(() => expect(document.querySelector('[data-identity-name]')?.textContent).toBe('Bob'), find)
  // A sign-in lands on Tonight; Bob goes to Together.
  fireEvent.click(document.querySelector('header .stage-tab[data-nav="together"]')!)
  await screen.findByRole('heading', { name: 'Together' }, find)
}
/** Commits that drew anything of Alice's when Alice was not who was shown. */
const leaks = (commits: Commit[]) => commits.filter(c => c.identity !== 'Alice' && c.alices)

vi.setConfig({ testTimeout: 20_000 })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('the next person to sign in on the tab is not shown the previous person\'s invitations', () => {
  it('neither the list the first person had loaded, while the second\'s is on its way', async () => {
    const server = stubServer()
    const commits = renderTogether()
    // Not vacuous: Alice sees her invitation.
    await screen.findByText('host invited you to watch Aliceonly Invite', {}, find)
    const releaseBob = server.hold('invites-2')
    await signOutAndInAsBob()
    // Bob's own list is still out: the page has had every chance to show Alice's.
    await new Promise(done => setTimeout(done, 100))
    expect(screen.queryByText(/Aliceonly/)).toBeNull()
    releaseBob()
    await screen.findByText('host invited you to watch Bobonly Invite', {}, find)
    expect(commits.some(c => c.identity === 'Bob')).toBe(true)
    expect(leaks(commits)).toEqual([])
  })

  it('nor an answer to the first person\'s request that arrives after the second is in', async () => {
    const server = stubServer()
    const releaseAlice = server.hold('invites-1')
    const commits = renderTogether()
    await screen.findByRole('heading', { name: 'Together' }, find)
    await waitFor(() => expect(document.querySelector('[data-identity-name]')?.textContent).toBe('Alice'), find)
    await signOutAndInAsBob()
    await screen.findByText('host invited you to watch Bobonly Invite', {}, find)
    // Alice's answer lands now, under Bob, on the page that shows the list.
    releaseAlice()
    await new Promise(done => setTimeout(done, 100))
    expect(screen.queryByText(/Aliceonly/)).toBeNull()
    expect(screen.getByText('host invited you to watch Bobonly Invite')).toBeTruthy()
    expect(leaks(commits)).toEqual([])
  })
})
