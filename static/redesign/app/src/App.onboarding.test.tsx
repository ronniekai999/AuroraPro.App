// @vitest-environment jsdom
//
// The app's part in what the onboarding flow can reach, and what can reach
// it. On a first visit to an account with several profiles the "Who's
// watching?" picker is up, and the flow for the profile the session is on
// mounts underneath it. Until someone is picked, the keys are the picker's:
// the flow must not take the focus, and nothing in it may be reached. And
// while the flow is up, the page behind it is out of reach too.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import App from './App'

const NOW = '2026-10-01T00:00:00Z'
const USER = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
const PARENT = { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: NOW, updated_at: NOW }
const OTHER = { id: 2, user_id: 1, name: 'Robin', is_default: false, created_at: NOW, updated_at: NOW }

const TITLE = { id: 7, library_id: 1, type: 'movie', title: 'Night Train to Meridian', year: 2020, rating: 7, overview: 'A train.', added_at: NOW, updated_at: NOW }

function stubServer({ profiles = [PARENT, OTHER] } = {}) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string) => {
    const p = new URL(input, 'http://localhost').pathname
    if (p === '/api/auth/me') return json(USER)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: USER })
    if (p === '/api/profiles') return json(profiles)
    if (p === '/api/profiles/active') return json(PARENT)
    if (/^\/api\/profiles\/\d+\/activate$/.test(p)) return new Response(null, { status: 204 })
    // The profile the session is on has not been set up.
    if (p === '/api/onboarding/status') {
      return json({ profile_id: 1, completed: false, eligible: true, library_embedded: true, min_picks: 5, threshold: 3, seed_count: 0 })
    }
    if (p === '/api/onboarding/grid') return json({ items: [] })
    if (p === '/api/me/referral-prompt') return json({ pending: false })
    if (p === '/api/me/hero') return json({ picks: [], slate_token: 's' })
    if (p === '/api/media/recent') return json({ data: [] })
    if (p === '/api/media') return json({ data: [], page: 1, per_page: 1, total_items: 0, total_pages: 1 })
    if (p.startsWith('/api/me/discover')) return json({ rails: [] })
    if (p === '/api/parties/active') return json({ parties: [] })
    if (p === '/api/me/party-invites') return json({ invites: [] })
    if (p === `/api/media/${TITLE.id}`) return json(TITLE)
    return json([])
  })
  vi.stubGlobal('WebSocket', class { readyState = 3; close() {} send() {} addEventListener() {} removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('scrollTo', () => {})
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('the onboarding flow under the "Who\'s watching?" picker', () => {
  it('is out of reach until someone is picked, and keeps the page behind it out of reach', async () => {
    stubServer()
    // A first visit on this browser: the picker has not been seen.
    localStorage.setItem('aurora_user', JSON.stringify(USER))
    localStorage.setItem('aurora_active_profile_id', '1')
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)

    const find = { timeout: 5000 }
    const picker = await screen.findByRole('dialog', { name: "Who's watching?" }, find)
    // The flow mounts under it, once the app knows this profile needs it.
    const flow = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Set up your Aurora"]')
      expect(el).not.toBeNull()
      return el!
    }, find)
    // The picker keeps the focus it had, and the flow cannot be reached.
    await waitFor(() => expect(picker.contains(document.activeElement)).toBe(true), find)
    expect(flow).toHaveAttribute('inert')
    expect(flow.contains(document.activeElement)).toBe(false)
    // Nor can the page behind the flow.
    const main = document.querySelector('main')!
    expect(main).toHaveAttribute('inert')
    // The picker is not inside either.
    expect(main.contains(picker)).toBe(false)
    expect(flow.contains(picker)).toBe(false)

    // Someone is picked: the picker goes, and the flow is the page.
    fireEvent.click(within(picker).getByRole('radio', { name: /Parent/ }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Who's watching?" })).toBeNull(), find)
    await waitFor(() => expect(flow.isConnected ? flow : document.querySelector('[role="dialog"][aria-label="Set up your Aurora"]')).not.toHaveAttribute('inert'), find)
    const heading = await screen.findByRole('heading', { level: 1, name: 'Make it yours' }, find)
    await waitFor(() => expect(heading).toHaveFocus(), find)
    expect(document.querySelector('main')).toHaveAttribute('inert')
  }, 30_000)
})

function Where() {
  const { pathname } = useLocation()
  return <output data-testid="where">{pathname}</output>
}

describe('the onboarding flow over a title page', () => {
  // A link to a title, opened by a profile that has not been set up: the
  // flow is drawn over the title page. The flow has no Escape of its own,
  // and the key went on to the page behind it, which went Back: the viewer,
  // still in the flow, was taken off the title they had opened.
  it('keeps Escape from sending the title page behind it Back', async () => {
    stubServer({ profiles: [PARENT] })
    localStorage.setItem('aurora_user', JSON.stringify(USER))
    localStorage.setItem('aurora_active_profile_id', '1')
    render(<MemoryRouter initialEntries={[`/title/${TITLE.id}`]}><App /><Where /></MemoryRouter>)

    const find = { timeout: 5000 }
    // The title page is up behind the flow, and the flow has the focus.
    await screen.findByRole('heading', { level: 1, name: TITLE.title }, find)
    const heading = await screen.findByRole('heading', { level: 1, name: 'Make it yours' }, find)
    await waitFor(() => expect(heading).toHaveFocus(), find)
    expect(document.querySelector('[role="dialog"][aria-label="Set up your Aurora"]')).not.toHaveAttribute('inert')

    fireEvent.keyDown(heading, { key: 'Escape' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    // Let anything the key started land.
    await new Promise(r => setTimeout(r, 50))
    expect(screen.getByTestId('where')).toHaveTextContent(`/title/${TITLE.id}`)
    expect(heading).toBeInTheDocument()
  }, 30_000)
})
