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

import { useCallback, useEffect, useId, useState } from 'react'
import {
  getCompanionPartyPreview,
  posterURL,
  type CompanionPartyPreview,
  type User,
} from '@/lib/api'
import { Icon } from '@/components/Icon'
import { PersonDisc } from '@/components/PersonDisc'
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
  const [error, setError] = useState<string | null>(null)

  // What is playing in the party the code names. null = none, or not known.
  const [preview, setPreview] = useState<CompanionPartyPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const normalize = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN)

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

  const attempt = useCallback(() => {
    if (!CODE_RE.test(code)) {
      setError('Enter the full 6-character code.')
      return
    }
    if (!user) {
      setError('Sign in to join the party.')
      return
    }
    setError(null)
    const res = onJoin(code)
    if (!res.ok) setError(res.error ?? 'Could not join the party.')
  }, [code, user, onJoin])

  const canJoin = CODE_RE.test(code) && !!user
  const shown = error || externalError || null

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
            id={`${ids}-code`}
            value={code}
            onChange={e => { setError(null); setCode(normalize(e.target.value)) }}
            // Enter answers also when there is nothing to submit with (an
            // incomplete code disables Join; a signed-out phone has none):
            // it says what is missing.
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); attempt() } }}
            maxLength={CODE_LEN}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="······"
            aria-invalid={error !== null}
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
                {/* The mark of live presence. */}
                <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: 'var(--aurora)' }} />
                <span className="min-w-0 truncate">{preview.partyName ? `${preview.partyName} is live` : 'This party is live'}</span>
              </span>{' '}
              <span className="block truncate text-[13px] leading-snug text-ink-2">
                {preview.mediaTitle || 'Watch party'}
                {typeof preview.participantCount === 'number' && ` · ${preview.participantCount} watching`}
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

// The title's poster, small, on the join and room screens. Where there is
// none, a plain tile with a film mark.
export function CompanionPoster({ poster, className = '' }: { poster?: string; className?: string }) {
  const src = poster ? posterURL(poster, 'w185') : ''
  return (
    <div className={`relative grid flex-none place-items-center overflow-hidden bg-surface-raised-2 ${className}`} aria-hidden="true">
      {src
        ? <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
        : <Icon name="film" size={16} className="text-ink-3" />}
    </div>
  )
}
