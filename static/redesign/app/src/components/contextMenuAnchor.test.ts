// Where a context menu anchors (Aurora Stage Phase 9).
//
// This exists because the bug it pins is INVISIBLE to a mouse-driven manual pass,
// which is exactly how it shipped and survived several reviews. Browsers fire a
// real `contextmenu` event for Shift+F10 and the Menu key on a focused element —
// so the menu opened for keyboard users all along — but a keyboard-generated
// event carries clientX/clientY of 0, so it appeared pinned to the viewport's
// top-left corner instead of on the card it acts on. Every pointer test passes
// either way; only the keyboard case distinguishes them.

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

  it('falls back to the element box when the event reports 0/0 (Shift+F10, Menu key)', () => {
    // The regression case. Without the fallback this returned {x:0, y:0} and the
    // menu rendered in the corner of the screen, detached from the card.
    expect(anchorFor({ clientX: 0, clientY: 0, currentTarget: rect(240, 560) }))
      .toEqual({ x: 240, y: 560 })
  })

  it('does not treat a near-origin pointer click as keyboard-driven', () => {
    // Only exactly 0/0 counts. A click one pixel in is still a click.
    expect(anchorFor({ clientX: 1, clientY: 0, currentTarget: rect(64, 200) }))
      .toEqual({ x: 1, y: 0 })
    expect(anchorFor({ clientX: 0, clientY: 1, currentTarget: rect(64, 200) }))
      .toEqual({ x: 0, y: 1 })
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
