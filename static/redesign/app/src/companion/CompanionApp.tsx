// The phone companion's root: the "second screen" of a watch party, at
// /join and /join/:code. It owns the session check, the sign-in, the switch
// between the join screen and the room, and the companion's connection.
//
// An Aurora account is required: the app's own sign-in and the sign-in
// providers the server has on. There is no guest identity. Someone without
// an account signs in once and is then a participant like any other.
//
// A phone screen with none of the app's chrome and no player: the phone
// opens the room socket only (chat, voice, reactions), through useCompanion.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  fetchMe,
  getSetupStatus,
  getStoredUser,
  login as apiLogin,
  companionOAuthStartUrl,
  type SetupStatus,
  type User,
} from '@/lib/api'
import { useCompanion } from '@/hooks/useCompanion'
import { JoinScreen } from './JoinScreen'
import { CompanionRoom } from './CompanionRoom'
import {
  CompanionHeader,
  COMPANION_OAUTH_PROVIDERS,
  type CompanionOAuthProvider,
} from './companionUi'

const CODE_RE = /^[A-Z0-9]{6}$/

export function CompanionApp() {
  const navigate = useNavigate()
  // Route param from /join/:code. Normalized to the 6-char alphabet;
  // anything malformed is treated as "no code" (blank join screen).
  const params = useParams()
  const routeCode = useMemo(() => {
    const raw = (params.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    return CODE_RE.test(raw) ? raw : ''
  }, [params.code])

  // ── Auth state. getStoredUser() gives an optimistic cached user for
  // first paint; fetchMe() verifies the session (httpOnly cookie) and
  // corrects/clears it. While verifying we still let a cached user
  // through so a returning guest isn't flashed the sign-in screen.
  const [user, setUser] = useState<User | null>(() => getStoredUser())
  const [authChecked, setAuthChecked] = useState(false)
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    fetchMe(ac.signal)
      .then(u => setUser(u))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        // No valid session — drop any stale cached user so the gate
        // shows sign-in rather than a phantom logged-in state.
        setUser(null)
      })
      .finally(() => setAuthChecked(true))
    void getSetupStatus(ac.signal).then(setSetupStatus).catch(() => { /* non-fatal */ })
    return () => ac.abort()
  }, [])

  const companion = useCompanion()
  const { join } = companion

  // Auto-join once we have BOTH a route code AND an authenticated user
  // and we're idle. This covers the QR / deep-link path: scan → land on
  // /join/CODE → (sign in if needed) → connect automatically. We guard
  // with a ref so a re-render storm can't fire join twice.
  const autoJoinedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!user || !routeCode) return
    if (companion.state.status !== 'idle') return
    if (autoJoinedRef.current === routeCode) return
    autoJoinedRef.current = routeCode
    join(routeCode)
  }, [user, routeCode, companion.state.status, join])

  // Manual join from the JoinScreen — keep the URL in sync so a refresh
  // or share reflects the joined code, then connect.
  const handleJoin = useCallback((code: string) => {
    const c = code.trim().toUpperCase()
    const res = join(c)
    if (res.ok && c !== routeCode) {
      // Update the deep-link without a full navigation remount.
      navigate(`/join/${c}`, { replace: true })
    }
    return res
  }, [join, navigate, routeCode])

  const handleLeave = useCallback(() => {
    companion.leave()
    autoJoinedRef.current = null
    navigate('/join', { replace: true })
  }, [companion, navigate])

  const onLogin = useCallback((u: User) => setUser(u), [])

  // ── Render. The shell is a fixed-height mobile column with the Aurora
  // gradient background. Three states: booting auth, active room,
  // join/sign-in. Gating on `user` ensures an invalidated session
  // (stale cached user cleared by fetchMe mid-connection) can never
  // leave the room view up without an identity.
  const inRoom = !!user && (
    companion.state.status === 'connected' ||
    companion.state.status === 'reconnecting' ||
    companion.state.status === 'joining'
  )

  return (
    // A fixed-height shell (100dvh, which follows a phone browser's own bars
    // better than 100vh) that does not scroll: in the room the chat is the
    // one thing that does, and the composer stays above the keyboard.
    <div className="aurora-companion-shell flex h-[100dvh] flex-col overflow-hidden bg-surface-page text-ink">
      {!authChecked && !user ? (
        <BootSplash />
      ) : inRoom ? (
        <CompanionRoom
          state={companion.state}
          voice={companion.voice}
          currentUserId={user?.id ?? -1}
          sendChat={companion.sendChat}
          sendReaction={companion.sendReaction}
          joinVoice={companion.joinVoice}
          toggleMute={companion.toggleMute}
          leaveVoice={companion.leaveVoice}
          onLeave={handleLeave}
        />
      ) : (
        <JoinScreen
          initialCode={routeCode || undefined}
          user={user}
          externalError={
            // Surface a fatal companion error (e.g. host ended the party,
            // connection lost) on the join screen after a bounce-back.
            companion.state.status === 'error' ? companion.state.error : null
          }
          onJoin={handleJoin}
          signInSlot={
            <SignInSlot
              setupStatus={setupStatus}
              joinCode={routeCode || undefined}
              onLogin={onLogin}
            />
          }
        />
      )}
    </div>
  )
}

// While the session is checked on first load.
function BootSplash() {
  return (
    <div className="flex flex-1 flex-col px-4 pt-4">
      <CompanionHeader />
      <p role="status" className="m-auto text-[15px] text-ink-2">Loading…</p>
    </div>
  )
}

// The sign-in: one button for each provider the server has on, and a
// username and password form behind one press. There is no guest path.
//
// A provider's button goes to /api/auth/oauth/{provider}/start with
// ?join=CODE, so the code survives the round trip. The server's return
// from that currently lands on the app at `/`, not back on /v2/join/CODE.
// A username and password sign-in completes here, with no redirect.
function SignInSlot({
  setupStatus, joinCode, onLogin,
}: {
  setupStatus: SetupStatus | null
  joinCode?: string
  onLogin: (u: User) => void
}) {
  const [pwOpen, setPwOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Set as a sign-in is sent, not at the next render: two presses in one
  // moment must not both pass.
  const sending = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const enabledProviders = useMemo<CompanionOAuthProvider[]>(() => {
    if (!setupStatus) return []
    const out: CompanionOAuthProvider[] = []
    if (setupStatus.oauth_google_enabled) out.push('google')
    if (setupStatus.oauth_discord_enabled) out.push('discord')
    if (setupStatus.oauth_twitch_enabled) out.push('twitch')
    if (setupStatus.oauth_facebook_enabled) out.push('facebook')
    if (setupStatus.oauth_twitter_enabled) out.push('twitter')
    return out
  }, [setupStatus])

  const submitPassword = useCallback(async () => {
    // The fields and the button stay focusable while a sign-in is out, so a
    // second press is refused here.
    if (sending.current) return
    if (!username || !password) {
      setError('Enter your username and password.')
      return
    }
    sending.current = true
    setSubmitting(true)
    setError(null)
    try {
      const u = await apiLogin(username, password)
      onLogin(u)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      sending.current = false
      setSubmitting(false)
    }
  }, [username, password, onLogin])

  return (
    <div className="grid gap-2.5">
      {/* One button for each provider the server has on, in the provider's
          own colours: they are its mark, not the app's. */}
      {enabledProviders.map(p => {
        const meta = COMPANION_OAUTH_PROVIDERS[p]
        return (
          <a
            key={p}
            href={companionOAuthStartUrl(p, joinCode)}
            className={`flex h-12 w-full items-center justify-center gap-3 rounded-control text-[15px] font-semibold transition-colors ${meta.className}`}
          >
            {meta.icon}
            Continue with {meta.label}
          </a>
        )
      })}

      {/* Username and password, behind one press. */}
      {!pwOpen ? (
        <button type="button" onClick={() => setPwOpen(true)} className="stage-btn stage-btn-ghost w-full">
          Sign in with username
        </button>
      ) : (
        <form
          className="grid gap-2.5 rounded-control bg-surface-raised p-3"
          onSubmit={e => { e.preventDefault(); void submitPassword() }}
          noValidate
        >
          {/* Read-only, not disabled, while the sign-in is out: a disabled
              field drops the focus it holds. */}
          <input
            type="text"
            value={username}
            onChange={e => { setError(null); setUsername(e.target.value) }}
            placeholder="Username"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="username"
            aria-label="Username"
            // The button that opened the form is gone; the focus it held
            // goes to the first thing to fill in.
            autoFocus
            readOnly={submitting}
            className="companion-field w-full"
          />
          <input
            type="password"
            value={password}
            onChange={e => { setError(null); setPassword(e.target.value) }}
            placeholder="Password"
            autoComplete="current-password"
            aria-label="Password"
            readOnly={submitting}
            className="companion-field w-full"
          />
          {/* Above the button, so that a refusal is in sight wherever the
              button that was pressed is. */}
          <p role="alert" className={error ? 'text-[14px] leading-snug text-danger-ink' : 'sr-only'}>{error ?? ''}</p>
          <button type="submit" aria-disabled={submitting} className="stage-btn stage-btn-primary w-full">
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}

      <p className="text-[13px] leading-snug text-ink-2">
        An Aurora account is required to join. No account? One tap with any provider above creates one.
      </p>
    </div>
  )
}
