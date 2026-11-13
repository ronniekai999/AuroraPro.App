// A database restore this tab follows, and what came of it, kept outside the
// Admin page.
//
// The restore runs as a job on the server: POST /api/admin/restore answers
// 202 once the file is uploaded and the job has started, and the job goes on
// whether or not this tab stays open. It checks the file, then clears the old
// data and loads the backup in ONE transaction: it commits whole or not at
// all, so a failure, or a server restart or update part way, leaves the
// database as it was (the restore is lost and has to be run again).
//
// The tab follows it by its id, read from GET /api/admin/restore/status
// (followRestore): `running` while it runs, `last` once it has ended. The id
// is kept in this tab's sessionStorage, so a reload or a sign-out and sign-in
// in the tab keeps following it, and its outcome is said when the server
// next answers. With no restore followed, mounting the backup panel or the
// app's alert looks once for one already running (discoverRestore), and again
// while that look fails. The status is read only while something that shows
// it to the following account is mounted (useRestoreWatch: the backup panel,
// and RestoreOutcomeAlert, which App mounts for a session with the admin UI),
// so a signed-out tab asks nothing.
//
// The outcome is said wherever the admin is when it lands: the backup panel
// while it is mounted, else RestoreOutcomeAlert. Both say it only to the
// account that followed the restore in this tab.
//
// What the status cannot say. Its route is behind the admin guards, which
// read the session from the database, and while the restore's transaction
// runs it holds exclusive locks on those tables: a read gets no answer until
// the restore has committed or rolled back. (The token check runs with no
// deadline once its 60 s cache has lapsed; with a fresh cache the session
// check gives up after 60 s with a 500.) The 202 says "validating", and the
// read that would say "replacing" is the one that waits, so every read of a
// followed restore that is slow, given up, or refused that way is said as the
// wait it most likely is (REPLACING), never as advice to sign in. Reads go one
// at a time, each given up after READ_TIMEOUT_MS, so this tab's status reads
// hold at most one of the server's database connections at a time (the scan
// bar pauses while a restore is followed: restoreFollowed); every other
// request the app makes meanwhile waits too, and the server's connections
// (10 by default) are soon all waiting until the restore ends. A successful restore replaces the
// sessions with the backup's (none), so everyone is signed out, the admin
// included, and the admin is told after signing in again (before a restart,
// which forgets the outcome); a failed one leaves everyone signed in. The
// server keeps the status in memory: after a restart it has no record of the
// restore, and the page says that too.

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
// read. The second is slower: an unanswered read can mean the database is
// being replaced, which takes minutes, and each refused read also costs a
// refresh of the session.
const POLL_MS = 3000
const POLL_UNREADABLE_MS = 10_000
// A read out this long during the replacing step is said to be waiting for
// it; one out this long is given up (past the session check's own 60 s,
// whose 500 comes first when the token check's cache is fresh). One read at a
// time.
const SLOW_READ_MS = 5000
const READ_TIMEOUT_MS = 75_000
let pollMs = POLL_MS
let pollUnreadableMs = POLL_UNREADABLE_MS
let slowReadMs = SLOW_READ_MS
let readTimeoutMs = READ_TIMEOUT_MS

// Who shows it now (a mounted backup panel or alert), by account.
const watchers = new Map<symbol, number>()
let timer: ReturnType<typeof setTimeout> | null = null
let reading = false
let lookAgain: ReturnType<typeof setTimeout> | null = null

// The followed restore's id, kept for this tab across reloads.
const FOLLOW_KEY = 'aurora.restore.following'

function storeFollow(f: FollowedRestore | null) {
  try {
    if (f) sessionStorage.setItem(FOLLOW_KEY, JSON.stringify(f))
    else sessionStorage.removeItem(FOLLOW_KEY)
  } catch { /* storage off: the follow lasts as long as the page */ }
}

function storedFollow(): FollowedRestore | null {
  try {
    const raw = sessionStorage.getItem(FOLLOW_KEY)
    if (!raw) return null
    const f = JSON.parse(raw) as Partial<FollowedRestore>
    if (typeof f.accountId === 'number' && typeof f.id === 'string' && f.id && typeof f.file === 'string') {
      return { accountId: f.accountId, id: f.id, file: f.file }
    }
  } catch { /* unreadable: nothing followed */ }
  return null
}

const watched = () => !!state.following && [...watchers.values()].includes(state.following.accountId)

function schedule(ms: number) {
  if (timer !== null || !watched()) return
  timer = setTimeout(() => { timer = null; void readOnce() }, ms)
}

/** One status read, given up after readTimeoutMs. `onSlow` runs if it is
 *  still out after slowReadMs. */
async function readStatus(onSlow?: () => void): Promise<RestoreStatus> {
  const ac = new AbortController()
  const slow = onSlow ? setTimeout(onSlow, slowReadMs) : null
  const limit = setTimeout(() => ac.abort(), readTimeoutMs)
  try {
    return await getRestoreStatus(ac.signal)
  } catch (e) {
    throw ac.signal.aborted ? new ReadTimedOut() : e
  } finally {
    if (slow !== null) clearTimeout(slow)
    clearTimeout(limit)
  }
}

class ReadTimedOut extends Error {
  constructor() { super('the status read was given up') }
}

async function readOnce() {
  const followed = state.following
  if (!followed || reading || !watched()) return
  reading = true
  try {
    const st = await readStatus(() => {
      // Waiting on the restore's locks, most likely: say so now rather than
      // after the read gives up.
      if (state.following === followed) set({ unreadable: { says: REPLACING, server: null } })
    })
    if (state.following === followed) apply(followed, st)
  } catch (e) {
    if (state.following === followed) set({ unreadable: unreadableFailure(e) })
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

/** Whether this tab follows a restore now (the scan bar pauses its polling
 *  meanwhile). */
export function restoreFollowed(): boolean {
  return !!state.following
}

/** The followed restore has ended (or the server has no record of it). */
function finish(outcome: RestoreOutcome) {
  storeFollow(null)
  set({ following: null, running: null, unreadable: null, outcome, seen: state.panels > 0 })
}

/** Start following a restore: the one this tab's upload started, or one
 *  found running. A previous outcome is put away: it is about an earlier
 *  restore. */
export function followRestore(accountId: number, run: RestoreRun): void {
  if (state.following?.id === run.id) return
  const following = { accountId, id: run.id, file: run.file }
  storeFollow(following)
  set({ following, running: run, unreadable: null, checkFailed: null, outcome: null, seen: false })
  schedule(pollMs)
}

/** A follow kept from before a reload: taken up, to be read at once. */
function takeUpStoredFollow() {
  if (state.following) return
  const f = storedFollow()
  if (f) set({ following: f, running: null, unreadable: null })
}

let discovering: Promise<void> | null = null

/** Looks for a restore running on the server, and follows it. Nothing when
 *  one is followed already. A failed look is kept for the backup panel
 *  (`checkFailed`; the alert says nothing of it) and tried again while
 *  something that shows a restore is mounted. */
export function discoverRestore(accountId: number): Promise<void> {
  if (state.following) return Promise.resolve()
  if (discovering) return discovering
  discovering = (async () => {
    try {
      const st = await readStatus()
      set({ checkFailed: null })
      if (st.running && !state.following) followRestore(accountId, st.running)
    } catch (e) {
      set({ checkFailed: adminFailure(e, 'check whether a restore is running', { read: true }) })
      if (lookAgain === null) {
        lookAgain = setTimeout(() => {
          lookAgain = null
          const someone = [...watchers.values()][0]
          if (someone !== undefined) void discoverRestore(someone)
        }, pollUnreadableMs)
      }
    } finally {
      discovering = null
    }
  })()
  return discovering
}

/** While the caller is mounted it shows the restore to `accountId`: the
 *  status is read for a restore that account follows, and one already
 *  running is looked for when none is followed. */
export function useRestoreWatch(accountId: number): void {
  useEffect(() => {
    const me = Symbol('restore watcher')
    watchers.set(me, accountId)
    takeUpStoredFollow()
    void discoverRestore(accountId)
    schedule(0)
    return () => {
      watchers.delete(me)
      if (!watched() && timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (watchers.size === 0 && lookAgain !== null) {
        clearTimeout(lookAgain)
        lookAgain = null
      }
    }
  }, [accountId])
}

/** An upload that never became a restore (a refusal, no answer): said the
 *  same way as a restore that ended. A restore followed meanwhile (another
 *  account's in this tab, whose own upload this refusal is not) goes on
 *  being followed. */
export function finishRestore(outcome: RestoreOutcome): void {
  set({ outcome, seen: state.panels > 0 })
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
  replacing: 'replacing the data',
}

export const NO_RECORD = 'The server has no record of how this restore ended: it has been restarted, or another restore has run since. Check the server’s log before going on.'

export const REPLACING = 'The server has not answered yet. While the restore replaces the database, the rest of Aurora waits for it, and so does this page: the server will answer again when the restore is done. Do not restart the server meanwhile: that undoes the restore, and the old data stays.'

export const NO_ANSWER = 'No answer came from the server, so it is not known how the restore is going. If the server is still up, the restore goes on; if it has stopped, the restore was undone and the database is as it was. This page looks again.'

/** Why the followed restore's status could not be read. While its
 *  transaction runs the server's session check waits on its locks, so a read
 *  that waited (given up here, a 500 or 401 from the check giving up, or a
 *  504 from a proxy in front that gave up first) is that wait, and is said as
 *  REPLACING, never as advice to sign in.
 *  No answer at all is said as that; anything else as what it is. */
function unreadableFailure(e: unknown): Failure {
  if (e instanceof NetworkError) return { says: NO_ANSWER, server: null }
  if (e instanceof ReadTimedOut || (e instanceof APIError && (e.status === 401 || e.status >= 500))) {
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
  if (r.database === 'unknown') {
    says = `${stopped}The restore was cut off as it was being committed (the connection to the database was lost, or the server stopped it), so it is not known whether it took effect: the database holds either what it held before or the backup, never a mix. Check which before going on.`
  } else if (r.phase === 'validating') {
    says = `${stopped}The restore did not start changing anything, so the database is as it was. Read what the server said before trying again.`
  } else {
    says = `${stopped}${stopped ? 'Everything the restore had done was undone' : 'The restore failed and everything it had done was undone'}, so the database is as it was. Read what the server said before trying again.`
  }
  const text = [r.message, r.stderr].filter(Boolean).join(': ')
  return { accountId: followed.accountId, file, ok: false, failure: { says, server: serverSaidForAdmin(new APIError(500, text, null)) } }
}

/** Tests only: what a reload forgets (the page's memory, not the tab's
 *  sessionStorage). */
export function forgetRestoreMemoryForTest(): void {
  if (timer !== null) clearTimeout(timer)
  if (lookAgain !== null) clearTimeout(lookAgain)
  timer = null
  lookAgain = null
  reading = false
  discovering = null
  watchers.clear()
  state = EMPTY
}

/** Tests only. */
export function resetRestoreOutcomeForTest(): void {
  forgetRestoreMemoryForTest()
  storeFollow(null)
  pollMs = POLL_MS
  pollUnreadableMs = POLL_UNREADABLE_MS
  slowReadMs = SLOW_READ_MS
  readTimeoutMs = READ_TIMEOUT_MS
}

/** Tests only: read the status this often. */
export function setRestorePollForTest(ms: number, unreadableMs = ms): void {
  pollMs = ms
  pollUnreadableMs = unreadableMs
}

/** Tests only: when a read is called slow, and when it is given up. */
export function setRestoreReadLimitsForTest(slowMs: number, timeoutMs: number): void {
  slowReadMs = slowMs
  readTimeoutMs = timeoutMs
}
