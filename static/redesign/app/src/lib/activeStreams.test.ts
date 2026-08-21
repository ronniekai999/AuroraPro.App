// The bug these pin: casting one movie to a TV showed up on the admin
// dashboard as two identical "transcode" rows for the same user and file —
// the paused local session and the receiver's cast-safe clone — with nothing
// to tell them apart. Grouping restores "one row per viewer" without hiding
// the clone, which an operator still needs to see (its FFmpeg is the one
// actually burning CPU).

import { describe, expect, it } from 'vitest'
import { groupCastStreams } from './activeStreams'

type Row = { id: string; user_id: number; cast_clone_of?: string; cast_held?: boolean }
// Same owner unless a test says otherwise — a cast pair is one person's.
const row = (id: string, over: Partial<Row> = {}): Row => ({ id, user_id: 7, ...over })
const groupIds = (rows: Row[]) => groupCastStreams(rows).map(g => g.row.id)

describe('groupCastStreams', () => {
  it('nests the receiver session under the local session driving it', () => {
    // The live case: rontavious999 casting Halloweentown, plus a party guest.
    const rows = [
      row('local'),
      row('tv', { cast_clone_of: 'local', cast_held: true }),
      row('guest'),
    ]
    const groups = groupCastStreams(rows)
    expect(groups.map(g => g.row.id)).toEqual(['local', 'guest'])
    expect(groups[0].castRows.map(r => r.id)).toEqual(['tv'])
    expect(groups[1].castRows).toEqual([])
  })

  it('counts a cast pair as one stream', () => {
    expect(groupIds([
      row('local'),
      row('tv', { cast_clone_of: 'local' }),
      row('guest'),
    ])).toEqual(['local', 'guest'])
  })

  it('keeps a clone top-level once its source is gone', () => {
    // The ordinary end of a cast: the browser closed, the TV plays on. That
    // is someone watching something, so it must stay visible and counted.
    const groups = groupCastStreams([row('tv', { cast_clone_of: 'local-gone', cast_held: true })])
    expect(groups.map(g => g.row.id)).toEqual(['tv'])
    expect(groups[0].castRows).toEqual([])
  })

  it('does not pair a clone with a source owned by someone else', () => {
    // An admin can mint a cast token against another user's session, which
    // produces a clone owned by the ADMIN pointing at the viewer's session.
    // Two independent viewers: folding them would under-count, and would
    // file the admin's TV under the viewer's name and avatar.
    const groups = groupCastStreams([
      row('viewer-local', { user_id: 42 }),
      row('admin-tv', { user_id: 1, cast_clone_of: 'viewer-local', cast_held: true }),
    ])
    expect(groups.map(g => g.row.id)).toEqual(['viewer-local', 'admin-tv'])
    expect(groups.every(g => g.castRows.length === 0)).toBe(true)
  })

  it('files a clone under its source even when it is listed first', () => {
    // /api/admin/sessions iterates a Go map, so row order is arbitrary and
    // changes on every 5-second poll.
    const groups = groupCastStreams([row('tv', { cast_clone_of: 'local' }), row('local')])
    expect(groups.map(g => g.row.id)).toEqual(['local'])
    expect(groups[0].castRows.map(r => r.id)).toEqual(['tv'])
  })

  it('groups both clones of a mid-re-point sender under one row', () => {
    // A next-episode advance or token renewal can briefly leave two clones
    // against one local session. Both are shown — a third that never clears
    // is the leak lib/castSession.ts exists to prevent, and hiding them
    // would hide it too.
    const groups = groupCastStreams([
      row('local'),
      row('tv-1', { cast_clone_of: 'local' }),
      row('tv-2', { cast_clone_of: 'local' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].castRows.map(r => r.id)).toEqual(['tv-1', 'tv-2'])
  })

  // As on the server, this is the ROOT condition doing the work — a
  // self-referencing row's source is itself, which is not a root. The
  // explicit `src === row` check in sourceOf is redundant intent, not
  // something this test kills.
  it('does not lose or loop on a self-referencing row', () => {
    const groups = groupCastStreams([row('a', { cast_clone_of: 'a' }), row('b')])
    expect(groups.map(g => g.row.id)).toEqual(['a', 'b'])
  })

  it('does not lose or loop on a cycle', () => {
    const groups = groupCastStreams([
      row('a', { cast_clone_of: 'b' }),
      row('b', { cast_clone_of: 'a' }),
    ])
    expect(groups.map(g => g.row.id)).toEqual(['a', 'b'])
    expect(groups.every(g => g.castRows.length === 0)).toBe(true)
  })

  // The rule is one level: a clone folds only into a source that is itself a
  // root. A chain therefore folds its first link and stops — no transitive
  // walk, no cycle special-case, and the same answer castPairable gives in
  // internal/streaming/streaming.go (mirrored by
  // TestActiveStreamCount_MirrorsTheClientGroupingRule). Unreachable in
  // practice: CloneForCast only ever clones a local session.
  it('folds only the first link of a chain, matching the server rule', () => {
    const groups = groupCastStreams([
      row('root'),
      row('mid', { cast_clone_of: 'root' }),
      row('leaf', { cast_clone_of: 'mid' }),
    ])
    expect(groups.map(g => g.row.id)).toEqual(['root', 'leaf'])
    expect(groups[0].castRows.map(r => r.id)).toEqual(['mid'])
    expect(groups[1].castRows).toEqual([])
  })

  it('degrades to a flat list when the server sends no pairing fields', () => {
    // A bundle can run ahead of the binary serving it; the pre-existing
    // one-row-per-session rendering is the correct fallback.
    const rows = [row('a'), row('b'), row('c')]
    const groups = groupCastStreams(rows)
    expect(groups.map(g => g.row.id)).toEqual(['a', 'b', 'c'])
    expect(groups.every(g => g.castRows.length === 0)).toBe(true)
  })

  it('returns nothing for an empty list', () => {
    expect(groupCastStreams([])).toEqual([])
  })
})
