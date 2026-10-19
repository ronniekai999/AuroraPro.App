// Which profile the app shows at startup. The server's session binding decides
// what every ceiling enforces (issue #462), so the app shows that binding, and
// changes it only through the server.
//
// The remembered id (localStorage) matters after a new login, which binds the
// account default: the app re-selects the profile this browser last used, but
// only an unlocked one, and only once the server has accepted the switch. A
// locked one waits for its PIN like any other switch.

import { useEffect } from 'react'
import type { Profile } from './api'

// A session acting as a profile with a ceiling may not manage profiles: the
// server refuses creating, deleting, re-defaulting, PIN changes, and edits to
// any other profile or to its own ceiling. The UI hides those controls.
export function isRestrictedProfile(p: Pick<Profile, 'max_age_rating'> | null | undefined): boolean {
  return !!p?.max_age_rating?.trim()
}

/** Whether the app shows the admin role's pages and controls. The role
 * belongs to the account, but the server refuses its powers to a session
 * acting as a restricted profile (403 profile_restricted), so they show only
 * once the session is known to act as an unrestricted profile, or the account
 * is known to have no profile at all. While the binding is unknown, or the
 * profile list failed to load, they stay hidden. As on the server, an account
 * with no unrestricted profile keeps them in a restricted session: nothing
 * else on it could use them. */
export function showsAdminUI(role: string | undefined, profiles: Profile[], profilesLoaded: boolean, activeId: number | null): boolean {
  if (role !== 'admin') return false
  if (activeId === null) return profilesLoaded && profiles.length === 0
  const acting = profiles.find(p => p.id === activeId)
  return !!acting && (!isRestrictedProfile(acting) || profiles.every(isRestrictedProfile))
}

/** Whether id is the account's only profile without a content limit. The
 * server refuses to give that profile a limit, or to delete it (409
 * last_unrestricted_profile): only a session acting as such a profile can
 * manage profiles, so an account with none could never lift a limit again. */
export function isSoleUnrestrictedProfile(profiles: Profile[], id: number | null): boolean {
  const own = profiles.find(p => p.id === id)
  return !!own && !isRestrictedProfile(own) && !profiles.some(p => p.id !== id && !isRestrictedProfile(p))
}

/** The unlocked profiles a restricted profile could switch into to loosen its
 * limit: any without a limit, and any whose limit differs from some
 * restricted profile's. The app has no rating ladder of its own (the
 * server's is the only one), so a differing limit that happens to be
 * stricter is listed too; profiles sharing one limit are harmless to each
 * other and are not. Empty when no profile is restricted. */
export function openDoorProfiles(profiles: Profile[]): Profile[] {
  const limit = (p: Profile) => (p.max_age_rating ?? '').trim().toUpperCase()
  const restricted = new Set(profiles.filter(isRestrictedProfile).map(limit))
  if (restricted.size === 0) return []
  return profiles.filter(p => !p.has_pin && (!isRestrictedProfile(p) || [...restricted].some(l => l !== limit(p))))
}

export async function resolveStartupProfile({ profiles, acting, remembered, activate, reread }: {
  profiles: Profile[]
  /** The session's binding, or null when it could not be read. */
  acting: Pick<Profile, 'id'> | null
  /** The profile id this browser last showed. */
  remembered: number | null
  /** Binds a profile server-side; rejects when the server refuses. */
  activate: (id: number) => Promise<void>
  /** Reads the binding again after a failed re-selection. */
  reread?: () => Promise<Pick<Profile, 'id'>>
}): Promise<number | null> {
  if (profiles.length === 0) return null
  let next = acting && profiles.some(p => p.id === acting.id) ? acting.id : null
  const want = remembered ? profiles.find(p => p.id === remembered) : undefined
  if (want && want.id !== next && !want.has_pin) {
    try {
      await activate(want.id)
      next = want.id
    } catch {
      // Keep the server's binding. A lost answer can follow a bind that
      // happened, so read it again; unreadable, it is unknown.
      if (reread) {
        try {
          const now = await reread()
          next = profiles.some(p => p.id === now.id) ? now.id : null
        } catch { next = null }
      }
    }
  }
  // The binding is unknown when it could not be read, or names a profile the
  // list does not hold. With one profile there is nothing to guess. With
  // several the app shows none (null), and the host opens the picker: a pick
  // binds the session, so what the app shows is what the server enforces.
  if (next === null && profiles.length === 1) next = profiles[0].id
  return next
}

const REMEMBERED_PROFILE_KEY = 'aurora_active_profile_id'

/** The profile id this browser last showed. It only feeds
 * resolveStartupProfile's re-selection after a new login; the app never shows
 * or fetches for it before the server's binding is read. */
export function readRememberedProfileId(): number | null {
  try {
    const raw = localStorage.getItem(REMEMBERED_PROFILE_KEY)
    return raw ? parseInt(raw, 10) || null : null
  } catch { return null }
}

export function rememberProfileId(id: number): void {
  try { localStorage.setItem(REMEMBERED_PROFILE_KEY, String(id)) } catch { /* ignore */ }
}

/** The startup sequence: the account's profiles, then the session's binding
 * (readSessionProfile), then resolveStartupProfile. Null when the profile list
 * cannot be read (profile features stay off) or the signal aborts.
 * askForProfile means the binding is unknown and there are several profiles:
 * the host opens the picker rather than guess. */
export async function loadStartupProfiles({ list, read, activate, remembered, signal, retryMs }: {
  list: () => Promise<Profile[]>
  read: () => Promise<Profile>
  activate: (id: number) => Promise<void>
  remembered: number | null
  signal?: AbortSignal
  retryMs?: number
}): Promise<{ profiles: Profile[]; activeId: number | null; askForProfile: boolean } | null> {
  // Both at once: neither depends on the other, and the catalog waits on them.
  const [profiles, acting] = await Promise.all([
    list().catch(() => null),
    readSessionProfile(read, retryMs),
  ])
  if (!profiles) return null
  if (signal?.aborted) return null
  const activeId = await resolveStartupProfile({ profiles, acting, remembered, activate, reread: read })
  if (signal?.aborted) return null
  return { profiles, activeId, askForProfile: activeId === null && profiles.length > 1 }
}

/** Reads the session's binding, retrying once after retryMs; null when both
 * reads fail. The binding is the one thing the app should not guess. */
export async function readSessionProfile(
  read: () => Promise<Profile>, retryMs = 1000,
): Promise<Profile | null> {
  try {
    return await read()
  } catch {
    await new Promise(resolve => setTimeout(resolve, retryMs))
    try { return await read() } catch { return null }
  }
}

/** Tabs share one session, so a switch in another tab moves this tab's
 * server binding too. Re-reads the binding whenever the tab comes back into
 * view and shows it, unless a switch is under way or started while the read
 * was in flight (that switch owns the answer). With reloadProfiles it also
 * re-lists the profiles each time, so a profile another device created or
 * edited (a new ceiling, name or PIN) shows as the server has it. */
export function useSessionProfileOnVisible({ enabled, profiles, read, setActiveProfileId, switching, reloadProfiles, setProfiles }: {
  enabled: boolean
  profiles: Profile[]
  read: () => Promise<Profile>
  setActiveProfileId: (update: (prev: number | null) => number | null) => void
  /** isSwitching and switchGeneration from useProfileSwitch. */
  switching: { isSwitching: () => boolean; switchGeneration: () => number }
  /** Lists the account's profiles again, and stores the list. */
  reloadProfiles?: () => Promise<Profile[]>
  setProfiles?: (profiles: Profile[]) => void
}) {
  const { isSwitching, switchGeneration } = switching
  useEffect(() => {
    if (!enabled) return
    const reread = () => {
      if (isSwitching()) return
      const generation = switchGeneration()
      const stale = () => isSwitching() || switchGeneration() !== generation
      const listed = reloadProfiles && setProfiles ? reloadProfiles().catch(() => null) : Promise.resolve(null)
      void Promise.all([read(), listed]).then(([acting, list]) => {
        if (!acting || stale()) return
        if (list) setProfiles?.(list)
        if (!(list ?? profiles).some(p => p.id === acting.id)) return
        setActiveProfileId(prev => (acting.id !== prev ? acting.id : prev))
      }).catch(() => { /* keep what we have */ })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') reread()
    }
    // A switch in another window of this browser records the profile it
    // showed (rememberProfileId), which fires here even while both windows
    // stay visible.
    const onStorage = (e: StorageEvent) => {
      if (e.key === REMEMBERED_PROFILE_KEY) reread()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('storage', onStorage)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('storage', onStorage)
    }
  }, [enabled, profiles, read, setActiveProfileId, isSwitching, switchGeneration, reloadProfiles, setProfiles])
}
