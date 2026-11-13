// Edges that are the only visible sign of a control must reach 3:1 against
// what is around them (WCAG 1.4.11). The app's hairline token, --line-strong,
// is a decoration between surfaces (1.46:1 to 1.76:1 on them) and is the
// natural thing to reach for; this holds the listed controls to an edge that
// can be seen.
//
// Each entry names a control, the class its edge is drawn with and the
// surfaces it meets. What this script checks about the class is only that the
// file still uses it; that it is on the control itself is pinned by that
// control's own unit test (for the PIN boxes, ProfilePinDialog.test.tsx),
// which is the stronger of the two. The classes are READ FROM THE SOURCE: an entry whose
// class is no longer there fails as out of date, not as passing. The colours
// are the token values in index.css.

import fs from 'node:fs'

const css = fs.readFileSync('src/index.css', 'utf8')
const token = name => {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`))
  if (!m) throw new Error(`verify: no --${name} in src/index.css — this check is out of date, not passing`)
  return m[1]
}
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = h => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) }
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }

const EDGES = [
  {
    what: 'an empty PIN box (the profile unlock prompt)',
    file: 'src/components/ProfilePinDialog.tsx',
    // The edge an empty, unfocused, error-free box is drawn with.
    edgeClass: 'border-ink-3', edgeToken: 'ink-3',
    // The box's own fill, and the dialog it sits on.
    surfaces: [['bg-surface-raised', 'surface-raised'], ['bg-surface-raised-2', 'surface-raised-2']],
  },
]

const NEED = 3
let problems = 0
console.log('## Control edges that must be seen (3:1)')
for (const e of EDGES) {
  const src = fs.readFileSync(e.file, 'utf8')
  const has = cls => new RegExp(`(^|[\\s'"\`])${cls.replace(/[-/[\]]/g, '\\$&')}($|[\\s'"\`])`).test(src)
  for (const cls of [e.edgeClass, ...e.surfaces.map(s => s[0])]) {
    if (!has(cls)) throw new Error(`verify: ${e.file} no longer uses ${cls} — this check is out of date, not passing`)
  }
  for (const [, surface] of e.surfaces) {
    const c = contrast(token(e.edgeToken), token(surface))
    const ok = c >= NEED
    if (!ok) problems++
    console.log(`  ${e.what}: --${e.edgeToken} on --${surface}  ${c.toFixed(2)}:1  (need ${NEED})  ${ok ? 'PASS' : '*** FAIL'}`)
  }
}
console.log(`\n${problems} control-edge problem(s).`)
process.exit(problems ? 1 : 0)
