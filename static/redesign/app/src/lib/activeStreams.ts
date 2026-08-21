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
  /** Who owns the session. Nesting is same-owner only: an admin can mint a
   *  cast token against another user's session, which produces a clone owned
   *  by the admin whose `cast_clone_of` points at the viewer's session. Those
   *  are two independent people watching, and folding them together would
   *  both under-count and file the admin's TV under the viewer's name. */
  user_id: number
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

/**
 * Nest each receiver session under the session it was cloned from.
 *
 * The pairing rule is ONE level and is mirrored exactly by castPairable in
 * internal/streaming/streaming.go, which feeds the Active Streams tile. Keep
 * them in step: a divergence renders as a header contradicting the list under
 * it. A clone folds into its source only when all of these hold —
 *
 *  - the source is in the list. A clone whose source is gone stays top-level:
 *    that is the ordinary end state of a cast (the browser closed, the TV
 *    plays on) and it is a real stream someone is watching, so hiding it or
 *    counting it as zero would under-report live playback.
 *  - the source belongs to the SAME user. See CastPairable.user_id — an admin
 *    casting someone else's session is the one way the server produces a
 *    cross-owner pair, and those are two independent viewers.
 *  - the source is itself a root, not another clone. This is what keeps a
 *    single lookup total: chains and cycles need no special case, they simply
 *    do not fold. Requiring a transitive walk instead is what let the Go and
 *    TypeScript sides answer a cycle differently — Go folding a live stream
 *    to zero while this side showed two rows. Neither shape is reachable
 *    (CloneForCast only clones a local session, and an id can only point at a
 *    session that already existed), so the cheaper rule wins.
 *
 * Input order is preserved for groups and within each group's clones. That
 * keeps a clone adjacent to its source, but it is NOT list stability:
 * /api/admin/sessions ranges a Go map, so the underlying order already
 * changes between polls and neither caller sorts.
 */
export function groupCastStreams<T extends CastPairable>(rows: T[]): StreamGroup<T>[] {
  const byId = new Map<string, T>()
  for (const r of rows) byId.set(r.id, r)

  // The row this one files under, or null if it is a group of its own.
  const sourceOf = (row: T): T | null => {
    if (!row.cast_clone_of) return null
    const src = byId.get(row.cast_clone_of)
    if (!src || src === row) return null
    if (src.cast_clone_of) return null // source is itself a clone
    if (src.user_id !== row.user_id) return null // different viewer
    return src
  }

  const groups: StreamGroup<T>[] = []
  const groupById = new Map<string, StreamGroup<T>>()
  // Two passes: every root becomes a group before any clone is filed, so a
  // clone listed BEFORE its source still lands under it (the API's order is
  // a Go map iteration — effectively random, and it changes every poll).
  const roots = new Map<string, T | null>()
  for (const row of rows) roots.set(row.id, sourceOf(row))
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
