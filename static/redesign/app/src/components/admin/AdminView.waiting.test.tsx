// @vitest-environment jsdom
//
// A server that is slow, or never answers, must not hold the admin in a
// dialog: after a wait the dialog's other button becomes a way out, which
// sends and aborts nothing, and what the request did is said in the panel
// when it lands. And each button whose request is out ignores a second
// press, by pointer and by keyboard, without being disabled under the focus.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { APIError, type ActiveStreamRow, type AdminUser, type Library, type Room, type LLMSettings, type MediaRequest, type RetypePreview } from '@/lib/api'
import { WAY_OUT_AFTER_MS } from '@/components/settings/ConfirmDialog'

const api = vi.hoisted(() => ({
  getAdminDashboard: vi.fn(), getEmbeddingStatus: vi.fn(), getSkipMarkerStatus: vi.fn(),
  listLibraries: vi.fn(), getLibraryHealth: vi.fn(), deleteLibrary: vi.fn(), previewLibraryRetype: vi.fn(),
  listPendingApprovals: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(),
  getAdminLLM: vi.fn(), updateAdminLLM: vi.fn(),
  getAdminOAuth: vi.fn(), updateAdminOAuth: vi.fn(), getAdminReferralSummary: vi.fn(), getAllSettings: vi.fn(),
  listAdminUsers: vi.fn(), updateUserRole: vi.fn(),
  listRooms: vi.fn(), deleteRoom: vi.fn(), listAdminSessions: vi.fn(), deleteStreamSession: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

import AdminView from './AdminView'
import { resetRestoreOutcomeForTest } from './restoreOutcome'

type User = ReturnType<typeof userEvent.setup>
const LIB: Library = { id: 1, name: 'Movies', type: 'movie', paths: ['/m'], scan_interval_minutes: 0, owner_id: 1, created_at: '', updated_at: '' }
const req = (id: number, title: string) => ({ id, user_id: 2, media_type: 'movie', tmdb_id: id, title, poster_path: '', overview: '', year: 2021, status: 'pending_approval', quality_1080p: true, quality_4k: false, requested_at: new Date().toISOString() } as MediaRequest)
const LLM = { provider: 'local', embed_provider: 'local', ollama_url: '', embed_url: '', api_key_masked: '', has_api_key: false, anthropic_api_key_masked: '', has_anthropic_api_key: false, openai_api_key_masked: '', has_openai_api_key: false, chat_model: '', embed_model: '', debug_log: false, live_debug_log: false, client_loaded: true } as LLMSettings
const PRIYA = { id: 2, username: 'priya', email: '', role: 'admin', created_at: '', updated_at: '' } as AdminUser

/** A promise this test settles when it likes. */
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const never = () => new Promise<never>(() => {})

beforeEach(() => {
  // A restore's outcome outlives the page by design: each test starts clean.
  resetRestoreOutcomeForTest()
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  for (const fn of Object.values(api)) fn.mockReset()
  for (const fn of [api.getAdminDashboard, api.getEmbeddingStatus, api.getSkipMarkerStatus, api.getLibraryHealth]) fn.mockRejectedValue(new Error('off'))
  api.listLibraries.mockResolvedValue([LIB])
  api.getAdminLLM.mockResolvedValue(LLM)
  api.getAllSettings.mockResolvedValue({})
  api.getAdminReferralSummary.mockResolvedValue({ by_source: [], answered: 0, skipped: 0, pending: 0, window_days: 30 })
  api.getAdminOAuth.mockResolvedValue({ google_enabled: false, google_client_id: '', google_redirect_url: '', google_bypass_invite: false, google_has_secret: false, google_client_secret_masked: '' })
  api.listAdminUsers.mockResolvedValue([PRIYA])
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function openSection(user: User, name: string) {
  render(<MemoryRouter><AdminView currentAdminId={1} /></MemoryRouter>)
  await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name }))
}
const statusSays = () => screen.getAllByRole('status').map(s => s.textContent?.trim()).filter(Boolean)

describe('a request that does not answer', () => {
  async function askToDelete() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await openSection(user, 'Libraries')
    await user.click(await screen.findByRole('button', { name: 'Delete Movies' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete library' }))
    return user
  }

  it('offers no way out at first, then one that sends nothing, and says the server is still being waited for', async () => {
    api.deleteLibrary.mockReturnValue(never())
    const user = await askToDelete()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(within(screen.getByRole('alertdialog')).queryByRole('button', { name: 'Stop waiting' })).toBeNull()
    await act(async () => { vi.advanceTimersByTime(WAY_OUT_AFTER_MS) })
    const out = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop waiting' })
    expect(out).not.toHaveAttribute('aria-disabled')
    await user.click(out)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(statusSays()).toContain('Still waiting for the server: deleting the library Movies.')
    expect(api.deleteLibrary).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete Movies' })).toHaveFocus())
  })

  it('takes the way out on Escape once it is offered', async () => {
    api.deleteLibrary.mockReturnValue(never())
    const user = await askToDelete()
    await act(async () => { vi.advanceTimersByTime(WAY_OUT_AFTER_MS) })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(statusSays()).toContain('Still waiting for the server: deleting the library Movies.')
  })

  it('says in the panel what an answer that lands after the way out did: done', async () => {
    const answer = deferred<void>()
    api.deleteLibrary.mockReturnValue(answer.promise)
    const user = await askToDelete()
    await act(async () => { vi.advanceTimersByTime(WAY_OUT_AFTER_MS) })
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop waiting' }))
    api.listLibraries.mockResolvedValue([])
    await act(async () => { answer.resolve() })
    await waitFor(() => expect(statusSays()).toEqual(['Deleted the library Movies.']))
    expect(api.listLibraries).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('says in the panel what an answer that lands after the way out did: refused', async () => {
    const answer = deferred<void>()
    api.deleteLibrary.mockReturnValue(answer.promise)
    const user = await askToDelete()
    await act(async () => { vi.advanceTimersByTime(WAY_OUT_AFTER_MS) })
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop waiting' }))
    await act(async () => { answer.reject(new APIError(500, 'failed to delete library', {})) })
    const said = await screen.findByRole('alert')
    expect(Array.from(said.querySelectorAll('p')).map(p => p.textContent)).toEqual(['Could not delete Movies just now.', 'The server said: failed to delete library'])
    expect(statusSays()).toEqual([])
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('names the restore’s way out for what it does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    vi.stubGlobal('fetch', (url: RequestInfo | URL) => String(url) === '/api/admin/restore' ? never() : Promise.resolve(new Response('{}', { status: 503 })))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<MemoryRouter><AdminView currentAdminId={1} /></MemoryRouter>)
    await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore database' }))
    await act(async () => { vi.advanceTimersByTime(WAY_OUT_AFTER_MS) })
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close and keep it running' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(statusSays()).toContain('Still waiting for the server: restoring the database from aurora.dump.')
  })
})

describe('a second press while the first is out sends nothing', () => {
  // Each button stays focusable (aria-disabled) and ignores the press.
  const twice = async (user: User, button: HTMLElement) => {
    await user.click(button)
    expect(button).toHaveAttribute('aria-disabled', 'true')
    await user.click(button)
    button.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
  }

  it('on Approve', async () => {
    const user = userEvent.setup()
    api.listPendingApprovals.mockResolvedValue([req(5, 'Dune')])
    api.approveRequest.mockReturnValue(never())
    await openSection(user, 'Requests')
    await twice(user, await screen.findByRole('button', { name: 'Approve Dune' }))
    expect(api.approveRequest).toHaveBeenCalledTimes(1)
  })

  it('on Deny while its own row is out', async () => {
    const user = userEvent.setup()
    api.listPendingApprovals.mockResolvedValue([req(5, 'Dune')])
    api.approveRequest.mockReturnValue(never())
    await openSection(user, 'Requests')
    await user.click(await screen.findByRole('button', { name: 'Approve Dune' }))
    const deny = screen.getByRole('button', { name: 'Deny Dune' })
    expect(deny).toHaveAttribute('aria-disabled', 'true')
    await user.click(deny)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    deny.focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('in the deny dialog, which another row’s answer does not unlock', async () => {
    const user = userEvent.setup()
    api.listPendingApprovals.mockResolvedValue([req(5, 'Dune'), req(6, 'Arrival')])
    const approved = deferred<void>()
    api.approveRequest.mockReturnValue(approved.promise)
    api.denyRequest.mockReturnValue(never())
    await openSection(user, 'Requests')
    await user.click(await screen.findByRole('button', { name: 'Approve Arrival' }))
    await user.click(screen.getByRole('button', { name: 'Deny Dune' }))
    const d = await screen.findByRole('alertdialog')
    await user.click(within(d).getByRole('button', { name: 'Deny request' }))
    expect(api.denyRequest).toHaveBeenCalledTimes(1)
    await act(async () => { approved.resolve() })
    await waitFor(() => expect(api.listPendingApprovals).toHaveBeenCalledTimes(2))
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Denying…' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    await user.click(confirm)
    expect(api.denyRequest).toHaveBeenCalledTimes(1)
  })

  it('on the AI providers’ Save', async () => {
    const user = userEvent.setup()
    api.updateAdminLLM.mockReturnValue(never())
    await openSection(user, 'AI providers')
    await twice(user, await screen.findByRole('button', { name: 'Save' }))
    expect(api.updateAdminLLM).toHaveBeenCalledTimes(1)
  })

  it('on a sign-in provider’s Save', async () => {
    const user = userEvent.setup()
    api.updateAdminOAuth.mockReturnValue(never())
    await openSection(user, 'Sign-in providers')
    await twice(user, await screen.findByRole('button', { name: 'Save Google settings' }))
    expect(api.updateAdminOAuth).toHaveBeenCalledTimes(1)
  })

  it('on a change of type’s check', async () => {
    const user = userEvent.setup()
    api.previewLibraryRetype.mockReturnValue(never() as Promise<RetypePreview>)
    await openSection(user, 'Libraries')
    const change = await screen.findByRole('button', { name: 'Change to TV' })
    await user.click(change)
    const checking = screen.getAllByRole('button', { name: 'Checking…' })
    expect(checking).toHaveLength(2)
    for (const b of checking) { await user.click(b); b.focus(); await user.keyboard('{Enter}') }
    expect(api.previewLibraryRetype).toHaveBeenCalledTimes(1)
  })

  it('on a user’s menu while a change from it is out', async () => {
    const user = userEvent.setup()
    api.updateUserRole.mockReturnValue(never())
    await openSection(user, 'Users')
    const trigger = await screen.findByRole('button', { name: 'Actions for priya' })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Remove admin' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove admin' }))
    expect(api.updateUserRole).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    // The dialog is up; the menu's button behind it does not open the menu.
    trigger.click()
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('a second question of a kind while one is out', () => {
  // The first was left by its way out; the second's opener ignores the press
  // and is described by the line that says what is still out.
  const LIB2: Library = { ...LIB, id: 2, name: 'Shows' }
  const stream = (id: string, file: string) => ({ id, kind: 'transcode', user_id: 2, username: 'priya', file_name: file, started_at: new Date().toISOString() } as unknown as ActiveStreamRow)
  const room = (id: number, name: string): Room => ({ id, code: `R${id}`, name, owner_user_id: 1, created_at: '' })
  it.each([
    ['delete a library', 'Libraries', 'Delete Movies', 'Delete library', 'Delete Shows', 'deleting the library Movies',
      () => { api.listLibraries.mockResolvedValue([LIB, LIB2]); api.deleteLibrary.mockReturnValue(never()) }, () => api.deleteLibrary],
    ['delete a room', 'Rooms', 'Delete Den', 'Delete room', 'Delete Loft', 'deleting the room Den',
      () => { api.listRooms.mockResolvedValue([room(1, 'Den'), room(2, 'Loft')]); api.deleteRoom.mockReturnValue(never()) }, () => api.deleteRoom],
    ['stop a stream', 'Active streams', 'Stop the stream of a.mkv', 'Stop stream', 'Stop the stream of b.mkv', 'stopping the stream of a.mkv',
      () => { api.listAdminSessions.mockResolvedValue([stream('a', 'a.mkv'), stream('b', 'b.mkv')]); api.deleteStreamSession.mockReturnValue(never()) }, () => api.deleteStreamSession],
    ['deny a request', 'Requests', 'Deny Dune', 'Deny request', 'Deny Arrival', 'denying the request for Dune',
      () => { api.listPendingApprovals.mockResolvedValue([req(5, 'Dune'), req(6, 'Arrival')]); api.denyRequest.mockReturnValue(never()) }, () => api.denyRequest],
  ])('%s', async (_what, section, first, confirm, second, waitingFor, prepare, sent) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    prepare()
    await openSection(user, section)
    await user.click(await screen.findByRole('button', { name: first }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: confirm }))
    await act(async () => { vi.advanceTimersByTime(WAY_OUT_AFTER_MS) })
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop waiting' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const opener = screen.getByRole('button', { name: second })
    expect(opener).toHaveAttribute('aria-disabled', 'true')
    expect(opener).toHaveAccessibleDescription(`Still waiting for the server: ${waitingFor}.`)
    await user.click(opener)
    opener.focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(sent()).toHaveBeenCalledTimes(1)
  })
})

describe('a restore left by its way out', () => {
  async function leaveRestore(answer: Promise<Response>) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    vi.stubGlobal('fetch', (url: RequestInfo | URL) => String(url) === '/api/admin/restore' ? answer : Promise.resolve(new Response('{}', { status: 503 })))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<MemoryRouter><AdminView currentAdminId={1} /></MemoryRouter>)
    await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore database' }))
    await act(async () => { vi.advanceTimersByTime(WAY_OUT_AFTER_MS) })
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close and keep it running' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    return user
  }

  it('says a late refusal once', async () => {
    const answer = deferred<Response>()
    await leaveRestore(answer.promise)
    await act(async () => { answer.resolve(new Response(JSON.stringify({ error: { code: 400, message: 'not a dump' } }), { status: 400, headers: { 'content-type': 'application/json' } })) })
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1))
    expect(screen.getByRole('alert')).toHaveTextContent('The server refused this file, and the database was not changed.')
  })

  it('says a success that lands in the panel after the admin left the section and came back', async () => {
    const answer = deferred<Response>()
    const user = await leaveRestore(answer.promise)
    await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Logs' }))
    await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
    await act(async () => { answer.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })) })
    await waitFor(() => expect(statusSays()).toContain('Restored the database from aurora.dump. Restart Aurora now.'))
    expect(screen.getByRole('region', { name: 'Restart Aurora now' })).toBeInTheDocument()
  })
})
