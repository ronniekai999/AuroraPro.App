// Unit tests for the cast-session tracker.
//
// This is the client half of the cast-lease fix, and it is the half that
// keeps a user from losing local playback: strand one clone per re-point and
// the 3-session-per-user cap is exhausted within a sitting, at which point
// the next mint 429s and ordinary playback starts failing too. Every
// assertion here is about exactly one thing — is each session released
// exactly once, never early, and never left behind?

import { describe, expect, it } from 'vitest'
import { createCastSessionTracker } from './castSession'

function tracker(local: string | null = 'local-1') {
  const released: string[] = []
  let localId = local
  const t = createCastSessionTracker({
    localSessionId: () => localId,
    release: id => released.push(id),
  })
  return { t, released, setLocal: (id: string | null) => { localId = id } }
}

describe('createCastSessionTracker', () => {
  it('starts with nothing committed', () => {
    const { t, released } = tracker()
    expect(t.committed()).toBeNull()
    expect(released).toEqual([])
  })

  it('does not commit a session until the receiver has taken it', () => {
    const { t, released } = tracker()
    t.notePending('clone-1')
    // Minted, not loaded: the keepalive ping and the teardown guard must not
    // see it yet.
    expect(t.committed()).toBeNull()
    t.commit()
    expect(t.committed()).toBe('clone-1')
    expect(released).toEqual([])
  })

  it('releases the outgoing clone when the receiver is re-pointed', () => {
    const { t, released } = tracker()
    t.notePending('clone-1'); t.commit()
    t.notePending('clone-2'); t.commit()

    expect(t.committed()).toBe('clone-2')
    expect(released).toEqual(['clone-1'])
  })

  it('releases one clone per re-point across a binge, never the newest', () => {
    const { t, released } = tracker()
    for (const id of ['ep1', 'ep2', 'ep3', 'ep4']) {
      t.notePending(id)
      t.commit()
    }
    expect(t.committed()).toBe('ep4')
    expect(released).toEqual(['ep1', 'ep2', 'ep3'])
  })

  // The failed-load hole: promoting at mint time left a session the receiver
  // never touched pinned by the keepalive for the rest of the viewing.
  it('releases a mint the receiver never took, and keeps the live one', () => {
    const { t, released } = tracker()
    t.notePending('clone-1'); t.commit()

    t.notePending('clone-2')
    t.abandon()

    expect(t.committed()).toBe('clone-1')
    expect(released).toEqual(['clone-2'])
  })

  it('abandon with nothing pending is a no-op', () => {
    const { t, released } = tracker()
    t.notePending('clone-1'); t.commit()
    t.abandon()
    expect(t.committed()).toBe('clone-1')
    expect(released).toEqual([])
  })

  it('releases both slots when the cast ends', () => {
    const { t, released } = tracker()
    t.notePending('clone-1'); t.commit()
    t.notePending('clone-2') // a re-point that was still in flight

    t.end()

    expect(t.committed()).toBeNull()
    expect(released.sort()).toEqual(['clone-1', 'clone-2'])
  })

  it('never releases twice, even if end() follows a failed load', () => {
    const { t, released } = tracker()
    t.notePending('clone-1'); t.commit()
    t.notePending('clone-2'); t.abandon()
    t.end()

    expect(released).toEqual(['clone-2', 'clone-1'])
    expect(new Set(released).size).toBe(released.length)
  })

  // The shared-session case: when no clone is needed the receiver streams the
  // SAME session as the local <video>. Releasing it here would delete the
  // session out from under local playback.
  describe('shared session (no clone)', () => {
    it('never releases the local session on commit', () => {
      const { t, released } = tracker('local-1')
      t.notePending('local-1')
      t.commit()

      expect(t.committed()).toBe('local-1')
      expect(released).toEqual([])
    })

    it('never releases the local session on end', () => {
      const { t, released } = tracker('local-1')
      t.notePending('local-1'); t.commit()
      t.end()
      expect(released).toEqual([])
    })

    // After a seek-rebuild the local session is a NEW id, so the shared
    // session the receiver still holds is no longer "local" and must be
    // released — this is the case that used to leak a whole session per
    // scrub.
    it('releases the old shared session once local playback has moved on', () => {
      const { t, released, setLocal } = tracker('local-1')
      t.notePending('local-1'); t.commit()

      setLocal('local-2') // seek rebuild booted a new local session
      t.notePending('clone-2'); t.commit()

      expect(t.committed()).toBe('clone-2')
      expect(released).toEqual(['local-1'])
    })
  })

  it('treats an unrecognized playlist shape as no cast session', () => {
    const { t, released } = tracker()
    t.notePending('clone-1'); t.commit()
    t.notePending(null)
    t.commit()
    // Nothing to promote, so the live session stays put rather than being
    // dropped on the floor.
    expect(t.committed()).toBe('clone-1')
    expect(released).toEqual([])
  })

  it('re-minting the same session replaces nothing', () => {
    const { t, released } = tracker()
    t.notePending('clone-1'); t.commit()
    t.notePending('clone-1'); t.commit()
    expect(t.committed()).toBe('clone-1')
    expect(released).toEqual([])
  })

  // Defensive branch: callers serialize their loads so a pending mint is
  // always resolved before the next one, but if that ever breaks, the
  // superseded mint must not be dropped silently — that is precisely the
  // leak this module exists to close.
  it('releases a pending mint that a second mint superseded', () => {
    const { t, released } = tracker()
    t.notePending('clone-1')
    t.notePending('clone-2')
    expect(released).toEqual(['clone-1'])
    t.commit()
    expect(t.committed()).toBe('clone-2')
  })
})
