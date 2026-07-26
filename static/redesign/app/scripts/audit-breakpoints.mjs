// Phase 8 breakpoint audit: find `max-width` media queries whose boundary does
// not meet Tailwind's `min-width` breakpoints, leaving a fractional-pixel band
// that matches NEITHER rule.
//
// This shape has already caused two real bugs in this codebase (the .stage-opt
// md-boundary gap in Phase 7a, and the theater's 1023.5px gap in 7b). It is
// invisible at integer widths and reachable at browser zoom, fractional DPR, or
// a scrollbar-affected viewport width. The negated form
// `not all and (min-width: Npx)` is the exact complement and has no gap.
//
// Run: npm run build && node scripts/audit-breakpoints.mjs

import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'

const SRC = 'src/index.css'
const assets = '/home/user/AuroraPro.App/static/v2/assets'

// Tailwind 3 defaults, as configured for this project.
const TW = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 }

const cssFile = fs.readdirSync(assets).filter(f => f.endsWith('.css')).sort()[0]
const built = postcss.parse(fs.readFileSync(path.join(assets, cssFile), 'utf8'))
const source = fs.readFileSync(SRC, 'utf8')
const srcLines = source.split('\n')

// Which Tailwind min-width breakpoints are actually emitted in this build?
const emitted = new Set()
built.walkAtRules('media', a => {
  const m = a.params.match(/min-width:\s*(\d+)px/)
  if (m) emitted.add(Number(m[1]))
})

console.log('Tailwind min-width breakpoints present in the built CSS:',
  [...emitted].sort((a, b) => a - b).join(', '))

let problems = 0
console.log('\n## max-width media queries in src/index.css')
srcLines.forEach((line, i) => {
  const m = line.match(/@media\s*\(\s*max-width:\s*(\d+)px\s*\)/)
  if (!m) return
  const bound = Number(m[1])
  // A gap exists when the next Tailwind breakpoint up is bound+1: everything in
  // (bound, bound+1) matches neither. Meeting exactly (max-width: N and
  // min-width: N) is an overlap at one integer, which is milder but worth naming.
  const gapWith = [...emitted].find(b => b === bound + 1)
  const overlapWith = [...emitted].find(b => b === bound)
  const name = Object.entries(TW).find(([, v]) => v === bound + 1 || v === bound)
  let verdict = 'ok (no adjacent Tailwind breakpoint)'
  if (gapWith) { verdict = `GAP: (${bound}, ${gapWith}) matches neither this nor \`${name?.[0]}:\``; problems++ }
  else if (overlapWith) verdict = `overlap at exactly ${bound}px with \`${name?.[0]}:\` (both apply; benign unless they set the same property)`
  console.log(`  ${SRC}:${i + 1}  max-width: ${bound}px  ->  ${verdict}`)
})

console.log('\n## negated-form queries (the correct shape)')
srcLines.forEach((line, i) => {
  if (/@media\s*not all and \(\s*min-width:/.test(line)) {
    console.log(`  ${SRC}:${i + 1}  ${line.trim()}`)
  }
})

console.log(`\n${problems} boundary gap(s) found.`)
process.exit(problems ? 1 : 0)
