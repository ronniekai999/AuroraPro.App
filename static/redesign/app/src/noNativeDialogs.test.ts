import { describe, expect, it } from 'vitest'

// The browser's own alert, confirm and prompt boxes are not the app's: they
// stop every script on the page, cannot be styled, read or focused the app's
// way, and carry whatever text they are handed (the server's own words, as
// several did). The app asks with its own dialog (components/settings/
// ConfirmDialog) and says failures in its own words (lib/failureWords).
//
// Files still being moved off them. Nothing is exempt now: every file has
// been moved off them, the Admin page last. The list stays so that a file
// put on it must leave it once it no longer uses one (the second test says
// so); adding one means a native box has come back.
const NOT_YET_DONE = new Set<string>([])

/** Every source file of the app, as text (tests excluded), by its path
 *  under src. */
function sources(): [string, string][] {
  const files = import.meta.glob(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  return Object.entries(files).map(([path, text]) => [path.replace(/^\.\//, ''), text])
}

/**
 * The source with its comments blanked (newlines kept), read the way the
 * language reads it: a `/*` inside a line comment or a string is not a
 * comment's start (a path glob such as /api/stream/* in a line comment used
 * to blank everything to the next block comment's end), quotes and
 * template literals (with their `${…}` parts) are strings, kept as they are
 * (`window['alert']` is in one), and a regular expression literal is skipped
 * whole, so a quote or a slash inside one starts nothing. A regular
 * expression is told from a division by what comes before the slash; a
 * quoted string that runs to the end of its line is ended there. JSX text
 * is read as code (a quote in it would open a string to the line's end).
 */
function withoutComments(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  // What a `/` means depends on the last thing that was not space.
  let last = ''
  // Open template literals: -1 while in the template's own text, else the
  // brace depth inside its current `${…}` part.
  const templates: number[] = []
  const readString = (quote: string) => {
    let s = quote
    i++
    while (i < n) {
      const c = text[i]
      if (c === '\\') { s += text.slice(i, i + 2); i += 2; continue }
      if (c === '\n') break
      s += c
      i++
      if (c === quote) break
    }
    return s
  }
  // Template text from i to its closing backtick or its next `${`.
  const readTemplate = () => {
    let s = ''
    while (i < n) {
      const c = text[i]
      if (c === '\\') { s += text.slice(i, i + 2); i += 2; continue }
      if (c === '`') { s += c; i++; templates.pop(); return s }
      if (c === '$' && text[i + 1] === '{') { s += '${'; i += 2; templates[templates.length - 1] = 0; return s }
      s += c
      i++
    }
    return s
  }
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (c === '\'' || c === '"') { out += readString(c); last = c; continue }
    if (c === '`') { out += '`'; i++; templates.push(-1); out += readTemplate(); last = '`'; continue }
    if (templates.length && templates[templates.length - 1] >= 0) {
      if (c === '{') templates[templates.length - 1]++
      else if (c === '}') {
        if (templates[templates.length - 1] === 0) {
          out += '}'
          i++
          templates[templates.length - 1] = -1
          out += readTemplate()
          last = '`'
          continue
        }
        templates[templates.length - 1]--
      }
    }
    if (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(out.trimEnd()))) {
      // A regular expression literal, to its closing slash on this line.
      let s = '/'
      let j = i + 1
      let inClass = false
      while (j < n && text[j] !== '\n') {
        const d = text[j]
        if (d === '\\') { s += text.slice(j, j + 2); j += 2; continue }
        s += d
        j++
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
      }
      out += s
      i = j
      last = '/'
      continue
    }
    out += c
    if (!/\s/.test(c)) last = c
    i++
  }
  return out
}

/** Where the parenthesis opened at `open` closes, strings and nesting
 *  counted; -1 when it does not. */
function closing(code: string, open: number): number {
  let depth = 0
  for (let j = open; j < code.length; j++) {
    const c = code[j]
    if (c === '\'' || c === '"' || c === '`') {
      const q = c
      for (j++; j < code.length && code[j] !== q; j++) if (code[j] === '\\') j++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  return -1
}

/** A native box, however it is reached: `window.alert(`, `window?.confirm(`,
 *  `window['prompt']`, `globalThis.alert(`, the same through a cast
 *  (`(window as any).confirm(`), an alias made of one (`const ask =
 *  window.confirm`), or a bare `alert(…)` with anything in its parentheses.
 *  A method of the app's own named the same (the install prompt's
 *  `prompt()`, declared, or called on an object) is not one.
 *
 *  It reads text, so it does not see: a destructured alias
 *  (`const { confirm: ask } = window`), `confirm.bind(window)` handed on,
 *  `window[key]` with a computed key, or any name built at run time. And
 *  the scanner reads JSX text as code: a `//` in JSX text would hide a call
 *  later on that line, a `/*` everything to the next `*\/` (no source has
 *  either today; the per-file probes below would show one that hid code
 *  there). */
function usesNative(text: string): boolean {
  const code = withoutComments(text)
  if (/\b(?:window|globalThis|self|top|parent)\s*(?:\?\.|\.)\s*(?:alert|confirm|prompt)\b/.test(code)) return true
  if (/\b(?:window|globalThis|self|top|parent)\s*(?:\?\.)?\[\s*['"`](?:alert|confirm|prompt)['"`]\s*\]/.test(code)) return true
  // Through a cast: `(window as any).confirm(`, `(window as Win)['alert']`.
  if (/\(\s*(?:window|globalThis|self|top|parent)\s+as\s+[^()]*\)\s*(?:(?:\?\.|\.)\s*(?:alert|confirm|prompt)\b|(?:\?\.)?\[\s*['"`](?:alert|confirm|prompt)['"`]\s*\])/.test(code)) return true
  for (const m of code.matchAll(/(?<![.\w$])(?:alert|confirm|prompt)\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const end = closing(code, open)
    // A declaration: `prompt(): …` or `prompt() {`.
    if (end !== -1 && /^\s*[:{]/.test(code.slice(end + 1))) continue
    // `async prompt()` and the like: a method being declared.
    if (/\b(?:async|get|set|static)\s+$/.test(code.slice(0, m.index))) continue
    return true
  }
  return false
}

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
    for (const box of [
      'window.alert("x")', 'window?.confirm("x")', "window['prompt']('x')", 'window?.["alert"]("x")', 'globalThis.confirm("x")',
      'if (!confirm("x")) return', 'alert(`x`)', 'const ask = window.confirm',
      // Nested parentheses, and a template with a call inside.
      'if (!confirm(String(n))) return', 'alert(`gone: ${name(x)}`)',
      // Through a cast.
      '(window as any).confirm("x")', "(window as unknown as Win)['alert']('x')", '(globalThis as Record<string, unknown>)?.prompt',
    ]) {
      expect(usesNative(box), box).toBe(true)
    }
    for (const not of ['async prompt() {', '  prompt(): Promise<void>', 'await e.prompt()', 'deferred.prompt()', 'onConfirm()', 'setAlert(true)', '// window.alert("x")', '/* confirm("x") */', 'const s = "a // b"']) {
      expect(usesNative(not), not).toBe(false)
    }
  })

  // The traps that hid real code from the stripping that came before.
  it('is not blinded by what only looks like a comment', () => {
    // A path glob in a line comment, before a real call on a later line.
    expect(usesNative('// streams under /api/stream/*\nconst a = 1\nwindow.confirm("Leave?")\n/* a real comment */')).toBe(true)
    // A string that looks like a comment's start or end.
    expect(usesNative('const glob = "/api/*"\nwindow.alert("x")\nconst end = "*/"')).toBe(true)
    expect(usesNative('const url = "https://x.test"\nconfirm("x")')).toBe(true)
    // A template literal with a comment's start in it.
    expect(usesNative('const t = `/* ${a} */`\nalert("x")')).toBe(true)
    // A regular expression with a quote, a backtick or a slash pair in it.
    expect(usesNative('const re = /[\'"`]/g\nconst u = /https?:\\/\\//\nwindow.prompt("x")')).toBe(true)
    // And a real block comment still hides what is in it.
    expect(usesNative('/* window.confirm("x") */\nconst a = 1')).toBe(false)
  })

  // Where the stripping that came before went blind (a glob in a line
  // comment blanked hundreds of lines): a box put on a line of real code
  // there is seen. Each file's line is the first statement at or after the
  // one named.
  it.each([
    ['components/VideoPlayer.tsx', 200],
    ['components/VideoPlayer.tsx', 4160],
    ['components/BugReportForm.tsx', 400],
    ['components/DetailView.tsx', 400],
    ['lib/streaming.ts', 60],
  ])('sees a box put into %s near line %i', (path, near) => {
    const text = new Map(sources()).get(path)!
    expect(text, path).toBeTruthy()
    const lines = text.split('\n')
    let at = near
    while (at < lines.length && !/^\s*(?:const|let|if|return)\b/.test(lines[at])) at++
    expect(at, `no statement after line ${near} in ${path}`).toBeLessThan(lines.length)
    const withBox = [...lines.slice(0, at), '  if (Date.now() < 0) window.confirm("Leave?")', ...lines.slice(at)].join('\n')
    expect(usesNative(text)).toBe(false)
    expect(withoutComments(withBox).split('\n')[at]).toContain('window.confirm("Leave?")')
    expect(usesNative(withBox)).toBe(true)
  })

  // Every file keeps its length and its newlines, and nothing changes but
  // to spaces. That alone would pass with code blanked too (blanked code is
  // spaces as well): what pins that no code is blanked is the per-file
  // probes above, a box on a statement line that the stripped text keeps.
  it('keeps every line of every file, and changes nothing but to spaces', () => {
    for (const [path, text] of sources()) {
      const code = withoutComments(text)
      expect(code.length, path).toBe(text.length)
      for (let k = 0; k < text.length; k++) {
        if (code[k] !== text[k] && (code[k] !== ' ' || text[k] === '\n')) throw new Error(`${path}: changed at ${k}`)
      }
    }
  })
})
