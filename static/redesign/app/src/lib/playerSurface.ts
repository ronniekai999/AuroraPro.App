// Which surface the player is presenting.
//
// Extracted from VideoPlayer so the precedence can be tested without a DOM. It
// looks like a formality and isn't: App makes `<main>` inert and locks its
// scroll off this value, so getting it backwards means a minimized cast
// widget reports 'theater' and leaves the whole app unscrollable and
// unclickable with no visible player to close.
//
// 'theater' is the name for "in the window": the picture edge to edge, or
// boxed beside the party panel. Either way the page behind is covered.

export type PlayerSurface = 'theater' | 'fullscreen' | 'minimized'

/**
 * `minimized` outranks `fullscreen` outranks `theater`.
 *
 * The minimized-first order is what makes the transient `minimized && fullscreen`
 * state safe: casting auto-minimizes and force-exits browser fullscreen, but the
 * two flips are separate commits, and during the gap the app must NOT be treated
 * as if a full-viewport player were covering it.
 *
 * Returns null when nothing is playing, which is also the value the host reads
 * as "un-inert everything".
 */
export function playerSurface(
  hasTarget: boolean,
  minimized: boolean,
  fullscreen: boolean,
): PlayerSurface | null {
  if (!hasTarget) return null
  if (minimized) return 'minimized'
  if (fullscreen) return 'fullscreen'
  return 'theater'
}
