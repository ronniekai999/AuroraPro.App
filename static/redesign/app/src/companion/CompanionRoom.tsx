// Aurora V2 — CompanionRoom
//
// The active "second screen" once joined. Matches
// the phone companion room:
//   - LIVE header (party name + code + connection dot)
//   - Read-only now-playing strip ("in sync with host" + position)
//   - Horizontal members row with speaking-glow + companion badge
//   - Chat bubbles (mine right/purple, theirs left; system lines centered)
//   - 9-emoji reaction quick bar + floating reactions (ReactionOverlay)
//   - Composer: emoji picker + text input + mic toggle (mute-by-default)
//
// Pure presentation over useCompanion state/actions — it owns NO socket.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessageEvent, PartyParticipant } from '@/lib/party'
import type { VoiceState } from '@/lib/voice'
import { ReactionOverlay } from '@/components/ReactionOverlay'
import type { CompanionState } from '@/hooks/useCompanion'
import { CompanionPoster } from './JoinScreen'
import { useReducedMotion } from './companionUi'

// Same 9 emojis as ReactionPicker / the mockup quick bar.
const QUICK_EMOJI = ['😂', '😱', '🔥', '❤️', '👏', '🤯', '😭', '💀', '🎉']
// A small palette for the composer's emoji button — a quick insert
// menu rather than a full picker (kept light for the phone).
const COMPOSER_EMOJI = ['😀', '😂', '😍', '😱', '🔥', '👀', '💀', '🎉', '👏', '❤️', '😭', '🤯']

export interface CompanionRoomProps {
  state: CompanionState
  voice: VoiceState
  currentUserId: number
  sendChat: (message: string) => void
  sendReaction: (emoji: string) => void
  joinVoice: () => Promise<void>
  toggleMute: () => void
  leaveVoice: () => void
  onLeave: () => void
}

export function CompanionRoom({
  state, voice, currentUserId,
  sendChat, sendReaction, joinVoice, toggleMute, leaveVoice, onLeave,
}: CompanionRoomProps) {
  const reduced = useReducedMotion()
  const [draft, setDraft] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [micBusy, setMicBusy] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll chat to the newest message when it grows, but only if
  // the user is already near the bottom (don't yank them up while
  // they're reading scrollback).
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [state.chat.length])

  // Map voice peers by user id for O(1) speaking lookup in the members
  // row. Self-speaking is tracked separately on voice.selfSpeaking.
  const speakingByUser = useMemo(() => {
    const m = new Map<number, boolean>()
    for (const p of voice.peers) m.set(p.userId, p.speaking)
    return m
  }, [voice.peers])

  const submit = () => {
    const t = draft.trim()
    if (!t) return
    sendChat(t)
    setDraft('')
    inputRef.current?.focus()
  }

  const onMicClick = async () => {
    setMicError(null)
    if (!voice.enabled) {
      setMicBusy(true)
      try {
        await joinVoice()
      } catch (err) {
        const reason = (err as { reason?: string })?.reason
        setMicError(
          reason === 'denied'
            ? 'Mic blocked. Allow microphone access in your browser settings.'
            : reason === 'device'
              ? 'Mic unavailable — check OS mic permissions or close apps using it.'
              : 'Could not start the mic. Tap to try again.',
        )
      } finally {
        setMicBusy(false)
      }
      return
    }
    // Already in voice → toggle mute on/off.
    toggleMute()
  }

  const live = state.connected && !state.reconnecting
  // joining = first connect in flight (no party-state yet). Treat it
  // like reconnecting for the dot/badge so the header never flashes a
  // misleading "OFFLINE" while we're actively connecting.
  const pending = state.reconnecting || (state.status === 'joining' && !state.connected)
  const connDotClass = pending
    ? 'bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.6)]'
    : state.connected
      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
      : 'bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.6)]'

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="flex items-center gap-2.5 border-b border-[rgba(220,200,255,0.08)] px-4 pb-3 pt-2">
        {live ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/[0.18] px-2 py-[3px] text-[11px] font-bold tracking-[0.1em] text-white">
            <span className={`h-1.5 w-1.5 rounded-full bg-red-400 shadow-[0_0_8px_#ef4444] ${reduced ? '' : 'animate-pulse'}`} />
            LIVE
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/[0.14] px-2 py-[3px] text-[11px] font-bold tracking-[0.1em] text-amber-200">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            {pending ? (state.status === 'joining' ? 'CONNECTING' : 'RECONNECTING') : 'OFFLINE'}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">
            {state.partyName || state.mediaTitle || 'Watch Party'}
          </p>
          {state.code && (
            <p className="font-display text-[11px] tracking-[0.08em] text-white/50">
              CODE · {state.code}
            </p>
          )}
        </div>
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${connDotClass}`} title={live ? 'Connected' : pending ? 'Connecting…' : 'Disconnected'} />
        <button
          type="button"
          onClick={onLeave}
          className="ml-1 flex-shrink-0 rounded-lg px-2 py-1.5 text-xs text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white"
          aria-label="Leave the party"
        >
          Leave
        </button>
      </header>

      {/* Transient server-error banner — surfaces 'error' frames that
          arrive while connected (e.g. chat rate-limited, invalid action)
          so they aren't silently swallowed. Fatal end-of-party errors are
          handled by CompanionApp's status switch, not here. */}
      {state.connected && state.error && (
        <div
          role="alert"
          className="mx-3.5 mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"
        >
          {state.error}
        </div>
      )}

      {/* ── Now-playing strip (READ-ONLY) ──────────────────────────── */}
      {(state.mediaTitle || state.mediaPoster) && (
        <div className="glass-panel mx-3.5 mt-3 flex items-center gap-3 rounded-2xl px-3 py-2.5">
          <CompanionPoster poster={state.mediaPoster} className="h-[50px] w-[34px] rounded-md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-white">{state.mediaTitle || 'Now playing'}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[color:var(--stage-purple-lt)]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {state.isPlaying ? 'In sync with host' : 'Paused by host'}
            </p>
          </div>
          <span className="font-display text-[13px] tabular-nums text-white/55">{formatClock(state.currentTimeMs)}</span>
        </div>
      )}

      {/* ── Members row ─────────────────────────────────────────────── */}
      {state.participants.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-3.5 pb-2.5 pt-3 scrollbar-hide" aria-label="Participants">
          {state.participants.map(p => (
            <MemberChip
              key={p.user_id}
              participant={p}
              isSelf={p.user_id === currentUserId}
              speaking={p.user_id === currentUserId ? voice.selfSpeaking : !!speakingByUser.get(p.user_id)}
            />
          ))}
        </div>
      )}

      {/* ── Chat ────────────────────────────────────────────────────── */}
      <div
        ref={chatScrollRef}
        className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-3.5 py-1.5"
        // Keep transient chat out of bug-report screenshots, matching
        // the ReactionOverlay precedent.
        data-screenshot-exclude="true"
      >
        {state.chat.length === 0 && (
          <p className="py-6 text-center text-xs text-white/50">
            Say hi 👋 — messages you send appear here and on everyone's screen.
          </p>
        )}
        {state.chat.map(m => (
          <ChatBubble key={chatKey(m)} msg={m} mine={m.user_id === currentUserId} />
        ))}
      </div>

      {/* ── Reaction quick bar ─────────────────────────────────────── */}
      <div className="flex gap-1 overflow-x-auto px-3 pb-1.5 pt-2 scrollbar-hide" aria-label="Quick reactions">
        {QUICK_EMOJI.map(e => (
          <button
            key={e}
            type="button"
            onClick={() => sendReaction(e)}
            className="h-9 w-9 flex-shrink-0 rounded-xl bg-white/[0.04] text-lg transition-colors hover:bg-purple-500/[0.18] active:bg-purple-500/30"
            aria-label={`React with ${e}`}
          >
            {e}
          </button>
        ))}
      </div>

      {/* ── Composer ───────────────────────────────────────────────── */}
      {micError && (
        <p className="px-4 pb-1 text-[11px] text-amber-300">{micError}</p>
      )}
      <div className="relative flex items-center gap-2 border-t border-[rgba(220,200,255,0.08)] px-3 pb-[calc(env(safe-area-inset-bottom)+0.875rem)] pt-2">
        {/* Emoji insert popover */}
        {emojiOpen && (
          <div
            className="absolute bottom-full left-3 mb-2 grid grid-cols-6 gap-1 rounded-2xl border border-white/[0.08] bg-[#15131c] p-2 shadow-xl"
            role="menu"
          >
            {COMPOSER_EMOJI.map(e => (
              <button
                key={e}
                type="button"
                onClick={() => { setDraft(d => d + e); setEmojiOpen(false); inputRef.current?.focus() }}
                className="rounded-lg px-2 py-1 text-xl transition-colors hover:bg-white/[0.08]"
                aria-label={`Insert ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setEmojiOpen(o => !o)}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-lg transition-colors hover:bg-white/[0.08]"
          aria-label="Insert emoji"
          aria-expanded={emojiOpen}
        >
          😀
        </button>
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
          placeholder="Message the party…"
          maxLength={1000}
          enterKeyHint="send"
          aria-label="Message the party"
          className="min-w-0 flex-1 rounded-xl border border-[rgba(220,200,255,0.10)] bg-white/[0.05] px-3.5 py-2.5 text-sm text-white placeholder:text-white/50 focus:border-purple-500/40 focus:outline-none"
        />
        {draft.trim() ? (
          <button
            type="button"
            onClick={submit}
            className="flex h-[2.875rem] w-[2.875rem] flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-purple-500 to-purple-800 text-white shadow-[0_0_18px_rgba(168,85,247,0.4)]"
            aria-label="Send message"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5"><path d="M3.4 20.4 21 12 3.4 3.6 3 10l12 2-12 2z" /></svg>
          </button>
        ) : (
          <MicButton
            voice={voice}
            busy={micBusy}
            reduced={reduced}
            onClick={() => void onMicClick()}
            onLongOff={leaveVoice}
          />
        )}
      </div>

      {/* Floating reactions — reuse the shared overlay. It's fixed
          inset-0; inside the companion's full-viewport tree it rises
          from the bottom like the mockup, and honors prefers-reduced-
          motion via its own animation. */}
      <ReactionOverlay events={state.recentReactions} />
    </div>
  )
}

// ── Mic toggle button. Mute-by-default: first tap opts into voice
// (mic still MUTED until a second tap unmutes). Emerald "live" ring
// pulses while unmuted + speaking-capable.
function MicButton({
  voice, busy, reduced, onClick, onLongOff,
}: {
  voice: VoiceState
  busy: boolean
  reduced: boolean
  onClick: () => void
  onLongOff: () => void
}) {
  // In voice + unmuted = "live" (emerald, pulsing). In voice + muted =
  // amber-ish idle. Not in voice = neutral.
  const inVoice = voice.enabled
  const liveMic = inVoice && !voice.muted
  const base = 'relative flex h-[2.875rem] w-[2.875rem] flex-shrink-0 items-center justify-center rounded-2xl border transition-colors'
  const tone = liveMic
    ? 'border-emerald-400/50 bg-emerald-500/[0.16] text-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.10)]'
    : inVoice
      ? 'border-white/15 bg-white/[0.06] text-white/70'
      : 'border-white/10 bg-white/[0.05] text-white/60'

  return (
    <button
      type="button"
      onClick={onClick}
      // Long-press to fully leave voice (release the mic + mesh). A11y:
      // also reachable via the leave-party path; this is a power move.
      onContextMenu={e => { if (inVoice) { e.preventDefault(); onLongOff() } }}
      disabled={busy}
      className={`${base} ${tone} disabled:opacity-60`}
      aria-pressed={liveMic}
      aria-label={
        busy ? 'Starting microphone' :
        !inVoice ? 'Turn on microphone (joins muted)' :
        liveMic ? 'Mute microphone' : 'Unmute microphone'
      }
      title={!inVoice ? 'Tap to join voice (starts muted)' : liveMic ? 'Live — tap to mute' : 'Muted — tap to talk'}
    >
      {liveMic && !reduced && (
        <span className="pointer-events-none absolute -inset-[5px] rounded-[18px] border-[1.5px] border-emerald-400/50 motion-safe:[animation:companion-mic-ring_1.6s_ease-out_infinite]" />
      )}
      {busy ? (
        <svg viewBox="0 0 24 24" fill="none" className={`h-5 w-5 ${reduced ? '' : 'animate-spin'}`} aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      ) : inVoice && voice.muted ? (
        // Muted glyph — mic with a slash.
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
          <path d="M19 11a1 1 0 0 0-2 0c0 .57-.1 1.12-.27 1.62l1.5 1.5A7 7 0 0 0 19 11zM15 5a3 3 0 0 0-6 0v.18l6 6V5zM3.3 2.3 2 3.6l6.99 7v.4a3 3 0 0 0 4.31 2.7l1.45 1.45A5 5 0 0 1 7 11a1 1 0 0 0-2 0 7 7 0 0 0 6 6.9V21a1 1 0 0 0 2 0v-3.1c.74-.1 1.43-.33 2.06-.66l3.34 3.35 1.3-1.3z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 10a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.9V21a1 1 0 0 0 2 0v-2.1A7 7 0 0 0 19 12z" />
        </svg>
      )}
      {/* Component-scoped keyframes for the live ring (no global CSS edit). */}
      <style>{`@keyframes companion-mic-ring{0%{transform:scale(.9);opacity:.8}100%{transform:scale(1.25);opacity:0}}`}</style>
    </button>
  )
}

function MemberChip({ participant, isSelf, speaking }: {
  participant: PartyParticipant
  isSelf: boolean
  speaking: boolean
}) {
  return (
    <span
      className={[
        'inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[5px] text-[11px] whitespace-nowrap',
        speaking
          ? 'border-emerald-400/50 bg-emerald-500/[0.14] text-white shadow-[0_0_12px_rgba(52,211,153,0.35)]'
          : 'border-[rgba(220,200,255,0.10)] bg-white/[0.04] text-white/80',
      ].join(' ')}
    >
      <span className={`h-[7px] w-[7px] rounded-full ${speaking ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-white/35'}`} />
      {isSelf ? 'You' : participant.username}
      {participant.is_host && <span className="text-[color:var(--stage-purple-lt)]" title="Host" aria-label="Host">★</span>}
      {participant.companion && <span title="On phone" aria-label="On phone">📱</span>}
      {speaking && (
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-2.5 w-2.5 text-emerald-400" aria-hidden="true">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 10a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.9V21a1 1 0 0 0 2 0v-2.1A7 7 0 0 0 19 12z" />
        </svg>
      )}
    </span>
  )
}

function ChatBubble({ msg, mine }: { msg: ChatMessageEvent; mine: boolean }) {
  return (
    <div className={`flex max-w-[82%] flex-col ${mine ? 'self-end items-end' : 'items-start'}`}>
      <span className={`mb-0.5 text-[10px] ${mine ? 'text-[color:var(--stage-purple-lt)]' : 'text-white/50'}`}>
        {mine ? 'You' : msg.username}
      </span>
      <div
        className={[
          'px-3 py-2 text-sm leading-snug break-words',
          mine
            ? 'rounded-2xl rounded-br-[5px] border border-purple-500/25 bg-purple-500/[0.28] text-white'
            : 'rounded-2xl rounded-bl-[5px] bg-white/[0.05] text-white/90',
        ].join(' ')}
      >
        {msg.message}
      </div>
    </div>
  )
}

// Stable-ish key for a chat row. Server messages carry an id; fall back
// to a composite if a malformed row lacks one.
function chatKey(m: ChatMessageEvent): string {
  return m.id || `${m.user_id}|${m.timestamp}|${m.message.slice(0, 16)}`
}

// Format ms → H:MM:SS / M:SS for the read-only position indicator.
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
