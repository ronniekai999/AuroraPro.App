// A database restore this tab follows, and what came of it, kept outside the
// Admin page.
//
// The restore runs as a job on the server: POST /api/admin/restore answers
// 202 once the file is uploaded and the job has started, and the job goes on
// whether or not this tab stays open. The tab follows it by reading
// GET /api/admin/restore/status (followRestore), and finds one already
// running when the backup panel or the app's alert mounts (discoverRestore),
// so a page opened or reloaded mid-restore picks it up. The status is read
// only while something that shows it to the following account is mounted
// (useRestoreWatch: the backup panel, and RestoreOutcomeAlert, which App
// mounts for a session with the admin UI), so a signed-out tab asks nothing.
//
// The outcome is said wherever the admin is when it lands: the backup panel
// while it is mounted, else RestoreOutcomeAlert. Both say it only to the
// account that followed the restore in this tab.
//
// What the status cannot say. Its route is behind the admin guards, which
// read the session from the database, and the restore is what replaces the
// database: from the wipe until pg_restore commits, and for good after a
// restore that failed past the wipe, every read is refused (401 or 500). The
// page says so and keeps looking. A successful restore ends every session (a
// backup holds no sessions), so the admin signs in again and is told then.
// The server keeps the status in memory: after a restart it has no record of
// the restore, and the page says that too.

import { useEffect, useSyncExternalStore } from 'react'
import { APIError, NetworkError, getRestoreStatus, type RestorePhase, type RestoreResult, type RestoreRun, type RestoreStatus } from '@/lib/api'
import { serverSaidForAdmin } from '@/lib/failureWords'
import { adminFailure, type Failure } from './adminFailure'

export type RestoreOutcome =
  | { accountId: number; file: string; ok: true }
  | { accountId: number; file: string; ok: false; failure: Failure }

/** The restore this tab follows: started here, or found running. */
export interface FollowedRestore {
  accountId: number
  id: string
  file: string
}

interface State {
  following: FollowedRestore | null
  /** The server's last word on the followed restore while it runs. */
  running: RestoreRun | null
  /** The last read of its status failed: why, in the page's words. */
  unreadable: Failure | null
  /** A look for a running restore failed (the backup panel says it). */
  checkFailed: Failure | null
  outcome: RestoreOutcome | null
  /** Said already: by a backup panel that was up, or by the alert. */
  seen: boolean
  /** Backup panels mounted now (one at most in practice). */
  panels: number
}

const EMPTY: State = { following: null, running: null, unreadable: null, checkFailed: null, outcome: null, seen: false, panels: 0 }
let state: State = EMPTY
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

// How often the status is read while a restore runs, and while it cannot be
// read. The second is slower: a refused read can mean the database is being
// replaced, which takes minutes, and each refused read also costs a refresh
// of the session.
const POLL_MS = 3000
const POLL_UNREADABLE_MS = 10_000
let pollMs = POLL_MS
let pollUnreadableMs = POLL_UNREADABLE_MS

// Who shows it now (a mounted backup panel or alert), by account.
const watchers = new Map<symbol, number>()
let timer: ReturnType<typeof setTimeout> | null = null
let reading = false

const watched = () => !!state.following && [...watchers.values()].includes(state.following.accountId)

function schedule(ms: number) {
  if (timer !== null || !watched()) return
  timer = setTimeout(() => { timer = null; void readOnce() }, ms)
}

async function readOnce() {
  const followed = state.following
  if (!followed || reading || !watched()) return
  reading = true
  try {
    const st = await getRestoreStatus()
    if (state.following === followed) apply(followed, st)
  } catch (e) {
    if (state.following === followed) set({ unreadable: unreadableFailure(e, state.running?.phase ?? null) })
  } finally {
    reading = false
    schedule(state.unreadable ? pollUnreadableMs : pollMs)
  }
}

function apply(followed: FollowedRestore, st: RestoreStatus) {
  if (st.running && st.running.id === followed.id) {
    set({ running: st.running, unreadable: null })
    return
  }
  if (st.last && st.last.id === followed.id) {
    finish(outcomeOf(followed, st.last))
    return
  }
  finish({ accountId: followed.accountId, file: followed.file, ok: false, failure: { says: NO_RECORD, server: null } })
}

function finish(outcome: RestoreOutcome) {
  set({ following: null, running: null, unreadable: null, outcome, seen: state.panels > 0 })
}

/** Start following a restore: the one this tab's upload started, or one
 *  found running. A previous outcome is put away: it is about an earlier
 *  restore. */
export function followRestore(accountId: number, run: RestoreRun): void {
  if (state.following?.id === run.id) return
  set({ following: { accountId, id: run.id, file: run.file }, running: run, unreadable: null, checkFailed: null, outcome: null, seen: false })
  schedule(pollMs)
}

let discovering: Promise<void> | null = null

/** Looks once for a restore running on the server, and follows it. Nothing
 *  when one is followed already. A failed look is kept for the backup panel
 *  (`checkFailed`); the alert says nothing of it. */
export function discoverRestore(accountId: number): Promise<void> {
  if (state.following) return Promise.resolve()
  if (discovering) return discovering
  discovering = (async () => {
    try {
      const st = await getRestoreStatus()
      set({ checkFailed: null })
      if (st.running && !state.following) followRestore(accountId, st.running)
    } catch (e) {
      set({ checkFailed: adminFailure(e, 'check whether a restore is running', { read: true }) })
    } finally {
      discovering = null
    }
  })()
  return discovering
}

/** While the caller is mounted it shows the restore to `accountId`: the
 *  status is read for a restore that account follows, and one already
 *  running is looked for once. */
export function useRestoreWatch(accountId: number): void {
  useEffect(() => {
    const me = Symbol('restore watcher')
    watchers.set(me, accountId)
    void discoverRestore(accountId)
    schedule(0)
    return () => {
      watchers.delete(me)
      if (!watched() && timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }, [accountId])
}

/** An upload that never became a restore (a refusal, no answer): said the
 *  same way as a restore that ended. */
export function finishRestore(outcome: RestoreOutcome): void {
  finish(outcome)
}

/** The alert's button, or a panel that showed it. The success notice stays
 *  in the panel until dismissed there. */
export function markRestoreSeen(): void {
  if (!state.seen) set({ seen: true })
}

/** The outcome is put away (the panel's Dismiss). */
export function clearRestoreOutcome(): void {
  if (state.outcome) set({ outcome: null, seen: false })
}

/** A backup panel is up: it shows the outcome, so it counts as said. */
export function backupPanelMounted(): () => void {
  set({ panels: state.panels + 1, seen: state.outcome ? true : state.seen })
  return () => set({ panels: state.panels - 1 })
}

export function useRestoreOutcome(): State {
  return useSyncExternalStore(
    l => { listeners.add(l); return () => { listeners.delete(l) } },
    () => state,
  )
}

/* ─────────────── the words ─────────────── */

/** What a running restore is doing, for "Restoring the database from X: …". */
export const PHASE_WORDS: Record<RestorePhase, string> = {
  validating: 'checking the file',
  wiping: 'clearing the old data',
  restoring: 'loading the backup',
}

export const NO_RECORD = 'The server has no record of how this restore ended: it has been restarted, or another restore has run since. Check the server’s log before going on.'

const REPLACING = 'While the restore replaces the database, the server cannot check who is signed in, so it cannot say how far the restore has got. The restore goes on running on the server, and this page looks again. If this lasts after the restore should have ended, it may have failed and left the database empty: the server’s log says how it ended.'

const NO_ANSWER = 'No answer came from the server, so it is not known how the restore is going. It goes on running on the server unless the server itself has stopped, and this page looks again.'

/** Why the followed restore's status could not be read. Past the validation
 *  the admin guards cannot read the session (the database is being
 *  replaced), so a refusal there says that; before it a refusal is what it
 *  says it is. */
function unreadableFailure(e: unknown, phase: RestorePhase | null): Failure {
  if (e instanceof NetworkError) return { says: NO_ANSWER, server: null }
  if (e instanceof APIError && (phase === 'wiping' || phase === 'restoring') && (e.status === 401 || e.status >= 500)) {
    return { says: REPLACING, server: serverSaidForAdmin(e) }
  }
  const f = adminFailure(e, 'read how the restore is going', { read: true })
  return { says: `${f.says} The restore may still be running on the server.`, server: f.server }
}

/** What a finished restore is said to have done. */
function outcomeOf(followed: FollowedRestore, r: RestoreResult): RestoreOutcome {
  const file = r.file || followed.file
  if (r.succeeded) return { accountId: followed.accountId, file, ok: true }
  const stopped = r.stopped === 'shutdown'
    ? 'The server was stopped or restarted while the restore ran. '
    : r.stopped === 'timeout'
      ? 'The restore ran past the server’s 60-minute limit and was stopped. '
      : ''
  let says: string
  if (r.database === 'unchanged') {
    says = stopped ? `${stopped}It stopped before anything was changed, so the database is as it was.` : 'The server refused this file, and the database was not changed.'
  } else if (r.phase === 'wiping') {
    says = `${stopped}The restore stopped while clearing the old data, so the database may be as it was or empty. Read what the server said before going on.`
  } else {
    says = `${stopped}The restore failed after the old data had been cleared, so the database may now be empty. Read what the server said, then restore again from a backup that works.`
  }
  const text = [r.message, r.stderr].filter(Boolean).join(': ')
  return { accountId: followed.accountId, file, ok: false, failure: { says, server: serverSaidForAdmin(new APIError(500, text, null)) } }
}

/** Tests only. */
export function resetRestoreOutcomeForTest(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  reading = false
  discovering = null
  watchers.clear()
  state = EMPTY
  pollMs = POLL_MS
  pollUnreadableMs = POLL_UNREADABLE_MS
}

/** Tests only: read the status this often. */
export function setRestorePollForTest(ms: number, unreadableMs = ms): void {
  pollMs = ms
  pollUnreadableMs = unreadableMs
}
