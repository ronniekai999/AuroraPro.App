// Aurora V2 — CinematicChatTicker
//
// Lower-third, auto-fading chat ticker for the watch-party "minimal"
// (cinematic) overlay mode. It reads the SAME `state.chat` the docked
// PartyPanel renders, but instead of a scrollable log it shows only the
// last few messages floating over the bottom of the video, then fades
// each one out and dismisses it after a few seconds — so the resting
// state is "just the movie."
//
// Look: lower third, left-aligned, a near-opaque dark bubble per message
// with the author's name in their own colour. New messages slide in from the
// left (motion-safe only); a message dims a little before it leaves.
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
import { NAME_BUBBLE_DIM_OPACITY, NAME_BUBBLE_FILL_ALPHA, NAME_BUBBLE_FILL_RGB, personColor } from '@/lib/personColor'

interface Props {
  chat: ChatMessageEvent[]
  // Kept so the parent can pass either party face the same props.
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
  userId: number
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
        userId: m.user_id,
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
        // .stage-party-ticker (index.css) lifts it above the player's Skip
        // button and control band while the player is in the window.
        className="stage-party-ticker fixed left-4 right-4 bottom-12 z-[66] flex flex-col items-start gap-1.5 pointer-events-none"
      >
        {items.map(item => (
          <div
            key={item.id}
            className={[
              'aurora-ticker-msg inline-block max-w-[62%]',
              'px-3 py-1.5 rounded-control text-[14px] leading-snug break-words',
              // A flat dark fill, NO backdrop-filter: up to `maxVisible`
              // bubbles sit over PLAYING video, and a blur layer per bubble
              // is re-composited on every frame. The fill is also the scrim
              // that keeps the message AND the name, which is drawn in the
              // person's own colour, readable over a bright frame; its
              // strength and the depth of the pre-exit dim are the two
              // numbers in lib/personColor, set there against all nine
              // colours.
              'text-ink',
              'transition-opacity duration-700 ease-out',
            ].join(' ')}
            style={{
              background: `rgba(${NAME_BUBBLE_FILL_RGB.join(', ')}, ${NAME_BUBBLE_FILL_ALPHA})`,
              opacity: item.lit ? 1 : NAME_BUBBLE_DIM_OPACITY,
            }}
          >
            <span className="font-semibold" style={{ color: personColor(item.userId) }}>
              {item.username}
            </span>{' '}
            {item.message}
          </div>
        ))}
      </div>
    </>
  )
}
