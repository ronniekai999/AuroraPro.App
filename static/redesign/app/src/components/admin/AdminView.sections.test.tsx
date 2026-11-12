// @vitest-environment jsdom
//
// Two admin sections whose dialogs hand work back to the page: the flagged
// list after a match, and the active streams after a diagnostic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import type { ActiveStreamRow, MatchSearchResult, ServerMediaItem, SessionDiagnostic } from '@/lib/api'

const api = vi.hoisted(() => ({
  getAdminDashboard: vi.fn(), getEmbeddingStatus: vi.fn(), getSkipMarkerStatus: vi.fn(),
  listFlaggedItems: vi.fn(), getAIRematchStatus: vi.fn(), searchForMatch: vi.fn(), manualMatch: vi.fn(),
  listAdminSessions: vi.fn(), diagnoseSession: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

import AdminView from './AdminView'

const flagged = (id: number, title: string): ServerMediaItem => ({
  id, title, type: 'movie', library_id: 1, match_status: 'needs_review', file_path: `/media/${id}.mkv`, added_at: '', updated_at: '',
} as ServerMediaItem)
const CANDIDATE: MatchSearchResult = { source: 'tmdb', id: 900, title: 'Kestrel', year: 2019 }
const stream = (id: string): ActiveStreamRow => ({
  id, kind: 'transcode', user_id: 2, username: 'priya', file_name: `${id}.mkv`, started_at: new Date().toISOString(),
} as unknown as ActiveStreamRow)
const diagnostic = (id: string): SessionDiagnostic => ({ session_id: id, file_path: `/media/${id}.mkv`, hw_accel: 'vaapi', remux: false, variants: [] })

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'unavailable' }), {
    status: 503, headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  for (const fn of Object.values(api)) fn.mockReset()
  for (const fn of [api.getAdminDashboard, api.getEmbeddingStatus, api.getSkipMarkerStatus]) fn.mockRejectedValue(new Error('off'))
  api.getAIRematchStatus.mockResolvedValue({ enabled: false })
  api.searchForMatch.mockResolvedValue([CANDIDATE])
  api.manualMatch.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

async function openSection(user: ReturnType<typeof userEvent.setup>, name: string) {
  render(<MemoryRouter><AdminView currentAdminId={1} /></MemoryRouter>)
  await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name }))
}
const list = () => screen.getByRole('group', { name: 'Flagged items' })
const said = () => screen.getAllByRole('status').map(s => s.textContent).filter(Boolean)

describe('Flagged items and the match dialog', () => {
  it('says a match was saved, reads the list again, and takes the focus when the matched row has gone', async () => {
    const user = userEvent.setup()
    api.listFlaggedItems.mockResolvedValueOnce([flagged(1, 'Kestrel'), flagged(2, 'Wren')]).mockResolvedValue([flagged(2, 'Wren')])
    await openSection(user, 'Flagged items')
    await user.click(await within(list()).findByRole('button', { name: 'Match Kestrel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Match “Kestrel”' })
    await user.click(await within(dialog).findByRole('button', { name: /^Match Kestrel \(2019\)/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(said()).toEqual(['Matched Kestrel.'])
    await waitFor(() => expect(within(list()).queryByRole('button', { name: 'Match Kestrel' })).toBeNull())
    expect(api.listFlaggedItems).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(list()).toHaveFocus())
  })

  // The same words twice are still two things said; and the group that
  // takes the focus is not left empty when the last item goes.
  it('says a second match of an item with the same title again, and says the list is empty inside the group that has the focus', async () => {
    const user = userEvent.setup()
    api.listFlaggedItems
      .mockResolvedValueOnce([flagged(1, 'Kestrel'), flagged(2, 'Kestrel')])
      .mockResolvedValueOnce([flagged(2, 'Kestrel')])
      .mockResolvedValue([])
    await openSection(user, 'Flagged items')
    for (const left of [1, 0]) {
      await user.click((await within(list()).findAllByRole('button', { name: 'Match Kestrel' }))[0])
      const dialog = await screen.findByRole('dialog')
      await user.click(await within(dialog).findByRole('button', { name: /^Match Kestrel \(2019\)/ }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(within(list()).queryAllByRole('button', { name: 'Match Kestrel' })).toHaveLength(left))
    }
    // Not the same string as the first time, or it would not be read out.
    expect(said()).toHaveLength(1)
    expect(said()[0]).not.toBe('Matched Kestrel.')
    expect(said()[0].trim()).toBe('Matched Kestrel.')
    await waitFor(() => expect(list()).toHaveFocus())
    expect(within(list()).getByText(/Nothing flagged/)).toBeInTheDocument()
  })

  // A match closed on may or may not have been saved. The page claims
  // neither: it reads the list again, which shows which.
  it('reads the list again, and claims no outcome, when the dialog is closed while a match is being sent', async () => {
    const user = userEvent.setup()
    api.listFlaggedItems.mockResolvedValue([flagged(1, 'Kestrel')])
    api.manualMatch.mockReturnValue(new Promise(() => {}))
    await openSection(user, 'Flagged items')
    await user.click(await within(list()).findByRole('button', { name: 'Match Kestrel' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: /^Match Kestrel \(2019\)/ }))
    expect(api.listFlaggedItems).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(api.listFlaggedItems).toHaveBeenCalledTimes(2))
    expect(said()).toEqual(['The dialog was closed while the match for Kestrel was still being sent, so it may or may not have been saved. This list has been read again.'])
    expect(screen.queryByText(/^Matched /)).toBeNull()
  })

  it('reads nothing again when the dialog is closed with no match out', async () => {
    const user = userEvent.setup()
    api.listFlaggedItems.mockResolvedValue([flagged(1, 'Kestrel')])
    await openSection(user, 'Flagged items')
    const opener = await within(list()).findByRole('button', { name: 'Match Kestrel' })
    await user.click(opener)
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(opener).toHaveFocus())
    expect(api.listFlaggedItems).toHaveBeenCalledTimes(1)
    expect(said()).toEqual([])
  })
})

describe('Active streams and the session diagnostic', () => {
  it('does not open the diagnostic again when its answer arrives after it was closed', async () => {
    const user = userEvent.setup()
    api.listAdminSessions.mockResolvedValue([stream('a81f09c2')])
    let answer: (d: SessionDiagnostic) => void = () => {}
    api.diagnoseSession.mockReturnValue(new Promise<SessionDiagnostic>(resolve => { answer = resolve }))
    await openSection(user, 'Active streams')
    const diagnose = await screen.findByRole('button', { name: 'Diagnose' })
    await user.click(diagnose)
    expect(await screen.findByRole('dialog', { name: 'Session diagnostic' })).toHaveTextContent('Loading…')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(async () => { answer(diagnostic('a81f09c2')) })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(diagnose).toHaveFocus())
  })

  it('shows the answer for the stream last asked about', async () => {
    const user = userEvent.setup()
    api.listAdminSessions.mockResolvedValue([stream('a81f09c2')])
    api.diagnoseSession.mockResolvedValue(diagnostic('a81f09c2'))
    await openSection(user, 'Active streams')
    await user.click(await screen.findByRole('button', { name: 'Diagnose' }))
    const dialog = await screen.findByRole('dialog', { name: 'Session diagnostic' })
    expect(await within(dialog).findByText('/media/a81f09c2.mkv')).toBeInTheDocument()
  })

  // The list is read again every few seconds, and a stream that has ended
  // takes its row away with the button that opened the dialog.
  it('hands the focus to Refresh when the stream that was diagnosed has gone', async () => {
    const user = userEvent.setup()
    api.listAdminSessions.mockResolvedValueOnce([stream('a81f09c2')]).mockResolvedValue([])
    api.diagnoseSession.mockResolvedValue(diagnostic('a81f09c2'))
    await openSection(user, 'Active streams')
    await user.click(await screen.findByRole('button', { name: 'Diagnose' }))
    const dialog = await screen.findByRole('dialog', { name: 'Session diagnostic' })
    await within(dialog).findByText('/media/a81f09c2.mkv')
    // The row goes while the dialog is open.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh', hidden: true }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Diagnose', hidden: true })).toBeNull())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toHaveFocus())
  })
})
