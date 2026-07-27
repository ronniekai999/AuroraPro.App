// Where a context menu anchors (Aurora Stage Phase 9).
//
// ⚠️ READ THIS BEFORE TRUSTING THE COVERAGE. The premise these tests were written
// to prove is FALSE in Chromium. Two reviewers measured it independently
// (Chromium 141, real Shift+F10 and Menu-key events on a focused card):
//
//     Shift+F10    clientX=340 clientY=360  detail=0  button=-1  buttons=0
//     Menu key     clientX=340 clientY=360  detail=0  button=-1  buttons=0
//     right-click  clientX=300 clientY=350  detail=0  button=2   buttons=2
//
// 340/360 is the element's CENTRE. Chromium never reports 0/0, so the fallback
// branch is unreachable there and the keyboard menu was already anchored on the
// card before any of this. The "falls back to the element box" case below
// therefore exercises a branch production does not take in the app's target
// browser — green tests over an impossible domain, which is the third time this
// project has hit that exact failure mode.
//
// The tests are kept because the function is kept: it is a defensive fallback for
// an engine that reports unusable 0/0 (plausibly WebKit, unmeasured — only
// Chromium is installed here), and because the pointer case below is genuinely
// load-bearing. It caught a real bug on its first run, described there.
// What is NOT claimed any more is that this fixes something in Chromium.

import { describe, expect, it } from 'vitest'
import { anchorFor } from './ContextMenu'

const rect = (left: number, bottom: number) => ({
  getBoundingClientRect: () => ({ left, bottom }),
})

describe('anchorFor', () => {
  it('uses the pointer position for a mouse-driven contextmenu', () => {
    // This case is why `detail` is not consulted. A real right-click reports
    // `detail: 0` on a contextmenu event — unlike a click, where detail is the
    // click count — so an implementation that treated detail:0 as "keyboard"
    // anchored EVERY mouse open to the card instead of the cursor. This test
    // caught exactly that on the first run.
    expect(anchorFor({ clientX: 412, clientY: 300, currentTarget: rect(10, 99) }))
      .toEqual({ x: 412, y: 300 })
  })

  it('falls back to the element box when an engine reports unusable 0/0 coords', () => {
    // NOT reachable in Chromium — see the header. This pins the defensive branch's
    // behaviour, not a browser fact.
    expect(anchorFor({ clientX: 0, clientY: 0, currentTarget: rect(240, 560) }))
      .toEqual({ x: 240, y: 560 })
  })

  it('ignores `detail` entirely — the trap that the first test suite could not see', () => {
    // A reviewer proved the previous suite could not catch reintroducing
    // `detail === 0` as a keyboard signal: no fixture set `detail`, so
    // `undefined === 0` was false and the mutant passed all five tests AND tsc.
    // These two rows kill it. A real right-click reports `detail: 0` just as
    // Shift+F10 does — that is the whole reason it cannot be the discriminator —
    // so a pointer event carrying detail:0 must still anchor at the cursor.
    expect(anchorFor({ clientX: 412, clientY: 300, detail: 0, currentTarget: rect(10, 99) }))
      .toEqual({ x: 412, y: 300 })
    // And detail must not force the fallback off either: coords still decide.
    expect(anchorFor({ clientX: 0, clientY: 0, detail: 1, currentTarget: rect(240, 560) }))
      .toEqual({ x: 240, y: 560 })
  })

  it('leaves Chromium\'s real keyboard coordinates alone', () => {
    // The measured Chromium case: Shift+F10 on a card at left:240 top:300
    // right:440 bottom:420 reports the element's centre. Those coordinates are
    // usable, so they must pass straight through — anchoring to the box instead
    // would MOVE the menu from the card's centre to its bottom-left, which is a
    // change for the worse, not a fix. This is the assertion that stops someone
    // "simplifying" the guard to a keyboard test like `button === -1`.
    expect(anchorFor({ clientX: 340, clientY: 360, currentTarget: rect(240, 420) }))
      .toEqual({ x: 340, y: 360 })
  })

  it('treats ONLY exactly 0/0 as unusable — above and below', () => {
    // A click one pixel in is still a click.
    expect(anchorFor({ clientX: 1, clientY: 0, currentTarget: rect(64, 200) }))
      .toEqual({ x: 1, y: 0 })
    expect(anchorFor({ clientX: 0, clientY: 1, currentTarget: rect(64, 200) }))
      .toEqual({ x: 0, y: 1 })
    // And the boundary is pinned from BELOW too, which it was not: the comment
    // here used to claim "only exactly 0/0 counts" while a `<= 0` mutant survived,
    // because no fixture went negative. Negative viewport coords are reachable for
    // a dispatched event, and they are still coordinates.
    expect(anchorFor({ clientX: -5, clientY: -5, currentTarget: rect(64, 200) }))
      .toEqual({ x: -5, y: -5 })
  })

  it('degrades to the raw coordinates when there is no element to measure', () => {
    // A synthetic event, or a target already detached. Better to open in the
    // corner than to throw inside a context-menu handler.
    expect(anchorFor({ clientX: 0, clientY: 0, currentTarget: null })).toEqual({ x: 0, y: 0 })
    expect(anchorFor({ clientX: 0, clientY: 0 })).toEqual({ x: 0, y: 0 })
    expect(anchorFor({ clientX: 0, clientY: 0, currentTarget: {} })).toEqual({ x: 0, y: 0 })
  })

  it('anchors to the BOTTOM-left, not the top-left, of the element', () => {
    // A menu that drops from the top edge covers the card it describes. Pinning
    // the axis so a future "simplification" to `rect.top` is caught.
    expect(anchorFor({ clientX: 0, clientY: 0, currentTarget: rect(100, 380) }).y).toBe(380)
  })
})
