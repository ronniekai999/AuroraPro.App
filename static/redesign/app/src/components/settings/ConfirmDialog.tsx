// "Are you sure?" for the things in Settings that cannot be taken back, or
// that reach further than the press suggests: deleting a profile or a list,
// disconnecting a way to sign in, loosening a limit, signing out everywhere.
//
// The app's alert dialog: focus goes into it (onto the answer that changes
// nothing), stays in it, and Escape and the cancel button close it. Where
// focus goes afterwards is this file's job: the dialog is opened by state,
// not by a trigger of its own, and without one it would hand focus to
// nothing when it closes.

import { memo, useEffect, useRef, type ReactNode } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'

interface WordsProps {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel: string
  destructive: boolean
  onConfirm: () => void
}

// What the dialog says. Not drawn again once the dialog is closing: by then
// the caller's state has moved on (the list it named is gone, the choice it
// asked about is put back), and the question must not change under the
// reader while it fades out.
const Words = memo(function Words({ title, children, confirmLabel, cancelLabel, destructive, onConfirm }: WordsProps) {
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle className="font-display text-[22px] leading-tight">{title}</AlertDialogTitle>
        <AlertDialogDescription className="text-[15px] leading-relaxed text-ink-2">{children}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel className="h-11">{cancelLabel}</AlertDialogCancel>
        <AlertDialogAction className={buttonVariants({ variant: destructive ? 'destructive' : 'default', className: 'h-11' })} onClick={onConfirm}>
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  )
}, (_shown, next) => !next.open)

export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = 'Cancel', destructive = false, onConfirm, onCancel, fallbackFocus }: {
  open: boolean
  /** The question, naming what it is about ("Delete Kids?"). */
  title: string
  /** What happens, and what is lost. */
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** The confirm button is the red one. */
  destructive?: boolean
  /** The confirm button was pressed. The caller closes the dialog. */
  onConfirm: () => void
  /** Closed any other way: the cancel button, Escape. */
  onCancel: () => void
  /** Where focus goes when the dialog closes and what opened it is no
   *  longer there to take it back (a Save button that goes with the choice
   *  it saved). */
  fallbackFocus?: () => HTMLElement | null | undefined
}) {
  // The dialog also "closes" when its confirm button is pressed; that is not
  // a cancel. It also means a second press on the confirm button, while the
  // dialog fades out, is not a second confirmation.
  const confirmed = useRef(false)
  useEffect(() => { if (open) confirmed.current = false }, [open])
  const opener = useRef<HTMLElement | null>(null)
  return (
    <AlertDialog open={open} onOpenChange={next => { if (!next && !confirmed.current) onCancel() }}>
      <AlertDialogContent
        // Runs before focus moves into the dialog: what has it now is what
        // opened the dialog.
        onOpenAutoFocus={() => {
          const el = document.activeElement
          opener.current = el instanceof HTMLElement && el !== document.body ? el : null
        }}
        onCloseAutoFocus={e => {
          e.preventDefault()
          const from = opener.current
          opener.current = null
          // The caller has already put focus somewhere on purpose.
          if (document.activeElement && document.activeElement !== document.body) return
          const back = from && from.isConnected && !from.matches(':disabled') ? from : fallbackFocus?.()
          back?.focus()
        }}
      >
        <Words
          open={open}
          title={title}
          confirmLabel={confirmLabel}
          cancelLabel={cancelLabel}
          destructive={destructive}
          onConfirm={() => {
            if (confirmed.current) return
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
