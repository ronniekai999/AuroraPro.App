// Find `max-width` media queries whose boundary does not meet Tailwind's
// `min-width` breakpoints, leaving a band that matches NEITHER rule.
//
// This shape has caused three real bugs here (the `.stage-opt` md gap in 7a, the
// theater's 1023.5px gap in 7b, the media-list 768px overlap in 8). It is
// invisible at integer widths and reachable at browser zoom, fractional DPR, or a
// scrollbar-affected viewport. `not all and (min-width: Npx)` is the exact
// complement and has no gap.
//
// ⚠️ REWRITTEN after review. The first version was a line-by-line regex
// (`/@media\s*\(\s*max-width:\s*(\d+)px\s*\)/`) and it missed, verifiably:
//   - the bug THIS COMMIT FIXED. Reverting `not all and (min-width: 768px)` back
//     to `max-width: 768px` produced "0 boundary gap(s) found", exit 0, because
//     the overlap branch set a verdict string and never incremented `problems`.
//   - `@media screen and (max-width: 767px)` — any media-type prefix defeated
//     the `(`-immediately-after-@media anchor. A real gap, reported clean.
//   - `@media (max-width: 767.5px)` — `\d+` only.
//   - `@media (max-width: 47.9375rem)` — px only.
//   - a query wrapped across two lines — it scanned lines, not rules.
// Three of four hand-injected gaps went undetected. Now it parses with PostCSS,
// normalises rem, and treats an overlap as a problem rather than a note.
//
// Run: npm run build && node scripts/audit-breakpoints.mjs

import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'

const SRC = 'src/index.css'
// Resolved relative to this script, not hardcoded: the first version pointed at
// an absolute path, so running it from a git worktree silently compared that
// worktree's source against the MAIN checkout's build.
const ASSETS = path.resolve(import.meta.dirname, '../../../v2/assets')

const ROOT_FONT_PX = 16   // Tailwind/browser default; this project does not change it.

const cssFiles = fs.existsSync(ASSETS)
  ? fs.readdirSync(ASSETS).filter(f => f.endsWith('.css'))
      .map(f => path.join(ASSETS, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)   // newest, not alphabetical
  : []
if (!cssFiles.length) {
  console.error(`audit: no built CSS in ${ASSETS} — run \`npm run build\` first.`)
  process.exit(2)
}
const built = postcss.parse(fs.readFileSync(cssFiles[0], 'utf8'))

// Which Tailwind min-width breakpoints does this build actually emit?
const emitted = new Set()
built.walkAtRules('media', a => {
  for (const m of a.params.matchAll(/min-width:\s*([\d.]+)(px|rem)/g)) {
    emitted.add(m[2] === 'rem' ? Number(m[1]) * ROOT_FONT_PX : Number(m[1]))
  }
})
console.log('Tailwind min-width breakpoints present in the built CSS:',
  [...emitted].sort((a, b) => a - b).join(', '))

// Parse the SOURCE with PostCSS so media-type prefixes, decimals, rem and
// line-wrapped params are all handled by the parser rather than by a regex.
const source = postcss.parse(fs.readFileSync(SRC, 'utf8'))
const lines = fs.readFileSync(SRC, 'utf8').split('\n')

let problems = 0
const found = []
source.walkAtRules('media', a => {
  for (const m of a.params.matchAll(/max-width:\s*([\d.]+)(px|rem)/g)) {
    const bound = m[2] === 'rem' ? Number(m[1]) * ROOT_FONT_PX : Number(m[1])
    found.push({ bound, params: a.params, line: a.source?.start?.line })
  }
})

console.log(`\n## max-width media queries in ${SRC} (${found.length} found)`)
for (const f of found) {
  // A GAP: the next emitted breakpoint sits strictly above the bound, so
  // (bound, next) matches neither. Any next-breakpoint > bound is a gap unless it
  // equals bound exactly — including non-integer bounds like 767.5.
  const above = [...emitted].filter(b => b > f.bound).sort((x, y) => x - y)[0]
  const exact = emitted.has(f.bound)
  let verdict, bad = false
  if (exact) {
    // OVERLAP: both rules apply at exactly `bound`. This IS a problem — the
    // media-list rule was this shape and its symptom (genre/length columns
    // vanishing at exactly 768px while the rest of the page had gone desktop)
    // needed no competing `md:` utility to occur. The old script called this
    // "benign unless they set the same property" and cleared it.
    verdict = `OVERLAP at exactly ${f.bound}px with a Tailwind min-width breakpoint — both apply`
    bad = true
  } else if (above !== undefined && above - f.bound < 1.0001) {
    verdict = `GAP: (${f.bound}, ${above}) matches neither this rule nor the min-width one`
    bad = true
  } else if (above !== undefined) {
    verdict = `ok (nearest breakpoint above is ${above}px, ${(above - f.bound).toFixed(4)}px away)`
  } else {
    verdict = 'ok (no Tailwind breakpoint above this bound)'
  }
  if (bad) problems++
  console.log(`  ${SRC}:${f.line}  @media ${f.params}`)
  console.log(`      -> ${verdict}`)
}
if (!found.length) console.log('  (none — every responsive rule uses the negated form)')

console.log('\n## negated-form queries (the correct shape)')
let negated = 0
source.walkAtRules('media', a => {
  if (/not all and \(\s*min-width:/.test(a.params)) {
    negated++
    console.log(`  ${SRC}:${a.source?.start?.line}  @media ${a.params}`)
  }
})
if (!negated) console.log('  (none)')

console.log(`\n${problems} boundary problem(s).`)
process.exit(problems ? 1 : 0)
