// THE RULE: a "cast"/"receiver" claim may come only from `cast_clone_of`.
// `cast_held` may never produce one.
//
// Why: Safari and iOS put a minted cast token on the local <video> src
// because native HLS cannot authenticate by cookie (#317), so ordinary local
// playback in those browsers sets `cast_held` with no receiver anywhere.
// Rendering it as casting mislabels a large share of ordinary viewers —
// recreating the "why are there two mystery rows" confusion that the cast
// pairing exists to end.
//
// An earlier version of this file tried to enforce that by regexing
// AdminView.tsx. A review demonstrated two bypasses against the real file:
// `!isReceiverSession(s) && s.cast_held && '· Casting'` passed (the negation
// read as receiver evidence), and the Sessions-tab badge was never scanned at
// all (its JSX expression contains nested braces). Modelling the shape of
// markup does not work. So the rule now lives where the strings are produced
// — castRoles + castLabel in lib/activeStreams — and this pins the strings
// themselves. AdminView renders castLabel()'s output verbatim.
//
// The honest residual: nothing stops a future edit from hardcoding "Casting"
// in JSX instead of calling castLabel. What this does guarantee is that the
// labels the app actually has are correct, which the regex did not.

import { describe, expect, it } from 'vitest'
import { castLabel, castRoles, isReceiverRole } from './activeStreams'
import type { CastRole } from './activeStreams'

type Row = { id: string; user_id: number; cast_clone_of?: string; cast_held?: boolean }
const row = (id: string, over: Partial<Row> = {}): Row => ({ id, user_id: 7, ...over })

const ALL_ROLES: CastRole[] = [
  'receiver-nested',
  'receiver-source-missing',
  'receiver-source-unpaired',
  'driving',
  'lease',
  'none',
]

// "cast", "casting", "casts", "receiver" — the words that assert a TV.
const CAST_WORDING = /\b(cast|casting|casts|receiver|receivers)\b/i

describe('castLabel wording', () => {
  it('never claims a cast or a receiver for a lease', () => {
    // The whole point. `lease` is the role of every Safari/iOS viewer.
    const l = castLabel('lease')
    expect(l.detail).not.toMatch(CAST_WORDING)
    expect(l.description).not.toMatch(CAST_WORDING)
    expect(l.badge).not.toBe('Cast')
  })

  it('claims a receiver for every receiver role', () => {
    // Guards the rule above against the degenerate satisfaction of removing
    // all cast wording everywhere.
    for (const role of ALL_ROLES.filter(isReceiverRole)) {
      const l = castLabel(role)
      expect(l.detail, role).toMatch(CAST_WORDING)
      expect(l.description, role).toMatch(CAST_WORDING)
      expect(l.badge, role).toBe('Cast')
    }
  })

  it('gives every role a label, so an unhandled role cannot render blank', () => {
    for (const role of ALL_ROLES) {
      const l = castLabel(role)
      expect(l, role).toBeTruthy()
      if (l.badge) expect(l.description, role).not.toBe('')
    }
  })

  it('says nothing at all for an ordinary stream', () => {
    expect(castLabel('none')).toEqual({ detail: '', badge: null, description: '' })
  })

  // A receiver whose source is right there in the table must not be described
  // as having a missing source — an operator can see otherwise.
  it('distinguishes a missing source from a present-but-unpaired one', () => {
    expect(castLabel('receiver-source-missing').detail).toMatch(/gone/)
    expect(castLabel('receiver-source-unpaired').detail).not.toMatch(/gone/)
    expect(castLabel('receiver-source-unpaired').description).not.toMatch(/no longer active/)
  })
})

describe('castRoles', () => {
  it('classifies a live cast pair', () => {
    const roles = castRoles([
      row('local'),
      row('tv', { cast_clone_of: 'local', cast_held: true }),
      row('guest'),
    ])
    expect(roles.get('local')).toBe('driving')
    expect(roles.get('tv')).toBe('receiver-nested')
    expect(roles.get('guest')).toBe('none')
  })

  it('does not call the source "driving" until a receiver has fetched', () => {
    // A clone minted but never loaded (load_failed, a receiver stall — what
    // castSession's abandon() exists for) leaves the local element playing.
    const roles = castRoles([row('local'), row('tv', { cast_clone_of: 'local' })])
    expect(roles.get('local')).toBe('none')
    expect(roles.get('tv')).toBe('receiver-nested')
  })

  it('marks an orphaned clone as a receiver whose source is gone', () => {
    // The ordinary end of a cast: the sender closed the tab, the TV plays on.
    const roles = castRoles([row('tv', { cast_clone_of: 'local-gone', cast_held: true })])
    expect(roles.get('tv')).toBe('receiver-source-missing')
  })

  it('marks a cross-owner clone as unpaired, not as source-gone', () => {
    // An admin casting another user's session. The source IS in the table and
    // is very much alive, so "source session gone" would be visibly false.
    const roles = castRoles([
      row('viewer-local', { user_id: 42 }),
      row('admin-tv', { user_id: 1, cast_clone_of: 'viewer-local', cast_held: true }),
    ])
    expect(roles.get('admin-tv')).toBe('receiver-source-unpaired')
    expect(roles.get('viewer-local')).toBe('none')
  })

  it('never calls a Safari/iOS local session a receiver', () => {
    // cast_held with no cast_clone_of — the shape this whole rule protects.
    const roles = castRoles([row('safari', { cast_held: true })])
    expect(roles.get('safari')).toBe('lease')
    expect(isReceiverRole(roles.get('safari')!)).toBe(false)
  })

  it('treats a self-reference as a receiver with no usable source', () => {
    const roles = castRoles([row('a', { cast_clone_of: 'a', cast_held: true })])
    expect(roles.get('a')).toBe('receiver-source-missing')
  })

  it('degrades to plain rows when the server sends no cast fields', () => {
    const roles = castRoles([row('a'), row('b')])
    expect([...roles.values()]).toEqual(['none', 'none'])
  })

  it('classifies every row it is given', () => {
    const rows = [
      row('local'),
      row('tv', { cast_clone_of: 'local', cast_held: true }),
      row('safari', { cast_held: true }),
      row('guest'),
    ]
    expect(castRoles(rows).size).toBe(rows.length)
  })
})
