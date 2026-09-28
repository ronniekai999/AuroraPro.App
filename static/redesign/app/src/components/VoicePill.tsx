// Aurora V2 — VoicePill
//
// Condensed voice HUD for the cinematic ("minimal") overlay mode. It's
// the corner-pill version of PartyPanel's voice strip: the existing
// VoiceState, distilled to a mic toggle + talking-avatars (self + peers)
// + a short status label. No new voice logic — it reads the exact same
// VoiceState and calls the same join/leave/mute handlers the rail uses.
//
// Cinematic overlay contract: `.voice-pill`.
//   - emerald-tinted glass pill, emerald glow when voice is live
//   - circular mic button (toggles mute when in voice; joins otherwise)
//   - overlapping avatar stack; a talking peer gets an emerald ring
//   - "N talking" / "N in voice" / "Join voice" label
//
// Props deliberately MIRROR PartyPanel's voice props so a parent can
// pass the same handlers to either surface. `selfLabel` is the only
// addition — VoiceState doesn't carry the local user's name (peers do),
// so the caller supplies the initial for the self avatar.

import type { VoiceState } from '@/lib/voice'

interface Props {
  voice?: VoiceState
  onJoinVoice?: () => void
  onLeaveVoice?: () => void
  onToggleVoiceMute?: () => void
  // Label used for the self avatar's initial + a11y ("You" by default).
  selfLabel?: string
}

function initial(name: string): string {
  const c = name.trim().charAt(0)
  return c ? c.toUpperCase() : '?'
}

export function VoicePill({
  voice,
  onJoinVoice,
  onLeaveVoice,
  onToggleVoiceMute,
  selfLabel = 'You',
}: Props) {
  // Render nothing unless the parent wired voice up — same guard shape
  // PartyPanel uses before showing its voice strip.
  if (!voice || !onJoinVoice || !onToggleVoiceMute || !onLeaveVoice) return null

  const live = voice.enabled && !voice.muted

  // ── Not in voice yet: a single compact "Join voice" pill. ──
  if (!voice.enabled) {
    return (
      <div
        data-screenshot-exclude="true"
        className="fixed top-4 right-4 z-[67]"
      >
        <button
          type="button"
          onClick={onJoinVoice}
          className="aurora-glass-overlay inline-flex items-center gap-2 pl-2.5 pr-3.5 py-2 rounded-full
                     bg-[rgba(8,6,14,0.5)] backdrop-blur-md border border-[rgba(220,200,255,0.18)]
                     text-white/80 hover:text-white hover:border-[rgba(220,200,255,0.32)]
                     transition-colors"
          title="Join voice chat"
        >
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-white/[0.08]">
            <MicIcon muted={false} className="w-3.5 h-3.5 text-white/70" />
          </span>
          <span className="text-xs font-medium">Join voice</span>
        </button>
      </div>
    )
  }

  // Self avatar + speaking peers' avatars, capped so the stack stays a
  // pill (mesh is ~4 anyway). Self first, then peers in arrival order.
  const avatars = [
    { key: 'self', label: selfLabel, speaking: voice.selfSpeaking, self: true },
    ...voice.peers.map(p => ({
      key: `peer-${p.userId}`,
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
      className={[
        'aurora-glass-overlay fixed top-4 right-4 z-[67] inline-flex items-center gap-2 pl-2.5 pr-3 py-2 rounded-full',
        'bg-[rgba(8,6,14,0.5)] backdrop-blur-md border transition-shadow',
        live
          ? 'border-emerald-400/40 shadow-[0_0_16px_rgba(52,211,153,0.25)]'
          : 'border-[rgba(220,200,255,0.18)]',
      ].join(' ')}
    >
      {/* Mic toggle — mute/unmute while in voice. */}
      <button
        type="button"
        onClick={onToggleVoiceMute}
        className={[
          'flex items-center justify-center w-7 h-7 rounded-full transition-colors',
          live
            ? 'bg-emerald-500/25 hover:bg-emerald-500/35'
            : 'bg-white/[0.08] hover:bg-white/[0.14]',
        ].join(' ')}
        title={voice.muted ? 'Unmute' : 'Mute'}
        aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
        aria-pressed={!voice.muted}
      >
        <MicIcon
          muted={voice.muted}
          className={`w-4 h-4 ${live ? 'text-emerald-300' : 'text-white/70'}`}
        />
      </button>

      {/* Talking-avatar stack. */}
      <div className="flex items-center">
        {avatars.map((a, i) => (
          <span
            key={a.key}
            className={[
              'flex items-center justify-center w-[22px] h-[22px] rounded-full',
              'text-[0.6rem] font-semibold text-white',
              'bg-gradient-to-br from-[#7e22ce] to-[#A855F7]',
              // Dark ring separates overlapping avatars (matches mockup's
              // 2px border in the near-black bg).
              'ring-2 ring-[#0a0a0f]',
              // Emerald speaking ring sits on top via box-shadow so it
              // doesn't fight the dark separator ring.
              a.speaking ? 'shadow-[0_0_0_2px_rgba(52,211,153,0.7)]' : '',
              i === 0 ? '' : '-ml-2',
            ].join(' ')}
            style={{ zIndex: avatars.length - i }}
            title={a.self ? `${a.label} (you)${a.speaking ? ' — talking' : ''}` : `${a.label}${a.speaking ? ' — talking' : ''}`}
          >
            {initial(a.label)}
          </span>
        ))}
      </div>

      <span className="text-[0.68rem] text-white/70 whitespace-nowrap">{label}</span>

      {/* Leave voice — small × so the pill stays compact. */}
      <button
        type="button"
        onClick={onLeaveVoice}
        className="ml-0.5 flex items-center justify-center w-5 h-5 rounded-full
                   text-white/45 hover:text-red-300 hover:bg-red-500/15 transition-colors"
        title="Leave voice"
        aria-label="Leave voice"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
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
