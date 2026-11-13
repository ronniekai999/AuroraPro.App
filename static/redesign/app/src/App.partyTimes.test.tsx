// @vitest-environment jsdom
//
// The bell's invitation rows give the party's planned time. An invitation is
// listed for as long as its party is held, and a party is held for a while
// past a planned time it did not start at: the row must not then give that
// time as one still to come.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from './App'

const NOW = '2026-10-01T00:00:00Z'
const USER = { id: 1, username: 'ronnie', email: 'r@example.test', role: 'user' }
const PROFILE = { id: 1, user_id: 1, name: 'Ronnie', is_default: true, created_at: NOW, updated_at: NOW }

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString()

function stubServer(invites: unknown[]) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (input: string) => {
    const p = new URL(input, 'http://localhost').pathname
    if (p === '/api/me/party-invites') return json({ invites })
    if (p === '/api/me/notifications') {
      return json({
        notifications: [
          { id: 1, user_id: 1, type: 'party_invite', title: 'jonah invited you to Kestrel', link: '/p/LATE01', created_at: NOW },
          { id: 2, user_id: 1, type: 'party_invite', title: 'jonah invited you to Orchard', link: '/p/SOON02', created_at: NOW },
          { id: 3, user_id: 1, type: 'party_invite', title: 'jonah invited you to Meridian', link: '/p/LIVE03', created_at: NOW },
        ],
        unread: 3,
      })
    }
    if (p === '/api/auth/me') return json(USER)
    if (p === '/api/auth/refresh') return json({ expires_in: 900, user: USER })
    if (p === '/api/profiles') return json([PROFILE])
    if (p === '/api/profiles/active') return json(PROFILE)
    if (/^\/api\/profiles\/\d+\/activate$/.test(p)) return new Response(null, { status: 204 })
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
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

describe('the bell’s invitation rows', () => {
  it('do not give a planned time that has passed as one still to come', async () => {
    const invite = (id: number, code: string, title: string, over: object) => ({
      invite_id: id, party_code: code, media_title: title, host_username: 'jonah', rsvp: 'pending', created_at: NOW, ...over,
    })
    stubServer([
      // Not started, four minutes past its time: still held, still listed.
      invite(1, 'LATE01', 'Kestrel', { scheduled_start_at: minutes(-4), started_at: null, note: 'Bring snacks.' }),
      // Not started, a week ahead.
      invite(2, 'SOON02', 'Orchard', { scheduled_start_at: minutes(7 * 24 * 60), started_at: null }),
      // Started: its planned time is its time, with nothing to add.
      invite(3, 'LIVE03', 'Meridian', { scheduled_start_at: minutes(-30), started_at: minutes(-28) }),
    ])
    localStorage.setItem('aurora_user', JSON.stringify(USER))
    localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
    render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)

    const find = { timeout: 5000 }
    await screen.findByText('Ronnie', { selector: '[data-identity-name]' }, find)
    fireEvent.click(document.querySelector('[data-identity-trigger]')!)
    fireEvent.click(within(screen.getByRole('group', { name: 'Account and profiles' })).getByRole('button', { name: /^Notifications/ }))
    /** The line under a notification's title: the time, and the host's note. */
    const under = async (title: string) => {
      const heading = await screen.findByText(title, {}, find)
      // The line comes with the invitation, which is asked for as the
      // bell opens.
      await waitFor(() => expect(heading.parentElement!.querySelector('p')).not.toBeNull(), find)
      return heading.parentElement!.querySelector('p')!.textContent
    }
    expect(await under('jonah invited you to Kestrel')).toMatch(/^Was planned for .+ · \d+:\d\d [AP]M · “Bring snacks.”$/)
    const soon = await under('jonah invited you to Orchard')
    expect(soon).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+ · \d+:\d\d [AP]M$/)
    const live = await under('jonah invited you to Meridian')
    expect(live).toMatch(/ · \d+:\d\d [AP]M$/)
    expect(live).not.toMatch(/planned/)
  }, 20_000)
})
