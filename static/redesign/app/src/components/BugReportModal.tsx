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
//   - Restore focus to the launcher on close (handled by React via
//     last-focused tracking — see useEffect below)
//   - role/aria already set; aria-live error region announces
//     validation failures

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

// Phase 3 — screen-recording hard cap. WebM at ~1080p with VP9
// averages 1-3 MB/sec, so 30s stays well under the 25 MB attachment
// cap with headroom for high-motion frames. Auto-stop on timer
// expiry; user can also stop early via the in-recording UI.
const MAX_RECORDING_MS = 30_000

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
    setError(null)
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
      setError('Screen recording isn\'t supported in this browser. Try Chrome, Edge, Firefox, or Safari 16.4+.')
      return
    }
    setCaptureAnnounce('Requesting screen-share permission…')
    let stream: MediaStream
    try {
      // Always request video; audio is opt-in and many browsers
      // require an explicit user gesture for it. We DON'T request
      // audio here — for a bug-report flow, silent video is
      // sufficient and skips the extra permission prompt.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 }, // 15fps is plenty for UI bug repro
        audio: false,
      })
    } catch (err) {
      if (!mountedRef.current) return
      // User canceled the screen picker → no error toast, just bail.
      // NotAllowedError is the canonical "user denied" signal.
      const name = err instanceof Error ? err.name : ''
      if (name === 'NotAllowedError' || name === 'AbortError') {
        return
      }
      setError(err instanceof Error
        ? `Screen recording failed to start: ${err.message}`
        : 'Screen recording failed to start.')
      return
    }
    if (!mountedRef.current) {
      // Race: user closed the modal during the permission prompt.
      // Release tracks and bail.
      for (const t of stream.getTracks()) try { t.stop() } catch { /* defensive */ }
      return
    }
    mediaStreamRef.current = stream
    // Prefer VP9 (smaller, better quality); fall back to VP8 then
    // unspecified WebM which lets the browser pick. Test isType-
    // Supported because Safari doesn't support VP9 yet.
    let mimeType = 'video/webm;codecs=vp9'
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm;codecs=vp8'
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm'
      }
    }
    const chunks: Blob[] = []
    let recorder: MediaRecorder
    try {
      // Phase 3 (deep-debug L6) — bitrate cap. Default Chrome bitrate
      // on a 4K screen can be 8-10 Mbps which over 30s exceeds the
      // 25 MB attachment cap. 2.5 Mbps × 30s ≈ 9 MB worst-case;
      // plenty for 15fps UI bug repro and stays comfortably inside
      // the cap.
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2_500_000,
      })
    } catch (err) {
      releaseMediaStream()
      setError(err instanceof Error
        ? `Recorder init failed: ${err.message}`
        : 'Recorder init failed.')
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
        setError('Recording produced no data — try again.')
        setCaptureAnnounce('Recording failed: no data captured.')
        return
      }
      if (blob.size > MAX_ATTACHMENT_BYTES) {
        setError(`Recording too large (${(blob.size / 1024 / 1024).toFixed(1)} MB > 25 MB cap). Try a shorter recording.`)
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
    } catch (err) {
      releaseMediaStream()
      mediaRecorderRef.current = null
      setError(err instanceof Error
        ? `Recorder failed to start: ${err.message}`
        : 'Recorder failed to start.')
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

  const handleStopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      try { mediaRecorderRef.current.stop() } catch { /* defensive */ }
    }
  }

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
    <>
    <div
      // Phase 2 (deep-debug #10/#11): hide via opacity + pointer-events
      // instead of visibility:hidden during capture. Keeps the modal
      // in the a11y tree (screen readers retain orientation) and the
      // focus trap doesn't lose its anchor. aria-busy on the panel
      // announces the async work. data-screenshot-exclude carries the
      // ignoreElements signal so html2canvas filters us out by
      // attribute (matches the launcher's opt-out).
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-fade-in"
      style={capturing || recording ? { opacity: 0, pointerEvents: 'none' } : undefined}
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
        className="w-full max-w-[560px] bg-[#0a0a0f] rounded-2xl border border-white/[0.08] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bug-report-title"
        aria-busy={capturing || submitting || recording}
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
              disabled={submitting || capturing || recording}
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
              disabled={submitting || capturing || recording}
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
              disabled={submitting || capturing || recording}
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
                disabled={submitting || capturing || recording}
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
                disabled={submitting || capturing || recording}
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
              {/* Phase 3 — Record screen. Stop button shown while
                  recording with a live countdown; auto-stops at 30s.
                  The browser's screen-picker is the privacy gate
                  (user chooses what to share); we display the
                  remaining time so they know when auto-stop fires. */}
              {recording ? (
                <button
                  type="button"
                  onClick={handleStopRecording}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-rose-600/30 hover:bg-rose-600/40 border border-rose-500/40 text-rose-100 text-xs font-medium transition-colors animate-pulse"
                  title="Stop recording now (otherwise auto-stops at 30s)"
                >
                  {/* Solid square = stop glyph. */}
                  <span aria-hidden="true" className="inline-block w-2.5 h-2.5 bg-rose-100 rounded-sm" />
                  Stop · {Math.ceil(recordingRemainingMs / 1000)}s
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStartRecording}
                  disabled={submitting || capturing || recording}
                  title="Record up to 30 seconds of your screen"
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-white/80 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="12" cy="12" r="3" fill="currentColor" />
                  </svg>
                  Record screen
                </button>
              )}
            </div>
            <p className="text-white/30 text-[10px] mt-1">
              Use Capture for a screenshot or Record screen for up to 30 seconds of video — the form will hide briefly for capture.
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
                    className="w-20 h-12 object-cover rounded border border-white/[0.08] shrink-0 bg-black"
                  />
                ) : attachmentPreviewURL ? (
                  <img
                    src={attachmentPreviewURL}
                    alt="Attachment preview"
                    className="w-20 h-12 object-cover rounded border border-white/[0.08] shrink-0"
                  />
                ) : null}
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
                  disabled={submitting || capturing || recording}
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
                modal can't safely unmount mid-capture.
                Phase 3 — also disabled during screen recording so
                the user goes through the Stop button (which fires
                the proper onstop handler) rather than dismissing
                the modal with a half-recorded blob. */}
            <button
              type="button"
              onClick={handleCancel}
              disabled={capturing || recording}
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
              disabled={submitting || capturing || recording}
              className="px-5 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Submitting…' : 'Submit Report'}
            </button>
          </div>
        </form>
      </div>
    </div>
    {/* Phase 3 deep-debug H4/M2 — Floating Stop pill rendered via
        a portal to document.body so it escapes the modal overlay's
        opacity:0 + pointer-events:none during recording. Without
        the portal, the pill was inside the focus-trap query and the
        Tab cycle missed it (it sits outside the modal panel ref).
        With the portal, focus moves to the pill on mount and Tab
        leaves it alone (no other focusable in body). */}
    {recording && typeof document !== 'undefined' && createPortal(
      <button
        type="button"
        onClick={handleStopRecording}
        data-screenshot-exclude="true"
        aria-label="Stop screen recording"
        autoFocus
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] inline-flex items-center gap-2 px-5 py-3 rounded-full bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium shadow-2xl animate-pulse"
      >
        <span aria-hidden="true" className="inline-block w-3 h-3 bg-white rounded-sm" />
        Stop recording · {Math.ceil(recordingRemainingMs / 1000)}s
      </button>,
      document.body,
    )}
    </>
  )
}
