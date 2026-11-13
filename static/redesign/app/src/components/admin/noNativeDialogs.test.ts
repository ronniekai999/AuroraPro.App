// The admin page asks and answers in its own dialog and its own words. The
// browser's confirm and alert boxes block the whole tab, cannot be styled or
// read with the page, and a confirm that outlives the admin area (a switch to
// a profile without admin powers) still sends what it asked about. This reads
// every source file under this folder and fails on a call to either.
//
// A lint of source text, not of behaviour: it does not see a call made
// through another name (`const ask = window.confirm; ask('…')` is caught only
// at the assignment, and `const w = window; w.confirm(…)` not at all) or
// from a file outside this folder. Nor does it look at the browser's own
// leave-this-page check (a `beforeunload` listener), which no admin source
// holds now: a restore runs on the server and outlives the page.
import { describe, expect, it } from 'vitest'

const SOURCES = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

// `window.confirm`, `window?.alert`, `window['prompt']`, `globalThis.alert`,
// and a bare `confirm(` / `alert(` / `prompt(` that is not a method or part
// of a longer name (`onConfirm(`, `x.alert(`, `confirmRetype(`).
const NATIVE = /\b(?:window|globalThis|self|top|parent)\s*(?:\?\.|\.)\s*(?:confirm|alert|prompt)\b|\b(?:window|globalThis|self|top|parent)\s*(?:\?\.)?\s*\[\s*['"`](?:confirm|alert|prompt)['"`]\s*\]|(?<![\w$.])(?:confirm|alert|prompt)\s*\(/

/** Each line that calls a native box, as `file:line`. Comments are read too:
 *  a mention in prose is reworded rather than exempted. */
export function nativeDialogCalls(sources: Record<string, string>): string[] {
  const found: string[] = []
  for (const [file, text] of Object.entries(sources)) {
    text.split('\n').forEach((line, i) => { if (NATIVE.test(line)) found.push(`${file}:${i + 1}`) })
  }
  return found
}

describe('the admin page', () => {
  it('reads the files it means to', () => {
    // The check is of something: the page and its helpers are among them.
    expect(Object.keys(SOURCES)).toEqual(expect.arrayContaining(['./AdminView.tsx', './AdminShell.tsx', './ManualMatchModal.tsx']))
  })

  it('calls no native confirm or alert box', () => {
    expect(nativeDialogCalls(SOURCES)).toEqual([])
  })

  it('would see one', () => {
    expect(nativeDialogCalls({
      a: 'if (!window.confirm(`Delete?`)) return',
      b: "window.alert('Saved')",
      c: '  alert("x")',
      d: 'catch { confirm("sure?") }',
      e: 'globalThis.alert(1)',
      f: 'if (window?.confirm("x")) go()',
      g: "window['alert']('x')",
      h: 'const name = prompt("Name?")',
      i: 'window?.["prompt"]("x")',
      j: 'top.confirm("x")',
      k: "parent['alert']('x')",
    })).toEqual(['a:1', 'b:1', 'c:1', 'd:1', 'e:1', 'f:1', 'g:1', 'h:1', 'i:1', 'j:1', 'k:1'])
    expect(nativeDialogCalls({
      f: 'onConfirm={() => { void confirmRetype() }}',
      g: 'role="alert"',
      h: 'setAlert(x); props.confirm(1); usePrompt()',
      i: "window.addEventListener('beforeunload', askBeforeLeaving)",
    })).toEqual([])
  })
})
