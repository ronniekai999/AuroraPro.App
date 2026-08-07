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
//
// Issue #445 — "dismiss" was only ever half implemented. Escape-while-focused and
// the X button closed these panels; clicking anywhere else on the page did not,
// which is the one gesture every user reaches for first. The outside-click half
// lives here rather than in either panel so both inherit it, and it stays a
// document listener: NO full-screen backdrop element, because a backdrop would
// re-introduce exactly the inertness these panels' z-45 layering was chosen to
// avoid (BUG-005 again).

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

    // Cleared by the outside-pointer path below, and by nothing else. A pointer
    // dismissal aimed at inert background should leave focus where the pointer
    // put it — yanking a focus ring back onto the bell is not what the user
    // asked for. ProfileSwitcher's own outside-click handler documents the same
    // policy ("a click outside is a pointer interaction, so don't yank focus
    // back to the trigger"). Keyboard/Escape/X-button closes are untouched: they
    // still restore, which is the whole APG contract this hook exists to honour.
    //
    // A local, not a ref, so it resets for free on every open — the effect
    // re-runs on `open` and gets a fresh one.
    let restoreFocus = true

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

    // Does `start` sit inside the control that OWNS this panel? Derived from the
    // ARIA wiring TopNav already publishes — each trigger carries
    // `aria-controls={open ? '<panel id>' : undefined}` — so the hook needs no
    // second ref threaded down from the call sites and no knowledge of TopNav.
    //
    // This guard is load-bearing, not defensive. Both triggers are TOGGLES
    // (`onClick={() => setNotifOpen(!notifOpen)}`), and mousedown precedes
    // click: without it, pressing the bell to close would close on mousedown and
    // the very next click — now seeing a CLOSED panel — would re-open it, so the
    // panel would look stuck open and the whole fix would look like it did
    // nothing. (The dismissal listens on mousedown to match every other
    // outside-click site here — AdminView's UserRowMenu, TopNav's AvatarMenu,
    // ProfileSwitcher — which is also what makes a drag that starts inside the
    // panel and ends outside it not count as a dismissal.)
    const ownsThisPanel = (start: Node | null): boolean => {
      // Anonymous panels (no id) can't be claimed by any trigger; skip rather
      // than match `aria-controls=""` on everything.
      if (!node?.id) return false
      let el: Element | null = start && start.nodeType === 1
        ? (start as Element)
        : (start?.parentElement ?? null)
      for (; el; el = el.parentElement) {
        // `aria-controls` is a space-separated ID list per ARIA, even though
        // every trigger here names exactly one panel.
        const controls = el.getAttribute('aria-controls')
        if (controls && controls.split(/\s+/).includes(node.id)) return true
      }
      return false
    }

    // Bubble phase, like every other outside-click site in this codebase. The
    // listener only exists while the panel is open (the effect returns early
    // otherwise), so there is no separate `open` check to make here.
    const onPointerDown = (e: MouseEvent) => {
      if (!node) return
      const target = e.target as Node | null
      // Inside the panel — including its own scrollbar, whose mousedown targets
      // the scrollable element itself. This is the case a backdrop element
      // handles for you and why click-outside is easy to get wrong.
      if (target && node.contains(target)) return
      if (ownsThisPanel(target)) return
      restoreFocus = false
      onCloseRef.current()
    }
    document.addEventListener('mousedown', onPointerDown)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointerDown)
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
      //
      // `restoreFocus` is the third exception, added with the outside-click
      // dismissal. That path tears the panel out from under the element that
      // held focus, so `focusLost` is true and the restore would otherwise fire
      // — dragging a focus ring onto the trigger the user just pointed away
      // from. Where the outside target takes focus itself the browser corrects
      // that a moment later, but where it deliberately does not (SearchPalette
      // preventDefaults mousedown on its options to keep focus in the input)
      // the stolen focus simply stays stolen.
      const active = document.activeElement
      const focusLost = !active || active === document.body
      if (restoreFocus && opener?.isConnected && (node?.contains(active) || focusLost)) {
        opener.focus({ preventScroll: true })
      }
    }
    // `open` only. See the onCloseRef note above; `ref` is a stable object.
  }, [open, ref])
}
