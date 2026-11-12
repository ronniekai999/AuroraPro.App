// The phone companion's way in: the party's code, and who is joining.
//
//   - One field for the six characters of the code (validated against
//     ^[A-Z0-9]{6}$), and Join.
//   - What is playing in the party a complete code names, read from
//     GET /api/code/{code}/info.
//   - Who the phone is signed in as; when it is not signed in, the sign-in
//     the companion's root supplies.
//
// It holds no session and joins nothing itself: it hands a complete code to
// the companion's root, which owns the sign-in and the connection.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  getCompanionPartyPreview,
  posterURL,
  type CompanionPartyPreview,
  type User,
} from '@/lib/api'
import { Icon } from '@/components/Icon'
import { PersonDisc } from '@/components/PersonDisc'
import { localDateKey } from '@/lib/partyInvites'
import { CompanionHeader } from './companionUi'

const CODE_LEN = 6
const CODE_RE = /^[A-Z0-9]{6}$/

export interface JoinScreenProps {
  // Pre-fill from /join/:code deep link (already uppercased by caller).
  initialCode?: string
  // Currently authenticated user, if any. When null, JoinScreen renders
  // a compact "sign in to join" affordance and disables the Join button.
  user: User | null
  // Slot for the sign-in UI (OAuth + password) — supplied by
  // CompanionApp so JoinScreen stays auth-agnostic. Rendered inside the
  // screen when `user` is null.
  signInSlot?: React.ReactNode
  // Submit a validated 6-char code. Parent runs useCompanion.join and is
  // responsible for transitioning to the room view on success. Returns
  // ok/error so JoinScreen can surface a failure inline.
  onJoin: (code: string) => { ok: boolean; error?: string }
  // Optional one-shot error to display (e.g. "host ended the party")
  // when the parent bounced the user back to this screen.
  externalError?: string | null
}

export function JoinScreen({ initialCode, user, signInSlot, onJoin, externalError }: JoinScreenProps) {
  const ids = useId()
  const [code, setCode] = useState<string>((initialCode ?? '').slice(0, CODE_LEN))
  // What stopped a join, and whether it is about the code in the field: only
  // then is the field marked.
  const [error, setError] = useState<{ text: string; aboutCode: boolean } | null>(null)

  // What is playing in the party the code names. null = none, or not known.
  const [preview, setPreview] = useState<CompanionPartyPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // What was typed or pasted, as a code: its letters and numbers, upper
  // case, the first six. A pasted join or invitation link gives the code it
  // ends in. The field has no maxLength of its own: that cut a pasted
  // "FRD-4YC" to six characters before the dash was taken out, and lost the
  // last one.
  const normalize = (v: string) => {
    const link = /\/(?:join|p)\/([A-Za-z0-9]{6})(?![A-Za-z0-9])/.exec(v)
    return (link ? link[1] : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN)
  }

  // Looked up a moment after a complete code is in the field.
  useEffect(() => {
    if (!CODE_RE.test(code)) {
      setPreview(null)
      setPreviewLoading(false)
      return
    }
    const ac = new AbortController()
    setPreviewLoading(true)
    const t = setTimeout(() => {
      getCompanionPartyPreview(code, ac.signal)
        .then(p => { setPreview(p) })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === 'AbortError') return
          // No party under that code is not an error here: the person may
          // still be typing the right one.
          setPreview(null)
        })
        .finally(() => { setPreviewLoading(false) })
    }, 300)
    return () => { ac.abort(); clearTimeout(t) }
  }, [code])

  // A complete code takes no more typing: a character typed into the middle
  // of one would push its last character out and send the caret to the end.
  // Refused before it happens, as the field's length limit used to; a paste
  // is not typing, and is cut after it has been cleaned (above).
  const fieldRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const el = fieldRef.current
    if (!el) return
    const refuseOverfill = (e: InputEvent) => {
      if (e.inputType === 'insertText' && el.value.length >= CODE_LEN && el.selectionStart === el.selectionEnd) e.preventDefault()
    }
    el.addEventListener('beforeinput', refuseOverfill)
    return () => el.removeEventListener('beforeinput', refuseOverfill)
  }, [])

  const attempt = useCallback(() => {
    if (!CODE_RE.test(code)) {
      setError({ text: 'Enter the full 6-character code.', aboutCode: true })
      return
    }
    if (!user) {
      setError({ text: 'Sign in to join the party.', aboutCode: false })
      return
    }
    setError(null)
    const res = onJoin(code)
    if (!res.ok) setError({ text: res.error ?? 'Could not join the party.', aboutCode: false })
  }, [code, user, onJoin])

  const canJoin = CODE_RE.test(code) && !!user
  const shown = error?.text || externalError || null
  // A party the server holds for a planned start is not live yet.
  const started = !!preview?.startedAt
  const here = typeof preview?.participantCount === 'number' ? preview.participantCount : null

  return (
    // The column scrolls inside the companion's fixed shell, so a small
    // phone with the sign-in form open can still reach its buttons.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.75rem)] pt-4">
      <CompanionHeader />

      <main className="flex flex-1 flex-col justify-center gap-6 py-6">
        <div>
          <h1 className="font-display text-[clamp(2.25rem,11vw,2.75rem)] font-extrabold leading-none tracking-[-0.02em] text-ink">Join the party</h1>
          <p className="mt-2 text-[17px] leading-snug text-ink-2">
            Enter the code from the big screen. Your phone becomes the chat and the reactions; the film stays on the TV.
          </p>
        </div>

        <form className="flex flex-col" onSubmit={e => { e.preventDefault(); attempt() }} noValidate>
          <label htmlFor={`${ids}-code`} className="text-[13px] font-semibold text-ink-2">Party code</label>
          <input
            ref={fieldRef}
            id={`${ids}-code`}
            value={code}
            onChange={e => { setError(null); setCode(normalize(e.target.value)) }}
            // Enter answers also when there is nothing to submit with (an
            // incomplete code disables Join; a signed-out phone has none):
            // it says what is missing.
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); attempt() } }}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="······"
            aria-invalid={error?.aboutCode === true}
            aria-describedby={shown !== null ? `${ids}-hint ${ids}-error` : `${ids}-hint`}
            className="party-code-field mt-1.5 w-full"
            autoFocus={!initialCode}
          />
          <p id={`${ids}-hint`} className="mt-2 text-[13px] leading-snug text-ink-2">
            6 letters and numbers. Or scan the QR code on the TV.
          </p>
          {user && (
            <button type="submit" disabled={!canJoin} className="stage-btn stage-btn-primary stage-btn-pill stage-btn-join mt-4 w-full">
              Join
            </button>
          )}
        </form>

        <p id={`${ids}-error`} role="alert" className={shown ? 'text-[14px] leading-snug text-danger-ink' : 'sr-only'}>{shown ?? ''}</p>

        {/* What is on in the party the code names. */}
        {previewLoading && !preview && (
          <div className="flex min-h-[72px] items-center gap-3 rounded-control bg-surface-raised px-4 py-3" aria-hidden="true">
            <div className="h-[60px] w-10 flex-none animate-pulse rounded-chip bg-surface-raised-2 motion-reduce:animate-none" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-32 animate-pulse rounded-chip bg-surface-raised-2 motion-reduce:animate-none" />
              <div className="h-2.5 w-20 animate-pulse rounded-chip bg-surface-raised-2 motion-reduce:animate-none" />
            </div>
          </div>
        )}
        {preview && (
          <div className="flex min-h-[72px] items-center gap-3 rounded-control bg-surface-raised px-4 py-3">
            <CompanionPoster poster={preview.mediaPoster} className="h-[60px] w-10 rounded-chip" />
            <p className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[15px] font-semibold leading-snug text-ink">
                {/* The mark of live presence, for a party that has started. */}
                {started && <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: 'var(--aurora)' }} />}
                <span className="min-w-0 truncate">
                  {started
                    ? (preview.partyName ? `${preview.partyName} is live` : 'This party is live')
                    : (preview.partyName ? `${preview.partyName} has not started` : 'This party has not started')}
                </span>
              </span>{' '}
              <span className="block truncate text-[13px] leading-snug text-ink-2">
                {preview.mediaTitle || 'Watch party'}
                {/* Everyone in the room, phones included: "here", not "watching". */}
                {started
                  ? (here !== null ? ` · ${here} here` : '')
                  : preview.scheduledStartAt ? `, ${plannedStartPhrase(preview.scheduledStartAt, new Date())}` : ''}
              </span>
            </p>
          </div>
        )}

        {!user && (
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Sign in to join</h2>
            <div className="mt-3">{signInSlot}</div>
          </div>
        )}
      </main>

      {user && (
        <footer className="flex items-center gap-2.5 text-[14px] text-ink-2">
          <PersonDisc name={user.username} colorKey={user.id} size={28} surface="var(--surface-page)" imageUrl={user.avatar_url} />
          <span className="min-w-0 flex-1 truncate">Joining as {user.username}</span>
        </footer>
      )}
    </div>
  )
}

/** When a party that has not started is planned for, for the middle of a
 *  sentence: "starts tonight at 8:00 PM", "starts tomorrow at 9:30 AM",
 *  "starts Fri, Aug 7 at 8:00 PM". Once the time has passed with the party
 *  still not started (its start failed, or nobody came) it does not go on
 *  saying "starts": "was planned for today at 6:00 PM". A time today is
 *  "tonight" only from five in the afternoon. */
export function plannedStartPhrase(iso: string, now: Date): string {
  const at = new Date(iso)
  const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const day = localDateKey(iso)
  const dayOf = (offsetDays: number) => localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, 12).toISOString())
  const past = at.getTime() <= now.getTime()
  const when = day === dayOf(0) ? (!past && at.getHours() >= 17 ? 'tonight' : 'today')
    : day === dayOf(1) ? 'tomorrow'
    : day === dayOf(-1) ? 'yesterday'
    : at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return `${past ? 'was planned for' : 'starts'} ${when} at ${clock}`
}

// The title's poster, small, on the join and room screens. Where there is
// none, a plain tile with a film mark. `onArt` is told the picture once it
// has loaded, for a caller that takes its colour from it.
export function CompanionPoster({ poster, className = '', onArt }: {
  poster?: string
  className?: string
  onArt?: (img: HTMLImageElement) => void
}) {
  const src = poster ? posterURL(poster, 'w185') : ''
  return (
    <div className={`relative grid flex-none place-items-center overflow-hidden bg-surface-raised-2 ${className}`} aria-hidden="true">
      {src
        ? (
          <img
            src={src}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            // Both: a picture from the cache is complete before a load
            // handler can be attached.
            ref={el => { if (el?.complete) onArt?.(el) }}
            onLoad={e => onArt?.(e.currentTarget)}
          />
        )
        : <Icon name="film" size={16} className="text-ink-3" />}
    </div>
  )
}
