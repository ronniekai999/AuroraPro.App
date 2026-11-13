// The party's mini dock: the "minimal" face's one input surface, at the
// bottom centre over the picture. It holds the three things reached for
// without the full rail: a reaction, a one-line quick reply, and the
// microphone's mute.
//
// It reuses the ReactionPicker (opening UPWARD, since the dock sits at the
// bottom of the screen) and sends chat through the same onSendChat the rail
// composer uses: no chat or reaction logic of its own.
//
// It is an opaque raised card, not glass: it sits on moving video, and
// text on a see-through fill over a bright frame fails contrast. The dock
// is interactive, so it takes pointer events (the ticker and reactions
// above it let presses through to the player). It is the person's own
// input surface, so, like the rail composer, it is NOT screenshot-excluded.

import { useState } from 'react'
import type { VoiceState } from '@/lib/voice'
import { ReactionPicker } from './ReactionOverlay'

interface Props {
  onSendChat: (msg: string) => void
  onSendReaction?: (emoji: string) => void
  voice?: VoiceState
  onToggleVoiceMute?: () => void
}

export function MiniDock({ onSendChat, onSendReaction, voice, onToggleVoiceMute }: Props) {
  const [draft, setDraft] = useState('')

  const send = () => {
    const msg = draft.trim()
    if (!msg) return
    onSendChat(msg)
    setDraft('')
  }

  const live = !!voice?.enabled && !voice.muted
  // Mic is actionable only when voice is wired AND the user is already
  // in voice (toggleMute no-ops otherwise — joining belongs to the
  // VoicePill). Hide it entirely if voice isn't wired at all.
  const showMic = !!voice && !!onToggleVoiceMute
  const micActionable = showMic && !!voice?.enabled

  return (
    <div
      // .stage-party-minidock: index.css lifts the dock above the player's
      // control band while the player is in the window. Its width is fixed:
      // the field gives Send its room when Send appears, and the dock does
      // not grow.
      className="stage-party-minidock fixed left-1/2 -translate-x-1/2 bottom-[calc(1rem+var(--tabbar-space,0px))] z-[67]
                 flex w-[min(360px,calc(100vw-2rem))] items-center gap-2 p-2 rounded-control
                 bg-surface-raised-2 shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
    >
      {/* Emoji: the shared picker, opening upward so the popover does not
          run off the bottom of the screen. */}
      {onSendReaction && (
        <ReactionPicker onSend={onSendReaction} placement="left" vertical="up" variant="dock" />
      )}

      {/* Quick reply. Enter sends. Its look is index.css's
          `input.stage-minidock-field` (the global field rule outranks
          utilities on an input). */}
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            send()
          }
        }}
        placeholder="Reply to the party"
        maxLength={500}
        aria-label="Send a quick chat message"
        className="stage-minidock-field min-w-0 flex-1"
      />

      {/* Send: appears only when there is text, so a resting dock is one
          stop shorter for the keys. */}
      {draft.trim() && (
        <button
          type="button"
          onClick={send}
          aria-label="Send message"
          className="stage-hit44 flex-none grid place-items-center w-10 h-10 rounded-control bg-action-soft text-ink
                     hover:bg-[var(--action-soft-hover)] transition-colors"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h13M13 6l6 6-6 6" />
          </svg>
        </button>
      )}

      {/* Mic mute toggle. Compact mirror of the rail's mute button: the
          glyph says muted or live, and live is also drawn in the colour
          for "on". */}
      {showMic && (
        <button
          type="button"
          onClick={onToggleVoiceMute}
          disabled={!micActionable}
          className={[
            'stage-hit44 flex-none grid place-items-center w-10 h-10 rounded-control transition-colors',
            // Hover lifts the fill a step; the live colour stays.
            live ? 'bg-action-soft text-ok' : 'text-ink-2',
            !micActionable ? 'opacity-40 cursor-not-allowed' : live ? 'hover:bg-[var(--action-soft-hover)]' : 'hover:bg-action-soft hover:text-ink',
          ].join(' ')}
          title={
            !micActionable
              ? 'Join voice from the voice pill first'
              : voice?.muted
                ? 'Unmute'
                : 'Mute'
          }
          aria-label={voice?.muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={!!voice?.enabled && !voice.muted}
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-[18px] h-[18px]"
            aria-hidden="true"
          >
            {(voice?.muted ?? true) ? (
              <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23A6.93 6.93 0 0 0 19 11zm-4.02.17L12 8.18V5a3 3 0 0 1 3 3v3a3 3 0 0 1-.02.17zM4.27 3L3 4.27l6.01 6.01V11a3 3 0 0 0 3 3v.01l1.91 1.91c-.66.38-1.4.59-2.15.59A5 5 0 0 1 7 11H5c0 4.41 3.59 8 8 8 .82 0 1.61-.14 2.34-.37l4.39 4.39L21 21.73 4.27 3z" />
            ) : (
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 10a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 0 0 2 0v-2.07A7 7 0 0 0 19 12z" />
            )}
          </svg>
        </button>
      )}
    </div>
  )
}
