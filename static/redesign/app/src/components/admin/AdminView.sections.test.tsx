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
  listAdminSessions: vi.fn(), diagnoseSession: vi.fn(), startAIRematch: vi.fn(),
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

  // A match closed on may or may not have been saved, and the server may
  // still be at it. The page claims neither, in words or in colour: it reads
  // the list now, and once more after a wait, since a read that comes before
  // the server has finished shows the item still flagged.
  it('reads the list now and again after a wait, and claims no outcome, when the dialog is closed while a match is being sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
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
      const line = screen.getAllByRole('status').find(el => el.textContent)!
      expect(line.textContent).toBe('The dialog was closed while the match for Kestrel was still being sent, so it may or may not have been saved. This list is read again now and once more in a few seconds: a match that was saved can take a moment to show.')
      // Not in the colour of a match that was saved.
      expect(line.className).not.toMatch(/text-ok/)
      expect(screen.queryByText(/^Matched /)).toBeNull()
      // The server finishes the match after the first read; the second
      // read shows it, and the list takes the focus the row's button had.
      await waitFor(() => expect(within(list()).getByRole('button', { name: 'Match Kestrel' })).toHaveFocus())
      api.listFlaggedItems.mockResolvedValue([])
      expect(api.listFlaggedItems).toHaveBeenCalledTimes(2)
      await act(async () => { vi.advanceTimersByTime(4000) })
      expect(api.listFlaggedItems).toHaveBeenCalledTimes(3)
      await waitFor(() => expect(within(list()).queryByRole('button', { name: 'Match Kestrel' })).toBeNull())
      await waitFor(() => expect(list()).toHaveFocus())
    } finally {
      vi.useRealTimers()
    }
  })

  // Four seconds is long enough to have clicked into the page to read. The
  // second read must not take the focus from there, or scroll the page to
  // the list.
  it('does not take the focus at the second read from someone who has moved it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      api.listFlaggedItems.mockResolvedValue([flagged(1, 'Kestrel')])
      api.manualMatch.mockReturnValue(new Promise(() => {}))
      await openSection(user, 'Flagged items')
      await user.click(await within(list()).findByRole('button', { name: 'Match Kestrel' }))
      await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: /^Match Kestrel \(2019\)/ }))
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(within(list()).getByRole('button', { name: 'Match Kestrel' })).toHaveFocus())
      await waitFor(() => expect(api.listFlaggedItems).toHaveBeenCalledTimes(2))
      ;(document.activeElement as HTMLElement).blur()
      api.listFlaggedItems.mockResolvedValue([])
      await act(async () => { vi.advanceTimersByTime(4000) })
      await waitFor(() => expect(within(list()).queryByRole('button', { name: 'Match Kestrel' })).toBeNull())
      await act(async () => {})
      expect(document.body).toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  // Two reads can be out at once, and the first can be the slower: its
  // older answer must not go up over the newer one.
  it('drops a read that lands after a later one has', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      api.listFlaggedItems.mockResolvedValueOnce([flagged(1, 'Kestrel')])
      api.manualMatch.mockReturnValue(new Promise(() => {}))
      await openSection(user, 'Flagged items')
      await user.click(await within(list()).findByRole('button', { name: 'Match Kestrel' }))
      await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: /^Match Kestrel \(2019\)/ }))
      // The read at the close is slow; the one four seconds on is not.
      let landFirst: (items: ServerMediaItem[]) => void = () => {}
      api.listFlaggedItems.mockImplementationOnce(() => new Promise<ServerMediaItem[]>(resolve => { landFirst = resolve }))
      api.listFlaggedItems.mockResolvedValue([])
      await user.keyboard('{Escape}')
      await waitFor(() => expect(api.listFlaggedItems).toHaveBeenCalledTimes(2))
      await act(async () => { vi.advanceTimersByTime(4000) })
      await waitFor(() => expect(within(list()).getByText(/Nothing flagged/)).toBeInTheDocument())
      // The first read answers now, with the item still flagged as it was
      // when that read was made.
      await act(async () => { landFirst([flagged(1, 'Kestrel')]) })
      expect(within(list()).queryByRole('button', { name: 'Match Kestrel' })).toBeNull()
      expect(within(list()).getByText(/Nothing flagged/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  // A failure lands by the rule an answer does: the older of two reads
  // failing last must not put an error over the newer one's list, and a
  // read that lands takes an earlier failure's words down.
  it('does not put an older read\'s failure over a newer list, and clears a failure when a read lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      api.listFlaggedItems.mockResolvedValueOnce([flagged(1, 'Kestrel')])
      api.manualMatch.mockReturnValue(new Promise(() => {}))
      await openSection(user, 'Flagged items')
      await user.click(await within(list()).findByRole('button', { name: 'Match Kestrel' }))
      await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: /^Match Kestrel \(2019\)/ }))
      // The read at the close is slow and will fail; the one four seconds
      // on answers first.
      let failFirst: (e: Error) => void = () => {}
      api.listFlaggedItems.mockImplementationOnce(() => new Promise<ServerMediaItem[]>((_, reject) => { failFirst = reject }))
      api.listFlaggedItems.mockResolvedValueOnce([flagged(2, 'Wren')])
      await user.keyboard('{Escape}')
      await waitFor(() => expect(api.listFlaggedItems).toHaveBeenCalledTimes(2))
      await act(async () => { vi.advanceTimersByTime(4000) })
      await within(list()).findByRole('button', { name: 'Match Wren' })
      await act(async () => { failFirst(new Error('the older read failed')) })
      expect(screen.queryByText('the older read failed')).toBeNull()
      expect(within(list()).getByRole('button', { name: 'Match Wren' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a failed read\'s words down when a later read lands', async () => {
    const user = userEvent.setup()
    api.listFlaggedItems.mockRejectedValueOnce(new Error('the list could not be read'))
    api.getAIRematchStatus.mockResolvedValue({ enabled: true })
    await openSection(user, 'Flagged items')
    expect(await screen.findByText('the list could not be read')).toBeInTheDocument()
    // A second read (the sweep is started, which reads the list again).
    api.listFlaggedItems.mockResolvedValue([flagged(1, 'Kestrel')])
    api.getAIRematchStatus.mockResolvedValue({ enabled: true, job: { started_at: '2026-01-01T00:00:00Z', total: 1, processed: 0, matched: 0, suggested: 0, failed: 0 } })
    api.startAIRematch.mockResolvedValue(undefined)
    await user.click(screen.getByRole('button', { name: 'Re-match with AI' }))
    await within(list()).findByRole('button', { name: 'Match Kestrel' })
    expect(screen.queryByText('the list could not be read')).toBeNull()
  })

  it('says a saved match in the colour of success', async () => {
    const user = userEvent.setup()
    api.listFlaggedItems.mockResolvedValueOnce([flagged(1, 'Kestrel')]).mockResolvedValue([])
    await openSection(user, 'Flagged items')
    await user.click(await within(list()).findByRole('button', { name: 'Match Kestrel' }))
    await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: /^Match Kestrel \(2019\)/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getAllByRole('status').find(el => el.textContent)!.className).toMatch(/text-ok/)
  })

  // The list takes the focus for the read that followed the match, and for
  // no later one. A matched item that is still flagged at that read keeps
  // its row and the focus; when a later read (the AI sweep's poll here)
  // takes the row away, the focus is not moved for someone who has since
  // put it elsewhere.
  it('does not move the focus at a later read for a match whose row stayed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      api.listFlaggedItems.mockResolvedValue([flagged(1, 'Kestrel')])
      // A sweep is running: the list is read again every five seconds.
      api.getAIRematchStatus.mockResolvedValue({ enabled: true, job: { started_at: '2026-01-01T00:00:00Z', total: 4, processed: 1, matched: 0, suggested: 0, failed: 0 } })
      await openSection(user, 'Flagged items')
      const match = await within(list()).findByRole('button', { name: 'Match Kestrel' })
      await user.click(match)
      await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: /^Match Kestrel \(2019\)/ }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      // Still flagged at the read that followed: the row and its button stay.
      await waitFor(() => expect(within(list()).getByRole('button', { name: 'Match Kestrel' })).toHaveFocus())
      const reads = api.listFlaggedItems.mock.calls.length
      // The person moves on (a tap on the page): the focus is on nothing.
      ;(document.activeElement as HTMLElement).blur()
      expect(document.body).toHaveFocus()
      api.listFlaggedItems.mockResolvedValue([])
      await act(async () => { vi.advanceTimersByTime(5000) })
      await waitFor(() => expect(api.listFlaggedItems.mock.calls.length).toBeGreaterThan(reads))
      await waitFor(() => expect(within(list()).queryByRole('button', { name: 'Match Kestrel' })).toBeNull())
      await act(async () => {})
      expect(document.body).toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  // The read after a match can land before the dialog has gone. The button
  // that opened it is then not there to take the focus back: the list is.
  it('gives the focus to the list when the row that opened the dialog has gone before the dialog closes', async () => {
    const user = userEvent.setup()
    api.listFlaggedItems.mockResolvedValue([flagged(1, 'Kestrel'), flagged(2, 'Wren')])
    let landMatch: () => void = () => {}
    api.manualMatch.mockImplementationOnce(() => new Promise<void>(resolve => { landMatch = resolve }))
    await openSection(user, 'Flagged items')
    await user.click(await within(list()).findByRole('button', { name: 'Match Kestrel' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: /^Match Kestrel \(2019\)/ }))
    // While the match is out the list is read (the sweep's poll, another
    // tab): the item is gone from it before the dialog is.
    api.listFlaggedItems.mockResolvedValue([flagged(2, 'Wren')])
    api.getAIRematchStatus.mockResolvedValue({ enabled: true })
    await act(async () => { landMatch() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(within(list()).queryByRole('button', { name: 'Match Kestrel' })).toBeNull())
    await waitFor(() => expect(list()).toHaveFocus())
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
