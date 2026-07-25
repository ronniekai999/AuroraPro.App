// Aurora V2 — ReactionOverlay
//
// Twitch-style floating-emoji animation. New reactions added to
// `state.recentReactions` rise from the bottom-right of the player
// and fade. Each instance is keyed by user+timestamp so React's
// reconciliation animates them in/out cleanly.
//
// We render at z-[65] — above the player (z-60) but below the party
// panel (z-70) so a user with both open can see the floating emoji
// without it overlapping the chat composer.
//
// CSS animation is in-component via inline keyframes injection so
// we don't have to round-trip a stylesheet edit for Phase 4.5.

import { useEffect, useRef, useState } from 'react'
import type { ReactionEvent } from '@/lib/party'

const ANIM_DURATION_MS = 3000
const SEEN_CAP = 200

interface ActiveReaction {
  key: string
  emoji: string
  username: string
  // Random horizontal jitter (0-100, percent of overlay width) so
  // simultaneous reactions don't stack on the same pixel.
  jitter: number
}

interface Props {
  events: ReactionEvent[]
}

// Audit H3 (Phase 4.5) — ID-based tracking. The old index-based
// approach broke once `events` hit the 100-cap in useParty: the
// array length plateaued at 100, lastSeenIndex stuck at 100, and
// no new event ever appeared "new" again, so animations silently
// stopped. ID-based tracking sidesteps the cap entirely — each
// reaction is identified by (user_id, created_at, emoji), and we
// only animate ones we haven't seen before.
function eventId(e: ReactionEvent): string {
  return `${e.user_id}|${e.created_at}|${e.emoji}`
}

export function ReactionOverlay({ events }: Props) {
  const [active, setActive] = useState<ActiveReaction[]>([])
  const seenIdsRef = useRef<Set<string>>(new Set())
  const prevEventsRef = useRef<ReactionEvent[]>([])

  useEffect(() => {
    // Audit M5 (Phase 4.5 final-6) — when events transitions from
    // empty to non-empty, clear the seen set. This is the
    // "party transition" boundary — useParty's leave() resets
    // recentReactions to [], then a new party-state populates with
    // history. Without the clear, IDs from the previous party
    // linger in seenIdsRef and could (rarely) dedup a real
    // collision in the new party.
    if (prevEventsRef.current.length === 0 && events.length > 0) {
      seenIdsRef.current = new Set()
    }
    prevEventsRef.current = events
    const seen = seenIdsRef.current
    const fresh: ActiveReaction[] = []
    for (const e of events) {
      const id = eventId(e)
      if (seen.has(id)) continue
      seen.add(id)
      fresh.push({
        key: `${id}-${Math.random().toString(36).slice(2, 8)}`,
        emoji: e.emoji,
        username: e.username,
        jitter: Math.random() * 60 + 20,
      })
    }
    if (fresh.length === 0) return
    // Cap the seen set to bound memory across long sessions.
    if (seen.size > SEEN_CAP) {
      const keep = Array.from(seen).slice(-SEEN_CAP)
      seenIdsRef.current = new Set(keep)
    }
    setActive(prev => [...prev, ...fresh])
    fresh.forEach(r => {
      setTimeout(() => {
        setActive(prev => prev.filter(a => a.key !== r.key))
      }, ANIM_DURATION_MS)
    })
  }, [events])

  if (active.length === 0) return null

  return (
    <>
      <style>{`
        @keyframes aurora-reaction-rise {
          0%   { transform: translateY(0)     scale(0.4); opacity: 0; }
          15%  { transform: translateY(-40px) scale(1);   opacity: 1; }
          80%  { transform: translateY(-260px) scale(1.05); opacity: 0.85; }
          100% { transform: translateY(-320px) scale(0.7); opacity: 0; }
        }
      `}</style>
      <div
        aria-hidden="true"
        // .stage-party-reactions confines the float area to the theater box
        // while the theater is up, so reactions don't drift across the dimmed
        // app either side of the picture.
        className="stage-party-reactions fixed pointer-events-none z-[65] inset-0 overflow-hidden"
        // 2026-05-27 (holistic deep-debug H1) — exclude from
        // BugReport screenshot capture. Floating emoji reactions
        // from other party members are transient meta-UI and would
        // leak others' reaction trails into a public GitHub issue.
        data-screenshot-exclude="true"
      >
        {active.map(r => (
          <div
            key={r.key}
            className="absolute bottom-10 text-5xl select-none"
            style={{
              right: `${r.jitter}%`,
              animation: `aurora-reaction-rise ${ANIM_DURATION_MS}ms ease-out forwards`,
              textShadow: '0 2px 24px rgba(0,0,0,0.6)',
            }}
          >
            {r.emoji}
            <div className="text-[10px] text-white/70 text-center font-medium -mt-1">
              {r.username}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// Quick-pick emoji bar shown at the bottom of the player when in a
// party. Sends through party.sendReaction; the server broadcasts
// back to all participants including the sender so the overlay
// fires uniformly for everyone.
interface PickerProps {
  onSend: (emoji: string) => void
  // 2026-05-25 deep-debug (M3) — controls which edge of the trigger
  // button the popover anchors to. The 9-emoji × ~56px-each popover
  // is ~512px wide; the player-header use case (right-aligned in a
  // wide toolbar) needs `right-0` so the popover grows leftward and
  // doesn't escape the viewport. The PartyPanel use case (leftmost
  // in a ~384px panel) needs `left-0` so the popover grows
  // rightward into the empty chat-input space rather than off the
  // panel's left edge / under the sidebar. Default 'right' preserves
  // VideoPlayer's existing visual.
  placement?: 'left' | 'right'
  // 2026-05-28 — vertical open direction. 'up' (default) opens the
  // popover above the trigger via `bottom-full` — correct for the
  // PartyPanel use case where the trigger sits at the bottom of the
  // chat panel. 'down' opens below via `top-full` — needed for the
  // VideoPlayer TOP-BAR trigger: the windowed player is now a
  // centered card with `overflow-hidden`, so an upward popover from
  // a top-edge button gets clipped. Opening downward into the card
  // body (like the adjacent Audio/CC menus) avoids the clip.
  vertical?: 'up' | 'down'
}

const QUICK_EMOJI = ['😂', '😱', '🔥', '❤️', '👏', '🤯', '😭', '💀', '🎉']

export function ReactionPicker({ onSend, placement = 'right', vertical = 'up' }: PickerProps) {
  const [open, setOpen] = useState(false)
  const popoverAnchor = placement === 'left' ? 'left-0' : 'right-0'
  const popoverV = vertical === 'down' ? 'top-full mt-1' : 'bottom-full mb-1'
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="px-3 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg text-sm transition-colors"
        title="Send a reaction"
      >
        😂
      </button>
      {open && (
        <div className={`absolute ${popoverV} ${popoverAnchor} bg-[#1a1a22] border border-white/[0.08] rounded-lg shadow-xl px-2 py-2 flex flex-wrap justify-center gap-1 max-w-[min(90vw,288px)] z-20`}>
          {QUICK_EMOJI.map(e => (
            <button
              key={e}
              onClick={() => { onSend(e); setOpen(false) }}
              className="text-2xl px-2 py-1 hover:bg-white/[0.08] rounded transition-colors"
              aria-label={`React with ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
