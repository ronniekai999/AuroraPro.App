// What came of a database restore, kept outside the Admin page.
//
// A restore runs for minutes, and the admin can be elsewhere when it ends
// (the browser's Back, a profile switch made in another tab, or the way out
// of its dialog and then another section): its outcome must still be said.
// The restore writes it here whether or not the page is mounted. The backup
// panel shows it while it is mounted; RestoreOutcomeAlert, mounted by App
// for a session with the admin UI, raises it when no panel is there to.
//
// Memory only. A reload or a closed tab would lose it, but worse, it stops
// the restore itself: the server runs the restore on the request, and a
// request whose page goes is cancelled, part way through and possibly after
// the old data was cleared. So while one is out the page asks the browser to
// check before it is left (holdPageForRestore).

import { useSyncExternalStore } from 'react'
import type { Failure } from './adminFailure'

export type RestoreOutcome =
  | { accountId: number; file: string; ok: true }
  | { accountId: number; file: string; ok: false; failure: Failure }

interface State {
  outcome: RestoreOutcome | null
  /** Said already: by a backup panel that was up, or by the alert. */
  seen: boolean
  /** Backup panels mounted now (one at most in practice). */
  panels: number
}

let state: State = { outcome: null, seen: false, panels: 0 }
const listeners = new Set<() => void>()
const set = (next: Partial<State>) => {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

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

// The browser's own "leave this page?" check (the beforeunload event; a
// browser shows its own words, and none of ours), held while any restore is
// out. Not a dialog of the app's and not one the page draws. Held by count:
// two restores cannot run at once on the server, but nothing here assumes it.
let holds = 0
const askBeforeLeaving = (e: BeforeUnloadEvent) => {
  // MDN's pair for asking. Current browsers ask when the event is cancelled.
  e.preventDefault()
  // Older Chrome and Edge ignore the cancel and ask only when returnValue is
  // set (MDN). Which values they accept was not tested here.
  e.returnValue = true
}

/** Holds the check until the returned release is called (once). The
 *  request outlives the Admin page, so this is not tied to a component. */
export function holdPageForRestore(): () => void {
  if (holds++ === 0) window.addEventListener('beforeunload', askBeforeLeaving)
  let released = false
  return () => {
    if (released) return
    released = true
    if (--holds === 0) window.removeEventListener('beforeunload', askBeforeLeaving)
  }
}

/** Tests only. */
export function resetRestoreOutcomeForTest(): void {
  state = { outcome: null, seen: false, panels: 0 }
  if (holds > 0) window.removeEventListener('beforeunload', askBeforeLeaving)
  holds = 0
}
