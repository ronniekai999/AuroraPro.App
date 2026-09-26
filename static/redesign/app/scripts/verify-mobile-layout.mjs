// Phone-width layout guards, measured in a REAL layout engine against the real
// built stylesheet — the same approach as verify-page-alignment.mjs, and for the
// same reason: both defects below were invisible to arithmetic and to jsdom, and
// were found by rendering the SPA at 390px.
//
//   1. RAIL HEADER OVERFLOW. `.rail-title` was `white-space: nowrap` beside an
//      "AI PICK" chip in a non-wrapping row. "Hidden gems in your library" + chip
//      pushed the chip 17px past the rail, which widened the whole page's layout
//      viewport to 407px on 320/360/390px phones. The visible symptom was not the
//      chip: it was the menu sheet and search palette, whose `fixed right-2`
//      resolved against the widened viewport and were clipped off the right edge.
//
//   2. CARD META WRAPPING. `.co-meta` had `flex-wrap: nowrap` and a comment
//      calling one line load-bearing (the badges clear the title by a fixed
//      offset), but each token span still wrapped its OWN text: at the two-up
//      phone grid's ~165px, "2h 16m" broke over two lines, the overlay grew, and
//      the title slid under the "4K"/"R" badges on 15 of 18 cards.
//
// Class lists are READ FROM THE SOURCE (see classesOf), so a call site drifting
// away from the fix fails here rather than passing against a stale copy.
//
// MUTATION-TESTED when written: each of these, applied alone to the fix, turns
// this check red — `.rail-title` back to nowrap; `.co-meta` back to a one-line
// nowrap flex row; `.co-tok` losing nowrap, or its min/max-width; the one-line
// `height` dropped; the `.co-txt` rule dropped, or just its overflow:hidden.
// Two survive, and are EQUIVALENT for what this asserts rather than uncovered:
// the title row losing `flex-wrap`, and the AI chip losing `whitespace-nowrap`.
// Either way the title wraps and nothing overflows; they only change whether
// the chip sits beside a wrapped title or below it.
//
//   npm run build && node scripts/verify-mobile-layout.mjs

import { chromium } from 'playwright'
import fs from 'node:fs'

const cssPath = process.argv[2] ?? fs
  .readdirSync('../../v2/assets')
  .filter(f => /^index-.*\.css$/.test(f))
  .map(f => `../../v2/assets/${f}`)[0]
if (!cssPath) throw new Error('verify-mobile: no built CSS found — run `npm run build` first')
const css = fs.readFileSync(cssPath, 'utf8')
// Same fallback-only pin as verify-page-alignment.mjs; see its header.
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = fs.existsSync(PINNED) ? PINNED : undefined

// The className whose value contains `marker`; exactly one, or this check is
// stale. (Same contract as verify-page-alignment.mjs's classesOf.)
function classesOf(file, marker) {
  const src = fs.readFileSync(file, 'utf8')
  const hits = [...src.matchAll(/className="([^"]*)"/g)].map(m => m[1]).filter(v => v.includes(marker))
  if (hits.length !== 1) {
    throw new Error(`verify-mobile: expected exactly one className containing "${marker}" in ${file}, found ${hits.length}` +
      ' — this check is out of date, not passing')
  }
  return hits[0]
}
const RAIL = 'src/components/MediaRail.tsx'
const CARD = 'src/components/MediaCardCinema.tsx'
const RAIL_HEADER = classesOf(RAIL, 'rail-header')
const RAIL_TITLE = classesOf(RAIL, 'rail-title')
const RAIL_TITLE_ROW = classesOf(RAIL, 'items-center gap-x-')
const RAIL_TEXT_COL = classesOf(RAIL, 'flex-col gap-0.5')
const AI_CHIP = classesOf(RAIL, 'bg-yellow-400/10')
const CO_META = classesOf(CARD, 'co-meta')
const CO_TITLE = classesOf(CARD, 'co-title')
const OVERLAY = classesOf(CARD, 'card-overlay')
const BADGES = classesOf(CARD, 'card-badges')
const POSTER_WRAP = classesOf(CARD, 'poster-wrap')

// Long enough to force the chip off the title's line at every phone width, and
// one real-world LLM title that is long even without a chip.
const RAIL_TITLES = [
  ['Hidden gems in your library', true],
  ['Because you watched Everything Everywhere All at Once', true],
  ['Because you watched Everything Everywhere All at Once', false],
]
// The browse grid's widest meta row (rating · year · runtime · genre), which is
// the row that wrapped. Built the way MediaCardCinema renders it: one .co-tok
// per token carrying the dot that precedes it, text in .co-txt. Those two class
// names are read from the source like the rest, so a restructure fails loudly.
const CO_TOK = classesOf(CARD, 'co-tok')
const CO_TXT = classesOf(CARD, 'co-txt')
const tok = (inner, i) => `<span class="${CO_TOK}">${i ? '<span class="sep" aria-hidden="true">·</span>' : ''}${inner}</span>`
const META = ['<span class="star">★ 9.2</span>', `<span class="${CO_TXT}">1999</span>`,
  `<span class="${CO_TXT}">2h 16m</span>`, `<span class="${CO_TXT}">Science Fiction</span>`].map(tok).join('')
// A single token wider than any phone card — the Continue Watching subtitle
// shape — which cannot wrap away and must ellipsize inside the row instead.
const META_LONE = tok(`<span class="${CO_TXT}">S12E104 · 1h 23m left of 1h 58m</span>`, 0)

const railHtml = RAIL_TITLES.map(([t, chip], i) => `
  <section class="rail-container" data-rail="${i}">
    <div class="${RAIL_HEADER}">
      <span class="rail-icon" data-tint="purple"></span>
      <div class="${RAIL_TEXT_COL}">
        <div class="${RAIL_TITLE_ROW}">
          <h2 class="${RAIL_TITLE}">${t}</h2>
          ${chip ? `<span class="${AI_CHIP}">✦ AI Pick</span>` : ''}
        </div>
        <span>Hand-picked by Aurora for your taste</span>
      </div>
      <span class="rail-spacer"></span>
    </div>
  </section>`).join('')

// Card widths: the two-up phone grid at 320–430px lands ~130–190px; 206 is the
// rail card. Each card carries two badges, which sit at a fixed offset above
// the overlay's foot — the geometry the one-line meta row exists to protect.
const CARD_WIDTHS = [120, 140, 150, 165, 180, 206]
const cardHtml = CARD_WIDTHS.flatMap(w => [[META, `${w}`], [META_LONE, `${w} lone`]]).map(([meta, id]) => `
  <div class="media-card-cinema" style="width:${parseInt(id)}px" data-card="${id}">
    <div class="${POSTER_WRAP}">
      <div class="poster-img" style="aspect-ratio:2/3;background:#345"></div>
      <div class="${BADGES}"><span class="card-badge is-quality">4K</span><span class="card-badge">PG-13</span></div>
      <div class="${OVERLAY}">
        <div class="${CO_TITLE}">The Grand Budapest Hotel</div>
        <div class="${CO_META}">${meta}</div>
      </div>
    </div>
  </div>`).join('')

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style><style>body{margin:0}</style></head><body>
<div class="stage-gutter" id="rails">${railHtml}</div>
<div class="stage-gutter" id="cards" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start">${cardHtml}</div>
</body></html>`

const browser = await chromium.launch({ executablePath: EXE })
let problems = 0
for (const width of [320, 360, 390, 430, 767, 1440]) {
  // isMobile: a phone browser WIDENS the layout viewport to fit overflowing
  // content (the 407px symptom) where a desktop viewport would just scroll, so
  // this is the mode in which the original defect is visible at all.
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.setContent(html)
  await page.evaluate(() => document.fonts.ready)
  const r = await page.evaluate(() => {
    const rails = [...document.querySelectorAll('[data-rail]')].map(sec => {
      const header = sec.firstElementChild
      const secBox = sec.getBoundingClientRect()
      const cs = getComputedStyle(sec)
      const contentRight = secBox.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth)
      const worst = Math.max(...[...header.querySelectorAll('*')].map(e => e.getBoundingClientRect().right))
      return { i: sec.dataset.rail, worst: +worst.toFixed(1), contentRight: +contentRight.toFixed(1) }
    })
    const cards = [...document.querySelectorAll('[data-card]')].map(card => {
      const meta = card.querySelector('.co-meta')
      const lh = parseFloat(getComputedStyle(meta).lineHeight) || parseFloat(getComputedStyle(meta).fontSize) * 1.5
      const title = card.querySelector('.co-title').getBoundingClientRect()
      const badges = card.querySelector('.card-badges').getBoundingClientRect()
      // The row clips (overflow:hidden), so what matters is what is VISIBLE:
      // tokens that start inside it. Tokens pushed to the clipped second line
      // are gone whole, which is intended. Every visible token must sit
      // entirely inside the row — past its right edge is a HARD CLIP mid-glyph
      // ("2h 1"), past its bottom is a token that wrapped its own text.
      const row = meta.getBoundingClientRect()
      const visibleToks = [...meta.children].filter(c => c.getBoundingClientRect().top < row.bottom - 0.5)
      const visible = visibleToks.map(c => c.getBoundingClientRect())
      // Every ELEMENT inside a visible token, not just the token's own box: a
      // token can be shrunk to fit while its text runs on past it (the text of
      // a lone token with no ellipsis rule did exactly that, and a box-only
      // measurement called it clean).
      const inner = visibleToks.flatMap(c => [c, ...c.querySelectorAll('*')]).map(e => e.getBoundingClientRect())
      const spill = Math.max(0, ...inner.map(b => b.right - row.right), ...visible.map(b => b.bottom - row.bottom))
      // Truncated tokens (ellipsis engaged). Only legitimate for a token that
      // is ALONE on the row; with company, the right behaviour is for the
      // tokens that do not fit to drop whole — not for every token to shrink
      // to "19…" / "2h…", which is what the old one-line flex row degrades to.
      const cut = visibleToks.flatMap(c => [c, ...c.querySelectorAll('*')]).filter(e => e.scrollWidth > e.clientWidth + 1)
      const truncated = visibleToks.filter(c => cut.some(e => c === e || c.contains(e))).length
      // An element whose content overruns it only shows an ELLIPSIS if it also
      // clips (text-overflow does nothing under overflow:visible) — otherwise
      // its text runs on and is hard-clipped by the row. Box geometry cannot
      // tell those two apart, so this reads the computed style of exactly the
      // elements that are overrunning.
      const noEllipsis = cut.filter(e => {
        const s = getComputedStyle(e)
        return !(s.textOverflow === 'ellipsis' && /hidden|clip/.test(s.overflowX))
      }).length
      return { w: card.dataset.card, metaH: +row.height.toFixed(1), lh: +lh.toFixed(1),
               tallestToken: +Math.max(...visible.map(b => b.height)).toFixed(1),
               shown: visible.length, of: meta.children.length, truncated, noEllipsis,
               spill: +spill.toFixed(1),
               gap: +(title.top - badges.bottom).toFixed(1) }
    })
    return { rails, cards, iw: window.innerWidth, sw: document.documentElement.scrollWidth }
  })
  console.log(`\n── ${width}px  (layout viewport ${r.iw}px, document ${r.sw}px)`)
  if (r.iw !== width || r.sw > width) {
    console.log(`   *** the page is wider than the device: ${r.sw}px on a ${width}px viewport`)
    problems++
  }
  for (const rail of r.rails) {
    const ok = rail.worst <= rail.contentRight + 0.5
    console.log(`   rail ${rail.i}  header reaches ${rail.worst}  content edge ${rail.contentRight}${ok ? '' : '   *** OVERFLOWS'}`)
    if (!ok) problems++
  }
  for (const c of r.cards) {
    // One line: no token taller than a line, and the row itself one line tall.
    const oneLine = c.tallestToken <= c.lh + 1 && c.metaH <= c.lh + 1
    const clear = c.gap >= 0
    const contained = c.spill <= 0.5 && c.noEllipsis === 0
    const wholeTokens = c.truncated === 0 || c.shown === 1
    // At least the first token must survive: a row showing nothing is a row
    // this check would otherwise call "one line, nothing clipped".
    if (c.shown < 1) { console.log(`   *** card ${c.w}px shows no meta at all`); problems++ }
    console.log(`   card ${String(c.w).padEnd(8)}  meta ${c.metaH}px (line ${c.lh}, tallest token ${c.tallestToken})  ${c.shown}/${c.of} tokens, ${c.truncated} truncated  badge→title gap ${c.gap}px  spill ${c.spill}px` +
      (oneLine ? '' : '   *** META WRAPS') + (clear ? '' : '   *** BADGES OVER TITLE') + (contained ? '' : '   *** TOKENS HARD-CLIPPED') +
      (wholeTokens ? '' : '   *** TOKENS SHRUNK INSTEAD OF DROPPED'))
    if (!oneLine) problems++
    if (!clear) problems++
    if (!contained) problems++
    if (!wholeTokens) problems++
  }
  await ctx.close()
}
await browser.close()
console.log(`\n${problems} mobile layout problem(s).`)
process.exit(problems ? 1 : 0)
