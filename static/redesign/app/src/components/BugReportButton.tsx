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
// Visual treatment: a small raised button in the corner. z-[40] — above
// page content, below modals (z-[60-80]), party drawer (z-[70]),
// server/notif panels (z-[45]), and the toast column (z-[200]). It sits
// 1.25rem above the corner, plus the phone's tab bar where there is one.

import { useEffect, useState } from 'react'
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
  // While the button is on the page, the page says so on its root: on a
  // phone the button floats over the end of the page, and the page leaves
  // room there so its last row can be scrolled clear of it (index.css,
  // `html[data-bug-launcher]`).
  useEffect(() => {
    if (hidden) return
    const root = document.documentElement
    root.setAttribute('data-bug-launcher', '')
    return () => root.removeAttribute('data-bug-launcher')
  }, [hidden])

  const handleSubmitted = (result: BugReportSubmitResult) => {
    // 2026-05-27 — Dropped the window.open(issue_url) — Aurora's
    // upstream GitHub repo is private, so the URL was a login wall
    // for most users. The modal now shows an in-modal thank-you
    // panel with the issue number; this toast is the subtle
    // confirmation that backs it up.
    onToast(`Bug reported as issue #${result.issue_number}. Thank you.`, 'success')
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
        // 2026-05-27 (deep-debug Phase 2 #1) — data-screenshot-exclude
        // signals to the in-modal html2canvas Capture flow that this
        // element should NOT appear in the screenshot. The Capture
        // handler's ignoreElements predicate filters on this attribute
        // so the bug-report meta-UI doesn't leak into bug evidence.
        data-screenshot-exclude="true"
        // In the bottom-right corner, where a "report" button is looked
        // for, above the phone's tab bar; the toasts stack above it
        // (App's ToastContainer). `display: none`, not an unmount, while
        // `hidden`: the dialog's state must outlive a player opening over
        // it (see the note at the top of this file).
        // `bottom` is a class, not an inline style: its height and its gap
        // are the figures index.css reserves at the end of the page.
        style={hidden ? { display: 'none' } : undefined}
        className="fixed bottom-[calc(1.25rem+var(--tabbar-space,0px))] right-6 z-[40] inline-flex h-11 items-center gap-2 rounded-control bg-surface-raised-2 px-3.5 text-[13px] font-medium text-ink-2 shadow-[shadow:var(--shadow-modal)] transition-colors hover:text-ink"
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
