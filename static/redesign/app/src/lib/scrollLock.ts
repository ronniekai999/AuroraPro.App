// One ref-counted body scroll lock, shared by every overlay that needs one.
//
// Three surfaces lock `body.style.overflow` independently: the theater (D6),
// the "Who's watching?" gate, and TopNav's mobile sheet. Each used to do its own
// save-prev / set-hidden / restore-prev, which composes ONLY if the locks
// release in LIFO order. They don't have to:
//
//   1. body overflow is '' (the stylesheet's overflow-x:hidden computes
//      overflow-y:auto).
//   2. A locks:  prevA = ''       → 'hidden'
//   3. B locks:  prevB = 'hidden' → 'hidden'
//   4. A releases FIRST: restores '' → the page scrolls freely while B still
//      needs it locked. During the theater that means wheeling the dimmed,
//      un-clickable app around behind a stationary player — the exact symptom
//      the lock exists to prevent.
//   5. B releases: restores 'hidden' → body is now PERMANENTLY overflow:hidden.
//      No lock is left to clear it; the app is unscrollable until a reload.
//
// Restore-prev is not the fix for multi-lock composition — it converts an
// under-lock into a permanent over-lock. A counter is the fix: the first lock
// records the pre-lock value, the last one out restores it, and the order the
// holders release in stops mattering.

let depth = 0
let saved: string | null = null

/**
 * Locks body scrolling and returns the release function. Idempotent per
 * handle — calling the returned function twice decrements once, so a React
 * effect cleanup that runs in a double-invoked StrictMode pass can't unbalance
 * the counter.
 */
export function lockBodyScroll(): () => void {
  if (depth === 0) {
    saved = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  depth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    depth -= 1
    if (depth === 0) {
      document.body.style.overflow = saved ?? ''
      saved = null
    }
  }
}

/** Test seam — the counter is module state, so suites must be able to zero it. */
export function __resetScrollLockForTests(): void {
  depth = 0
  saved = null
}

/** Test seam. */
export function scrollLockDepth(): number {
  return depth
}
