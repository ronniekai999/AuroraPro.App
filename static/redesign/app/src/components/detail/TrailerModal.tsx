// Aurora V2 — trailer modal.
//
// A lightweight full-screen overlay that embeds a YouTube trailer for a movie
// or show. The app's main <VideoPlayer> is hls.js-based and can't play a
// YouTube URL, so trailers use an iframe embed instead. We use the
// youtube-nocookie host so the embed doesn't set tracking cookies until the
// user actually plays (privacy-friendlier for a self-hosted server).
//
// Closes on Escape, on backdrop click, and via the Close button. autoplay is
// allowed because opening the modal follows a user gesture (the button click).

import { useEffect } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  youtubeKey: string
  title?: string
  onClose: () => void
}

export function TrailerModal({ youtubeKey, title, onClose }: Props) {
  // Escape-to-close, mirroring the other Aurora modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const src =
    `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeKey)}` +
    `?autoplay=1&rel=0&modestbranding=1`

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 stage-scrim-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title ? `${title} — Trailer` : 'Trailer'}
    >
      <div
        className="relative w-full max-w-[min(92vw,1100px)] aspect-video rounded-2xl overflow-hidden bg-black shadow-[shadow:var(--shadow-modal)] ring-1 ring-white/10 stage-dialog-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* referrerPolicy overrides the SPA's `Referrer-Policy: no-referrer`
            (set in router.go frontendHeaders) for THIS iframe only. Without a
            referrer, YouTube's embed fails with "Error 153 — Video player
            configuration error" because it can't see the embedding origin.
            Sending the origin fixes it while keeping no-referrer everywhere
            else. */}
        <iframe
          className="absolute inset-0 h-full w-full"
          src={src}
          title={title ? `${title} — Trailer` : 'Trailer'}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close trailer"
        className="absolute top-4 right-4 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white text-sm transition-colors"
      >
        Close
      </button>
    </div>,
    document.body,
  )
}
