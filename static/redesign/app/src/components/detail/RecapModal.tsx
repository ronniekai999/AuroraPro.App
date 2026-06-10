// Aurora V2 — "Previously" recap modal.
//
// Shows a short, spoiler-safe "where things stand" brief for a series the
// viewer is resuming. The text is generated server-side (GET /api/media/{id}/
// recap) from the synopses of episodes the viewer has already finished, bounded
// to their resume point — so it never spoils ahead. This component is purely
// presentational: DetailView owns the fetch and passes loading / recap / error
// in. Closes on Escape, backdrop click, and the Close button — mirroring the
// other Aurora modals (TrailerModal).

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SparkleIcon, PlayIcon } from './icons'

export interface RecapUpTo {
  season: number
  episode: number
  title?: string
}

interface Props {
  title: string
  loading: boolean
  recap?: string
  upTo?: RecapUpTo
  // Set when the server returned available:false — a friendly reason code
  // ("ai_unavailable" | "no_history" | "insufficient_overviews").
  unavailableReason?: string
  error?: string | null
  onClose: () => void
  onStart?: () => void // optional "Resume" CTA wired to the next episode
}

// Maps the server's reason codes to friendly copy. Keeps the "nothing to show"
// states warm rather than error-like.
function reasonCopy(reason: string): { head: string; body: string } {
  switch (reason) {
    case 'no_history':
      return {
        head: 'Nothing to recap yet',
        body: 'Finish an episode and Aurora will catch you up next time — spoiler-free.',
      }
    case 'insufficient_overviews':
      return {
        head: 'Not enough to go on',
        body: 'This series is missing episode synopses, so there’s nothing to summarize yet.',
      }
    case 'ai_unavailable':
      return {
        head: 'Recaps are off',
        body: 'The local AI isn’t configured on this server, so recaps aren’t available.',
      }
    default:
      return { head: 'No recap available', body: 'There’s nothing to show for this title right now.' }
  }
}

export function RecapModal({
  title,
  loading,
  recap,
  upTo,
  unavailableReason,
  error,
  onClose,
  onStart,
}: Props) {
  // Escape-to-close, mirroring the other Aurora modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Typewriter reveal once the recap text arrives. Respects reduced-motion.
  const [shown, setShown] = useState('')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    window.clearInterval(timer.current)
    if (!recap) {
      setShown('')
      return
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      setShown(recap)
      return
    }
    let i = 0
    timer.current = window.setInterval(() => {
      i = Math.min(recap.length, i + 2)
      setShown(recap.slice(0, i))
      if (i >= recap.length) window.clearInterval(timer.current)
    }, 16)
    return () => window.clearInterval(timer.current)
  }, [recap])

  const upToLabel = upTo ? `Caught up to S${upTo.season} · E${upTo.episode}` : undefined

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Previously, on ${title}`}
    >
      <div
        className="relative w-full max-w-[600px] rounded-2xl overflow-hidden bg-gradient-to-b from-[#16131d] to-[#100e15] shadow-2xl ring-1 ring-purple-500/30"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="px-6 pt-6 pb-4 border-b border-white/10">
          <div className="flex items-center gap-1.5 text-purple-300 text-[11px] font-semibold uppercase tracking-[0.18em]">
            <SparkleIcon size={13} /> Previously
          </div>
          <h2 className="font-display font-bold text-2xl md:text-[1.7rem] leading-tight mt-1.5">
            Previously, on <span className="text-purple-200">{title}</span>
          </h2>
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="badge-glass bg-emerald-500/10 text-emerald-200 border border-emerald-400/30 inline-flex items-center gap-1">
              🛡️ Spoiler-safe
            </span>
            {upToLabel && (
              <span className="badge-glass bg-white/5 text-white/60 border border-white/10">{upToLabel}</span>
            )}
            <span className="badge-glass bg-purple-500/10 text-purple-200 border border-purple-500/25 inline-flex items-center gap-1">
              ⚡ Aurora AI
            </span>
          </div>
        </div>

        {/* body */}
        <div className="px-6 py-5 min-h-[150px]">
          {loading && (
            <div className="space-y-3 animate-pulse" aria-label="Generating recap">
              <div className="h-4 rounded bg-white/10 w-[92%]" />
              <div className="h-4 rounded bg-white/10 w-[97%]" />
              <div className="h-4 rounded bg-white/10 w-[85%]" />
              <div className="h-4 rounded bg-white/10 w-[60%]" />
              <p className="text-white/40 text-xs pt-1">Catching you up…</p>
            </div>
          )}

          {!loading && error && (
            <div className="text-center py-6">
              <p className="text-red-300/90 font-medium">Couldn’t build the recap</p>
              <p className="text-white/50 text-sm mt-1">{error}</p>
            </div>
          )}

          {!loading && !error && unavailableReason && (() => {
            const c = reasonCopy(unavailableReason)
            return (
              <div className="text-center py-6">
                <p className="text-white/90 font-medium">{c.head}</p>
                <p className="text-white/55 text-sm mt-1.5 max-w-sm mx-auto">{c.body}</p>
              </div>
            )
          })()}

          {!loading && !error && recap && (
            <p className="text-[16px] leading-[1.7] text-white/90">
              {shown}
              {shown.length < recap.length && (
                <span className="inline-block w-[8px] -mb-[1px] bg-purple-400 animate-pulse">&nbsp;</span>
              )}
            </p>
          )}
        </div>

        {/* footer */}
        <div className="px-6 py-4 border-t border-white/10 flex items-center justify-between gap-3">
          <p className="text-white/40 text-[11.5px] max-w-[280px]">
            Built only from episodes you’ve finished — nothing beyond your spot.
          </p>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-full text-sm font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-white/85 transition-all"
            >
              Close
            </button>
            {onStart && (
              <button
                type="button"
                onClick={onStart}
                className="px-4 py-2 rounded-full text-sm font-semibold inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-500 transition-all shadow-[0_0_20px_rgba(168,85,247,0.45)]"
              >
                <PlayIcon size={15} /> Resume
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
