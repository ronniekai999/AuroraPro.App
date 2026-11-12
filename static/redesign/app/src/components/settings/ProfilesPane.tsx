// Settings, "Profiles and parental controls" (/settings/profiles): every
// profile on the account with its limit and its PIN, and a way to add one.
//
// A session acting as a profile with a content limit gets no management
// controls: the server refuses those writes from it, and a child's session
// should not be shown a way to try. It sees its own profile and what it may
// still change there (its name, avatar, lean and lists).

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Icon } from '@/components/Icon'
import { type Toast } from '@/components/Toast'
import { createProfile, listProfiles, type Profile } from '@/lib/api'
import { LIMIT_OPTIONS, NO_LIMIT } from '@/lib/profileLimits'
import { refusalMessage } from '@/lib/profileRefusal'
import { isRestrictedProfile, openDoorProfiles } from '@/lib/profileSession'
import { PaneNote, SettingSelect } from './controls'
import { ProfileRow } from './ProfileRow'

type OnToast = (message: string, type?: Toast['type']) => void

/** "Sam", "Sam and Kit", "Sam, Kit and Guest". */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function ProfilesPane({ actingProfile, profileKnown, profileSettled = true, onToast, onProfilesChanged, onSignInAgain }: {
  /** The profile the session is acting as, or null. */
  actingProfile: Profile | null
  /** False while the session's profile is unknown: then it is treated as
   *  restricted, since it could be acting as a restricted one. */
  profileKnown: boolean
  /** False while the app is still finding out which profile the session
   *  acts as. Until it has, this says it is loading, not that the profile
   *  "could not be confirmed", which is only true once the startup read has
   *  finished without an answer. */
  profileSettled?: boolean
  /** Leave for the sign-in page (when the server says this device has been
   *  signed out). */
  onSignInAgain?: () => void
  onToast?: OnToast
  /** Called after a change to profiles the app also holds (a PIN, a limit, a
   *  name, a new or deleted profile), so its copy, which decides what the
   *  session is offered and whether a switch prompts, is read again. */
  onProfilesChanged?: () => void
}) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const actingId = actingProfile?.id ?? null
  const [all, setAll] = useState<Profile[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Two copies of the acting profile: the app's, and the one in the list
  // this page last read. Either can be the newer one (another device gave
  // the profile a limit, and only one of the two has been read since), so
  // the session is treated as limited when EITHER says so. The server
  // refuses a limited session's management writes whatever is shown.
  const listed = all?.find(p => p.id === actingId)
  const acting = listed ?? actingProfile
  const restricted = !profileKnown || isRestrictedProfile(actingProfile) || isRestrictedProfile(listed)

  // Each load supersedes the ones before it, so an older answer cannot land
  // last and put back a list a newer one replaced.
  const loadGenRef = useRef(0)
  // The newest load, for an older one to hand its caller: a load that a
  // newer one has overtaken did not fail, and its caller wants the list.
  const latestLoadRef = useRef<Promise<Profile[] | null> | null>(null)
  const reload = useCallback((): Promise<Profile[] | null> => {
    const gen = ++loadGenRef.current
    const load = (async (): Promise<Profile[] | null> => {
      try {
        const list = await listProfiles()
        if (gen !== loadGenRef.current) return latestLoadRef.current
        setAll(list)
        setErr(null)
        return list
      } catch (e) {
        if (gen !== loadGenRef.current) return latestLoadRef.current
        setErr(e instanceof Error && e.message ? e.message : 'The profiles could not be loaded.')
        return null
      }
    })()
    latestLoadRef.current = load
    return load
    // The acting profile is a dependency so the list is read again when the
    // session moves to another profile: what it may see has changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restricted, actingId])
  useEffect(() => { void reload() }, [reload])

  const changed = useCallback(async () => {
    await reload()
    onProfilesChanged?.()
  }, [reload, onProfilesChanged])

  // Filtered when shown, not when stored, so a session that has just become
  // restricted never sees the other profiles' rows for a commit.
  const profiles = all === null ? null : restricted ? all.filter(p => p.id === actingId) : all
  const openDoors = restricted || !all ? [] : openDoorProfiles(all)

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className="font-display text-[22px] font-semibold leading-tight text-ink">Profiles and parental controls</h2>
      <p className="mt-1.5 max-w-[62ch] text-[14px] leading-snug text-ink-2">
        Every profile has its own history, picks and limit. A limit hides titles rated above it, titles with no rating, and titles
        with a rating Aurora does not recognise.
        {/* The password is the key to every profile: said to the people who
            manage them, not to a session with a limit. */}
        {!restricted && ' The account password also unlocks any profile.'}
      </p>

      {!profileSettled ? (
        <p className="mt-5 text-[14px] text-ink-2">Loading…</p>
      ) : restricted && (
        <div className="mt-5">
          <PaneNote>
            {acting
              ? `${acting.name} has a content limit, so limits, PINs and the other profiles can only be managed from a profile without one.`
              : 'This device’s profile could not be confirmed, so profiles can only be managed after a reload.'}
          </PaneNote>
        </div>
      )}

      {openDoors.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-control bg-surface-raised px-5 py-4">
          <Icon name="alertTriangle" size={20} className="flex-none text-warn" />
          <p className="min-w-0 flex-1 basis-[18rem] text-[14px] leading-snug text-ink">
            <strong className="font-semibold">{nameList(openDoors.map(p => p.name))} {openDoors.length === 1 ? 'has' : 'have'} no PIN.</strong>{' '}
            A profile with a limit can switch to {openDoors.length === 1 ? 'it' : 'them'} without one, and {openDoors.length === 1 ? 'its limit is' : 'their limits are'} different or absent.
            A PIN on {openDoors.length === 1 ? openDoors[0].name : 'each'} keeps the limits in place.
          </p>
        </div>
      )}

      {err && <p role="alert" className="mt-5 text-[14px] text-danger-ink">{err}</p>}
      {profileSettled && profiles === null && !err && <p className="mt-5 text-[14px] text-ink-2">Loading…</p>}
      {profileSettled && profiles !== null && all !== null && (
        <>
          <ul aria-label="Profiles" className="mt-5">
            {profiles.map(p => (
              <ProfileRow
                key={p.id}
                profile={p}
                profiles={all}
                acting={p.id === actingId}
                manages={!restricted}
                openDoor={openDoors.some(o => o.id === p.id)}
                onChanged={changed}
                onRefresh={reload}
                // The deleted profile's row took the focus with it.
                onDeleted={() => headingRef.current?.focus()}
                onSignInAgain={onSignInAgain}
                onToast={onToast}
              />
            ))}
          </ul>
          {!restricted && profiles.length === 0 && <p className="mt-2 text-[14px] text-ink-2">This account has no profiles yet.</p>}
          {!restricted && <AddProfile first={all.length === 0} onAdded={changed} onToast={onToast} />}
        </>
      )}
    </section>
  )
}

/** The server counts a name's bytes (100 at most), not its characters. */
const NAME_MAX_BYTES = 100
const byteLength = (text: string) => new TextEncoder().encode(text).length

/** What to say when adding a profile is refused. The server words its
 *  profile count limit for a log. */
export function addProfileRefusal(e: unknown): string {
  if (e instanceof Error && /maximum number of profiles/i.test(e.message)) {
    return 'This account has as many profiles as the server allows. Delete one to add another.'
  }
  return refusalMessage(e, 'The profile could not be added.')
}

function AddProfile({ first, onAdded, onToast }: {
  /** The account has no profile yet. Its first cannot have a limit: the
   *  server refuses one, since an account whose only profile is limited has
   *  nobody who can manage profiles. */
  first: boolean
  onAdded: () => Promise<void>
  onToast?: OnToast
}) {
  const ids = useId()
  const [name, setName] = useState('')
  const [limit, setLimit] = useState(NO_LIMIT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = name.trim()
  const tooLong = byteLength(next) > NAME_MAX_BYTES
  const useLimit = first ? NO_LIMIT : limit

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!next || tooLong || busy) return
    setBusy(true)
    setError(null)
    try {
      // The limit goes with the create, so a child's profile never exists
      // without it.
      await createProfile(next, useLimit === NO_LIMIT ? {} : { max_age_rating: useLimit })
      setName('')
      setLimit(NO_LIMIT)
      await onAdded()
      onToast?.(`${next} is added`, 'success')
    } catch (err) {
      setError(addProfileRefusal(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${ids}-title`} className="mt-6 rounded-control bg-surface-raised p-5">
      <h3 id={`${ids}-title`} className="font-display text-[17px] font-semibold text-ink">Add a profile</h3>
      <p className="mt-1 max-w-[60ch] text-[13px] leading-snug text-ink-2">
        {first
          ? 'The first profile has no limit, so that someone can manage the others. Add it, then add a profile with a limit for a child.'
          : 'For a child, pick a limit now. A limit only holds while the child cannot switch to a profile without one, so give those a PIN.'}
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label htmlFor={`${ids}-name`} className="block text-[13px] font-semibold text-ink">
          Name
          <input
            id={`${ids}-name`}
            value={name}
            maxLength={NAME_MAX_BYTES}
            // Read-only, not disabled, while the profile is added: a
            // disabled field drops the focus.
            readOnly={busy}
            aria-invalid={tooLong}
            onChange={e => setName(e.target.value)}
            className="mt-1.5 block h-11 w-56 max-w-full py-0"
          />
        </label>
        {!first && (
          <div>
            <label htmlFor={`${ids}-limit`} className="mb-1.5 block text-[13px] font-semibold text-ink">Limit</label>
            <SettingSelect id={`${ids}-limit`} wide value={limit} options={LIMIT_OPTIONS} onChange={v => { if (!busy) setLimit(v) }} />
          </div>
        )}
        {/* Off through aria-disabled, never `disabled`: the button is off
            again the moment the profile is added (the name is empty), and a
            disabled button would drop the focus it was pressed with. */}
        <button type="submit" aria-disabled={!next || tooLong || busy} className="stage-btn stage-btn-primary">{busy ? 'Adding…' : 'Add profile'}</button>
      </div>
      {tooLong && <p className="mt-2 text-[13px] text-danger-ink">That name is too long. Shorten it a little.</p>}
      <p role="alert" className={error ? 'mt-3 max-w-[62ch] text-[14px] leading-snug text-danger-ink' : 'sr-only'}>{error ?? ''}</p>
    </form>
  )
}
