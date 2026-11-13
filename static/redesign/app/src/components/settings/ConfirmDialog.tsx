// "Are you sure?" for the things in Settings that cannot be taken back, or
// that reach further than the press suggests: deleting a profile or a list,
// disconnecting a way to sign in, loosening a limit, signing out everywhere.
//
// The app's alert dialog: focus goes into it (onto the answer that changes
// nothing), stays in it, and Escape and the cancel button close it. It is
// opened by state, not by a trigger of its own, so where focus goes when it
// closes is said here (lib/returnFocus).

import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { useReturnFocus } from '@/lib/returnFocus'
import { cn } from '@/lib/utils'

interface WordsProps {
  open: boolean
  title: string
  children: ReactNode
  details?: ReactNode
  error?: ReactNode
  pending: boolean
  /** The answer's request has been out long enough that the other button is
   *  now a way out of the dialog (it sends and aborts nothing). */
  wayOut: string | null
  confirmLabel: string
  cancelLabel: string
  destructive: boolean
  safeFirst: boolean
  onConfirm: () => void
}

// What the dialog says. Not drawn again once the dialog is closing: by then
// the caller's state has moved on (the list it named is gone, the choice it
// asked about is put back), and the question must not change under the
// reader while it fades out.
const Words = memo(function Words({ title, children, details, error, pending, wayOut, confirmLabel, cancelLabel, destructive, safeFirst, onConfirm }: WordsProps) {
  // While the answer's request is out the buttons keep the focus they have
  // (a disabled button drops it) and say they do nothing.
  const waiting = pending ? 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50' : ''
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle className="font-display text-[22px] leading-tight">{title}</AlertDialogTitle>
        <AlertDialogDescription className="text-[15px] leading-relaxed text-ink-2">{children}</AlertDialogDescription>
      </AlertDialogHeader>
      {details}
      {/* Why the last answer was refused. The dialog stays, so the question
          can be answered again, or put down. */}
      {error && <div role="alert" className="text-[14px] leading-snug">{error}</div>}
      {/* Stacked, on a phone, the buttons are drawn last first, which puts
          the confirm button on top. `safeFirst` keeps them in their own
          order there: the answer that changes nothing on top. */}
      <AlertDialogFooter className={safeFirst ? 'flex-col' : undefined}>
        <AlertDialogCancel className={`h-11 ${wayOut ? '' : waiting}`} aria-disabled={(pending && !wayOut) || undefined}>{wayOut ?? cancelLabel}</AlertDialogCancel>
        <AlertDialogAction className={buttonVariants({ variant: destructive ? 'destructive' : 'default', className: `h-11 ${waiting}` })} aria-disabled={pending || undefined} onClick={onConfirm}>
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}, (_shown, next) => !next.open)

/** How long a confirmed request may be out before the dialog offers a way
 *  out of waiting for it. */
export const WAY_OUT_AFTER_MS = 10_000

export function ConfirmDialog({ open, title, children, details, pending = false, error, onStopWaiting, stopWaitingLabel = 'Stop waiting', confirmLabel, cancelLabel = 'Cancel', destructive = false, safeFirst = false, onConfirm, onCancel, fallbackFocus, overlayClassName, contentClassName }: {
  open: boolean
  /** The question, naming what it is about ("Delete Kids?"). */
  title: string
  /** What happens, and what is lost. */
  children: ReactNode
  /** More of what is lost (a list), drawn under the description. */
  details?: ReactNode
  /** For a caller that keeps the dialog up while what it confirmed is sent:
   *  true while that request is out. Every answer is ignored meanwhile (the
   *  buttons, Escape), so the question cannot be answered twice; when it
   *  goes back to false with the dialog still open, it can be answered
   *  again. */
  pending?: boolean
  /** Why the server refused what was confirmed, said inside the dialog. */
  error?: ReactNode
  /** For a `pending` dialog: once its request has been out WAY_OUT_AFTER_MS,
   *  the other button (and Escape) becomes `stopWaitingLabel` and calls this.
   *  It must send nothing and abort nothing: it only lets the person go,
   *  and the caller says the outcome where they are when it lands. Without
   *  it a request that never answers holds the dialog for good. */
  onStopWaiting?: () => void
  stopWaitingLabel?: string
  confirmLabel: string
  cancelLabel?: string
  /** The confirm button is the red one. */
  destructive?: boolean
  /** On a phone, where the buttons stack, the cancel button is the upper
   *  one: for a question whose confirm is the answer to think twice about. */
  safeFirst?: boolean
  /** The confirm button was pressed. The caller closes the dialog. */
  onConfirm: () => void
  /** Closed any other way: the cancel button, Escape. */
  onCancel: () => void
  /** Where focus goes when the dialog closes and what opened it cannot take
   *  it back: it is gone (a Save button that goes with the choice it saved),
   *  or the browser never focused it. */
  fallbackFocus?: () => HTMLElement | null | undefined
  /** The layer, for a dialog asked from a surface that is itself drawn
   *  above the page (the onboarding overlay): its scrim's and its own. */
  overlayClassName?: string
  contentClassName?: string
}) {
  // The dialog also "closes" when its confirm button is pressed; that is not
  // a cancel. It also means a second press on the confirm button, while the
  // dialog fades out, is not a second confirmation.
  const confirmed = useRef(false)
  // Opened afresh, or a request it was kept up for has ended (refused) with
  // it still open: it can be answered again. Until then the confirm that
  // sent it stands, and every other answer (the buttons, Escape) is ignored.
  // A caller that does not pass `pending` never changes it, so for them a
  // confirm is final.
  useEffect(() => { if (open && !pending) confirmed.current = false }, [open, pending])
  const returnFocus = useReturnFocus(fallbackFocus)
  // The way out, once the request has been out long enough.
  const [waited, setWaited] = useState(false)
  const offersWayOut = onStopWaiting !== undefined
  // The confirm button closes the dialog too (Radix's Action), after its own
  // press: that close is not the way out.
  const confirmPressed = useRef(false)
  useEffect(() => {
    setWaited(false)
    if (!open || !pending || !offersWayOut) return
    const t = window.setTimeout(() => setWaited(true), WAY_OUT_AFTER_MS)
    return () => window.clearTimeout(t)
  }, [open, pending, offersWayOut])
  const wayOut = open && pending && waited && onStopWaiting ? stopWaitingLabel : null
  return (
    <AlertDialog open={open} onOpenChange={next => {
      if (next) return
      if (confirmPressed.current) { confirmPressed.current = false; return }
      // While the request is out nothing answers the dialog, until it offers
      // its way out; then the other button and Escape take it.
      if (pending) { if (wayOut) onStopWaiting?.(); return }
      if (!confirmed.current) onCancel()
    }}>
      {/* Scrolls inside itself when its words are taller than the window
          (a long list of what is lost, on a phone): centred, it would put
          its top, and its title, above the screen. */}
      <AlertDialogContent
        {...returnFocus}
        onOpenAutoFocus={() => {
          returnFocus.onOpenAutoFocus()
          // Taller than the window, the dialog scrolls: keep the answer that
          // has the focus in view (the question is its accessible name).
          window.requestAnimationFrame(() => {
            const el = document.activeElement
            if (el instanceof HTMLElement && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
          })
        }}
        overlayClassName={overlayClassName} className={cn('max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain', contentClassName)}>
        <Words
          open={open}
          title={title}
          confirmLabel={confirmLabel}
          cancelLabel={cancelLabel}
          destructive={destructive}
          safeFirst={safeFirst}
          details={details}
          error={error}
          pending={pending}
          wayOut={wayOut}
          onConfirm={() => {
            confirmPressed.current = true
            if (pending || confirmed.current) return
            confirmed.current = true
            onConfirm()
          }}
        >
          {children}
        </Words>
      </AlertDialogContent>
    </AlertDialog>
  )
}
