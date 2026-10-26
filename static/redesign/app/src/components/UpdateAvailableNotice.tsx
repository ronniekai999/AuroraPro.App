// "Aurora was updated" — shown when the server serves a newer build than the
// one this tab is running (lib/buildUpdate.ts). It stays until the user
// reloads or dismisses it: the toasts' three-second timer would let it vanish
// unread, and reloading by itself would lose what they were doing.
//
// z-[58]: above the page and the top bar (.stage-topnav is 51), below the
// player (z-[60]), every dialog (75 and up), the toasts and the bug-report
// recording pill, so it never covers the player's controls or a modal and
// waits behind them until they close.

import { useNewBuildAvailable } from '@/lib/buildUpdate'
import { Icon } from '@/components/Icon'

const MESSAGE = 'Aurora was updated. Reload to use the current version.'

export function UpdateAvailableNotice() {
  const { available, dismiss } = useNewBuildAvailable()
  return (
    <>
      {/* Always mounted, so screen readers announce the message when it
          arrives (a live region inserted already filled is often not read),
          and only the message, as the toasts do. */}
      <p className="sr-only" role="status">{available ? MESSAGE : ''}</p>
      {available && (
        // Centred by the wrapper, not a translate on the card: .toast's
        // entrance animation holds `transform: none` when it finishes.
        <div
          className="fixed inset-x-0 top-4 z-[58] flex justify-center px-4 pointer-events-none"
          data-screenshot-exclude="true"
        >
          <div className="toast pointer-events-auto max-w-full">
            <p className="text-white/80 text-sm">{MESSAGE}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="stage-btn stage-btn-sm stage-btn-primary flex-shrink-0"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss update notice"
              className="w-7 h-7 rounded-md inline-flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.06] transition-colors flex-shrink-0"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
