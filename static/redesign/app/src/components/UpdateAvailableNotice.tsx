// "Aurora was updated" — shown when the server serves a newer build than the
// one this tab is running (lib/buildUpdate.ts). It stays until the user
// reloads or dismisses it: the toasts' three-second timer would let it vanish
// unread, and reloading by itself would lose what they were doing.
//
// Top centre rather than the toasts' corner: the player's controls sit along
// the bottom edge, and a persistent card there would cover the scrub bar.

import { useNewBuildAvailable } from '@/lib/buildUpdate'
import { Icon } from '@/components/Icon'

export function UpdateAvailableNotice() {
  const { available, dismiss } = useNewBuildAvailable()
  if (!available) return null
  // Centred by the wrapper, not a translate on the card: .toast's entrance
  // animation holds `transform: none` when it finishes, which would cancel it.
  return (
    <div
      className="fixed inset-x-0 top-4 z-[210] flex justify-center px-4 pointer-events-none"
      data-screenshot-exclude="true"
    >
      <div className="toast pointer-events-auto max-w-full">
        <p className="text-white/80 text-sm" role="status">
          Aurora was updated. Reload to use the current version.
        </p>
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
  )
}
