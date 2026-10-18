// Which profile the app shows at startup. The server's session binding decides
// what every ceiling enforces (issue #462), so the app shows that binding, and
// changes it only through the server.
//
// The remembered id (localStorage) matters after a new login, which binds the
// account default: the app re-selects the profile this browser last used, but
// only an unlocked one, and only once the server has accepted the switch. A
// locked one waits for its PIN like any other switch.

import type { Profile } from './api'

// A session acting as a profile with a ceiling may not manage profiles: the
// server refuses creating, deleting, re-defaulting, PIN changes, and edits to
// any other profile or to its own ceiling. The UI hides those controls.
export function isRestrictedProfile(p: Pick<Profile, 'max_age_rating'> | null | undefined): boolean {
  return !!p?.max_age_rating?.trim()
}

export async function resolveStartupProfile({ profiles, acting, remembered, activate }: {
  profiles: Profile[]
  /** The session's binding, or null when it could not be read. */
  acting: Pick<Profile, 'id'> | null
  /** The profile id this browser last showed. */
  remembered: number | null
  /** Binds a profile server-side; rejects when the server refuses. */
  activate: (id: number) => Promise<void>
}): Promise<number | null> {
  if (profiles.length === 0) return null
  let next = acting && profiles.some(p => p.id === acting.id) ? acting.id : null
  const want = remembered ? profiles.find(p => p.id === remembered) : undefined
  if (want && want.id !== next && !want.has_pin) {
    try {
      await activate(want.id)
      next = want.id
    } catch { /* keep the server's binding */ }
  }
  // The binding is unknown only when it could not be read. Showing the default
  // then cannot loosen anything: the server enforces its binding, whatever the
  // app displays.
  if (next === null) next = (profiles.find(p => p.is_default) || profiles[0]).id
  return next
}
