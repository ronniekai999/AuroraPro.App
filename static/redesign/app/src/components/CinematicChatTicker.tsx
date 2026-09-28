// Aurora V2 — CinematicChatTicker
//
// Lower-third, auto-fading chat ticker for the watch-party "minimal"
// (cinematic) overlay mode. It reads the SAME `state.chat` the docked
// PartyPanel renders, but instead of a scrollable log it shows only the
// last few messages floating over the bottom of the video, then fades
// each one out and dismisses it after a few seconds — so the resting
// state is "just the movie."
//
// Cinematic overlay contract (`.ticker`):
//   - lower-third, left-aligned, translucent glass bubbles
//   - purple author name, near-white message text (AA over the blur)
//   - new messages slide in from the left (motion-safe only)
//   - older still-visible messages dim (opacity .45) before they leave
//
// Lifecycle correctness (this is the tricky part):
//   - We never want the initial chat backlog to all animate in at once
//     when the user flips into minimal mode mid-party. So on first
//     render we mark every existing message id as "seen" WITHOUT
//     showing it, exactly like ReactionOverlay seeds its seen-set.
//   - Each shown message gets a setTimeout that fades it, then a second
//     to remove it. ALL timers are tracked and cleared on unmount so a
//     mode-toggle or party-leave can't leave dangling timers firing
//     setState on an unmounted tree.
//
// This component is render-only meta-UI over transient chat, so — like
// ReactionOverlay — it's marked data-screenshot-exclude so other
// people's chat doesn't leak into a bug-report screenshot, and
// aria-hidden because the docked PartyPanel chat log is the accessible
// source of truth for messages (a screen-reader user runs the rail).

import { useEffect, useRef, useState } from 'react'
import type { ChatMessageEvent } from '@/lib/party'

interface Props {
  chat: ChatMessageEvent[]
  // Highlight the current user's own messages with the purple "me" tint.
  currentUserId?: number
  // How many messages to keep on screen at once (oldest drop off the
  // top as new ones arrive). Default mirrors the mockup's ~3.
  maxVisible?: number
  // How long a message stays fully lit before it dims + auto-dismisses.
  // The dim phase is a short fixed tail after this.
  fadeMs?: number
}

// The fixed tail (ms) between a message dimming and being removed from
// the DOM. Long enough to read the fade; short enough to feel cinematic.
const DISMISS_TAIL_MS = 1200

interface TickerItem {
  id: string
  username: string
  message: string
  mine: boolean
  // false once the dim timer has fired — drives the opacity-down tween.
  lit: boolean
}

export function CinematicChatTicker({
  chat,
  currentUserId,
  maxVisible = 3,
  fadeMs = 5000,
}: Props) {
  const [items, setItems] = useState<TickerItem[]>([])
  // Message ids we've already turned into ticker items — prevents a
  // re-render (or the 200-cap array churning) from re-animating a
  // message we already showed. Mirrors ReactionOverlay's seenIdsRef.
  const seenRef = useRef<Set<string>>(new Set())
  // Track every live timer so unmount can clear them — otherwise a
  // mode-toggle/leave during a message's lifetime fires setState on an
  // unmounted component (React warning + wasted work).
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  // First-pass guard: seed the seen-set with the existing backlog so
  // flipping into minimal mode mid-party doesn't replay the whole log.
  const seededRef = useRef(false)

  useEffect(() => {
    const seen = seenRef.current
    const timers = timersRef.current

    // First effect run: adopt the current backlog as "already seen"
    // without rendering any of it. Subsequent messages animate in.
    if (!seededRef.current) {
      seededRef.current = true
      for (const m of chat) seen.add(m.id)
      return
    }

    const fresh = chat.filter(m => !seen.has(m.id))
    if (fresh.length === 0) return

    const additions: TickerItem[] = fresh.map(m => {
      seen.add(m.id)
      return {
        id: m.id,
        username: m.username,
        message: m.message,
        mine: m.user_id === currentUserId,
        lit: true,
      }
    })

    setItems(prev => {
      // Append new, then keep only the newest `maxVisible`. Anything
      // dropped here is replaced by a fresher message, so its dangling
      // dim/remove timers become harmless no-ops (they filter on id).
      const next = [...prev, ...additions]
      return next.length > maxVisible ? next.slice(next.length - maxVisible) : next
    })

    // Schedule the dim → remove lifecycle for each new message.
    for (const item of additions) {
      const dim = setTimeout(() => {
        timers.delete(dim)
        setItems(prev => prev.map(i => (i.id === item.id ? { ...i, lit: false } : i)))
      }, fadeMs)
      timers.add(dim)

      const drop = setTimeout(() => {
        timers.delete(drop)
        setItems(prev => prev.filter(i => i.id !== item.id))
      }, fadeMs + DISMISS_TAIL_MS)
      timers.add(drop)
    }

    // Bound the seen-set so a marathon session doesn't grow it forever.
    if (seen.size > 400) {
      seenRef.current = new Set(Array.from(seen).slice(-400))
    }
  }, [chat, currentUserId, maxVisible, fadeMs])

  // Clear every outstanding timer on unmount.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }, [])

  if (items.length === 0) return null

  return (
    <>
      {/* Scoped keyframe — injected in-component (the ReactionOverlay
          pattern) so the ticker is self-contained and doesn't depend on
          an index.css edit. Gated by the media query so reduced-motion
          users get an instant appear with no horizontal slide. */}
      <style>{`
        @keyframes aurora-ticker-in {
          from { transform: translateX(-12px); opacity: 0; }
          to   { transform: translateX(0);     opacity: 1; }
        }
        @media (prefers-reduced-motion: no-preference) {
          .aurora-ticker-msg { animation: aurora-ticker-in 0.4s ease-out both; }
        }
      `}</style>
      <div
        aria-hidden="true"
        data-screenshot-exclude="true"
        className="fixed left-4 right-4 bottom-12 z-[66] flex flex-col items-start gap-1.5 pointer-events-none"
      >
        {items.map(item => (
          <div
            key={item.id}
            className={[
              'aurora-ticker-msg inline-flex items-baseline gap-2 max-w-[62%]',
              'px-3 py-1.5 rounded-[13px] text-sm leading-snug',
              // Flat dark scrim, NO backdrop-filter: the ticker shows up to
              // `maxVisible` bubbles at once over PLAYING video — a blur
              // layer per bubble is the per-frame re-composite cost
              // index.css flags (deep-debug Bug 25). A solid-ish fill reads
              // identically at this size and costs nothing to composite, and
              // doubles as the contrast scrim that keeps text ≥AA over bright
              // video (no backdrop needed).
              'bg-[rgba(6,5,12,0.72)] border',
              item.mine
                ? 'border-purple-400/30'
                : 'border-[rgba(220,200,255,0.16)]',
              // Dim is a brief pre-exit cue; keep it shallow (80%) so the
              // near-white text stays legible over bright video while fading.
              'transition-opacity duration-700 ease-out',
              item.lit ? 'opacity-100' : 'opacity-80',
            ].join(' ')}
            style={{ textShadow: '0 1px 8px rgba(0,0,0,0.85)' }}
          >
            <span
              className={[
                'text-xs font-semibold shrink-0',
                item.mine ? 'text-purple-200' : 'text-purple-300',
              ].join(' ')}
            >
              {item.username}
            </span>
            <span className="text-white/95 break-words">{item.message}</span>
          </div>
        ))}
      </div>
    </>
  )
}
