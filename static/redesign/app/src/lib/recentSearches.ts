// The last few things a profile searched for, kept in this browser so the
// search page can offer them again. A convenience of this browser only: the
// server never sees the list, and it is kept apart for each account and
// profile, so one profile is not shown what another looked for.
//
// A search is remembered when the viewer does something with it (opens or
// plays a result, or asks for a search by description), not for every
// keystroke that ran one.

const MAX = 8
const key = (owner: string) => `aurora_recent_searches:${owner}`

/** The remembered searches, newest first; empty when there are none or the
 *  browser's storage cannot be read. */
export function readRecentSearches(owner: string): string[] {
  try {
    const raw = localStorage.getItem(key(owner))
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, MAX) : []
  } catch {
    return []
  }
}

/** Puts `words` at the head of the list and returns the list as it now is.
 *  The same words in another case move up rather than appear twice; fewer
 *  than two characters are not a search worth offering again. */
export function rememberSearch(owner: string, words: string): string[] {
  const said = words.trim()
  const before = readRecentSearches(owner)
  if (said.length < 2) return before
  const next = [said, ...before.filter(w => w.toLowerCase() !== said.toLowerCase())].slice(0, MAX)
  try { localStorage.setItem(key(owner), JSON.stringify(next)) } catch { /* private mode, a full store: not kept */ }
  return next
}

export function forgetRecentSearches(owner: string): void {
  try { localStorage.removeItem(key(owner)) } catch { /* nothing to forget */ }
}

/** Forgets what every profile of an account searched for in this browser:
 *  what signing out does. (A session that merely expires leaves them, as it
 *  leaves the My Library snapshot: the same person signs in again.) Owners
 *  are `<user id>:<profile id or "none">`. */
export function forgetAccountRecentSearches(userId: number): void {
  try {
    const prefix = key(`${userId}:`)
    const mine: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) mine.push(k)
    }
    for (const k of mine) localStorage.removeItem(k)
  } catch { /* nothing to forget */ }
}
