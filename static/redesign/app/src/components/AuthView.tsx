// The signed-out pages: sign in, and create an account.
//
// Two pages, one component, because they share their state (the fields
// carry over when the viewer goes from one to the other) and the server's
// answer about how this server is set up (`/api/auth/setup-status`: whether
// it has any account yet, and which sign-in providers are on).
//
// What that route does NOT say, so neither page draws it:
//   - the server's or its owner's name ("your media server", not a name);
//   - whether an invite code is valid (the code is checked when the account
//     is made, and a refusal is said then);
//   - anything of the library. A signed-out visitor is shown no poster: the
//     wall beside the sign-in form is a wall of empty frames.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { AuroraWordmark } from '@/components/AuroraWordmark'
import { AuroraMark } from '@/components/TopNav'
import { Icon } from '@/components/Icon'
import { RestoreRecordNote } from '@/components/RestoreRecordNote'
import { Spinner } from '@/components/ui/spinner'
import { APIError, getSetupStatus, login as apiLogin, register, type SetupStatus, type User as ApiUser } from '@/lib/api'
import { rememberDeviceIntent, rememberDevicePairing } from '@/lib/devicePairing'
import { useRestoreRecord } from '@/hooks/useRestoreRecord'
import { OAUTH_SIGN_IN_PROVIDERS, type OAuthProvider } from '@/lib/oauth'

/** A field of the two forms, by the end of its id (`auth-<field>`). */
export type AuthField = 'invite' | 'username' | 'email' | 'password'
/** What the page says of a refusal, and the field it is about, if any. */
export interface Refusal { says: string; field: AuthField | null }

// What the page says when the server refuses a sign-in or a new account.
//
// The server's own answers (internal/api/auth_handlers.go), each a whole
// sentence with the status it comes with, and the page's words for it. A
// sentence is matched whole and with its status, never by a word inside
// it: matched on "password", the server's "failed to hash password" (a 500)
// told its viewer that a password needs 8 to 128 characters. Anything not
// on the list, and every 5xx, gets a line that is about no field: it says
// the thing could not be done just now. A server message is never shown as
// it came, so an endpoint that leaked a stack trace or a schema detail
// would not have it put on screen here.
const ANSWERS: readonly (readonly [status: number, sentence: string, says: string, field: AuthField])[] = [
  [401, 'invalid credentials', 'That username and password do not match.', 'username'],
  [400, 'username and password required', 'Enter a username and a password.', 'username'],
  [400, 'username, email, and password required', 'Enter a username, an email address and a password.', 'username'],
  [400, 'invalid email format', 'That email address does not look right.', 'email'],
  [400, 'username must be 3-50 characters', 'A username needs 3 to 50 characters.', 'username'],
  [400, 'username may only contain letters, numbers, underscores, and hyphens', 'A username can have letters, numbers, underscores and hyphens.', 'username'],
  [400, 'password must be at least 8 characters', 'A password needs 8 to 128 characters.', 'password'],
  [400, 'password must be at most 128 characters', 'A password needs 8 to 128 characters.', 'password'],
  // The server does not say which of the two.
  [409, 'that username or email is unavailable', 'That username or email is already in use.', 'username'],
  // Reached only when the page drew no invite field (it could not read how
  // the server is set up): the field is drawn then, and asked for.
  [400, 'invite code required', 'Enter the invite code from this server’s admin.', 'invite'],
  [400, 'invalid or expired invite code', 'That invite code was not accepted. Check it with the server’s admin.', 'invite'],
]
/** `making`: the refusal is of a new account, not of a sign-in. */
export function refusalSays(err: unknown, making: boolean): Refusal {
  const notNow = making
    ? 'The account could not be created just now. Try again in a moment.'
    : 'Could not sign in just now. Try again in a moment.'
  if (err instanceof APIError) {
    // The rate limiter, whatever its words.
    if (err.status === 429) return { says: 'Too many tries. Wait a moment and try again.', field: null }
    for (const [status, sentence, says, field] of ANSWERS) {
      if (err.status === status && err.message === sentence) return { says, field }
    }
    return { says: notNow, field: null }
  }
  // fetch's own failure: the request got no answer at all.
  if (err instanceof TypeError) return { says: 'The server could not be reached. Check your connection and try again.', field: null }
  return { says: notNow, field: null }
}

/** The brand: the mark and the drawn wordmark. In a bar they are the size
 *  the top bar and the onboarding flow's bar draw them at (28px and 15px),
 *  so the brand does not change size from the page that makes an account to
 *  the setup that follows it. */
function Brand({ size }: { size: 'page' | 'bar' }) {
  return (
    <div className="auth-brand">
      <AuroraMark size={size === 'page' ? 36 : 28} />
      <AuroraWordmark ink="var(--ink)" className={size === 'page' ? 'h-[20px] w-auto' : 'h-[15px] w-auto'} />
    </div>
  )
}

// A sign-in provider. A link, not a button with a redirect: the browser
// follows it to the provider and back, and there is no state here to keep.
// The invite code typed on the register page rides along (`?invite=`), so
// the server can claim it as the account is made.
function ProviderLink({ provider, label, inviteCode, disabled, pairing }: {
  provider: OAuthProvider
  label: string
  inviteCode: string
  disabled: boolean
  /** The page was opened to connect a TV. */
  pairing: boolean
}) {
  const params = new URLSearchParams()
  if (inviteCode.trim()) params.set('invite', inviteCode.trim())
  const qs = params.toString()
  const href = `/api/auth/oauth/${provider}/start${qs ? '?' + qs : ''}`
  return (
    <a
      href={disabled ? undefined : href}
      // aria-disabled rather than only dropping href: without it the element
      // loses its `link` role while a sign-in is out, and goes from the
      // accessibility tree instead of reading as unavailable.
      aria-disabled={disabled || undefined}
      onClick={e => {
        if (disabled) { e.preventDefault(); return }
        // A TV's code in the address is carried through the round trip,
        // and so is having come here to connect one: the provider's way
        // back is to the front page, and the page said "Its code comes
        // next."
        rememberDevicePairing(window.location.pathname, window.location.search)
        if (pairing) rememberDeviceIntent()
      }}
      className="auth-provider"
      data-provider={provider}
    >
      Continue with {label}
    </a>
  )
}

export default function AuthView({ onLogin }: { onLogin: (user: ApiUser) => void }) {
  const [isRegister, setIsRegister] = useState(false)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<Refusal | null>(null)
  // The server asked for an invite code the page had not drawn a field for
  // (it could not read how the server is set up).
  const [inviteAsked, setInviteAsked] = useState(false)
  // On a fresh install (no account in the database) the first person to
  // register becomes the admin and needs no invite code.
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  // A database restore this browser started: while its transaction runs the
  // server's session checks wait on it (and can fail after a minute), and
  // one that succeeds ends every sign-in, so the admin who started it can
  // land here, the one page that can still say how it went (by its ticket;
  // hooks/useRestoreRecord).
  const restoreRecord = useRestoreRecord({})
  useEffect(() => {
    let cancelled = false
    void getSetupStatus().then(s => { if (!cancelled) setSetupStatus(s) }).catch(() => { /* the pages work without it */ })
    return () => { cancelled = true }
  }, [])
  const firstRun = !!setupStatus && !setupStatus.has_users
  // Nobody can sign in to a server with no account: it opens on the form
  // that makes the first one.
  useEffect(() => {
    if (firstRun) setIsRegister(true)
  }, [firstRun])
  const inviteRequired = !!setupStatus?.has_users || inviteAsked
  const providers = OAUTH_SIGN_IN_PROVIDERS.filter(p => setupStatus?.[p.flag])
  // Opened on the page that pairs a TV (its code is in the address, or the
  // viewer followed "Connect a TV with a code"): signing in is the first
  // step of that, and the page says so.
  const { pathname } = useLocation()
  const pairing = pathname === '/device'

  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setError(null)
    // What the server would refuse for, said before it is asked. (It needs
    // an email address for a new account; the old form sent none and showed
    // its refusal as a complaint about the username.)
    if (isRegister && inviteRequired && !inviteCode.trim()) {
      setError({ says: 'Enter the invite code from this server’s admin.', field: 'invite' })
      return
    }
    const missing: AuthField | null = !username ? 'username' : isRegister && !email.trim() ? 'email' : !password ? 'password' : null
    if (missing) {
      setError({ says: isRegister ? 'Enter a username, an email address and a password.' : 'Enter a username and a password.', field: missing })
      return
    }
    setSubmitting(true)
    try {
      if (isRegister) {
        const t = await register({ username, email, password, invite_code: inviteCode })
        onLogin(t.user)
      } else {
        onLogin(await apiLogin(username, password))
      }
    } catch (err) {
      const refusal = refusalSays(err, isRegister)
      if (refusal.field === 'invite') setInviteAsked(true)
      setError(refusal)
    } finally {
      setSubmitting(false)
    }
  }, [isRegister, username, email, password, inviteCode, inviteRequired, onLogin])
  // A refusal puts the focus in the field it is about, or in the form's
  // first field. The fields and the button are disabled while the server is
  // asked, which drops the focus to the page, and nothing put it back: a
  // keyboard's next Tab started from the top of the document.
  useEffect(() => {
    if (!error || submitting) return
    const first: AuthField = isRegister && inviteRequired ? 'invite' : 'username'
    document.getElementById(`auth-${error.field ?? first}`)?.focus()
    // Only when a refusal arrives: `error` is a new object each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, submitting])

  // Going from one page to the other takes the pressed button away with the
  // page it was on: the focus goes to the new page's heading.
  const swapped = useRef(false)
  const swap = (to: boolean) => { swapped.current = true; setIsRegister(to); setError(null) }
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!swapped.current) return
    swapped.current = false
    heading.current?.focus()
  }, [isRegister])
  const errorLine = error && <p role="alert" className="auth-error"><Icon name="alertTriangle" size={16} className="mt-0.5 flex-none" />{error.says}</p>
  const orProviders = (label: string, row: boolean) => providers.length > 0 && (
    <>
      <div className="auth-or" aria-hidden="true"><span />{label}<span /></div>
      {/* role=group: the divider above is not read, so the links' own
          names ("Continue with …") carry what they are. */}
      <div className={row ? 'auth-providers is-row' : 'auth-providers'} role="group" aria-label={isRegister ? 'Other ways to create an account' : 'Other ways to sign in'}>
        {providers.map(p => (
          <ProviderLink key={p.provider} provider={p.provider} label={p.label} inviteCode={isRegister ? inviteCode : ''} disabled={submitting} pairing={pairing} />
        ))}
      </div>
    </>
  )

  if (isRegister) {
    return (
      <div className="auth-page is-register" data-auth="register">
        <header className="auth-bar">
          <Brand size="bar" />
          {/* No account exists on a first run: there is nothing to sign in to. */}
          {!firstRun && (
            <p className="auth-bar-aside">
              Have an account?{' '}
              <button type="button" className="auth-link" onClick={() => swap(false)}>Sign in</button>
            </p>
          )}
        </header>
        <main className="auth-main">
          <form onSubmit={handleSubmit} className="auth-form is-wide" noValidate>
            <div className="auth-head">
              <h1 className="auth-title" ref={heading} tabIndex={-1}>{firstRun ? 'Set up this server' : 'Create an account'}</h1>
              <p className="auth-lead">
                {firstRun
                  ? 'Nobody has an account here yet. The one you make now becomes the server’s admin.'
                  : inviteRequired
                    // "With a password", not a flat "this server is
                    // invite-only": an admin can let a provider below in
                    // without a code, and the route does not say which
                    // here.
                    ? 'This server is private. Signing up with a password needs an invite code from its admin.'
                    : 'Choose a username and a password.'}
              </p>
            </div>
            <RestoreRecordNote record={restoreRecord} />
            {inviteRequired && (
              <div className="auth-field">
                <label htmlFor="auth-invite">Invite code</label>
                <input
                  id="auth-invite"
                  type="text"
                  className="auth-input auth-code"
                  value={inviteCode}
                  onChange={e => setInviteCode(e.target.value.toUpperCase())}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={submitting}
                />
              </div>
            )}
            <div className="auth-pair">
              <div className="auth-field">
                <label htmlFor="auth-username">Username</label>
                <input id="auth-username" type="text" className="auth-input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={submitting} />
              </div>
              <div className="auth-field">
                <label htmlFor="auth-email">Email</label>
                <input id="auth-email" type="email" className="auth-input" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" disabled={submitting} />
              </div>
            </div>
            <div className="auth-field">
              <label htmlFor="auth-password">Password</label>
              <input id="auth-password" type="password" className="auth-input" placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" disabled={submitting} />
            </div>
            {errorLine}
            <button type="submit" disabled={submitting} className="auth-submit">
              {submitting ? <><Spinner className="size-4" />Creating the account…</> : 'Create account'}
            </button>
            {orProviders('or, without a password', true)}
          </form>
        </main>
      </div>
    )
  }

  return (
    <div className="auth-page is-signin" data-auth="signin">
      {/* Beside the form on a wide screen: a wall of frames with the house
          lights down. Empty frames: nobody signed out is shown what the
          library holds. */}
      <div className="auth-wall">
        <div className="auth-wall-frames" aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => <span key={i} />)}
        </div>
        <div className="auth-wall-fade" aria-hidden="true" />
        <p className="auth-wall-line">Lights down. Your library is ready.</p>
      </div>
      <main className="auth-main">
        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <Brand size="page" />
          <div className="auth-head">
            <h1 className="auth-title" ref={heading} tabIndex={-1}>Welcome back</h1>
            <p className="auth-lead">
              {pairing ? 'Sign in to connect your TV. Its code comes next.' : 'Sign in to your media server.'}
            </p>
          </div>
          <RestoreRecordNote record={restoreRecord} />
          <div className="auth-field">
            <label htmlFor="auth-username">Username</label>
            <input id="auth-username" type="text" className="auth-input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={submitting} />
          </div>
          <div className="auth-field">
            <label htmlFor="auth-password">Password</label>
            <input id="auth-password" type="password" className="auth-input" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" disabled={submitting} />
          </div>
          {errorLine}
          <button type="submit" disabled={submitting} className="auth-submit">
            {submitting ? <><Spinner className="size-4" />Signing in…</> : 'Sign in'}
          </button>
          {orProviders('or', false)}
          <p className="auth-foot">
            <span>New here? <button type="button" className="auth-link" onClick={() => swap(true)}>Create an account</button></span>
            {/* The page that pairs a TV asks for a sign-in first: this goes
                there, and the line above then says what the sign-in is for.
                Not offered where the viewer already is. */}
            {!pairing && <Link to="/device" className="auth-link">Connect a TV with a code</Link>}
          </p>
        </form>
      </main>
    </div>
  )
}
