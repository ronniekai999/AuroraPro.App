// Chrome-focus tracking for the player's auto-hide timer.
//
// THE BUG THIS FIXES (2026-08-09). The hide timer refuses to schedule while
// focus sits inside `[data-player-chrome]` — a guard added in Phase 7b (#389)
// so the chrome never goes `inert` out from under a KEYBOARD user parked on
// the seek bar (the HTML focus-fixup rule would dump activeElement to <body>
// and they'd lose their place, WCAG 2.4.3). But the guard read focus alone,
// not how it got there. A MOUSE user who clicked the fullscreen button (or
// dragged the volume slider — any natively focusable control) left focus
// sitting inside the chrome indefinitely: clicking the non-focusable video
// surface never moves it, and nothing blurred it. Every mousemove then
// evaluated `focusInChrome() === true`, so no hide timer was ever scheduled
// and the controls stayed visible forever — reported as "controls don't hide
// in fullscreen" because the fullscreen-button click is typically the last
// interaction before the viewer sits back.
//
// THE FIX. Gate the guard on input MODALITY, not focus alone: only focus
// that arrived via the keyboard pins the chrome. Mouse/touch focus is
// incidental — the pointer user has already moved on to watching — so it
// must not suppress auto-hide. This single gate covers every current and
// future focusable element inside the chrome (buttons, the volume range
// input, menu triggers) without per-element mousedown hacks, and leaves the
// keyboard path — the one the WCAG guard exists for — fully intact.

// Module scope, not React state: the hide timer's useCallback stays zero-dep,
// and the DOM/event stream is the source of truth here, not renders.
// Defaults to false (pointer assumed) so programmatic focus moves — like the
// theater opening focus landing on the overlay root — never read as keyboard.
let lastInteractionWasKeyboard = false

/** Capture-phase listeners record the modality of the most recent input.
 *  Capture, not bubble: the scrub bar's keydown handler stops propagation of
 *  arrow keys it consumes, and a bubble listener would miss exactly the
 *  keyboard events most likely to precede chrome focus. Returns an unbind. */
export function bindInputModalityTracking(win: Window): () => void {
  const onKey = () => { lastInteractionWasKeyboard = true }
  const onPointer = () => { lastInteractionWasKeyboard = false }
  win.addEventListener('keydown', onKey, true)
  win.addEventListener('pointerdown', onPointer, true)
  return () => {
    win.removeEventListener('keydown', onKey, true)
    win.removeEventListener('pointerdown', onPointer, true)
  }
}

/** True when focus currently sits inside a region that auto-hides with the
 *  controls AND it was the keyboard that put it there. Pointer-originated
 *  focus (a clicked button keeping focus afterwards) deliberately does not
 *  count — see the header comment. */
export function focusInChrome(): boolean {
  if (!lastInteractionWasKeyboard) return false
  const el = document.activeElement
  if (!el || el === document.body) return false
  return !!(el as Element).closest?.('[data-player-chrome]')
}

/** Test-only reset. The module flag is a process-wide input-modality record;
 *  suites that assert both modalities in one file need to re-seed it without
 *  dispatching synthetic events through jsdom's focus machinery first. */
export function __resetInputModalityForTests(): void {
  lastInteractionWasKeyboard = false
}
