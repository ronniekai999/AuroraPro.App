import { describe, expect, it } from 'vitest'

// The browser's own alert, confirm and prompt boxes are not the app's: they
// stop every script on the page, cannot be styled, read or focused the app's
// way, and carry whatever text they are handed (the server's own words, as
// several did). The app asks with its own dialog (components/settings/
// ConfirmDialog) and says failures in its own words (lib/failureWords).
//
// Files still being moved off them. Empty once every one is done: a file
// that no longer uses one must leave this list (the second test says so).
const NOT_YET_DONE = new Set<string>([
  'components/admin/AdminView.tsx',
])

/** Every source file of the app, as text (tests excluded), by its path
 *  under src. */
function sources(): [string, string][] {
  const files = import.meta.glob(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  return Object.entries(files).map(([path, text]) => [path.replace(/^\.\//, ''), text])
}

/** Comments blanked, so a sentence about a box is not a box. Strings are
 *  kept: `window['alert']` is in one. */
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

/** A native box, however it is reached: `window.alert(`, `window?.confirm(`,
 *  `window['prompt']`, `globalThis.alert(`, or a bare `alert(`. A method of
 *  the app's own named the same (the install prompt's `prompt()`, declared
 *  or called on an object) is not one. It reads text: an alias made
 *  elsewhere (`const ask = window.confirm`) is caught where it is made, a
 *  name built at run time is not. */
const NATIVE = [
  /\b(?:window|globalThis|self|top|parent)\s*(?:\?\.|\.)\s*(?:alert|confirm|prompt)\b/,
  /\b(?:window|globalThis|self|top|parent)\s*(?:\?\.)?\[\s*['"`](?:alert|confirm|prompt)['"`]\s*\]/,
  /(?<![.\w$])(?:alert|confirm|prompt)\s*\([^()]*\)(?!\s*[:{])/,
]
const usesNative = (text: string) => NATIVE.some(re => re.test(withoutComments(text)))

describe('no native alert, confirm or prompt boxes', () => {
  it('none is used in the app\'s sources, outside the files still being moved off them', () => {
    const all = sources()
    expect(all.length).toBeGreaterThan(100)
    expect(all.filter(([path, text]) => !NOT_YET_DONE.has(path) && usesNative(text)).map(([path]) => path)).toEqual([])
  })

  it('every file still listed still uses one (take it off the list when it no longer does)', () => {
    const byPath = new Map(sources())
    for (const path of NOT_YET_DONE) {
      expect(byPath.has(path), `${path} is not a source file`).toBe(true)
      expect(usesNative(byPath.get(path)!), `${path} no longer uses a native box`).toBe(true)
    }
  })

  it('sees each way of reaching one, and not a method of the app\'s own', () => {
    for (const box of ['window.alert("x")', 'window?.confirm("x")', "window['prompt']('x')", 'window?.["alert"]("x")', 'globalThis.confirm("x")', 'if (!confirm("x")) return', 'alert(`x`)', 'const ask = window.confirm']) {
      expect(usesNative(box), box).toBe(true)
    }
    for (const not of ['async prompt() {', '  prompt(): Promise<void>', 'await e.prompt()', 'deferred.prompt()', 'onConfirm()', 'setAlert(true)', '// window.alert("x")', '/* confirm("x") */']) {
      expect(usesNative(not), not).toBe(false)
    }
  })
})
