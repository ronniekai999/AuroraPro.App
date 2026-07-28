// Type-only registration of jest-dom's matchers (Phase 11.1).
//
// `expect(el).toHaveFocus()` and friends are added to vitest's `expect` at RUNTIME
// by setup-dom.ts, which imports them dynamically so the 140 node-environment
// tests never load DOM code. TypeScript cannot see a dynamic import's side
// effects, so `tsc -b` failed on every matcher — 166 tests green, build red.
//
// `@testing-library/jest-dom/vitest` exists precisely to augment vitest's
// `Assertion` interface. Referenced here as a side-effect import in a .d.ts, so it
// contributes types only and never reaches the bundle.
import '@testing-library/jest-dom/vitest'
