// Phase 11.4 — the focus contract for NON-MODAL dropdown panels.
//
// `ServerPanel` and `NotificationPanel` each render `role="dialog"` with zero
// focus() calls, no Escape handler and no restore. A reviewer grepped both and
// found the gap; TopNav's `openPanel` even documents it, having previously
// claimed the opposite ("the panels this opens manage their own focus" — they do
// not). The result: activating a row opens a dialog while focus stays on a
// trigger whose `aria-expanded` just went false, so a screen-reader user gets no
// announcement and no route in, and Escape does nothing.
//
// DELIBERATELY NOT A FOCUS TRAP, and not `aria-modal`. These panels sit at z-45,
// BELOW the sticky nav stack, specifically so the nav's own triggers stay
// clickable while one is open — that was the point of BUG-005. Trapping focus or
// declaring `aria-modal` would tell assistive tech the rest of the page is inert
// when it is not, which is a worse lie than the current silence. The APG contract
// for a non-modal dialog is: move focus in, let Escape dismiss, put focus back.

import { useEffect, type RefObject } from 'react'

export function usePanelDismiss(
  open: boolean,
  onClose: () => void,
  ref: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null

    // Focus the panel itself rather than its first control. The first control in
    // both of these is the Close button, and landing there announces "Close" as
    // the panel's opening word — the container, which carries the aria-label, is
    // what a reader should meet first. Requires tabIndex={-1} on the panel.
    const raf = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }))

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Only when the panel actually owns focus. These are non-modal and several
      // other Escape handlers are live at once (App's view-level handler, the
      // palette's); swallowing every Escape from a panel that happens to be open
      // in the background is the bug ContextMenu's `stopPropagation` fixed from
      // the other direction.
      if (!ref.current?.contains(document.activeElement)) return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey)
      // Restore only if the opener is still in the document AND focus is still
      // inside the panel we are tearing down. Without the second test, closing
      // the panel by clicking something else would yank focus off whatever the
      // user just clicked.
      if (opener?.isConnected && ref.current?.contains(document.activeElement)) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [open, onClose, ref])
}
