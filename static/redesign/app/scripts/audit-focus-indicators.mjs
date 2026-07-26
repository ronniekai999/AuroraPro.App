// Guard against the project's most-repeated bug: a control that suppresses the
// global :focus-visible outline and supplies nothing visible in its place.
//
// It has now happened four times (the admin tabpanel in Phase 6, twice more in
// 7a, and the whole input population found in Phase 8). It keeps happening
// because the suppression is one innocuous-looking utility, and because a
// comment on the floor rule asserted — wrongly — that the floor could not be
// suppressed. See the corrected note above `:focus-visible` in index.css.
//
// Two checks:
//   1. Every first-party `focus:outline-none` / `focus-visible:outline-none`
//      must sit alongside a replacement indicator utility, or be listed in
//      ALLOWED below with a reason.
//   2. The global input :focus treatment — which the input exemption makes the
//      ONLY indicator for every text field — must still clear 3:1.
//
// Run: node scripts/audit-focus-indicators.mjs   (no build needed for check 1)

import fs from 'node:fs'
import path from 'node:path'

const SRC = 'src'
const CSS = 'src/index.css'

// Vendored shadcn/ui primitives are excluded: they ship their own focus system
// and are not edited here.
const EXCLUDE_DIR = path.join('src', 'components', 'ui')

// A replacement is any focus-state utility that paints something perceivable.
const REPLACEMENT = /focus(-visible)?:(ring|shadow|outline-\[|outline-[0-9]|border|bg)/

// Deliberate exemptions, each with the reason it is safe.
const ALLOWED = new Map([
  ['src/companion/JoinScreen.tsx:176',
    'Invisible (opacity-0) overlay input for OTP-style entry — the focus state is ' +
    'drawn on the visible code boxes beneath it, which is where the user looks. ' +
    'An outline on a transparent full-bleed input would be the wrong shape.'],
  ['src/components/MiniDock.tsx:74',
    'An <input>, so the global input exemption removes the outline regardless of ' +
    'this utility; its indicator is the global input :focus treatment, which ' +
    'check 2 below holds to 3:1.'],
])

let problems = 0

/** Blank out every comment while preserving line numbers, so prose ABOUT the
 *  utility (including the multi-line JSX comments this codebase uses heavily to
 *  record past fixes) is never mistaken for a call site. Replacing comment
 *  characters with spaces rather than deleting them keeps line/column stable. */
function stripComments(src) {
  const out = src.split('')
  let i = 0, inS = null, inLine = false, inBlock = false
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (inLine) { if (c === '\n') inLine = false; else out[i] = ' '; i++; continue }
    if (inBlock) {
      if (c === '*' && n === '/') { out[i] = out[i + 1] = ' '; inBlock = false; i += 2; continue }
      if (c !== '\n') out[i] = ' '
      i++; continue
    }
    if (inS) { if (c === '\\') { i += 2; continue } if (c === inS) inS = null; i++; continue }
    if (c === '"' || c === "'" || c === '`') { inS = c; i++; continue }
    if (c === '/' && n === '/') { out[i] = out[i + 1] = ' '; inLine = true; i += 2; continue }
    if (c === '/' && n === '*') { out[i] = out[i + 1] = ' '; inBlock = true; i += 2; continue }
    i++
  }
  return out.join('')
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (!full.startsWith(EXCLUDE_DIR)) walk(full, out) }
    else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

console.log('## Check 1 — outline suppression without a replacement')
for (const file of walk(SRC)) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = stripComments(raw).split('\n')
  lines.forEach((line, i) => {
    if (!/focus(-visible)?:outline-none/.test(line)) return
    const ref = `${file}:${i + 1}`
    // The className may span lines; look at a small window. Comment-stripped, so
    // a replacement mentioned only in prose does not count as one either.
    const win = lines.slice(Math.max(0, i - 4), i + 5).join(' ')
    if (REPLACEMENT.test(win)) return
    if (ALLOWED.has(ref)) { console.log(`  allowed  ${ref}\n           ${ALLOWED.get(ref)}`); return }
    console.log(`  *** ${ref} suppresses the focus outline with no replacement`)
    problems++
  })
}
if (!problems) console.log('  no unguarded suppressions.')

console.log('\n## Check 2 — the global input :focus treatment still clears 3:1')
const css = fs.readFileSync(CSS, 'utf8')
const m = css.match(/input:not\(\[type="range"\]\):focus, select:focus, textarea:focus \{([^}]*)\}/)
if (!m) { console.log('  *** could not find the global input :focus rule'); problems++ }
else {
  const body = m[1]
  const bc = body.match(/border-color:\s*(rgba?\([^)]*\))/)
  const bg = body.match(/background:\s*(rgba?\([^)]*\))/)
  if (!bc || !bg) { console.log('  *** rule no longer sets border-color + background'); problems++ }
  else {
    const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
    const Y = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const over = (f, a, b) => f.map((c, i) => a * c + (1 - a) * b[i])
    const ratio = (a, b) => { const [l1, l2] = [Y(a), Y(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05) }
    const parse = str => { const n = str.match(/[\d.]+/g).map(Number); return { rgb: n.slice(0, 3).map(v => v / 255), a: n[3] ?? 1 } }
    const B = parse(bc[1]), G = parse(bg[1])
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    // The three panel darks the app actually renders these fields on.
    for (const [name, panel] of [['#0a0a0f', hex('#0a0a0f')], ['#050505', hex('#050505')], ['#141420', hex('#141420')]]) {
      const fill = over(G.rgb, G.a, panel)
      const border = over(B.rgb, B.a, fill)
      const r = ratio(border, fill)
      const ok = r >= 3
      if (!ok) problems++
      console.log(`  on ${name}: focus border vs field fill ${r.toFixed(2)}:1  ${ok ? 'PASS' : '*** FAIL (need 3.0)'}`)
    }
  }
}

console.log(`\n${problems} problem(s).`)
process.exit(problems ? 1 : 0)
