// The party this browser was last in, kept so that "You were just in" on
// Together can offer one press back after leaving by mistake, reloading the
// tab, or coming back a little later.
//
// One record per signed-in user AND profile. localStorage belongs to the
// browser, not to a person: without the user in the key the next person to
// sign in would be offered the last one's party, and without the profile a
// switch between two profiles of one account showed the other profile's
// party, by name and code.
//
// Kept for an hour:
//   - A party ends when its last person leaves, so an old code points at
//     nothing.
//   - Rooms are the lasting thing (/api/rooms); this is "I was just here".
//   - Anything older reads as a history, which this is not.

/** The single key every record used to share. A record under it names no
 *  profile, so it is not read; it is removed when a new one is written. */
const OLD_KEY = 'aurora_last_party'
const TTL_MS = 60 * 60 * 1000 // 1 hour

/** A profile id, or null for an account with no profile. */
type ProfileId = number | null | undefined

const keyFor = (userId: number, profileId: ProfileId) => `aurora_last_party:${userId}:${profileId ?? 0}`

export interface LastPartyEntry {
  code: string
  partyName?: string
  mediaTitle?: string
  // When the person last joined or left this party, as an ISO string.
  touchedAt: string
  // Whose record this is. Also in the key; checked on read all the same.
  userId: number
  // Was this person the party's host? Decides what "Rejoin" is said to do.
  wasHost: boolean
}

/**
 * The record for this user and profile, or null when there is none, it is
 * older than an hour, or it cannot be read.
 *
 * The profile is the one the session acts as, the same value the writer is
 * given (App hands both the same state), so the two agree by construction.
 * Null is an account with no profile, or a session whose profile is not
 * known yet. Never the profile this browser "remembers": that one only
 * steers startup, and can be a profile from an earlier sign-in.
 */
export function readLastParty(currentUserId: number | undefined, profileId: ProfileId = null): LastPartyEntry | null {
  if (!currentUserId) return null
  const key = keyFor(currentUserId, profileId)
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LastPartyEntry
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.userId !== currentUserId) return null
    const t = Date.parse(parsed.touchedAt)
    if (!Number.isFinite(t) || Date.now() - t > TTL_MS) {
      try { localStorage.removeItem(key) } catch { /* defensive */ }
      return null
    }
    return parsed
  } catch {
    // Not a record: removed, so the next read does not trip on it again.
    try { localStorage.removeItem(key) } catch { /* defensive */ }
    return null
  }
}

/**
 * Write the record. Called by the party hook when a party is joined (so a
 * reload has somewhere to go back to) and when it is left (so a leave by
 * mistake can be undone), with the profile the session acts as.
 *
 * Best effort: a browser that refuses the write (no room, private mode) loses
 * a convenience and nothing else.
 */
export function cacheLastParty(entry: Omit<LastPartyEntry, 'touchedAt'> & { touchedAt?: string }, profileId: ProfileId = null): void {
  if (!entry.userId || !entry.code) return
  try {
    const full: LastPartyEntry = {
      ...entry,
      touchedAt: entry.touchedAt ?? new Date().toISOString(),
    }
    localStorage.setItem(keyFor(entry.userId, profileId), JSON.stringify(full))
    localStorage.removeItem(OLD_KEY)
  } catch {
    /* defensive */
  }
}

/** Forget the record: the party it names turned out to be gone. */
export function clearLastParty(userId: number | undefined, profileId: ProfileId = null): void {
  if (!userId) return
  try { localStorage.removeItem(keyFor(userId, profileId)) } catch { /* defensive */ }
}

/** Whether a `storage` event is about a last-party record (another tab of
 *  this browser joined or left a party). */
export const isLastPartyKey = (key: string | null): boolean => key === null || key.startsWith('aurora_last_party:')
