// The voice HUD of the party's minimal face: the rail's voice card distilled
// to a corner pill. A mic toggle, the people in voice as overlapping discs
// (whoever is speaking carries the aurora ring) and a short label. No voice
// logic of its own: it reads the same VoiceState and calls the same
// join/leave/mute handlers the rail uses, so a parent can pass either surface
// the same props. `selfLabel` is the one addition, because VoiceState does
// not carry the local person's name.
//
// `.stage-voice-pill` (index.css) moves it below the player's top bar while
// the player is in the window; the top-right corner is the bar's.

import type { VoiceState } from '@/lib/voice'
import { PersonDisc } from './PersonDisc'

interface Props {
  voice?: VoiceState
  onJoinVoice?: () => void
  onLeaveVoice?: () => void
  onToggleVoiceMute?: () => void
  // Label used for the self avatar's initial + a11y ("You" by default).
  selfLabel?: string
  // The local person's id: what picks their colour, so they are the same
  // colour here as in the rail's roster and in the chat.
  selfUserId?: number
}

export function VoicePill({
  voice,
  onJoinVoice,
  onLeaveVoice,
  onToggleVoiceMute,
  selfLabel = 'You',
  selfUserId,
}: Props) {
  // Render nothing unless the parent wired voice up — same guard shape
  // PartyPanel uses before showing its voice strip.
  if (!voice || !onJoinVoice || !onToggleVoiceMute || !onLeaveVoice) return null

  const live = voice.enabled && !voice.muted

  // Not in voice yet: one compact "Join voice" pill.
  if (!voice.enabled) {
    return (
      <div
        data-screenshot-exclude="true"
        className="stage-voice-pill fixed top-4 right-4 z-[67]"
      >
        <button
          type="button"
          onClick={onJoinVoice}
          className="inline-flex items-center gap-2 h-10 pl-3 pr-4 rounded-control
                     bg-surface-raised-2 text-ink text-[13px] font-semibold hover:brightness-110 transition-[filter]"
          title="Join voice chat"
        >
          <MicIcon muted={false} className="w-4 h-4" />
          Join voice
        </button>
      </div>
    )
  }

  // Self first, then peers in arrival order, capped so the stack stays a
  // pill (a voice mesh is about four people anyway).
  const avatars = [
    { key: 'self', id: (selfUserId ?? selfLabel) as number | string, label: selfLabel, speaking: voice.selfSpeaking, self: true },
    ...voice.peers.map(p => ({
      key: `peer-${p.userId}`,
      id: p.userId as number | string,
      label: p.username,
      speaking: p.speaking,
      self: false,
    })),
  ].slice(0, 5)

  const talkingCount =
    (voice.selfSpeaking ? 1 : 0) + voice.peers.filter(p => p.speaking).length
  const inVoiceCount = 1 + voice.peers.length
  const label = talkingCount > 0 ? `${talkingCount} talking` : `${inVoiceCount} in voice`

  return (
    <div
      data-screenshot-exclude="true"
      className="stage-voice-pill fixed top-4 right-4 z-[67] inline-flex items-center gap-2 h-12 pl-1.5 pr-1.5 rounded-control bg-surface-raised-2"
    >
      {/* Mute or unmute while in voice. White when live: the one filled
          control on the pill is the one that says the mic is open. */}
      <button
        type="button"
        onClick={onToggleVoiceMute}
        className={[
          'flex items-center justify-center w-9 h-9 rounded-full transition-colors',
          live
            ? 'bg-action text-action-on hover:brightness-95'
            : 'bg-action-soft text-ink hover:bg-white/[0.16]',
        ].join(' ')}
        title={voice.muted ? 'Unmute' : 'Mute'}
        aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
        aria-pressed={!voice.muted}
      >
        <MicIcon muted={voice.muted} className="w-4 h-4" />
      </button>

      {/* Who is in voice. The group is named; the discs are decoration. */}
      <div
        className="flex items-center"
        role="img"
        aria-label={`In voice: ${avatars.map(a => `${a.self ? 'you' : a.label}${a.speaking ? ' (talking)' : ''}`).join(', ')}`}
      >
        {avatars.map((a, i) => (
          <span
            key={a.key}
            className={i === 0 ? 'inline-flex' : 'inline-flex -ml-1.5'}
            style={{ zIndex: avatars.length - i }}
            title={a.self ? `${a.label} (you)${a.speaking ? ', talking' : ''}` : `${a.label}${a.speaking ? ', talking' : ''}`}
          >
            <PersonDisc
              name={a.label}
              colorKey={a.id}
              size={28}
              speaking={a.speaking}
              surface="var(--surface-raised-2)"
            />
          </span>
        ))}
      </div>

      <span className="text-[13px] text-ink whitespace-nowrap tabular-nums">{label}</span>

      <button
        type="button"
        onClick={onLeaveVoice}
        className="flex items-center justify-center w-9 h-9 rounded-full
                   text-ink-2 hover:text-danger-ink hover:bg-action-soft transition-colors"
        title="Leave voice"
        aria-label="Leave voice"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  )
}

// Shared mic glyph — the same two paths PartyPanel uses (live vs muted)
// so the icon language is consistent across the rail and the pill.
function MicIcon({ muted, className }: { muted: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      {muted ? (
        <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23A6.93 6.93 0 0 0 19 11zm-4.02.17L12 8.18V5a3 3 0 0 1 3 3v3a3 3 0 0 1-.02.17zM4.27 3L3 4.27l6.01 6.01V11a3 3 0 0 0 3 3v.01l1.91 1.91c-.66.38-1.4.59-2.15.59A5 5 0 0 1 7 11H5c0 4.41 3.59 8 8 8 .82 0 1.61-.14 2.34-.37l4.39 4.39L21 21.73 4.27 3z" />
      ) : (
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 10a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 0 0 2 0v-2.07A7 7 0 0 0 19 12z" />
      )}
    </svg>
  )
}
