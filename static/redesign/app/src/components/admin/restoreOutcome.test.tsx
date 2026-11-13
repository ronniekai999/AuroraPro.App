// @vitest-environment jsdom
//
// A restore runs as a job on the server, and the tab follows it through
// GET /api/admin/restore/status. The upload's request used to carry the whole
// restore: a reload, a closed tab or a lost connection stopped it part way and
// could leave the database empty, so the page held the browser's leave-this-
// page check. Now the upload answers 202 once the job has started, and:
//   - the backup panel follows the job's phases to its outcome;
//   - a page opened or reloaded while one runs finds it and follows it;
//   - a status that cannot be read is said as that (the restore may still be
//     running), never as an outcome;
//   - the outcome is said wherever the admin is when it lands, to the account
//     that followed it, and only while a session with the admin UI is up.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import type { RestoreResult, RestoreRun, RestoreStatus } from '@/lib/api'

const api = vi.hoisted(() => ({
  getAdminDashboard: vi.fn(), getEmbeddingStatus: vi.fn(), getSkipMarkerStatus: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

import AdminView from './AdminView'
import { RestoreOutcomeAlert } from './RestoreOutcomeAlert'
import { NO_RECORD, resetRestoreOutcomeForTest, setRestorePollForTest } from './restoreOutcome'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const run = (id: string, phase: RestoreRun['phase'], file = 'aurora.dump'): RestoreRun => ({ id, file, phase, started_at: '2026-11-13T10:00:00Z' })
const ended = (id: string, r: Partial<RestoreResult>): RestoreResult => ({
  id, file: 'aurora.dump', started_at: '2026-11-13T10:00:00Z', ended_at: '2026-11-13T10:05:00Z',
  succeeded: true, phase: 'restoring', database: 'restored', message: 'Restore complete.', ...r,
})

let answerUpload: (r: Response | Error) => void
/** What the status route answers now: a status, a refusal, or no answer. */
let status: RestoreStatus | Response | Error
let statusReads = 0

beforeEach(() => {
  resetRestoreOutcomeForTest()
  setRestorePollForTest(15)
  statusReads = 0
  status = { running: null, last: null }
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => {
    const u = String(url)
    if (u === '/api/admin/restore') {
      return new Promise<Response>((resolve, reject) => { answerUpload = r => (r instanceof Error ? reject(r) : resolve(r)) })
    }
    if (u === '/api/admin/restore/status') {
      statusReads++
      if (status instanceof Error) return Promise.reject(status)
      if (status instanceof Response) return Promise.resolve(status.clone())
      return Promise.resolve(json(200, status))
    }
    // The session refresh a 401 sets off, and everything else: the server is
    // unwell, which ends no session.
    return Promise.resolve(json(503, { error: 'unavailable' }))
  }))
  for (const fn of Object.values(api)) fn.mockReset().mockRejectedValue(new Error('off'))
})
afterEach(() => {
  resetRestoreOutcomeForTest()
  vi.unstubAllGlobals()
})

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

const openBackup = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name: 'Backup and restore' }))
const progress = () => screen.queryByRole('region', { name: 'Restore in progress' })

/** Opens the backup panel, asks for a restore and confirms it. */
async function startRestore(user: ReturnType<typeof userEvent.setup>) {
  const view = render(<Harness page adminUI />)
  await openBackup(user)
  await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
  await user.click(screen.getByRole('button', { name: 'Restore database' }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore database' }))
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/restore', expect.anything()))
  return view
}

/** The server has the file and has started job j1. */
async function accepted() {
  status = { running: run('j1', 'validating'), last: null }
  answerUpload(json(202, { running: run('j1', 'validating'), last: null }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
}

describe('the backup panel follows the restore the server runs', () => {
  it('says each step, then the outcome, from the status', async () => {
    const user = userEvent.setup()
    await startRestore(user)
    await accepted()
    expect(progress()).toHaveTextContent('Restoring the database from aurora.dump: checking the file. It runs on the server, and goes on if this tab is closed.')
    // The button that asked is not offered again while it runs.
    expect(screen.getByRole('button', { name: 'Restore database' })).toBeDisabled()
    status = { running: run('j1', 'wiping'), last: null }
    await waitFor(() => expect(progress()).toHaveTextContent('Restoring the database from aurora.dump: clearing the old data.'))
    status = { running: run('j1', 'restoring'), last: null }
    await waitFor(() => expect(progress()).toHaveTextContent('Restoring the database from aurora.dump: loading the backup.'))
    status = { running: null, last: ended('j1', {}) }
    const notice = await screen.findByRole('region', { name: 'Restart Aurora now' })
    expect(notice).toHaveTextContent('The database has been restored from aurora.dump.')
    expect(progress()).toBeNull()
    // Said by the panel, so not by the alert as well.
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it.each([
    ['refused in its check', { succeeded: false, phase: 'validating', database: 'unchanged', message: 'upload is not a complete, readable pg_dump custom archive', stderr: 'pg_restore: error: could not read input file' },
      'The server refused this file, and the database was not changed.',
      'The server said: upload is not a complete, readable pg_dump custom archive: pg_restore: error: could not read input file'],
    ['stopped while clearing the old data', { succeeded: false, phase: 'wiping', database: 'may_be_empty', message: 'pre-restore wipe failed: exit status 2' },
      'The restore stopped while clearing the old data, so the database may be as it was or empty. Read what the server said before going on.',
      'The server said: pre-restore wipe failed: exit status 2'],
    ['failed after the wipe', { succeeded: false, phase: 'restoring', database: 'may_be_empty', message: 'restore failed (exit status 1); database is in wiped state', stderr: 'pg_restore: error: relation exists' },
      'The restore failed after the old data had been cleared, so the database may now be empty. Read what the server said, then restore again from a backup that works.',
      'The server said: restore failed (exit status 1); database is in wiped state: pg_restore: error: relation exists'],
    ['stopped by a server restart', { succeeded: false, phase: 'restoring', database: 'may_be_empty', stopped: 'shutdown', message: 'the server stopped the restore because it was shutting down' },
      'The server was stopped or restarted while the restore ran. The restore failed after the old data had been cleared, so the database may now be empty. Read what the server said, then restore again from a backup that works.',
      'The server said: the server stopped the restore because it was shutting down'],
  ] as const)('says a restore %s by what it left', async (_what, result, says, server) => {
    const user = userEvent.setup()
    await startRestore(user)
    await accepted()
    status = { running: null, last: ended('j1', result as Partial<RestoreResult>) }
    const alert = await screen.findByRole('alert')
    expect(Array.from(alert.querySelectorAll('p')).map(p => p.textContent)).toEqual([says, server])
    expect(progress()).toBeNull()
  })

  it('says when the server has no record of it (it restarted)', async () => {
    const user = userEvent.setup()
    await startRestore(user)
    await accepted()
    status = { running: null, last: null }
    expect(await screen.findByRole('alert')).toHaveTextContent(NO_RECORD)
  })

  it('no longer holds the browser’s leave-this-page check: closing the tab does not stop it', async () => {
    const user = userEvent.setup()
    await startRestore(user)
    const leaving = () => {
      const e = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(leaving()).toBe(false)
    await accepted()
    expect(leaving()).toBe(false)
  })
})

describe('a page opened while a restore runs', () => {
  it('finds it and follows it to the end', async () => {
    const user = userEvent.setup()
    status = { running: run('j7', 'restoring', 'nightly.dump'), last: null }
    render(<Harness page adminUI />)
    await openBackup(user)
    await waitFor(() => expect(progress()).toHaveTextContent('Restoring the database from nightly.dump: loading the backup.'))
    // No second restore is offered while it runs.
    expect(screen.getByRole('button', { name: 'Restore database' })).toBeDisabled()
    status = { running: null, last: ended('j7', { file: 'nightly.dump' }) }
    expect(await screen.findByRole('region', { name: 'Restart Aurora now' })).toHaveTextContent('The database has been restored from nightly.dump.')
  })

  it('finds it from anywhere in the app, and says the outcome there', async () => {
    status = { running: run('j8', 'wiping'), last: null }
    render(<Harness page={false} adminUI />)
    await waitFor(() => expect(statusReads).toBeGreaterThan(1))
    status = { running: null, last: ended('j8', {}) }
    expect(await screen.findByRole('alertdialog', { name: 'Restart Aurora now' })).toBeInTheDocument()
  })

  it('says it could not check, rather than that none runs, when the status cannot be read', async () => {
    const user = userEvent.setup()
    status = json(500, { error: { code: 500, message: 'failed to check the session' } })
    render(<Harness page adminUI />)
    await openBackup(user)
    expect(await screen.findByText('Could not check whether a restore is running just now. A restore may be running on the server.')).toBeInTheDocument()
    expect(screen.getByText('The server said: failed to check the session')).toBeInTheDocument()
  })
})

describe('a status that cannot be read', () => {
  it('is said as that, and the page keeps looking until it can say how the restore ended', async () => {
    const user = userEvent.setup()
    await startRestore(user)
    await accepted()
    status = { running: run('j1', 'restoring'), last: null }
    await waitFor(() => expect(progress()).toHaveTextContent('loading the backup'))

    // No answer at all.
    status = new TypeError('Failed to fetch')
    await waitFor(() => expect(progress()).toHaveTextContent('No answer came from the server, so it is not known how the restore is going. It goes on running on the server unless the server itself has stopped, and this page looks again.'))

    // Refused, as every admin route is while the database is being replaced:
    // the guards read the session from it.
    status = json(500, { error: { code: 500, message: 'failed to check the session' } })
    await waitFor(() => expect(progress()).toHaveTextContent('While the restore replaces the database, the server cannot check who is signed in'))
    expect(progress()).toHaveTextContent('The server said: failed to check the session')
    status = json(401, { error: { code: 401, message: 'token revoked' } })
    const reads = statusReads
    await waitFor(() => expect(statusReads).toBeGreaterThan(reads + 1))
    expect(progress()).toHaveTextContent('While the restore replaces the database, the server cannot check who is signed in')
    // Not an outcome: nothing says it failed or finished.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Restart Aurora now' })).toBeNull()

    status = { running: null, last: ended('j1', {}) }
    expect(await screen.findByRole('region', { name: 'Restart Aurora now' })).toBeInTheDocument()
    expect(progress()).toBeNull()
  })

  it('before the old data is touched, is said as the refusal it is', async () => {
    const user = userEvent.setup()
    await startRestore(user)
    await accepted()
    status = json(500, { error: { code: 500, message: 'database is down' } })
    await waitFor(() => expect(progress()).toHaveTextContent('Could not read how the restore is going just now. The restore may still be running on the server.'))
  })
})

describe('a restore that ends after the Admin page has gone', () => {
  /** Starts a restore and leaves the Admin page while it runs. */
  async function restoreThenLeave(user: ReturnType<typeof userEvent.setup>) {
    const view = await startRestore(user)
    await accepted()
    // The browser's Back: App leaves /admin, and the page unmounts.
    view.rerender(<Harness page={false} adminUI />)
    expect(progress()).toBeNull()
    return view
  }

  it('says to restart, once, wherever the admin is', async () => {
    const user = userEvent.setup()
    const view = await restoreThenLeave(user)
    status = { running: null, last: ended('j1', {}) }
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
    status = { running: null, last: ended('j1', { succeeded: false, phase: 'restoring', database: 'may_be_empty', message: 'restore failed; database is in wiped state' }) }
    const said = await screen.findByRole('alertdialog', { name: 'The restore from aurora.dump did not go through' })
    expect(said).toHaveTextContent('The restore failed after the old data had been cleared, so the database may now be empty.')
    expect(said).toHaveTextContent('The server said: restore failed; database is in wiped state')
  })

  it('reads nothing while no session with the admin UI is up, and says it when one is back', async () => {
    const user = userEvent.setup()
    const view = await restoreThenLeave(user)
    // A switch to a profile with a limit, or a sign-out: nothing shows the
    // restore, so nothing asks the server about it.
    view.rerender(<Harness page={false} adminUI={false} />)
    await new Promise(resolve => setTimeout(resolve, 60))
    const reads = statusReads
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(statusReads).toBe(reads)
    status = { running: null, last: ended('j1', {}) }
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.body).not.toHaveTextContent('Restart Aurora')
    view.rerender(<Harness page={false} adminUI />)
    expect(await screen.findByRole('alertdialog', { name: 'Restart Aurora now' })).toBeInTheDocument()
  })

  it('is not said to another account', async () => {
    const user = userEvent.setup()
    const view = await restoreThenLeave(user)
    view.rerender(<Harness page={false} adminUI={false} />)
    status = { running: null, last: ended('j1', {}) }
    view.rerender(<Harness page={false} adminUI account={2} />)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('is said by the backup panel, not by the alert, when the panel is up', async () => {
    const user = userEvent.setup()
    const view = await restoreThenLeave(user)
    view.rerender(<Harness page adminUI />)
    await openBackup(user)
    expect(progress()).toHaveTextContent('Restoring the database from aurora.dump')
    status = { running: null, last: ended('j1', {}) }
    expect(await screen.findByRole('region', { name: 'Restart Aurora now' })).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('an upload that got no answer', () => {
  it('says the restore may have started, and looks for it on the server', async () => {
    const user = userEvent.setup()
    await startRestore(user)
    const reads = statusReads
    status = { running: run('j5', 'wiping'), last: null }
    answerUpload(new TypeError('Failed to fetch'))
    const d = await screen.findByRole('alertdialog')
    expect(await within(d).findByRole('alert')).toHaveTextContent('No answer came back from the server while the file was sent, so it is not known whether the restore started.')
    await waitFor(() => expect(statusReads).toBeGreaterThan(reads))
    await user.click(within(d).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(progress()).toHaveTextContent('Restoring the database from aurora.dump: clearing the old data.'))
    // The look found it running: it is followed, not said to have failed.
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
