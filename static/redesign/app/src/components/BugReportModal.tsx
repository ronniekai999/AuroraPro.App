// BugReportModal — Phase 1 MVP.
//
// Centered overlay modal with a focused 4-field form: name (prefilled
// from user's display username so emails don't leak into public/
// triage view), title, description, optional attachment from disk.
// On submit, POSTs multipart to /api/feedback; on success, shows the
// returned issue URL as a clickable toast deep-link.
//
// Pattern mirrors CollectionsModal.tsx (same z-[70], click-outside,
// submitting/error flags). Phase 2 will add a "Capture this page"
// button to populate the attachment via html2canvas. Phase 3 will add
// live screen recording.
//
// Accessibility (deep-debug #5):
//   - Escape closes the modal (unless submitting; matches the
//     click-outside behavior)
//   - Auto-focus the Title field on open
//   - Restore focus to the launcher on close (handled by React via
//     last-focused tracking — see useEffect below)
//   - role/aria already set; aria-live error region announces
//     validation failures

import { useEffect, useRef, useState } from 'react'
import { submitBugReport, type BugReportSubmitResult } from '@/lib/api'

interface Props {
  // Prefill the "Your name" field. Should be the user's DISPLAY
  // username, NOT their email — the field's value lands in the
  // public GitHub issue body. (deep-debug #7)
  prefillName?: string
  onClose: () => void
  // Called on successful submission with the GH issue link/number so
  // the parent can pop a toast deep-linking to the issue.
  onSubmitted: (result: BugReportSubmitResult) => void
}

// Match server-side limits (internal/api/feedback_handlers.go) so the
// validation message is the same on both sides.
const MAX_TITLE_LEN = 200
const MAX_DESC_LEN = 10_000 // lowered from 50k per deep-debug #23
const MAX_NAME_LEN = 100
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MiB

// Whitelist matches the server's safeExtension + isValidAttachmentName.
// Setting this in the file <input> accept attribute is just a hint
// (users can still pick anything); the server is the source of truth.
const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,video/webm,video/mp4'

export function BugReportModal({ prefillName, onClose, onSubmitted }: Props) {
  const [name, setName] = useState(prefillName ?? '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [attachment, setAttachment] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Deep-debug #19 — read latest `submitting` from a ref inside
  // event handlers (click-outside, Escape) so a state-update race
  // can't dismiss the modal between user-click and React's batched
  // re-render.
  const submittingRef = useRef(submitting)
  useEffect(() => { submittingRef.current = submitting }, [submitting])

  // File input ref so the × clear-attachment button can also reset
  // the input value (otherwise the picker still shows the old
  // filename even when state.attachment is null). Deep-debug #26.
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Title-input ref for auto-focus on mount. Deep-debug #5.
  const titleInputRef = useRef<HTMLInputElement>(null)
  // Modal root ref for focus-trap. Deep-debug #5.
  const rootRef = useRef<HTMLDivElement>(null)
  // Track the element that opened us so focus returns there on close.
  // Deep-debug #5.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null,
  )

  // In-flight submit AbortController so the Cancel button (now
  // enabled during submit, per deep-debug #27) can cancel the GitHub
  // POST cleanly. Wrapped in a ref because the controller identity
  // shouldn't trigger re-renders. Deep-debug #28.
  const submitAcRef = useRef<AbortController | null>(null)

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
      if (e.key === 'Escape' && !submittingRef.current) {
        e.stopPropagation()
        onClose()
        return
      }
      // Minimal focus trap — if the user tabs out of the modal,
      // pull focus back to the modal root. Not a full container-
      // walking trap, but enough to prevent escape into background
      // content for screen-reader users.
      if (e.key === 'Tab' && rootRef.current) {
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
    // Capture submitAcRef at effect-time too so the cleanup aborts
    // the controller that was alive when this effect ran (Cancel
    // race against unmount — the ref might have been cleared by a
    // resolved submit between unmount-scheduling and cleanup-fire).
    const cleanupAbortController = submitAcRef
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Restore focus to the element that opened us (the launcher).
      opener?.focus?.()
      // Abort any in-flight submit if the modal unmounts while a
      // request is pending (Cancel click, parent close, etc.).
      cleanupAbortController.current?.abort()
    }
    // Intentionally only on mount — onClose is captured in the
    // closure but its identity won't change in practice (parent
    // passes a stable prop), and re-registering on every render is
    // wasteful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAttachmentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    if (file && file.size > MAX_ATTACHMENT_BYTES) {
      setError(`Attachment exceeds 25 MB (got ${(file.size / 1024 / 1024).toFixed(1)} MB).`)
      // Clear the picker so the user has to pick again — without this,
      // the file name keeps showing even though we're refusing it.
      e.target.value = ''
      setAttachment(null)
      return
    }
    setError(null)
    setAttachment(file)
  }

  // Deep-debug #26 — clear the selected attachment + reset the
  // <input type="file"> value so the picker no longer shows the
  // stale filename.
  const handleClearAttachment = () => {
    setAttachment(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Deep-debug #27 — Cancel during submit aborts the request via
  // the shared AbortController, then closes the modal.
  const handleCancel = () => {
    if (submittingRef.current) {
      submitAcRef.current?.abort()
    }
    onClose()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const trimmedTitle = title.trim()
    const trimmedDesc = description.trim()
    if (!trimmedTitle) {
      setError('Title is required.')
      return
    }
    if (!trimmedDesc) {
      setError('Description is required.')
      return
    }
    if (trimmedTitle.length > MAX_TITLE_LEN) {
      setError(`Title exceeds ${MAX_TITLE_LEN} characters.`)
      return
    }
    if (trimmedDesc.length > MAX_DESC_LEN) {
      setError(`Description exceeds ${MAX_DESC_LEN} characters.`)
      return
    }
    setSubmitting(true)
    const ac = new AbortController()
    submitAcRef.current = ac
    try {
      const result = await submitBugReport({
        title: trimmedTitle,
        description: trimmedDesc,
        name: name.trim() || undefined,
        attachment: attachment ?? undefined,
      }, ac.signal)
      onSubmitted(result)
      onClose()
    } catch (err) {
      // Aborts are user-initiated (Cancel); don't surface them as
      // errors. AbortError comes from fetch when signal.aborted.
      if (err && (err as Error).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setSubmitting(false)
      // Only clear the ref if this is still the active request
      // (modal might already be unmounting after abort).
      if (submitAcRef.current === ac) {
        submitAcRef.current = null
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-fade-in"
      onClick={() => { if (!submittingRef.current) onClose() }}
    >
      <div
        ref={rootRef}
        className="w-full max-w-[560px] bg-[#0a0a0f] rounded-2xl border border-white/[0.08] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bug-report-title"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-white/[0.04]">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 mb-3">
            <span className="text-rose-200 text-xs font-medium uppercase tracking-wider">
              Bug Report
            </span>
          </div>
          <h2 id="bug-report-title" className="text-white text-2xl font-bold font-display">
            Report a Bug
          </h2>
          <p className="text-white/50 text-sm mt-1">
            Help us improve Aurora — this opens a GitHub issue with the details below.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Name. Deep-debug #7 — label clarifies that the value
              is visible in the public GitHub issue. */}
          <div>
            <label htmlFor="bug-name" className="block text-white/80 text-sm font-medium mb-1">
              Your name <span className="text-white/40">(optional, visible in the GitHub issue)</span>
            </label>
            <input
              id="bug-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={MAX_NAME_LEN}
              disabled={submitting}
              placeholder="So we can credit you in the issue thread"
              className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder-white/30 focus:outline-none focus:border-purple-500/60 transition-colors disabled:opacity-50"
            />
          </div>

          {/* Title */}
          <div>
            <label htmlFor="bug-title" className="block text-white/80 text-sm font-medium mb-1">
              Title <span className="text-rose-400">*</span>
            </label>
            <input
              id="bug-title"
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={MAX_TITLE_LEN}
              required
              disabled={submitting}
              placeholder="e.g. Continue Watching card jumps to wrong episode"
              className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder-white/30 focus:outline-none focus:border-purple-500/60 transition-colors disabled:opacity-50"
            />
            <p className="text-white/30 text-[10px] mt-1 tabular-nums">
              {title.length} / {MAX_TITLE_LEN}
            </p>
          </div>

          {/* Description */}
          <div>
            <label htmlFor="bug-desc" className="block text-white/80 text-sm font-medium mb-1">
              Description <span className="text-rose-400">*</span>
            </label>
            <textarea
              id="bug-desc"
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={MAX_DESC_LEN}
              required
              disabled={submitting}
              rows={6}
              placeholder="What did you expect to happen? What actually happened? Steps to reproduce?"
              className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder-white/30 focus:outline-none focus:border-purple-500/60 transition-colors disabled:opacity-50 resize-y min-h-[120px]"
            />
            <p className="text-white/30 text-[10px] mt-1 tabular-nums">
              {description.length} / {MAX_DESC_LEN}
            </p>
          </div>

          {/* Attachment */}
          <div>
            <label htmlFor="bug-attachment" className="block text-white/80 text-sm font-medium mb-1">
              Screenshot or recording <span className="text-white/40">(optional, max 25 MB)</span>
            </label>
            <input
              id="bug-attachment"
              ref={fileInputRef}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              onChange={handleAttachmentChange}
              disabled={submitting}
              className="block w-full text-sm text-white/80 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-purple-600/20 file:text-purple-200 hover:file:bg-purple-600/30 file:cursor-pointer disabled:opacity-50"
            />
            {attachment && (
              <p className="text-white/50 text-xs mt-1 flex items-center gap-2">
                <span>{attachment.name} · {(attachment.size / 1024 / 1024).toFixed(2)} MB</span>
                {/* Deep-debug #26 — small × to clear the selection
                    without reopening the picker. */}
                <button
                  type="button"
                  onClick={handleClearAttachment}
                  disabled={submitting}
                  className="text-white/40 hover:text-rose-300 transition-colors disabled:opacity-50"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                >
                  ×
                </button>
              </p>
            )}
            {/* Phase 2 will add a "Capture this page" button here; for
                MVP we accept disk uploads only. */}
          </div>

          {/* PII warning — only when an attachment is selected
              (deep-debug #25). Without an attachment there's no
              screenshot/recording to warn about. */}
          {attachment && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-amber-200 text-xs">
              <strong>Heads-up:</strong> screenshots and recordings may show
              personal data (your library, currently playing media, profile
              info). Issues are filed to the Aurora repository — review what
              you're attaching before submitting.
            </div>
          )}

          {/* Error — aria-live so screen readers announce validation
              failures + server errors. */}
          {error && (
            <div
              className="rounded-lg bg-red-500/15 border border-red-500/40 px-3 py-2 text-red-300 text-sm"
              role="alert"
              aria-live="polite"
            >
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            {/* Deep-debug #27 — Cancel stays enabled during submit
                so a slow GitHub can be aborted (the AbortController
                cancels the in-flight fetch via handleCancel). */}
            <button
              type="button"
              onClick={handleCancel}
              className="px-4 py-2 rounded-lg text-white/70 hover:text-white hover:bg-white/[0.05] transition-colors text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Submitting…' : 'Submit Report'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
