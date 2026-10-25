// Aurora V2 — Companion JoinScreen
//
// The phone "second screen" entry surface. Matches
// the phone companion join flow:
//   - Aurora-branded logo + "Join the party" heading
//   - Big OTP-style 6-box code entry (validates ^[A-Z0-9]{6}$)
//   - "Scan the QR on the TV instead" hint
//   - Live now-playing preview via GET /api/code/{code}/info
//   - Sign-in affordance (rendered by CompanionApp when unauthenticated)
//
// Stateless w.r.t. auth/join: it raises the entered code to the parent
// (CompanionApp) which owns the auth gate + useCompanion.join.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getCompanionPartyPreview,
  posterURL,
  type CompanionPartyPreview,
  type User,
} from '@/lib/api'
import { CompanionBrand, AURORA_REDUCED_MOTION } from './companionUi'

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
  // Code is held as a normalized string; the 6 boxes are a presentation
  // of its characters. A single hidden input owns focus + native mobile
  // keyboard (numeric-capable, autocapitalized) so paste + autofill of
  // an SMS'd code Just Works.
  const [code, setCode] = useState<string>((initialCode ?? '').slice(0, CODE_LEN))
  const [error, setError] = useState<string | null>(null)
  // Track focus in state (not document.activeElement at render time) so
  // the blinking-cursor box highlight updates reactively + render stays
  // pure.
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Live preview state. null = unknown/none; a value = a live party.
  const [preview, setPreview] = useState<CompanionPartyPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const normalize = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN)

  // Debounced preview lookup whenever a full 6-char code is present.
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
          // A 404 / non-active code just means "no live preview" — not a
          // hard error here (the user may still be typing the right one).
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

  const chars = code.padEnd(CODE_LEN, '').split('')
  const focusedIndex = Math.min(code.length, CODE_LEN - 1)
  const canJoin = CODE_RE.test(code) && !!user

  return (
    // Scrollable within the fixed app shell so a small phone with the
    // sign-in form expanded can still reach the buttons.
    <div className="flex flex-1 flex-col min-h-0 overflow-y-auto px-6 pt-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
      <CompanionBrand size="lg" className="mx-auto mt-4 mb-5" />

      <h1 className="font-display text-2xl font-bold text-center text-white">Join the party</h1>
      {preview?.partyName || preview?.mediaTitle ? (
        <p className="text-center text-sm text-white/50 mt-1.5">
          {preview.partyName ? `${preview.partyName}` : 'A watch party is live'}
        </p>
      ) : (
        <p className="text-center text-sm text-white/50 mt-1.5">Enter the code from the big screen</p>
      )}

      {/* ── OTP 6-box code entry ───────────────────────────────────── */}
      <div className="mt-7">
        <p className="text-center text-[11px] uppercase tracking-[0.14em] text-white/50 mb-3">
          Enter the 6-character code
        </p>
        {/* The visible boxes are a presentation of the code; the real
            input is a full-size transparent overlay on top (inset-0), so
            a tap anywhere on the boxes lands on — and focuses — the
            input natively. The boxes are aria-hidden since the input
            carries the accessible name + keyboard. No div-level click
            handler needed (avoids a11y static-interaction lint + invalid
            interactive nesting). */}
        <div className="relative mx-auto block w-full max-w-[20rem]">
          <div className="flex justify-center gap-2.5" aria-hidden="true">
            {chars.map((ch, i) => {
              const filled = ch !== ''
              const isCursor = i === focusedIndex && focused
              return (
                <div
                  key={i}
                  className={[
                    'flex h-[3.25rem] w-10 items-center justify-center rounded-xl border font-display text-2xl font-semibold',
                    'transition-colors',
                    filled
                      ? 'border-purple-500/60 bg-purple-500/10 text-white shadow-[0_0_0_3px_rgba(168,85,247,0.12)]'
                      : 'border-[var(--glow-border)] bg-white/[0.04] text-white/30',
                    // `isCursor`, WITHOUT the `&& !filled` this shipped with.
                    // The real input is opacity-0, so these boxes are the only
                    // focus indication there is — and `focusedIndex` is
                    // `min(code.length, CODE_LEN - 1)`, so with all six characters
                    // entered it points at the LAST box, which is filled. The
                    // branch could therefore never fire in exactly the state a
                    // user is in when they tab away to check the code and tab back:
                    // filled boxes rendered identically focused and unfocused, with
                    // Enter as the submit action (WCAG 2.4.7).
                    isCursor
                      ? 'border-purple-400/80 shadow-[0_0_0_3px_rgba(168,85,247,0.18),0_0_18px_rgba(168,85,247,0.3)]'
                      : '',
                  ].join(' ')}
                >
                  {ch || '·'}
                </div>
              )
            })}
          </div>
          {/* Real input — visually hidden but focusable + keyboard-backed.
              inputMode/pattern hint mobile keyboards; autoCapitalize
              "characters" so typed letters match the A-Z alphabet. */}
          <input
            ref={inputRef}
            value={code}
            onChange={e => { setError(null); setCode(normalize(e.target.value)) }}
            onKeyDown={e => { if (e.key === 'Enter') attempt() }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            maxLength={CODE_LEN}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="one-time-code"
            spellCheck={false}
            aria-label="Party code"
            // Sits over the boxes (transparent) so taps land on the
            // input on mobile; text is transparent + caret hidden since
            // the boxes are the visible presentation.
            className="absolute inset-0 h-full w-full cursor-pointer bg-transparent text-center text-transparent caret-transparent opacity-0 focus:outline-none"
            autoFocus={!initialCode}
          />
        </div>

        {/* QR hint */}
        <div className="mt-3.5 text-center">
          <span className="inline-flex items-center gap-2 text-sm text-white/55">
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
              <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm13-2h3v2h-3v-2zm0 4h3v4h-2v-2h-1v-2zm-5-4h2v5h-2v-5z" />
            </svg>
            Scan the QR on the TV instead
          </span>
        </div>
      </div>

      {/* ── Live now-playing preview ───────────────────────────────── */}
      <div className="mt-6 min-h-[5.25rem]">
        {previewLoading && !preview && (
          <div className="glass-panel flex items-center gap-3 rounded-2xl p-3" aria-hidden="true">
            <div className="h-[68px] w-[46px] flex-shrink-0 animate-pulse motion-reduce:animate-none rounded-lg bg-white/[0.06]" />
            <div className="flex-1 space-y-2">
              <div className="h-2.5 w-20 animate-pulse motion-reduce:animate-none rounded bg-white/[0.06]" />
              <div className="h-3 w-32 animate-pulse motion-reduce:animate-none rounded bg-white/[0.08]" />
              <div className="h-2.5 w-16 animate-pulse motion-reduce:animate-none rounded bg-white/[0.06]" />
            </div>
          </div>
        )}
        {preview && (
          <div className="glass-panel flex items-center gap-3 rounded-2xl p-3">
            <CompanionPoster poster={preview.mediaPoster} className="h-[68px] w-[46px] rounded-lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] text-white/50">
                {preview.partyName ? `${preview.partyName} · now playing` : 'Now playing'}
              </p>
              <p className="truncate text-sm font-semibold text-white">
                {preview.mediaTitle || 'Watch party'}
              </p>
              {typeof preview.participantCount === 'number' && (
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
                  {preview.participantCount} watching
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {(error || externalError) && (
        <p className="mt-3 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-center text-sm text-red-300">
          {error || externalError}
        </p>
      )}

      {/* ── Action / sign-in ───────────────────────────────────────── */}
      <div className="mt-auto pt-5">
        {user ? (
          <button
            type="button"
            disabled={!canJoin}
            onClick={attempt}
            className={[
              'w-full rounded-2xl py-3.5 font-semibold text-white transition-ui',
              AURORA_REDUCED_MOTION ? '' : 'motion-safe:hover:scale-[1.01]',
              'bg-gradient-to-br from-purple-500 to-purple-800 shadow-[0_8px_26px_rgba(168,85,247,0.4)]',
              'disabled:opacity-40 motion-safe:disabled:hover:scale-100 disabled:cursor-not-allowed',
            ].join(' ')}
          >
            Join the party
          </button>
        ) : (
          <div>
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-white/50">
              <span className="h-px flex-1 bg-[var(--glow-border)]" />
              sign in to join
              <span className="h-px flex-1 bg-[var(--glow-border)]" />
            </div>
            <div className="mt-4">{signInSlot}</div>
          </div>
        )}
      </div>
    </div>
  )
}

// Small poster tile shared by the join + room surfaces. Falls back to
// the Aurora gradient placeholder when no poster path is available
// (mirrors the mockup's gradient poster).
export function CompanionPoster({ poster, className = '' }: { poster?: string; className?: string }) {
  const src = poster ? posterURL(poster, 'w185') : ''
  return (
    <div
      className={`relative flex-shrink-0 overflow-hidden bg-gradient-to-br from-[#3b2a5c] to-[#16121f] shadow-[0_6px_18px_rgba(0,0,0,0.5)] ${className}`}
      aria-hidden="true"
    >
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(216,180,254,0.5),transparent_60%)]" />
      )}
    </div>
  )
}
