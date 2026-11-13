// The bug report form: its fields, the three ways to show the problem
// (a file, a capture of the page, a recording of the screen), its refusals,
// its announcements and its one send per press.
//
// One implementation, drawn inside whatever frames it: useBugReportForm
// holds the form's state and does its work, BugReportFields draws the form,
// and the frame (the dialog, BugReportModal; the panel on the error screen,
// ErrorScreen) reads from the same state what it needs to know: whether a
// send, a capture or a recording is under way, and whether the report has
// been sent.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { failureWords } from '@/lib/failureWords'
import { createPortal } from 'react-dom'
import { collectClientContext, submitBugReport, type BugReportSubmitResult } from '@/lib/api'
import { Icon } from '@/components/Icon'


// 2026-05-27 — Capture library: html-to-image (active fork) replaces
// html2canvas (last release Dec 2021, 1100+ open issues). html-to-image
// uses SVG `<foreignObject>` to serialize the DOM and renders via a
// HTMLImageElement → canvas pipeline; smaller bundle (~10 KB gzipped
// vs html2canvas's ~50 KB) and modern Promise API. The trade-off is
// that some CSS features render slightly differently — we capture only
// the visible viewport via a fully-laid-out clone, so the practical
// impact for screenshotting Aurora's pages is minimal. Lazy-loaded so
// the chunk only ships when a user clicks Capture.

// The server's limits (internal/api/feedback_handlers.go), so that what the
// form lets go the server takes. The server counts bytes of UTF-8 as it
// receives them, and a form's text goes out with every line break as CR LF:
// so the form counts the same way (sentBytes), not in JavaScript's string
// units, and its counters say bytes. Its refusals say "too long" and no
// number of characters, which bytes are not.
const MAX_TITLE_LEN = 200
const MAX_DESC_LEN = 10_000 // lowered from 50k per deep-debug #23
const MAX_NAME_LEN = 100
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MiB

// Whitelist matches the server's safeExtension + isValidAttachmentName.
// Setting this in the file <input> accept attribute is just a hint
// (users can still pick anything); the server is the source of truth.
const ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,video/webm,video/mp4'

// 2026-05-27 — Threshold above which image attachments get compressed
// client-side BEFORE upload. GitHub's Camo image proxy refuses to
// serve embedded issue-body images > ~5 MB, so the inline preview
// would otherwise show a broken-image icon for every triager
// reviewing the report. 4 MB triggers compression; the encoded
// output is accepted as long as it fits the server-side embed gate
// (4.5 MB). Videos are NOT compressed here (would require a heavy
// FFmpeg-in-the-browser dep) — the server-side embed gate handles
// the GitHub-render path for videos by skipping the embed entirely.
const COMPRESS_TRIGGER_BYTES = 4 * 1024 * 1024 // 4 MB — start compressing above this
// Deep-debug M5 — accept compressed output up to the server's embed
// gate (4.5 MB) rather than the trigger (4 MB). Previously a JPEG
// output of e.g. 4.2 MB was REJECTED because it exceeded the
// trigger, so the un-compressed original (could be 25 MB) shipped
// instead — wasting bandwidth and missing the embed gate. The
// embed-gate threshold matches the server's camoEmbedMaxBytes
// constant in internal/api/feedback_handlers.go.
const COMPRESS_ACCEPT_BYTES = 4_500_000 // 4.5 MB — accept anything that fits the embed gate

// Max dimension for compressed images. 1920px wide covers virtually
// all triage use cases (UI screenshots, error dialogs); details
// remain legible without producing massive blob URLs. If the source
// is already smaller in both dimensions, dimensions are preserved.
const COMPRESS_MAX_DIM = 1920

// compressImageIfLarge re-encodes an image File at lower resolution
// and/or JPEG-quality so the resulting blob is small enough to embed
// in a GitHub issue. Strategy:
//   1. Load the source via blob URL + an <img> element.
//   2. Draw to a canvas at min(natural, MAX_DIM) — proportional scale.
//   3. canvas.toBlob('image/png') first (preserves transparency).
//   4. If still > threshold, fall back to JPEG @ quality 0.85.
// Returns the original file unchanged on any failure (loader error,
// canvas tainted, encoder returned null) — better to ship a too-big
// file than refuse the user's submission.
//
// Skipped for non-images (videos, etc.) — they bypass and return
// the input unchanged.
async function compressImageIfLarge(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file
  if (file.size <= COMPRESS_TRIGGER_BYTES) return file
  try {
    const srcURL = URL.createObjectURL(file)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('image load failed'))
        el.src = srcURL
      })
      // Compute target dimensions — proportional scale to fit
      // MAX_DIM in the larger axis.
      const ratio = Math.min(1, COMPRESS_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.round(img.naturalWidth * ratio)
      const h = Math.round(img.naturalHeight * ratio)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return file
      ctx.drawImage(img, 0, 0, w, h)
      // Deep-debug M3 — strip ANY existing extension and replace
      // with the canonical one for the encoded format. The previous
      // regex (`/\.(png|webp)$/i`) only matched a small allow-list,
      // so a file named `cat.HEIC` or `screenshot` (no ext) kept the
      // wrong extension and confused the server-side safeExtension
      // check. `/\.[^.]+$/` matches the last dot + extension OR
      // nothing (the empty match still works with replace).
      const baseName = file.name.replace(/\.[^.]+$/, '')
      // First pass: PNG (preserves transparency).
      const png = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'))
      if (png && png.size <= COMPRESS_ACCEPT_BYTES) {
        return new File([png], `${baseName}.png`, { type: 'image/png' })
      }
      // Second pass: JPEG @ 85%. Drops transparency but covers the
      // realistic abuse case (huge full-resolution Retina PNGs).
      // Deep-debug M5 — accept anything ≤ COMPRESS_ACCEPT_BYTES
      // (4.5 MB, matches server embed gate) rather than the 4 MB
      // trigger; previously a 4.2 MB JPEG was rejected here and
      // the un-compressed (often 10-25 MB) original shipped instead.
      const jpeg = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.85))
      if (jpeg && jpeg.size <= COMPRESS_ACCEPT_BYTES) {
        return new File([jpeg], `${baseName}.jpg`, { type: 'image/jpeg' })
      }
      // Both passes still too big — return original. The server-side
      // embed gate will skip the inline render but keep the link.
      return file
    } finally {
      URL.revokeObjectURL(srcURL)
    }
  } catch {
    // Anything went wrong → ship the original. Server still accepts
    // the upload (up to 25 MB cap) and the link still works in the
    // issue body; only the inline render is degraded.
    return file
  }
}

// Phase 3 — screen-recording hard cap. WebM at ~1080p with VP9
// averages 1-3 MB/sec, so 30s stays well under the 25 MB attachment
// cap with headroom for high-motion frames. Auto-stop on timer
// expiry; user can also stop early via the in-recording UI.
const MAX_RECORDING_MS = 30_000

export interface BugReportFormOptions {
  // Prefill the "Your name" field. Should be the user's DISPLAY
  // username, NOT their email — the field's value lands in the
  // public GitHub issue body. (deep-debug #7)
  prefillName?: string
  // The person closed the form (Cancel).
  onClose: () => void
  // Called on successful submission with the GH issue link/number so
  // the parent can pop a toast deep-linking to the issue.
  onSubmitted: (result: BugReportSubmitResult) => void
  // The session the form was opened in is no longer the one on screen (a
  // switch of profile made in another tab). The form calls onClose as
  // soon as nothing of its own is in flight: a send under way finishes
  // first, and a recording is stopped.
  dismissed?: boolean
  // Called in place of onClose when it is the dismissal that closes the
  // form, and not the person. `unsent` is why the last send failed, when
  // one did and nothing has been sent since: the form is going, and its
  // refusal with it, so the caller has to say that the report was not sent.
  onDismissed?: (unsent: string | null) => void
  // What the page the form is on has already put in front of the person,
  // and the report is to carry: `text` goes at the end of the description,
  // as written, and `url` is the address the report names (the page the
  // text is about, whatever the address bar has moved to since). The form
  // says that it carries them (see the heads-up).
  evidence?: BugReportEvidence
  // What a capture of the page the form is on shows, said before one is
  // taken. Over the app that is whatever is on screen; a page of its own
  // says what it shows.
  captureShows?: string
}

export interface BugReportEvidence { text: string; url: string }

/** How many bytes a text field's value is when the server reads it: UTF-8,
 *  with each line break sent as CR LF (a multipart form body does that to
 *  every text value). A lone surrogate is sent as U+FFFD, three bytes, as
 *  the encoder makes it. */
export function sentBytes(value: string): number {
  return new TextEncoder().encode(value.replace(/\r\n|\r|\n/g, '\r\n')).length
}

/** What is put between the person's description and the evidence. */
const EVIDENCE_GAP = '\n\n'

export function useBugReportForm({ prefillName, onClose, onSubmitted, dismissed = false, onDismissed, evidence, captureShows }: BugReportFormOptions) {
  // The description and the evidence share the server's limit.
  const descriptionMax = Math.max(1, MAX_DESC_LEN - (evidence ? sentBytes(EVIDENCE_GAP + evidence.text) : 0))
  const [name, setName] = useState(prefillName ?? '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [attachment, setAttachment] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The field a refusal is about, when it is about one (the form's own
  // checks of the name, the title and the description), with the refusal's
  // words: it holds only while those are the words on screen, so a later
  // refusal about something else (a capture that failed) is not pinned on a
  // field.
  const [fieldRefusal, setFieldRefusal] = useState<{ field: 'name' | 'title' | 'description'; text: string } | null>(null)
  const errorField = fieldRefusal && error === fieldRefusal.text ? fieldRefusal.field : null
  // Every refusal goes through here. One with the words already on screen
  // is taken down and put up again on the next frame: a live region whose
  // text does not change is not read out again, and the same press (or the
  // same oversize file picked twice) deserves the same answer aloud. It
  // uses nothing of the render it was made in, since a recording's handlers
  // keep it for as long as the recording runs.
  const errorShown = useRef<string | null>(null)
  useLayoutEffect(() => { errorShown.current = error }, [error])
  // The frame a taken-down refusal is waiting on, to come back. Anything
  // that says something else first, or clears the line, cancels it: left
  // alone it put the older words back over a newer refusal, and back on a
  // field the person had since typed in.
  const refill = useRef(0)
  // While it waits, the line keeps its height: the row of actions under it
  // would otherwise jump up a line and back.
  const [refilling, setRefilling] = useState(false)
  const cancelRefill = () => {
    if (!refill.current) return
    cancelAnimationFrame(refill.current)
    refill.current = 0
    setRefilling(false)
  }
  useEffect(() => () => cancelAnimationFrame(refill.current), [])
  const clearError = () => { cancelRefill(); setError(null) }
  const refuse = (text: string, field: 'name' | 'title' | 'description' | null = null) => {
    cancelRefill()
    setFieldRefusal(field ? { field, text } : null)
    if (errorShown.current !== text) { setError(text); return }
    setError(null)
    setRefilling(true)
    refill.current = requestAnimationFrame(() => {
      refill.current = 0
      if (!mountedRef.current) return
      setRefilling(false)
      setError(text)
    })
  }
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const attachTriggerRef = useRef<HTMLButtonElement | null>(null)
  // A refusal adds a line above Cancel and Send. The panel scrolls, and its
  // offset stays where it was: the new line pushed Send half out of view
  // with the focus still on it. The row is brought back into view.
  useEffect(() => {
    if (error) actionsRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [error])
  // 2026-05-27 — Post-submit success state. When non-null, the modal
  // body is replaced with a thank-you panel showing the issue number
  // (NOT a link — the GitHub repo is private and the URL would be a
  // login-wall for users without repo access). Previously the modal
  // closed and opened the issue URL in a new tab, which 404'd for
  // most users. The parent's onSubmitted still fires so a subtle
  // toast can confirm the submission.
  const [submittedResult, setSubmittedResult] = useState<BugReportSubmitResult | null>(null)
  // 2026-05-27 (Phase 2) — `capturing` is true while the screenshot
  // library (html-to-image since the 2026-05-27 swap; was
  // html2canvas) is rasterizing the page. The modal panel goes
  // opacity:0 + pointer-events:none (NOT visibility:hidden — that
  // drops the modal from the a11y tree and confuses screen readers
  // per deep-debug #10/#11). aria-busy signals async work.
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
  // Phase 3 — screen recording. Mirrors the capturing flow: a
  // recording in flight gates Escape/Cancel/click-outside the same
  // way capture does. Live remainingMs powers the countdown shown
  // on the Stop button.
  const [recording, setRecording] = useState(false)
  const [recordingRemainingMs, setRecordingRemainingMs] = useState(MAX_RECORDING_MS)
  const recordingRef = useRef(recording)
  useEffect(() => { recordingRef.current = recording }, [recording])
  // Imperative state for the active recorder + media stream + auto-
  // stop timer. Refs because their identity churn shouldn't trigger
  // re-renders.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const recordingTimerRef = useRef<number | null>(null)
  const recordingCountdownRef = useRef<number | null>(null)
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
  // 2026-05-27 (deep-debug H2) — monotonic ID for attachment-set
  // operations. compressImageIfLarge takes 1-3s on big inputs; if
  // the user clicks Capture or picks a new file mid-compression,
  // the older promise resolves and overwrites the newer attachment
  // unless we gate on the operation ID. Each call to
  // beginAttachmentOp() returns a fresh ID; the result-set is
  // applied only when the ID still matches the latest.
  const attachmentOpRef = useRef(0)
  // Title-input ref for auto-focus on mount. Deep-debug #5.
  const titleInputRef = useRef<HTMLInputElement>(null)

  // In-flight submit AbortController so the Cancel button (now
  // enabled during submit, per deep-debug #27) can cancel the GitHub
  // POST cleanly. Wrapped in a ref because the controller identity
  // shouldn't trigger re-renders. Deep-debug #28.
  const submitAcRef = useRef<AbortController | null>(null)
  // An unmount with a send still out (Cancel, a close by the caller) aborts
  // it. The ref is held in a local: by the time the cleanup runs it may have
  // been cleared by a send that has just resolved.
  useEffect(() => {
    const controller = submitAcRef
    return () => { controller.current?.abort() }
  }, [])

  // Helper: install a new attachment AND its preview URL atomically.
  // Revokes the previous preview to avoid a leak. The previewURLRef
  // mirrors the current value so the unmount cleanup can revoke
  // whatever is live without re-revoking via a state-keyed effect
  // (deep-debug Phase 2 #14).
  //
  // Phase 3 (deep-debug L5) — also create previews for video/* so
  // recorded WebM attachments get a visible <video> thumbnail. Image
  // previews use <img>, video previews use a native <video> element
  // (no canvas-render needed; the browser handles it).
  const setAttachmentWithPreview = (file: File | null) => {
    setAttachmentPreviewURL(prev => {
      if (prev) URL.revokeObjectURL(prev)
      const next = file && (
        file.type.startsWith('image/') || file.type.startsWith('video/')
      ) ? URL.createObjectURL(file) : null
      previewURLRef.current = next
      return next
    })
    setAttachment(file)
  }

  const handleAttachmentChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.files?.[0] ?? null
    if (raw && raw.size > MAX_ATTACHMENT_BYTES) {
      refuse(`Attachment exceeds 25 MB (got ${(raw.size / 1024 / 1024).toFixed(1)} MB).`)
      // Clear the picker so the user has to pick again — without this,
      // the file name keeps showing even though we're refusing it.
      e.target.value = ''
      setAttachmentWithPreview(null)
      return
    }
    clearError()
    if (!raw) {
      setAttachmentWithPreview(null)
      return
    }
    // 2026-05-27 — Compress huge images before they hit the wire so the
    // resulting GitHub-issue embed actually renders (Camo refuses
    // images > ~5 MB). compressImageIfLarge is a no-op for files
    // already small enough or for video MIME types.
    //
    // Deep-debug H2 — capture our operation ID before the async
    // compression; only apply the result if we're still the latest
    // attachment-set operation. Without this, a slow compression
    // can overwrite a faster Capture / re-pick performed during
    // the wait.
    const opId = ++attachmentOpRef.current
    const file = await compressImageIfLarge(raw)
    if (!mountedRef.current || opId !== attachmentOpRef.current) return
    setAttachmentWithPreview(file)
  }

  // 2026-05-27 — "Capture this page" handler.
  //
  // Flow:
  //   1. Lazy-load html-to-image FIRST so a load failure doesn't
  //      leave the modal mid-hide. (deep-debug Phase 2 #7)
  //   2. Set `capturing` → modal panel goes opacity:0 +
  //      pointer-events:none (NOT visibility:hidden — opacity keeps
  //      the modal in the a11y tree so screen readers don't lose
  //      orientation, per deep-debug Phase 2 #10/#11). aria-busy
  //      announces the async work.
  //   3. Yield two animation frames OR a 200ms timeout, whichever
  //      fires first (deep-debug Phase 2 #8 — RAF is throttled to
  //      ~1/sec in backgrounded tabs and may never fire if the user
  //      switches away).
  //   4. Call html-to-image's `toBlob` on document.body. We pass a
  //      `filter` callback (analogue of html2canvas's
  //      `ignoreElements`) that excludes any element with
  //      `data-screenshot-exclude="true"`. The library serializes
  //      via SVG `<foreignObject>` so the captured PNG already
  //      matches what the user sees — no separate scale/window
  //      args needed. Pixel ratio is auto-detected and capped here
  //      to 2 so a 4K Retina display doesn't produce a >25 MB blob.
  //   5. Result is a Blob (PNG by default). Build a File, set as
  //      attachment.
  //   6. Restore modal interactivity.
  //
  // Failure modes handled: chunk fetch error (caught + clear toast),
  // null blob (rare browser quirk + lib's failure mode), oversize
  // PNG (clear error), user closes modal mid-capture (mountedRef
  // bail), capture canceled by a newer click (capturingRef +
  // mountedRef check).
  //
  // 2026-05-27 — Migrated from html2canvas to html-to-image (active
  // fork; ~5x smaller chunk). The library's API is single-call:
  // `toBlob(node, options)` returns a Blob directly instead of
  // html2canvas's two-step canvas → toBlob pattern.
  const handleCapture = async () => {
    clearError()
    // Deep-debug Phase 2 #7 — load the library BEFORE the modal
    // hide. If the chunk fetch fails we want the modal to stay
    // visible so the user sees the error without a confusing
    // "modal disappeared" flash.
    setCaptureAnnounce('Loading capture library…')
    let toBlob: typeof import('html-to-image').toBlob
    try {
      const mod = await import('html-to-image')
      toBlob = mod.toBlob
    } catch (err) {
      if (!mountedRef.current) return
      setCaptureAnnounce('')
      refuse('Couldn\'t load the screenshot library. Try uploading a screenshot from disk instead.')
      console.warn('[Aurora] html-to-image chunk load failed', err)
      return
    }
    if (!mountedRef.current) return
    setCapturing(true)
    setCaptureAnnounce('Capturing screenshot…')
    try {
      // Wait for hide to paint. Promise.race against a 200ms
      // setTimeout so a backgrounded tab (RAF throttled / paused)
      // doesn't hang the handler indefinitely. Deep-debug Phase 2 #8.
      await Promise.race([
        new Promise<void>(r =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
        new Promise<void>(r => setTimeout(r, 200)),
      ])
      if (!mountedRef.current) return
      // Deep-debug C1/H2 — bound the capture to the visible
      // viewport. Without `width`/`height`/`canvasWidth`/
      // `canvasHeight`, html-to-image captures `document.body`'s
      // full layout-rect (often 8,000-30,000px on long-scroll
      // Movies/Discover grids). At pixelRatio=2 that exceeds the
      // 16384px canvas cap and produces an unusable squashed
      // capture; it ALSO causes the library to re-fetch every
      // off-screen <img> via its internal serialization (200+ TMDB
      // poster requests on a typical grid). Bounding to viewport
      // fixes both — capture is crisp, only visible images are
      // re-fetched. `style.transform` shifts the cloned body by
      // the current scroll offset so the visible portion lands at
      // origin in the output canvas.
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Deep-debug H3 — clamp pixelRatio to [1, 2]. Sub-1 ratios
      // happen on Windows browsers at < 100% display scale and
      // some Android Chrome configs; without the floor we'd
      // produce sub-resolution captures. Ceiling at 2 keeps the
      // worst-case canvas under the 25 MB attachment cap.
      const pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
      // Improvement #8 — capture-side defense-in-depth for sensitive
      // inputs. The sibling lane tags known sensitive *surfaces* with
      // data-screenshot-exclude (the `filter` below drops those whole
      // subtrees), but a stray password/secret field elsewhere on the
      // page would otherwise be serialized in clear text into the PNG
      // — which becomes a public-ish GitHub attachment. html-to-image
      // rasterizes `input.value` (the live property), so CSS tricks
      // like -webkit-text-security don't help; we have to actually
      // blank the value for the duration of the rasterize, then
      // restore it. We also blank any input/textarea that is itself
      // tagged data-screenshot-exclude (belt-and-suspenders for fields
      // a surface tagged but the `filter` can't reach because the
      // field is the captured node's ancestor, not a descendant).
      // Restored in the inner finally so a thrown toBlob still leaves
      // the user's typed values intact.
      const maskedInputs: Array<{ el: HTMLInputElement | HTMLTextAreaElement; value: string }> = []
      const sensitiveFields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="password"], input[data-screenshot-exclude="true"], textarea[data-screenshot-exclude="true"]',
      )
      for (const field of sensitiveFields) {
        if (field.value) {
          maskedInputs.push({ el: field, value: field.value })
          field.value = ''
        }
      }
      let blob: Blob | null
      try {
        // Deep-debug M1 — the `filter` predicate runs on every
        // descendant including Text/Comment nodes (despite the
        // library's TS signature claiming HTMLElement). The
        // `instanceof HTMLElement` guard handles this correctly;
        // simplifying to `!node.dataset.screenshotExclude` would
        // crash on Text nodes whose `dataset` is undefined.
        blob = await toBlob(document.body, {
          pixelRatio,
          width: vw,
          height: vh,
          canvasWidth: vw,
          canvasHeight: vh,
          style: {
            transform: `translate(-${window.scrollX}px, -${window.scrollY}px)`,
            transformOrigin: 'top left',
          },
          // Skip excluded elements (this dialog's overlay, toasts, the
          // reaction overlay). True = keep, false = skip (inverse of
          // html2canvas's ignoreElements).
          filter: (node) =>
            !(node instanceof HTMLElement
              && node.dataset.screenshotExclude === 'true'),
          // Deep-debug H1 — `skipFonts: true` prevents the library
          // from re-fetching @font-face binaries. Aurora self-hosts its
          // variable fonts (src/fonts/*.woff2 via @font-face), so without
          // this every Capture click refetches those woff2 files — adds
          // latency and needlessly re-embeds fonts. The DOM is
          // already painted with the user's chosen font; the
          // captured PNG matches what they see on screen via the
          // browser's font cache (NOT via re-embedding the font in
          // the SVG). Worst case on a system that hasn't loaded
          // the font: capture falls back to the next stack font,
          // which is fine for bug-report screenshots.
          skipFonts: true,
        })
      } finally {
        // Restore the blanked values regardless of capture outcome.
        for (const { el, value } of maskedInputs) {
          el.value = value
        }
      }
      if (!mountedRef.current) return
      if (!blob) {
        refuse('Capture failed: the browser could not encode the screenshot.')
        setCaptureAnnounce('Capture failed.')
        return
      }
      if (blob.size > MAX_ATTACHMENT_BYTES) {
        refuse(
          `Capture too large (${(blob.size / 1024 / 1024).toFixed(1)} MB > 25 MB cap). ` +
          'Try uploading a screenshot from disk instead.',
        )
        setCaptureAnnounce('Capture too large.')
        return
      }
      const rawFile = new File(
        [blob],
        `aurora-screenshot-${Date.now()}.png`,
        { type: 'image/png' },
      )
      // 2026-05-27 — Run captured screenshots through the same
      // compression pass as disk uploads. html-to-image at
      // pixelRatio=2 on a 4K viewport can still produce >4 MB PNGs
      // that won't render in the GitHub issue embed via Camo.
      // compressImageIfLarge is a no-op when already small enough.
      //
      // Deep-debug H2 — operation-ID guard so a slow Capture
      // compression can't overwrite a newer disk pick / Capture
      // that landed during the wait.
      const opId = ++attachmentOpRef.current
      const file = await compressImageIfLarge(rawFile)
      if (!mountedRef.current || opId !== attachmentOpRef.current) return
      setAttachmentWithPreview(file)
      setCaptureAnnounce('Screenshot attached.')
      // Reset the file picker so the user can clear-and-pick again
      // without their previous screenshot still showing as selected.
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } catch {
      if (!mountedRef.current) return
      // The capture library's and the browser's words are for a developer.
      refuse('The capture failed. Try again, or attach a screenshot from your device instead.')
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
    // Deep-debug H2 — bump the op ID so any in-flight compression
    // promise no-ops when it resolves (would otherwise restore the
    // attachment the user just cleared).
    attachmentOpRef.current++
    setAttachmentWithPreview(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    // The remove button goes with the attachment it removed; the focus goes
    // to the control that attaches one.
    attachTriggerRef.current?.focus()
  }

  // Deep-debug #27 — Cancel during submit aborts the request via
  // the shared AbortController, then closes the modal.
  //
  // Phase 2 — Cancel is GATED OUT during capture (deep-debug Phase 2
  // #5/#13) because the screenshot library has no abort API
  // (true of both html2canvas and html-to-image); clicking Cancel
  // mid-capture used to unmount the modal but leave the async work
  // running, then setState fire on a dead component.
  //
  // Phase 3 — also gated out during recording for the same reason
  // (MediaRecorder has a stop API, but the user-facing Stop button
  // is right next to Cancel in the UI; gating Cancel forces the
  // intent through Stop and avoids the half-recorded blob arriving
  // on a dead component).
  const handleCancel = () => {
    if (capturingRef.current || recordingRef.current) return
    if (submittingRef.current) {
      submitAcRef.current?.abort()
    }
    onClose()
  }

  // Phase 3 — Screen recording.
  //
  // Flow:
  //   1. Click "Record screen" → request getDisplayMedia (user picks
  //      a screen/window/tab to share via the browser's native
  //      picker)
  //   2. Spin up a MediaRecorder, accumulate Blob chunks, start a
  //      30s auto-stop timer + countdown
  //   3. User clicks Stop early OR timer fires → stop the recorder
  //   4. onstop: assemble chunks into a WebM File, set as attachment,
  //      release the media tracks
  //
  // Browser support: Firefox/Chrome/Edge/Safari 16.4+. getDisplayMedia
  // requires HTTPS in production (works on http://localhost for dev).
  // On unsupported browsers we surface a clear toast and gracefully
  // hide the Record button.
  //
  // PII: the OS-level screen picker is the privacy gate — the user
  // explicitly picks WHICH screen/window/tab to share. Aurora doesn't
  // get to choose. Our PII banner reinforces that whatever they pick
  // becomes the issue body.
  const stopRecordingTimers = () => {
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
    if (recordingCountdownRef.current !== null) {
      window.clearInterval(recordingCountdownRef.current)
      recordingCountdownRef.current = null
    }
  }

  // Release the MediaStream tracks so the browser stops the
  // "this app is sharing your screen" indicator promptly.
  const releaseMediaStream = () => {
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        try { track.stop() } catch { /* defensive */ }
      }
      mediaStreamRef.current = null
    }
  }

  const handleStartRecording = async () => {
    clearError()
    // Phase 3 (deep-debug M6) — re-entrancy guard. The browser's
    // OS picker is modal to the tab, so a normal double-click can't
    // get here twice, but a programmatic re-invocation (test runner,
    // misbehaving extension) could. Bail if a recording is already
    // active or starting.
    if (recordingRef.current) return
    // Feature detection — Safari < 16.4 and some restricted contexts
    // don't have getDisplayMedia at all. Better to bail before we
    // confuse the user with a permission flow that doesn't exist.
    if (typeof navigator === 'undefined'
      || !navigator.mediaDevices?.getDisplayMedia
      || typeof MediaRecorder === 'undefined'
    ) {
      refuse('Screen recording isn\'t supported in this browser. Try Chrome, Edge, Firefox, or Safari 16.4+.')
      return
    }
    setCaptureAnnounce('Requesting screen-share permission…')
    let stream: MediaStream
    try {
      // 2026-05-27 — getDisplayMedia constraints tuned for browser-
      // tab playback compatibility:
      //
      // - `{ max: 1920 } / { max: 1080 } @ { max: 30 }` instead of
      //   the previous `frameRate: 15` hint. Without `{ max: … }`,
      //   Chrome treats the value as a preference and may capture
      //   at native screen resolution + 60fps — verified: a Retina
      //   recording came in at 3420x1972 @ 60fps despite our 15fps
      //   request. Chrome's direct-URL .webm player chokes on 4K@60
      //   even though VLC handles it. 1080p@30 is universally
      //   playable across browsers and produces smaller files.
      //
      // - `audio: true` (was `false`) so the screen-share picker
      //   offers the "Share tab audio" / "Share system audio" toggle.
      //   The user opts in via the picker — no extra permission
      //   prompt from our side. Silent video was insufficient for
      //   audio bugs (chat/voice issues, video playback glitches).
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: 1920 },
          height: { max: 1080 },
          frameRate: { max: 30 },
        },
        audio: true,
      })
    } catch (err) {
      if (!mountedRef.current) return
      // User canceled the screen picker → no error toast, just bail.
      // NotAllowedError is the canonical "user denied" signal.
      const name = err instanceof Error ? err.name : ''
      if (name === 'NotAllowedError' || name === 'AbortError') {
        return
      }
      refuse('Screen recording could not start.')
      return
    }
    if (!mountedRef.current) {
      // Race: user closed the modal during the permission prompt.
      // Release tracks and bail.
      for (const t of stream.getTracks()) try { t.stop() } catch { /* defensive */ }
      return
    }
    mediaStreamRef.current = stream
    // 2026-05-27 (deep-debug H1) — INCLUDE opus in the codec string.
    // MediaRecorder silently DROPS the audio track if the mimeType
    // doesn't declare an audio codec, even when the stream has
    // audio tracks AND audio:true was requested. The result was a
    // perfectly captured WebM with no sound — exactly the user-
    // reported symptom. Cascade now: VP9+Opus → VP8+Opus →
    // unspecified WebM (browser picks both codecs). Tested:
    // - Chrome 140+: vp9+opus
    // - Firefox 110+: vp9+opus
    // - Safari 16.4+: vp8+opus (no VP9)
    let mimeType = 'video/webm;codecs="vp9,opus"'
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm;codecs="vp8,opus"'
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm'
      }
    }
    const chunks: Blob[] = []
    let recorder: MediaRecorder
    try {
      // Bitrate caps stay under the 25 MB attachment cap.
      // - Video: 2.5 Mbps × 30s ≈ 9.4 MB worst-case at 1080p/30fps
      //   (the source constraint above caps both axes).
      // - Audio: 96 kbps × 30s ≈ 360 KB. Explicit so a browser
      //   default of 128 kbps doesn't sneak past the cap.
      // Combined worst-case ~ 9.8 MB — comfortable headroom.
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2_500_000,
        audioBitsPerSecond: 96_000,
      })
    } catch {
      releaseMediaStream()
      refuse('Screen recording could not start.')
      return
    }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = () => {
      stopRecordingTimers()
      releaseMediaStream()
      mediaRecorderRef.current = null
      if (!mountedRef.current) return
      setRecording(false)
      setRecordingRemainingMs(MAX_RECORDING_MS)
      const blob = new Blob(chunks, { type: mimeType.startsWith('video/webm') ? 'video/webm' : mimeType })
      if (blob.size === 0) {
        refuse('Recording produced no data — try again.')
        setCaptureAnnounce('Recording failed: no data captured.')
        return
      }
      if (blob.size > MAX_ATTACHMENT_BYTES) {
        refuse(`Recording too large (${(blob.size / 1024 / 1024).toFixed(1)} MB > 25 MB cap). Try a shorter recording.`)
        setCaptureAnnounce('Recording too large.')
        return
      }
      const file = new File(
        [blob],
        `aurora-recording-${Date.now()}.webm`,
        { type: 'video/webm' },
      )
      setAttachmentWithPreview(file)
      setCaptureAnnounce('Recording attached.')
      // Reset the file picker so the user can clear-and-pick again
      // without their previous recording still showing as selected.
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
    // 2026-05-27 — listen for the user clicking the browser's
    // native "Stop sharing" button (which we can't intercept). When
    // the video track ends from any path, stop the recorder so
    // onstop fires and we finalize the blob.
    //
    // Phase 3 (deep-debug M3) — `{ once: true }` so the listener
    // self-removes after firing. Avoids accumulating dead
    // listeners across multiple record sessions in the same modal
    // instance.
    const videoTrack = stream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => {
        if (mediaRecorderRef.current?.state === 'recording') {
          try { mediaRecorderRef.current.stop() } catch { /* defensive */ }
        }
      }, { once: true })
    }
    // Phase 3 (deep-debug H3) — call recorder.start() BEFORE the
    // setRecording(true) so a thrown start() doesn't leave the
    // modal in a stuck "recording but no recorder" state. If start
    // throws, we release the stream and surface a toast.
    try {
      // L9 — pass a 1000ms timeslice so we get periodic chunks.
      // Without a timeslice, MediaRecorder emits a single chunk at
      // stop time. Periodic chunks bound memory growth during long
      // captures and let a future "show progress" UI sample partial
      // size as the recording proceeds.
      recorder.start(1000)
    } catch {
      releaseMediaStream()
      mediaRecorderRef.current = null
      refuse('Screen recording could not start.')
      setCaptureAnnounce('Recording failed to start.')
      return
    }
    mediaRecorderRef.current = recorder
    setRecording(true)
    setRecordingRemainingMs(MAX_RECORDING_MS)
    setCaptureAnnounce('Recording started — up to 30 seconds.')
    // 30s auto-stop timer.
    recordingTimerRef.current = window.setTimeout(() => {
      if (mediaRecorderRef.current?.state === 'recording') {
        try { mediaRecorderRef.current.stop() } catch { /* defensive */ }
      }
    }, MAX_RECORDING_MS)
    // Countdown ticker (1Hz) for the Stop button label.
    const startedAt = Date.now()
    recordingCountdownRef.current = window.setInterval(() => {
      if (!mountedRef.current) return
      const elapsed = Date.now() - startedAt
      const remaining = Math.max(0, MAX_RECORDING_MS - elapsed)
      setRecordingRemainingMs(remaining)
      if (remaining <= 0 && recordingCountdownRef.current !== null) {
        window.clearInterval(recordingCountdownRef.current)
        recordingCountdownRef.current = null
      }
    }, 1000)
  }

  // Why the last send failed, while nothing has been sent since. Read by
  // the dismissal (below), which closes the dialog in the same pass that
  // would have shown the refusal.
  const unsentRef = useRef<string | null>(null)

  const handleStopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      try { mediaRecorderRef.current.stop() } catch { /* defensive */ }
    }
  }

  // Dismissed by the app (see the prop): close once nothing is in flight. A
  // recording is stopped, which ends it as Stop does and brings this back
  // round; a send or a capture under way is waited for.
  useEffect(() => {
    if (!dismissed) return
    if (recording) { handleStopRecording(); return }
    if (submitting || capturing) return
    if (onDismissed) onDismissed(unsentRef.current)
    else onClose()
    // The callbacks are the caller's; one is called, once, when the state
    // above first allows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed, recording, submitting, capturing])

  // Cleanup recording state on unmount (defensive — onstop is the
  // normal-flow finalization, but a forced unmount via the parent
  // should also stop the recorder, kill the timers, and release the
  // OS-level screen-share so the browser drops the "this app is
  // sharing your screen" indicator immediately.
  //
  // Phase 3 deep-debug L8 — empty deps are intentional: the cleanup
  // body reads from refs (mediaRecorderRef, the ref-shaped timers
  // managed by stopRecordingTimers, and the stream managed by
  // releaseMediaStream). None of those values participate in render
  // identity, so re-running this effect on every render would just
  // be wasted work. The eslint-disable suppresses the
  // react-hooks/exhaustive-deps lint warning that wants to add the
  // closure-captured functions to deps — adding them would NOT
  // change behavior (the functions are stable closures over the
  // same refs) but would force re-binding every render.
  useEffect(() => () => {
    stopRecordingTimers()
    if (mediaRecorderRef.current?.state === 'recording') {
      try { mediaRecorderRef.current.stop() } catch { /* defensive */ }
    }
    releaseMediaStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Send stays focusable while a report is out (a disabled button drops
    // the focus it holds), so a second press is refused here.
    if (submittingRef.current) return
    const trimmedTitle = title.trim()
    const trimmedDesc = description.trim()
    if (!trimmedTitle) {
      refuse('Title is required.', 'title')
      return
    }
    if (!trimmedDesc) {
      refuse('Description is required.', 'description')
      return
    }
    if (sentBytes(trimmedTitle) > MAX_TITLE_LEN) {
      refuse('Title is too long.', 'title')
      return
    }
    if (sentBytes(trimmedDesc) > descriptionMax) {
      refuse('Description is too long.', 'description')
      return
    }
    // The name has no counter (it is optional): its refusal says how much
    // is too much, since the field's own maxLength counts characters and
    // lets a longer name in.
    const nameBytes = sentBytes(name.trim())
    if (nameBytes > MAX_NAME_LEN) {
      refuse(`Your name is too long: ${nameBytes} of ${MAX_NAME_LEN} bytes.`, 'name')
      return
    }
    clearError()
    setFieldRefusal(null)
    unsentRef.current = null
    submittingRef.current = true
    setSubmitting(true)
    const ac = new AbortController()
    submitAcRef.current = ac
    try {
      const result = await submitBugReport({
        title: trimmedTitle,
        description: evidence ? `${trimmedDesc}${EVIDENCE_GAP}${evidence.text}` : trimmedDesc,
        name: name.trim() || undefined,
        attachment: attachment ?? undefined,
        // The page the evidence is about, not wherever the tab is now.
        ...(evidence ? { context: { ...collectClientContext(), url: evidence.url } } : {}),
      }, ac.signal)
      // 2026-05-27 — Switch the modal body to the success view instead
      // of closing + opening the GitHub URL in a new tab. The repo is
      // private; the URL is a login wall for users without repo
      // access. The parent's onSubmitted still fires so the App-level
      // toast confirms the submission, but the modal stays open with
      // a thank-you and the issue number for reference. User closes
      // explicitly via Done.
      //
      // Deep-debug H1 — both the in-modal state update AND the
      // parent's onSubmitted are guarded by mountedRef. If the
      // modal unmounts during the await window (external trigger:
      // parent route change, error boundary), the toast for a
      // disengaged user is suppressed.
      if (mountedRef.current) {
        setSubmittedResult(result)
        onSubmitted(result)
      }
    } catch (err) {
      // Aborts are user-initiated (Cancel); don't surface them as
      // errors. AbortError comes from fetch when signal.aborted.
      if (err && (err as Error).name === 'AbortError') return
      // The route answers 404 only when bug reporting is off on the server.
      const why = failureWords(err, 'send the report', { status: { 404: 'Bug reports are not turned on for this server.' } }) ?? 'The report could not be sent.'
      unsentRef.current = why
      refuse(why)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
      // Only clear the ref if this is still the active request
      // (modal might already be unmounting after abort).
      if (submitAcRef.current === ac) {
        submitAcRef.current = null
      }
    }
  }

  return {
    // What the frame around the form reads.
    submitting, capturing, recording, recordingRemainingMs, submittedResult,
    submittingRef, capturingRef, recordingRef, titleInputRef,
    handleStopRecording,
    // The fields' own.
    descriptionMax, carriesEvidence: !!evidence,
    captureShows: captureShows ?? 'Captures show whatever is on screen now — library, currently playing media, profile info.',
    name, setName, title, setTitle, description, setDescription,
    attachment, attachmentPreviewURL,
    error, errorField, fieldRefusal, refilling, clearError, captureAnnounce,
    fileInputRef, attachTriggerRef, actionsRef,
    handleAttachmentChange, handleCapture, handleClearAttachment, handleStartRecording,
    handleCancel, handleSubmit,
  }
}

export type BugReportFormState = ReturnType<typeof useBugReportForm>

/** The form itself: the fields, the attachment's three ways in, the
 *  refusal and status lines, Cancel and Send. */
export function BugReportFields({ form }: { form: BugReportFormState }) {
  const {
    submitting, capturing, recording, titleInputRef, descriptionMax, carriesEvidence, captureShows,
    name, setName, title, setTitle, description, setDescription,
    attachment, attachmentPreviewURL,
    error, errorField, fieldRefusal, refilling, clearError, captureAnnounce,
    fileInputRef, attachTriggerRef, actionsRef,
    handleAttachmentChange, handleCapture, handleClearAttachment, handleStartRecording,
    handleCancel, handleSubmit,
  } = form
  return (
    <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
      {/* Name. Deep-debug #7 — label clarifies that the value
          is visible in the public GitHub issue. */}
      <div>
        <label htmlFor="bug-name" className="block text-ink text-sm font-semibold mb-1">
          Your name <span className="font-normal text-ink-2">(optional, visible in the GitHub issue)</span>
        </label>
        <input
          id="bug-name"
          type="text"
          value={name}
          onChange={e => { setName(e.target.value); if (errorField === 'name' || (refilling && fieldRefusal?.field === 'name')) clearError() }}
          maxLength={MAX_NAME_LEN}
          aria-invalid={errorField === 'name'}
          aria-describedby={errorField === 'name' ? 'bug-error' : undefined}
          // Read-only, not disabled, while the report is sent: a disabled
          // field drops the focus it holds.
          readOnly={submitting}
          disabled={capturing || recording}
          placeholder="So we can credit you in the issue thread"
          className="w-full disabled:opacity-50 read-only:opacity-60"
        />
      </div>

      {/* Title */}
      <div>
        <label htmlFor="bug-title" className="block text-ink text-sm font-semibold mb-1">
          Title <span className="text-danger-ink" aria-hidden="true">*</span>
        </label>
        <input
          id="bug-title"
          ref={titleInputRef}
          type="text"
          value={title}
          onChange={e => { setTitle(e.target.value); if (errorField === 'title' || (refilling && fieldRefusal?.field === 'title')) clearError() }}
          maxLength={MAX_TITLE_LEN}
          required
          aria-invalid={errorField === 'title'}
          aria-describedby={errorField === 'title' ? 'bug-error' : undefined}
          // Read-only, not disabled, while the report is sent: a disabled
          // field drops the focus it holds.
          readOnly={submitting}
          disabled={capturing || recording}
          placeholder="e.g. Continue Watching card jumps to wrong episode"
          className="w-full disabled:opacity-50 read-only:opacity-60"
        />
        <p className="text-ink-2 text-xs mt-1 tabular-nums">
          {sentBytes(title)} / {MAX_TITLE_LEN} bytes
        </p>
      </div>

      {/* Description */}
      <div>
        <label htmlFor="bug-desc" className="block text-ink text-sm font-semibold mb-1">
          Description <span className="text-danger-ink" aria-hidden="true">*</span>
        </label>
        <textarea
          id="bug-desc"
          value={description}
          onChange={e => { setDescription(e.target.value); if (errorField === 'description' || (refilling && fieldRefusal?.field === 'description')) clearError() }}
          // The browser counts string units here, never more than the
          // bytes sent: a ceiling, with the true count in the line below
          // and in the check on Send.
          maxLength={descriptionMax}
          required
          aria-invalid={errorField === 'description'}
          aria-describedby={errorField === 'description' ? 'bug-error' : undefined}
          // Read-only, not disabled, while the report is sent: a disabled
          // field drops the focus it holds.
          readOnly={submitting}
          disabled={capturing || recording}
          rows={6}
          placeholder="What did you expect to happen? What actually happened? Steps to reproduce?"
          className="w-full disabled:opacity-50 read-only:opacity-60 resize-y min-h-[120px]"
        />
        <p className="text-ink-2 text-xs mt-1 tabular-nums">
          {sentBytes(description)} / {descriptionMax} bytes
        </p>
      </div>

      {/* Attachment */}
      <div>
        {/* The heading of a group of three buttons, not the label of
            one of them: as a <label> for the first it became that
            button's name, so "Choose file" was announced as
            "Screenshot or recording (optional, max 25 MB)". */}
        <p id="bug-attachment-label" className="block text-ink text-sm font-semibold mb-1">
          Screenshot or recording <span className="font-normal text-ink-2">(optional, max 25 MB)</span>
        </p>
        {/* 2026-05-27 polish — three matching outlined buttons in a
            consistent row. Native file <input> is hidden behind a
            custom-styled "Choose file" button so all three options
            share the same visual treatment (previously the native
            input rendered the browser's ugly "Choose File / No
            f...sen" with truncated label). Each button now carries
            a small format hint to differentiate
            (File / PNG / WebM 30s).
            Deep-debug M2 — tabIndex={-1} + aria-hidden so the
            hidden input doesn't double-up the tab stop. The
            styled button below is the sole keyboard/AT entry
            point. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          onChange={handleAttachmentChange}
          disabled={submitting || capturing || recording}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />
        <div role="group" aria-labelledby="bug-attachment-label" className="flex items-center gap-2.5 flex-wrap">
          {/* Custom-styled file-picker trigger. Matches Capture /
              Record visually. Forwards click to the hidden native
              <input> so the browser's picker still opens.
              Deep-debug M3 — aria-haspopup="dialog" so AT users
              hear that activation opens a file-picker dialog
              (the native input carries that semantic implicitly;
              the custom button has to declare it). */}
          <button
            ref={attachTriggerRef}
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting || capturing || recording}
            title="Upload a screenshot or recording from your device"
            aria-haspopup="dialog"
            className="stage-btn stage-btn-sm stage-btn-ghost stage-hit44 shrink-0"
          >
            {/* Upload glyph */}
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Choose file
            {/* 2026-05-27 — dropped the "· File" suffix (redundant
                with the button label). Format hints now appear only
                on Capture (· PNG) and Record (· WebM 30s) where they
                actually convey new info. */}
          </button>
          {/* Phase 2 — "Capture this page" button. Briefly hides
              the modal so the screenshot doesn't include the form
              itself, then sets the captured image as the
              attachment. Disabled while submitting OR another
              capture is already in flight. */}
          <button
            type="button"
            onClick={handleCapture}
            disabled={submitting || capturing || recording}
            title="Capture a screenshot of the visible page area"
            className="stage-btn stage-btn-sm stage-btn-ghost stage-hit44 shrink-0"
          >
            {capturing ? (
              // Phase 2 (deep-debug #15) — inline spinner during
              // capture (covers both lazy-import + library
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
            {!capturing && <span className="text-ink-2 font-normal">· PNG</span>}
          </button>
          {/* Phase 3 — Record screen. Stop button shown while
              recording with a live countdown; auto-stops at 30s.
              The browser's screen-picker is the privacy gate
              (user chooses what to share); we display the
              remaining time so they know when auto-stop fires. */}
          {recording ? (
            // Holistic deep-debug S1 — during recording the modal
            // is opacity:0 + pointer-events:none, so an in-modal
            // Stop button is invisible AND unreachable. The
            // portal'd floating Stop pill at the bottom of the
            // viewport is the canonical Stop control while
            // recording. Nothing to render here.
            null
          ) : (
            <button
              type="button"
              onClick={handleStartRecording}
              disabled={submitting || capturing || recording}
              title="Record up to 30 seconds of your screen"
              className="stage-btn stage-btn-sm stage-btn-ghost stage-hit44 shrink-0"
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-danger-ink">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
              Record screen
              <span className="text-ink-2 font-normal">· WebM 30s</span>
            </button>
          )}
        </div>
        <p className="text-ink-2 text-xs mt-2 leading-snug">
          Use Capture for a screenshot or Record screen for up to 30 seconds of video — the form will hide briefly for capture.
        </p>
        {/* Phase 2 (deep-debug #4) — PRE-capture PII notice. Shown
            always above the controls so the user understands what
            gets captured BEFORE clicking, not after the blob is
            already in memory. Separate from the post-attachment
            warning further down (which reinforces the warning
            once they see what they captured). */}
        <p className="text-warn text-xs mt-1 leading-snug">
          {captureShows}{' '}
          If you Record screen and choose to share tab or system audio in the browser's share
          dialog, that audio is recorded into the clip too. Review the thumbnail below before sending.
        </p>
        {attachment && (
          <div className="mt-2 flex items-center gap-3 p-2 rounded-control bg-surface-raised">
            {/* Phase 2 — thumbnail preview when the attachment is
                an image (captured screenshot OR uploaded PNG/JPG).
                Phase 3 (deep-debug L5) — also preview video/* via
                a native <video> element so recorded WebM has the
                same "verify before submit" UX as captured PNGs.
                The browser handles the thumbnail render natively;
                no canvas step needed. */}
            {attachmentPreviewURL && attachment?.type.startsWith('video/') ? (
              <video
                src={attachmentPreviewURL}
                muted
                playsInline
                className="w-20 h-12 object-cover rounded-chip shrink-0 bg-black"
              />
            ) : attachmentPreviewURL ? (
              <img
                src={attachmentPreviewURL}
                alt="Attachment preview"
                className="w-20 h-12 object-cover rounded-chip shrink-0"
              />
            ) : null}
            <div className="flex-1 min-w-0">
              <p className="text-ink text-xs truncate">{attachment.name}</p>
              <p className="text-ink-2 text-xs tabular-nums">
                {(attachment.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
            {/* Deep-debug #26 — × to clear the selection. */}
            <button
              type="button"
              onClick={handleClearAttachment}
              disabled={submitting || capturing || recording}
              className="grid h-11 w-11 flex-none place-items-center rounded-control text-ink-2 transition-colors hover:bg-action-soft hover:text-ink disabled:opacity-50"
              aria-label="Remove attachment"
              title="Remove attachment"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
      </div>

      {/* PII warning — visible always (was attachment-only). The
          diagnostic buffer (last 200 console messages + 100
          network requests) is auto-attached to every submission
          starting 2026-05-27, so users should be aware even when
          they don't add a screenshot/recording. Captured data
          skips request bodies and headers; sensitive URL params
          (tokens, passwords, api keys, etc.) are redacted before
          capture. */}
      <div className="rounded-chip bg-surface-raised px-3 py-2 text-ink-2 text-xs leading-snug">
        <strong className="font-semibold text-ink">Heads-up:</strong> every report includes a recent
        console + network log (last few minutes) for triage. Sensitive
        URL params (tokens, passwords, API keys) are redacted before
        attaching, and bodies/headers are never captured.
        {/* Said wherever it is sent: the page's own evidence. No promise
            that a report leaves out what was watched; an address, an
            error's text and the log's requests can each point at a title. */}
        {carriesEvidence && (
          <span data-evidence-note="">
            {' '}This report also carries what the app saw, exactly as it is
            shown on this page: the error's text, the page's address, the
            time and the build. With the log, that can show which pages and
            titles were open.
          </span>
        )}
        {attachment && (
          <>
            {' '}Screenshots and recordings may also show personal data
            (your library, currently playing media, profile info) —
            review what you're attaching before sending.
            {attachment.type.startsWith('video/') && (
              <>
                {' '}If you shared tab or system audio in the screen-share
                dialog, that audio is part of this recording and will be
                uploaded with the report.
              </>
            )}
          </>
        )}
      </div>

      {/* A refusal: the form's own checks, a capture that failed, the
          server's answer. An alert, always in the page so that its
          words arriving are what is announced. */}
      <p id="bug-error" role="alert" className={error ? 'text-danger-ink text-sm leading-snug' : refilling ? 'min-h-[1.375em] text-sm leading-snug' : 'sr-only'}>
        {error ?? ''}
      </p>

      {/* Phase 2 (deep-debug #10) — sr-only aria-live region so
          screen readers hear capture progress. Visible text stays
          on the Capture button itself. */}
      <p className="sr-only" role="status" aria-live="polite">
        {captureAnnounce}
      </p>

      {/* Actions */}
      <div ref={actionsRef} className="flex flex-wrap items-center justify-end gap-2 pt-2">
        {/* Deep-debug #27 — Cancel stays enabled during submit
            so a slow GitHub can be aborted (the AbortController
            cancels the in-flight fetch via handleCancel).
            Phase 2 (deep-debug #5/#13) — also disabled during
            capture because the screenshot library has no abort
            API (true of both html2canvas and html-to-image) and
            the modal can't safely unmount mid-capture.
            Phase 3 — also disabled during screen recording so
            the user goes through the Stop button (which fires
            the proper onstop handler) rather than dismissing
            the modal with a half-recorded blob. */}
        <button
          type="button"
          onClick={handleCancel}
          disabled={capturing || recording}
          className="stage-btn stage-btn-quiet"
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
          disabled={capturing || recording}
          aria-disabled={submitting}
          className="stage-btn stage-btn-primary"
        >
          {submitting ? 'Sending…' : 'Send report'}
        </button>
      </div>
    </form>
  )
}

/** What replaces the form once the report has been sent. No link to the
 *  issue: the repository is private, and its address is a login wall for
 *  most. The number is the person's reference. */
export function BugReportSent({ result, onClose }: { result: BugReportSubmitResult; onClose: () => void }) {
  return (
    <div className="px-6 py-6 space-y-4">
      <div className="flex items-start gap-3">
        {/* Checkmark glyph */}
        <div className="shrink-0 w-10 h-10 rounded-full bg-surface-raised flex items-center justify-center text-ok">
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <div className="text-ink text-sm">
          <p>Sent. Aurora's team will take it from here.</p>
          <p className="text-ink-2 text-xs mt-1">
            Reference: <span className="font-mono text-ink">issue #{result.issue_number}</span>
          </p>
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="stage-btn stage-btn-primary"
        >
          Done
        </button>
      </div>
    </div>
  )
}

/** For a session with the admin's powers, when the token the server files
 *  reports with is failing its checks: nobody's report can be sent. */
export function BugReportTokenNotice({ reason }: { reason?: string }) {
  return (
    <div
      className="mx-6 mt-4 rounded-chip bg-surface-raised border-l-2 border-current px-3 py-2 text-warn text-xs leading-snug"
      role="alert"
    >
      <strong>Admin notice — GitHub token issue:</strong>{' '}
      {reason || 'The configured PAT failed its most recent health check.'}{' '}
      Nobody can send a bug report until this is resolved. See{' '}
      <code className="font-mono">docs/bug-report-setup.md</code>.
    </div>
  )
}

/** The Stop control of a recording under way. Drawn at the top of the
 *  window, outside whatever frames the form: the frame is hidden while the
 *  screen is recorded, and this is what stays. */
export function BugReportRecordingPill({ form }: { form: BugReportFormState }) {
  const { recording, recordingRemainingMs, handleStopRecording } = form
  if (!recording || typeof document === 'undefined') return null
  return createPortal(
    // Deep-debug H2 — z-[210] sits ABOVE toasts (z-[200]) and every
    // other Aurora overlay. Background-page interaction is the whole
    // point during recording, but if a toast fires during the user's
    // 30s window, the Stop control must remain visible.
    // Deep-debug S8 — role="status" with aria-live so SR users
    // hear the "Recording · Xs left" countdown periodically.
    // Deep-debug L6 — border-rose-500/80 (was /50) so the widget
    // edge meets WCAG 1.4.11 3:1 non-text contrast on the
    // near-black widget background.
    <div
      data-screenshot-exclude="true"
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[210] inline-flex items-center gap-3 pl-4 pr-1.5 py-1.5 rounded-control bg-surface-raised-2 shadow-[shadow:var(--shadow-modal)]"
    >
      {/* Pulsing red dot — the universal "recording active" cue.
          Deep-debug L5 — motion-safe: prefix so users with
          prefers-reduced-motion get the solid red dot without the
          ping animation. The static dot + countdown text still
          carry the recording-state meaning. */}
      <span aria-hidden="true" className="relative inline-flex items-center justify-center w-3 h-3">
        <span className="absolute inset-0 rounded-full bg-danger-ink motion-safe:animate-ping opacity-75" />
        <span className="relative inline-block w-3 h-3 rounded-full bg-danger-ink" />
      </span>
      <span className="text-ink text-sm font-medium tabular-nums">
        {/* Deep-debug M3 — clamp at 1 so the countdown never
            shows "0s left" between the last tick and the
            recorder.stop() callback firing. */}
        Recording · {Math.max(1, Math.ceil(recordingRemainingMs / 1000))}s left
      </span>
      <button
        type="button"
        onClick={handleStopRecording}
        aria-label="Stop screen recording"
        autoFocus
        className="stage-btn stage-btn-sm stage-btn-destructive stage-hit44"
      >
        <span aria-hidden="true" className="inline-block w-2.5 h-2.5 rounded-[2px] bg-current" />
        Stop
      </button>
    </div>,
    document.body,
  )
}
