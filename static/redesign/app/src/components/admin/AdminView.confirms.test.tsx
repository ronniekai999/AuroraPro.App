// @vitest-environment jsdom
//
// Every question the admin page asks before it changes or destroys something:
// the app's own dialog, never the browser's box. For each one: dismissing it
// sends nothing; confirming sends exactly one request; a second press while
// that request is out sends nothing, and nothing answers the dialog then; a
// refusal is said inside the dialog in the page's words (the server's text
// only after them), and the dialog stays to be answered again; and once it
// goes through, the focus is where the page says.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { APIError, type ActiveStreamRow, type AdminUser, type Library, type MediaRequest, type Room, type RetypePreview } from '@/lib/api'

const api = vi.hoisted(() => ({
  getAdminDashboard: vi.fn(), getEmbeddingStatus: vi.fn(), getSkipMarkerStatus: vi.fn(),
  listLibraries: vi.fn(), getLibraryHealth: vi.fn(), deleteLibrary: vi.fn(), scanLibrary: vi.fn(),
  previewLibraryRetype: vi.fn(), retypeLibrary: vi.fn(), createLibrary: vi.fn(),
  getAllSettings: vi.fn(), purgeImageCache: vi.fn(), updateSettings: vi.fn(),
  listRooms: vi.fn(), deleteRoom: vi.fn(), createRoom: vi.fn(),
  listPendingApprovals: vi.fn(), denyRequest: vi.fn(), approveRequest: vi.fn(),
  listAdminSessions: vi.fn(), deleteStreamSession: vi.fn(),
  listAdminUsers: vi.fn(), getAdminReferralSummary: vi.fn(), updateUserRole: vi.fn(), deleteUser: vi.fn(), createInvite: vi.fn(),
  getAdminLLM: vi.fn(), updateAdminLLM: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

import AdminView from './AdminView'
import { resetRestoreOutcomeForTest } from './restoreOutcome'

type User = ReturnType<typeof userEvent.setup>

const LIB: Library = { id: 1, name: 'Movies', type: 'movie', paths: ['/media/movies'], scan_interval_minutes: 0, owner_id: 1, created_at: '', updated_at: '' }
const ROOM: Room = { id: 4, code: 'FRD4YC', name: 'Movie night', owner_user_id: 1, created_at: '' }
const REQ = { id: 5, user_id: 2, media_type: 'movie', tmdb_id: 9, title: 'Dune', poster_path: '', overview: '', year: 2021, status: 'pending_approval', quality_1080p: true, quality_4k: false, requested_at: new Date().toISOString(), username: 'priya' } as MediaRequest
const STREAM = { id: 's1-session', kind: 'transcode', user_id: 2, username: 'priya', file_name: 's1.mkv', started_at: new Date().toISOString() } as unknown as ActiveStreamRow
const PRIYA = { id: 2, username: 'priya', email: 'p@example.test', role: 'user', created_at: '', updated_at: '' } as AdminUser
const PREVIEW: RetypePreview = {
  library_id: 1, library_name: 'Movies', current_type: 'movie', target_type: 'show', items_to_delete: 3, items_kept: 0,
  casualties: [{ table: 'watch_progress', rows: 7, why: 'what people have watched' }],
} as RetypePreview

// The restore is a multipart upload made with fetch directly.
let restoreAnswer: () => Promise<Response>
const restoreCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/admin/restore')
const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
  if (String(url) === '/api/admin/restore') return restoreAnswer()
  return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
})
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  // A restore's outcome outlives the page by design: each test starts clean.
  resetRestoreOutcomeForTest()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  fetchMock.mockClear()
  restoreAnswer = async () => json(200, { status: 'ok', message: 'Restore complete. RESTART AURORA NOW.' })
  for (const fn of Object.values(api)) fn.mockReset()
  for (const fn of [api.getAdminDashboard, api.getEmbeddingStatus, api.getSkipMarkerStatus, api.getLibraryHealth]) fn.mockRejectedValue(new Error('off'))
  api.listLibraries.mockResolvedValue([LIB])
  api.getAllSettings.mockResolvedValue({})
  api.listRooms.mockResolvedValue([ROOM])
  api.listPendingApprovals.mockResolvedValue([REQ])
  api.listAdminSessions.mockResolvedValue([STREAM])
  api.listAdminUsers.mockResolvedValue([PRIYA])
  api.getAdminReferralSummary.mockResolvedValue({ by_source: [] })
  api.previewLibraryRetype.mockResolvedValue(PREVIEW)
})
afterEach(() => vi.unstubAllGlobals())

async function openSection(user: User, name: string) {
  const view = render(<MemoryRouter><AdminView currentAdminId={1} /></MemoryRouter>)
  await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name }))
  return view
}

interface Case {
  name: string
  section: string
  /** Press what asks the question; answers the control that asked. */
  ask: (user: User, view: ReturnType<typeof render>) => Promise<HTMLElement>
  title: string | RegExp
  confirm: string
  /** The request's calls so far. */
  calls: () => unknown[][]
  /** The arguments it is sent with. */
  args?: unknown[]
  hold: () => void
  refuse: (status: number, server: string) => void
  /** A refusal the server sends here, and what the page says of it first. */
  refusal: { status: number; says: string }
  succeed: () => void
  /** Where the focus is once it went through. */
  focusAfter: (asker: HTMLElement) => HTMLElement
}

const never = () => new Promise<never>(() => {})

const CASES: Case[] = [
  {
    name: 'delete a library',
    section: 'Libraries',
    ask: async user => { const b = await screen.findByRole('button', { name: 'Delete Movies' }); await user.click(b); return b },
    title: 'Delete the library Movies?',
    confirm: 'Delete library',
    calls: () => api.deleteLibrary.mock.calls,
    args: [1],
    hold: () => api.deleteLibrary.mockReturnValue(never()),
    refuse: (status, server) => api.deleteLibrary.mockRejectedValueOnce(new APIError(status, server, {})),
    refusal: { status: 500, says: 'Could not delete Movies just now.' },
    succeed: () => { api.deleteLibrary.mockResolvedValue(undefined); api.listLibraries.mockResolvedValueOnce([LIB]).mockResolvedValue([]) },
    // The row that asked is gone.
    focusAfter: () => screen.getByRole('heading', { name: 'Libraries on this server' }),
  },
  {
    name: 'change a library’s type',
    section: 'Libraries',
    ask: async user => { const b = await screen.findByRole('button', { name: 'Change to TV' }); await user.click(b); return b },
    title: 'Change Movies to TV shows?',
    confirm: 'Delete and rescan',
    calls: () => api.retypeLibrary.mock.calls,
    // The count the check returned, echoed back.
    args: [1, 'show', 3],
    hold: () => api.retypeLibrary.mockReturnValue(never()),
    refuse: (status, server) => api.retypeLibrary.mockRejectedValueOnce(new APIError(status, server, {})),
    refusal: { status: 409, says: 'Nothing was deleted. The library has changed since it was checked, or a scan of it is running. Cancel, wait for any scan to finish, and check again to see the new figure.' },
    succeed: () => api.retypeLibrary.mockResolvedValue({ items_deleted: 3 }),
    focusAfter: asker => asker,
  },
  {
    name: 'purge the image cache',
    section: 'Server settings',
    ask: async user => { const b = await screen.findByRole('button', { name: 'Purge image cache' }); await user.click(b); return b },
    title: 'Purge the image cache?',
    confirm: 'Purge image cache',
    calls: () => api.purgeImageCache.mock.calls,
    hold: () => api.purgeImageCache.mockReturnValue(never()),
    refuse: (status, server) => api.purgeImageCache.mockRejectedValueOnce(new APIError(status, server, {})),
    refusal: { status: 500, says: 'The server could not purge the image cache.' },
    succeed: () => api.purgeImageCache.mockResolvedValue({ files_purged: 12, bytes_freed: 3 * 1024 * 1024 }),
    focusAfter: asker => asker,
  },
  {
    name: 'delete a room',
    section: 'Rooms',
    ask: async user => { const b = await screen.findByRole('button', { name: 'Delete Movie night' }); await user.click(b); return b },
    title: 'Delete the room Movie night?',
    confirm: 'Delete room',
    calls: () => api.deleteRoom.mock.calls,
    args: [4],
    hold: () => api.deleteRoom.mockReturnValue(never()),
    refuse: (status, server) => api.deleteRoom.mockRejectedValueOnce(new APIError(status, server, {})),
    refusal: { status: 403, says: 'Only the person who made this room can delete it.' },
    succeed: () => { api.deleteRoom.mockResolvedValue(undefined); api.listRooms.mockResolvedValueOnce([ROOM]).mockResolvedValue([]) },
    focusAfter: () => screen.getByRole('heading', { name: 'Rooms on this server' }),
  },
  {
    name: 'deny a request',
    section: 'Requests',
    ask: async user => { const b = await screen.findByRole('button', { name: 'Deny Dune' }); await user.click(b); return b },
    title: 'Deny the request for Dune?',
    confirm: 'Deny request',
    calls: () => api.denyRequest.mock.calls,
    args: [5],
    hold: () => api.denyRequest.mockReturnValue(never()),
    refuse: (status, server) => api.denyRequest.mockRejectedValueOnce(new APIError(status, server, {})),
    refusal: { status: 400, says: 'The server refused this: the request may no longer be waiting for approval.' },
    succeed: () => { api.denyRequest.mockResolvedValue(undefined); api.listPendingApprovals.mockResolvedValueOnce([REQ]).mockResolvedValue([]) },
    focusAfter: () => screen.getByRole('heading', { name: 'Waiting for approval' }),
  },
  {
    name: 'stop a stream',
    section: 'Active streams',
    ask: async user => { const b = await screen.findByRole('button', { name: 'Stop the stream of s1.mkv' }); await user.click(b); return b },
    title: "Stop priya's stream?",
    confirm: 'Stop stream',
    calls: () => api.deleteStreamSession.mock.calls,
    args: ['s1-session'],
    hold: () => api.deleteStreamSession.mockReturnValue(never()),
    refuse: (status, server) => api.deleteStreamSession.mockRejectedValueOnce(new APIError(status, server, {})),
    refusal: { status: 500, says: 'Could not stop the stream just now.' },
    succeed: () => { api.deleteStreamSession.mockResolvedValue(undefined); api.listAdminSessions.mockResolvedValueOnce([STREAM]).mockResolvedValue([]) },
    focusAfter: () => screen.getByRole('button', { name: 'Refresh' }),
  },
  {
    name: 'make a user an admin',
    section: 'Users',
    ask: async user => {
      const b = await screen.findByRole('button', { name: 'Actions for priya' })
      await user.click(b)
      await user.click(screen.getByRole('menuitem', { name: 'Make admin' }))
      return b
    },
    title: 'Make priya an admin?',
    confirm: 'Make admin',
    calls: () => api.updateUserRole.mock.calls,
    args: [2, 'admin'],
    hold: () => api.updateUserRole.mockReturnValue(never()),
    refuse: (status, server) => api.updateUserRole.mockRejectedValueOnce(new APIError(status, server, {})),
    refusal: { status: 400, says: "Could not change priya's role." },
    succeed: () => api.updateUserRole.mockResolvedValue(undefined),
    focusAfter: asker => asker,
  },
  {
    name: 'delete a user',
    section: 'Users',
    ask: async user => {
      const b = await screen.findByRole('button', { name: 'Actions for priya' })
      await user.click(b)
      await user.click(screen.getByRole('menuitem', { name: 'Delete user' }))
      return b
    },
    title: 'Delete priya?',
    confirm: 'Delete user',
    calls: () => api.deleteUser.mock.calls,
    args: [2],
    hold: () => api.deleteUser.mockReturnValue(never()),
    refuse: (status, server) => api.deleteUser.mockRejectedValueOnce(new APIError(status, server, {})),
    refusal: { status: 500, says: 'Could not delete priya just now.' },
    succeed: () => api.deleteUser.mockResolvedValue(undefined),
    // The row, its menu and the dialog go together: the table takes the focus.
    focusAfter: () => screen.getByRole('region', { name: 'Users on this server' }),
  },
  {
    name: 'restore the database',
    section: 'Backup and restore',
    ask: async (user, view) => {
      const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
      await user.upload(input, new File(['PGDMP'.padEnd(2048, 'x')], 'aurora.dump'))
      const b = screen.getByRole('button', { name: 'Restore database' })
      await user.click(b)
      return b
    },
    title: 'Restore the database from aurora.dump?',
    confirm: 'Restore database',
    calls: () => restoreCalls(),
    hold: () => { restoreAnswer = never },
    refuse: (status, server) => {
      let first = true
      const ok = restoreAnswer
      restoreAnswer = async () => {
        if (!first) return ok()
        first = false
        return json(status, { error: { code: status, message: server } })
      }
    },
    refusal: { status: 400, says: 'The server refused this file, and the database was not changed.' },
    succeed: () => { /* the default answer */ },
    // The button that asked is locked once the restore is done.
    focusAfter: () => screen.getByRole('region', { name: 'Restart Aurora now' }),
  },
]

const dialog = () => screen.getByRole('alertdialog')

describe.each(CASES)('asking before they $name', c => {
  it('is the app’s dialog, and sends nothing when Cancel is pressed', async () => {
    const user = userEvent.setup()
    const view = await openSection(user, c.section)
    const asker = await c.ask(user, view)
    const d = await screen.findByRole('alertdialog', { name: c.title })
    // The answer that changes nothing has the focus.
    expect(within(d).getAllByRole('button')[0]).toHaveFocus()
    await user.click(within(d).getAllByRole('button')[0])
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(c.calls()).toHaveLength(0)
    await waitFor(() => expect(asker).toHaveFocus())
  })

  it('sends nothing when Escape is pressed', async () => {
    const user = userEvent.setup()
    const view = await openSection(user, c.section)
    await c.ask(user, view)
    await screen.findByRole('alertdialog', { name: c.title })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(c.calls()).toHaveLength(0)
  })

  it('sends one request when confirmed, and nothing more for a second press, Cancel or Escape while it is out', async () => {
    const user = userEvent.setup()
    c.hold()
    const view = await openSection(user, c.section)
    await c.ask(user, view)
    await screen.findByRole('alertdialog', { name: c.title })
    await user.click(within(dialog()).getByRole('button', { name: c.confirm }))
    await waitFor(() => expect(c.calls()).toHaveLength(1))
    if (c.args) expect(c.calls()[0]).toEqual(c.args)
    const buttons = within(dialog()).getAllByRole('button')
    for (const b of buttons) expect(b).toHaveAttribute('aria-disabled', 'true')
    // The focus stays on the button pressed: it is not disabled under it.
    expect(document.activeElement).toBe(buttons[buttons.length - 1])
    await user.click(buttons[buttons.length - 1])
    await user.click(buttons[0])
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog', { name: c.title })).toBeInTheDocument()
    expect(c.calls()).toHaveLength(1)
  })

  it('says a refusal inside the dialog in the page’s words, keeps the dialog, and can be answered again', async () => {
    const user = userEvent.setup()
    c.refuse(c.refusal.status, 'the server’s own words')
    const view = await openSection(user, c.section)
    await c.ask(user, view)
    await screen.findByRole('alertdialog', { name: c.title })
    await user.click(within(dialog()).getByRole('button', { name: c.confirm }))
    const said = await within(dialog()).findByRole('alert')
    const lines = within(said).getAllByText(/./)
    // The page's words first; the server's only after them, marked as its.
    expect(lines[0].textContent).toBe(c.refusal.says)
    expect(lines[1].textContent).toBe('The server said: the server’s own words')
    expect(screen.getByRole('alertdialog', { name: c.title })).toBeInTheDocument()
    expect(c.calls()).toHaveLength(1)
    // Not locked by the refused answer: it can be confirmed again, or put down.
    await user.click(within(dialog()).getByRole('button', { name: c.confirm }))
    await waitFor(() => expect(c.calls()).toHaveLength(2))
  })

  it('closes once it has gone through and puts the focus where it belongs', async () => {
    const user = userEvent.setup()
    c.succeed()
    const view = await openSection(user, c.section)
    const asker = await c.ask(user, view)
    await screen.findByRole('alertdialog', { name: c.title })
    await user.click(within(dialog()).getByRole('button', { name: c.confirm }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(c.calls()).toHaveLength(1)
    await waitFor(() => expect(c.focusAfter(asker)).toHaveFocus())
  })
})
