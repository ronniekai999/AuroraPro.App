// BugReportButton — floating bottom-RIGHT launcher for the bug-report
// modal. Hidden when the operator hasn't enabled the feature flag,
// AND visually hidden when other surfaces compete for the
// bottom-right / right-edge real estate (video player, server status
// panel, notifications panel, party drawer). PR #107 moved this
// from bottom-LEFT (where the sidebar buried it at higher z); PR
// #107 follow-up restored mobile/party gating per deep-debug.
//
// The launcher button itself toggles visibility via `display: none`
// while `hidden` is true — but the COMPONENT stays mounted, and so
// does its `modalOpen` state. This is important for the screen-
// recording flow: a watch-party event that opens the player mid-
// recording would have unmounted us under the old gate, silently
// killing the in-flight recording. Now the modal stays mounted and
// the recording completes normally. (Holistic deep-debug M1.)
//
// Visual treatment: small subtle pill. z-[40] — above page content,
// below modals (z-[60-80]), party drawer (z-[70]), server/notif
// panels (z-[45]), and the toast column (z-[200]). Position is
// `right-6, bottom: max(5rem, 5rem + safe-area-inset-bottom)` so
// the pill clears the toast column AND the iOS home-indicator
// gesture region.

import { useState } from 'react'
import { BugReportModal } from './BugReportModal'
import type { BugReportSubmitResult } from '@/lib/api'

interface Props {
  // Pre-fill the "Your name" field in the modal so reports carry
  // submitter context. Optional — modal accepts undefined.
  prefillName?: string
  // Parent App's toast pusher so we can show the issue URL on success.
  // Receives the message + a 'success' type; if the toast widget
  // doesn't natively support links, the URL is appended in plain text.
  onToast: (message: string, type: 'success' | 'error' | 'info') => void
  // Hide the launcher pill while another full-screen / right-edge
  // surface is open (video player, server status panel, notif
  // panel, watch-party drawer). Component stays mounted so the
  // modal can outlive the visibility change — see file-level
  // comment.
  hidden?: boolean
  // 2026-05-27 — PAT health diagnostics, populated by the server
  // only for admin requesters. Forwarded to the modal so the
  // amber warning banner can render when the configured GitHub
  // token is expired / revoked / missing scope. Undefined for
  // non-admins.
  tokenHealthy?: boolean
  tokenHealthReason?: string
  // 2026-05-27 (deep-debug M1) — App-provided callback to refresh
  // the bug-report config. The server's health check updates
  // tokenHealthy every 6h on its own ticker; the frontend would
  // otherwise hold whatever value was returned at login forever.
  // We trigger a refetch on modal-open so an admin who opens the
  // modal hours after login sees the current health state.
  onRefreshConfig?: () => void
}

export function BugReportButton({ prefillName, onToast, hidden, tokenHealthy, tokenHealthReason, onRefreshConfig }: Props) {
  const [modalOpen, setModalOpen] = useState(false)

  const handleSubmitted = (result: BugReportSubmitResult) => {
    // Deep-debug #6 — the toast widget renders message text as
    // inert text (not auto-linkified), so a URL in the toast is a
    // dead string the user has ~3s to memorize. Open the issue in
    // a new tab immediately so the user can verify the report
    // landed; the toast becomes a confirmation rather than the
    // only access path.
    //
    // Use 'noopener,noreferrer' so the new tab can't access this
    // window's window.opener (security best practice for any
    // user-driven new-tab open).
    try {
      window.open(result.issue_url, '_blank', 'noopener,noreferrer')
    } catch {
      // Popup blocker / browser refusal — fall through to the toast
      // text so the URL is at least visible somewhere.
    }
    onToast(`Bug reported — issue #${result.issue_number} created. Opened in a new tab.`, 'success')
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          // Deep-debug M1 — refresh config so the modal's
          // admin-only PAT health banner reflects the latest
          // server-side check (the 6h background ticker may have
          // updated tokenHealthy since the user logged in). Fire-
          // and-forget; the modal still opens immediately and
          // re-renders when the new config lands.
          onRefreshConfig?.()
          setModalOpen(true)
        }}
        title="Report a bug or share feedback"
        aria-label="Report a bug"
        // 2026-05-27 (deep-debug Phase 2 #1) — data-screenshot-exclude
        // signals to the in-modal html2canvas Capture flow that this
        // element should NOT appear in the screenshot. The Capture
        // handler's ignoreElements predicate filters on this attribute
        // so the bug-report meta-UI doesn't leak into bug evidence.
        data-screenshot-exclude="true"
        // 2026-05-27 — Bottom-right launcher. Original `bottom-4
        // left-4` was buried behind the left sidebar; bottom-right
        // keeps the launcher in clear space.
        //
        // PR #107 follow-up (deep-debug M2/M3):
        // - `bottom: 5rem` (was `bottom-4`) so the launcher sits
        //   ABOVE the toast column (`bottom-6 right-6`, toasts ~52px
        //   tall stacking upward to ~y=76). Previous `bottom-4`
        //   placed the pill at y=16-50 which overlapped toasts by
        //   ~24px; toasts win on z (200 vs 40) and would temporarily
        //   bury the launcher on every notification.
        // - Inline `bottom` resolves to `max(5rem, 5rem + safe-area)`
        //   so on iOS Safari the home-indicator gesture region
        //   (bottom 8-15px) doesn't steal taps. The wider Aurora UI
        //   doesn't handle safe-area yet; the launcher does because
        //   it's the lowest-Y interactive element on the right.
        // - Holistic deep-debug H2/M1 retained — `display: none`
        //   (not conditional unmount) when `hidden` so the modal
        //   state persists across player open/close events.
        style={{
          bottom: 'max(5rem, calc(5rem + env(safe-area-inset-bottom, 0px)))',
          ...(hidden ? { display: 'none' } : {}),
        }}
        className="fixed right-6 z-[40] inline-flex items-center gap-2 px-3 py-2 rounded-full bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] hover:border-white/[0.15] text-white/60 hover:text-white text-xs font-medium transition-all backdrop-blur-md shadow-lg"
      >
        {/* Inline SVG so the button has zero icon-component dependency.
            Bug icon = stylized beetle with antennae and legs (Feather's
            "bug" path, simplified). */}
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="8" y="6" width="8" height="14" rx="4" />
          <path d="M19 7l-3 2M5 7l3 2M19 13h-3M8 13H5M19 19l-3-2M5 19l3-2M12 6V3M9 3h6" />
        </svg>
        Report bug
      </button>
      {modalOpen && (
        <BugReportModal
          prefillName={prefillName}
          onClose={() => setModalOpen(false)}
          onSubmitted={handleSubmitted}
          tokenHealthy={tokenHealthy}
          tokenHealthReason={tokenHealthReason}
        />
      )}
    </>
  )
}
