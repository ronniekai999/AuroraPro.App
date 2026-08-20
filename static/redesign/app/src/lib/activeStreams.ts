// Pairing for the admin Active Streams / Now Playing surfaces.
//
// Casting to a Chromecast is ONE person watching ONE title, but it is two
// server sessions: the local browser session — force-paused the instant the
// receiver connects, its encoder stopped 75s later by the idle reaper — and
// the cast-safe clone CloneForCast makes for the TV (it clones for any
// subtitle track, any remux, and any Dolby audio, so cloning is the normal
// path, not the exception). Both rows carry the same user, the same file and
// the same "transcode" badge, so the admin dashboard showed a solo viewer as
// two identical streams and read as a session leak.
//
// The server now says which is which (`cast_clone_of`, `cast_held`). This
// turns that into the shape the UI renders: one row per viewer, with the
// receiver's session nested under the browser session that is driving it.
//
// Lives here rather than in AdminView because two surfaces need it (the
// dashboard widget and the Sessions tab) and because the orphan/cycle rules
// below are worth pinning in a unit test rather than re-deriving in JSX.

/** The subset of ActiveStreamRow this module needs. Structural so both the
 *  real API row and a test fixture satisfy it. */
export interface CastPairable {
  id: string
  /** Session this row was cloned from for a receiver; absent on ordinary
   *  sessions. Older servers omit it entirely — everything degrades to a
   *  flat list, which is exactly the pre-existing behavior. */
  cast_clone_of?: string
}

export interface StreamGroup<T> {
  /** The row an operator should read as "this stream". */
  row: T
  /** Receiver sessions playing from `row`, in input order. Usually 0 or 1;
   *  briefly 2 during a re-point (next episode, token renewal), which is
   *  worth SEEING rather than hiding — a third that never goes away is the
   *  clone leak lib/castSession.ts exists to prevent. */
  castRows: T[]
}

// A clone chain should never exceed one link — the sender always clones from
// the LOCAL session, never from a clone. The walk is bounded anyway, because
// a malformed chain must not hang the admin dashboard.
const MAX_CHAIN = 8

/**
 * Nest each receiver session under the session it was cloned from.
 *
 * Rules that matter, all of them cases the live server actually produces:
 *
 *  - A clone whose source is NOT in the list stays top-level. That is the
 *    ordinary end state of a cast — the local player closes, the TV keeps
 *    playing — and it is a real stream someone is watching. Hiding it, or
 *    counting it as zero, would under-report live playback.
 *  - A self-referencing or cyclic `cast_clone_of` degrades to top-level
 *    rather than looping. The server does not emit either (the shared-
 *    session path leaves `cast_clone_of` unset precisely so a session is
 *    never its own parent), which is why this is a floor, not a feature.
 *  - Input order is preserved for groups and within each group's clones, so
 *    a 5-second poll cannot reshuffle the list under the operator's cursor.
 */
export function groupCastStreams<T extends CastPairable>(rows: T[]): StreamGroup<T>[] {
  const byId = new Map<string, T>()
  for (const r of rows) byId.set(r.id, r)

  // Resolve the row a clone should be filed under: walk up until a row with
  // no (resolvable) source is found. Returns null when the row is itself a
  // root, when the chain leaves the list, or when it loops.
  const rootOf = (row: T): T | null => {
    const seen = new Set<string>([row.id])
    let cur = row
    for (let i = 0; i < MAX_CHAIN; i++) {
      const parentId = cur.cast_clone_of
      if (!parentId) return cur === row ? null : cur
      if (seen.has(parentId)) return null // cycle (includes self-reference)
      const parent = byId.get(parentId)
      if (!parent) return cur === row ? null : cur // chain leaves the list
      seen.add(parentId)
      cur = parent
    }
    return null
  }

  const groups: StreamGroup<T>[] = []
  const groupById = new Map<string, StreamGroup<T>>()
  // Two passes: every root becomes a group before any clone is filed, so a
  // clone listed BEFORE its source still lands under it (the API's order is
  // a Go map iteration — effectively random, and it changes every poll).
  const roots = new Map<string, T | null>()
  for (const row of rows) roots.set(row.id, rootOf(row))
  for (const row of rows) {
    if (roots.get(row.id)) continue
    const g: StreamGroup<T> = { row, castRows: [] }
    groups.push(g)
    groupById.set(row.id, g)
  }
  for (const row of rows) {
    const root = roots.get(row.id)
    if (!root) continue
    groupById.get(root.id)?.castRows.push(row)
  }
  return groups
}

/** How many streams an operator is actually looking at — the count that
 *  belongs beside "Now Playing", and the client-side mirror of the server's
 *  ActiveStreamCount. */
export function streamCount<T extends CastPairable>(rows: T[]): number {
  return groupCastStreams(rows).length
}
