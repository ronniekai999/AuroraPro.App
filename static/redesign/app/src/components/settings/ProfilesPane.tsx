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

export function ProfilesPane({ actingProfile, profileKnown, onToast, onProfilesChanged }: {
  /** The profile the session is acting as, or null. */
  actingProfile: Profile | null
  /** False while the session's profile is unknown: then it is treated as
   *  restricted, since it could be acting as a restricted one. */
  profileKnown: boolean
  onToast?: OnToast
  /** Called after a change to profiles the app also holds (a PIN, a limit, a
   *  name, a new or deleted profile), so its copy, which decides what the
   *  session is offered and whether a switch prompts, is read again. */
  onProfilesChanged?: () => void
}) {
  const headingId = useId()
  const restricted = !profileKnown || isRestrictedProfile(actingProfile)
  const actingId = actingProfile?.id ?? null
  const [all, setAll] = useState<Profile[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Each load supersedes the ones before it, so an older answer cannot land
  // last and put back a list a newer one replaced.
  const loadGenRef = useRef(0)
  const reload = useCallback(async () => {
    const gen = ++loadGenRef.current
    try {
      const list = await listProfiles()
      if (gen !== loadGenRef.current) return
      setAll(list)
      setErr(null)
    } catch (e) {
      if (gen !== loadGenRef.current) return
      setErr(e instanceof Error && e.message ? e.message : 'The profiles could not be loaded.')
    }
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
      <h2 id={headingId} className="font-display text-[22px] font-semibold leading-tight text-ink">Profiles and parental controls</h2>
      <p className="mt-1.5 max-w-[62ch] text-[14px] leading-snug text-ink-2">
        Every profile has its own history, picks and limit. A limit hides titles rated above it, and titles with no rating at all.
        The account password also unlocks any profile.
      </p>

      {restricted && (
        <div className="mt-5">
          <PaneNote>
            {actingProfile
              ? `${actingProfile.name} has a content limit, so limits, PINs and the other profiles can only be managed from a profile without one.`
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
      {profiles === null && !err && <p className="mt-5 text-[14px] text-ink-2">Loading…</p>}
      {profiles !== null && all !== null && (
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
                onToast={onToast}
              />
            ))}
          </ul>
          {!restricted && profiles.length === 0 && <p className="mt-2 text-[14px] text-ink-2">This account has no profiles yet.</p>}
          {!restricted && <AddProfile onAdded={changed} onToast={onToast} />}
        </>
      )}
    </section>
  )
}

function AddProfile({ onAdded, onToast }: { onAdded: () => Promise<void>; onToast?: OnToast }) {
  const ids = useId()
  const [name, setName] = useState('')
  const [limit, setLimit] = useState(NO_LIMIT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = name.trim()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!next || busy) return
    setBusy(true)
    setError(null)
    try {
      // The limit goes with the create, so a child's profile never exists
      // without it.
      await createProfile(next, limit === NO_LIMIT ? {} : { max_age_rating: limit })
      setName('')
      setLimit(NO_LIMIT)
      await onAdded()
      onToast?.(`${next} is added`, 'success')
    } catch (err) {
      setError(refusalMessage(err, 'The profile could not be added.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${ids}-title`} className="mt-6 rounded-control bg-surface-raised p-5">
      <h3 id={`${ids}-title`} className="font-display text-[17px] font-semibold text-ink">Add a profile</h3>
      <p className="mt-1 max-w-[60ch] text-[13px] leading-snug text-ink-2">
        For a child, pick a limit now. A limit only holds while the child cannot switch to a profile without one, so give those a PIN.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label htmlFor={`${ids}-name`} className="block text-[13px] font-semibold text-ink">
          Name
          <input id={`${ids}-name`} value={name} maxLength={100} disabled={busy} onChange={e => setName(e.target.value)} className="mt-1.5 block h-11 w-56 max-w-full py-0" />
        </label>
        <div>
          <label htmlFor={`${ids}-limit`} className="mb-1.5 block text-[13px] font-semibold text-ink">Limit</label>
          <SettingSelect id={`${ids}-limit`} wide value={limit} options={LIMIT_OPTIONS} disabled={busy} onChange={setLimit} />
        </div>
        <button type="submit" disabled={!next || busy} className="stage-btn stage-btn-primary">{busy ? 'Adding…' : 'Add profile'}</button>
      </div>
      <p role="alert" className={error ? 'mt-3 max-w-[62ch] text-[14px] leading-snug text-danger-ink' : 'sr-only'}>{error ?? ''}</p>
    </form>
  )
}
