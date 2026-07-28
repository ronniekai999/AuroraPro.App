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
// Chromium resolution: this environment ships a build the npm `playwright` package
// does not expect (1194 vs 1234), so an unpinned launch fails HERE. The pin is a
// FALLBACK, not a requirement — an earlier version of this comment claimed
// `npx playwright install` was "unavailable", and a reviewer showed it works in 17
// seconds. Worse, a hard pin breaks the machine that HAS done the documented thing,
// and suppresses Playwright's own remedy ("run npx playwright install"), which is
// the most useful error message available. So: use the pinned path only if it
// exists, otherwise let Playwright resolve normally.

import { chromium } from 'playwright'
import fs from 'node:fs'
const cssPath = process.argv[2] ?? fs
  .readdirSync('../../v2/assets')
  .filter(f => /^index-.*\.css$/.test(f))
  .map(f => `../../v2/assets/${f}`)[0]
if (!cssPath) throw new Error('verify: no built CSS found — run `npm run build` first')
const css = fs.readFileSync(cssPath, 'utf8')
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = fs.existsSync(PINNED) ? PINNED : undefined

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
<div class="stage-topnav" id="nav">nav</div>
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
for (const width of [320, 390, 767, 768, 1440, 1920, 2000, 2560, 3840]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  await page.setContent(html)
  const r = await page.evaluate(() => {
    const box = id => { const e = document.getElementById(id); if (!e) return null
      const b = e.getBoundingClientRect(); const cs = getComputedStyle(e)
      return { left: +(b.left + parseFloat(cs.paddingLeft)).toFixed(1),
               right: +(b.right - parseFloat(cs.paddingRight)).toFixed(1),
               boxLeft: +b.left.toFixed(1), boxRight: +b.right.toFixed(1) }
    }
    return { nav: box('nav'), rail: box('rail'), browsetb: box('browsetb'), herofoot: box('herofoot'),
             admintb: box('admintb'), page: box('page'),
             // The LAYOUT viewport, not the window width. `100%` resolves against
             // this, and on a Chromium with classic 15px scrollbars they differ —
             // at 2560 the real inset would be 312.5 while the window width says
             // 320. This environment's headless build has zero-width scrollbars, so
             // deriving the expectation from the window parameter passes here and
             // would fail on anyone else's machine. A portability landmine, not a
             // visible bug, which is exactly the kind that survives review.
             clientWidth: document.documentElement.clientWidth,
             docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }
  })
  out.push({ width, ...r })
  await page.close()
}
await browser.close()
// Read from the stylesheet the script already has in memory, not restated. As
// literals, changing `--page-max` legitimately produced "content is 1400px above
// the 1920px cap" — a message blaming the CSS when the SCRIPT was the stale side.
const num = (re, what) => {
  const m = css.match(re)
  if (!m) throw new Error(`verify: could not read ${what} from the built CSS — this check is out of date, not passing`)
  return Number(m[1])
}
const CAP = num(/--page-max:\s*(\d+)px/, '--page-max')
const GUTTER = num(/--page-gutter:\s*(\d+)px/, '--page-gutter')
const MOBILE = num(/min-width:\s*768px\)\s*\{\s*:root\s*\{\s*--page-pad-x:\s*(\d+)px/, 'the mobile --page-pad-x')
let problems = 0
for (const r of out) {
  const keys = ['rail', 'browsetb', 'herofoot', 'page']
  console.log(`\n── ${r.width}px`)
  for (const k of keys) {
    console.log(`   ${k.padEnd(9)} content ${String(r[k].left).padStart(6)} .. ${String(r[k].right).padStart(6)}   (width ${(r[k].right - r[k].left).toFixed(0)})`)
  }
  console.log(`   admintb   BOX     ${String(r.admintb.boxLeft).padStart(6)} .. ${String(r.admintb.boxRight).padStart(6)}`)
  console.log(`   nav       content ${String(r.nav.left).padStart(6)} .. ${String(r.nav.right).padStart(6)}`)

  // 1. Every page system shares both content edges. This is the stair-step check.
  const ref = r[keys[0]]
  for (const k of keys.slice(1)) {
    if (r[k].left !== ref.left || r[k].right !== ref.right) {
      console.log(`   *** ${k} is misaligned with ${keys[0]}: ${r[k].left}..${r[k].right} vs ${ref.left}..${ref.right}`)
      problems++
    }
  }
  // 2. The cap binds where it should. ONE expectation covering every width, which
  //    also removes the previous version's arithmetic bug: it demanded exactly CAP
  //    the moment `width > CAP`, but `max()` keeps picking the gutter until the cap
  //    term exceeds it — so between 1920 and 1920+2*48 the content is `width - 96`,
  //    not 1920. On correct CSS at 2000px it reported "content is 1904px above the
  //    1920px cap". A width in that band is exactly what someone would add next,
  //    and a check that fails on good code gets deleted. 2000 is now in the list.
  const w = ref.right - ref.left
  const vw = r.clientWidth
  const inset = vw < 768 ? MOBILE : Math.max(GUTTER, (vw - CAP) / 2)
  const expectedContent = vw - 2 * inset
  if (Math.abs(w - expectedContent) > 0.5) {
    console.log(`   *** content is ${w.toFixed(1)}px, expected ${expectedContent.toFixed(1)}`)
    problems++
  }
  // Absolute expectation, not one derived from the measurement itself. An earlier
  // version asserted `w === r.width - 2 * ref.left`, true by definition — deleting
  // the mobile token override (pushing 390px from an 18px inset to 48px) sailed
  // through it.
  if (Math.abs(ref.left - inset) > 0.5) {
    console.log(`   *** inset is ${ref.left}, expected ${inset}`)
    problems++
  }

  // 4. THE BLEED. `.stage-bleed` is what this phase adds, and it was measured,
  //    printed, and never asserted — so removing it, or removing `.stage-gutter`
  //    beside it, left four distinct 48px stair-steps between the admin toolbar
  //    and every other page system, all green. The thing a commit introduces is
  //    the last thing that should be uncovered.
  //    Its CONTENT must line up with everything else, and its BOX must reach the
  //    page edge: 0 while the gutter is the whole padding, and `inset - GUTTER`
  //    once the cap is contributing (it bleeds to the capped page, not the viewport).
  if (Math.abs(r.admintb.left - ref.left) > 0.5 || Math.abs(r.admintb.right - ref.right) > 0.5) {
    console.log(`   *** admintb content ${r.admintb.left}..${r.admintb.right} != ${ref.left}..${ref.right}`)
    problems++
  }
  //    The bleed amount is NOT the page inset. `.stage-bleed`'s own `100%`
  //    resolves against its parent's ALREADY-PADDED content box, so the cap term
  //    is zero inside a capped page and the margin is just the gutter. Below md
  //    the token is a flat MOBILE px, so it cancels exactly and the box sits at 0;
  //    at 2560 the page inset is 320 and the bleed 48, so the box starts at 272.
  //    My first expectation used the gutter at every width and reported the three
  //    mobile widths as "not bleeding" when they were bleeding correctly.
  const bleed = vw < 768 ? MOBILE : GUTTER
  // 5. The TOP NAV, which is a fifth page system and was missed entirely by the
  //    first version of this phase. Its inset is deliberately 18px tighter than
  //    the page gutter below the cap, and must converge with it above — otherwise
  //    the tabs sit at x=30 while every page they navigate to starts at x=320.
  const NAV_INSET = 30, NAV_MOBILE = 18
  const navExpected = vw < 768 ? NAV_MOBILE : Math.max(NAV_INSET, (vw - CAP) / 2)
  if (Math.abs(r.nav.left - navExpected) > 0.5) {
    console.log(`   *** nav inset is ${r.nav.left}, expected ${navExpected}`)
    problems++
  }
  if (vw > CAP + 2 * GUTTER && Math.abs(r.nav.left - ref.left) > 0.5) {
    console.log(`   *** past the cap the nav (${r.nav.left}) must track the page (${ref.left})`)
    problems++
  }

  const expectedBoxLeft = inset - bleed
  if (Math.abs(r.admintb.boxLeft - expectedBoxLeft) > 0.5) {
    console.log(`   *** admintb box starts at ${r.admintb.boxLeft}, expected ${expectedBoxLeft} — it is not bleeding`)
    problems++
  }
  // 3. Nothing overflows horizontally at any width — the 390px case that a whole
  //    breakpoint pass missed, because the hero clips rather than scrolls.
  if (r.docOverflow) { console.log('   *** HORIZONTAL OVERFLOW'); problems++ }
}
console.log(`\n${problems} alignment problem(s).`)
process.exit(problems ? 1 : 0)
