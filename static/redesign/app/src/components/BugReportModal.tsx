// BugReportModal — Phases 1 + 2 + 3.
//
// Centered overlay modal with a focused 4-field form: name (prefilled
// from user's display username so emails don't leak into public/
// triage view), title, description, optional attachment from disk OR
// from a live "Capture this page" screenshot (Phase 2) OR from a
// "Record screen" capture via MediaRecorder + getDisplayMedia (Phase
// 3, 30s cap, WebM). On submit, POSTs multipart to /api/feedback; on
// success, shows the returned issue URL as a clickable toast
// deep-link.
//
// Pattern mirrors CollectionsModal.tsx (same z-[70], click-outside,
// submitting/error flags).
//
// Accessibility (deep-debug #5):
//   - Escape closes the modal (unless submitting; matches the
//     click-outside behavior)
//   - Auto-focus the Title field on open
//   - Restore focus on close to what opened the dialog, or where the
//     caller says when that is gone (see the mount effect below)
//   - role/aria already set; aria-live error region announces
//     validation failures

import { useEffect, useRef } from 'react'
import type { BugReportSubmitResult } from '@/lib/api'
import {
  BugReportFields, BugReportRecordingPill, BugReportSent, BugReportTokenNotice, useBugReportForm,
} from './BugReportForm'

interface Props {
  // Prefill the "Your name" field. Should be the user's DISPLAY
  // username, NOT their email — the field's value lands in the
  // public GitHub issue body. (deep-debug #7)
  prefillName?: string
  onClose: () => void
  // Called on successful submission with the GH issue link/number so
  // the parent can pop a toast deep-linking to the issue.
  onSubmitted: (result: BugReportSubmitResult) => void
  // 2026-05-27 — PAT health diagnostics, populated only when the
  // requester is an admin. When tokenHealthy === false, the modal
  // renders an amber banner above the form with the reason so the
  // admin can act on the misconfig before users hit the submit-time
  // 5xx. Undefined for non-admins / pre-first-check.
  tokenHealthy?: boolean
  tokenHealthReason?: string
  // Puts the focus somewhere when the dialog closes and what opened it
  // cannot take it back: it is gone from the page (the Me page's row, once
  // the app has gone back to the page the report is about), or nothing had
  // the focus when the dialog opened.
  focusFallback?: () => void
  // The session the dialog was opened in is no longer the one on screen (a
  // switch of profile made in another tab). The dialog calls onClose as
  // soon as nothing of its own is in flight: a send under way finishes
  // first, and a recording is stopped.
  dismissed?: boolean
  // Called in place of onClose when it is the dismissal that closes the
  // dialog, and not the person. `unsent` is why the last send failed, when
  // one did and nothing has been sent since: the dialog is going, and its
  // refusal with it, so the caller has to say that the report was not sent.
  onDismissed?: (unsent: string | null) => void
}

export function BugReportModal({ prefillName, onClose, onSubmitted, tokenHealthy, tokenHealthReason, focusFallback, dismissed = false, onDismissed }: Props) {
  // The form's state and work: components/BugReportForm. This is its frame.
  const form = useBugReportForm({ prefillName, onClose, onSubmitted, dismissed, onDismissed })
  const { submitting, capturing, recording, submittedResult, submittingRef, capturingRef, recordingRef, titleInputRef } = form
  // Modal root ref for focus-trap. Deep-debug #5.
  const rootRef = useRef<HTMLDivElement>(null)
  // Track the element that opened us so focus returns there on close.
  // Deep-debug #5.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null,
  )

  // Auto-focus title + register Escape handler on mount; clean up +
  // restore focus on unmount. Deep-debug #5.
  useEffect(() => {
    titleInputRef.current?.focus()
    // Capture the opener at mount-time into a local so the cleanup
    // closure refers to the right element, not whatever the ref is
    // pointing at when unmount fires. Required by the
    // react-hooks/exhaustive-deps lint rule.
    const opener = openerRef.current
    const onKeyDown = (e: KeyboardEvent) => {
      // Phase 2/3 — block Escape while a capture OR recording is in
      // flight so the modal doesn't unmount mid-flight and leave
      // async work running on a dead component. mountedRef guards
      // also catch the case if the parent closes us, but it's
      // cheaper to prevent the unmount.
      if (e.key === 'Escape'
        && !submittingRef.current
        && !capturingRef.current
        && !recordingRef.current
      ) {
        e.stopPropagation()
        onClose()
        return
      }
      // Minimal focus trap — if the user tabs out of the modal,
      // pull focus back to the modal root. Not a full container-
      // walking trap, but enough to prevent escape into background
      // content for screen-reader users.
      //
      // 2026-05-27 (deep-debug H1) — skip the trap during recording.
      // The modal is `visibility: hidden`; its descendants are
      // querySelectorAll-visible but not actually focusable, so the
      // first/last focus targets are unreachable. The only focusable
      // element on screen during recording is the portal'd Stop
      // button at document.body root — Tab/Shift+Tab should let the
      // browser cycle naturally to/from that button (which is the
      // only candidate, so focus stays put). Trapping into a hidden
      // subtree would silently steal focus into nowhere.
      if (e.key === 'Tab' && rootRef.current && !recordingRef.current) {
        const focusable = rootRef.current.querySelectorAll<HTMLElement>(
          'a, button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Give the focus back to what opened the dialog. When that is gone
      // or never had it, the caller says where it goes instead.
      if (opener && opener !== document.body && opener.isConnected) opener.focus?.()
      else focusFallback?.()
      // A send still out is aborted by the form itself as it unmounts.
    }
    // Intentionally only on mount — onClose is captured in the
    // closure but its identity won't change in practice (parent
    // passes a stable prop), and re-registering on every render is
    // wasteful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
    <div
      // 2026-05-27 — Two-tier hide strategy:
      //
      // CAPTURE (200ms-ish flash while html-to-image rasterizes the
      // page): `opacity: 0 + pointerEvents: none`. Keeps the modal
      // in the a11y tree so screen readers retain orientation
      // (deep-debug #10/#11) — the captureAnnounce live-region
      // tells them what's happening; pulling the modal entirely
      // would lose the dialog landmark mid-flow.
      //
      // RECORDING (up to 30s, user actively interacts with the
      // page they're recording): `visibility: hidden`. True full
      // hide — no paint, no a11y tree entry, no pointer events.
      // With opacity:0 alone the user reported "the bug report
      // doesn't minimize." visibility:hidden is unambiguous.
      // The Stop pill is portal'd to document.body so it stays
      // visible even when the modal subtree is hidden.
      //
      // data-screenshot-exclude carries the html-to-image opt-out
      // (`filter` predicate matches this overlay and the toasts).
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--scrim)] p-4 stage-scrim-in"
      style={
        recording
          ? { visibility: 'hidden' }
          : capturing
            ? { opacity: 0, pointerEvents: 'none' }
            : undefined
      }
      data-screenshot-exclude="true"
      onClick={() => {
        // Click-outside also blocked during capture / recording /
        // submit (matches Escape / Cancel gating) so the modal can't
        // unmount while async work is still running.
        if (
          !submittingRef.current
          && !capturingRef.current
          && !recordingRef.current
        ) onClose()
      }}
    >
      <div
        ref={rootRef}
        // Cap the panel to the viewport and let it scroll its OWN content.
        // Previously this was `overflow-hidden` with no max-height, so a form
        // taller than the screen had nothing scrollable inside the modal and
        // the wheel chained to the page behind it (reported: "can't scroll the
        // Report a Bug window — it scrolls Aurora behind it"), leaving the
        // Submit button below the fold unreachable. max-h + overflow-y-auto
        // makes the modal scroll; overscroll-contain stops the chain at its
        // scroll boundaries; overflow-x-hidden preserves the rounded corners.
        className="w-full max-w-[560px] max-h-[90dvh] overflow-y-auto overflow-x-hidden overscroll-contain bg-surface-raised-2 rounded-sheet shadow-[shadow:var(--shadow-modal)] stage-dialog-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        // Holistic deep-debug M2 — drop aria-modal during recording
        // so screen-reader virtual cursor can reach the portal'd
        // Stop pill (rendered to document.body, outside this
        // subtree). When recording ends and the modal returns to
        // its normal modal-overlay role, aria-modal goes back on.
        aria-modal={recording ? undefined : true}
        aria-labelledby="bug-report-title"
        aria-busy={capturing || submitting || recording}
      >
        {/* Header — transforms into a success state once the report
            lands. The submittedResult path replaces the "Bug Report"
            chip with a green "Reported" chip and swaps the title +
            subtitle accordingly. Same header structure so the modal
            doesn't visually jump. */}
        <div className="px-6 pt-6 pb-4 border-b border-line">
          {submittedResult ? (
            <>
              <p className="mb-2 text-ok text-xs font-semibold uppercase tracking-wider">
                Reported · #{submittedResult.issue_number}
              </p>
              <h2 id="bug-report-title" className="text-ink text-[22px] font-semibold leading-tight font-display">
                Thanks, got it
              </h2>
              <p className="text-ink-2 text-sm mt-1">
                Your report was filed as issue <span className="font-mono text-ink">#{submittedResult.issue_number}</span>. The Aurora team will take a look.
              </p>
            </>
          ) : (
            <>
              <p className="mb-2 text-ink-2 text-xs font-semibold uppercase tracking-wider">
                Bug report
              </p>
              <h2 id="bug-report-title" className="text-ink text-[22px] font-semibold leading-tight font-display">
                Report a bug
              </h2>
              <p className="text-ink-2 text-sm mt-1">
                Help us improve Aurora — this opens a GitHub issue with the details below.
              </p>
            </>
          )}
        </div>

        {/* Success view body — replaces the form once the report
            lands. Single Done button closes the modal; we deliberately
            do NOT include a link to the GitHub issue because the
            repo is private (the URL is a login wall for users
            without repo access). The issue number is the user's
            reference for follow-up via chat / email. */}
        {submittedResult && <BugReportSent result={submittedResult} onClose={onClose} />}

        {/* 2026-05-27 — Admin-only PAT health banner. The server
            populates tokenHealthy only for admin requesters, so this
            banner can't render for regular users. Amber matches the
            existing PII warning so admins see "operator action needed"
            as a distinct visual class from form-error red. Hidden
            after submit lands so the success view stays clean. */}
        {!submittedResult && tokenHealthy === false && <BugReportTokenNotice reason={tokenHealthReason} />}

        {!submittedResult && <BugReportFields form={form} />}
      </div>
    </div>
    {/* Phase 3 deep-debug H4/M2 — Floating Stop pill rendered via
        a portal to document.body so it escapes the modal overlay's
        visibility:hidden during recording. Without the portal, the
        pill was inside the focus-trap query and the Tab cycle
        missed it (it sits outside the modal panel ref). With the
        portal, focus moves to the pill on mount and Tab leaves it
        alone (no other focusable in body).

        2026-05-27 — Moved from bottom-center to TOP-CENTER and
        scaled up so the user has clear visual confirmation
        recording is active. The previous bottom-center placement
        was at the edge of the viewport — easy to miss on tall
        screens or when the user is focused on reproducing the bug
        in the middle of the page. Top-center puts the indicator
        in their peripheral vision regardless of where on screen
        they're working. Pulsing red dot + countdown leaves no
        ambiguity. */}
    <BugReportRecordingPill form={form} />
    </>
  )
}
