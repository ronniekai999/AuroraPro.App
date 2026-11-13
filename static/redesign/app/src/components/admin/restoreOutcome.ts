// What came of a database restore this tab sent, kept outside the Admin page.
//
// A restore runs for minutes, and the admin can be elsewhere when it ends
// (the browser's Back, a profile switch made in another tab, or the way out
// of its dialog and then another section): its outcome must still be said.
// The restore writes it here whether or not the page is mounted. The backup
// panel shows it while it is mounted; RestoreOutcomeAlert, mounted by App
// for a session with the admin UI, raises it when no panel is there to.
//
// Memory only, and only what this tab's request was answered. The restore
// itself no longer depends on the page: once the upload is done the server
// runs it to its end and keeps a record of it, which a reload, another tab
// or the sign-in page reads (hooks/useRestoreRecord, lib/restoreStatus).
// An answer that never came (`lost`) leaves the saying to that record.

import { useSyncExternalStore } from 'react'
import type { Failure } from './adminFailure'

export type RestoreOutcome =
  | { accountId: number; file: string; ok: true }
  /** `lost`: no answer from Aurora (the connection, or a proxy's 502-504). */
  | { accountId: number; file: string; ok: false; failure: Failure; lost?: true }

interface State {
  outcome: RestoreOutcome | null
  /** Restore requests this tab has out now. Their tickets are kept before
   *  the upload ends, so the server's record of them is not there yet: a
   *  read now would call them unknown. */
  out: number
  /** Counts the requests that have ended, so the server's record is read
   *  again (hooks/useRestoreRecord's recheck). */
  ended: number
  /** Said already: by a backup panel that was up, or by the alert. */
  seen: boolean
  /** Backup panels mounted now (one at most in practice). */
  panels: number
}

let state: State = { outcome: null, out: 0, ended: 0, seen: false, panels: 0 }
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

/** A restore request goes out from this tab. */
export function beginRestore(): void {
  set({ out: state.out + 1 })
}

/** Restore requests this tab has out now, for code outside React (the scan
 *  bar's poll, which holds back while one may be running). */
export function restoreRequestsOut(): number {
  return state.out
}

export function finishRestore(outcome: RestoreOutcome): void {
  set({ outcome, seen: state.panels > 0, out: Math.max(0, state.out - 1), ended: state.ended + 1 })
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

/** Tests only. */
export function resetRestoreOutcomeForTest(): void {
  state = { outcome: null, out: 0, ended: 0, seen: false, panels: 0 }
}
