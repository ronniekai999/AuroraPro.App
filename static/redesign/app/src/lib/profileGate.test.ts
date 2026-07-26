// The "Who's watching?" gate's persistence half (Aurora Stage Phase 7b, D7).
//
// `shouldShowProfileGate`'s arithmetic is covered in components/contentViews.test.ts.
// This file covers the two localStorage helpers around it, which were untested
// and where six mutations survived a mutation pass:
//
//   markProfileGateSeen persists `false` instead of `true`   → the gate nags forever
//   markProfileGateSeen becomes a no-op                      → same, and it was a
//                                                              real user lockout
//   hasSeenProfileGate always returns false / always true    → gate always/never shows
//   hasSeenProfileGate's `=== true` weakened to truthiness   → any stored value counts
//   PROFILE_GATE_SEEN_KEY renamed (read/write key drift)     → silent, permanent nag
//
// The first two are the interesting ones: with the gate's `open` derived from
// localStorage on every render (as it originally was), a no-op write meant a
// full-viewport overlay with NO exit on a first visit — Escape is ignored when
// the gate wasn't opened by hand, and the "Keep watching as X" button isn't
// rendered either. The component now latches the dismissal in state so a failed
// write can't trap anyone, but the write still has to work for the gate to stay
// dismissed across a reload, and that is what these pin.
//
// Runs in vitest's default `node` environment, so localStorage is stubbed to the
// surface appearance.ts actually touches — same pattern as appearance.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
})

const { PROFILE_GATE_SEEN_KEY, hasSeenProfileGate, markProfileGateSeen } =
  await import('./profileGate')

const PREFS_KEY = 'aurora_prefs'

beforeEach(() => {
  store.clear()
})

describe('profile gate persistence', () => {
  it('is unseen on a fresh device', () => {
    expect(hasSeenProfileGate()).toBe(false)
  })

  it('round-trips: marking seen makes hasSeen true', () => {
    // Kills both "markProfileGateSeen is a no-op" and "persists false".
    markProfileGateSeen()
    expect(hasSeenProfileGate()).toBe(true)
  })

  it('writes true, not merely a truthy value, under the documented key', () => {
    // Kills the key-drift mutant: a renamed constant would still round-trip
    // through the two helpers, so asserting the round-trip alone is not enough —
    // the stored SHAPE has to be pinned, because App's other readers and the
    // pre-paint shim in main.tsx read this blob by name.
    markProfileGateSeen()
    const raw = store.get(PREFS_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string)).toMatchObject({ [PROFILE_GATE_SEEN_KEY]: true })
    expect(PROFILE_GATE_SEEN_KEY).toBe('profile_gate_seen')
  })

  it('requires exactly `true` — a truthy stored value does not count as seen', () => {
    // Kills the `=== true` → truthy-coercion mutant. This matters because the
    // blob is shared and hand-edited in devtools, and because a legacy V1 value
    // of 1 or "yes" should be treated as "not answered by THIS policy" rather
    // than silently suppressing the gate forever.
    for (const junk of [1, 'true', 'yes', {}, []]) {
      store.set(PREFS_KEY, JSON.stringify({ [PROFILE_GATE_SEEN_KEY]: junk }))
      expect(hasSeenProfileGate()).toBe(false)
    }
    store.set(PREFS_KEY, JSON.stringify({ [PROFILE_GATE_SEEN_KEY]: true }))
    expect(hasSeenProfileGate()).toBe(true)
  })

  it('preserves the rest of the prefs blob', () => {
    // The flag shares `aurora_prefs` with the appearance dials, the autoplay
    // toggle and player_volume. It must merge, not overwrite — the read has to
    // happen at write time, which is why it routes through writePrefKey.
    store.set(PREFS_KEY, JSON.stringify({ font_choice: 'nova', player_volume: 0.4 }))
    markProfileGateSeen()
    expect(JSON.parse(store.get(PREFS_KEY) as string)).toEqual({
      font_choice: 'nova',
      player_volume: 0.4,
      [PROFILE_GATE_SEEN_KEY]: true,
    })
  })

  it('treats a malformed blob as unseen rather than throwing', () => {
    store.set(PREFS_KEY, '{not json')
    expect(hasSeenProfileGate()).toBe(false)
    // And a write over a malformed blob still succeeds, replacing it.
    markProfileGateSeen()
    expect(hasSeenProfileGate()).toBe(true)
  })

  it('does not throw when the write is denied', () => {
    // Safari private mode / quota full. The pref is lost — the component's
    // in-state latch is what keeps the gate dismissable for the session — but a
    // throw here would take the whole click handler down with it.
    const denied = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => { throw new DOMException('QuotaExceededError') },
      removeItem: () => {},
      clear: () => {},
    }
    vi.stubGlobal('localStorage', denied)
    try {
      expect(() => markProfileGateSeen()).not.toThrow()
      expect(hasSeenProfileGate()).toBe(false)
    } finally {
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
      })
    }
  })
})
