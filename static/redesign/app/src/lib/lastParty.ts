// Aurora V2 — last-party cache.
//
// Persists the most-recently-joined or -left party code in localStorage
// so the join modal can offer a one-click "Rejoin {CODE}" affordance
// after the user accidentally leaves, refreshes the tab, or comes back
// later.
//
// The cache is per-user (userId stored inside the value) so a stale
// entry from user A doesn't show in user B's modal after a logout/
// login cycle. TTL is short (1 hour) because:
//   - Quick parties die immediately when the host explicitly leaves,
//     so a stale code points to a tombstoned room past the host-grace
//     window (90s server-side).
//   - Persistent rooms are a separate concern handled by /api/rooms;
//     this cache is for the "I just was here" case, not "rooms I own."
//   - Anything older than ~1h is more confusing than useful — if a
//     user joined a party last week, surfacing it as "rejoin" creates
//     the wrong mental model (this is a session memory, not a history).

const STORAGE_KEY = 'aurora_last_party'
const TTL_MS = 60 * 60 * 1000 // 1 hour

export interface LastPartyEntry {
  code: string
  partyName?: string
  mediaTitle?: string
  // When the user last interacted (joined OR left) with this party.
  // Stored as ISO string for serialization; read paths Date.parse it.
  touchedAt: string
  // Owner of this cache entry. localStorage is per-origin not per-user,
  // so on the same browser two users could otherwise see each other's
  // last party. The read path validates userId matches.
  userId: number
  // Was the user the host of this party? Drives UX wording — for hosts,
  // "Rejoin" actually means "start a new party in the same room" if the
  // room was persistent, OR "the party ended — start fresh?" if it was
  // a quick-party. The modal uses this to set expectations.
  wasHost: boolean
}

/**
 * Read the cached last-party entry, scoped to the current user.
 * Returns null when:
 *   - nothing is cached
 *   - the entry is for a different user (post-logout/login leak guard)
 *   - the entry is older than TTL_MS
 *   - the entry is corrupted JSON (best-effort silent clear)
 */
export function readLastParty(currentUserId: number | undefined): LastPartyEntry | null {
  if (!currentUserId) return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LastPartyEntry
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.userId !== currentUserId) return null
    const t = Date.parse(parsed.touchedAt)
    if (!Number.isFinite(t) || Date.now() - t > TTL_MS) {
      // Expired — opportunistically clear so subsequent reads short-circuit.
      try { localStorage.removeItem(STORAGE_KEY) } catch { /* defensive */ }
      return null
    }
    return parsed
  } catch {
    // Corrupted entry — wipe so we don't keep hitting the catch every
    // read.
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* defensive */ }
    return null
  }
}

/**
 * Write the cache. Called from useParty on successful join (so a
 * mid-session refresh has a rejoin target) and on leave (so the user
 * can undo an accidental leave).
 *
 * Best-effort: localStorage write failures (quota, private-browsing
 * restrictions, etc.) are silently swallowed since the cache is a
 * convenience, not load-bearing.
 */
export function cacheLastParty(entry: Omit<LastPartyEntry, 'touchedAt'> & { touchedAt?: string }): void {
  if (!entry.userId || !entry.code) return
  try {
    const full: LastPartyEntry = {
      ...entry,
      touchedAt: entry.touchedAt ?? new Date().toISOString(),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(full))
  } catch {
    /* defensive — quota / private-browsing / DOM exception */
  }
}

/**
 * Drop the cache. Called when the user explicitly dismisses the
 * rejoin pill or when a rejoin attempt confirms the party is gone
 * (so we don't keep prompting them to click a dead link).
 */
export function clearLastParty(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* defensive */ }
}
