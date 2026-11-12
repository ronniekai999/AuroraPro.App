// Settings, "Account and sign-in" (/settings/account): who is signed in, the
// account password, the accounts linked for signing in without it, and
// signing out.

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
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
import { PaneNote, PaneSection, SettingRow } from './controls'

type OnToast = (message: string, type?: Toast['type']) => void

export function AccountPane({ user, activeProfile, profileKnown, onLogout, onToast }: {
  user?: ApiUser
  activeProfile: Profile | null
  /** False while the session's profile is unknown: then it is treated as restricted. */
  profileKnown: boolean
  onLogout?: () => void
  onToast?: OnToast
}) {
  return (
    <>
      {user && (
        <PaneSection title="Account">
          <SettingRow label={user.username} desc={user.role === 'admin' ? 'Admin of this server' : 'Member of this server'} />
        </PaneSection>
      )}

      <PaneSection
        title="Sign-in methods"
        note="The account password also unlocks every profile, whatever its PIN. A linked account signs in without the password."
      >
        <SignInMethodsCard activeProfile={activeProfile} profileKnown={profileKnown} onLogout={onLogout} onToast={onToast} />
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
          <button type="button" onClick={onLogout} className="stage-btn stage-btn-danger flex-none">Sign out</button>
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
export function SignInMethodsCard({ activeProfile, profileKnown, onLogout, onToast }: {
  activeProfile: Profile | null
  /** False while the session's profile is unknown: then it is treated as restricted. */
  profileKnown: boolean
  onLogout?: () => void
  onToast?: OnToast
}) {
  return !profileKnown || isRestrictedProfile(activeProfile)
    ? <PaneNote>Sign-in methods can only be managed from a profile without a content limit.</PaneNote>
    : <SignInMethods onLogout={onLogout} onToast={onToast} />
}

function SignInMethods({ onLogout, onToast }: { onLogout?: () => void; onToast?: OnToast }) {
  const [links, setLinks] = useState<OAuthLinksResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // The provider with a request out, so its button cannot fire twice.
  const [busy, setBusy] = useState<string | null>(null)
  // The provider whose Disconnect is waiting for a second press.
  const [confirming, setConfirming] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setLinks(await listOAuthLinks())
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : 'The sign-in methods could not be loaded.')
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
      onToast?.(refusalMessage(e, `${oauthProviderLabel(provider)} could not be connected.`), 'error')
    }
  }
  const disconnect = async (provider: string) => {
    setConfirming(null)
    setBusy(provider)
    try {
      await unlinkOAuth(provider)
      onToast?.(`${oauthProviderLabel(provider)} is disconnected.`, 'info')
      await reload()
    } catch (e) {
      onToast?.(refusalMessage(e, `${oauthProviderLabel(provider)} could not be disconnected.`), 'error')
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
    <div>
      <SettingRow
        label="Password"
        desc={links.hasPassword
          ? 'Set.'
          : 'This account has no password. It signs in through a linked account, and a forgotten profile PIN cannot be recovered without one.'}
      />
      {links.hasPassword && <PasswordForm onChanged={onLogout} />}
      {links.linked.map(l => (
        <SettingRow
          key={l.provider}
          label={oauthProviderLabel(l.provider)}
          desc={onlyWayIn
            ? `Connected ${new Date(l.linkedAt).toLocaleDateString()}. It is the only way to sign in to this account, so it cannot be disconnected until another account is linked.`
            : `Connected ${new Date(l.linkedAt).toLocaleDateString()}`}
        >
          {confirming === l.provider ? (
            <>
              <button type="button" onClick={() => void disconnect(l.provider)} className="stage-btn stage-btn-danger">
                Disconnect {oauthProviderLabel(l.provider)}
              </button>
              <button type="button" onClick={() => setConfirming(null)} className="stage-btn stage-btn-quiet">Keep</button>
            </>
          ) : (
            <button
              type="button"
              disabled={onlyWayIn || busy === l.provider}
              onClick={() => setConfirming(l.provider)}
              className="stage-btn stage-btn-outline"
            >
              {busy === l.provider ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
        </SettingRow>
      ))}
      {links.available.map(p => (
        <SettingRow key={p} label={oauthProviderLabel(p)} desc="Not connected">
          <button type="button" disabled={busy === p} onClick={() => void connect(p)} className="stage-btn stage-btn-ghost">
            {busy === p ? 'Opening…' : 'Connect'}
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
// (the server revokes them all), so the form says so before the press and
// the app signs out when it succeeds.
function PasswordForm({ onChanged }: { onChanged?: () => void }) {
  const ids = useId()
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tooShort = next.length > 0 && next.length < 8
  const ready = current.length > 0 && next.length >= 8 && next.length <= 128 && !busy

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await changePassword(current, next)
      onChanged?.()
    } catch (err) {
      setError(passwordErrorMessage(err))
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <SettingRow
        label="Change the password"
        desc="Signs out every device on this account, this one included. You sign in again with the new password."
      >
        <button type="button" onClick={() => setOpen(true)} className="stage-btn stage-btn-ghost">Change password</button>
      </SettingRow>
    )
  }
  return (
    <form onSubmit={submit} className="border-t border-line py-4" aria-label="Change the password">
      <p className="text-[15px] font-semibold text-ink">Change the password</p>
      <p className="mt-0.5 max-w-[56ch] text-[13px] leading-snug text-ink-2">
        Signs out every device on this account, this one included. You sign in again with the new password.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label htmlFor={`${ids}-current`} className="block text-[13px] font-semibold text-ink">
          Current password
          <input
            id={`${ids}-current`}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={current}
            disabled={busy}
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
            minLength={8}
            maxLength={128}
            value={next}
            disabled={busy}
            aria-invalid={tooShort}
            aria-describedby={`${ids}-hint`}
            onChange={e => setNext(e.target.value)}
            className="mt-1.5 block h-11 w-56 max-w-full py-0"
          />
        </label>
        <button type="submit" disabled={!ready} className="stage-btn stage-btn-primary">{busy ? 'Changing…' : 'Change password'}</button>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); setCurrent(''); setNext(''); setError(null) }} className="stage-btn stage-btn-quiet">Cancel</button>
      </div>
      <p id={`${ids}-hint`} className={`mt-2 text-[13px] ${tooShort ? 'text-danger-ink' : 'text-ink-3'}`}>At least 8 characters.</p>
      <p role="alert" className="mt-1 min-h-[1.25rem] text-[14px] text-danger-ink">{error ?? ''}</p>
    </form>
  )
}

/** What to say when a password change is refused. Exported for its test. */
export function passwordErrorMessage(e: unknown): string {
  if (e instanceof APIError) {
    if (e.status === 401 && e.message === WRONG_CURRENT_PASSWORD) return 'That is not the current password.'
    if (e.status === 429) return 'Too many attempts. Wait a minute, then try again.'
  }
  return refusalMessage(e, 'The password could not be changed. Try again.')
}
