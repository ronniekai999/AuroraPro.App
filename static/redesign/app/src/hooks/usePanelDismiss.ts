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

import { useEffect, useRef, type RefObject } from 'react'

export function usePanelDismiss(
  open: boolean,
  onClose: () => void,
  ref: RefObject<HTMLElement | null>,
) {
  // `onClose` is an inline arrow at both call sites, so a new identity every App
  // render. Depending on it directly made this effect tear down and re-run
  // constantly — and the cleanup below moves focus, so each re-run yanked the
  // user's position out of the panel and the rAF dragged it back to the
  // container. Measured: focus visits an element OUTSIDE the dialog in between.
  //
  // Not hypothetical. App rotates the home hero every 9 seconds, so opening
  // either panel from Home fired this on a loop for as long as it stayed open;
  // NotificationPanel's own open effect triggers it too via onMarkAllRead.
  // Exactly the failure SearchPalette documents at length ("Phase 9 reintroduced
  // the failure Phase 7b had documented") and that NotificationPanel's
  // neighbouring effect already dodges with a ref. This hook was written thirty
  // lines away from both and repeated it.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    // Captured NOW, not read in the cleanup. Both panels are `if (!open) return
    // null`, so React detaches the host ref during the mutation phase and
    // `ref.current` is already null by the time this effect's passive cleanup
    // runs — the restore guard short-circuited on `undefined` and focus fell to
    // <body> on EVERY close. The hook's headline promise never once happened.
    const node = ref.current

    // Focus the panel itself rather than its first control. The first control in
    // both of these is the Close button, and landing there announces "Close" as
    // the panel's opening word — the container, which carries the aria-label, is
    // what a reader should meet first. Requires tabIndex={-1} on the panel.
    const raf = requestAnimationFrame(() => node?.focus({ preventScroll: true }))

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!node) return
      // Only when the panel actually owns focus. These are non-modal and several
      // other Escape handlers are live at once (App's view-level handler, the
      // palette's); swallowing every Escape from a panel that happens to be open
      // in the background is the bug ContextMenu's `stopPropagation` fixed from
      // the other direction.
      if (!node.contains(document.activeElement)) return
      e.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey)
      // Restore when the opener is still around AND focus either is still inside
      // the panel, or has been LOST — `<body>` or nothing.
      //
      // The second half is what makes this work on the close path, and capturing
      // `node` was not enough on its own. On unmount React removes the panel's DOM
      // before this passive cleanup runs, so the element that had focus (the Close
      // button the user just pressed) is already detached and `document
      // .activeElement` has already fallen back to `<body>`. Testing only
      // `node.contains(activeElement)` is therefore false at exactly the moment the
      // restore is needed. A test written for this hook caught that the first fix
      // was still inverted.
      //
      // The `focusLost` half is also what keeps the guard honest in the other
      // direction: if the user closed the panel by clicking some other control,
      // focus is on THAT control — neither inside the panel nor lost — so we leave
      // it alone rather than yanking it back to the trigger.
      const active = document.activeElement
      const focusLost = !active || active === document.body
      if (opener?.isConnected && (node?.contains(active) || focusLost)) {
        opener.focus({ preventScroll: true })
      }
    }
    // `open` only. See the onCloseRef note above; `ref` is a stable object.
  }, [open, ref])
}
