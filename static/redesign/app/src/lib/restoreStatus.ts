// What became of a database restore, as the server records it.
//
// A restore no longer runs on its request: once the file is uploaded the
// server runs it to its end whatever becomes of this page, and records how it
// went (internal/api/admin_restore.go). Two reads give that record:
//
//   - GET /api/admin/restore/status, behind the admin guard, for any admin
//     the database can vouch for (getAdminRestoreStatus in lib/api).
//   - GET /api/restore/status with the restore's ticket, which needs no
//     session. From a restore's wipe until it commits there are no tables to
//     check a session against, one that fails after its wipe leaves none, and
//     one that succeeds brings back no sessions: a reload in any of those
//     lands on the sign-in page, and the ticket is how that page can still
//     say how the restore went.
//
// The ticket is a secret this browser makes for each restore, sends with the
// upload and keeps in localStorage, so a reload or a closed tab keeps it. It
// reads that one restore's record and nothing else; the server keeps only its
// hash, and a newer restore replaces it. localStorage can be unavailable (a
// private window, blocked site data): then nothing is remembered, and the
// Admin page's own read is all there is.

import { APIError } from '@/lib/api'

export type RestoreState = 'none' | 'running' | 'succeeded' | 'failed'

export interface RestoreStatus {
  state: RestoreState
  /** Where a running restore is, or where a failed one stopped. */
  step?: 'checking' | 'clearing' | 'restoring'
  /** What it has done to the database, as far as the server can tell. */
  database?: 'unchanged' | 'unknown' | 'empty' | 'restored'
  file?: string
  started_at?: string
  finished_at?: string
  /** A restore has succeeded since Aurora last started. */
  restart_required: boolean
  /** The server's account of a finished restore. */
  message?: string
}

export const RESTORE_TICKET_HEADER = 'X-Aurora-Restore-Ticket'
const STORE_KEY = 'aurora.restore'

export interface RememberedRestore {
  ticket: string
  file: string
  /** The last state this browser read for it; null before the first. */
  seen: RestoreState | null
  /** When it was kept (ms since the epoch); null for one kept before this
   *  was recorded. */
  at: number | null
}

/** 32 random bytes, base64url: the server takes 32 to 128 characters of
 *  that alphabet. */
export function newRestoreTicket(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function write(r: RememberedRestore | null) {
  try {
    if (r) localStorage.setItem(STORE_KEY, JSON.stringify(r))
    else localStorage.removeItem(STORE_KEY)
  } catch { /* nothing is remembered */ }
}

export function rememberedRestore(): RememberedRestore | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const r = JSON.parse(raw) as Partial<RememberedRestore>
    if (typeof r.ticket !== 'string' || typeof r.file !== 'string') return null
    return { ticket: r.ticket, file: r.file, seen: typeof r.seen === 'string' ? r.seen as RestoreState : null, at: typeof r.at === 'number' ? r.at : null }
  } catch {
    return null
  }
}

/** A new restore's ticket, kept before its upload starts so a reload
 *  during the upload still has it. Replaces any earlier one. */
export function rememberRestore(ticket: string, file: string): void {
  write({ ticket, file, seen: null, at: Date.now() })
}

/** The last state read for a ticket, if it is still the one kept. */
export function noteRestoreSeen(ticket: string, state: RestoreState): void {
  const r = rememberedRestore()
  if (r && r.ticket === ticket && r.seen !== state) write({ ...r, seen: state })
}

/** Puts back what was kept before a restore that never started (a 409:
 *  another restore was running, possibly one this browser started), so its
 *  ticket is not lost to the one refused. */
export function putBackRestore(ticket: string, previous: RememberedRestore | null): void {
  if (rememberedRestore()?.ticket === ticket) write(previous)
}

/** Drops a ticket, if it is still the one kept (another tab may have
 *  started a newer restore). */
export function forgetRestore(ticket: string): void {
  if (rememberedRestore()?.ticket === ticket) write(null)
}

/** The record for a ticket; null when the server has none for it (it
 *  restarted, or a newer restore replaced it). Throws on no answer and on
 *  any other status. */
export async function readRestoreByTicket(ticket: string, signal?: AbortSignal): Promise<RestoreStatus | null> {
  const res = await fetch('/api/restore/status', {
    headers: { [RESTORE_TICKET_HEADER]: ticket },
    // The route reads no cookie, but a proxy in front of Aurora (basic
    // auth, an access gateway) may need its own.
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  })
  if (res.status === 404) return null
  if (!res.ok) throw new APIError(res.status, `HTTP ${res.status}`, null)
  return await res.json() as RestoreStatus
}

function timeOf(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return ` at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

export interface RestoreWords {
  title: string
  says: string
  /** Something the admin must not miss: a restart, or an empty database. */
  urgent: boolean
}

/** One set of words for a record, for the Admin page and the sign-in page
 *  alike. Null when there is nothing to say. */
export function restoreWords(st: RestoreStatus): RestoreWords | null {
  const file = st.file || 'the uploaded file'
  // The server's own text (st.message) is not among them: it is for the
  // Admin page only (components/admin/adminFailure, restoreServerLine).
  const earlier = st.restart_required ? ' Aurora still has to be restarted after an earlier restore.' : ''
  switch (st.state) {
    case 'running':
      return st.step === 'checking'
        ? { title: 'A restore is running', urgent: false, says: `Aurora is checking ${file} before it changes anything. The restore goes on on the server whether or not this page is open.` }
        : { title: 'A restore is running', urgent: true, says: `Aurora is replacing its database with ${file}. Until it has finished nobody can sign in. Do not restart Aurora meanwhile: that stops the restore and leaves the database empty. It goes on on the server whether or not this page is open.` }
    case 'succeeded':
      return { title: 'Restart Aurora now', urgent: true, says: `The database was restored from ${file}${timeOf(st.finished_at)}. Until Aurora is restarted, it goes on working from what it held before the restore. Sign-ins from before the restore have ended: sign in again with an account from the backup.` }
    case 'failed':
      if (st.database === 'unchanged') {
        return { title: `The restore from ${file} did not go through`, urgent: false, says: `The database was not changed.${earlier}` }
      }
      if (st.database === 'empty') {
        return { title: `The restore from ${file} failed`, urgent: true, says: 'It failed after the old data was cleared, so the database is now empty and nobody can sign in. Restore a backup from the server’s command line before restarting Aurora: started on an empty database, Aurora makes the first account anyone creates its admin.' }
      }
      return { title: `The restore from ${file} was stopped part way`, urgent: true, says: 'The database may be as it was, empty, or restored. Check it on the server before going on.' }
    default:
      return null
  }
}

/** Said when a ticket the browser kept is no longer known to the server.
 *  `seenRunning`: this browser had read the restore as running. */
export function lostRestoreWords(file: string, seenRunning: boolean): RestoreWords {
  return {
    title: `Aurora has no record of the restore from ${file}`,
    urgent: true,
    says: seenRunning
      ? 'Aurora has restarted since that restore began, or a newer restore has replaced it. If Aurora restarted while the restore was running, the restore did not finish and the database may be empty: check it on the server.'
      : 'If its upload did not finish, it never started and nothing was changed. If it did start, Aurora has restarted since or a newer restore has replaced it; if Aurora restarted while the restore was running, the database may be empty: check it on the server.',
  }
}
