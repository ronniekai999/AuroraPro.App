// One question in the app's dialog and the one request its answer sends.
//
// The dialog stays up while the request is out and says a refusal inside
// itself. If the request is slow, the dialog offers a way out
// (ConfirmDialog's `onStopWaiting`): it closes, sends and aborts nothing, and
// the panel says that the server is still being waited for; when the answer
// lands, what it did is said in the panel (a refusal as an alert there), so
// nobody is held in a dialog by a server that does not answer.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Failure } from './adminFailure'
import { FailureNote } from './AdminNotes'

export interface ConfirmedAction<T> {
  /** What the open question is about; null when none is open. */
  asked: T | null
  /** A request of this kind is out (its dialog may have been left). */
  busy: boolean
  /** Ask about `subject`. Ignored while a request of this kind is out: the
   *  question would open already waiting, and its way out would name the
   *  wrong thing. The opener says why through `openerProps`. */
  ask: (subject: T) => void
  /** Run the confirmed request. `send` does the request and whatever its
   *  success means (say it, read the list again) and answers the failure to
   *  say, or null when there is none (also when it closes the question for
   *  a reason of its own: the thing was gone). */
  run: (send: (subject: T) => Promise<Failure | null>) => Promise<void>
  /** Props for ConfirmDialog. */
  dialog: {
    open: boolean
    pending: boolean
    error: Failure | null
    onCancel: () => void
    onStopWaiting: () => void
  }
  /** For each button that asks this kind of question: it stays focusable
   *  while a request is out, ignores the press (`ask` does), and is
   *  described by the line that says what is still out. */
  openerProps: { 'aria-disabled'?: true; 'aria-describedby'?: string }
  /** What the panel says once the dialog has been left while its request
   *  was out: that it is still out, then a refusal, if one comes. */
  panelNotes: React.ReactNode
}

/** `waitingFor` names the request for "Still waiting for the server: …"
 *  ("deleting the library Movies"). `lateFailureInPanel: false` for a
 *  caller that says a late refusal itself (the restore's own record). */
export function useConfirmedAction<T>(waitingFor: (subject: T) => string, { lateFailureInPanel = true }: { lateFailureInPanel?: boolean } = {}): ConfirmedAction<T> {
  const [asked, setAsked] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Failure | null>(null)
  const [waiting, setWaiting] = useState<string | null>(null)
  const [lateFailure, setLateFailure] = useState<Failure | null>(null)
  const waitingId = useId()
  // What was SENT, kept apart from what is asked: the way out names it.
  const sent = useRef<T | null>(null)
  // The dialog was left while the request was out: its answer is said in
  // the panel, not in a dialog that is gone.
  const left = useRef(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const ask = useCallback((subject: T) => {
    if (busyRef.current) return
    setRefused(null)
    setLateFailure(null)
    setAsked(subject)
  }, [])

  const run = useCallback(async (send: (subject: T) => Promise<Failure | null>) => {
    const subject = asked
    if (subject === null || busyRef.current) return
    left.current = false
    sent.current = subject
    busyRef.current = true
    setBusy(true)
    setRefused(null)
    setLateFailure(null)
    const failure = await send(subject)
    busyRef.current = false
    if (!mounted.current) return
    setBusy(false)
    if (left.current) {
      setWaiting(null)
      if (failure && lateFailureInPanel) setLateFailure(failure)
      return
    }
    if (failure) setRefused(failure)
    else setAsked(null)
  }, [asked, lateFailureInPanel])

  return {
    asked,
    busy,
    ask,
    run,
    dialog: {
      open: asked !== null,
      pending: busy,
      error: refused,
      onCancel: () => { setAsked(null); setRefused(null) },
      onStopWaiting: () => {
        left.current = true
        if (sent.current !== null) setWaiting(waitingFor(sent.current))
        setAsked(null)
      },
    },
    openerProps: busy ? { 'aria-disabled': true, 'aria-describedby': waitingId } : {},
    panelNotes: (
      <>
        {waiting && <p id={waitingId} role="status" className="text-[14px] leading-snug text-ink">Still waiting for the server: {waiting}.</p>}
        <FailureNote failure={lateFailure} />
      </>
    ),
  }
}
