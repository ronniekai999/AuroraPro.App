// Vitest configuration — exists solely to pin the test-run timezone.
//
// WHY A NON-UTC ZONE. The calendar's date math is deliberately UTC-consistent
// (Audit M3) and contentViews.test.ts asserts so. But this container and any
// default CI runner have TZ unset, i.e. UTC, where a local-time implementation
// and a UTC one are indistinguishable — so those assertions could not fail.
// Mutating todayUTC() to getFullYear/getMonth/getDate left the entire suite
// green. America/New_York is UTC-4/-5, so a timestamp at 01:30Z falls on the
// previous local day and the two implementations diverge observably. Picking a
// DST zone is deliberate: it also exercises the offset changing across the year.
//
// WHY A SEPARATE FILE, not a `test` block in vite.config.ts. A `test` block
// there needs `defineConfig` from `vitest/config`, which ships its own nested
// copy of vite; the react plugin then types as the outer vite's `Plugin` and is
// unassignable to the nested vite's `PluginOption`, so `tsc -b` fails while
// `npm test` goes green. This file dodges that because tsconfig.node.json
// includes only `vite.config.ts`, so nothing typechecks this one — and
// mergeConfig keeps the build config (aliases, plugins, base) as the source of
// truth rather than duplicating it here.
//
// WHY NOT the npm script. `TZ=… vitest run` in package.json only covers people
// who type `npm test`. A bare `npx vitest run`, `vitest --watch`, or an IDE test
// runner bypasses it, and the module-scope guard in contentViews.test.ts then
// turns the whole file into a COLLECTION error — which reports as
// "Tests 55 passed (55)" with the 15 tests simply absent. Green-looking, and
// exactly the failure mode the guard exists to prevent. Config travels with the
// project, so every entry point gets the pin.
import { mergeConfig, defineConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      env: { TZ: 'America/New_York' },
    },
  }),
)
