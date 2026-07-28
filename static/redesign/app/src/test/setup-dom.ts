// Vitest setup — runs before EVERY test file, DOM or not (Phase 11.1).
//
// `setupFiles` is not environment-aware: it executes for the 140 node-environment
// pure-function tests as well as the jsdom ones. Everything here therefore has to
// be guarded on a DOM actually existing, or the fast path breaks.

import { afterEach, expect } from 'vitest'

const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined'

if (hasDom) {
  // `@testing-library/jest-dom` v6+ ships a vitest entry point that registers the
  // custom matchers (toHaveAttribute, toHaveFocus, …) onto vitest's own expect.
  // Imported dynamically so the node-environment files never load it.
  const matchers = await import('@testing-library/jest-dom/matchers')
  expect.extend(matchers.default ?? matchers)

  const { cleanup } = await import('@testing-library/react')
  // Testing Library auto-cleans only when it detects a global afterEach, which it
  // does NOT when `globals: false` (this project's setting — the tests import
  // describe/it/expect explicitly). Without this, every render leaks into the next
  // test's document and `getByRole` starts matching elements from a previous test.
  afterEach(() => { cleanup() })

  // `scrollIntoView` IS required. A reviewer measured `Element.prototype
  // .scrollIntoView` as a native function under jsdom 30 and concluded this block
  // was dead code with a false rationale. Removing it fails four tests with
  // "row?.scrollIntoView is not a function" — SearchPalette's highlight-follow
  // effect calls it on every arrow press. Whatever the prototype reports in
  // isolation, it is not callable on the elements under test here, so the guard
  // fires and the stub is what keeps the keyboard tests running.
  //
  // The reviewer WAS right about the rest of the original comment, which claimed
  // `matchMedia` was also missing and that DetailTabs calls `scrollIntoView`.
  // Neither is true: DetailTabs contains no such call, and nothing under test
  // calls matchMedia. The matchMedia stub is kept only because the next component
  // to be tested here will need it, and it is now labelled as forward-looking
  // rather than as a fix for a problem that exists.
  //
  // Known hole either way: jsdom's scrollIntoView is a NO-OP, so the effect is
  // exercised but its EFFECT is not asserted. Deleting the call from the component
  // survives this suite. Accepted, not papered over.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {}
  }
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
  }
}
