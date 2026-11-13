// The server's record of the latest database restore, as this browser can
// read it (lib/restoreStatus.ts says why there are two reads).
//
// With a ticket kept, it reads by ticket: that read needs no session, so it
// works on the sign-in page and while the restore has the database, and it
// never sets off the session-expiry path a refused admin read would. Without
// one, and only where `adminRead` is given (the Admin page), it reads through
// the admin route. It reads again every few seconds while the restore runs,
// and while a kept ticket's read gets no answer (Aurora restarting, a
// network drop); an admin read that fails is not retried unless the restore
// was last seen running, since a refused one would only be refused again.

import { useCallback, useEffect, useState } from 'react'
import {
  forgetRestore, noteRestoreSeen, readRestoreByTicket, rememberedRestore,
  type RememberedRestore, type RestoreStatus,
} from '@/lib/restoreStatus'

export const RESTORE_POLL_MS = 5000

export interface RestoreRecord {
  /** The server's record, once read; null for none, or one put away. */
  status: RestoreStatus | null
  /** A kept ticket the server no longer knows, while that is worth saying:
   *  the restore was never seen to end. */
  lost: RememberedRestore | null
  /** The latest read got no answer, or was refused. */
  unreachable: boolean
  /** A kept ticket whose record has not been read yet because Aurora has not
   *  answered: there is a restore to ask about, and no word on it yet. */
  waiting: RememberedRestore | null
  /** Puts the record away: a kept ticket is forgotten, and the same restore
   *  is not shown again in this tab. */
  dismiss: () => void
}

// Restores put away in this tab, by start time. Module state: the record
// outlives the panel that showed it.
const dismissedStarts = new Set<string>()

/** Tests only. */
export function resetRestoreRecordForTest(): void {
  dismissedStarts.clear()
}

export function useRestoreRecord({ adminRead, recheck = 0 }: {
  adminRead?: (signal: AbortSignal) => Promise<RestoreStatus>
  /** Changed to read again at once (a restore in this tab started or ended). */
  recheck?: number
}): RestoreRecord {
  const [status, setStatus] = useState<RestoreStatus | null>(null)
  const [lost, setLost] = useState<RememberedRestore | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const [waiting, setWaiting] = useState<RememberedRestore | null>(null)
  // The ticket `status` was read with (null for the admin read): Dismiss
  // forgets that one only, never a newer one another tab has kept since.
  const [source, setSource] = useState<string | null>(null)
  // Bumped when a ticket is forgotten, so the reads start again without it.
  const [forgotten, setForgotten] = useState(0)

  useEffect(() => {
    const kept = rememberedRestore()
    if (!kept && !adminRead) {
      setStatus(null)
      return
    }
    const ac = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastState: RestoreStatus['state'] | null = null
    let byTicket = !!kept
    const again = () => { timer = setTimeout(() => { void ask() }, RESTORE_POLL_MS) }
    const ask = async () => {
      try {
        let st: RestoreStatus | null
        if (kept && byTicket) {
          st = await readRestoreByTicket(kept.ticket, ac.signal)
          if (ac.signal.aborted) return
          if (!st) {
            const seen = rememberedRestore()?.ticket === kept.ticket ? rememberedRestore()!.seen : kept.seen
            setUnreachable(false)
            setWaiting(null)
            setStatus(null)
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
        setWaiting(null)
        setUnreachable(false)
        setStatus(st)
        if (st.state === 'running') again()
      } catch {
        if (ac.signal.aborted) return
        setUnreachable(true)
        if (kept && byTicket && lastState === null) setWaiting(kept)
        // A ticket read has no session to upset; an admin read that was
        // refused would only be refused again, unless a restore was running.
        if ((kept && byTicket) || lastState === 'running') again()
      }
    }
    void ask()
    return () => {
      ac.abort()
      clearTimeout(timer)
    }
  }, [adminRead, recheck, forgotten])

  const dismiss = useCallback(() => {
    if (status?.started_at && status.state !== 'running') dismissedStarts.add(status.started_at)
    const ticket = lost?.ticket ?? (status && status.state !== 'running' ? source ?? undefined : undefined)
    setLost(null)
    setStatus(null)
    setWaiting(null)
    if (ticket) {
      forgetRestore(ticket)
      setForgotten(n => n + 1)
    }
  }, [status, lost, source])

  const shown = status && status.state !== 'running' && status.started_at && dismissedStarts.has(status.started_at) ? null : status
  return { status: shown, lost, unreachable, waiting, dismiss }
}
