// "A new version of Aurora is ready": shown when the server serves a newer
// build than the one this tab is running (lib/buildUpdate.ts). It stays
// until the user reloads or dismisses it: a toast's timer would let it
// vanish unread, and reloading by itself would lose what they were doing.
//
// In the bottom left corner, where the toasts are; they stack above it while
// it is up (it says how tall it is, as measured, through
// --update-notice-space, which .toast-stack reads). z-[58]: above the page and the top bar (.stage-topnav
// is 51), below the player (z-[60]), every dialog (75 and up), the toasts
// and the bug-report recording pill, so it never covers the player's
// controls or a modal and waits behind them until they close.

import { useLayoutEffect, useRef } from 'react'
import { useNewBuildAvailable } from '@/lib/buildUpdate'
import { Icon } from '@/components/Icon'

const MESSAGE = 'A new version of Aurora is ready.'
/** One row of the card (a toast's min-height), where nothing can be
 *  measured, and the gap the stack keeps between two cards. */
const ROW_PX = 52
const GAP_PX = 12

export function UpdateAvailableNotice() {
  const { available, dismiss } = useNewBuildAvailable()
  // Room for it under the toasts: its own height, as drawn, and the gap to
  // the toast above it. Measured, and measured again when it changes: its
  // words wrap on a narrow phone, where it is taller than the one row
  // (52px) a fixed 64px allowed for, and a toast above it then touched it.
  const card = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!available) return
    const root = document.documentElement
    const el = card.current
    const say = () => {
      const h = el?.getBoundingClientRect().height || ROW_PX
      root.style.setProperty('--update-notice-space', `${Math.ceil(h) + GAP_PX}px`)
    }
    say()
    const watch = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(say) : null
    if (el) watch?.observe(el)
    return () => {
      watch?.disconnect()
      root.style.removeProperty('--update-notice-space')
    }
  }, [available])
  return (
    <>
      {/* Always mounted, so screen readers announce the message when it
          arrives (a live region inserted already filled is often not read),
          and only the message, as the toasts do. */}
      <p className="sr-only" role="status">{available ? MESSAGE : ''}</p>
      {available && (
        <div className="update-notice" data-screenshot-exclude="true" ref={card}>
          <div className="toast">
            <p className="toast-text">{MESSAGE}</p>
            <button type="button" onClick={() => window.location.reload()} className="toast-action is-primary">
              Reload
            </button>
            <button type="button" onClick={dismiss} aria-label="Dismiss update notice" className="toast-x">
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
