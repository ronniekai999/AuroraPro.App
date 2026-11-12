// One profile in "Profiles and parental controls": its limit, its PIN, and a
// panel for the rest (name, avatar, what its suggestions lean towards, its
// lists, making it the default, deleting it).
//
// The server decides what a session may change. This row offers a session
// only what it will accept, says in plain words why a control is missing or
// off, and when the server still refuses (another device got there first)
// shows that refusal under the row instead of losing it in a toast.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from '@/components/Icon'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import { ProfilePinDialog } from '@/components/ProfilePinDialog'
import { type Toast } from '@/components/Toast'
import {
  APIError,
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
import { limitOptionValue, limitOptionsFor, limitPhrase, loosensLimit, NO_LIMIT } from '@/lib/profileLimits'
import { refusalMessage, refusalReason } from '@/lib/profileRefusal'
import { isRestrictedProfile, isSoleUnrestrictedProfile } from '@/lib/profileSession'
import { ConfirmDialog } from './ConfirmDialog'
import { SettingSelect } from './controls'
import { AvatarPicker, LeanPicker } from './ProfilePickers'

type OnToast = (message: string, type?: Toast['type']) => void
type Run = (write: () => Promise<unknown>, fallback: string, done?: string, onRefusal?: (e: unknown) => string | null) => Promise<boolean>

/** How long Save waits for the list it reads before a limit is written, and
 *  how long a row waits for the list to reload after a write. */
export const LIMIT_CHECK_TIMEOUT_MS = 10_000

/** `work`, or nothing once `ms` have passed. The work goes on either way;
 *  only the wait for it ends. */
function waitAtMost<T>(work: Promise<T>, ms: number): Promise<T | void> {
  let timer = 0
  return Promise.race([
    work,
    new Promise<void>(resolve => { timer = window.setTimeout(resolve, ms) }),
  ]).finally(() => window.clearTimeout(timer))
}

/** The server counts a name's bytes (100 at most), not its characters. */
const NAME_MAX_BYTES = 100
const byteLength = (text: string) => new TextEncoder().encode(text).length

export function ProfileRow({ profile, profiles, acting, manages, openDoor, onChanged, onRefresh, onDeleted, onSignInAgain, onToast }: {
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
  /** Read the list again and hand it back, or null when it could not be
   *  read. For a check against what the server has now, before a write. */
  onRefresh: () => Promise<Profile[] | null>
  /** This profile was deleted here and the list reloaded: this row is gone,
   *  and focus with it unless the list takes it. */
  onDeleted?: () => void
  /** Leave for the sign-in page, when the server says this device has been
   *  signed out. */
  onSignInAgain?: () => void
  onToast?: OnToast
}) {
  const ids = useId()
  const [editing, setEditing] = useState(false)
  // A session that cannot manage profiles has this one row and nothing else
  // to do here, so its panel is simply open.
  const open = editing || !manages
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const [pinFormOpen, setPinFormOpen] = useState(false)
  const [newPin, setNewPin] = useState('')
  // A write that needs the profile's current PIN or the account password.
  const [unlockFor, setUnlockFor] = useState<null | { kind: 'change-pin'; pin: string } | { kind: 'remove-pin' } | { kind: 'default' }>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // A question asked of one session must not be answered by another: if
  // this device starts watching as this profile while "Delete Sam?" is up
  // (a switch made in another tab), or stops being allowed to manage
  // profiles, the question is withdrawn. Confirming it would delete the
  // profile this device now acts as, which the server does not refuse.
  useEffect(() => { setConfirmDelete(false) }, [acting, manages])
  // Where focus goes when the control that had it is gone or cannot hold it.
  const pinToggleRef = useRef<HTMLButtonElement | null>(null)
  const editToggleRef = useRef<HTMLButtonElement | null>(null)
  const defaultRef = useRef<HTMLButtonElement | null>(null)

  const name = profile.name
  const soleUnrestricted = isSoleUnrestrictedProfile(profiles, profile.id)

  /** Runs one write. A refusal is shown under the row. One that means the
   *  list this row was drawn from is out of date (the profile changed or was
   *  deleted elsewhere, a PIN appeared, the session's own profile gained a
   *  limit, the count of unlimited profiles moved) also reloads it, which
   *  tells the app to read its copy again. */
  const run: Run = async (write, fallback, done, onRefusal) => {
    setBusy(true)
    setError(null)
    setSignedOut(false)
    try {
      await write()
      // The write is done. The list is read again, but a read that does not
      // answer must not keep the row busy after its own work has finished.
      await waitAtMost(onChanged(), LIMIT_CHECK_TIMEOUT_MS)
      if (done) onToast?.(done, 'success')
      return true
    } catch (e) {
      const reason = refusalReason(e)
      const gone = e instanceof APIError && e.status === 404
      setError(onRefusal?.(e) ?? (gone
        ? `${name} was deleted on another device. The list has been reloaded.`
        : refusalMessage(e, fallback)))
      setSignedOut(reason === 'session_ended')
      if (gone || reason === 'profile_changed' || reason === 'profile_pin_required' || reason === 'profile_restricted' || reason === 'last_unrestricted_profile') {
        void onChanged().catch(() => { /* the row keeps what it has */ })
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  const pinOk = /^[0-9]{4}$/.test(newPin)
  const submitPin = (e: FormEvent) => {
    e.preventDefault()
    if (!pinOk || busy) return
    // An existing PIN is confirmed first; a first PIN needs nothing.
    if (profile.has_pin) { setUnlockFor({ kind: 'change-pin', pin: newPin }); return }
    void run(
      () => setProfilePin(profile.id, newPin),
      `The PIN for ${name} could not be set.`,
      `PIN set for ${name}`,
      // The row said "no PIN", so there is no field here for the one the
      // server now asks for.
      e2 => (refusalReason(e2) === 'profile_pin_required'
        ? `Another device set a PIN on ${name} a moment ago, so this one was not set. The row has been reloaded: change the PIN with that one, or with the account password.`
        : null),
    ).then(ok => {
      if (!ok) return
      setNewPin('')
      setPinFormOpen(false)
      // The form, and the field that had focus, are gone.
      pinToggleRef.current?.focus()
    })
  }
  const makeDefault = () => {
    if (busy || profile.is_default) return
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
    await waitAtMost(onChanged(), LIMIT_CHECK_TIMEOUT_MS)
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

  // What making this profile the default would do beyond the obvious.
  const noDefaultYet = !profiles.some(p => p.is_default)
  const defaultNote = profile.is_default
    ? `${name} is the default: the profile a new sign-in with the password starts on.`
    : [
        'The default is the profile a new sign-in with the password starts on.',
        isRestrictedProfile(profile) ? `${name} has a limit, so those sign-ins would start limited.` : null,
        noDefaultYet && profile.has_pin ? 'This account has no default yet, so devices that never picked a profile will be signed out.' : null,
      ].filter(Boolean).join(' ')

  return (
    <li className="border-t border-line py-4 first:border-t-0" data-profile-row={profile.id}>
      {/* One line from lg, in columns that are the same in every row, so
          the limits and the PINs read down the page as lists. Below that it
          wraps: the name, then the limit and the PIN, then the buttons. */}
      <div className={`flex flex-wrap items-start gap-x-4 gap-y-3 ${manages ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_16rem_5.5rem_8.5rem_5.5rem]' : ''}`}>
        <div className="flex min-h-[68px] min-w-0 flex-1 basis-[12rem] items-center gap-3">
          <ProfileAvatar avatarUrl={profile.avatar_url} name={name} colorKey={profile.id} size={48} />
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold leading-tight text-ink">{name}</p>
            {summary && <p className="mt-0.5 text-[13px] text-ink-2">{summary}</p>}
          </div>
        </div>

        {manages && (
          <>
            <LimitControl profile={profile} acting={acting} soleUnrestricted={soleUnrestricted} busy={busy} run={run} onRefresh={onRefresh} />
            <div>
              <p className="mb-1 text-xs font-medium text-ink-2" aria-hidden="true">PIN</p>
              <p className={`flex h-11 items-center gap-1.5 whitespace-nowrap text-[14px] ${profile.has_pin ? 'text-ink' : openDoor ? 'text-warn' : 'text-ink-2'}`}>
                <Icon name={profile.has_pin ? 'lock' : 'unlock'} size={15} className="flex-none" />
                {profile.has_pin ? 'PIN set' : 'No PIN'}
              </p>
            </div>
            <button
              type="button"
              ref={pinToggleRef}
              aria-expanded={pinFormOpen}
              // Only while there is a form to point at.
              aria-controls={pinFormOpen ? `${ids}-pin` : undefined}
              // Not `disabled` for the length of a write: this button takes
              // the focus when the PIN form closes.
              aria-disabled={busy}
              onClick={() => { if (busy) return; setPinFormOpen(o => !o); setNewPin(''); setError(null) }}
              className="stage-btn stage-btn-ghost px-4 lg:mt-5 lg:w-full"
            >
              {profile.has_pin ? 'Change PIN' : 'Set a PIN'}{' '}<span className="sr-only">for {name}</span>
            </button>
            <button
              type="button"
              ref={editToggleRef}
              aria-expanded={open}
              aria-controls={open ? `${ids}-panel` : undefined}
              onClick={() => setEditing(o => !o)}
              className="stage-btn stage-btn-outline px-4 lg:mt-5 lg:w-full"
            >
              {open ? 'Close' : 'Edit'}{' '}<span className="sr-only">{name}</span>
            </button>
          </>
        )}
      </div>

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
              // Read-only, not disabled, while the PIN is sent: a disabled
              // field drops the focus.
              readOnly={busy}
              aria-describedby={`${ids}-pinnote`}
              onChange={e => setNewPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              className="h-11 w-28 py-0 text-[17px] tracking-[0.3em]"
            />
            <button type="submit" disabled={!pinOk} aria-disabled={busy} className="stage-btn stage-btn-primary">
              {profile.has_pin ? 'Change PIN' : 'Set PIN'}
            </button>
            {profile.has_pin && (
              <button type="button" aria-disabled={busy} onClick={() => { if (!busy) setUnlockFor({ kind: 'remove-pin' }) }} className="stage-btn stage-btn-danger">
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

      <div role="alert" className={error ? 'mt-2 flex max-w-[62ch] flex-wrap items-center gap-x-4 gap-y-2 text-[14px] leading-snug text-danger-ink' : 'sr-only'}>
        {error ?? ''}
        {error && signedOut && onSignInAgain && (
          <button type="button" onClick={onSignInAgain} className="stage-btn stage-btn-ghost px-4">Sign in again</button>
        )}
      </div>

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
                {/* The name can be long: the label wraps instead of running
                    off a phone. */}
                <button
                  type="button"
                  ref={defaultRef}
                  // Never `disabled`: once this profile IS the default the
                  // button that was pressed would drop the focus. It stays,
                  // says why it does nothing, and does nothing.
                  aria-disabled={busy || profile.is_default}
                  aria-describedby={`${ids}-default`}
                  onClick={makeDefault}
                  className="stage-btn stage-btn-ghost stage-btn-wrap"
                >
                  Make {name} the default
                </button>
                <p id={`${ids}-default`} className="mt-2 max-w-[44ch] text-[13px] leading-snug text-ink-2">{defaultNote}</p>
              </div>
              <div className="min-w-0 flex-1 basis-[14rem]">
                <button
                  type="button"
                  disabled={profile.is_default || acting || soleUnrestricted}
                  // Not `disabled` for the length of a write: the dialog
                  // hands focus back to this button, and a disabled one
                  // cannot hold it.
                  aria-disabled={busy}
                  onClick={e => {
                    if (busy) return
                    // Not every browser focuses a button on a click, and the
                    // dialog gives focus back to what had it.
                    e.currentTarget.focus()
                    setConfirmDelete(true)
                  }}
                  className="stage-btn stage-btn-danger stage-btn-wrap"
                >
                  Delete {name}
                </button>
                <p className="mt-2 max-w-[44ch] text-[13px] leading-snug text-ink-2">
                  {profile.is_default
                    ? 'The default profile cannot be deleted. Make another profile the default first.'
                    : acting
                      ? `You are watching as ${name}. Switch to another profile to delete this one.`
                      : soleUnrestricted
                        ? 'The only profile without a limit cannot be deleted.'
                        : 'Its watch history, lists and picks go with it. This cannot be undone.'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${name}?`}
        confirmLabel={`Delete ${name}`}
        cancelLabel={`Keep ${name}`}
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          if (acting || !manages) return
          void run(() => deleteProfile(profile.id), `${name} could not be deleted.`, `${name} is deleted`).then(ok => { if (ok) onDeleted?.() })
        }}
        fallbackFocus={() => editToggleRef.current}
      >
        The watch history, lists, ratings and picks of {name} are deleted with it, and the devices using it are signed out. This cannot be undone.
      </ConfirmDialog>

      {unlockFor && (
        <ProfilePinDialog
          profile={profile}
          title={unlockFor.kind === 'change-pin' ? `Change the PIN for ${name}` : unlockFor.kind === 'remove-pin' ? `Remove the PIN from ${name}` : `Make ${name} the default`}
          description="Enter the current PIN, or the account password, to confirm."
          submitLabel={unlockFor.kind === 'change-pin' ? 'Change PIN' : unlockFor.kind === 'remove-pin' ? 'Remove PIN' : 'Make default'}
          onSubmit={submitUnlock}
          onCancel={() => setUnlockFor(null)}
          // A PIN change closes the form that asked for it.
          fallbackFocus={unlockFor.kind === 'default' ? () => defaultRef.current : () => pinToggleRef.current}
        />
      )}
    </li>
  )
}

// A profile's limit. Choosing in the dropdown changes nothing by itself: on
// Windows and Linux an arrow key or a typed letter on a closed dropdown
// "changes" it at once, and one stray key must not lift a child's limit. The
// choice is held here until Save is pressed, and a choice that lets MORE
// through, or that limits the profile this device is watching as, is asked
// about first.
function LimitControl({ profile, acting, soleUnrestricted, busy, run, onRefresh }: {
  profile: Profile
  acting: boolean
  soleUnrestricted: boolean
  busy: boolean
  run: Run
  onRefresh: () => Promise<Profile[] | null>
}) {
  const ids = useId()
  const name = profile.name
  const stored = limitOptionValue(profile.max_age_rating)
  const [draft, setDraft] = useState(stored)
  const [asking, setAsking] = useState(false)
  // The stored limit changed under the control (saved here, or on another
  // device and reloaded): the control shows it, and a question asked about
  // the old one is withdrawn, since its words no longer hold.
  useEffect(() => { setDraft(stored); setAsking(false) }, [stored, profile.id])
  // So is one asked before this device started, or stopped, watching as
  // this profile: "limit yourself" is a different question.
  useEffect(() => { setAsking(false) }, [acting])
  // Save reads the list again first; this is what it found, when that
  // stopped the save.
  const [checking, setChecking] = useState(false)
  const [stopped, setStopped] = useState<string | null>(null)
  const selectRef = useRef<HTMLSpanElement | null>(null)
  const focusSelect = () => selectRef.current?.querySelector('select')?.focus()
  // The facts as they are NOW, for Save to read after its wait: whether this
  // device watches as this profile, and whether this control is still on the
  // page. What Save saw when it was pressed can be out of date by then.
  // Set as the commit lands, not after paint: Save's continuation can run
  // in between, and must not read the commit before.
  const actingNow = useRef(acting)
  useLayoutEffect(() => { actingNow.current = acting }, [acting])
  const mounted = useRef(true)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  // The limit this control last wrote, until the row shows it. The reload
  // after a write can stall, and the row then still shows the old limit
  // with Save beside it; the next Save reads the new one, and must know it
  // was written here and not on another device.
  const lastWrote = useRef<string | null>(null)
  useLayoutEffect(() => { if (lastWrote.current === stored) lastWrote.current = null }, [stored])
  const dirty = draft !== stored
  const loosens = loosensLimit(stored, draft)
  // Limiting the profile this session acts as takes these controls away
  // from it.
  const limitsSelf = acting && stored === NO_LIMIT && draft !== NO_LIMIT
  const waiting = busy || checking

  const save = async () => {
    setAsking(false)
    const writing = draft
    const ok = await run(
      () => updateProfile(profile.id, { max_age_rating: writing }).then(() => { lastWrote.current = writing }),
      `The limit for ${name} could not be changed.`,
      writing === NO_LIMIT ? `${name} has no limit now` : `${name} is limited: ${limitPhrase(writing)}`,
    )
    // Refused: back to what the server has.
    if (!ok) setDraft(stored)
    // The Save button is gone either way; focus goes to the control it
    // belonged to instead of nowhere.
    focusSelect()
  }
  const pressSave = async () => {
    if (!dirty || waiting) return
    // Read now: the list Save is about to read can reach this row, and
    // clear the record, before Save's own wait is over.
    const wroteHere = lastWrote.current
    // Whether this choice loosens the limit is a question about what the
    // server has NOW. Another device may have tightened it since this row
    // was drawn, and judged against the old value a looser limit would go
    // through unasked. So the list is read again first, and a limit that
    // has moved stops the save and is shown.
    setChecking(true)
    setStopped(null)
    // With a deadline: a read that never answers must not leave the control
    // waiting, with Save, Undo and the dropdown all inert.
    let timer = 0
    const fresh = await Promise.race([
      onRefresh().catch(() => null),
      new Promise<'slow'>(resolve => { timer = window.setTimeout(() => resolve('slow'), LIMIT_CHECK_TIMEOUT_MS) }),
    ])
    window.clearTimeout(timer)
    // The control left the page while the list was read (this device may no
    // longer manage profiles): nothing is saved.
    if (!mounted.current) return
    setChecking(false)
    if (fresh === 'slow') {
      setStopped(`The server took too long to say what the limit for ${name} is now, so nothing was saved. Try again.`)
      return
    }
    if (!fresh) {
      setStopped(`The limit for ${name} could not be checked just now, so nothing was saved. Try again.`)
      return
    }
    const now = fresh.find(p => p.id === profile.id)
    // Deleted on another device: the row goes with the reload.
    if (!now) return
    const nowStored = limitOptionValue(now.max_age_rating)
    if (nowStored !== stored) {
      // This row shows a limit the server no longer has. When the server's
      // is the one this control wrote, the row is behind its own write.
      setStopped(nowStored === wroteHere
        ? `The limit for ${name} was already saved from this device. It is now: ${limitPhrase(nowStored)}. Choose again if that is not what you want.`
        : `The limit for ${name} was changed on another device a moment ago, so nothing was saved. It is now: ${limitPhrase(nowStored)}. Choose again if that is not what you want.`)
      focusSelect()
      return
    }
    // "Limit yourself" is judged on who this device watches as now, not at
    // the press: another tab can move the session onto this profile while
    // the list is read, and a limit written then would limit this device
    // without its having been asked.
    const limitsSelfNow = actingNow.current && stored === NO_LIMIT && draft !== NO_LIMIT
    if (loosens || limitsSelfNow) setAsking(true)
    else void save()
  }

  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-2" aria-hidden="true">Limit</p>
      <span ref={selectRef} className="block">
        <SettingSelect
          wide
          aria-label={`Limit for ${name}`}
          aria-describedby={soleUnrestricted ? `${ids}-sole` : dirty ? `${ids}-unsaved` : undefined}
          value={draft}
          options={limitOptionsFor(profile.max_age_rating)}
          // Not disabled while a write is out: that would drop the focus.
          disabled={soleUnrestricted}
          onChange={v => { if (!waiting) { setDraft(v); setStopped(null) } }}
        />
      </span>
      {soleUnrestricted && (
        <p id={`${ids}-sole`} className="mt-2 max-w-[16rem] text-[13px] leading-snug text-ink-2">
          {name} is the only profile without a limit. One has to stay that way, so that someone can manage the others.
        </p>
      )}
      <p role="status" className={stopped ? 'mt-2 max-w-[16rem] text-[13px] leading-snug text-ink' : 'sr-only'}>{stopped ?? ''}</p>
      {dirty && (
        <div className="mt-2 max-w-[16rem]">
          <p id={`${ids}-unsaved`} className="text-[13px] leading-snug text-ink-2">
            Not saved. The limit for {name} is still: {limitPhrase(stored)}.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              aria-disabled={waiting}
              onClick={e => { e.currentTarget.focus(); void pressSave() }}
              className="stage-btn stage-btn-primary px-4"
            >
              Save limit{' '}<span className="sr-only">for {name}</span>
            </button>
            <button type="button" aria-disabled={waiting} onClick={() => { if (!waiting) { setDraft(stored); focusSelect() } }} className="stage-btn stage-btn-quiet px-3">
              Undo
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={asking}
        title={draft === NO_LIMIT ? `Take the limit off ${name}?` : limitsSelf ? `Limit ${name}?` : `Loosen the limit for ${name}?`}
        confirmLabel={draft === NO_LIMIT ? 'Remove the limit' : limitsSelf ? `Limit ${name}` : 'Loosen the limit'}
        cancelLabel="Keep it as it is"
        onCancel={() => { setAsking(false); setDraft(stored) }}
        onConfirm={() => { void save() }}
        // The Save button that opened this goes with the choice it saved.
        fallbackFocus={() => selectRef.current?.querySelector('select')}
      >
        {limitsSelf
          ? `You are watching as ${name}. With a limit (${limitPhrase(draft)}), this device can no longer manage profiles until it switches to one without a limit.`
          : draft === NO_LIMIT
            ? `${name} will be able to see and play everything on this server. The limit now is: ${limitPhrase(stored)}.`
            : `${name} will be able to see and play more: ${limitPhrase(draft)}. The limit now is: ${limitPhrase(stored)}.`}
      </ConfirmDialog>
    </div>
  )
}

function RenameForm({ profile, busy, run }: { profile: Profile; busy: boolean; run: Run }) {
  const id = useId()
  const [name, setName] = useState(profile.name)
  useEffect(() => { setName(profile.name) }, [profile.id, profile.name])
  const next = name.trim()
  // The server refuses a name over 100 bytes, which an accented or
  // non-Latin name reaches well before 100 characters.
  const tooLong = byteLength(next) > NAME_MAX_BYTES
  const changed = next.length > 0 && next !== profile.name && !tooLong
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
        <input
          id={id}
          value={name}
          maxLength={NAME_MAX_BYTES}
          readOnly={busy}
          aria-invalid={tooLong}
          aria-describedby={tooLong ? `${id}-long` : undefined}
          onChange={e => setName(e.target.value)}
          className="h-11 w-64 max-w-full py-0"
        />
        {/* Off through aria-disabled, never `disabled`: Save is off again
            once the name is the stored one, and a disabled button would
            drop the focus it was pressed with. */}
        <button type="submit" aria-disabled={!changed || busy} className="stage-btn stage-btn-ghost">Save name</button>
      </div>
      {tooLong && <p id={`${id}-long`} className="mt-1.5 text-[13px] text-danger-ink">That name is too long. Shorten it a little.</p>}
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
  const [confirming, setConfirming] = useState<Watchlist | null>(null)
  // Takes focus when a list is deleted: its row, and the button that was
  // pressed, are gone.
  const headingRef = useRef<HTMLParagraphElement | null>(null)

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
      <p ref={headingRef} tabIndex={-1} className="text-[13px] font-semibold text-ink">Lists</p>
      <p className="mb-2 mt-0.5 text-[13px] leading-snug text-ink-2">A title’s List button adds it to one of these.</p>
      {failed && <p className="text-[14px] text-danger-ink">The lists for {profileName} could not be loaded.</p>}
      {!failed && lists === null && <p className="text-[14px] text-ink-2">Loading…</p>}
      {lists !== null && lists.length === 0 && <p className="text-[14px] text-ink-2">No lists yet.</p>}
      {lists !== null && lists.length > 0 && (
        <ul aria-label={`Lists for ${profileName}`} className="mb-3">
          {lists.map(l => (
            <li key={l.id} className="flex min-h-11 items-center justify-between gap-2 border-t border-line py-1 first:border-t-0">
              <span className="min-w-0 break-words text-[15px] text-ink">{l.name}</span>
              <button type="button" aria-disabled={busy} onClick={e => { if (busy) return; e.currentTarget.focus(); setConfirming(l) }} className="stage-btn stage-btn-quiet flex-none px-3">
                Delete{' '}<span className="sr-only">the list {l.name}</span>
              </button>
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
        <input id={id} value={name} maxLength={100} placeholder="New list" readOnly={busy} onChange={e => setName(e.target.value)} className="h-11 w-64 max-w-full py-0" />
        <button type="submit" aria-disabled={!name.trim() || busy} className="stage-btn stage-btn-ghost">Add list</button>
      </form>
      <p role="alert" className={error ? 'mt-2 text-[14px] text-danger-ink' : 'sr-only'}>{error ?? ''}</p>

      <ConfirmDialog
        open={confirming !== null}
        title={`Delete the list “${confirming?.name ?? ''}”?`}
        confirmLabel="Delete the list"
        cancelLabel="Keep it"
        destructive
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const l = confirming
          setConfirming(null)
          if (l) void write(() => deleteWatchlist(profileId, l.id), `“${l.name}” could not be deleted.`).then(ok => { if (ok) headingRef.current?.focus() })
        }}
        fallbackFocus={() => headingRef.current}
      >
        The list and what {profileName} saved in it are deleted. The titles themselves stay on the server.
      </ConfirmDialog>
    </div>
  )
}
