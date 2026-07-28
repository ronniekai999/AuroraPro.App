// Phase 12 — measure the page systems' horizontal alignment in a REAL layout
// engine, at every width that matters.
//
// This exists because Phase 11.4 shipped a 320px stair-step. The ultra-wide cap
// went on `.stage-gutter` alone while BrowseView's toolbar restated the gutter
// itself, so at 2560 the genre chips sat at x=48 while the grid they filter
// started at x=368. Every claim in that commit was derived by arithmetic and every
// one of them was plausible. A reviewer found it by opening a browser.
//
// Arithmetic cannot see: `margin-inline` clobbering a negative margin utility,
// a percentage resolving against the wrong containing block, an over-constrained
// box solving margin-right to something absurd, or a `max()` that never binds.
// All four were live in the reverted attempt. So this asserts, rather than argues.
//
// NOT wired into `npm run audit`: it launches a browser and the gate is meant to
// stay fast. Run it when touching anything that reads --page-pad-x.
//
//   npm run verify:layout
//
// The executablePath pin is deliberate — this environment ships Chromium at a
// build the npm `playwright` package does not expect, and `npx playwright install`
// is unavailable. Env var override for other machines.

import { chromium } from 'playwright'
import fs from 'node:fs'
const cssPath = process.argv[2] ?? fs
  .readdirSync('../../v2/assets')
  .filter(f => /^index-.*\.css$/.test(f))
  .map(f => `../../v2/assets/${f}`)[0]
if (!cssPath) throw new Error('verify: no built CSS found — run `npm run build` first')
const css = fs.readFileSync(cssPath, 'utf8')
const EXE = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

// A standalone page carrying the real built stylesheet and the real class
// combinations, so the numbers come from a layout engine rather than arithmetic.
// The class lists are READ FROM THE SOURCE, not written here. A hardcoded probe
// cannot catch a call site drifting away from the shared class — which is the
// precise bug this file exists for: Phase 11.4's stair-step was BrowseView's
// toolbar restating the gutter. Mutation-verified: with the classes hardcoded,
// reverting that toolbar to `px-[var(--page-gutter)]` left this check green.
function classesOf(file, marker) {
  const src = fs.readFileSync(file, 'utf8')
  // The className whose VALUE contains the marker — not the first className after
  // the marker's position. The latter matched a mention of the marker in a comment
  // and then returned a CHILD element's classes: the browse toolbar resolved to
  // `genre-chips flex items-center …` and the hero footer to `min-w-0 max-w-2xl`,
  // both of which are inside the element being probed. Caught because the check
  // then reported real misalignments that were its own fault.
  const hits = [...src.matchAll(/className="([^"]*)"/g)]
    .map(m => m[1])
    .filter(v => v.includes(marker))
  if (hits.length !== 1) {
    throw new Error(
      `verify: expected exactly one className containing "${marker}" in ${file}, found ${hits.length}` +
      ' — this check is out of date, not passing')
  }
  return hits[0]
}
const BROWSE_TB = classesOf('src/components/BrowseView.tsx', 'browse-toolbar')
const ADMIN_TB = classesOf('src/components/admin/AdminView.tsx', 'stage-toolbar')
const HERO_FOOT = classesOf('src/components/HeroSection.tsx', 'absolute bottom-0 left-0 right-0 z-20')

const html = `<!doctype html><html><head><style>${css}</style>
<style>body{margin:0}.probe{outline:0}</style></head><body>
<div class="min-h-screen">
  <div id="page" class="stage-page">
    <div id="admintb" class="${ADMIN_TB}">admin toolbar</div>
  </div>
  <div id="rail" class="stage-gutter">rail</div>
  <div id="browsetb" class="${BROWSE_TB}">browse toolbar</div>
  <section style="position:relative;height:200px;overflow:hidden">
    <div id="herofoot" class="${HERO_FOOT}">hero footer</div>
  </section>
</div></body></html>`

const browser = await chromium.launch({ executablePath: EXE })
const out = []
for (const width of [390, 767, 768, 1440, 1920, 2560]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  await page.setContent(html)
  const r = await page.evaluate(() => {
    const box = id => { const e = document.getElementById(id); if (!e) return null
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e)
      return { left: +(b.left + parseFloat(cs.paddingLeft)).toFixed(1),
               right: +(b.right - parseFloat(cs.paddingRight)).toFixed(1),
               boxLeft: +b.left.toFixed(1), boxRight: +b.right.toFixed(1) }
    }
    return { rail: box('rail'), browsetb: box('browsetb'), herofoot: box('herofoot'),
             admintb: box('admintb'), page: box('page'),
             docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }
  })
  out.push({ width, ...r })
  await page.close()
}
await browser.close()
const CAP = 1920
let problems = 0
for (const r of out) {
  const keys = ['rail', 'browsetb', 'herofoot', 'page']
  console.log(`\n── ${r.width}px`)
  for (const k of keys) {
    console.log(`   ${k.padEnd(9)} content ${String(r[k].left).padStart(6)} .. ${String(r[k].right).padStart(6)}   (width ${(r[k].right - r[k].left).toFixed(0)})`)
  }
  console.log(`   admintb   BOX     ${String(r.admintb.boxLeft).padStart(6)} .. ${String(r.admintb.boxRight).padStart(6)}`)

  // 1. Every page system shares both content edges. This is the stair-step check.
  const ref = r[keys[0]]
  for (const k of keys.slice(1)) {
    if (r[k].left !== ref.left || r[k].right !== ref.right) {
      console.log(`   *** ${k} is misaligned with ${keys[0]}: ${r[k].left}..${r[k].right} vs ${ref.left}..${ref.right}`)
      problems++
    }
  }
  // 2. The cap actually binds, and only above it.
  const w = ref.right - ref.left
  if (r.width > CAP && Math.round(w) !== CAP) {
    console.log(`   *** content is ${w.toFixed(0)}px above the ${CAP}px cap`)
    problems++
  }
  // Absolute expectation, not one derived from the measurement itself. The first
  // version asserted `w === r.width - 2 * ref.left`, which is true by definition
  // — deleting the mobile token override (pushing 390px from an 18px inset to
  // 48px) sailed through it.
  const expectedInset = r.width < 768 ? 18 : Math.max(48, (r.width - CAP) / 2)
  if (Math.round(ref.left) !== Math.round(expectedInset)) {
    console.log(`   *** inset is ${ref.left}, expected ${expectedInset}`)
    problems++
  }
  // 3. Nothing overflows horizontally at any width — the 390px case that a whole
  //    breakpoint pass missed, because the hero clips rather than scrolls.
  if (r.docOverflow) { console.log('   *** HORIZONTAL OVERFLOW'); problems++ }
}
console.log(`\n${problems} alignment problem(s).`)
process.exit(problems ? 1 : 0)
