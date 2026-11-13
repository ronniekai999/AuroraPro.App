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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let answerRestore: (r: Response | Error) => void

beforeEach(() => {
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
    expect(said).toHaveTextContent('it is not known how far it got: the database may be as it was, restored, or empty')
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

describe('while a restore is out', () => {
  // The browser's own leave-this-page check: a cancelled beforeunload.
  // Both halves of the ask, each checked on its own: the cancel (current
  // browsers) and a truthy returnValue (Chrome and Edge before 119). jsdom
  // has no BeforeUnloadEvent, and on its plain Event the legacy setter would
  // cancel by itself, so returnValue is shadowed and the cancel is watched.
  const leavingIsChecked = () => {
    const e = new Event('beforeunload', { cancelable: true })
    Object.defineProperty(e, 'returnValue', { value: undefined, writable: true })
    const cancel = vi.spyOn(e, 'preventDefault')
    window.dispatchEvent(e)
    const cancelled = cancel.mock.calls.length > 0
    const legacy = (e as unknown as { returnValue: unknown }).returnValue === true
    expect(cancelled, 'the cancel and the legacy value go together').toBe(legacy)
    return cancelled
  }
  async function startRestore(user: ReturnType<typeof userEvent.setup>) {
    const view = render(<Harness page adminUI />)
    await user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
    await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    const d = await screen.findByRole('alertdialog')
    // Said before the admin commits: a reload can stop it, not only lose
    // the report of it.
    expect(d).toHaveAccessibleDescription(/Keep this tab open until it says it has finished: reloading or closing it, or losing the connection, stops the restore part way and can leave the database empty\./)
    expect(leavingIsChecked()).toBe(false)
    await user.click(within(d).getByRole('button', { name: 'Restore database' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/restore', expect.anything()))
    return view
  }

  it.each([
    ['it succeeds', () => json(200, { status: 'ok' })],
    ['it is refused', () => json(400, { error: { code: 400, message: 'upload is not a pg_dump custom archive' } })],
    ['it gets no answer', () => new TypeError('Failed to fetch')],
  ])('asks the browser to check before the page is left, until %s', async (_how, answer) => {
    const user = userEvent.setup()
    await startRestore(user)
    expect(leavingIsChecked()).toBe(true)
    await act(async () => { answerRestore(answer()) })
    await waitFor(() => expect(leavingIsChecked()).toBe(false))
  })

  it('keeps the check when the Admin page goes, and drops it when the answer lands', async () => {
    const user = userEvent.setup()
    const view = await startRestore(user)
    view.rerender(<Harness page={false} adminUI />)
    expect(leavingIsChecked()).toBe(true)
    await act(async () => { answerRestore(json(200, { status: 'ok' })) })
    await waitFor(() => expect(leavingIsChecked()).toBe(false))
  })
})
