// @vitest-environment jsdom
//
// A restore runs as a job on the server, in one transaction, and the tab
// follows it by id through GET /api/admin/restore/status. The upload's
// request used to carry the whole restore: a reload, a closed tab or a lost
// connection stopped it part way and could leave the database empty, so the
// page held the browser's leave-this-page check. Now the upload answers 202
// once the job has started, and:
//   - the backup panel follows the job to its outcome, said by what it left;
//   - while the transaction runs the server's session check waits on its
//     locks, so reads get no answer: that is said as the wait it is, never as
//     advice to sign in; a successful restore then ends the session, and the
//     outcome is said after signing in again;
//   - the followed id outlives a reload (sessionStorage), and a page opened
//     while one runs finds it, looking again while the look fails;
//   - the outcome is said wherever the admin is when it lands, to the account
//     that followed it, and only while a session with the admin UI is up.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { SESSION_EXPIRED_EVENT, resetSessionEndedLatch, type RestoreResult, type RestoreRun, type RestoreStatus } from '@/lib/api'

const api = vi.hoisted(() => ({
  getAdminDashboard: vi.fn(), getEmbeddingStatus: vi.fn(), getSkipMarkerStatus: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

import AdminView from './AdminView'
import { RestoreOutcomeAlert } from './RestoreOutcomeAlert'
import {
  NO_ANSWER, NO_RECORD, REPLACING, forgetRestoreMemoryForTest, resetRestoreOutcomeForTest,
  setRestorePollForTest, setRestoreReadLimitsForTest,
} from './restoreOutcome'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const run = (id: string, phase: RestoreRun['phase'], file = 'aurora.dump'): RestoreRun => ({ id, file, phase, started_at: '2026-11-13T10:00:00Z' })
const ended = (id: string, r: Partial<RestoreResult>): RestoreResult => ({
  id, file: 'aurora.dump', started_at: '2026-11-13T10:00:00Z', ended_at: '2026-11-13T10:05:00Z',
  succeeded: true, phase: 'replacing', database: 'restored', message: 'Restore complete.', ...r,
})

let answerUpload: (r: Response | Error) => void
/** What the status route answers now: a status, a refusal, no answer at all,
 *  or 'hang': nothing until the read is given up (the server's session check
 *  waiting on the restore's locks). */
let status: RestoreStatus | Response | Error | 'hang'
let statusReads = 0
/** What a session refresh answers (a 401 makes the app's session end). */
let refresh: () => Response

beforeEach(() => {
  resetRestoreOutcomeForTest()
  resetSessionEndedLatch()
  setRestorePollForTest(15)
  setRestoreReadLimitsForTest(40, 150)
  statusReads = 0
  status = { running: null, last: null }
  refresh = () => json(503, { error: 'unavailable' })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    if (u === '/api/admin/restore') {
      return new Promise<Response>((resolve, reject) => { answerUpload = r => (r instanceof Error ? reject(r) : resolve(r)) })
    }
    if (u === '/api/admin/restore/status') {
      statusReads++
      if (status === 'hang') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      if (status instanceof Error) return Promise.reject(status)
      if (status instanceof Response) return Promise.resolve(status.clone())
      return Promise.resolve(json(200, status))
    }
    if (u === '/api/auth/refresh') return Promise.resolve(refresh())
    return Promise.resolve(json(503, { error: 'unavailable' }))
  }))
  for (const fn of Object.values(api)) fn.mockReset().mockRejectedValue(new Error('off'))
})
afterEach(() => {
  resetRestoreOutcomeForTest()
  resetSessionEndedLatch()
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
async function startRestore(user: ReturnType<typeof userEvent.setup>, account = 1) {
  const view = render(<Harness page adminUI account={account} />)
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
  it('through what really happens: no answer while the data is replaced, signed out at the commit, the outcome after signing in', async () => {
    const user = userEvent.setup()
    const expired = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    try {
      const view = await startRestore(user)
      await accepted()
      expect(progress()).toHaveTextContent('Restoring the database from aurora.dump: checking the file. It runs on the server, and goes on if this tab is closed.')
      // Said before it happens: a success signs everyone out.
      expect(progress()).toHaveTextContent('When it succeeds everyone is signed out, you included: sign in again to see that it finished, before restarting Aurora.')
      expect(screen.getByRole('button', { name: 'Restore database' })).toBeDisabled()

      // The transaction holds its locks: the session check waits, and so
      // does the read. The page says what that is, and nothing about
      // signing in.
      status = 'hang'
      await waitFor(() => expect(progress()).toHaveTextContent(REPLACING))
      const reads = statusReads
      await waitFor(() => expect(statusReads).toBeGreaterThan(reads + 1))
      expect(progress()).toHaveTextContent(REPLACING)
      // A read that the server's check gave up on (401 "token revoked",
      // with the refresh also waiting) is the same wait.
      status = json(401, { error: { code: 401, message: 'token revoked' } })
      await waitFor(() => expect(progress()).toHaveTextContent('The server said: token revoked'))
      expect(progress()).toHaveTextContent(REPLACING)
      expect(document.body.textContent).not.toMatch(/sign in again\. |may need to sign in/i)
      expect(screen.queryByRole('alert')).toBeNull()

      // The restore commits: the backup holds no sessions, so the session
      // ends and the app signs out.
      status = json(401, { error: { code: 401, reason: 'session_ended', message: 'this session has ended; sign in again' } })
      refresh = () => json(401, { error: { code: 401, message: 'invalid or expired refresh token' } })
      await waitFor(() => expect(expired).toHaveBeenCalled())
      view.rerender(<Harness page={false} adminUI={false} />)
      status = { running: null, last: ended('j1', {}) }
      const reads2 = statusReads
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(statusReads).toBe(reads2)

      // Signed in again (the backup's account): the outcome.
      resetSessionEndedLatch()
      view.rerender(<Harness page={false} adminUI />)
      expect(await screen.findByRole('alertdialog', { name: 'Restart Aurora now' })).toHaveTextContent('The database has been restored from aurora.dump.')
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expired)
    }
  })

  it('says each step the server reports, then the outcome', async () => {
    const user = userEvent.setup()
    await startRestore(user)
    await accepted()
    status = { running: run('j1', 'replacing'), last: null }
    await waitFor(() => expect(progress()).toHaveTextContent('Restoring the database from aurora.dump: replacing the data.'))
    status = { running: null, last: ended('j1', {}) }
    const notice = await screen.findByRole('region', { name: 'Restart Aurora now' })
    expect(notice).toHaveTextContent('The database has been restored from aurora.dump.')
    expect(progress()).toBeNull()
    // Said by the panel, so not by the alert as well.
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it.each([
    ['refused in its check', { succeeded: false, phase: 'validating', database: 'unchanged', message: 'upload is not a complete, readable pg_dump custom archive — the database was NOT modified', stderr: 'pg_restore: error: could not read input file' },
      'The restore did not start changing anything, so the database is as it was. Read what the server said before trying again.',
      'The server said: upload is not a complete, readable pg_dump custom archive — the database was NOT modified: pg_restore: error: could not read input file'],
    ['that failed in its transaction', { succeeded: false, phase: 'replacing', database: 'unchanged', message: 'the restore failed and its transaction was rolled back — the database was NOT modified: psql: exit status 3', stderr: 'ERROR:  canceling statement due to lock timeout' },
      'The restore failed and everything it had done was undone, so the database is as it was. Read what the server said before trying again.',
      'The server said: the restore failed and its transaction was rolled back — the database was NOT modified: psql: exit status 3: ERROR: canceling statement due to lock timeout'],
    ['stopped by a server restart', { succeeded: false, phase: 'replacing', database: 'unchanged', stopped: 'shutdown', message: 'the server stopped the restore because it was shutting down' },
      'The server was stopped or restarted while the restore ran. Everything the restore had done was undone, so the database is as it was. Read what the server said before trying again.',
      'The server said: the server stopped the restore because it was shutting down'],
    ['whose commit could not be confirmed', { succeeded: false, phase: 'replacing', database: 'unknown', message: 'psql was cut off after it sent the COMMIT' },
      'The connection to the database was lost as the restore was committing, so it is not known whether it took effect: the database holds either what it held before or the backup, never a mix. Check which before going on.',
      'The server said: psql was cut off after it sent the COMMIT'],
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

  it('says a success signs everyone out before it is asked for', async () => {
    const user = userEvent.setup()
    const view = render(<Harness page adminUI />)
    await openBackup(user)
    await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleDescription(/When the restore succeeds everyone is signed out, you included, since a backup holds no sessions: sign in again to see that it finished, then restart Aurora\./)
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(/if it fails, or the server is restarted or updated before it ends, nothing is changed and it has to be run again\./)
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

describe('a restore followed across a reload', () => {
  it('is followed again after the page is reloaded, and its outcome said', async () => {
    const user = userEvent.setup()
    const view = await startRestore(user)
    await accepted()
    view.unmount()
    // The reload: the page's memory goes, the tab's sessionStorage stays.
    forgetRestoreMemoryForTest()
    status = { running: null, last: ended('j1', {}) }
    render(<Harness page={false} adminUI />)
    expect(await screen.findByRole('alertdialog', { name: 'Restart Aurora now' })).toBeInTheDocument()
  })

  it('shows it running in the panel after a reload, while it runs', async () => {
    const user = userEvent.setup()
    const view = await startRestore(user)
    await accepted()
    view.unmount()
    forgetRestoreMemoryForTest()
    status = 'hang'
    render(<Harness page adminUI />)
    await openBackup(user)
    await waitFor(() => expect(progress()).toHaveTextContent('Restoring the database from aurora.dump'))
    await waitFor(() => expect(progress()).toHaveTextContent(REPLACING))
    expect(screen.getByRole('button', { name: 'Restore database' })).toBeDisabled()
  })
})

describe('a page opened while a restore runs', () => {
  it('finds it and follows it to the end', async () => {
    const user = userEvent.setup()
    status = { running: run('j7', 'replacing', 'nightly.dump'), last: null }
    render(<Harness page adminUI />)
    await openBackup(user)
    await waitFor(() => expect(progress()).toHaveTextContent('Restoring the database from nightly.dump: replacing the data.'))
    // No second restore is offered while it runs.
    expect(screen.getByRole('button', { name: 'Restore database' })).toBeDisabled()
    status = { running: null, last: ended('j7', { file: 'nightly.dump' }) }
    expect(await screen.findByRole('region', { name: 'Restart Aurora now' })).toHaveTextContent('The database has been restored from nightly.dump.')
  })

  it('finds it from anywhere in the app, and says the outcome there', async () => {
    status = { running: run('j8', 'validating'), last: null }
    render(<Harness page={false} adminUI />)
    await waitFor(() => expect(statusReads).toBeGreaterThan(1))
    status = { running: null, last: ended('j8', {}) }
    expect(await screen.findByRole('alertdialog', { name: 'Restart Aurora now' })).toBeInTheDocument()
  })

  it('says it could not check, rather than that none runs, and looks again until it can', async () => {
    const user = userEvent.setup()
    setRestorePollForTest(15, 30)
    status = json(500, { error: { code: 500, message: 'failed to check the session' } })
    render(<Harness page adminUI />)
    await openBackup(user)
    expect(await screen.findByText('Could not check whether a restore is running just now. A restore may be running on the server.')).toBeInTheDocument()
    expect(screen.getByText('The server said: failed to check the session')).toBeInTheDocument()
    status = { running: run('j9', 'validating'), last: null }
    await waitFor(() => expect(progress()).toHaveTextContent('Restoring the database from aurora.dump: checking the file.'))
    expect(screen.queryByText(/Could not check whether a restore is running/)).toBeNull()
  })
})

describe('a status that cannot be read', () => {
  it('says no answer at all as that, and keeps looking until it can say how the restore ended', async () => {
    const user = userEvent.setup()
    await startRestore(user)
    await accepted()
    status = new TypeError('Failed to fetch')
    await waitFor(() => expect(progress()).toHaveTextContent(NO_ANSWER))
    status = json(504, { error: 'gateway timeout' })
    await waitFor(() => expect(progress()).toHaveTextContent(REPLACING))
    // Not an outcome: nothing says it failed or finished.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Restart Aurora now' })).toBeNull()
    status = { running: null, last: ended('j1', {}) }
    expect(await screen.findByRole('region', { name: 'Restart Aurora now' })).toBeInTheDocument()
    expect(progress()).toBeNull()
  })

  it('says a refusal that is not the wait as the refusal it is', async () => {
    const user = userEvent.setup()
    await startRestore(user)
    await accepted()
    status = json(400, { error: { code: 400, message: 'bad request' } })
    await waitFor(() => expect(progress()).toHaveTextContent('Could not read how the restore is going. The restore may still be running on the server.'))
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

  it('says a restore that failed, with the server’s words after the page’s', async () => {
    const user = userEvent.setup()
    await restoreThenLeave(user)
    status = { running: null, last: ended('j1', { succeeded: false, phase: 'replacing', database: 'unchanged', message: 'the restore failed and its transaction was rolled back' }) }
    const said = await screen.findByRole('alertdialog', { name: 'The restore from aurora.dump did not go through' })
    expect(said).toHaveTextContent('The restore failed and everything it had done was undone, so the database is as it was.')
    expect(said).toHaveTextContent('The server said: the restore failed and its transaction was rolled back')
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

  it('is still followed when another account in the tab has an upload refused', async () => {
    const user = userEvent.setup()
    const view = await restoreThenLeave(user)
    // Account 2 signs in on the tab and tries a restore of its own: refused
    // (one is running). Account 1's restore is still followed.
    view.rerender(<Harness page adminUI account={2} />)
    await openBackup(user)
    await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['y'], 'other.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    const d = await screen.findByRole('alertdialog')
    await user.click(within(d).getByRole('button', { name: 'Restore database' }))
    answerUpload(json(409, { error: { code: 409, message: 'another backup or restore is already in progress' } }))
    expect(await within(d).findByRole('alert')).toHaveTextContent('A backup or restore is already running, so this one did not start.')
    // The restore ends before account 1 is back: only the kept follow can
    // say it (a look for a running one finds none).
    status = { running: null, last: ended('j1', {}) }
    view.rerender(<Harness page={false} adminUI account={1} />)
    expect(await screen.findByRole('alertdialog', { name: 'Restart Aurora now' })).toBeInTheDocument()
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
    status = { running: run('j5', 'validating'), last: null }
    answerUpload(new TypeError('Failed to fetch'))
    const d = await screen.findByRole('alertdialog')
    expect(await within(d).findByRole('alert')).toHaveTextContent('No answer came back from the server while the file was sent, so it is not known whether the restore started.')
    await waitFor(() => expect(statusReads).toBeGreaterThan(reads))
    await user.click(within(d).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(progress()).toHaveTextContent('Restoring the database from aurora.dump: checking the file.'))
    // The look found it running: it is followed, not said to have failed.
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
