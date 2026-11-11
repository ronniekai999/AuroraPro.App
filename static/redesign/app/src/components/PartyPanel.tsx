// The watch-party surface: who is here, voice, chat, the ready gate and the
// way out. It reads `useParty().state` and calls its actions; it owns no
// party state.
//
// Two faces, so the parent keeps ONE mount point and a header toggle just
// flips `variant`:
//   - "rail" (default): the whole party in a panel at the right edge.
//   - "minimal": "just the film". A lower-third chat ticker, a corner voice
//     pill and a bottom mini dock (CinematicChatTicker / VoicePill / MiniDock).

import { useEffect, useRef, useState } from 'react'
import type { PartyState } from '@/hooks/useParty'
import { useExitTransition } from '@/hooks/useExitTransition'
import type { VoiceState } from '@/lib/voice'
import { ReactionPicker } from './ReactionOverlay'
import { CinematicChatTicker } from './CinematicChatTicker'
import { VoicePill } from './VoicePill'
import { MiniDock } from './MiniDock'
import { PartyLobbyCard } from './PartyLobbyCard'
import { PersonDisc } from './PersonDisc'
import { personColor } from '@/lib/personColor'

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
  // 2026-08 — host succession made "leave" and "end" different actions:
  // the host's leave hands the party off, and THIS is the deliberate
  // end-for-everyone (useParty.end → POST /api/parties/{code}/end).
  // Optional: when absent, the hand-off dialog simply omits the "End
  // for everyone" option.
  onEndParty?: () => void
  // Invites feature — scheduled-party lobby controls (rail-only; the
  // minimal face is a during-playback surface and a scheduled party
  // hasn't started). Host early start = useParty.requestPlay: the server
  // cancels the countdown on first play. Reschedule wraps
  // schedulePartyStart + a toast in App.
  onStartNow?: () => void
  onReschedule?: (iso: string) => void
}

export function PartyPanel({
  state, currentUserId, onSendChat, onLeave, onClose,
  onSendReaction,
  voice, onJoinVoice, onLeaveVoice, onToggleVoiceMute,
  onSendReady,
  variant = 'rail',
  onToggleVariant,
  onInvite,
  onEndParty,
  onStartNow,
  onReschedule,
}: PartyPanelProps) {
  const [draft, setDraft] = useState('')
  const chatRef = useRef<HTMLDivElement | null>(null)
  // 2026-05-25 — host-aware leave confirmation; reworked 2026-08 for
  // host succession. A host's leave now HANDS THE PARTY OFF server-side
  // (promoteSuccessorLocked picks the most senior remaining watcher and
  // the movie keeps playing), so the dialog's job changed from "are you
  // sure you want to end it?" to a choice: hand off and leave, or end
  // for everyone (a separate deliberate action, onEndParty). Only when
  // nobody eligible remains — lone host, or only phone companions left,
  // who have no player to keep watching on — does a leave still end the
  // party, and the dialog keeps the historical end-confirm copy for
  // exactly that case.
  //
  // Guests get the silent button (their leave is non-destructive —
  // party continues, others stay).
  const isHost = !!currentUserId && currentUserId === state.hostUserId
  // Mirrors the server's successor-eligibility rule (companions can't
  // inherit: no player, no sync socket). Presentation-only — the server
  // decides for real on leave; this just picks which dialog to show.
  const canHandOff = isHost && state.participants.some(
    p => p.user_id !== currentUserId && !p.companion,
  )
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  // The confirm stays mounted for its exit fade after the flag flips false;
  // a re-open mid-fade cancels the pending unmount (partyPanelLeave.test
  // closes and re-opens it within one test).
  const leaveExit = useExitTransition(showLeaveConfirm)

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

  // The rail tells the page it is open, so a boxed player can leave room for
  // it instead of sitting underneath (index.css `--theater-rail-space`).
  useEffect(() => {
    if (variant !== 'rail') return
    const el = document.documentElement
    el.dataset.partyRail = 'open'
    return () => { el.removeAttribute('data-party-rail') }
  }, [variant])

  // ──────────────────────────────────────────────────────────────────
  // Minimal face: "just the film". Three small surfaces over the picture
  // (a chat ticker, a voice pill, a mini dock) and one chip that brings
  // the rail back. Each is its own fixed overlay, rendered as siblings in
  // a Fragment so no wrapping box intercepts presses over the player.
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
        {/* The chip that restores the rail. Top left of the viewport,
            mirroring the voice pill at the top right. `.stage-party-dock`
            (index.css) moves it down, `top` ONLY, while the player is in
            the window, because that corner is the player's back button and
            title. It is a sibling of the player root, so it is not on
            screen in browser fullscreen. The glyph is a chat bubble: a
            corners-out glyph read as "fullscreen". */}
        {onToggleVariant && (
          <button
            type="button"
            onClick={onToggleVariant}
            data-screenshot-exclude="true"
            className="stage-party-dock fixed top-4 left-4 z-[67] flex items-center gap-2 h-10 px-3.5 rounded-control
                       bg-surface-raised-2 text-ink text-[13px] font-semibold hover:brightness-110 transition-[filter]"
            title="Open the party chat"
            aria-label="Open the party chat"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" />
            </svg>
            Party
            {state.code && state.reconnecting && (
              <span
                className="w-2 h-2 rounded-full bg-warn motion-safe:animate-pulse"
                title="Reconnecting to the party"
              />
            )}
          </button>
        )}
      </>
    )
  }

  const talking = state.participants.filter(p => {
    const isSelf = currentUserId === p.user_id
    return isSelf ? !!voice?.selfSpeaking : !!voice?.peers.find(v => v.userId === p.user_id)?.speaking
  })

  // ──────────────────────────────────────────────────────────────────
  // Rail (default) face: the whole party in one panel at the right edge.
  // Opaque, because it sits over (or beside) playing video and blur over
  // video is paid for on every frame.
  return (
    <aside
      aria-label="Party"
      className="stage-party-rail fixed top-3 right-3 bottom-3 w-[calc(100%-1.5rem)] sm:w-[340px] sm:top-4 sm:right-4 sm:bottom-4 bg-surface-raised rounded-control shadow-[0_24px_64px_rgba(0,0,0,0.6)] z-[70] flex flex-col overflow-hidden motion-safe:animate-fade-in"
    >
      {/* Header */}
      <div className="pl-5 pr-3 pt-4 pb-3 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-display text-ink text-[22px] font-semibold tracking-[-0.01em] leading-tight truncate">
            {state.partyName || (state.mediaTitle ? `Watching ${state.mediaTitle}` : 'Watch Party')}
          </p>
          <p className="text-ink-2 text-[12px] mt-0.5 flex items-center gap-2 flex-wrap">
            <span className="tracking-[0.12em] tabular-nums">{state.code ? state.code : 'Joining…'}</span>
            {/* Shown while the room socket reconnects after an unexpected
                close. The server holds a host's place for 90 seconds, so
                most outages are over before anyone notices more than this. */}
            {state.code && state.reconnecting && (
              <span
                className="inline-flex items-center gap-1.5 text-warn font-medium"
                title="Lost connection to the party. Trying to reconnect"
              >
                <span className="w-2 h-2 rounded-full bg-warn motion-safe:animate-pulse" />
                Reconnecting…
              </span>
            )}
            {state.code && (
              <button
                onClick={() => {
                  // The clipboard API needs HTTPS or localhost, and many
                  // installs are plain HTTP on a home network; fall back to
                  // a hidden textarea so the code is copied either way.
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
                    } catch { /* the code is on screen to read */ }
                  }
                  if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(code).catch(fallback)
                  } else {
                    fallback()
                  }
                }}
                className="text-ink underline underline-offset-2 hover:no-underline"
                title="Copy code to clipboard"
              >
                Copy code
              </button>
            )}
          </p>
        </div>
        {/* Host only: opens the invite card (join code and a QR link for
            phones). The parent wires it for the host alone. */}
        {onInvite && (
          <button
            onClick={onInvite}
            className="h-10 px-3 rounded-control text-ink text-[13px] font-semibold hover:bg-action-soft transition-colors"
            title="Invite friends to this party"
            aria-label="Invite friends to this party"
          >
            Invite
          </button>
        )}
        {/* Collapses the rail to the minimal face. A window-chrome minus:
            a corners-out glyph read as "fullscreen" next to the player's
            real one. */}
        {onToggleVariant && (
          <button
            onClick={onToggleVariant}
            className="w-10 h-10 rounded-control text-ink-2 hover:text-ink hover:bg-action-soft grid place-items-center transition-colors"
            title="Minimize the party chat"
            aria-label="Minimize the party chat"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M5 11h14v2H5z" />
            </svg>
          </button>
        )}
        <button
          onClick={onClose}
          className="w-10 h-10 rounded-control text-ink-2 hover:text-ink hover:bg-action-soft grid place-items-center transition-colors"
          aria-label="Close panel"
          title="Hide the party panel"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {/* Error banner */}
      {state.error && (
        <div role="alert" className="mx-3 mb-2 px-3 py-2 rounded-control bg-surface-raised-2 text-danger-ink text-[13px]">
          {state.error}
        </div>
      )}

      {/* Scheduled-party lobby: countdown, RSVP roster and host controls.
          Visible until the countdown fires (party-starting clears
          scheduledStartAt) or the host starts early (isPlaying). */}
      {state.code && state.scheduledStartAt && !state.startedAt && !state.isPlaying && (
        <PartyLobbyCard
          code={state.code}
          scheduledStartAt={state.scheduledStartAt}
          isHost={isHost}
          onStartNow={isHost ? onStartNow : undefined}
          onReschedule={isHost ? onReschedule : undefined}
        />
      )}

      {/* Who is here. A person's disc carries the aurora ring while they
          are speaking; the dot beside the name is their playback state. */}
      <div className="px-5 pb-3">
        <p className="text-ink-2 text-[12px] font-semibold uppercase tracking-[0.08em] mb-2">
          Watching ({state.participants.length})
        </p>
        <ul className="flex flex-wrap gap-x-3 gap-y-2">
          {state.participants.map(p => {
            const isSelf = currentUserId === p.user_id
            const peerVoice = voice?.peers.find(v => v.userId === p.user_id)
            const speaking = isSelf ? !!voice?.selfSpeaking : !!peerVoice?.speaking
            const onVoice = isSelf
              ? (voice?.enabled ?? false)
              : !!peerVoice
            const state_ = speaking
              ? 'talking'
              : p.is_buffering ? 'buffering' : onVoice ? 'in voice' : p.ready ? 'ready' : ''
            return (
              <li
                key={p.user_id}
                className="flex items-center gap-2 min-w-0"
                title={`${p.username}${p.is_host ? ' (host)' : ''}${state_ ? `, ${state_}` : ''}`}
              >
                <PersonDisc name={p.username} colorKey={p.user_id} size={32} speaking={speaking} />
                <span className="min-w-0">
                  <span className="block text-ink text-[13px] font-medium truncate max-w-[120px]">
                    {p.username}{p.is_host && <span className="text-ink-2 font-normal"> · host</span>}
                  </span>
                  {state_ && (
                    <span className={`block text-[12px] leading-tight ${p.is_buffering && !speaking ? 'text-warn' : 'text-ink-2'}`}>
                      {state_}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Voice. Hidden unless the parent wired the voice callbacks. */}
      {voice && onJoinVoice && onToggleVoiceMute && onLeaveVoice && (
        <div className="mx-3 mb-3 p-3 rounded-control bg-surface-raised-2 flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-ink text-[14px] font-semibold">
              {voice.enabled
                ? (talking.length > 0 ? `Voice · ${talking.length} talking` : `Voice · ${1 + voice.peers.length} here`)
                : 'Voice'}
            </span>
            <span className="block text-ink-2 text-[12px] truncate">
              {talking.length > 0
                ? `${talking.map(t => (t.user_id === currentUserId ? 'You' : t.username)).join(', ')} ${talking.length === 1 && talking[0].user_id !== currentUserId ? 'is' : 'are'} speaking`
                : voice.enabled ? voice.status : 'Talk while you watch'}
            </span>
          </span>
          {!voice.enabled ? (
            <button
              onClick={onJoinVoice}
              className="h-10 px-4 rounded-full bg-action text-action-on text-[14px] font-semibold hover:brightness-95 transition-[filter] flex-none"
              title="Join voice chat"
            >
              Join Voice
            </button>
          ) : (
            <>
              <button
                onClick={onToggleVoiceMute}
                aria-pressed={!voice.muted}
                className={`h-10 px-3 rounded-control text-[13px] font-semibold flex items-center gap-2 transition-colors flex-none ${
                  voice.muted
                    ? 'bg-action-soft text-ink hover:bg-white/[0.16]'
                    : 'bg-action text-action-on hover:brightness-95'
                }`}
                title={voice.muted ? 'Click to unmute' : 'Click to mute'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
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
                className="h-10 px-3 rounded-control text-danger-ink text-[13px] font-semibold hover:bg-action-soft transition-colors flex-none"
                title="Leave voice chat"
              >
                Leave Voice
              </button>
            </>
          )}
        </div>
      )}

      {/* Chat */}
      <div ref={chatRef} className="flex-1 overflow-y-auto px-5 py-2 space-y-3">
        {state.chat.length === 0 && (
          <p className="text-ink-2 text-[13px] text-center py-8">No messages yet. Say hi!</p>
        )}
        {state.chat.map(m => (
          <p key={m.id} className="text-[14px] leading-[1.45] break-words">
            <span className="font-semibold" style={{ color: personColor(m.user_id) }}>{m.username}</span>{' '}
            <span className="text-[12px] text-ink-3 tabular-nums">{formatTime(m.timestamp)}</span>
            <br />
            <span className="text-ink">{m.message}</span>
          </p>
        ))}
      </div>

      {/* Ready dots / spoiler-free start. Everyone has the toggle; the host
          also sees how many guests are ready. The server enforces the gate
          when the host presses play. */}
      {onSendReady && (() => {
        const me = state.participants.find(p => p.user_id === currentUserId)
        if (!me) return null
        const isReady = !!me.ready
        const hostUid = state.hostUserId
        // The people the server's spoiler-free gate waits for: phone
        // companions have no player and no Ready control, so they are
        // never counted.
        const guests = state.participants.filter(p => p.user_id !== hostUid && !p.companion)
        const notReadyGuests = guests.filter(g => !g.ready)
        const iAmHost = currentUserId === hostUid
        return (
          <div className="px-5 py-3 border-t border-line">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-ink text-[13px] font-medium">
                  {iAmHost
                    ? (notReadyGuests.length === 0
                        ? `Everyone's ready (${guests.length})`
                        : `Waiting on ${notReadyGuests.length} of ${guests.length}`)
                    : (isReady ? "You're ready" : 'Tap "I\'m Ready" when buffered')}
                </p>
                {iAmHost && notReadyGuests.length > 0 && (
                  <p className="text-ink-2 text-[12px] truncate">
                    {notReadyGuests.map(g => g.username).join(', ')}
                  </p>
                )}
              </div>
              <button
                onClick={() => onSendReady(!isReady)}
                aria-pressed={isReady}
                className={`h-10 px-4 rounded-control text-[13px] font-semibold transition-colors flex-shrink-0 ${
                  isReady
                    ? 'bg-action text-action-on hover:brightness-95'
                    : 'bg-action-soft text-ink hover:bg-white/[0.16]'
                }`}
              >
                {isReady ? "Ready ✓" : "I'm Ready"}
              </button>
            </div>
          </div>
        )
      })()}

      {/* Composer */}
      <div className="px-3 pt-3 pb-3">
        <div className="flex gap-2 items-center">
          {/* placement="left": the picker grows rightward into the input's
              space instead of off the panel's left edge. Before the input,
              so its popover never covers Send. */}
          {onSendReaction && state.roomConnected && (
            <ReactionPicker onSend={onSendReaction} placement="left" />
          )}
          <input
            type="text"
            aria-label="Message the party"
            placeholder={state.roomConnected ? 'Message the party' : 'Connecting…'}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend() }}
            disabled={!state.roomConnected}
            className="flex-1 min-w-0 h-11 px-3 bg-surface-page border border-line-strong rounded-control text-ink text-[14px] placeholder:text-ink-3 focus:outline-none focus-visible:border-ink disabled:opacity-50"
            maxLength={500}
          />
          <button
            onClick={handleSend}
            disabled={!draft.trim() || !state.roomConnected}
            className="h-11 px-4 bg-action text-action-on rounded-control text-[14px] font-semibold hover:brightness-95 transition-[filter] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
        {/* A guest's leave is silent: the party goes on without them. A
            host's opens a dialog. With an eligible successor present the
            host's leave hands the party off, so the button reads "Leave
            Party" and the dialog offers hand-off or end-for-everyone;
            without one, leaving ends the party and the copy says so. */}
        <button
          onClick={() => {
            if (isHost) {
              setShowLeaveConfirm(true)
            } else {
              onLeave()
            }
          }}
          className="w-full mt-2 h-10 rounded-control text-danger-ink text-[14px] font-semibold hover:bg-action-soft transition-colors"
        >
          {isHost && !canHandOff ? 'End Party' : 'Leave Party'}
        </button>
        {leaveExit.mounted && (
          <div
            className={`fixed inset-0 z-[80] bg-[rgba(6,7,8,0.72)] flex items-center justify-center p-4 animate-fade-in${leaveExit.closing ? ' is-closing' : ''}`}
            onClick={() => setShowLeaveConfirm(false)}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="party-leave-title"
              className="w-full max-w-sm bg-surface-raised-2 rounded-sheet p-6"
              onClick={e => e.stopPropagation()}
            >
              {canHandOff ? (
                <>
                  <h2 id="party-leave-title" className="font-display text-ink text-[22px] font-semibold mb-2">Leave the party?</h2>
                  <p className="text-ink-2 text-[15px] mb-5 leading-normal">
                    You're the host. If you leave, hosting passes to another
                    watcher and the movie keeps playing. The code{' '}
                    <span className="text-ink font-semibold tracking-[0.08em]">{state.code}</span>{' '}
                    keeps working, and you can rejoin any time.
                  </p>
                  <div className="flex gap-2 justify-end flex-wrap">
                    <button
                      onClick={() => setShowLeaveConfirm(false)}
                      className="h-11 px-4 rounded-control text-ink-2 hover:text-ink text-[14px] font-semibold transition-colors"
                    >
                      Keep watching
                    </button>
                    {onEndParty && (
                      <button
                        onClick={() => { setShowLeaveConfirm(false); onEndParty() }}
                        className="h-11 px-4 rounded-control bg-danger text-white text-[14px] font-semibold hover:brightness-110 transition-[filter]"
                      >
                        End for everyone
                      </button>
                    )}
                    <button
                      onClick={() => { setShowLeaveConfirm(false); onLeave() }}
                      className="h-11 px-5 rounded-full bg-action text-action-on text-[14px] font-semibold hover:brightness-95 transition-[filter]"
                    >
                      Hand off &amp; leave
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2 id="party-leave-title" className="font-display text-ink text-[22px] font-semibold mb-2">End the party?</h2>
                  <p className="text-ink-2 text-[15px] mb-5 leading-normal">
                    You're the host. Leaving will end the party for everyone
                    {state.participants.length > 1 && ` (${state.participants.length - 1} other ${state.participants.length === 2 ? 'guest' : 'guests'})`}
                    . The join code <span className="text-ink font-semibold tracking-[0.08em]">{state.code}</span> will stop working.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setShowLeaveConfirm(false)}
                      className="h-11 px-4 rounded-control text-ink-2 hover:text-ink text-[14px] font-semibold transition-colors"
                    >
                      Keep watching
                    </button>
                    <button
                      onClick={() => { setShowLeaveConfirm(false); onLeave() }}
                      className="h-11 px-4 rounded-control bg-danger text-white text-[14px] font-semibold hover:brightness-110 transition-[filter]"
                    >
                      End party
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {/* The highlight reel only exists AFTER the party ends, so there is
            no link here; the host gets a notification once it is rendered. */}
      </div>
    </aside>
  )
}

function formatTime(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
