// The phone companion once it is in a party: the chat, the reactions and
// voice, beside a film that plays on another screen.
//
//   - The party's name, its code, how many are here, and Leave.
//   - What is playing, and where it was when the phone last heard; its
//     poster's colour is washed down the top of the screen.
//   - Who is here; the ring round a person means they are speaking.
//   - The chat, a line a message.
//   - The nine reactions, voice, and the message field.
//
// It only shows what the companion's connection holds and calls its actions:
// it owns no socket.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ChatMessageEvent, PartyParticipant } from '@/lib/party'
import type { VoiceState } from '@/lib/voice'
import { Icon } from '@/components/Icon'
import { PersonDisc } from '@/components/PersonDisc'
import { ReactionOverlay } from '@/components/ReactionOverlay'
import { ambientFor } from '@/lib/ambient'
import { personColor } from '@/lib/personColor'
import { QUICK_REACTIONS, drawnReaction } from '@/lib/reactions'
import type { CompanionState } from '@/hooks/useCompanion'
import { CompanionPoster } from './JoinScreen'

export interface CompanionRoomProps {
  state: CompanionState
  voice: VoiceState
  currentUserId: number
  /** False when the message was not sent: the draft is then kept. */
  sendChat: (message: string) => boolean | void
  /** What is typed and not yet sent, when the caller holds it: the room can
   *  be taken down under it (the connection given up on), and the words
   *  must be there when the person comes back to the party. */
  draft?: string
  onDraftChange?: (text: string) => void
  sendReaction: (emoji: string) => void
  joinVoice: () => Promise<void>
  toggleMute: () => void
  leaveVoice: () => void
  onLeave: () => void
}

export function CompanionRoom({
  state, voice, currentUserId,
  sendChat, sendReaction, joinVoice, toggleMute, leaveVoice, onLeave,
  draft: heldDraft, onDraftChange,
}: CompanionRoomProps) {
  const ids = useId()
  const [ownDraft, setOwnDraft] = useState('')
  const draft = heldDraft ?? ownDraft
  const setDraft = onDraftChange ?? setOwnDraft
  const [micBusy, setMicBusy] = useState(false)
  // Set as voice is asked for, not at the next render: two presses in one
  // moment must not both ask.
  const micAsking = useRef(false)
  const [micError, setMicError] = useState<string | null>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The colour the poster of what is playing casts on the screen behind it
  // (lib/ambient: sampled from the picture already drawn, and clamped dark),
  // kept with the poster it came from: it is shown only while that is still
  // the poster on screen.
  const poster = state.mediaPoster
  const [wash, setWash] = useState<{ poster: string | undefined; color: string | null } | null>(null)
  const onArt = useCallback((img: HTMLImageElement) => {
    void ambientFor(img).then(color => {
      setWash(was => (was && was.poster === poster && was.color === color ? was : { poster, color }))
    })
  }, [poster])
  const ambient = wash && wash.poster === poster ? wash.color : null

  // Follow the newest message, but only for someone already near the end:
  // a person reading back is not pulled down. A chat that has just filled
  // (the history that arrives with the connection) opens at its end.
  //
  // "Near the end" is kept from the scroller's own scroll events, as it was
  // BEFORE the new line arrived: measured after, one tall message put the
  // end further away than the allowance and the chat stopped following. And
  // the effect runs for a new last message, not a new count: the list is
  // capped, so after two hundred messages the count no longer changes.
  const nearEnd = useRef(true)
  const chatHad = useRef(0)
  const last = state.chat[state.chat.length - 1]
  const lastKey = last ? chatKey(last) : ''
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const filled = chatHad.current === 0
    chatHad.current = state.chat.length
    if (filled || nearEnd.current) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey])

  // When everything left is within reach of the end, the reader is at the
  // end, whatever the last scroll event said: a history that comes back
  // shorter than the box (after a reconnect) fires no scroll event, and a
  // reader left "scrolled back" would never be followed again.
  useEffect(() => {
    const el = chatScrollRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) nearEnd.current = true
  }, [state.chat])

  // The chat's own box changes height too (a note appears above the message
  // field, the voice row opens): someone at the end stays at the end.
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(() => { if (nearEnd.current) el.scrollTop = el.scrollHeight })
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  // The chat is a live region, and the history that arrives with the
  // connection is not news: up to a hundred lines would be read out at once.
  // It is switched on a frame after the room's state has been drawn, and
  // off again from a drop until the state has arrived anew. `synced`, not
  // the connection's status: the socket is "connected" as it opens, before
  // the server has sent the history.
  const [chatLive, setChatLive] = useState(false)
  useEffect(() => {
    if (!state.synced) { setChatLive(false); return }
    const frame = requestAnimationFrame(() => setChatLive(true))
    return () => cancelAnimationFrame(frame)
  }, [state.synced])

  // Entering the room, the focus goes to its heading: the screen before it
  // (the code field, the sign-in) is gone, and the focus with it.
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  useEffect(() => { headingRef.current?.focus() }, [])

  // The others in voice, by user id, and whether each is speaking. The
  // viewer's own voice is on voice.enabled and voice.selfSpeaking.
  const speakingByUser = useMemo(() => {
    const m = new Map<number, boolean>()
    for (const p of voice.peers) m.set(p.userId, p.speaking)
    return m
  }, [voice.peers])

  const submit = () => {
    const t = draft.trim()
    if (!t) return
    // Not sent (the connection is down): what was typed stays in the field.
    if (!live || sendChat(t) === false) return
    setDraft('')
    inputRef.current?.focus()
  }

  const onMicClick = async () => {
    if (micAsking.current) return
    setMicError(null)
    if (!voice.enabled) {
      // No microphone API at all: a page not served over https, or an old
      // in-app browser. Trying again cannot help, so it is not what is said.
      if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        setMicError('Voice is not available in this browser.')
        return
      }
      micAsking.current = true
      setMicBusy(true)
      try {
        await joinVoice()
      } catch (err) {
        const reason = (err as { reason?: string })?.reason
        setMicError(
          reason === 'denied'
            ? 'The microphone is blocked. Allow it for this site in your browser’s settings.'
            : reason === 'device'
              ? 'The microphone is not available. Check the phone’s microphone permission, or close another app that is using it.'
              : 'Voice could not be started. Try again.',
        )
      } finally {
        micAsking.current = false
        setMicBusy(false)
      }
      return
    }
    // In voice already: this is the mute switch.
    toggleMute()
  }

  // Voice that ended without the person leaving it (it goes with the room's
  // connection) is said: the button has gone back to "Join voice" by itself.
  const leftVoice = useRef(false)
  const wasInVoice = useRef(voice.enabled)
  useEffect(() => {
    if (wasInVoice.current && !voice.enabled && !leftVoice.current) {
      setMicError('Voice ended when the connection dropped. Join voice again once you are reconnected.')
    }
    wasInVoice.current = voice.enabled
    leftVoice.current = false
  }, [voice.enabled])
  const leave = () => { leftVoice.current = true; leaveVoice() }

  const live = state.connected && !state.reconnecting
  // The connection has come back: said for a few seconds, since the note
  // about being disconnected otherwise just goes.
  const [backAgain, setBackAgain] = useState(false)
  const wasLive = useRef<boolean | null>(null)
  useEffect(() => {
    const before = wasLive.current
    wasLive.current = live
    if (!live) { setBackAgain(false); return }
    // Only a return: the first connection is not one.
    if (before !== false) return
    setBackAgain(true)
    const t = window.setTimeout(() => setBackAgain(false), 6000)
    return () => window.clearTimeout(t)
  }, [live])
  // The first connection still on its way counts as connecting, so the
  // header never says "offline" while the phone is in fact getting there.
  const pending = state.reconnecting || (state.status === 'joining' && !state.connected)
  const here = state.participants.length
  const inVoice = voice.enabled
  const liveMic = inVoice && !voice.muted
  // What the server refused while connected (too many messages, say). An
  // error that ends the party is the join screen's to show.
  const refused = state.connected && state.error ? state.error : null

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      style={{ '--ambient': ambient ?? 'transparent' } as CSSProperties}
    >
      {/* Behind everything else on the screen: the header and the page
          below are positioned, and come after it. */}
      <div className="companion-wash" aria-hidden="true" />
      <header className="relative flex flex-none items-center gap-2 pl-4 pr-2 pt-3">
        <div className="min-w-0 flex-1">
          <h1 ref={headingRef} tabIndex={-1} className="truncate rounded-chip font-display text-[26px] font-bold leading-[1.15] tracking-[-0.015em] text-ink">
            <bdi>{state.partyName || state.mediaTitle || 'Watch party'}</bdi>
          </h1>
          <p className="text-[13px] leading-snug text-ink-2">
            {state.code && <>Code <span className="tracking-[0.04em]">{state.code}</span></>}
            {state.code && here > 0 && ' · '}
            {here > 0 && `${here} here`}
          </p>
          {/* The connection, in words, whenever it is not simply up. */}
          <p role="status" className={live ? (backAgain ? 'text-[13px] leading-snug text-ink-2' : 'sr-only') : `text-[13px] leading-snug ${pending ? 'text-warn' : 'text-danger-ink'}`}>
            {live
              ? (backAgain ? (draft.trim() ? 'Connected again. Your message is still in the field.' : 'Connected again.') : '')
              : pending ? (state.status === 'joining' ? 'Connecting…' : 'Reconnecting…') : 'Offline'}
          </p>
        </div>
        <button type="button" onClick={onLeave} className="stage-btn stage-btn-danger flex-none" aria-label="Leave the party">
          Leave
        </button>
      </header>

      <main className="relative flex min-h-0 flex-1 flex-col">
        {(state.mediaTitle || state.mediaPoster) && (
          <section aria-label="Now playing" className="companion-tall-only mx-4 mt-3 flex-none items-center gap-3 rounded-control bg-surface-raised p-3">
            <CompanionPoster poster={state.mediaPoster} className="h-[60px] w-10 rounded-chip" onArt={onArt} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold text-ink"><bdi>{state.mediaTitle || 'Now playing'}</bdi></p>
              {/* The room's connection is told the position when the phone
                  connects and when the title or the host changes, not as
                  the film runs: so this is where it was, not a clock. */}
              <p className="mt-1 text-xs tabular-nums text-ink-2">
                {formatClock(state.currentTimeMs)} · {state.isPlaying ? 'playing' : 'paused'} at the last update
              </p>
            </div>
          </section>
        )}

        {here > 0 && (
          <ul aria-label="Participants" className="companion-tall-only scrollbar-hide mt-3 flex-none gap-3 overflow-x-auto px-4">
            {state.participants.map(p => {
              const self = p.user_id === currentUserId
              return (
                <Member
                  key={p.user_id}
                  participant={p}
                  isSelf={self}
                  // Who else is in voice is only known to a phone that is in
                  // voice itself: out of it, nothing is said of the others'.
                  inVoice={self ? inVoice : inVoice && speakingByUser.has(p.user_id)}
                  speaking={self ? voice.selfSpeaking : !!speakingByUser.get(p.user_id)}
                />
              )
            })}
          </ul>
        )}

        <div
          ref={chatScrollRef}
          role="log"
          aria-label="Chat"
          aria-live={chatLive ? 'polite' : 'off'}
          onScroll={e => {
            const el = e.currentTarget
            nearEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
          }}
          className="mt-2 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3"
          // Kept out of a bug report's screenshot, as the reactions are.
          data-screenshot-exclude="true"
        >
          {/* Pushes a short chat to the foot of its space, above the reactions. */}
          <div className="flex-1" aria-hidden="true" />
          {state.chat.length === 0 && (
            <p className="text-[14px] leading-snug text-ink-2">
              Nothing said yet. What you send appears here and on everyone’s screen.
            </p>
          )}
          {state.chat.map(m => (
            <ChatLine key={chatKey(m)} msg={m} mine={m.user_id === currentUserId} />
          ))}
        </div>

        {/* The one place this screen reports a refusal: the server's, and
            the microphone's. */}
        {/* Not atomic: when one of the two changes, only that one is read
            out again. */}
        <p role="alert" aria-atomic="false" className={refused || micError ? 'flex-none px-4 pb-2 text-[13px] leading-snug text-danger-ink' : 'sr-only'}>
          {refused && <span>{refused}</span>}{refused && micError ? ' ' : ''}{micError && <span id={`${ids}-mic`}>{micError}</span>}
        </p>

        <div className="flex flex-none items-center gap-2 px-4">
          <div role="group" aria-label="Quick reactions" className="scrollbar-hide -my-1 flex min-w-0 flex-1 gap-2 overflow-x-auto py-1">
            {/* lib/reactions' nine: each is one the server accepts, as it is
                sent; what is drawn can differ (the heart). */}
            {QUICK_REACTIONS.map(e => (
              <button
                key={e}
                type="button"
                onClick={() => sendReaction(e)}
                className="grid h-12 w-12 flex-none place-items-center rounded-control bg-surface-raised text-[22px] transition-colors hover:bg-surface-raised-2"
                aria-label={`React with ${drawnReaction(e)}`}
              >
                {drawnReaction(e)}
              </button>
            ))}
          </div>
          {/* Voice. Joining starts with the microphone muted; the same
              button is then the mute switch, and its words say which. A
              long press (the context menu) leaves voice, as "Leave voice"
              below does in sight. */}
          <button
            type="button"
            onClick={() => void onMicClick()}
            onContextMenu={e => { if (inVoice) { e.preventDefault(); leave() } }}
            aria-disabled={micBusy}
            aria-describedby={micError ? `${ids}-mic` : undefined}
            className={`stage-btn stage-btn-thumb stage-btn-pill flex-none ${inVoice ? `stage-btn-ghost ${liveMic ? 'is-on' : ''}` : 'stage-btn-primary'}`}
          >
            {inVoice && <Icon name="mic" size={18} />}
            {micBusy ? 'Starting…' : !inVoice ? 'Join voice' : liveMic ? 'Mute' : 'Unmute'}
          </button>
        </div>
        {inVoice && (
          <p className="flex flex-none items-center justify-between gap-3 px-4 pt-2 text-[13px] leading-snug text-ink-2">
            <span>{liveMic ? 'Your microphone is on.' : 'You are in voice, muted.'}</span>
            <button type="button" onClick={leave} className="stage-btn stage-btn-sm stage-hit44 stage-btn-quiet -mr-3 flex-none">Leave voice</button>
          </p>
        )}

        {/* Why Send is off while the connection is down, tied to the field
            and the button. What is typed is kept, not sent into nothing. */}
        {!live && (
          <p id={`${ids}-held`} className="flex-none px-4 pt-2 text-[13px] leading-snug text-ink-2">
            Not connected. What you type is kept here until the connection is back.
          </p>
        )}
        <form
          className="flex flex-none gap-2 px-4 pb-[calc(env(safe-area-inset-bottom)+1.75rem)] pt-3"
          onSubmit={e => { e.preventDefault(); submit() }}
        >
          <label htmlFor={`${ids}-msg`} className="sr-only">Message the party</label>
          <input
            id={`${ids}-msg`}
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Message the party"
            maxLength={1000}
            enterKeyHint="send"
            autoComplete="off"
            aria-describedby={live ? undefined : `${ids}-held`}
            className="companion-field h-12 min-w-0 flex-1"
          />
          {/* Off, not disabled, while there is nothing to send or nowhere to
              send it: it keeps its place in the tab order and the focus a
              press gave it. */}
          <button
            type="submit"
            aria-disabled={!draft.trim() || !live}
            aria-describedby={live ? undefined : `${ids}-held`}
            aria-label="Send message"
            className="stage-btn stage-btn-thumb stage-btn-square stage-btn-ghost flex-none"
          >
            <Icon name="send" size={18} />
          </button>
        </form>
      </main>

      {/* The reactions that float up the screen: the app's own overlay,
          which covers the window. Under reduced motion the stylesheet
          stills them. */}
      <ReactionOverlay events={state.recentReactions} />
    </div>
  )
}

/** One person in the party: their disc (ringed while they speak), their
 *  name, and what is known of how they are here. */
function Member({ participant, isSelf, inVoice, speaking }: {
  participant: PartyParticipant
  isSelf: boolean
  inVoice: boolean
  speaking: boolean
}) {
  const parts = [
    participant.is_host ? 'host' : null,
    speaking ? 'talking' : inVoice ? 'in voice' : null,
    participant.companion ? 'on phone' : null,
  ].filter((x): x is string => x !== null)
  // With nothing more known of them, a person is here: whether they are
  // watching, and for others whether they are in voice, is not something
  // this phone is told.
  const note = parts.length ? parts.join(', ') : 'here'
  return (
    <li className="flex w-16 flex-none flex-col items-center gap-1 text-center">
      {/* No surface of its own: the people sit on the wash, and a ring in
          the page's colour showed against it. */}
      <PersonDisc name={participant.username} colorKey={participant.user_id} size={48} speaking={speaking} surface="transparent" />
      <span className="w-full truncate text-xs font-semibold text-ink">{isSelf ? 'You' : <bdi>{participant.username}</bdi>}</span>
      <span className="text-xs leading-tight text-ink-2">{note.charAt(0).toUpperCase() + note.slice(1)}</span>
    </li>
  )
}

/** A message: who said it, in their colour, then what. */
function ChatLine({ msg, mine }: { msg: ChatMessageEvent; mine: boolean }) {
  return (
    <p className="text-[15px] leading-[1.4] [overflow-wrap:anywhere]">
      {/* Each isolated: a name or a message in a right-to-left script must
          not reorder what is beside it. */}
      <span className="font-semibold" style={{ color: personColor(msg.user_id) }}>{mine ? 'You' : <bdi>{msg.username}</bdi>}</span>{' '}
      <bdi className="text-ink">{msg.message}</bdi>
    </p>
  )
}

// A key for a chat line: the server's id, or what stands in for one when a
// malformed row has none.
function chatKey(m: ChatMessageEvent): string {
  return m.id || `${m.user_id}|${m.timestamp}|${m.message.slice(0, 16)}`
}

// Where playback has got to, as H:MM:SS or M:SS.
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
