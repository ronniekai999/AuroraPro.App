// How the account appears to the server's other members (/user/<username>):
// display name, bio, social handles, and whether finished titles are shown.
// It fetches its own data: this is the only consumer of /api/me/profile.

import { useEffect, useId, useState } from 'react'
import { type Toast } from '@/components/Toast'
import { getMyProfile, updateMyProfile, type MemberProfile, type Profile } from '@/lib/api'
import { refusalMessage } from '@/lib/profileRefusal'
import { isRestrictedProfile } from '@/lib/profileSession'
import { SOCIAL_NETWORKS, normalizeHandleInput } from '@/lib/socialLinks'
import { PaneNote, SettingRow, SettingSwitch } from './controls'

type OnToast = (message: string, type?: Toast['type']) => void

// A session acting as a profile with a content limit cannot edit the
// account's member profile (the server refuses: it is the account's public
// identity, and its sharing switch publishes the default profile's history),
// so it gets a note in place of the form.
export function MemberProfileSection({ activeProfile, profileKnown, onToast }: {
  activeProfile: Profile | null
  /** False while the session's profile is unknown: then it is treated as restricted. */
  profileKnown: boolean
  onToast?: OnToast
}) {
  return !profileKnown || isRestrictedProfile(activeProfile)
    ? <PaneNote>Your member profile can only be edited from a profile without a content limit.</PaneNote>
    : <MemberProfileEditor onToast={onToast} />
}

function MemberProfileEditor({ onToast }: { onToast?: OnToast }) {
  const ids = useId()
  const [loaded, setLoaded] = useState<MemberProfile | null>(null)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [form, setForm] = useState({
    display_name: '',
    bio: '',
    social_x: '',
    social_instagram: '',
    social_facebook: '',
    social_snapchat: '',
    share_watch_history: false,
  })

  const syncForm = (p: MemberProfile) => setForm({
    display_name: p.display_name ?? '',
    bio: p.bio ?? '',
    social_x: p.social_x ?? '',
    social_instagram: p.social_instagram ?? '',
    social_facebook: p.social_facebook ?? '',
    social_snapchat: p.social_snapchat ?? '',
    share_watch_history: p.share_watch_history,
  })

  useEffect(() => {
    let cancelled = false
    getMyProfile()
      .then(p => { if (!cancelled) { setLoaded(p); syncForm(p) } })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    // A pasted URL or @handle is reduced to the bare handle before it is
    // sent. null means the paste cannot honestly be reduced (an unknown
    // host, a deep path, a page route such as profile.php): refused with the
    // network named, rather than saved as a wrong handle of the right shape.
    // Length is checked here too, so an over-long handle reads "too long".
    const handles: Partial<Record<(typeof SOCIAL_NETWORKS)[number]['key'], string>> = {}
    for (const n of SOCIAL_NETWORKS) {
      const norm = normalizeHandleInput(form[n.key], n)
      if (norm === null) {
        onToast?.(`${n.label}: that link has no username in it. Enter just the handle.`, 'error')
        return
      }
      if (norm.length > n.maxLen) {
        onToast?.(`${n.label}: that handle is too long (${n.maxLen} characters at most).`, 'error')
        return
      }
      handles[n.key] = norm
    }
    setSaving(true)
    try {
      // The sharing switch is NOT in this save: it saves itself when it is
      // flipped. It is a privacy control, and a "turn it off" that waited
      // for Save would be lost by leaving the page.
      const p = await updateMyProfile({ display_name: form.display_name, bio: form.bio, ...handles })
      setLoaded(p)
      syncForm(p)
      onToast?.('Your member profile is saved', 'success')
    } catch (e) {
      onToast?.(refusalMessage(e, 'Your member profile could not be saved.'), 'error')
    } finally {
      setSaving(false)
    }
  }

  // Saved at once (one field), shown at once, and put back if the server
  // refuses.
  const toggleShare = async (next: boolean) => {
    setSharing(true)
    setForm(f => ({ ...f, share_watch_history: next }))
    try {
      const p = await updateMyProfile({ share_watch_history: next })
      setLoaded(p)
      setForm(f => ({ ...f, share_watch_history: p.share_watch_history }))
      onToast?.(next ? 'Finished titles now show on your page' : 'Finished titles are hidden from your page', 'success')
    } catch (e) {
      setForm(f => ({ ...f, share_watch_history: !next }))
      onToast?.(refusalMessage(e, 'Sharing could not be changed.'), 'error')
    } finally {
      setSharing(false)
    }
  }

  if (failed) return <p role="alert" className="text-[14px] text-danger-ink">Your member profile could not be loaded.</p>
  if (!loaded) return <p className="text-[14px] text-ink-2">Loading…</p>

  const field = 'mt-1.5 block w-full'
  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label htmlFor={`${ids}-name`} className="block text-[13px] font-semibold text-ink">
          Display name
          <input
            id={`${ids}-name`}
            value={form.display_name}
            onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
            placeholder={loaded.username}
            maxLength={80}
            className={`${field} h-11 py-0`}
          />
        </label>
      </div>
      <label htmlFor={`${ids}-bio`} className="mt-4 block text-[13px] font-semibold text-ink">
        Bio
        <textarea
          id={`${ids}-bio`}
          value={form.bio}
          onChange={e => setForm(f => ({ ...f, bio: e.target.value }))}
          placeholder="A line or two about you"
          rows={2}
          maxLength={500}
          className={`${field} resize-y`}
        />
      </label>
      <div className="mt-4 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))]">
        {SOCIAL_NETWORKS.map(n => (
          <label key={n.key} htmlFor={`${ids}-${n.key}`} className="block text-[13px] font-semibold text-ink">
            {n.label}
            <input
              id={`${ids}-${n.key}`}
              value={form[n.key]}
              onChange={e => setForm(f => ({ ...f, [n.key]: e.target.value }))}
              // The profile's address or the @handle: saving reduces either.
              placeholder={`@${n.placeholder}`}
              maxLength={120}
              className={`${field} h-11 py-0`}
            />
          </label>
        ))}
      </div>
      <div className="mt-5">
        <button type="button" onClick={() => void save()} disabled={saving} className="stage-btn stage-btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="mt-6">
        <SettingRow
          labelId={`${ids}-share`}
          descId={`${ids}-share-desc`}
          label="Share what I finish"
          desc="Shows titles finished on the account’s default profile on your page. Nothing in progress, and nothing from other profiles. Off unless you turn it on; it applies at once."
        >
          <SettingSwitch
            checked={form.share_watch_history}
            disabled={sharing}
            labelledBy={`${ids}-share`}
            describedBy={`${ids}-share-desc`}
            onChange={next => void toggleShare(next)}
          />
        </SettingRow>
      </div>
    </div>
  )
}
