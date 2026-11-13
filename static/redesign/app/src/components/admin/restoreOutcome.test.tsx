// @vitest-environment jsdom
//
// A restore's outcome is said wherever the admin is when it lands. The
// upload runs for minutes; the browser's Back or a profile switch made in
// another tab takes the Admin page away meanwhile, and its answer used to be
// lost with it: no "Restart Aurora now", and after a restore that wiped the
// database and then failed, only a line in the console.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'

const api = vi.hoisted(() => ({
  getAdminDashboard: vi.fn(), getEmbeddingStatus: vi.fn(), getSkipMarkerStatus: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

import AdminView from './AdminView'
import { RestoreOutcomeAlert } from './RestoreOutcomeAlert'
import { resetRestoreOutcomeForTest } from './restoreOutcome'
import { resetRestoreRecordForTest } from '@/hooks/useRestoreRecord'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let answerRestore: (r: Response | Error) => void

beforeEach(() => {
  // A restore's ticket is kept in localStorage, which outlives a test.
  localStorage.clear()
  resetRestoreRecordForTest()
  resetRestoreOutcomeForTest()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => {
    if (String(url) === '/api/admin/restore') {
      return new Promise<Response>((resolve, reject) => { answerRestore = r => (r instanceof Error ? reject(r) : resolve(r)) })
    }
    return Promise.resolve(json(503, { error: 'unavailable' }))
  }))
  for (const fn of Object.values(api)) fn.mockReset().mockRejectedValue(new Error('off'))
})
afterEach(() => vi.unstubAllGlobals())

/** App as far as this goes: the Admin page while the view is admin, and the
 *  alert while the session has the admin UI. */
function Harness({ page, adminUI, account = 1 }: { page: boolean; adminUI: boolean; account?: number }) {
  return (
    <MemoryRouter>
      {page && <AdminView currentAdminId={account} />}
      {adminUI && <RestoreOutcomeAlert accountId={account} />}
    </MemoryRouter>
  )
}

/** Starts a restore and leaves the Admin page while it is out. */
async function restoreThenLeave(user: ReturnType<typeof userEvent.setup>) {
  const view = render(<Harness page adminUI />)
  await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
  await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
  await user.click(screen.getByRole('button', { name: 'Restore database' }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore database' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/restore', expect.anything()))
  // The browser's Back: App leaves /admin, and the page unmounts.
  view.rerender(<Harness page={false} adminUI />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  return view
}

describe('a restore that ends after the Admin page has gone', () => {
  it('says to restart, once, wherever the admin is', async () => {
    const user = userEvent.setup()
    const view = await restoreThenLeave(user)
    answerRestore(json(200, { status: 'ok' }))
    const said = await screen.findByRole('alertdialog', { name: 'Restart Aurora now' })
    expect(said).toHaveTextContent('The database has been restored from aurora.dump.')
    // The focus goes into it, onto its one answer.
    await waitFor(() => expect(within(said).getByRole('button', { name: 'OK' })).toHaveFocus())
    await user.click(within(said).getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    view.rerender(<Harness page={false} adminUI={false} />)
    view.rerender(<Harness page={false} adminUI />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('says a restore that failed after the database was cleared, with the server’s words after the page’s', async () => {
    const user = userEvent.setup()
    await restoreThenLeave(user)
    answerRestore(json(500, { error: { code: 500, message: 'restore failed; database is in wiped state' } }))
    const said = await screen.findByRole('alertdialog', { name: 'The restore from aurora.dump did not go through' })
    expect(said).toHaveTextContent('The restore did not finish. Depending on where it stopped, the database is either as it was or empty.')
    expect(said).toHaveTextContent('The server said: restore failed; database is in wiped state')
  })

  it('says a restore that got no answer may have done anything', async () => {
    const user = userEvent.setup()
    await restoreThenLeave(user)
    answerRestore(new TypeError('Failed to fetch'))
    const said = await screen.findByRole('alertdialog', { name: 'The restore from aurora.dump did not go through' })
    expect(said).toHaveTextContent('If the upload had finished, the restore goes on on the server without this page')
  })

  it('shows nothing to a session without the admin UI, and says it when the admin UI is back', async () => {
    const user = userEvent.setup()
    const view = await restoreThenLeave(user)
    // A switch to a profile with a limit.
    view.rerender(<Harness page={false} adminUI={false} />)
    answerRestore(json(200, { status: 'ok' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.body).not.toHaveTextContent('Restart Aurora')
    view.rerender(<Harness page={false} adminUI />)
    expect(await screen.findByRole('alertdialog', { name: 'Restart Aurora now' })).toBeInTheDocument()
  })

  it('is not said to another account', async () => {
    const user = userEvent.setup()
    const view = await restoreThenLeave(user)
    view.rerender(<Harness page={false} adminUI={false} />)
    answerRestore(json(200, { status: 'ok' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    view.rerender(<Harness page={false} adminUI account={2} />)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('is said by the backup panel, not by the alert, when the panel is up', async () => {
    const user = userEvent.setup()
    const view = await restoreThenLeave(user)
    view.rerender(<Harness page adminUI />)
    await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
    answerRestore(json(200, { status: 'ok' }))
    expect(await screen.findByRole('region', { name: 'Restart Aurora now' })).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('a restore that outlives its page', () => {
  // The browser's own leave-this-page check: a cancelled beforeunload. The
  // restore no longer depends on the page, so nothing asks for it.
  const leavingIsChecked = () => {
    const e = new Event('beforeunload', { cancelable: true })
    Object.defineProperty(e, 'returnValue', { value: undefined, writable: true })
    const cancel = vi.spyOn(e, 'preventDefault')
    window.dispatchEvent(e)
    return cancel.mock.calls.length > 0 || (e as unknown as { returnValue: unknown }).returnValue === true
  }
  const kept = () => JSON.parse(localStorage.getItem('aurora.restore') ?? 'null') as { ticket: string; file: string; seen: string | null } | null
  /** Answers the status reads: the ticket read by `ticket`, the admin read
   *  by `admin`, the upload as `answerRestore` decides. */
  function serve({ ticket, admin }: { ticket?: () => Response; admin?: () => Response }) {
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => {
      const u = String(url)
      if (u === '/api/admin/restore') return new Promise<Response>((resolve, reject) => { answerRestore = r => (r instanceof Error ? reject(r) : resolve(r)) })
      if (u === '/api/restore/status' && ticket) return Promise.resolve(ticket())
      if (u === '/api/admin/restore/status' && admin) return Promise.resolve(admin())
      return Promise.resolve(json(503, { error: 'unavailable' }))
    }))
  }

  it('sends the restore with a ticket it keeps, and holds nothing', async () => {
    const user = userEvent.setup()
    const view = render(<Harness page adminUI />)
    await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
    await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    const d = await screen.findByRole('alertdialog')
    // Said before the admin commits.
    expect(d).toHaveAccessibleDescription(/Once the file is uploaded the restore runs on the server to its end: reloading or closing this tab does not stop it/)
    await user.click(within(d).getByRole('button', { name: 'Restore database' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/restore', expect.anything()))
    const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u) === '/api/admin/restore')!
    const ticket = (call[1]!.headers as Record<string, string>)['X-Aurora-Restore-Ticket']
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // Kept before the answer, so a reload now can still ask about it.
    expect(kept()).toEqual({ ticket, file: 'aurora.dump', seen: null })
    expect(leavingIsChecked()).toBe(false)
    await act(async () => { answerRestore(json(200, { status: 'ok' })) })
    await waitFor(() => expect(kept()?.seen).toBe('succeeded'))
  })

  it('shows a restore still running when the page is opened again, and takes no other', async () => {
    localStorage.setItem('aurora.restore', JSON.stringify({ ticket: 'k'.repeat(43), file: 'big.dump', seen: 'running' }))
    // The record arrives once a file has been chosen, so the button is seen
    // to go from ready to refused.
    let answerRecord!: () => void
    const answered = new Promise<void>(resolve => { answerRecord = resolve })
    serve({ ticket: () => json(200, { state: 'running', step: 'restoring', database: 'empty', file: 'big.dump', started_at: '2026-11-13T15:00:00Z', restart_required: false }) })
    const served = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url) === '/api/restore/status') await answered
      return served(url, init)
    })
    const user = userEvent.setup()
    const view = render(<Harness page adminUI />)
    await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
    await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'other.dump'))
    expect(screen.getByRole('button', { name: 'Restore database' })).toBeEnabled()
    await act(async () => { answerRecord() })
    const note = await screen.findByRole('region', { name: 'A restore is running' })
    expect(note).toHaveTextContent('Aurora is replacing its database with big.dump.')
    expect(within(note).queryByRole('button', { name: /Dismiss/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Restore database' })).toBeDisabled()
    expect(view.container.querySelector<HTMLInputElement>('input[type="file"]')).toBeDisabled()
    // The ticket read carries the ticket, and no session.
    const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u) === '/api/restore/status')!
    expect((call[1]!.headers as Record<string, string>)['X-Aurora-Restore-Ticket']).toBe('k'.repeat(43))
    expect(call[1]!.credentials).toBe('omit')
  })

  it('lets the server’s record say how a restore that got no answer ended', async () => {
    let record: Response = json(503, { error: 'unavailable' })
    serve({ ticket: () => record })
    const user = userEvent.setup()
    const view = render(<Harness page adminUI />)
    await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
    await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    const d = await screen.findByRole('alertdialog')
    await user.click(within(d).getByRole('button', { name: 'Restore database' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/restore', expect.anything()))
    record = json(200, { state: 'failed', step: 'restoring', database: 'empty', file: 'aurora.dump', started_at: '2026-11-13T15:00:00Z', finished_at: '2026-11-13T15:05:00Z', restart_required: false, message: 'restore failed; database is in wiped state' })
    await act(async () => { answerRestore(new TypeError('Failed to fetch')) })
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    const note = await screen.findByRole('region', { name: 'The restore from aurora.dump failed' })
    expect(note).toHaveTextContent('the database is now empty')
    expect(note).toHaveTextContent('The server said: restore failed; database is in wiped state')
    // The panel no longer says it is not known how far it got.
    expect(view.container).not.toHaveTextContent('The connection to the server was lost during the restore')
  })
})
