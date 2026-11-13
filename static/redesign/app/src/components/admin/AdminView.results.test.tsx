// @vitest-environment jsdom
//
// What the admin page says of what came of something, now that it has no
// browser boxes: a result that needs nothing more is said once in its
// panel's status line; one the admin still has to act on (a restart) is a
// notice that stays until it is dismissed; a failure is said beside the
// control that failed, in the page's words first, with the server's own
// text only after them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { APIError, NetworkError, type Library, type LLMSettings, type MediaRequest, type RetypePreview, type ServerMediaItem } from '@/lib/api'
import { adminFailure, NO_ANSWER_WRITE } from './adminFailure'

const api = vi.hoisted(() => ({
  getAdminDashboard: vi.fn(), getEmbeddingStatus: vi.fn(), getSkipMarkerStatus: vi.fn(),
  listLibraries: vi.fn(), getLibraryHealth: vi.fn(), deleteLibrary: vi.fn(), scanLibrary: vi.fn(),
  previewLibraryRetype: vi.fn(), retypeLibrary: vi.fn(), createLibrary: vi.fn(),
  getAllSettings: vi.fn(), purgeImageCache: vi.fn(), updateSettings: vi.fn(),
  listRooms: vi.fn(), createRoom: vi.fn(),
  listPendingApprovals: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(), deleteUser: vi.fn(),
  listAdminUsers: vi.fn(), getAdminReferralSummary: vi.fn(), createInvite: vi.fn(),
  getAdminLLM: vi.fn(), updateAdminLLM: vi.fn(),
  getAdminOAuth: vi.fn(), updateAdminOAuth: vi.fn(),
  listAdminSessions: vi.fn(), deleteStreamSession: vi.fn(), updateUserRole: vi.fn(),
  listFlaggedItems: vi.fn(), getAIRematchStatus: vi.fn(), startAIRematch: vi.fn(), manualMatch: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

import AdminView from './AdminView'
import { resetRestoreOutcomeForTest, setRestorePollForTest } from './restoreOutcome'

type User = ReturnType<typeof userEvent.setup>
const LIB: Library = { id: 1, name: 'Movies', type: 'movie', paths: ['/media/movies'], scan_interval_minutes: 0, owner_id: 1, created_at: '', updated_at: '' }
const REQ = { id: 5, user_id: 2, media_type: 'movie', tmdb_id: 9, title: 'Dune', poster_path: '', overview: '', year: 2021, status: 'pending_approval', quality_1080p: true, quality_4k: false, requested_at: new Date().toISOString() } as MediaRequest
const LLM = { provider: 'local', embed_provider: 'local', ollama_url: '', embed_url: '', api_key_masked: '', has_api_key: false, anthropic_api_key_masked: '', has_anthropic_api_key: false, openai_api_key_masked: '', has_openai_api_key: false, chat_model: '', embed_model: '', debug_log: false, live_debug_log: false, client_loaded: true } as LLMSettings

let fetchAnswer: (url: string) => Promise<Response>
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  // A restore's outcome outlives the page by design: each test starts clean.
  resetRestoreOutcomeForTest()
  // A restore is followed by reading its status: quickly, here.
  setRestorePollForTest(10)
  fetchAnswer = async () => json(503, { error: 'unavailable' })
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => fetchAnswer(String(url))))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  for (const fn of Object.values(api)) fn.mockReset()
  for (const fn of [api.getAdminDashboard, api.getEmbeddingStatus, api.getSkipMarkerStatus, api.getLibraryHealth]) fn.mockRejectedValue(new Error('off'))
  api.listLibraries.mockResolvedValue([LIB])
  api.getAllSettings.mockResolvedValue({})
  api.listRooms.mockResolvedValue([])
  api.listPendingApprovals.mockResolvedValue([REQ])
  api.listAdminUsers.mockResolvedValue([])
  api.listAdminSessions.mockResolvedValue([])
  api.getAdminReferralSummary.mockResolvedValue({ by_source: [], answered: 0, skipped: 0, pending: 0, window_days: 30 })
  api.getAdminLLM.mockResolvedValue(LLM)
  api.getAdminOAuth.mockResolvedValue({ google_enabled: false, google_client_id: '', google_redirect_url: '', google_bypass_invite: false, google_has_secret: false, google_client_secret_masked: '' })
  api.getAIRematchStatus.mockResolvedValue({ enabled: true })
  api.listFlaggedItems.mockResolvedValue([])
})
afterEach(() => { resetRestoreOutcomeForTest(); vi.unstubAllGlobals() })

/** A restore job's status as the server reports it. */
const RUN = { id: 'j1', file: 'aurora.dump', phase: 'validating', started_at: '2026-11-13T10:00:00Z' }
const ENDED = { id: 'j1', file: 'aurora.dump', started_at: '2026-11-13T10:00:00Z', ended_at: '2026-11-13T10:05:00Z', succeeded: true, phase: 'replacing', database: 'restored', message: 'Restore complete.' }

async function openSection(user: User, name: string) {
  const view = render(<MemoryRouter><AdminView currentAdminId={1} /></MemoryRouter>)
  await goTo(user, name)
  return view
}
const goTo = (user: User, name: string) => user.click(within(screen.getByRole('navigation', { name: 'Admin sections' })).getByRole('button', { name }))
const statusSays = () => screen.getAllByRole('status').map(s => s.textContent?.trim()).filter(Boolean)
/** The alert's lines, in order. */
const alertLines = (el: HTMLElement) => Array.from(el.querySelectorAll('p')).map(p => p.textContent)

describe('results said once in their panel', () => {
  it('says a scan started, and nothing blocks', async () => {
    const user = userEvent.setup()
    api.scanLibrary.mockResolvedValue(undefined)
    await openSection(user, 'Libraries')
    await user.click(await screen.findByRole('button', { name: 'Scan Movies' }))
    await waitFor(() => expect(statusSays()).toEqual(['Started a scan of Movies.']))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says what a purge freed', async () => {
    const user = userEvent.setup()
    api.purgeImageCache.mockResolvedValue({ files_purged: 12, bytes_freed: 3 * 1024 * 1024 })
    await openSection(user, 'Server settings')
    await user.click(await screen.findByRole('button', { name: 'Purge image cache' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Purge image cache' }))
    await waitFor(() => expect(statusSays()).toEqual(['Purged 12 files (3.0 MB freed).']))
  })

  it('says what a change of type deleted', async () => {
    const user = userEvent.setup()
    api.previewLibraryRetype.mockResolvedValue({ library_id: 1, library_name: 'Movies', current_type: 'movie', target_type: 'show', items_to_delete: 3, items_kept: 0 } as RetypePreview)
    api.retypeLibrary.mockResolvedValue({ items_deleted: 3 })
    await openSection(user, 'Libraries')
    await user.click(await screen.findByRole('button', { name: 'Change to TV' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete and rescan' }))
    await waitFor(() => expect(statusSays()).toEqual(['Deleted 3 items from Movies and started a rescan.']))
  })

  it('says AI settings saved when nothing waits on a restart, and raises no notice', async () => {
    const user = userEvent.setup()
    api.updateAdminLLM.mockResolvedValue({ ok: true, restart_required: false })
    await openSection(user, 'AI providers')
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(statusSays()).toEqual(['AI provider settings saved.']))
    expect(screen.queryByRole('region', { name: /Restart Aurora/ })).toBeNull()
  })

  it('says sign-in settings saved', async () => {
    const user = userEvent.setup()
    api.updateAdminOAuth.mockResolvedValue({})
    await openSection(user, 'Sign-in providers')
    await user.click(await screen.findByRole('button', { name: 'Save Google settings' }))
    await waitFor(() => expect(statusSays()).toContain('Google sign-in settings saved.'))
  })
})

describe('what the admin still has to do', () => {
  it('keeps the restart notice after a restore, across the page’s sections, until it is dismissed', async () => {
    const user = userEvent.setup()
    let started = false
    fetchAnswer = async url => {
      if (url === '/api/admin/restore') { started = true; return json(202, { running: RUN, last: null }) }
      if (url === '/api/admin/restore/status') return json(200, started ? { running: null, last: ENDED } : { running: null, last: null })
      return json(503, { error: 'unavailable' })
    }
    const view = await openSection(user, 'Backup and restore')
    await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restore database' }))
    const notice = await screen.findByRole('region', { name: 'Restart Aurora now' })
    expect(notice).toHaveTextContent('The database has been restored from aurora.dump.')
    await goTo(user, 'Users')
    expect(screen.queryByRole('region', { name: 'Restart Aurora now' })).toBeNull()
    await goTo(user, 'Backup and restore')
    const again = screen.getByRole('region', { name: 'Restart Aurora now' })
    await user.click(within(again).getByRole('button', { name: /Dismiss/ }))
    expect(screen.queryByRole('region', { name: 'Restart Aurora now' })).toBeNull()
  })

  it('keeps the AI settings’ restart notice across sections until it is dismissed', async () => {
    const user = userEvent.setup()
    api.updateAdminLLM.mockResolvedValue({ ok: true, restart_required: true })
    await openSection(user, 'AI providers')
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('region', { name: 'Restart Aurora to use the new AI settings' })).toBeInTheDocument()
    // The notice is not read out by itself: the status line says it too.
    expect(statusSays()).toEqual(['Saved. Restart Aurora to apply these settings.'])
    await goTo(user, 'Logs')
    await goTo(user, 'AI providers')
    const notice = await screen.findByRole('region', { name: 'Restart Aurora to use the new AI settings' })
    await user.click(within(notice).getByRole('button', { name: /Dismiss/ }))
    expect(screen.queryByRole('region', { name: /Restart Aurora/ })).toBeNull()
  })

  it('does not call a save that landed a failed save when only the read back fails', async () => {
    const user = userEvent.setup()
    api.updateAdminLLM.mockResolvedValue({ ok: true, restart_required: true })
    await openSection(user, 'AI providers')
    await screen.findByRole('button', { name: 'Save' })
    api.getAdminLLM.mockRejectedValueOnce(new APIError(500, 'failed to read settings', {}))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const said = await screen.findByRole('alert')
    expect(alertLines(said)).toEqual(['Saved. The settings could not be read back: reload to see them.', 'The server said: failed to read settings'])
    expect(screen.getByRole('region', { name: 'Restart Aurora to use the new AI settings' })).toBeInTheDocument()
  })
})

describe('failures said beside what failed', () => {
  it('says a scan that is already running beside its row, the server’s words after the page’s', async () => {
    const user = userEvent.setup()
    api.scanLibrary.mockRejectedValue(new APIError(409, 'scan already in progress', {}))
    await openSection(user, 'Libraries')
    await user.click(await screen.findByRole('button', { name: 'Scan Movies' }))
    expect(alertLines(await screen.findByRole('alert'))).toEqual(['A scan of Movies is already running.', 'The server said: scan already in progress'])
    expect(statusSays()).toEqual([])
  })

  it('says a library the server refused, beside Add', async () => {
    const user = userEvent.setup()
    api.createLibrary.mockRejectedValue(new APIError(400, 'path does not exist: /nope', {}))
    await openSection(user, 'Libraries')
    await user.type(screen.getByRole('textbox', { name: 'Library name' }), 'Films')
    await user.type(screen.getByRole('textbox', { name: 'Folders on the server, separated by commas' }), '/nope')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(alertLines(await screen.findByRole('alert'))).toEqual(['The server refused this library.', 'The server said: path does not exist: /nope'])
  })

  it('says a check of a change of type that could not be made, beside its buttons', async () => {
    const user = userEvent.setup()
    api.previewLibraryRetype.mockRejectedValue(new APIError(500, 'failed to preview retype', {}))
    await openSection(user, 'Libraries')
    await user.click(await screen.findByRole('button', { name: 'Change to TV' }))
    expect(alertLines(await screen.findByRole('alert'))).toEqual(['Could not check what changing Movies would delete just now.', 'The server said: failed to preview retype'])
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.retypeLibrary).not.toHaveBeenCalled()
  })

  it('shows the counts the check returned in the question it asks', async () => {
    const user = userEvent.setup()
    api.previewLibraryRetype.mockResolvedValue({
      library_id: 1, library_name: 'Movies', current_type: 'movie', target_type: 'show', items_to_delete: 3, items_kept: 2,
      casualties: [{ table: 'watch_progress', rows: 7, why: 'what people have watched' }, { table: 'user_ratings', rows: 4 }],
    } as RetypePreview)
    await openSection(user, 'Libraries')
    await user.click(await screen.findByRole('button', { name: 'Change to TV' }))
    const d = await screen.findByRole('alertdialog', { name: 'Change Movies to TV shows?' })
    expect(d).toHaveAccessibleDescription(/This deletes 3 catalog items and everything attached to them, then rescans from disk\. 2 items already of the target type are kept\./)
    const lost = within(d).getByRole('list', { name: 'What is deleted' })
    expect(within(lost).getAllByRole('listitem').map(li => li.textContent)).toEqual(['7 × watch_progress — what people have watched', '4 × user_ratings'])
  })

  it('says an approve the server refused beside its row', async () => {
    const user = userEvent.setup()
    api.approveRequest.mockRejectedValue(new APIError(500, 'failed to dispatch request', {}))
    await openSection(user, 'Requests')
    await user.click(await screen.findByRole('button', { name: 'Approve Dune' }))
    expect(alertLines(await screen.findByRole('alert'))).toEqual(['Could not approve the request for Dune just now.', 'The server said: failed to dispatch request'])
  })

  it('says an AI save the server refused beside Save', async () => {
    const user = userEvent.setup()
    api.updateAdminLLM.mockRejectedValue(new APIError(400, 'anthropic needs an API key', {}))
    await openSection(user, 'AI providers')
    await user.click(await screen.findByRole('button', { name: 'Save' }))
    expect(alertLines(await screen.findByRole('alert'))).toEqual(['The server refused these settings.', 'The server said: anthropic needs an API key'])
    expect(screen.queryByRole('region', { name: /Restart Aurora/ })).toBeNull()
  })

  it('says a sign-in save that got no answer without claiming it did not happen', async () => {
    const user = userEvent.setup()
    api.updateAdminOAuth.mockRejectedValue(new NetworkError('Failed to fetch'))
    await openSection(user, 'Sign-in providers')
    await user.click(await screen.findByRole('button', { name: 'Save Google settings' }))
    // The section's referral panels have alerts of their own.
    const said = (await screen.findByText(/^No answer came back/)).closest<HTMLElement>('[role="alert"]')!
    expect(alertLines(said)).toEqual([NO_ANSWER_WRITE])
  })

  it('says an invite that could not be made beside its button, with no server line for a bare status', async () => {
    const user = userEvent.setup()
    api.createInvite.mockRejectedValue(new APIError(500, 'HTTP 500', null))
    await openSection(user, 'Users')
    await user.click(await screen.findByRole('button', { name: 'Generate invite code' }))
    expect(alertLines(await screen.findByRole('alert'))).toEqual(['Could not make an invite code just now.'])
  })

  it('says an invite was made', async () => {
    const user = userEvent.setup()
    api.createInvite.mockResolvedValue({ code: 'ABCD-1234' })
    await openSection(user, 'Users')
    await user.click(await screen.findByRole('button', { name: 'Generate invite code' }))
    await waitFor(() => expect(statusSays()).toEqual(['A new invite code is ready below.']))
  })

  it('says a backup that could not be downloaded beside its button', async () => {
    const user = userEvent.setup()
    fetchAnswer = async url => url === '/api/admin/backup'
      ? json(409, { error: { code: 409, message: 'another backup or restore is already in progress' } })
      : json(503, { error: 'unavailable' })
    await openSection(user, 'Backup and restore')
    await user.click(screen.getByRole('button', { name: 'Download backup' }))
    expect(alertLines(await screen.findByRole('alert'))).toEqual(['A backup or restore is already running. Try again when it has finished.', 'The server said: another backup or restore is already in progress'])
  })

  it('says a restore that failed, and that the database is as it was, beside the button that asked', async () => {
    const user = userEvent.setup()
    // The upload is taken (202); the job then fails, as its status says.
    let started = false
    fetchAnswer = async url => {
      if (url === '/api/admin/restore') { started = true; return json(202, { running: RUN, last: null }) }
      if (url === '/api/admin/restore/status') {
        return json(200, started
          ? { running: null, last: { ...ENDED, succeeded: false, database: 'unchanged', message: 'the restore failed and its transaction was rolled back' } }
          : { running: null, last: null })
      }
      return json(503, { error: 'unavailable' })
    }
    const view = await openSection(user, 'Backup and restore')
    await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    const d = await screen.findByRole('alertdialog')
    await user.click(within(d).getByRole('button', { name: 'Restore database' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const said = 'The restore failed and everything it had done was undone, so the database is as it was. Read what the server said before trying again.'
    expect(alertLines(await screen.findByRole('alert'))).toEqual([said, 'The server said: the restore failed and its transaction was rolled back'])
  })

  it('says a sweep that did not start, and a suggestion that could not be accepted, beside each', async () => {
    const user = userEvent.setup()
    api.listFlaggedItems.mockResolvedValue([{ id: 3, title: 'Kestrel', type: 'movie', library_id: 1, match_status: 'needs_review', file_path: '/m/k.mkv', added_at: '', updated_at: '', ai_suggested_tmdb_id: 77, ai_suggested_title: 'Kestrel', ai_match_confidence: 60 } as ServerMediaItem])
    api.startAIRematch.mockRejectedValue(new APIError(409, 'an AI re-match job is already in progress', {}))
    api.manualMatch.mockRejectedValue(new APIError(500, 'tmdb lookup failed', {}))
    await openSection(user, 'Flagged items')
    await user.click(await screen.findByRole('button', { name: 'Re-match with AI' }))
    expect(alertLines(await screen.findByRole('alert'))).toEqual(['A re-match is already running.', 'The server said: an AI re-match job is already in progress'])
    await user.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
    expect(alertLines(screen.getAllByRole('alert')[1])).toEqual(['Could not accept the suggestion for Kestrel just now.', 'The server said: tmdb lookup failed'])
  })
})

describe('the sign-in settings, saved and read back', () => {
  const google = (id: string) => ({ google_enabled: true, google_client_id: id, google_redirect_url: '', google_bypass_invite: false, google_has_secret: true, google_client_secret_masked: '••••' })
  it('stores what the server holds after a save, not its acknowledgement', async () => {
    const user = userEvent.setup()
    api.getAdminOAuth.mockResolvedValueOnce(google('old-id')).mockResolvedValue(google('stored-id'))
    api.updateAdminOAuth.mockResolvedValue({ ok: true })
    await openSection(user, 'Sign-in providers')
    const field = await screen.findByDisplayValue('old-id')
    await user.click(screen.getByRole('button', { name: 'Save Google settings' }))
    await waitFor(() => expect(field).toHaveValue('stored-id'))
    expect(api.getAdminOAuth).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('checkbox', { name: 'Enable Google Sign-In' })).toBeChecked()
  })
  it('says a save whose read back failed was saved', async () => {
    const user = userEvent.setup()
    api.getAdminOAuth.mockResolvedValueOnce(google('old-id')).mockRejectedValue(new APIError(500, 'failed to read oauth settings', {}))
    api.updateAdminOAuth.mockResolvedValue({ ok: true })
    await openSection(user, 'Sign-in providers')
    await screen.findByDisplayValue('old-id')
    await user.click(screen.getByRole('button', { name: 'Save Google settings' }))
    const said = (await screen.findByText(/^Saved\. The settings could not be read back/)).closest<HTMLElement>('[role="alert"]')!
    expect(alertLines(said)).toEqual(['Saved. The settings could not be read back: reload to see them.', 'The server said: failed to read oauth settings'])
  })
})

describe('a role change that may have happened', () => {
  const PRIYA = { id: 2, username: 'priya', email: '', role: 'admin', created_at: '', updated_at: '' }
  const openDemotion = async (user: User) => {
    await openSection(user, 'Users')
    await user.click(await screen.findByRole('button', { name: 'Actions for priya' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove admin' }))
    return screen.findByRole('alertdialog', { name: 'Remove admin from priya?' })
  }

  it('asks in true words; after a failure the server may not mean, puts the question down, reads the users again and then says to check', async () => {
    const user = userEvent.setup()
    let readAgain!: (v: unknown) => void
    api.listAdminUsers.mockResolvedValueOnce([PRIYA]).mockReturnValueOnce(new Promise(r => { readAgain = r }))
    // A demotion whose sign-out step failed: the role WAS changed.
    api.updateUserRole.mockRejectedValue(new APIError(500, 'role updated but session revocation failed; retry to fully revoke admin access', {}))
    const d = await openDemotion(user)
    expect(d).toHaveAccessibleDescription('priya loses the admin pages and every admin power. They stay signed in.')
    await user.click(within(d).getByRole('button', { name: 'Remove admin' }))
    await waitFor(() => expect(api.listAdminUsers).toHaveBeenCalledTimes(2))
    // Not said before the read has ended.
    expect(screen.queryByText(/The list has been read again/)).toBeNull()
    await act(async () => { readAgain([{ ...PRIYA, role: 'user' }]) })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const said = (await screen.findByText(/^Could not confirm the change/)).closest<HTMLElement>('[role="alert"]')!
    expect(alertLines(said)[0]).toBe("Could not confirm the change. The list has been read again: check priya's role.")
    expect(api.updateUserRole).toHaveBeenCalledTimes(1)
  })

  it('says when the users could not be read again either', async () => {
    const user = userEvent.setup()
    api.listAdminUsers.mockResolvedValueOnce([PRIYA]).mockRejectedValue(new APIError(500, 'x', {}))
    api.updateUserRole.mockRejectedValue(new APIError(500, 'role updated but session revocation failed', {}))
    const d = await openDemotion(user)
    await user.click(within(d).getByRole('button', { name: 'Remove admin' }))
    expect(await screen.findByText("Could not confirm the change, and the list could not be read again. Reload this page to check priya's role.")).toBeInTheDocument()
  })

  it('keeps a refused question as it was asked, and sends nothing when the row has changed under it', async () => {
    const user = userEvent.setup()
    // The last admin: refused, nothing changed. The read after it finds
    // priya changed by someone else meanwhile.
    api.listAdminUsers.mockResolvedValueOnce([PRIYA]).mockResolvedValue([{ ...PRIYA, role: 'user' }])
    api.updateUserRole.mockRejectedValueOnce(new APIError(400, 'cannot remove admin from the last remaining admin', {}))
    const d = await openDemotion(user)
    await user.click(within(d).getByRole('button', { name: 'Remove admin' }))
    await within(d).findByRole('alert')
    await waitFor(() => expect(api.listAdminUsers).toHaveBeenCalledTimes(2))
    // The row now says user; the open question is still the one asked.
    await waitFor(() => expect(screen.getByText('user', { selector: 'span' })).toBeInTheDocument())
    const same = screen.getByRole('alertdialog', { name: 'Remove admin from priya?' })
    expect(within(same).queryByRole('button', { name: 'Make admin' })).toBeNull()
    // Pressed again: the role it was about is gone, so nothing is sent.
    await user.click(within(same).getByRole('button', { name: 'Remove admin' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.updateUserRole).toHaveBeenCalledTimes(1)
    expect(statusSays()).toContain("priya's role has changed since you asked, so nothing was sent. Check it and ask again.")
  })
})

describe('a thing already gone', () => {
  it('hands the focus to the users table after deleting a user who was already gone', async () => {
    const user = userEvent.setup()
    api.listAdminUsers.mockResolvedValueOnce([{ id: 2, username: 'priya', email: '', role: 'user', created_at: '', updated_at: '' }]).mockResolvedValue([])
    api.deleteUser.mockRejectedValue(new APIError(404, 'user not found', {}))
    await openSection(user, 'Users')
    await user.click(await screen.findByRole('button', { name: 'Actions for priya' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete user' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete user' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(screen.getByRole('region', { name: 'Users on this server' })).toHaveFocus())
  })
  const PRIYA = { id: 2, username: 'priya', email: '', role: 'admin', created_at: '', updated_at: '' }
  it('closes the deny dialog, reads the requests again and says so', async () => {
    const user = userEvent.setup()
    api.listPendingApprovals.mockResolvedValueOnce([REQ]).mockResolvedValue([])
    api.denyRequest.mockRejectedValue(new APIError(404, 'request not found', {}))
    await openSection(user, 'Requests')
    await user.click(await screen.findByRole('button', { name: 'Deny Dune' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Deny request' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(statusSays()).toEqual(['The request for Dune was already gone from the server.'])
    expect(api.listPendingApprovals).toHaveBeenCalledTimes(2)
  })
  it.each([
    ['a role change', 'Remove admin', 'Remove admin', () => api.updateUserRole.mockRejectedValue(new APIError(404, 'user not found', {}))],
    ['a delete', 'Delete user', 'Delete user', () => api.deleteUser.mockRejectedValue(new APIError(404, 'user not found', {}))],
  ])('closes %s of a user already gone, reads the users again and says so', async (_what, item, confirm, refuse) => {
    const user = userEvent.setup()
    api.listAdminUsers.mockResolvedValueOnce([PRIYA]).mockResolvedValue([])
    refuse()
    await openSection(user, 'Users')
    await user.click(await screen.findByRole('button', { name: 'Actions for priya' }))
    await user.click(screen.getByRole('menuitem', { name: item }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: confirm }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(statusSays()).toEqual(['priya was already gone from the server.']))
    expect(api.listAdminUsers).toHaveBeenCalledTimes(2)
  })
  it('closes a change of type for a library already gone, reads the libraries again and says so', async () => {
    const user = userEvent.setup()
    api.previewLibraryRetype.mockResolvedValue({ library_id: 1, library_name: 'Movies', current_type: 'movie', target_type: 'show', items_to_delete: 3, items_kept: 0 } as RetypePreview)
    api.retypeLibrary.mockRejectedValue(new APIError(404, 'library not found', {}))
    await openSection(user, 'Libraries')
    await user.click(await screen.findByRole('button', { name: 'Change to TV' }))
    api.listLibraries.mockResolvedValue([])
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete and rescan' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(statusSays()).toEqual(['Movies is no longer on the server.'])
    await waitFor(() => expect(api.listLibraries).toHaveBeenCalledTimes(2))
  })
  it('closes the delete dialog, reads the libraries again and says so', async () => {
    const user = userEvent.setup()
    api.deleteLibrary.mockRejectedValue(new APIError(404, 'library not found', {}))
    await openSection(user, 'Libraries')
    await user.click(await screen.findByRole('button', { name: 'Delete Movies' }))
    api.listLibraries.mockResolvedValue([])
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete library' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(statusSays()).toEqual(['Movies was already gone from the server.'])
    expect(api.listLibraries).toHaveBeenCalledTimes(2)
  })
  it('closes the stop dialog, reads the streams again and says so', async () => {
    const user = userEvent.setup()
    api.listAdminSessions.mockResolvedValueOnce([{ id: 's1', kind: 'transcode', user_id: 2, username: 'priya', file_name: 's1.mkv', started_at: new Date().toISOString() }]).mockResolvedValue([])
    api.deleteStreamSession.mockRejectedValue(new APIError(404, 'session not found', {}))
    await openSection(user, 'Active streams')
    await user.click(await screen.findByRole('button', { name: 'Stop the stream of s1.mkv' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop stream' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(statusSays()).toEqual(['The stream of s1.mkv had already ended.'])
  })
})

describe('a restore’s other answers', () => {
  const restoreAnswering = async (user: User, answer: () => Promise<Response>) => {
    fetchAnswer = async url => url === '/api/admin/restore' ? answer() : json(503, { error: 'unavailable' })
    const view = await openSection(user, 'Backup and restore')
    await user.upload(view.container.querySelector<HTMLInputElement>('input[type="file"]')!, new File(['x'], 'aurora.dump'))
    await user.click(screen.getByRole('button', { name: 'Restore database' }))
    const d = await screen.findByRole('alertdialog')
    await user.click(within(d).getByRole('button', { name: 'Restore database' }))
    return alertLines(await within(d).findByRole('alert'))[0]
  }
  const LOST = 'No answer came back from the server while the file was sent, so it is not known whether the restore started. If it did, it runs on the server: this page looks for it, and the server’s log says what happened.'
  it.each([
    ['no answer', () => Promise.reject(new TypeError('Failed to fetch')), LOST],
    ['a proxy that gave up (504)', async () => json(504, { error: 'gateway timeout' }), LOST],
    ['a proxy that gave up (502)', async () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }), LOST],
    ['a proxy that gave up (503)', async () => json(503, { error: 'service unavailable' }), LOST],
    ['a file refused (400)', async () => json(400, { error: { code: 400, message: 'upload is not a pg_dump custom archive' } }), 'The server refused this file, and the database was not changed.'],
    ['a server error before the job (500)', async () => json(500, { error: { code: 500, message: 'failed to create temp file for upload' } }), 'The restore did not start, and the database was not changed. Read what the server said before trying again.'],
    ['another restore running (409)', async () => json(409, { error: { code: 409, message: 'another backup or restore is already in progress' } }), 'A backup or restore is already running, so this one did not start. The database was not changed by it. Wait for the other to finish, then try again.'],
    ['a file too large (413)', async () => json(413, { error: { code: 413, message: 'upload exceeds the 50 GB limit' } }), 'The file is too large to restore from here, and the database was not changed.'],
  ])('says %s', async (_what, answer, says) => {
    const user = userEvent.setup()
    expect(await restoreAnswering(user, answer)).toBe(says)
  })
})

it('says a backup that could not be downloaded when the server’s answer is not JSON', async () => {
  const user = userEvent.setup()
  fetchAnswer = async url => url === '/api/admin/backup'
    ? new Response('pg_dump: error: connection to server failed', { status: 500, headers: { 'content-type': 'text/plain' } })
    : json(503, { error: 'unavailable' })
  await openSection(user, 'Backup and restore')
  await user.click(screen.getByRole('button', { name: 'Download backup' }))
  expect(alertLines(await screen.findByRole('alert'))).toEqual(['Could not download a backup just now.', 'The server said: pg_dump: error: connection to server failed'])
})

describe('leaving the admin page with a question open', () => {
  // A switch to a profile without admin powers takes App off /admin, which
  // unmounts the page.
  it('sends nothing and leaves nothing on screen', async () => {
    const user = userEvent.setup()
    const view = await openSection(user, 'Libraries')
    await user.click(await screen.findByRole('button', { name: 'Delete Movies' }))
    await screen.findByRole('alertdialog')
    view.unmount()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.body.textContent).toBe('')
    expect(api.deleteLibrary).not.toHaveBeenCalled()
  })
})

describe('adminFailure', () => {
  const doing = 'delete the library'
  it('takes the kinds and their sentences from the shared words', () => {
    expect(adminFailure(new APIError(403, 'admin access requires a profile without a content limit', { error: { reason: 'profile_restricted' } }), doing))
      .toEqual({ says: 'The profile you are watching as has a content limit, so it cannot do this. Switch to a profile without a limit first.', server: 'The server said: admin access requires a profile without a content limit' })
    expect(adminFailure(new APIError(403, 'admin only', {}), doing)).toEqual({ says: 'That is not allowed.', server: 'The server said: admin only' })
    expect(adminFailure(new APIError(404, 'library not found', {}), doing).says).toBe('That is not available.')
    expect(adminFailure(new APIError(401, 'unauthorized', {}), doing).says).toBe('Could not delete the library. You may need to sign in again.')
    expect(adminFailure(new APIError(500, 'boom', {}), doing).says).toBe('Could not delete the library just now.')
  })
  it('says a write that got no answer may have happened, and a read that could not reach the server', () => {
    expect(adminFailure(new NetworkError('Failed to fetch'), doing)).toEqual({ says: NO_ANSWER_WRITE, server: null })
    expect(adminFailure(new NetworkError('Failed to fetch'), 'read the settings', { read: true }).says).toBe('Could not reach the server. Check the connection and try again.')
  })
  it('never shows the app’s own error or a bare status as the server’s words', () => {
    expect(adminFailure(new TypeError('x is not iterable'), doing)).toEqual({ says: 'Could not delete the library just now.', server: null })
    expect(adminFailure(new APIError(500, 'HTTP 500', null), doing).server).toBeNull()
  })
  it('cuts a long server text short', () => {
    const server = adminFailure(new APIError(500, 'x'.repeat(5000), {}), doing).server!
    expect(server.endsWith('…')).toBe(true)
    expect(Array.from(server.replace('The server said: ', ''))).toHaveLength(200)
  })
  it('lets a route name what one of its statuses means, and its own sentence for a 5xx', () => {
    expect(adminFailure(new APIError(404, 'library not found', {}), doing, { 404: 'Movies is no longer on the server.' }))
      .toEqual({ says: 'Movies is no longer on the server.', server: 'The server said: library not found' })
    expect(adminFailure(new APIError(503, 'down', {}), doing, { otherwise: 'Mine.' }).says).toBe('Mine.')
    expect(adminFailure(new APIError(409, 'busy', {}), doing, { otherwise: 'Mine.' }).says).toBe('Could not delete the library.')
  })
})
