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
    // 2026-05-27 — Dropped the window.open(issue_url) — Aurora's
    // upstream GitHub repo is private, so the URL was a login wall
    // for most users. The modal now shows an in-modal thank-you
    // panel with the issue number; this toast is the subtle
    // confirmation that backs it up.
    onToast(`Bug reported — issue #${result.issue_number} created. Thanks!`, 'success')
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
        // left-4` was buried behind the sidebar; bottom-right keeps
        // the launcher in clear space.
        //
        // 2026-05-27 polish pass:
        // - `bottom: 1.25rem` (was 5rem) — the launcher reclaims its
        //   natural corner anchor. The earlier 5rem position was a
        //   well-intentioned over-correction: it kept the pill above
        //   the toast column but floated it in mid-air over content
        //   instead of hugging the corner where users expect a
        //   "report" pill (Intercom / Linear / Vercel pattern).
        //   Toasts shifted upward in App.tsx ToastContainer to
        //   `bottom-[5.5rem]` so they stack ABOVE the launcher
        //   instead of covering it.
        // - Inline `bottom` still resolves to `max(corner, corner +
        //   safe-area)` so iOS Safari home-indicator gesture region
        //   doesn't steal taps.
        // - Subtle purple accent border (was pure white/8%): the
        //   launcher was almost invisible against Aurora's dark UI;
        //   `border-purple-500/20` adds just enough chroma to draw
        //   the eye without shouting. Hover deepens to purple/40.
        // - Holistic deep-debug H2/M1 retained — `display: none`
        //   (not conditional unmount) when `hidden` so the modal
        //   state persists across player open/close events.
        style={{
          bottom: 'max(1.25rem, calc(1.25rem + env(safe-area-inset-bottom, 0px)))',
          ...(hidden ? { display: 'none' } : {}),
        }}
        className="fixed right-6 z-[40] inline-flex items-center gap-2 px-3 py-2 rounded-full bg-white/[0.05] hover:bg-purple-500/15 border border-purple-500/20 hover:border-purple-500/40 text-white/70 hover:text-white text-xs font-medium transition-ui backdrop-blur-md shadow-lg"
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
