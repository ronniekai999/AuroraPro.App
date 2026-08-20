// The bug these pin: casting one movie to a TV showed up on the admin
// dashboard as two identical "transcode" rows for the same user and file —
// the paused local session and the receiver's cast-safe clone — with nothing
// to tell them apart. Grouping restores "one row per viewer" without hiding
// the clone, which an operator still needs to see (its FFmpeg is the one
// actually burning CPU).

import { describe, expect, it } from 'vitest'
import { groupCastStreams, streamCount } from './activeStreams'

type Row = { id: string; cast_clone_of?: string; cast_held?: boolean }
const row = (id: string, over: Partial<Row> = {}): Row => ({ id, ...over })

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
    expect(streamCount([
      row('local'),
      row('tv', { cast_clone_of: 'local' }),
      row('guest'),
    ])).toBe(2)
  })

  it('keeps a clone top-level once its source is gone', () => {
    // The ordinary end of a cast: the browser closed, the TV plays on. That
    // is someone watching something, so it must stay visible and counted.
    const groups = groupCastStreams([row('tv', { cast_clone_of: 'local-gone', cast_held: true })])
    expect(groups.map(g => g.row.id)).toEqual(['tv'])
    expect(groups[0].castRows).toEqual([])
    expect(streamCount([row('tv', { cast_clone_of: 'local-gone' })])).toBe(1)
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

  it('flattens a longer chain onto its root rather than dropping links', () => {
    const groups = groupCastStreams([
      row('root'),
      row('mid', { cast_clone_of: 'root' }),
      row('leaf', { cast_clone_of: 'mid' }),
    ])
    expect(groups.map(g => g.row.id)).toEqual(['root'])
    expect(groups[0].castRows.map(r => r.id)).toEqual(['mid', 'leaf'])
  })

  it('degrades to a flat list when the server sends no pairing fields', () => {
    // A bundle can run ahead of the binary serving it; the pre-existing
    // one-row-per-session rendering is the correct fallback.
    const rows = [row('a'), row('b'), row('c')]
    const groups = groupCastStreams(rows)
    expect(groups.map(g => g.row.id)).toEqual(['a', 'b', 'c'])
    expect(streamCount(rows)).toBe(3)
  })

  it('returns nothing for an empty list', () => {
    expect(groupCastStreams([])).toEqual([])
    expect(streamCount([])).toBe(0)
  })
})
