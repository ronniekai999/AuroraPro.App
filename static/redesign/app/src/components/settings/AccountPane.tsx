// Settings, "Account and sign-in" (/settings/account): who is signed in, the
// account password, the accounts linked for signing in without it, and
// signing out.

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { type Toast } from '@/components/Toast'
import {
  APIError,
  WRONG_CURRENT_PASSWORD,
  changePassword,
  listOAuthLinks,
  startOAuthLink,
  unlinkOAuth,
  type OAuthLinksResponse,
  type Profile,
  type User as ApiUser,
} from '@/lib/api'
import { oauthProviderLabel } from '@/lib/oauth'
import { refusalMessage } from '@/lib/profileRefusal'
import { isRestrictedProfile } from '@/lib/profileSession'
import { ConfirmDialog } from './ConfirmDialog'
import { PaneNote, PaneSection, SettingRow } from './controls'
import { failureWords } from '@/lib/failureWords'

type OnToast = (message: string, type?: Toast['type']) => void

export function AccountPane({ user, activeProfile, profileKnown, profileSettled = true, onLogout, onToast }: {
  user?: ApiUser
  activeProfile: Profile | null
  /** False while the session's profile is unknown: then it is treated as restricted. */
  profileKnown: boolean
  /** False while the app is still finding out which profile the session acts as. */
  profileSettled?: boolean
  onLogout?: () => void
  onToast?: OnToast
}) {
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const signOutRef = useRef<HTMLButtonElement | null>(null)
  // The password is the key to every profile: said to the people who manage
  // them, not to a session with a limit (or one that might have one).
  const managesSignIn = profileKnown && !isRestrictedProfile(activeProfile)
  return (
    <>
      {user && (
        <PaneSection title="Account">
          <SettingRow label={user.username} desc={user.role === 'admin' ? 'Admin of this server' : 'Member of this server'} />
        </PaneSection>
      )}

      <PaneSection
        title="Sign-in methods"
        note={managesSignIn
          ? 'The account password also unlocks every profile, whatever its PIN. A linked account signs in without the password.'
          : undefined}
      >
        {profileSettled
          ? <SignInMethodsCard username={user?.username} activeProfile={activeProfile} profileKnown={profileKnown} onLogout={onLogout} onToast={onToast} />
          : <p className="text-[14px] text-ink-2">Loading…</p>}
      </PaneSection>

      {onLogout && (
        <section aria-label="Sign out" className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-control bg-surface-raised p-5">
          <div className="min-w-0 flex-1 basis-[16rem]">
            <p className="text-[15px] font-semibold text-ink">Sign out</p>
            {/* The server's logout ends EVERY session on the account. There
                is no sign-out for one device, and this must not read as one. */}
            <p className="mt-0.5 max-w-[56ch] text-[13px] leading-snug text-ink-2">
              Signs out every device on this account, this one included. One device cannot be signed out by itself.
            </p>
          </div>
          <button
            type="button"
            ref={signOutRef}
            // Not every browser focuses a button on a click, and the dialog
            // gives focus back to what had it.
            onClick={e => { e.currentTarget.focus(); setConfirmSignOut(true) }}
            className="stage-btn stage-btn-danger flex-none"
          >
            Sign out
          </button>
          <ConfirmDialog
            open={confirmSignOut}
            title="Sign out of every device?"
            confirmLabel="Sign out everywhere"
            cancelLabel="Stay signed in"
            destructive
            onCancel={() => setConfirmSignOut(false)}
            onConfirm={() => { setConfirmSignOut(false); onLogout() }}
            fallbackFocus={() => signOutRef.current}
          >
            This signs out every device on this account: this one, and every other browser, phone and TV that is signed in. Each signs in again.
          </ConfirmDialog>
        </section>
      )}
    </>
  )
}

// A session acting as a profile with a content limit cannot link or unlink a
// sign-in method (the server refuses: a new link would let it sign in again
// without the password, after its session ends), so it gets a note in place
// of the list. The password form goes with it: the password is the key to
// every profile.
export function SignInMethodsCard({ username, activeProfile, profileKnown, onLogout, onToast }: {
  /** The account's sign-in name, for the password form. */
  username?: string
  activeProfile: Profile | null
  /** False while the session's profile is unknown: then it is treated as restricted. */
  profileKnown: boolean
  onLogout?: () => void
  onToast?: OnToast
}) {
  return !profileKnown || isRestrictedProfile(activeProfile)
    ? <PaneNote>Sign-in methods can only be managed from a profile without a content limit.</PaneNote>
    : <SignInMethods username={username} onLogout={onLogout} onToast={onToast} />
}

function SignInMethods({ username, onLogout, onToast }: { username?: string; onLogout?: () => void; onToast?: OnToast }) {
  const [links, setLinks] = useState<OAuthLinksResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // The provider with a request out, so its button cannot fire twice.
  const [busy, setBusy] = useState<string | null>(null)
  // The provider whose Disconnect is being asked about.
  const [confirming, setConfirming] = useState<string | null>(null)
  // A provider just disconnected: its row now offers Connect, and that
  // button takes the focus the Disconnect button had.
  const [disconnected, setDisconnected] = useState<string | null>(null)
  // The provider the last question was about, kept after the dialog closes.
  const [asked, setAsked] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!disconnected) return
    rootRef.current?.querySelector<HTMLElement>(`[data-connect="${disconnected}"]`)?.focus()
    setDisconnected(null)
  }, [disconnected, links])

  const reload = useCallback(async () => {
    try {
      setLinks(await listOAuthLinks())
      setErr(null)
    } catch (e) {
      setErr(failureWords(e, 'load the sign-in methods') ?? 'The sign-in methods could not be loaded.')
    }
  }, [])
  // The ?linked=<provider> marker a finished link leaves is handled once by
  // the app, whatever page is showing; this read already has the new link.
  useEffect(() => { void reload() }, [reload])

  const connect = async (provider: string) => {
    setBusy(provider)
    try {
      // Leaves for the provider on success, so busy is not cleared.
      await startOAuthLink(provider)
    } catch (e) {
      setBusy(null)
      onToast?.(refusalMessage(e, `${oauthProviderLabel(provider)} could not be connected.`, { doing: `connect ${oauthProviderLabel(provider)}` }), 'error')
    }
  }
  const disconnect = async (provider: string) => {
    setConfirming(null)
    setBusy(provider)
    try {
      await unlinkOAuth(provider)
      onToast?.(`${oauthProviderLabel(provider)} is disconnected.`, 'info')
      await reload()
      setDisconnected(provider)
    } catch (e) {
      onToast?.(refusalMessage(e, `${oauthProviderLabel(provider)} could not be disconnected.`, { doing: `disconnect ${oauthProviderLabel(provider)}` }), 'error')
    } finally {
      setBusy(null)
    }
  }

  if (err) return <p role="alert" className="text-[14px] text-danger-ink">{err}</p>
  if (!links) return <p className="text-[14px] text-ink-2">Loading…</p>

  // No password and one linked account: disconnecting it would leave no way
  // in. The server refuses that too (409); this only saves the attempt.
  const onlyWayIn = !links.hasPassword && links.linked.length <= 1

  return (
    <div ref={rootRef}>
      <SettingRow
        label="Password"
        desc={links.hasPassword
          ? 'Set.'
          : 'This account has no password. It signs in through a linked account, and a forgotten profile PIN cannot be recovered without one.'}
      />
      {links.hasPassword && <PasswordForm username={username} onSignIn={onLogout} />}
      {links.linked.map(l => (
        <SettingRow
          key={l.provider}
          label={oauthProviderLabel(l.provider)}
          desc={onlyWayIn
            ? `Connected ${new Date(l.linkedAt).toLocaleDateString()}. It is the only way to sign in to this account, so it cannot be disconnected until another account is linked.`
            : `Connected ${new Date(l.linkedAt).toLocaleDateString()}`}
        >
          <button
            type="button"
            disabled={onlyWayIn}
            // Not `disabled` for the length of the request: the dialog
            // hands focus back to this button.
            aria-disabled={busy === l.provider}
            data-disconnect={l.provider}
            onClick={e => { if (busy === l.provider) return; e.currentTarget.focus(); setAsked(l.provider); setConfirming(l.provider) }}
            className="stage-btn stage-btn-outline"
          >
            {busy === l.provider ? 'Disconnecting…' : 'Disconnect'}{' '}<span className="sr-only">{oauthProviderLabel(l.provider)}</span>
          </button>
        </SettingRow>
      ))}
      <ConfirmDialog
        open={confirming !== null}
        title={`Disconnect ${confirming ? oauthProviderLabel(confirming) : ''}?`}
        confirmLabel="Disconnect"
        cancelLabel="Keep it"
        destructive
        onCancel={() => setConfirming(null)}
        onConfirm={() => { const p = confirming; if (p) void disconnect(p) }}
        fallbackFocus={() => (asked ? rootRef.current?.querySelector<HTMLElement>(`[data-disconnect="${asked}"]`) : null)}
      >
        You will no longer be able to sign in to Aurora with your {confirming ? oauthProviderLabel(confirming) : ''} account. You can connect it again later.
      </ConfirmDialog>
      {links.available.map(p => (
        <SettingRow key={p} label={oauthProviderLabel(p)} desc="Not connected">
          <button type="button" data-connect={p} disabled={busy === p} onClick={() => void connect(p)} className="stage-btn stage-btn-ghost">
            {busy === p ? 'Opening…' : 'Connect'}{' '}<span className="sr-only">{oauthProviderLabel(p)}</span>
          </button>
        </SettingRow>
      ))}
      {links.linked.length === 0 && links.available.length === 0 && (
        <SettingRow label="Linked accounts" desc="No sign-in providers are turned on for this server." />
      )}
    </div>
  )
}

// Changing the password ends every session on the account, this one too
// (the server revokes them all), so the form says so before the press, and
// says that it worked before the app leaves for the sign-in page.
function PasswordForm({ username, onSignIn }: { username?: string; onSignIn?: () => void }) {
  const ids = useId()
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const currentRef = useRef<HTMLInputElement | null>(null)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const doneRef = useRef<HTMLDivElement | null>(null)
  // Opening the form swaps the button that opened it for the form, and
  // closing it swaps back: focus follows, or it is left on nothing.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open) currentRef.current?.focus()
    else if (wasOpen.current) openerRef.current?.focus()
    wasOpen.current = open
  }, [open])
  useEffect(() => { if (done) doneRef.current?.focus() }, [done])

  // The server counts bytes, 8 to 128: a password of accented or non-Latin
  // characters reaches both ends sooner than its length in characters says.
  const bytes = passwordBytes(next)
  const tooShort = next.length > 0 && bytes < 8
  const tooLong = bytes > 128
  const filled = current.length > 0 && bytes >= 8 && !tooLong
  const ready = filled && !busy

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await changePassword(current, next)
      setDone(true)
    } catch (err) {
      setError(passwordErrorMessage(err))
      setBusy(false)
      // The field to correct.
      if (err instanceof APIError && err.status === 401 && err.message === WRONG_CURRENT_PASSWORD) currentRef.current?.focus()
    }
  }

  if (done) {
    return (
      <div ref={doneRef} tabIndex={-1} className="border-t border-line py-4" role="status">
        <p className="text-[15px] font-semibold text-ink">The password is changed.</p>
        <p className="mt-0.5 max-w-[56ch] text-[13px] leading-snug text-ink-2">
          Every device on this account has been signed out, this one included. Sign in again with the new password.
        </p>
        {onSignIn && <button type="button" onClick={onSignIn} className="stage-btn stage-btn-primary mt-3">Sign in again</button>}
      </div>
    )
  }
  if (!open) {
    return (
      <SettingRow
        label="Change the password"
        desc="Signs out every device on this account, this one included. You sign in again with the new password."
      >
        <button type="button" ref={openerRef} onClick={() => setOpen(true)} className="stage-btn stage-btn-ghost">Change password</button>
      </SettingRow>
    )
  }
  return (
    <form onSubmit={submit} className="border-t border-line py-4" aria-label="Change the password">
      <p className="text-[15px] font-semibold text-ink">Change the password</p>
      <p className="mt-0.5 max-w-[56ch] text-[13px] leading-snug text-ink-2">
        Signs out every device on this account, this one included. You sign in again with the new password.
      </p>
      {/* For a password manager: without the account's name in the form it
          may save the new password attached to nothing. Not shown, not a
          tab stop, and not read out. */}
      {username && <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label htmlFor={`${ids}-current`} className="block text-[13px] font-semibold text-ink">
          Current password
          <input
            id={`${ids}-current`}
            ref={currentRef}
            type="password"
            autoComplete="current-password"
            value={current}
            // Read-only, not disabled, while the change is sent: a disabled
            // field drops the focus.
            readOnly={busy}
            onChange={e => setCurrent(e.target.value)}
            className="mt-1.5 block h-11 w-56 max-w-full py-0"
          />
        </label>
        <label htmlFor={`${ids}-next`} className="block text-[13px] font-semibold text-ink">
          New password
          <input
            id={`${ids}-next`}
            type="password"
            autoComplete="new-password"
            value={next}
            readOnly={busy}
            aria-invalid={tooShort || tooLong}
            aria-describedby={`${ids}-hint`}
            onChange={e => setNext(e.target.value)}
            className="mt-1.5 block h-11 w-56 max-w-full py-0"
          />
        </label>
        <button type="submit" disabled={!filled} aria-disabled={busy} className="stage-btn stage-btn-primary">{busy ? 'Changing…' : 'Change password'}</button>
        <button type="button" aria-disabled={busy} onClick={() => { if (busy) return; setOpen(false); setCurrent(''); setNext(''); setError(null) }} className="stage-btn stage-btn-quiet">Cancel</button>
      </div>
      <p id={`${ids}-hint`} className={`mt-2 text-[13px] ${tooShort || tooLong ? 'text-danger-ink' : 'text-ink-3'}`}>
        {tooLong ? 'That is too long for a password here. Shorten it.' : 'At least 8 characters.'}
      </p>
      <p role="alert" className="mt-1 min-h-[1.25rem] text-[14px] text-danger-ink">{error ?? ''}</p>
    </form>
  )
}

/** A password's length as the server counts it: in bytes. */
export const passwordBytes = (password: string) => new TextEncoder().encode(password).length

/** What to say when a password change is refused. Exported for its test. */
export function passwordErrorMessage(e: unknown): string {
  if (e instanceof APIError) {
    if (e.status === 401 && e.message === WRONG_CURRENT_PASSWORD) return 'That is not the current password.'
    if (e.status === 429) return 'Too many attempts. Wait a minute, then try again.'
  }
  // A 500 can come after the password was changed (the sessions could not
  // then be ended), so it is not said to have failed.
  return refusalMessage(e, 'The password could not be changed. Try again.', {
    doing: 'change the password',
    overrides: { status: { 500: 'Something went wrong on the server, and the password may or may not have changed.' } },
  })
}
