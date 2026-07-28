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

  // jsdom implements neither of these, and both are called on mount by code under
  // test: `scrollIntoView` by SearchPalette's highlight-follow effect and
  // DetailTabs' tab strip, `matchMedia` by the reduced-motion checks. Unstubbed
  // they throw and the failure looks like a component bug rather than a jsdom gap.
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
