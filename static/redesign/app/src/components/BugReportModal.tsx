// BugReportModal — Phases 1 + 2.
//
// Centered overlay modal with a focused 4-field form: name (prefilled
// from user's display username so emails don't leak into public/
// triage view), title, description, optional attachment from disk OR
// from a live "Capture this page" screenshot (Phase 2). On submit,
// POSTs multipart to /api/feedback; on success, shows the returned
// issue URL as a clickable toast deep-link.
//
// Pattern mirrors CollectionsModal.tsx (same z-[70], click-outside,
// submitting/error flags). Phase 3 will add live screen recording.
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

// html2canvas is loaded lazily in handleCapture to keep the main
// bundle slim (the library is ~140KB minified / ~50KB gzipped). Most
// users never click Capture, so they shouldn't pay that cost on first
// paint.

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
  // 2026-05-27 (Phase 2) — `capturing` is true while html2canvas is
  // rasterizing the page. The modal panel goes opacity:0 +
  // pointer-events:none (NOT visibility:hidden — that drops the
  // modal from the a11y tree and confuses screen readers per
  // deep-debug #10/#11). aria-busy signals async work.
  const [capturing, setCapturing] = useState(false)
  // Status announced to screen readers via aria-live (deep-debug #10).
  const [captureAnnounce, setCaptureAnnounce] = useState('')
  // Preview URL for a captured screenshot. When set, the attachment
  // row shows a small thumbnail so the user can verify what they're
  // about to submit (mirrors Plex/Discord "preview before send" UX).
  // Revoked when replaced (in setAttachmentWithPreview) and on
  // unmount (the unmount-only effect below). Deep-debug #14 — kept
  // the revocation in ONE place (the setter) to avoid double-revoke.
  const [attachmentPreviewURL, setAttachmentPreviewURL] = useState<string | null>(null)

  // Deep-debug #19 — read latest `submitting` from a ref inside
  // event handlers (click-outside, Escape) so a state-update race
  // can't dismiss the modal between user-click and React's batched
  // re-render.
  const submittingRef = useRef(submitting)
  useEffect(() => { submittingRef.current = submitting }, [submitting])
  // Phase 2 — capturing ref for the same reason as submittingRef:
  // event handlers (Escape, Cancel) need the latest value without
  // re-binding on every render. Deep-debug Phase 2 #5.
  const capturingRef = useRef(capturing)
  useEffect(() => { capturingRef.current = capturing }, [capturing])
  // Phase 2 — mounted flag so post-await state-sets in handleCapture
  // bail when the modal has been closed mid-flight. Deep-debug
  // Phase 2 #5.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  // Phase 2 — preview URL track-and-revoke. Keep the *current* URL in
  // a ref so the unmount-only cleanup can revoke whatever is live
  // without depending on the state value (avoids the double-revoke
  // problem from Phase 2 #14: the setter already revokes on replace).
  const previewURLRef = useRef<string | null>(null)
  useEffect(() => () => {
    if (previewURLRef.current) URL.revokeObjectURL(previewURLRef.current)
  }, [])

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
      // Phase 2 — also block Escape while a capture is in flight so
      // the modal doesn't unmount mid-capture and leave async work
      // running on a dead component. The capture's own mountedRef
      // guards still catch the case if the parent closes us, but
      // it's cheaper to prevent the unmount.
      if (e.key === 'Escape' && !submittingRef.current && !capturingRef.current) {
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

  // Helper: install a new attachment AND its preview URL atomically.
  // Revokes the previous preview to avoid a leak. The previewURLRef
  // mirrors the current value so the unmount cleanup can revoke
  // whatever is live without re-revoking via a state-keyed effect
  // (deep-debug Phase 2 #14).
  const setAttachmentWithPreview = (file: File | null) => {
    setAttachmentPreviewURL(prev => {
      if (prev) URL.revokeObjectURL(prev)
      // Only image/* gets a preview thumbnail. Video would need a
      // canvas-render step we don't do in MVP.
      const next = file && file.type.startsWith('image/')
        ? URL.createObjectURL(file)
        : null
      previewURLRef.current = next
      return next
    })
    setAttachment(file)
  }

  const handleAttachmentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    if (file && file.size > MAX_ATTACHMENT_BYTES) {
      setError(`Attachment exceeds 25 MB (got ${(file.size / 1024 / 1024).toFixed(1)} MB).`)
      // Clear the picker so the user has to pick again — without this,
      // the file name keeps showing even though we're refusing it.
      e.target.value = ''
      setAttachmentWithPreview(null)
      return
    }
    setError(null)
    setAttachmentWithPreview(file)
  }

  // 2026-05-27 (Phase 2) — "Capture this page" handler.
  //
  // Flow:
  //   1. Lazy-load html2canvas FIRST so a load failure doesn't leave
  //      the modal mid-hide. (deep-debug Phase 2 #7)
  //   2. Set `capturing` → modal panel goes opacity:0 +
  //      pointer-events:none (NOT visibility:hidden — opacity keeps
  //      the modal in the a11y tree so screen readers don't lose
  //      orientation, per deep-debug Phase 2 #10/#11). aria-busy
  //      announces the async work.
  //   3. Yield two animation frames OR a 200ms timeout, whichever
  //      fires first (deep-debug Phase 2 #8 — RAF is throttled to
  //      ~1/sec in backgrounded tabs and may never fire if the user
  //      switches away).
  //   4. Call html2canvas on document.body, CAPPED to the visible
  //      viewport (deep-debug Phase 2 #3 — full-document capture
  //      OOMs on long-scroll pages). Scale capped at 2 to bound
  //      worst-case canvas bytes.
  //   5. Convert canvas → PNG Blob → File → set as attachment.
  //   6. Restore modal interactivity.
  //
  // Failure modes handled: chunk fetch error (caught + clear toast),
  // toBlob null (rare browser quirk), oversize PNG (clear error),
  // user closes modal mid-capture (mountedRef bail), capture canceled
  // by a newer click (capturingRef + mountedRef check).
  const handleCapture = async () => {
    setError(null)
    // Deep-debug Phase 2 #7 — load the library BEFORE the modal
    // hide. If the chunk fetch fails we want the modal to stay
    // visible so the user sees the error without a confusing
    // "modal disappeared" flash.
    setCaptureAnnounce('Loading capture library…')
    let html2canvas: typeof import('html2canvas').default
    try {
      const mod = await import('html2canvas')
      html2canvas = mod.default
    } catch (err) {
      if (!mountedRef.current) return
      setCaptureAnnounce('')
      setError('Couldn\'t load the screenshot library. Try uploading a screenshot from disk instead.')
      console.warn('[Aurora] html2canvas chunk load failed', err)
      return
    }
    if (!mountedRef.current) return
    setCapturing(true)
    setCaptureAnnounce('Capturing screenshot…')
    try {
      // Wait for hide to paint. Use Promise.race against a 200ms
      // setTimeout so a backgrounded tab (RAF throttled / paused)
      // doesn't hang the handler indefinitely. Deep-debug Phase 2 #8.
      await Promise.race([
        new Promise<void>(r =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
        new Promise<void>(r => setTimeout(r, 200)),
      ])
      if (!mountedRef.current) return
      const canvas = await html2canvas(document.body, {
        // Don't print html2canvas's verbose console output in prod.
        logging: false,
        // Try to use CORS-enabled <img> requests so cross-origin
        // images render in the screenshot. Most Aurora image
        // rendering goes through /api/images/ (same-origin) but a
        // handful of usages go direct to image.tmdb.org via
        // tmdbPosterURL(); those <img>s carry crossOrigin="anonymous"
        // so html2canvas can include them via this CORS refetch.
        useCORS: true,
        // 2026-05-27 (deep-debug Phase 2 #3) — capture ONLY the
        // visible viewport. Without these explicit window/x/y/scale
        // bounds, html2canvas captures the full document.body which
        // OOMs on long-scroll pages (Movies/Discover grids) at
        // 1920×8000+ at DPR=2 = >240MB raw RGBA. Scale capped at 2
        // for the same reason — Retina captures stay crisp but
        // can't escalate to 3x or higher.
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
        scale: Math.min(window.devicePixelRatio || 1, 2),
        // 2026-05-27 (deep-debug Phase 2 #1) — filter on a stable
        // attribute (data-screenshot-exclude) rather than ref-based
        // identity. The Phase 1 BugReportButton sets this attribute
        // so the floating launcher doesn't show up in screenshots
        // (it's not a descendant of the modal overlay; ref-based
        // filtering missed it). Any future fixed/floating element
        // can opt out the same way.
        ignoreElements: el =>
          el === rootRef.current?.parentElement ||
          el instanceof HTMLElement && el.dataset.screenshotExclude === 'true',
      })
      if (!mountedRef.current) return
      const blob = await new Promise<Blob | null>(res =>
        canvas.toBlob(b => res(b), 'image/png'),
      )
      if (!mountedRef.current) return
      if (!blob) {
        setError('Capture failed: the browser could not encode the screenshot.')
        setCaptureAnnounce('Capture failed.')
        return
      }
      if (blob.size > MAX_ATTACHMENT_BYTES) {
        setError(
          `Capture too large (${(blob.size / 1024 / 1024).toFixed(1)} MB > 25 MB cap). ` +
          'Try uploading a screenshot from disk instead.',
        )
        setCaptureAnnounce('Capture too large.')
        return
      }
      const file = new File(
        [blob],
        `aurora-screenshot-${Date.now()}.png`,
        { type: 'image/png' },
      )
      setAttachmentWithPreview(file)
      setCaptureAnnounce('Screenshot attached.')
      // Reset the file picker so the user can clear-and-pick again
      // without their previous screenshot still showing as selected.
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error
        ? `Capture failed: ${err.message}`
        : 'Capture failed — try again or upload a screenshot from disk instead.')
      setCaptureAnnounce('Capture failed.')
    } finally {
      if (mountedRef.current) {
        setCapturing(false)
      }
    }
  }

  // Deep-debug #26 — clear the selected attachment + reset the
  // <input type="file"> value so the picker no longer shows the
  // stale filename. Phase 2: also revokes the captured-screenshot
  // preview URL via the shared helper.
  const handleClearAttachment = () => {
    setAttachmentWithPreview(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Deep-debug #27 — Cancel during submit aborts the request via
  // the shared AbortController, then closes the modal.
  //
  // Phase 2 — Cancel is GATED OUT during capture (deep-debug Phase 2
  // #5/#13) because html2canvas has no abort API; clicking Cancel
  // mid-capture used to unmount the modal but leave the async work
  // running, then setState fire on a dead component. The
  // "Capturing…" button text plus the disabled file input + capture
  // button make it clear the modal is locked briefly.
  const handleCancel = () => {
    if (capturingRef.current) return
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
      // Phase 2 (deep-debug #10/#11): hide via opacity + pointer-events
      // instead of visibility:hidden during capture. Keeps the modal
      // in the a11y tree (screen readers retain orientation) and the
      // focus trap doesn't lose its anchor. aria-busy on the panel
      // announces the async work. data-screenshot-exclude carries the
      // ignoreElements signal so html2canvas filters us out by
      // attribute (matches the launcher's opt-out).
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-fade-in"
      style={capturing ? { opacity: 0, pointerEvents: 'none' } : undefined}
      data-screenshot-exclude="true"
      onClick={() => {
        // Click-outside also blocked during capture (matches Escape
        // / Cancel gating) so the modal can't unmount while async
        // work is still running.
        if (!submittingRef.current && !capturingRef.current) onClose()
      }}
    >
      <div
        ref={rootRef}
        className="w-full max-w-[560px] bg-[#0a0a0f] rounded-2xl border border-white/[0.08] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bug-report-title"
        aria-busy={capturing || submitting}
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
              disabled={submitting || capturing}
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
              disabled={submitting || capturing}
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
              disabled={submitting || capturing}
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
            <div className="flex items-center gap-2 flex-wrap">
              <input
                id="bug-attachment"
                ref={fileInputRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                onChange={handleAttachmentChange}
                disabled={submitting || capturing}
                className="block flex-1 min-w-0 text-sm text-white/80 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-purple-600/20 file:text-purple-200 hover:file:bg-purple-600/30 file:cursor-pointer disabled:opacity-50"
              />
              {/* Phase 2 — "Capture this page" button. Briefly hides
                  the modal so the screenshot doesn't include the form
                  itself, then sets the captured image as the
                  attachment. Disabled while submitting OR another
                  capture is already in flight. */}
              <button
                type="button"
                onClick={handleCapture}
                disabled={submitting || capturing}
                title="Capture a screenshot of the visible page area"
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-white/80 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {capturing ? (
                  // Phase 2 (deep-debug #15) — inline spinner during
                  // capture (covers both lazy-import + html2canvas
                  // rasterize). Without this, the button looks
                  // disabled with no visible progress on slow
                  // connections.
                  <svg width={14} height={14} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" fill="none" opacity="0.25" />
                    <path d="M21 12a9 9 0 0 1-9 9" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" />
                  </svg>
                ) : (
                  // Camera-ish glyph (decorative; button has visible
                  // text). Inline SVG keeps this file dependency-free.
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                )}
                {capturing ? 'Capturing…' : 'Capture this page'}
              </button>
            </div>
            <p className="text-white/30 text-[10px] mt-1">
              Use Capture to take a screenshot of the visible page area — the form will hide briefly.
            </p>
            {/* Phase 2 (deep-debug #4) — PRE-capture PII notice. Shown
                always above the controls so the user understands what
                gets captured BEFORE clicking, not after the blob is
                already in memory. Separate from the post-attachment
                warning further down (which reinforces the warning
                once they see what they captured). */}
            <p className="text-amber-200/80 text-[10px] mt-1">
              Captures show whatever is on screen now — library, currently playing media, profile info.
              Review the thumbnail below before submitting.
            </p>
            {attachment && (
              <div className="mt-2 flex items-start gap-3 p-2 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                {/* Phase 2 — thumbnail preview when the attachment is
                    an image (captured screenshot OR uploaded PNG/JPG).
                    Lets the user visually confirm what they're about to
                    publish to GitHub. Videos skip the preview because
                    we'd need a canvas-render step. */}
                {attachmentPreviewURL && (
                  <img
                    src={attachmentPreviewURL}
                    alt="Attachment preview"
                    className="w-20 h-12 object-cover rounded border border-white/[0.08] shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-white/70 text-xs truncate">{attachment.name}</p>
                  <p className="text-white/40 text-[10px]">
                    {(attachment.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
                {/* Deep-debug #26 — × to clear the selection. */}
                <button
                  type="button"
                  onClick={handleClearAttachment}
                  disabled={submitting}
                  className="text-white/40 hover:text-rose-300 transition-colors disabled:opacity-50 self-start"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                >
                  ×
                </button>
              </div>
            )}
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

          {/* Phase 2 (deep-debug #10) — sr-only aria-live region so
              screen readers hear capture progress. Visible text stays
              on the Capture button itself. */}
          <p className="sr-only" role="status" aria-live="polite">
            {captureAnnounce}
          </p>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            {/* Deep-debug #27 — Cancel stays enabled during submit
                so a slow GitHub can be aborted (the AbortController
                cancels the in-flight fetch via handleCancel).
                Phase 2 (deep-debug #5/#13) — also disabled during
                capture because html2canvas has no abort API and the
                modal can't safely unmount mid-capture. */}
            <button
              type="button"
              onClick={handleCancel}
              disabled={capturing}
              className="px-4 py-2 rounded-lg text-white/70 hover:text-white hover:bg-white/[0.05] transition-colors text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="submit"
              // Phase 2 (deep-debug critical #2) — also gate on
              // `capturing` so the user can't ship a report while
              // the capture is mid-flight (would attach the previous
              // file or null, with the captured screenshot landing
              // after the request was already sent).
              disabled={submitting || capturing}
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
