// Which surface the player reports (Aurora Stage Phase 7b, D5/D6).
//
// Eight inputs, exhaustively — not a boundary sample. App drives <main>'s dim +
// inert + scroll lock off this value, so a wrong answer is not cosmetic: report
// 'theater' for a minimized cast widget and the entire app is left dimmed,
// unscrollable and unclickable with no visible player to close it.

import { describe, expect, it } from 'vitest'
import { playerSurface } from './playerSurface'

describe('playerSurface', () => {
  it('covers all eight (hasTarget, minimized, fullscreen) combinations', () => {
    // The whole domain as a table. Every row is reachable: `hasTarget` is
    // App's playerTarget, and minimized/fullscreen are independent booleans that
    // both go through transient both-true states (casting auto-minimizes and
    // force-exits browser fullscreen, but those are separate commits).
    const table: [boolean, boolean, boolean, ReturnType<typeof playerSurface>][] = [
      [false, false, false, null],
      [false, false, true, null],
      [false, true, false, null],
      [false, true, true, null],
      [true, false, false, 'theater'],
      [true, false, true, 'fullscreen'],
      [true, true, false, 'minimized'],
      [true, true, true, 'minimized'],
    ]
    for (const [hasTarget, minimized, fullscreen, expected] of table) {
      expect(
        playerSurface(hasTarget, minimized, fullscreen),
        `hasTarget=${hasTarget} minimized=${minimized} fullscreen=${fullscreen}`,
      ).toBe(expected)
    }
  })

  it('reports null whenever nothing is playing, whatever the other two say', () => {
    // Pins the un-inert contract: `null` is what tells App to release the dim,
    // the inert attribute and the scroll lock. If `hasTarget` stopped
    // short-circuiting, closing the player mid-fullscreen would report
    // 'fullscreen' forever and never release them.
    for (const minimized of [true, false]) {
      for (const fullscreen of [true, false]) {
        expect(playerSurface(false, minimized, fullscreen)).toBeNull()
      }
    }
  })

  it('ranks minimized above fullscreen', () => {
    // The ordering that makes the transient minimized+fullscreen state safe. If
    // fullscreen were consulted first, the cast hand-off would report a
    // full-viewport player during the gap while the surface is actually a small
    // widget — and App would dim and inert the app behind nothing.
    expect(playerSurface(true, true, true)).toBe('minimized')
  })

  it('ranks fullscreen above theater', () => {
    // Theater is the fallthrough, not a peer: it must be what you get when
    // neither of the other two applies, so a new mode added above it cannot be
    // silently shadowed.
    expect(playerSurface(true, false, true)).toBe('fullscreen')
    expect(playerSurface(true, false, false)).toBe('theater')
  })
})
