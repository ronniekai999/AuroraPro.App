// Aurora V2 — CompanionApp (mobile "second screen" root)
//
// Top-level tree for the watch-party mobile companion. Reachable at the
// SPA routes /join and /join/:code (the integrator wires main.tsx to
// render this component there). Self-contained: it owns the auth gate,
// the join/room switch, and the useCompanion connection.
//
// AUTH (locked decision = Option A): an Aurora account is REQUIRED. We
// reuse the EXISTING JWT auth + the 5 existing OAuth providers. There is
// NO guest token / anonymous identity here. A friend without an account
// signs in once (one-tap OAuth or username/password) and is then a
// normal participant.
//
// Mobile-first + Aurora-branded: a full-viewport (100dvh) dark gradient
// shell, no desktop chrome, no video player. The phone opens ONLY the
// room socket (chat/voice/reactions) via useCompanion.

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
  CompanionBrand,
  COMPANION_OAUTH_PROVIDERS,
  useReducedMotion,
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
    // Fixed-viewport app shell: h-[100dvh] + overflow-hidden so the
    // CHAT region is the only scroll area (the page itself never
    // scrolls under the composer / safe-area). 100dvh tracks mobile
    // browser chrome better than 100vh.
    <div className="aurora-companion-shell flex h-[100dvh] flex-col overflow-hidden bg-[#050505] text-white">
      {/* Radial Aurora glow background, matching the mockup's screen bg. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            'radial-gradient(ellipse 90% 50% at 15% 8%, rgba(168,85,247,0.14) 0%, transparent 60%),' +
            'radial-gradient(ellipse 70% 40% at 90% 100%, rgba(107,33,168,0.14) 0%, transparent 55%),' +
            '#050505',
        }}
      />

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

// ── Boot splash while we verify the session on first load.
function BootSplash() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <CompanionBrand size="lg" />
      <p className="text-sm text-white/40">Loading…</p>
    </div>
  )
}

// ── Sign-in surface (Option A). One-tap OAuth for every enabled
// provider + a collapsible username/password form. No guest path.
//
// OAuth: navigates to the existing /api/auth/oauth/{provider}/start with
// ?join=CODE so the code survives the round-trip (the server's success
// page redirects back signed-in). Note: that server redirect currently
// lands at `/` (the desktop app) rather than /v2/join/CODE — see the
// integrationNotes about pointing the companion OAuth return at this
// route for a seamless mobile return. Username/password sign-in, by
// contrast, completes fully IN-PLACE here (no redirect) and is the
// zero-friction path on the phone.
function SignInSlot({
  setupStatus, joinCode, onLogin,
}: {
  setupStatus: SetupStatus | null
  joinCode?: string
  onLogin: (u: User) => void
}) {
  const reduced = useReducedMotion()
  const [pwOpen, setPwOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
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
    if (!username || !password) {
      setError('Enter your username and password.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const u = await apiLogin(username, password)
      onLogin(u)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setSubmitting(false)
    }
  }, [username, password, onLogin])

  return (
    <div className="space-y-2.5">
      {/* OAuth one-tap buttons */}
      {enabledProviders.map(p => {
        const meta = COMPANION_OAUTH_PROVIDERS[p]
        return (
          <a
            key={p}
            href={companionOAuthStartUrl(p, joinCode)}
            className={[
              'flex w-full items-center justify-center gap-3 rounded-2xl py-3 font-medium transition-all',
              reduced ? '' : 'hover:scale-[1.01]',
              meta.className,
            ].join(' ')}
          >
            {meta.icon}
            Continue with {meta.label}
          </a>
        )
      })}

      {/* Password sign-in (collapsible) */}
      {!pwOpen ? (
        <button
          type="button"
          onClick={() => setPwOpen(true)}
          className="w-full rounded-2xl border border-[var(--glow-border)] bg-white/[0.05] py-3 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08]"
        >
          Sign in with username
        </button>
      ) : (
        <div className="space-y-2.5 rounded-2xl border border-[var(--glow-border)] bg-white/[0.03] p-3">
          <input
            type="text"
            value={username}
            onChange={e => { setError(null); setUsername(e.target.value) }}
            placeholder="Username"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="username"
            aria-label="Username"
            disabled={submitting}
            className="w-full rounded-xl border border-[var(--glow-border)] bg-white/[0.04] px-3.5 py-2.5 text-sm text-white placeholder:text-white/40 focus:border-purple-500/40 focus:outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={e => { setError(null); setPassword(e.target.value) }}
            onKeyDown={e => { if (e.key === 'Enter') void submitPassword() }}
            placeholder="Password"
            autoComplete="current-password"
            aria-label="Password"
            disabled={submitting}
            className="w-full rounded-xl border border-[var(--glow-border)] bg-white/[0.04] px-3.5 py-2.5 text-sm text-white placeholder:text-white/40 focus:border-purple-500/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void submitPassword()}
            disabled={submitting}
            className="w-full rounded-xl bg-gradient-to-br from-purple-500 to-purple-800 py-2.5 text-sm font-semibold text-white shadow-[0_8px_26px_rgba(168,85,247,0.4)] disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      )}

      {error && <p className="text-center text-sm text-red-300">{error}</p>}

      <p className="px-2 pt-1 text-center text-[11px] leading-snug text-white/35">
        An Aurora account is required to join. No account? One tap with any provider above creates one.
      </p>
    </div>
  )
}
