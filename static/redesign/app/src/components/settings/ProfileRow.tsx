// One profile in "Profiles and parental controls": its limit, its PIN, and a
// panel for the rest (name, avatar, what its suggestions lean towards, its
// lists, making it the default, deleting it).
//
// The server decides what a session may change. This row offers a session
// only what it will accept, says in plain words why a control is missing or
// off, and when the server still refuses (another device got there first)
// shows that refusal under the row instead of losing it in a toast.

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { Icon } from '@/components/Icon'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import { ProfilePinDialog } from '@/components/ProfilePinDialog'
import { type Toast } from '@/components/Toast'
import {
  createWatchlist,
  deleteProfile,
  deleteWatchlist,
  listWatchlists,
  setDefaultProfile,
  setProfileMaturity,
  setProfilePin,
  updateProfile,
  type Profile,
  type ProfileUnlock,
  type Watchlist,
} from '@/lib/api'
import { profileSummary } from '@/lib/navScope'
import { canonicalLimit, limitOptionsFor, limitPhrase, NO_LIMIT } from '@/lib/profileLimits'
import { refusalMessage, refusalReason } from '@/lib/profileRefusal'
import { isSoleUnrestrictedProfile } from '@/lib/profileSession'
import { SettingSelect } from './controls'
import { AvatarPicker, LeanPicker } from './ProfilePickers'

type OnToast = (message: string, type?: Toast['type']) => void

export function ProfileRow({ profile, profiles, acting, manages, openDoor, onChanged, onToast }: {
  profile: Profile
  /** Every profile on the account (for the rules that count them). */
  profiles: Profile[]
  /** The session is watching as this profile. */
  acting: boolean
  /** The session may manage profiles (it acts as one without a limit). */
  manages: boolean
  /** A profile with a limit could switch into this one, and it has no PIN. */
  openDoor: boolean
  /** Reload the list (and tell the app its copy is stale). */
  onChanged: () => Promise<void>
  onToast?: OnToast
}) {
  const ids = useId()
  const [editing, setEditing] = useState(false)
  // A session that cannot manage profiles has this one row and nothing else
  // to do here, so its panel is simply open.
  const open = editing || !manages
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A limit picked for the profile being watched as, waiting to be confirmed.
  const [pendingLimit, setPendingLimit] = useState<string | null>(null)
  const [pinFormOpen, setPinFormOpen] = useState(false)
  const [newPin, setNewPin] = useState('')
  // A write that needs the profile's current PIN or the account password.
  const [unlockFor, setUnlockFor] = useState<null | { kind: 'change-pin'; pin: string } | { kind: 'remove-pin' } | { kind: 'default' }>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const name = profile.name
  const limit = canonicalLimit(profile.max_age_rating)
  const soleUnrestricted = isSoleUnrestrictedProfile(profiles, profile.id)

  /** Runs one write. A refusal is shown under the row; one that says the
   *  profile changed elsewhere also reloads the list it was judged against. */
  const run = async (write: () => Promise<unknown>, fallback: string, done?: string): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await write()
      await onChanged()
      if (done) onToast?.(done, 'success')
      return true
    } catch (e) {
      setError(refusalMessage(e, fallback))
      const reason = refusalReason(e)
      if (reason === 'profile_changed' || reason === 'profile_pin_required') void onChanged().catch(() => { /* the row keeps what it has */ })
      return false
    } finally {
      setBusy(false)
    }
  }

  const applyLimit = (value: string) => {
    setPendingLimit(null)
    void run(
      () => updateProfile(profile.id, { max_age_rating: value }),
      `${name}’s limit could not be changed.`,
      value === NO_LIMIT ? `${name} has no limit now` : `${name} is limited: ${limitPhrase(value)}`,
    )
  }
  const pickLimit = (value: string) => {
    if (value === limit) return
    // Limiting the profile this session acts as takes these controls away
    // from it, so that one is asked about first.
    if (acting && limit === NO_LIMIT && value !== NO_LIMIT) { setError(null); setPendingLimit(value); return }
    applyLimit(value)
  }

  const pinOk = /^[0-9]{4}$/.test(newPin)
  const submitPin = (e: FormEvent) => {
    e.preventDefault()
    if (!pinOk || busy) return
    // An existing PIN is confirmed first; a first PIN needs nothing.
    if (profile.has_pin) { setUnlockFor({ kind: 'change-pin', pin: newPin }); return }
    void run(() => setProfilePin(profile.id, newPin), `The PIN for ${name} could not be set.`, `PIN set for ${name}`)
      .then(ok => { if (ok) { setNewPin(''); setPinFormOpen(false) } })
  }
  const makeDefault = () => {
    // A locked profile becomes the default only with its PIN or the account
    // password, unless this session is already acting as it.
    if (profile.has_pin && !acting) { setUnlockFor({ kind: 'default' }); return }
    void run(() => setDefaultProfile(profile.id), `${name} could not be made the default.`, `${name} is the default profile now`)
  }
  /** The write behind the unlock prompt. It rejects with the server's
   *  refusal, which the prompt words itself. */
  const submitUnlock = async (unlock: ProfileUnlock) => {
    const what = unlockFor
    if (!what) return
    if (what.kind === 'change-pin') await setProfilePin(profile.id, what.pin, unlock)
    else if (what.kind === 'remove-pin') await setProfilePin(profile.id, '', unlock)
    else await setDefaultProfile(profile.id, unlock)
    setUnlockFor(null)
    setNewPin('')
    setPinFormOpen(false)
    setError(null)
    await onChanged()
    onToast?.(
      what.kind === 'change-pin' ? `PIN changed for ${name}` : what.kind === 'remove-pin' ? `PIN removed from ${name}` : `${name} is the default profile now`,
      'success',
    )
  }

  // Under the name. A session that manages profiles has the limit and the
  // PIN in their own columns; one that does not is told them here.
  const summary = (manages
    ? [profile.is_default ? 'Default profile' : null, acting ? 'watching now' : null]
    : [profileSummary(profile), acting ? 'watching now' : null]
  ).filter((part): part is string => !!part).join(' · ')

  return (
    <li className="border-t border-line py-4 first:border-t-0" data-profile-row={profile.id}>
      {/* One line from lg, in columns that are the same in every row, so
          the limits and the PINs read down the page as lists. Below that it
          wraps: the name, then the limit and the PIN, then the buttons. */}
      <div className={`flex flex-wrap items-end gap-x-4 gap-y-3 ${manages ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_16rem_5.5rem_8.5rem_5.5rem]' : ''}`}>
        <div className="flex min-w-0 flex-1 basis-[12rem] items-center gap-3 self-center">
          <ProfileAvatar avatarUrl={profile.avatar_url} name={name} colorKey={profile.id} size={48} />
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold leading-tight text-ink">{name}</p>
            {summary && <p className="mt-0.5 text-[13px] text-ink-2">{summary}</p>}
          </div>
        </div>

        {manages && (
          <>
            <div>
              <p className="mb-1 text-xs font-medium text-ink-2" aria-hidden="true">Limit</p>
              <SettingSelect
                wide
                aria-label={`Limit for ${name}`}
                aria-describedby={soleUnrestricted ? `${ids}-sole` : undefined}
                value={pendingLimit ?? limit}
                options={limitOptionsFor(profile.max_age_rating)}
                disabled={busy || soleUnrestricted}
                onChange={pickLimit}
              />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-ink-2" aria-hidden="true">PIN</p>
              <p className={`flex h-11 items-center gap-1.5 whitespace-nowrap text-[14px] ${profile.has_pin ? 'text-ink' : openDoor ? 'text-warn' : 'text-ink-2'}`}>
                <Icon name={profile.has_pin ? 'lock' : 'unlock'} size={15} className="flex-none" />
                {profile.has_pin ? 'PIN set' : 'No PIN'}
              </p>
            </div>
            <button
              type="button"
              aria-expanded={pinFormOpen}
              aria-controls={`${ids}-pin`}
              disabled={busy}
              onClick={() => { setPinFormOpen(o => !o); setNewPin(''); setError(null) }}
              className="stage-btn stage-btn-ghost px-4 lg:w-full"
            >
              {profile.has_pin ? 'Change PIN' : 'Set a PIN'}{' '}<span className="sr-only">for {name}</span>
            </button>
          </>
        )}
        {manages && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${ids}-panel`}
            onClick={() => setEditing(o => !o)}
            className="stage-btn stage-btn-outline px-4 lg:w-full"
          >
            {open ? 'Close' : 'Edit'}{' '}<span className="sr-only">{name}</span>
          </button>
        )}
      </div>

      {manages && soleUnrestricted && (
        <p id={`${ids}-sole`} className="mt-2 text-[13px] leading-snug text-ink-2">
          {name} is the only profile without a limit. One has to stay that way, so that someone can manage the others.
        </p>
      )}

      {pendingLimit !== null && (
        <div className="mt-3 rounded-control bg-surface-raised p-4">
          <p className="max-w-[60ch] text-[14px] leading-snug text-ink">
            You are watching as {name}. With a limit ({limitPhrase(pendingLimit)}), this device can no longer manage profiles until it switches to one without a limit.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => applyLimit(pendingLimit)} className="stage-btn stage-btn-ghost">Limit {name}</button>
            <button type="button" disabled={busy} onClick={() => setPendingLimit(null)} className="stage-btn stage-btn-quiet">Cancel</button>
          </div>
        </div>
      )}

      {manages && pinFormOpen && (
        <form id={`${ids}-pin`} onSubmit={submitPin} className="mt-3 rounded-control bg-surface-raised p-4">
          <label htmlFor={`${ids}-newpin`} className="block text-[13px] font-semibold text-ink">
            {profile.has_pin ? `New PIN for ${name}, four digits` : `PIN for ${name}, four digits`}
          </label>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
              id={`${ids}-newpin`}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              // Browsers ignore "off" on a password field and offer to save
              // the PIN as the site's password, or to overwrite the saved
              // account password with it. See ProfilePinDialog.
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              maxLength={4}
              value={newPin}
              disabled={busy}
              aria-describedby={`${ids}-pinnote`}
              onChange={e => setNewPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              className="h-11 w-28 py-0 text-[17px] tracking-[0.3em]"
            />
            <button type="submit" disabled={!pinOk || busy} className="stage-btn stage-btn-primary">
              {profile.has_pin ? 'Change PIN' : 'Set PIN'}
            </button>
            {profile.has_pin && (
              <button type="button" disabled={busy} onClick={() => setUnlockFor({ kind: 'remove-pin' })} className="stage-btn stage-btn-danger">
                Remove PIN
              </button>
            )}
          </div>
          <p id={`${ids}-pinnote`} className="mt-2 max-w-[62ch] text-[13px] leading-snug text-ink-2">
            {profile.has_pin
              ? 'Switching to this profile needs its PIN or the account password.'
              : 'Without a PIN, anyone signed in to this account can switch to this profile.'}
            {' '}Setting or changing the PIN signs out the account’s other devices that are using this profile
            {profile.is_default ? ', and those that never picked one' : ''}; they sign in again.
          </p>
        </form>
      )}

      <p role="alert" className={error ? 'mt-2 max-w-[62ch] text-[14px] leading-snug text-danger-ink' : 'sr-only'}>{error ?? ''}</p>

      {open && (
        // A ruled indent, not a filled card: the fields and the options in
        // it are filled, and on a card of the same fill they had no edge.
        <div id={`${ids}-panel`} className="mt-4 space-y-6 border-l-2 border-line-strong py-1 pl-4 sm:pl-6">
          <RenameForm profile={profile} busy={busy} run={run} />
          <div>
            <p className="mb-2 text-[13px] font-semibold text-ink">Avatar</p>
            <AvatarPicker
              profileId={profile.id}
              profileName={name}
              avatarUrl={profile.avatar_url}
              onPick={async avatarUrl => {
                if (!await run(() => updateProfile(profile.id, { avatar_url: avatarUrl }), `The avatar for ${name} could not be changed.`)) throw new Error('refused')
              }}
            />
          </div>
          <div>
            <p className="text-[13px] font-semibold text-ink">What suggestions lean towards</p>
            <p className="mb-2 mt-0.5 max-w-[60ch] text-[13px] leading-snug text-ink-2">
              Steers what is suggested to {name} first, from the next visit to Tonight. It hides nothing; a limit does that.
            </p>
            <LeanPicker
              profileId={profile.id}
              profileName={name}
              pref={profile.maturity_pref}
              onPick={async pref => {
                if (!await run(() => setProfileMaturity(profile.id, pref), `The lean for ${name} could not be changed.`)) throw new Error('refused')
              }}
            />
          </div>
          <ProfileLists profileId={profile.id} profileName={name} />
          {manages && (
            <div className="flex flex-wrap items-start gap-x-8 gap-y-4 border-t border-line pt-5">
              <div className="min-w-0 flex-1 basis-[14rem]">
                <button type="button" disabled={busy || profile.is_default} onClick={makeDefault} className="stage-btn stage-btn-ghost">
                  Make {name} the default
                </button>
                <p className="mt-2 max-w-[44ch] text-[13px] leading-snug text-ink-2">
                  {profile.is_default
                    ? `${name} is the default: the profile a new sign-in with the password starts on.`
                    : 'The default is the profile a new sign-in with the password starts on.'}
                </p>
              </div>
              <div className="min-w-0 flex-1 basis-[14rem]">
                {confirmDelete ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setConfirmDelete(false); void run(() => deleteProfile(profile.id), `${name} could not be deleted.`, `${name} is deleted`) }}
                      className="stage-btn stage-btn-destructive"
                    >
                      Delete {name} for good
                    </button>
                    <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)} className="stage-btn stage-btn-quiet">Keep</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busy || profile.is_default || acting || soleUnrestricted}
                    onClick={() => setConfirmDelete(true)}
                    className="stage-btn stage-btn-danger"
                  >
                    Delete {name}
                  </button>
                )}
                <p className="mt-2 max-w-[44ch] text-[13px] leading-snug text-ink-2">
                  {profile.is_default
                    ? 'The default profile cannot be deleted. Make another profile the default first.'
                    : acting
                      ? `You are watching as ${name}. Switch to another profile to delete this one.`
                      : soleUnrestricted
                        ? 'The only profile without a limit cannot be deleted.'
                        : 'Its watch history, lists and picks are deleted with it, and devices using it are signed out. This cannot be undone.'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {unlockFor && (
        <ProfilePinDialog
          profile={profile}
          title={unlockFor.kind === 'change-pin' ? `Change ${name}’s PIN` : unlockFor.kind === 'remove-pin' ? `Remove ${name}’s PIN` : `Make ${name} the default`}
          description="Enter the current PIN, or the account password, to confirm."
          submitLabel={unlockFor.kind === 'change-pin' ? 'Change PIN' : unlockFor.kind === 'remove-pin' ? 'Remove PIN' : 'Make default'}
          onSubmit={submitUnlock}
          onCancel={() => setUnlockFor(null)}
        />
      )}
    </li>
  )
}

function RenameForm({ profile, busy, run }: {
  profile: Profile
  busy: boolean
  run: (write: () => Promise<unknown>, fallback: string, done?: string) => Promise<boolean>
}) {
  const id = useId()
  const [name, setName] = useState(profile.name)
  useEffect(() => { setName(profile.name) }, [profile.id, profile.name])
  const next = name.trim()
  const changed = next.length > 0 && next !== profile.name
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        if (!changed || busy) return
        void run(() => updateProfile(profile.id, { name: next }), `${profile.name} could not be renamed.`, `Renamed to ${next}`)
      }}
    >
      <label htmlFor={id} className="block text-[13px] font-semibold text-ink">Name</label>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <input id={id} value={name} maxLength={100} disabled={busy} onChange={e => setName(e.target.value)} className="h-11 w-64 max-w-full py-0" />
        <button type="submit" disabled={!changed || busy} className="stage-btn stage-btn-ghost">Save name</button>
      </div>
    </form>
  )
}

// A profile's lists (the ones a title's "List" button adds to). This is the
// only place one is made or deleted. Loaded when the panel opens, and only
// ever for the profile the panel belongs to: the server refuses a session
// with a content limit any other profile's.
function ProfileLists({ profileId, profileName }: { profileId: number; profileName: string }) {
  const id = useId()
  const [lists, setLists] = useState<Watchlist[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const ls = await listWatchlists(profileId, signal)
      if (signal?.aborted) return
      setLists(ls)
      setFailed(false)
    } catch {
      if (!signal?.aborted) setFailed(true)
    }
  }, [profileId])
  useEffect(() => {
    const ac = new AbortController()
    setLists(null)
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  const write = async (fn: () => Promise<unknown>, fallback: string): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
      return true
    } catch (e) {
      setError(refusalMessage(e, fallback))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="text-[13px] font-semibold text-ink">Lists</p>
      <p className="mb-2 mt-0.5 text-[13px] leading-snug text-ink-2">A title’s List button adds it to one of these.</p>
      {failed && <p className="text-[14px] text-danger-ink">The lists for {profileName} could not be loaded.</p>}
      {!failed && lists === null && <p className="text-[14px] text-ink-2">Loading…</p>}
      {lists !== null && lists.length === 0 && <p className="text-[14px] text-ink-2">No lists yet.</p>}
      {lists !== null && lists.length > 0 && (
        <ul aria-label={`Lists for ${profileName}`} className="mb-3">
          {lists.map(l => (
            <li key={l.id} className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-t border-line py-1 first:border-t-0">
              <span className="min-w-0 truncate text-[15px] text-ink">{l.name}</span>
              {confirming === l.id ? (
                <span className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setConfirming(null); void write(() => deleteWatchlist(profileId, l.id), `“${l.name}” could not be deleted.`) }}
                    className="stage-btn stage-btn-danger px-4"
                  >
                    Delete “{l.name}” and what is in it
                  </button>
                  <button type="button" onClick={() => setConfirming(null)} className="stage-btn stage-btn-quiet px-3">Keep</button>
                </span>
              ) : (
                <button type="button" disabled={busy} onClick={() => setConfirming(l.id)} className="stage-btn stage-btn-quiet px-3">
                  Delete{' '}<span className="sr-only">the list {l.name}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={e => {
          e.preventDefault()
          const next = name.trim()
          if (!next || busy) return
          void write(() => createWatchlist(profileId, next), 'The list could not be made.').then(ok => { if (ok) setName('') })
        }}
      >
        <label htmlFor={id} className="sr-only">New list for {profileName}</label>
        <input id={id} value={name} maxLength={100} placeholder="New list" disabled={busy} onChange={e => setName(e.target.value)} className="h-11 w-64 max-w-full py-0" />
        <button type="submit" disabled={!name.trim() || busy} className="stage-btn stage-btn-ghost">Add list</button>
      </form>
      <p role="alert" className={error ? 'mt-2 text-[14px] text-danger-ink' : 'sr-only'}>{error ?? ''}</p>
    </div>
  )
}
