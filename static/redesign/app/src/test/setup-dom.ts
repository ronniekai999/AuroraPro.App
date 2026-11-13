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

  // `scrollIntoView` was required while the search palette existed: its
  // highlight-follow effect called it on every arrow press, and removing this
  // stub failed four tests with "row?.scrollIntoView is not a function"
  // (whatever the prototype reports in isolation, it was not callable on the
  // elements under test). The palette is gone (the search page's arrow keys
  // move the real focus, lib/searchKeys.ts) and today's callers all use
  // `scrollIntoView?.()`, so nothing is known to need the stub now; it is
  // kept because jsdom still does not implement the method.
  //
  // The reviewer WAS right about the rest of the original comment, which claimed
  // `matchMedia` was also missing and that the title page's tab strip (since
  // removed) called `scrollIntoView`. Neither was true: it contained no such
  // call, and nothing under test called matchMedia. The matchMedia stub is kept only because the next component
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
