// Aurora V2 — MiniDock
//
// The compact pill dock for the cinematic ("minimal") overlay mode.
// Bottom-center, it holds the three things you reach for without the
// full rail: an emoji reaction, a one-line quick reply, and a mic
// mute toggle. Keep this aligned with the cinematic overlay controls.
// `.mini-dock`.
//
// It reuses the existing ReactionPicker verbatim (opening UPWARD, since
// the dock sits at the bottom of the screen) and sends chat through the
// same onSendChat the rail composer uses — no new chat/reaction logic.
//
// The dock is interactive, so it opts INTO pointer events (the ticker /
// reactions above it are pointer-events:none so clicks fall through to
// the player; the dock must not). It's the user's own input surface, so
// — like the rail composer — it is NOT screenshot-excluded.

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
      className="aurora-glass-overlay fixed left-1/2 -translate-x-1/2 bottom-4 z-[67]
                 inline-flex items-center gap-2 pl-2.5 pr-2.5 py-1.5 rounded-full
                 bg-[rgba(8,6,14,0.5)] backdrop-blur-lg border border-[rgba(220,200,255,0.18)]
                 shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
    >
      {/* Emoji — reuse the shared 9-emoji picker. Opens upward so the
          popover doesn't render below the screen edge. */}
      {onSendReaction && (
        <ReactionPicker onSend={onSendReaction} placement="left" vertical="up" />
      )}

      {/* Quick reply. Enter sends; stays inline so the dock stays a pill. */}
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
        placeholder="Quick reply…"
        maxLength={500}
        aria-label="Send a quick chat message"
        className="w-44 sm:w-56 bg-transparent px-2 py-1 text-sm text-white
                   placeholder:text-white/40 focus:outline-none border-0"
      />

      {/* Send — appears only when there's text, keeping the resting
          dock minimal. */}
      {draft.trim() && (
        <button
          type="button"
          onClick={send}
          aria-label="Send message"
          className="flex items-center justify-center w-8 h-8 rounded-full
                     bg-gradient-to-br from-[#A855F7] to-[#7e22ce] text-white
                     hover:brightness-110 transition-[filter]"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.4.92V9.5a1 1 0 0 0 .82.98L13 12 2.82 13.52A1 1 0 0 0 2 14.5v4.98a1 1 0 0 0 1.4.92z" />
          </svg>
        </button>
      )}

      {/* Mic mute toggle. Compact mirror of the rail's mute button. */}
      {showMic && (
        <button
          type="button"
          onClick={onToggleVoiceMute}
          disabled={!micActionable}
          className={[
            'flex items-center justify-center w-8 h-8 rounded-full transition-colors',
            live
              ? 'bg-emerald-500/20 border border-emerald-400/45'
              : 'bg-white/[0.06] border border-transparent',
            micActionable ? 'hover:brightness-110' : 'opacity-40 cursor-not-allowed',
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
            className={`w-[15px] h-[15px] ${live ? 'text-emerald-300' : 'text-white/70'}`}
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
