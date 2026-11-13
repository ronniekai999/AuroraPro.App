// @vitest-environment jsdom
//
// Upcoming (the calendar): its summary and its List / Month control are
// handed to the Library header's row; the page has no heading block of its
// own.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'

const api = vi.hoisted(() => ({
  getCalendar: vi.fn<(from: string, to: string) => Promise<unknown[]>>(),
  listMyPartyInvites: vi.fn<() => Promise<unknown[]>>(),
  listActiveParties: vi.fn<() => Promise<unknown[]>>(),
}))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  getCalendar: api.getCalendar,
  listMyPartyInvites: api.listMyPartyInvites,
  listActiveParties: api.listActiveParties,
}))

import CalendarView, { calendarSummary } from './CalendarView'
import { LibraryHeader, LibraryToolsProvider } from './LibraryHeader'

const noop = () => {}
const ep = (air_date: string, n = 1) => ({
  episode_id: n, media_item_id: 100 + n, show_title: `Show ${n}`, season_number: 1, episode_number: n, title: `Episode ${n}`, air_date,
})

function Page() {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <>
      <LibraryHeader current="calendar" navScope="full" onNavigate={noop} toolsRef={setSlot} />
      <LibraryToolsProvider value={slot}><main><CalendarView onOpenMedia={noop} /></main></LibraryToolsProvider>
    </>
  )
}
const header = () => document.querySelector<HTMLElement>('[data-library-header]')!
const summary = () => within(header()).getByRole('status').textContent

beforeEach(() => {
  localStorage.clear()
  api.listMyPartyInvites.mockResolvedValue([])
  api.listActiveParties.mockResolvedValue([])
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the line that says what the calendar is showing', () => {
  const november = new Date(Date.UTC(2026, 10, 1))

  it('counts the list\'s window as it is', () => {
    expect(calendarSummary('list', november, [ep('2026-11-09'), ep('2026-11-10', 2)])).toBe('Next 30 days · 2 episodes')
    expect(calendarSummary('list', november, [ep('2026-11-09')])).toBe('Next 30 days · 1 episode')
    expect(calendarSummary('list', november, [])).toBe('Next 30 days · no upcoming episodes')
  })

  // The month view also fetches the days of the neighbouring months that pad
  // its grid; they are not November's.
  it('counts only the month it names', () => {
    const fetched = [ep('2026-10-31'), ep('2026-11-01', 2), ep('2026-11-30', 3), ep('2026-12-01', 4)]
    expect(calendarSummary('grid', november, fetched)).toMatch(/^November 2026 · 2 episodes$/)
    expect(calendarSummary('grid', november, [ep('2026-10-31')])).toMatch(/^November 2026 · no upcoming episodes$/)
  })
})

describe('Upcoming', () => {
  it('puts its summary and its List / Month control in the Library header\'s row', async () => {
    api.getCalendar.mockResolvedValue([ep(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))])
    render(<Page />)
    await waitFor(() => expect(summary()).toBe('Next 30 days · 1 episode'))
    const control = within(header()).getByRole('group', { name: 'Calendar view' })
    expect(within(control).getAllByRole('button').map(b => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['List', 'true'], ['Month', 'false']])
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Upcoming'])
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('sr-only')
    expect(within(document.querySelector('main')!).queryByRole('group', { name: 'Calendar view' })).toBeNull()
  })

  it('switches to the month, which the summary then names, and remembers the choice', async () => {
    api.getCalendar.mockResolvedValue([])
    render(<Page />)
    await waitFor(() => expect(summary()).toBe('Next 30 days · no upcoming episodes'))
    fireEvent.click(within(header()).getByRole('button', { name: 'Month' }))
    await waitFor(() => expect(summary()).toMatch(/^[A-Z][a-z]+ \d{4} · no upcoming episodes$/))
    expect(within(header()).getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true')
    cleanup()
    render(<Page />)
    await waitFor(() => expect(within(header()).getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true'))
  })

  it('says nothing in the summary while it loads, and says in words when it cannot load', async () => {
    let fail!: (e: Error) => void
    api.getCalendar.mockReturnValue(new Promise((_, reject) => { fail = reject }))
    render(<Page />)
    await waitFor(() => expect(within(header()).getByRole('status')).toBeInTheDocument())
    expect(summary()).toBe('')
    fail(new Error('HTTP 500'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('The calendar could not be loaded. Reload the page to try again.')
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Upcoming'])
    expect(document.body.textContent).not.toContain('500')
  })
})
