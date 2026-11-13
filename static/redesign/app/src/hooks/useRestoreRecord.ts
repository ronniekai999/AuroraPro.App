// The server's record of the latest database restore, as this browser can
// read it (lib/restoreStatus.ts says why there are two reads).
//
// With a ticket kept, it reads by ticket: that read needs no session, so it
// works on the sign-in page and while the restore has the database, and it
// never sets off the session-expiry path a refused admin read would. Without
// one, and only where `adminRead` is given (the Admin page), it reads through
// the admin route; it does that too after a kept ticket the server no longer
// knows, so a restore running now is still said.
//
// When it reads again: every few seconds while the restore runs, and while a
// kept ticket gets no answer (Aurora restarting, a network drop) or has no
// record yet because its upload may still be going (another tab's). Every
// half minute after a success, so the restart it asks for clears it. A
// refused admin read is not asked again unless a restore was running or the
// caller says this tab's own restore got no answer (`keepAsking`), and then
// with a growing wait.

import { useCallback, useEffect, useState } from 'react'
import {
  forgetRestore, noteRestoreSeen, readRestoreByTicket, rememberedRestore, settleInterruptedUpload,
  type RememberedRestore, type RestoreStatus,
} from '@/lib/restoreStatus'

export const RESTORE_POLL_MS = 5000
/** How often a restore that succeeded is read again: Aurora's restart
 *  forgets it, and the note goes with it. */
export const RESTORE_DONE_POLL_MS = 30_000
/** The longest an upload can take: the server's read deadline for the
 *  restore route is 65 minutes. A ticket kept more recently than this whose
 *  record is not there yet may be an upload still going in another tab. */
export const RESTORE_UPLOAD_WINDOW_MS = 66 * 60_000
const RETRY_MAX_MS = 60_000

export interface RestoreRecord {
  /** The server's record, once read; null for none, or one put away. */
  status: RestoreStatus | null
  /** A kept ticket the server no longer knows, while that is worth saying:
   *  the restore was never seen to end. */
  lost: RememberedRestore | null
  /** The latest read got no answer, or was refused. */
  unreachable: boolean
  /** A kept ticket with no word on it yet: Aurora has not answered, or the
   *  upload may still be going. */
  waiting: RememberedRestore | null
  /** Puts the record away: an ended or lost restore's ticket is forgotten
   *  and the same restore is not shown again in this tab; a waiting ticket
   *  is only set aside in this tab (another tab may be uploading it). */
  dismiss: () => void
}

// Restores put away in this tab, by start time. Module state: the record
// outlives the panel that showed it.
const dismissedStarts = new Set<string>()

/** Tests only. */
export function resetRestoreRecordForTest(): void {
  dismissedStarts.clear()
}

export function useRestoreRecord({ adminRead, recheck = 0, keepAsking = false }: {
  adminRead?: (signal: AbortSignal) => Promise<RestoreStatus>
  /** Changed to read again at once (a restore in this tab ended). */
  recheck?: number
  /** This tab's own restore got no answer: keep asking the admin route,
   *  with a growing wait, until it says something. */
  keepAsking?: boolean
}): RestoreRecord {
  const [status, setStatus] = useState<RestoreStatus | null>(null)
  const [lost, setLost] = useState<RememberedRestore | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [waiting, setWaiting] = useState<RememberedRestore | null>(null)
  // The ticket `status` was read with (null for the admin read): Dismiss
  // forgets that one only, never a newer one another tab has kept since.
  const [source, setSource] = useState<string | null>(null)
  // A waiting ticket set aside in this tab.
  const [ignored, setIgnored] = useState<string | null>(null)
  // Bumped when a ticket is forgotten, so the reads start again without it.
  const [forgotten, setForgotten] = useState(0)

  useEffect(() => {
    settleInterruptedUpload()
    const stored = rememberedRestore()
    const kept = stored && stored.ticket !== ignored ? stored : null
    if (!kept && !adminRead) {
      setStatus(null)
      setWaiting(null)
      return
    }
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastState: RestoreStatus['state'] | null = null
    let byTicket = !!kept
    let failures = 0
    // One more look for a ticket whose request ended without an answer:
    // the answer can be lost a moment before the server records it.
    let graceUsed = false
    const backoff = () => Math.min(RETRY_MAX_MS, RESTORE_POLL_MS * 2 ** (failures - 1))
    const again = (ms = RESTORE_POLL_MS) => { timer = setTimeout(() => { void ask() }, ms) }
    const ask = async (): Promise<void> => {
      try {
        let st: RestoreStatus | null
        if (kept && byTicket) {
          st = await readRestoreByTicket(kept.ticket, ac.signal)
          if (ac.signal.aborted) return
          if (!st) {
            const now = rememberedRestore()
            const seen = now?.ticket === kept.ticket ? now.seen : kept.seen
            setUnreachable(false)
            setStatus(null)
            const ended = now?.ticket === kept.ticket ? now.ended : kept.ended
            if (seen === null && (ended ? !graceUsed : kept.at !== null && Date.now() - kept.at < RESTORE_UPLOAD_WINDOW_MS)) {
              // Its upload may still be going, in another tab (no record
              // yet is not no record), or its answer was lost a moment
              // before the server recorded it: one more look.
              if (ended) graceUsed = true
              setWaiting(kept)
              again()
              return
            }
            setWaiting(null)
            if (seen === null || seen === 'running') {
              setLost(kept)
              // Where there is an admin read, it says what runs now (another
              // restore, or this one), so a restore running is said and its
              // button held; it cannot say what became of this ticket's.
              if (adminRead) {
                byTicket = false
                await ask()
              }
            } else {
              // It ended, this browser saw how, and Aurora has restarted
              // since: nothing left to say.
              forgetRestore(kept.ticket)
              setForgotten(n => n + 1)
            }
            return
          }
          noteRestoreSeen(kept.ticket, st.state)
          setSource(kept.ticket)
          setLost(null)
        } else {
          st = await adminRead!(ac.signal)
          if (ac.signal.aborted) return
          setSource(null)
        }
        lastState = st.state
        failures = 0
        setWaiting(null)
        setUnreachable(false)
        setStatus(st)
        if (st.state === 'running') again()
        else if (st.state === 'succeeded' && kept && byTicket) again(RESTORE_DONE_POLL_MS)
      } catch {
        if (ac.signal.aborted) return
        setUnreachable(true)
        failures++
        if (kept && byTicket) {
          // A ticket read has no session to upset: asked again, with a
          // growing wait while Aurora stays away.
          if (lastState === null) setWaiting(kept)
          again(backoff())
        } else if (lastState === 'running' || keepAsking) {
          // A refused admin read would only be refused again, unless a
          // restore was running or this tab's own got no answer.
          again(backoff())
        }
      }
    }
    void ask()
    return () => {
      ac.abort()
      clearTimeout(timer)
    }
  }, [adminRead, recheck, forgotten, ignored, keepAsking])

  const dismiss = useCallback(() => {
    if (!status && !lost && waiting) {
      // Only set aside here: another tab may still be uploading it.
      setIgnored(waiting.ticket)
      setWaiting(null)
      setUnreachable(false)
      return
    }
    if (status?.started_at && status.state !== 'running') dismissedStarts.add(status.started_at)
    const ticket = lost?.ticket ?? (status && status.state !== 'running' ? source ?? undefined : undefined)
    setLost(null)
    setStatus(null)
    setWaiting(null)
    if (ticket) {
      forgetRestore(ticket)
      setForgotten(n => n + 1)
    }
  }, [status, lost, waiting, source])

  const shown = status && status.state !== 'running' && status.started_at && dismissedStarts.has(status.started_at) ? null : status
  return { status: shown, lost, unreachable, waiting, dismiss }
}
