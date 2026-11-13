// @vitest-environment jsdom
//
// The invitation list is one account's. Two people can use one tab in turn
// (sign out, sign in, no reload), and the Together page shows the list as it
// is: so nothing of the first person's may be drawn once they have signed
// out, neither the list they had loaded nor an answer to their request that
// arrives after the second person is in.

import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  fireEvent.change(await screen.findByLabelText('Username', {}, find), { target: { value: 'bob' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
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

// A profile switch binds the new profile on the server before the app shows
// it. Until the app has caught up it still names the old profile, and the
// server answers for the new one. The server hides an invitation whose title
// is over the acting profile's limit, so the Kid's list is empty and the
// Parent's holds one, with the host's note; a request answered in that
// window must not put the Parent's list under the Kid's name. The bell draws
// the list: an invitation's note and time, under its notification.
describe('a profile switch that the server has made and the app has not shown yet', () => {
  const USER = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
  const PARENT = { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }
  const KID = { id: 2, user_id: 1, name: 'Kid', is_default: false, created_at: NOW, updated_at: NOW, max_age_rating: 'PG' }
  const LOCKED = { id: 3, user_id: 1, name: 'Locked', is_default: false, created_at: NOW, updated_at: NOW, has_pin: true }
  const PROFILES = [PARENT, KID, LOCKED]

  /** The session starts bound to the Kid. `hold('activate')` keeps the
   *  answer to an activation back AFTER the server has bound the profile;
   *  `hold('invites')` keeps the invitations answer back, and it is then
   *  answered for whichever profile is bound when it is let go, as a request
   *  that reached the server late would be. `invitesAsked` lists the profile
   *  the app NAMED when each invitations request was sent. */
  function stubSwitching() {
    let bound = 2
    const holds = new Map<string, Promise<void>>()
    const invitesAsked: (string | null)[] = []
    const activations: number[] = []
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const p = new URL(input, 'http://localhost').pathname
      if (p === '/api/me/party-invites') {
        invitesAsked.push(document.querySelector('[data-identity-name]')?.textContent ?? null)
        const held = holds.get('invites')
        if (held) await held
        return json({ invites: bound === 1 ? [{
          invite_id: 7, party_code: 'ABC123', media_title: 'Parentonly Invite', note: 'Parentonly note', host_username: 'jonah',
          rsvp: 'pending', scheduled_start_at: '2099-01-01T20:00:00Z', started_at: null, created_at: NOW,
        }] : [] })
      }
      const activate = p.match(/^\/api\/profiles\/(\d+)\/activate$/)
      if (activate && init?.method === 'POST') {
        const id = Number(activate[1])
        if (id === LOCKED.id) return json({ error: { code: 403, message: 'PIN required', reason: 'profile_pin_required' } }, 403)
        bound = id
        activations.push(id)
        const held = holds.get('activate')
        if (held) await held
        return new Response(null, { status: 204 })
      }
      if (p === '/api/auth/me') return json(USER)
      if (p === '/api/auth/refresh') return json({ expires_in: 900, user: USER })
      if (p === '/api/profiles') return json(PROFILES)
      if (p === '/api/profiles/active') return json(PROFILES.find(x => x.id === bound))
      if (p === '/api/me/notifications') {
        return json({ notifications: [{ id: 1, user_id: 1, type: 'party_invite', title: 'jonah invited you to a film', link: '/p/ABC123', created_at: NOW }], unread: 1 })
      }
      if (p === '/api/me/hero') return json({ picks: [], slate_token: 's' })
      if (p === '/api/media/recent') return json({ data: [] })
      if (p === '/api/media') return json({ data: [], page: 1, per_page: 1, total_items: 0, total_pages: 1 })
      if (p.startsWith('/api/me/discover')) return json({ rails: [] })
      if (p === '/api/parties/active') return json({ parties: [] })
      return json([])
    })
    vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    vi.stubGlobal('scrollTo', () => {})
    return {
      invitesAsked, activations,
      hold(key: string) {
        let release!: () => void
        holds.set(key, new Promise<void>(done => { release = done }))
        return () => { holds.delete(key); release() }
      },
    }
  }

  interface Seen { identity: string | null; parents: boolean }
  function renderAsKid() {
    localStorage.clear()
    localStorage.setItem('aurora_user', JSON.stringify(USER))
    localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
    // The browser last showed the Kid, which is what the server has bound.
    localStorage.setItem('aurora_active_profile_id', '2')
    const commits: Seen[] = []
    const onRender = () => commits.push({
      identity: document.querySelector('[data-identity-name]')?.textContent ?? null,
      parents: (document.body.textContent ?? '').includes('Parentonly'),
    })
    render(<Profiler id="app" onRender={onRender}><MemoryRouter initialEntries={['/']}><App /></MemoryRouter></Profiler>)
    return commits
  }
  const identity = () => document.querySelector('[data-identity-name]')?.textContent ?? null
  const pickProfile = (name: RegExp) => {
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    fireEvent.click(within(screen.getByRole('group', { name: 'Watching as' })).getByRole('button', { name }))
  }
  const openBell = async () => {
    if (!screen.queryByRole('group', { name: 'Account and profiles' })) fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    fireEvent.click(within(screen.getByRole('group', { name: 'Account and profiles' })).getByRole('button', { name: /^Notifications/ }))
    await screen.findByText('jonah invited you to a film', {}, find)
  }
  /** Commits that drew anything of the Parent's under another name. */
  const underAnother = (commits: Seen[]) => commits.filter(c => c.identity !== 'Parent' && c.parents)

  it('starts no invitations request while the switch is out, and makes it for the profile the switch ends on', async () => {
    const server = stubSwitching()
    const commits = renderAsKid()
    await waitFor(() => expect(identity()).toBe('Kid'), find)
    const release = server.hold('activate')
    pickProfile(/Parent/)
    // The server has bound the Parent; the app still shows the Kid.
    await waitFor(() => expect(server.activations).toEqual([1]), find)
    expect(identity()).toBe('Kid')
    const before = server.invitesAsked.length
    // The bell asks for the list when it opens.
    await openBell()
    await new Promise(done => setTimeout(done, 150))
    expect(server.invitesAsked.length).toBe(before)
    expect(screen.queryByText(/Parentonly note/)).toBeNull()

    release()
    await waitFor(() => expect(identity()).toBe('Parent'), find)
    // Not vacuous: the list was owed, and is the Parent's under the Parent's name.
    await screen.findByText(/Parentonly note/, {}, find)
    // Every request since was sent with the Parent named (Tonight asks too,
    // now that the session is offered Together): none under the Kid's name.
    expect(server.invitesAsked.slice(before).length).toBeGreaterThan(0)
    expect(server.invitesAsked.slice(before).filter(name => name !== 'Parent')).toEqual([])
    expect(commits.some(c => c.identity === 'Kid')).toBe(true)
    expect(underAnother(commits)).toEqual([])
  })

  it('drops an answer the server gave for the new profile to a request the old one made', async () => {
    const server = stubSwitching()
    const commits = renderAsKid()
    await waitFor(() => expect(identity()).toBe('Kid'), find)
    // The Kid opens the bell; the list is asked for, and its answer is slow.
    const releaseInvites = server.hold('invites')
    await openBell()
    await waitFor(() => expect(server.invitesAsked).toContain('Kid'), find)
    const asked = server.invitesAsked.length
    // Meanwhile the switch: bound on the server, not yet shown.
    const releaseActivation = server.hold('activate')
    pickProfile(/Parent/)
    await waitFor(() => expect(server.activations).toEqual([1]), find)
    // The slow answer arrives now, and it is the Parent's.
    releaseInvites()
    await new Promise(done => setTimeout(done, 150))
    expect(identity()).toBe('Kid')
    expect(screen.queryByText(/Parentonly note/)).toBeNull()

    releaseActivation()
    await waitFor(() => expect(identity()).toBe('Parent'), find)
    // Asked again, with the Parent named, and shown under the Parent.
    await screen.findByText(/Parentonly note/, {}, find)
    expect(server.invitesAsked.slice(asked).length).toBeGreaterThan(0)
    expect(server.invitesAsked.slice(asked).filter(name => name !== 'Parent')).toEqual([])
    expect(commits.some(c => c.identity === 'Kid')).toBe(true)
    expect(underAnother(commits)).toEqual([])
  })

  it('asks again when the switch ends on the profile already shown', async () => {
    const server = stubSwitching()
    renderAsKid()
    await waitFor(() => expect(identity()).toBe('Kid'), find)
    const releaseInvites = server.hold('invites')
    await openBell()
    await waitFor(() => expect(server.invitesAsked).toContain('Kid'), find)
    const asked = server.invitesAsked.length
    // A profile with a PIN: the prompt is a switch that is out.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    pickProfile(/Locked/)
    const prompt = await screen.findByRole('dialog', { name: /Locked/ }, find)
    // The answer lands while the prompt is up: it is not kept.
    releaseInvites()
    await new Promise(done => setTimeout(done, 150))
    expect(server.invitesAsked.length).toBe(asked)
    // Cancelled: still the Kid, and nothing else would ask. The hook does.
    fireEvent.click(within(prompt).getByRole('button', { name: /Cancel/ }))
    await waitFor(() => expect(server.invitesAsked.length).toBe(asked + 1), find)
    expect(server.invitesAsked[asked]).toBe('Kid')
    expect(identity()).toBe('Kid')
    await new Promise(done => setTimeout(done, 150))
    expect(server.invitesAsked.length).toBe(asked + 1)
  })
})

