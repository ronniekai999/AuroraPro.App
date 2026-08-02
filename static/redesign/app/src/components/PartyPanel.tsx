// Aurora V2 — PartyPanel
//
// The watch-party UX surface: members list, chat, leave button.
//
// Layout: fixed right-edge panel, 320px wide, slides in when open.
// On small screens (<640px) the panel goes full-width as an overlay.
//
// What's NOT here yet (Phase 4.5+):
//   - Voice mesh controls (mute/talk)
//   - Reactions overlay (floating-emoji animation across video)
//   - Ready-state UI ("I'm Ready" button + spoiler-free gate)
//   - Hand-off / promote-to-host
//
// 2026-05-25 — added reaction picker next to the chat send button.
// The picker also lives in the player header (VideoPlayer.tsx), but
// users naturally look for emoji reactions next to the chat UI — the
// "panel looks great but where are reactions?" feedback. Both
// locations send through the same party.sendReaction action.
//
// The panel reads from `useParty().state` and dispatches via the
// action methods (sendChat, leave). It does not own party state.
//
// 2026-05-30 — Cinematic Overlay. The panel is now a translucent
// floating GLASS overlay that floats OVER the video instead of an
// opaque slab bolted to the right edge, and it has two faces:
//   - variant="rail"    (default) — the full feature set below
//                         (members, voice strip, chat, ready, composer,
//                         end-party, highlight reel, reconnecting badge),
//                         restyled to read as floating glass.
//   - variant="minimal" — the "just the movie" face: a lower-third chat
//                         ticker, a corner voice pill, and a bottom mini
//                         dock (CinematicChatTicker / VoicePill /
//                         MiniDock), composed here so the parent keeps
//                         ONE mount point and the header toggle just
//                         flips `variant`.
// `variant` defaults to "rail" so existing callers are unchanged.

import { useEffect, useRef, useState } from 'react'
import type { PartyState } from '@/hooks/useParty'
import type { VoiceState } from '@/lib/voice'
import { ReactionPicker } from './ReactionOverlay'
import { CinematicChatTicker } from './CinematicChatTicker'
import { VoicePill } from './VoicePill'
import { MiniDock } from './MiniDock'

interface PartyPanelProps {
  state: PartyState
  currentUserId?: number
  onSendChat: (msg: string) => void
  onLeave: () => void
  onClose: () => void
  // 2026-05-25 — reaction picker handler. Optional so the panel still
  // renders if the host hasn't wired up reactions (which would be a
  // bug, but the panel shouldn't crash on a missing handler).
  onSendReaction?: (emoji: string) => void
  // Phase 4.6 — voice mesh.
  voice?: VoiceState
  onJoinVoice?: () => void
  onLeaveVoice?: () => void
  onToggleVoiceMute?: () => void
  // Phase 4.6 — ready dots / spoiler-free start gate.
  onSendReady?: (ready: boolean) => void
  // 2026-05-30 — Cinematic Overlay. Which face to render. Defaults to
  // "rail" so every existing caller keeps the current behavior with no
  // change. "minimal" renders the ticker + voice pill + mini dock.
  variant?: 'rail' | 'minimal'
  // Fired by the header dock button (rail) and by a restore affordance
  // (minimal) to flip between the two faces. Optional: when absent, the
  // toggle button is hidden and the panel is locked to `variant`.
  onToggleVariant?: () => void
  // 2026-05-30 — host "invite to party" affordance. When provided (the
  // parent passes it only for the HOST), the rail header shows an invite
  // button that opens the parent's PartyInvite card (join code + QR deep
  // link for phones). Optional: guests don't get it, so the button is
  // hidden. Rail-only (minimal mode has no header).
  onInvite?: () => void
}

export function PartyPanel({
  state, currentUserId, onSendChat, onLeave, onClose,
  onSendReaction,
  voice, onJoinVoice, onLeaveVoice, onToggleVoiceMute,
  onSendReady,
  variant = 'rail',
  onToggleVariant,
  onInvite,
}: PartyPanelProps) {
  const [draft, setDraft] = useState('')
  const chatRef = useRef<HTMLDivElement | null>(null)
  // 2026-05-25 — host-aware leave confirmation. The host clicking
  // "Leave" actually ENDS the party server-side (manager.go:1489-1493
  // — explicit leave-party from the host triggers endPartyInternal
  // immediately, kicking all guests). Until this guard, the button
  // was labeled "Leave Party" for everyone with no warning, leading
  // to surprised hosts wondering why their movie night ended.
  //
  // Guests get the silent button (their leave is non-destructive —
  // party continues, others stay).
  const isHost = !!currentUserId && currentUserId === state.hostUserId
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)

  // Auto-scroll chat to bottom on new messages — only if the user
  // was already near the bottom, so a user scrolled up reading
  // backlog isn't yanked back down by an incoming message.
  useEffect(() => {
    const el = chatRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [state.chat])

  const handleSend = () => {
    if (!draft.trim()) return
    onSendChat(draft)
    setDraft('')
  }

  // ──────────────────────────────────────────────────────────────────
  // Minimal (cinematic) face. Renders the three lower-chrome surfaces
  // over the video and a single small "expand to rail" affordance.
  // Composed here so App keeps ONE mount point and the toggle just
  // flips `variant`. Each child is itself a floating fixed/absolute
  // overlay (positioned relative to the viewport like the rail), so we
  // render them as siblings inside a Fragment — no wrapping box that
  // would intercept clicks over the player.
  if (variant === 'minimal') {
    const selfLabel =
      state.participants.find(p => p.user_id === currentUserId)?.username || 'You'
    return (
      <>
        <CinematicChatTicker chat={state.chat} currentUserId={currentUserId} />
        <VoicePill
          voice={voice}
          onJoinVoice={onJoinVoice}
          onLeaveVoice={onLeaveVoice}
          onToggleVoiceMute={onToggleVoiceMute}
          selfLabel={selfLabel}
        />
        <MiniDock
          onSendChat={onSendChat}
          onSendReaction={onSendReaction}
          voice={voice}
          onToggleVoiceMute={onToggleVoiceMute}
        />
        {/* Restore-to-rail affordance. Only when the parent supports
            toggling; otherwise minimal is a locked presentation. Lives at
            the viewport's top-left, mirroring the VoicePill pinned at the
            viewport's top-right — in the inset theater that is the dimmed
            strip above the box, opposite the pill. `.stage-party-dock`
            (index.css) adjusts `top` ONLY, and only while the theater is
            up: same 16px while the box is inset, below the topbar when the
            theater goes full-bleed and the always-visible title would sit
            under the chip. It must never re-anchor the chip into the box's
            top-left — that corner belongs to the topbar's title block (the
            original bug). Moot in element-fullscreen: the chip is a sibling
            of the fullscreened player root, so it isn't rendered there —
            same as the pill. The glyph is a chat bubble: the old
            corners-out glyph read as "fullscreen" while the player's real
            fullscreen button was on screen. */}
        {onToggleVariant && (
          <button
            type="button"
            onClick={onToggleVariant}
            data-screenshot-exclude="true"
            className="stage-party-dock aurora-glass-overlay fixed top-4 left-4 z-[67] flex items-center gap-2 px-3 py-2 rounded-full
                       bg-[rgba(8,6,14,0.5)] backdrop-blur-md border border-[rgba(220,200,255,0.16)]
                       text-white/70 hover:text-white hover:border-[rgba(220,200,255,0.3)]
                       text-xs font-medium transition-colors"
            title="Open the party chat"
            aria-label="Open the party chat"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" />
            </svg>
            Party
            {state.code && state.reconnecting && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-400 motion-safe:animate-pulse"
                title="Reconnecting to the party"
              />
            )}
          </button>
        )}
      </>
    )
  }

  // ──────────────────────────────────────────────────────────────────
  // Rail (default) face — the full panel, restyled as floating glass.
  // 2026-05-30 — was a near-opaque slab bolted to the right edge
  // (`bg-[#0a0a0f]/95` + `border-l`, flush to top/right/bottom). Now a
  // translucent glass card lifted off the edges (inset margins +
  // rounded) so the movie glows through and around it. On phones it
  // still spans (nearly) full width but keeps the float inset + radius.
  return (
    // .stage-party-rail insets this by the theater's own offsets while the
    // theater is up — it used to straddle the boundary, ~265px over the picture
    // and ~75px over the dimmed app behind it.
    <aside className="stage-party-rail aurora-glass-overlay fixed top-3 right-3 bottom-3 w-[calc(100%-1.5rem)] sm:w-[340px] sm:top-4 sm:right-4 sm:bottom-4 bg-[rgba(12,10,20,0.4)] backdrop-blur-xl rounded-2xl border border-[var(--glow-border)] shadow-[var(--glow-halo),0_20px_60px_rgba(0,0,0,0.5)] z-[70] flex flex-col overflow-hidden motion-safe:animate-fade-in">
      {/* Header */}
      <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-white text-sm font-semibold truncate">
            {state.partyName || (state.mediaTitle ? `Watching ${state.mediaTitle}` : 'Watch Party')}
          </p>
          <p className="text-white/40 text-xs mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span>{state.code ? `Code: ${state.code}` : 'Joining…'}</span>
            {/* 2026-05-25 — connection status badge. Shows when the
                room socket is reconnecting after an unexpected close
                (e.g. proxy idle timeout, brief network blip). The
                server's 90s host-disconnect grace period gives us up
                to ~5 backoff attempts (1+2+4+8+16=31s) before guests
                get kicked, so most outages are invisible to the UI
                except for this badge briefly flickering. */}
            {state.code && state.reconnecting && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-300 text-[10px] font-medium border border-amber-500/30"
                title="Lost connection to the party — trying to reconnect"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 motion-safe:animate-pulse" />
                Reconnecting…
              </span>
            )}
            {state.code && (
              <button
                onClick={() => {
                  // Audit M2 (Phase 4.5 final-6) — clipboard API
                  // requires HTTPS or localhost; many Aurora deploys
                  // are HTTP intranet. Catch + fall back to a
                  // textarea selection trick so the user gets the
                  // code one way or another.
                  const code = state.code!
                  const fallback = () => {
                    try {
                      const ta = document.createElement('textarea')
                      ta.value = code
                      ta.style.position = 'fixed'
                      ta.style.top = '-1000px'
                      document.body.appendChild(ta)
                      ta.select()
                      document.execCommand('copy')
                      document.body.removeChild(ta)
                    } catch { /* ignore — user can read the code on screen */ }
                  }
                  if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(code).catch(fallback)
                  } else {
                    fallback()
                  }
                }}
                className="ml-2 text-purple-400 hover:text-purple-300"
                title="Copy code to clipboard"
              >
                copy
              </button>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* 2026-05-30 — host invite affordance. Opens the parent's
              PartyInvite card (join code + QR deep link for phones).
              Rendered only when the parent wires onInvite (host-only). */}
          {onInvite && (
            <button
              onClick={onInvite}
              className="w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/60 hover:text-white flex items-center justify-center transition-colors"
              title="Invite friends to this party"
              aria-label="Invite friends to this party"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M19 8v6M22 11h-6" />
              </svg>
            </button>
          )}
          {/* 2026-05-30 — dock → minimal toggle. Collapses the rail into
              the cinematic ticker/pill/dock face. Hidden when the parent
              doesn't support toggling (rail-only callers). The glyph is a
              window-chrome minus: the original corners-out glyph read as
              "fullscreen" (the player's real fullscreen button is on screen
              at the same time), so users avoided it. */}
          {onToggleVariant && (
            <button
              onClick={onToggleVariant}
              className="w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/60 hover:text-white flex items-center justify-center transition-colors"
              title="Minimize the party chat"
              aria-label="Minimize the party chat"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M5 11h14v2H5z" />
              </svg>
            </button>
          )}
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/70 hover:text-white text-lg flex items-center justify-center"
            aria-label="Close panel"
          >
            ×
          </button>
        </div>
      </div>

      {/* Error banner */}
      {state.error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
          {state.error}
        </div>
      )}

      {/* Members */}
      <div className="px-5 py-3 border-b border-white/[0.06]">
        <p className="text-white/40 text-[10px] uppercase tracking-wider mb-2">
          Watching ({state.participants.length})
        </p>
        <div className="flex flex-wrap gap-2">
          {state.participants.map(p => {
            // Phase 4.6 — speaking-glow chip if voice is on and this
            // participant is talking. self uses voice.selfSpeaking;
            // peers use the speaking flag from voice.peers (indexed
            // by user_id).
            const isSelf = currentUserId === p.user_id
            const peerVoice = voice?.peers.find(v => v.userId === p.user_id)
            const speaking = isSelf ? !!voice?.selfSpeaking : !!peerVoice?.speaking
            const onVoice = isSelf
              ? (voice?.enabled ?? false)
              : !!peerVoice
            return (
              <div
                key={p.user_id}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border transition-shadow ${
                  speaking
                    ? 'bg-emerald-500/15 border-emerald-400/50 shadow-[0_0_10px_rgba(52,211,153,0.4)]'
                    : 'bg-white/[0.04] border-white/[0.06]'
                }`}
                title={`${p.username}${p.is_host ? ' (host)' : ''}${p.is_buffering ? ' — buffering' : ''}${onVoice ? (speaking ? ' — talking' : ' — in voice') : ''}`}
              >
                <div className={`w-2 h-2 rounded-full ${
                  speaking
                    ? 'bg-emerald-300'
                    : p.is_buffering
                      ? 'bg-amber-400'
                      : (p.ready ? 'bg-emerald-400' : 'bg-white/30')
                }`} />
                <span className="text-white/80 text-xs">{p.username}</span>
                {onVoice && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className={speaking ? 'text-emerald-300' : 'text-white/40'}>
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 10a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 0 0 2 0v-2.07A7 7 0 0 0 19 12z"/>
                  </svg>
                )}
                {p.is_host && <span className="text-purple-300 text-[10px] font-semibold uppercase">host</span>}
              </div>
            )
          })}
        </div>
      </div>

      {/* Phase 4.6 — Voice strip. Mic button + status line. Hidden
          unless the parent wired voice callbacks. */}
      {voice && onJoinVoice && onToggleVoiceMute && onLeaveVoice && (
        <div className="px-5 py-3 border-b border-white/[0.06] flex items-center gap-3">
          {!voice.enabled ? (
            <button
              onClick={onJoinVoice}
              className="px-3 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.06] text-white/80 text-xs flex items-center gap-2 transition-colors"
              title="Join voice chat"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 10a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 0 0 2 0v-2.07A7 7 0 0 0 19 12z"/>
              </svg>
              Join Voice
            </button>
          ) : (
            <>
              <button
                onClick={onToggleVoiceMute}
                className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-2 transition-colors ${
                  voice.muted
                    ? 'bg-white/[0.05] hover:bg-white/[0.1] border-white/[0.06] text-white/70'
                    : 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-400/40 text-emerald-200'
                }`}
                title={voice.muted ? 'Click to unmute' : 'Click to mute'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  {voice.muted ? (
                    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23A6.93 6.93 0 0 0 19 11zm-4.02.17L12 8.18V5a3 3 0 0 1 3 3v3a3 3 0 0 1-.02.17zM4.27 3L3 4.27l6.01 6.01V11a3 3 0 0 0 3 3v.01l1.91 1.91c-.66.38-1.4.59-2.15.59A5 5 0 0 1 7 11H5c0 4.41 3.59 8 8 8 .82 0 1.61-.14 2.34-.37l4.39 4.39L21 21.73 4.27 3z"/>
                  ) : (
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zm7 10a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.93V21a1 1 0 0 0 2 0v-2.07A7 7 0 0 0 19 12z"/>
                  )}
                </svg>
                {voice.muted ? 'Muted' : 'Live'}
              </button>
              <button
                onClick={onLeaveVoice}
                className="px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-xs transition-colors"
                title="Leave voice chat"
              >
                Leave Voice
              </button>
              <span className="text-white/40 text-[10px] ml-auto">{voice.status}</span>
            </>
          )}
        </div>
      )}

      {/* Chat */}
      <div ref={chatRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {state.chat.length === 0 && (
          <p className="text-white/30 text-xs text-center py-8">No messages yet — say hi!</p>
        )}
        {state.chat.map(m => {
          const mine = m.user_id === currentUserId
          return (
            <div key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
              <div className="flex items-center gap-2 text-[10px] mb-0.5">
                <span className={mine ? 'text-purple-300' : 'text-white/50'}>{m.username}</span>
                <span className="text-white/30">{formatTime(m.timestamp)}</span>
              </div>
              <div className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-sm ${
                mine
                  ? 'bg-purple-600/30 text-white rounded-br-sm'
                  : 'bg-white/[0.05] text-white/90 rounded-bl-sm'
              }`}>
                {m.message}
              </div>
            </div>
          )
        })}
      </div>

      {/* Phase 4.6 — Ready dots / spoiler-free start. The "I'm Ready"
          toggle is for everyone (host included). Host UI also shows
          a summary: how many guests are ready, which aren't. Server
          enforces the spoiler-free gate when host hits play. */}
      {onSendReady && (() => {
        const me = state.participants.find(p => p.user_id === currentUserId)
        if (!me) return null
        const isReady = !!me.ready
        const hostUid = state.hostUserId
        const guests = state.participants.filter(p => p.user_id !== hostUid)
        const notReadyGuests = guests.filter(g => !g.ready)
        const iAmHost = currentUserId === hostUid
        return (
          <div className="px-5 py-3 border-b border-white/[0.06]">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-white/40 text-[10px] uppercase tracking-wider mb-0.5">
                  {iAmHost
                    ? (notReadyGuests.length === 0
                        ? `Everyone's ready (${guests.length})`
                        : `Waiting on ${notReadyGuests.length} of ${guests.length}`)
                    : (isReady ? "You're ready" : 'Tap "I\'m Ready" when buffered')}
                </p>
                {iAmHost && notReadyGuests.length > 0 && (
                  <p className="text-white/30 text-[10px] truncate">
                    {notReadyGuests.map(g => g.username).join(', ')}
                  </p>
                )}
              </div>
              <button
                onClick={() => onSendReady(!isReady)}
                className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors flex-shrink-0 ${
                  isReady
                    ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-400/40 text-emerald-200'
                    : 'bg-white/[0.05] hover:bg-white/[0.1] border-white/[0.06] text-white/80'
                }`}
              >
                {isReady ? "Ready ✓" : "I'm Ready"}
              </button>
            </div>
          </div>
        )
      })()}

      {/* Composer */}
      <div className="px-4 py-3 border-t border-white/[0.06]">
        <div className="flex gap-2 items-center">
          {/* 2026-05-25 — reaction picker. Renders only when the parent
              wired up onSendReaction. placement="left" anchors the
              popover to the picker's LEFT edge so it grows rightward
              into the chat-input space rather than off the panel's
              left edge / behind the sidebar (M3 from PR #83 review).
              Positioned BEFORE the input so the popover doesn't cover
              the Send button when open. */}
          {onSendReaction && state.roomConnected && (
            <ReactionPicker onSend={onSendReaction} placement="left" />
          )}
          <input
            type="text"
            placeholder={state.roomConnected ? 'Send a message…' : 'Connecting…'}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend() }}
            disabled={!state.roomConnected}
            className="flex-1 px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-sm placeholder:text-white/30 focus:bg-white/[0.06] focus:outline-none disabled:opacity-50"
            maxLength={500}
          />
          <button
            onClick={handleSend}
            disabled={!draft.trim() || !state.roomConnected}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
        {/* 2026-05-25 — host sees "End Party" with a confirm dialog
            since their leave kicks every guest; guest sees the silent
            "Leave Party" since their leave is non-destructive. */}
        <button
          onClick={() => {
            if (isHost) {
              setShowLeaveConfirm(true)
            } else {
              onLeave()
            }
          }}
          className="w-full mt-3 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 text-sm transition-colors"
        >
          {isHost ? 'End Party' : 'Leave Party'}
        </button>
        {showLeaveConfirm && (
          <div
            className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setShowLeaveConfirm(false)}
          >
            <div
              className="w-full max-w-sm bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-6"
              onClick={e => e.stopPropagation()}
            >
              <h2 className="text-white text-base font-semibold mb-2">End the party?</h2>
              <p className="text-white/60 text-sm mb-5 leading-snug">
                You're the host. Leaving will end the party for everyone
                {state.participants.length > 1 && ` (${state.participants.length - 1} other ${state.participants.length === 2 ? 'guest' : 'guests'})`}
                . The join code <span className="text-purple-300 font-mono">{state.code}</span> will stop working.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowLeaveConfirm(false)}
                  className="px-4 py-2 text-white/70 hover:text-white text-sm transition-colors"
                >
                  Keep watching
                </button>
                <button
                  onClick={() => { setShowLeaveConfirm(false); onLeave() }}
                  className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 rounded-lg text-red-200 text-sm font-medium transition-colors"
                >
                  End party
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Phase 4.7 — the highlight reel only exists AFTER the party
            ends, so there is no in-panel link; the host gets a bell
            notification with the reel URL once it's rendered. */}
      </div>
    </aside>
  )
}

function formatTime(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
