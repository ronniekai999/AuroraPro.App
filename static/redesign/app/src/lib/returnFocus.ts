// Where focus goes when a dialog closes, for a dialog that is opened by
// state and not by a trigger of its own. The dialog primitives give focus
// back to their trigger; with no trigger they give it to nothing, and the
// next Tab starts from the top of the page.

import { useRef } from 'react'

/** Handlers for a dialog's content (`onOpenAutoFocus`, `onCloseAutoFocus`).
 *  What had focus when the dialog opened gets it back when it closes. When
 *  that is gone, disabled, or was never focused (Safari does not focus a
 *  button on a click), `fallback` says where focus goes instead. Focus the
 *  caller has already put somewhere on purpose is left there. */
export function useReturnFocus(fallback?: () => HTMLElement | null | undefined) {
  const opener = useRef<HTMLElement | null>(null)
  return {
    // Runs before focus moves into the dialog: what has it now is what
    // opened the dialog.
    onOpenAutoFocus: () => {
      const el = document.activeElement
      opener.current = el instanceof HTMLElement && el !== document.body ? el : null
    },
    onCloseAutoFocus: (e: Event) => {
      e.preventDefault()
      const from = opener.current
      opener.current = null
      if (document.activeElement && document.activeElement !== document.body) return
      const back = from && from.isConnected && !from.matches(':disabled') ? from : fallback?.()
      back?.focus()
    },
  }
}
