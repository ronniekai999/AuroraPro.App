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
//   - Reaction picker (sendReaction is wired but no UI to fire it)
//   - Hand-off / promote-to-host
//
// The panel reads from `useParty().state` and dispatches via the
// action methods (sendChat, leave). It does not own party state.

import { useEffect, useRef, useState } from 'react'
import type { PartyState } from '@/hooks/useParty'
import type { VoiceState } from '@/lib/voice'

interface PartyPanelProps {
  state: PartyState
  currentUserId?: number
  onSendChat: (msg: string) => void
  onLeave: () => void
  onClose: () => void
  // Phase 4.6 — voice mesh.
  voice?: VoiceState
  onJoinVoice?: () => void
  onLeaveVoice?: () => void
  onToggleVoiceMute?: () => void
  // Phase 4.6 — ready dots / spoiler-free start gate.
  onSendReady?: (ready: boolean) => void
}

export function PartyPanel({
  state, currentUserId, onSendChat, onLeave, onClose,
  voice, onJoinVoice, onLeaveVoice, onToggleVoiceMute,
  onSendReady,
}: PartyPanelProps) {
  const [draft, setDraft] = useState('')
  const chatRef = useRef<HTMLDivElement | null>(null)

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

  return (
    <aside className="fixed top-0 right-0 bottom-0 w-full sm:w-[340px] bg-[#0a0a0f]/95 backdrop-blur-xl border-l border-white/[0.06] z-[70] flex flex-col animate-fade-in">
      {/* Header */}
      <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-white text-sm font-semibold truncate">
            {state.partyName || (state.mediaTitle ? `Watching ${state.mediaTitle}` : 'Watch Party')}
          </p>
          <p className="text-white/40 text-xs mt-0.5">
            {state.code ? `Code: ${state.code}` : 'Joining…'}
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
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-white/70 hover:text-white text-lg flex items-center justify-center"
          aria-label="Close panel"
        >
          ×
        </button>
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
        <div className="flex gap-2">
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
        <button
          onClick={onLeave}
          className="w-full mt-3 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 text-sm transition-colors"
        >
          Leave Party
        </button>
        {/* Phase 4.6 — highlight reel link. Always visible while in
            a party; the server auto-generates the reel from the
            ongoing party's reactions. If the party is too young /
            has no reactions yet, the server returns 404 and the
            browser shows a "couldn't load" page. Phase 4.7 may
            gate visibility behind a "reel ready" event. */}
        {state.code && (
          <a
            href={`/api/parties/${encodeURIComponent(state.code)}/highlight.mp4?token=${encodeURIComponent(localStorage.getItem('aurora_token') || '')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-center mt-3 py-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded-lg text-white/70 hover:text-white text-xs transition-colors"
            title="Download a highlight reel of this party (server-generated from reactions)"
          >
            Highlight Reel
          </a>
        )}
      </div>
    </aside>
  )
}

function formatTime(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
