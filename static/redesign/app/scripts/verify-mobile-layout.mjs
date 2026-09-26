// Phone-width layout guards, measured in a REAL layout engine against the real
// built stylesheet and the real web fonts — the same approach as
// verify-page-alignment.mjs, and for the same reason: both defects below were
// invisible to arithmetic and to jsdom, and were found by rendering the SPA at
// 390px.
//
//   1. RAIL HEADER OVERFLOW. `.rail-title` was `white-space: nowrap` beside an
//      "AI PICK" chip in a non-wrapping row. "Hidden gems in your library" + chip
//      pushed the chip 17px past the rail, which widened the whole page's layout
//      viewport to 407px on 320/360/390px phones. The visible symptom was not the
//      chip: it was the menu sheet and search palette, whose `fixed right-2`
//      resolved against the widened viewport and were clipped off the right edge.
//      Titles are user- and LLM-written (the conversational rail's title is the
//      query the user typed), so an unbroken word and a long subtitle are cases.
//
//   2. CARD META WRAPPING. `.co-meta` had `flex-wrap: nowrap` and a comment
//      calling one line load-bearing (the badges clear the title by a fixed
//      offset), but each token span still wrapped its OWN text: at the two-up
//      phone grid's ~165px, "2h 16m" broke over two lines, the overlay grew, and
//      the title slid under the "4K"/"R" badges on 15 of 18 cards.
//
// Class lists are READ FROM THE SOURCE (see classesOf), so a call site drifting
// away from the fix fails here rather than passing against a stale copy. The
// page is served over HTTP, not setContent: the built CSS points its @font-face
// rules at absolute /v2/assets/ URLs, which an about:blank page cannot resolve —
// the first version of this script measured every case in the fallback font
// without knowing it. It now fails if any web font errors, and runs once per
// typeface the Settings page offers.
//
// MUTATION-TESTED: each of these, applied ALONE to the fix, turns this check red —
// `.rail-title` back to nowrap, or losing overflow-wrap or min-width; the subtitle losing
// break-words; `.co-meta` back to a one-line nowrap flex row, losing its
// one-line height, or losing overflow:hidden; `.co-tok` losing nowrap or
// min-width:0; `.co-txt` losing overflow:hidden or text-overflow. Three survive
// and are EQUIVALENT for what this asserts rather than uncovered: the title row
// losing `flex-wrap`, and the AI chip losing `whitespace-nowrap` or `flex-none`.
// Either way the title wraps and nothing overflows; they only move the chip
// beside a wrapped title instead of below it. What this cannot see is the card
// markup itself — the probe rebuilds it from class names — so the token /
// separator STRUCTURE is pinned by MediaCardCinema.meta.test.tsx instead.
//
//   npm run build && node scripts/verify-mobile-layout.mjs

import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

// Everything resolves from this script's own location, so the check reads the
// same tree whichever directory it is run from.
const APP = path.resolve(import.meta.dirname, '..')
const ASSETS = path.resolve(APP, '../../v2/assets')
const cssFile = fs.existsSync(ASSETS)
  ? fs.readdirSync(ASSETS).filter(f => /^index-.*\.css$/.test(f))
      .sort((a, b) => fs.statSync(path.join(ASSETS, b)).mtimeMs - fs.statSync(path.join(ASSETS, a)).mtimeMs)[0]
  : undefined
if (!cssFile) throw new Error(`verify-mobile: no built CSS in ${ASSETS} — run \`npm run build\` first`)
// Same fallback-only pin as verify-page-alignment.mjs; see its header.
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = fs.existsSync(PINNED) ? PINNED : undefined

// The className whose value contains `marker`; exactly one, or this check is
// stale. (Same contract as verify-page-alignment.mjs's classesOf.)
function classesOf(file, marker) {
  const src = fs.readFileSync(path.join(APP, file), 'utf8')
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
const RAIL_ICON = classesOf(RAIL, 'rail-icon')
const RAIL_TITLE = classesOf(RAIL, 'rail-title')
const RAIL_TITLE_ROW = classesOf(RAIL, 'items-center gap-x-')
const RAIL_TEXT_COL = classesOf(RAIL, 'flex-col gap-0.5')
const RAIL_SUB = classesOf(RAIL, 'text-white/55 text-xs')
const RAIL_SPACER = classesOf(RAIL, 'rail-spacer')
const SEE_ALL = classesOf(RAIL, 'rail-see-all')
const AI_CHIP = classesOf(RAIL, 'bg-yellow-400/10')
const CO_META = classesOf(CARD, 'co-meta')
const CO_TITLE = classesOf(CARD, 'co-title')
const CO_TOK = classesOf(CARD, 'co-tok')
const CO_TXT = classesOf(CARD, 'co-txt')
const OVERLAY = classesOf(CARD, 'card-overlay')
const BADGES = classesOf(CARD, 'card-badges')
const RESUME = classesOf(CARD, 'resume-pill')
const POSTER_WRAP = classesOf(CARD, 'poster-wrap')
// Settings' typefaces: the attribute-less default plus every `data-font` value.
// Read from appearance.ts so a new typeface is measured without editing this.
const FONTS = [null, ...JSON.parse(
  (fs.readFileSync(path.join(APP, 'src/lib/appearance.ts'), 'utf8').match(/ATTRIBUTED_FONTS[^=]*=\s*(\[[^\]]*\])/) ??
    (() => { throw new Error('verify-mobile: could not read ATTRIBUTED_FONTS from appearance.ts — this check is out of date') })())[1]
    .replace(/'/g, '"'))]

const SUBTITLE = 'Hand-picked by Aurora for your taste'
// [title, AI chip, subtitle, See All]
const RAILS = [
  ['Hidden gems in your library', true, SUBTITLE, false],
  ['Because you watched Everything Everywhere All at Once', true, null, false],
  ['Because you watched Everything Everywhere All at Once', false, null, true],
  ['Continue Watching', false, null, true],
  // The conversational rail: title = the user's typed query, with the chip.
  ['a cozy mystery set in a small coastal town with a quirky detective and no gore', true, 'Your conversational search', false],
  // An unbroken word — a typed query can be anything.
  ['Supercalifragilisticexpialidociousmarathonnight', true, null, true],
  // An LLM-written subtitle carrying one long UNBROKEN token. Underscores, not
  // "/" or "-": Chromium breaks after those, and a fixture it could break was
  // caught by the subtitle's missing break-words in 1 of 24 passes.
  ['Mind-bending sci-fi', true, 'Seeded from collection_1241_harry_potter_extended_directors_cuts_boxset', false],
]
const railHtml = RAILS.map(([t, chip, sub, seeAll], i) => `
  <section class="rail-container" data-rail="${i}">
    <div class="${RAIL_HEADER}">
      <span class="${RAIL_ICON}" data-tint="purple"></span>
      <div class="${RAIL_TEXT_COL}">
        <div class="${RAIL_TITLE_ROW}">
          <h2 class="${RAIL_TITLE}">${t}</h2>
          ${chip ? `<span class="${AI_CHIP}"><svg width="10" height="10"></svg> AI Pick</span>` : ''}
        </div>
        ${sub ? `<span class="${RAIL_SUB}">${sub}</span>` : ''}
      </div>
      <span class="${RAIL_SPACER}" aria-hidden="true"></span>
      ${seeAll ? `<button class="${SEE_ALL}">See All <svg width="14" height="14"></svg></button>` : ''}
    </div>
  </section>`).join('')

// The browse grid's widest meta row (rating · year · runtime · genre), which is
// the row that wrapped, built the way MediaCardCinema renders it: one .co-tok per
// token carrying the dot that precedes it, the rating as the star <svg> + value,
// text in .co-txt.
const STAR = '<span class="star"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15 9 22 9 16.5 13.5 18.5 21 12 16.5 5.5 21 7.5 13.5 2 9 9 9"/></svg> 9.2</span>'
const tok = (inner, i) => `<span class="${CO_TOK}">${i ? '<span class="sep" aria-hidden="true">·</span>' : ''}${inner}</span>`
const META = [STAR, `<span class="${CO_TXT}">1999</span>`, `<span class="${CO_TXT}">2h 16m</span>`,
  `<span class="${CO_TXT}">Science Fiction</span>`].map(tok).join('')
// A single token wider than any phone card — the Continue Watching subtitle
// shape — which cannot wrap away and must ellipsize inside the row instead.
const META_LONE = tok(`<span class="${CO_TXT}">S12E104 · 1h 23m left of 1h 58m</span>`, 0)
// Card widths: the two-up phone grid at 320–430px lands ~130–190px; 206 is the
// rail card. Each card carries two badges, which sit at a fixed offset above the
// overlay's foot — the geometry the one-line meta row exists to protect.
const CARD_WIDTHS = [120, 140, 150, 165, 180, 206]
const cardHtml = CARD_WIDTHS.flatMap(w => [[META, `${w}`], [META_LONE, `${w} lone`]]).map(([meta, id]) => `
  <div class="media-card-cinema" style="width:${parseInt(id)}px" data-card="${id}">
    <div class="${POSTER_WRAP}">
      <div class="poster-img" style="aspect-ratio:2/3;background:#345"></div>
      <div class="${BADGES}"><span class="card-badge is-quality">4K</span><span class="card-badge">PG-13</span></div>
      <button class="${RESUME}"><svg width="10" height="10"></svg>Resume</button>
      <div class="${OVERLAY}">
        <div class="${CO_TITLE}">The Grand Budapest Hotel</div>
        <div class="${CO_META}">${meta}</div>
      </div>
    </div>
  </div>`).join('')

const ORIGIN = 'http://aurora.probe'
// The typeface rides on the served <html>, NOT set after load: setting it from
// script and then awaiting document.fonts.ready resolved before style recalc had
// even requested the new face, so every "typeface" pass silently measured Inter.
const htmlFor = font => `<!doctype html><html lang="en"${font ? ` data-font="${font}"` : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/v2/assets/${cssFile}"><style>body{margin:0}</style></head><body>
<div class="stage-gutter" id="rails">${railHtml}</div>
<div class="stage-gutter" id="cards" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start">${cardHtml}</div>
</body></html>`

const browser = await chromium.launch({ executablePath: EXE })
let problems = 0
const fail = msg => { console.log(`   *** ${msg}`); problems++ }
for (const font of FONTS) {
  console.log(`\n══ typeface: ${font ?? 'default (no data-font)'}`)
  for (const width of [320, 360, 390, 430, 767, 1440]) {
    // isMobile: a phone browser WIDENS the layout viewport to fit overflowing
    // content (the 407px symptom) where a desktop viewport would just scroll, so
    // this is the mode in which the original defect is visible at all.
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true })
    await ctx.route(`${ORIGIN}/**`, route => {
      const p = new URL(route.request().url()).pathname
      if (p === '/') return route.fulfill({ body: htmlFor(font), contentType: 'text/html' })
      const f = path.join(ASSETS, path.basename(p))
      if (p.startsWith('/v2/assets/') && fs.existsSync(f)) {
        const type = f.endsWith('.css') ? 'text/css' : f.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream'
        return route.fulfill({ body: fs.readFileSync(f), contentType: type })
      }
      return route.fulfill({ status: 404, body: '' })
    })
    const page = await ctx.newPage()
    await page.goto(`${ORIGIN}/`)
    const r = await page.evaluate(async () => {
      await document.fonts.ready
      // The family body text resolves to under this typeface — the one the rail
      // title and card meta are set in. It must be among the faces that loaded.
      const bodyFamily = getComputedStyle(document.body).fontFamily.split(',')[0].trim().replace(/['"]/g, '')
      // Faces the page actually requested; `unloaded` ones are declared but unused.
      const faces = [...document.fonts].filter(f => f.status !== 'unloaded')
      const fontErrors = faces.filter(f => f.status === 'error').map(f => f.family)
      const fontsLoaded = faces.filter(f => f.status === 'loaded').map(f => f.family)

      const rails = [...document.querySelectorAll('[data-rail]')].map(sec => {
        const header = sec.firstElementChild
        const secBox = sec.getBoundingClientRect()
        const cs = getComputedStyle(sec)
        const contentRight = secBox.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth)
        const els = [...header.querySelectorAll('*')]
        const worst = Math.max(...els.map(e => e.getBoundingClientRect().right))
        // Text spilling out of its OWN box: an <h2> can be shrunk to fit while an
        // unbroken word runs on past it, which box geometry alone cannot see.
        const spilling = els.filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible')
          .map(e => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : ''))
        return { i: sec.dataset.rail, worst: +worst.toFixed(1), contentRight: +contentRight.toFixed(1), spilling }
      })

      const cards = [...document.querySelectorAll('[data-card]')].map(card => {
        const meta = card.querySelector('.co-meta')
        const ms = getComputedStyle(meta)
        const lh = parseFloat(ms.lineHeight) || parseFloat(ms.fontSize) * 1.5
        const title = card.querySelector('.co-title').getBoundingClientRect()
        const badges = card.querySelector('.card-badges').getBoundingClientRect()
        // The resume pill clears the overlay by its own fixed offset (58px, vs the
        // badges' 62px), so it is the tighter of the two.
        const resume = card.querySelector('.resume-pill').getBoundingClientRect()
        const row = meta.getBoundingClientRect()
        // Tokens that start inside the row are the visible ones; the rest have
        // wrapped to a second line that the row must CLIP away — without the
        // clip they paint below it, over the card's foot.
        const toks = [...meta.children]
        const visibleToks = toks.filter(c => c.getBoundingClientRect().top < row.bottom - 0.5)
        const hiddenToks = toks.filter(c => !visibleToks.includes(c))
        const rowClips = /hidden|clip/.test(ms.overflowY) && /hidden|clip/.test(ms.overflowX)
        const visible = visibleToks.map(c => c.getBoundingClientRect())
        // Every ELEMENT inside a visible token, not just the token's own box: a
        // token can be shrunk to fit while its text runs on past it.
        const inner = visibleToks.flatMap(c => [c, ...c.querySelectorAll('*')]).map(e => e.getBoundingClientRect())
        const spill = Math.max(0, ...inner.map(b => b.right - row.right), ...visible.map(b => b.bottom - row.bottom))
        // Truncated tokens (ellipsis engaged). Only legitimate for a token ALONE on
        // the row; with company, the tokens that do not fit must drop whole — not
        // every token shrink to "19…" / "2h…", which is what a one-line
        // nowrap flex row degrades to.
        const cut = visibleToks.flatMap(c => [c, ...c.querySelectorAll('*')]).filter(e => e.scrollWidth > e.clientWidth + 1)
        const truncated = visibleToks.filter(c => cut.some(e => c === e || c.contains(e))).length
        // Overrunning content only shows an ELLIPSIS if its element also clips
        // (text-overflow does nothing under overflow:visible) — otherwise the text
        // runs on and is hard-clipped by the row. Geometry cannot tell those
        // apart, so read the computed style of exactly the overrunning elements.
        const noEllipsis = cut.filter(e => {
          const s = getComputedStyle(e)
          return !(s.textOverflow === 'ellipsis' && /hidden|clip/.test(s.overflowX))
        }).length
        return { w: card.dataset.card, metaH: +row.height.toFixed(1), lh: +lh.toFixed(1),
                 tallestToken: +Math.max(0, ...visible.map(b => b.height)).toFixed(1),
                 shown: visible.length, of: toks.length, hidden: hiddenToks.length, rowClips, truncated, noEllipsis,
                 spill: +spill.toFixed(1), gap: +(title.top - badges.bottom).toFixed(1),
                 pillGap: +(title.top - resume.bottom).toFixed(1) }
      })
      return { rails, cards, fontErrors, fontsLoaded, bodyFamily, iw: window.innerWidth, sw: document.documentElement.scrollWidth }
    })

    const before = problems
    if (r.fontErrors.length) fail(`web fonts failed to load: ${[...new Set(r.fontErrors)].join(', ')} — measurements would use a fallback font`)
    if (!r.fontsLoaded.includes(r.bodyFamily)) fail(`body font "${r.bodyFamily}" did not load (loaded: ${[...new Set(r.fontsLoaded)].join(', ') || 'none'}) — measurements would use a fallback font`)
    if (r.iw !== width || r.sw > width) fail(`the page is wider than the device: ${r.sw}px on a ${width}px viewport`)
    for (const rail of r.rails) {
      if (rail.worst > rail.contentRight + 0.5) fail(`rail ${rail.i}: header reaches ${rail.worst}, past the rail's content edge ${rail.contentRight}`)
      if (rail.spilling.length) fail(`rail ${rail.i}: text overruns its box in ${rail.spilling.join(', ')}`)
    }
    for (const c of r.cards) {
      const at = `card ${c.w}px`
      if (c.shown < 1) fail(`${at}: shows no meta at all`)
      if (!(c.tallestToken <= c.lh + 1 && c.metaH <= c.lh + 1)) fail(`${at}: META WRAPS — row ${c.metaH}px, tallest token ${c.tallestToken}px, line ${c.lh}px`)
      if (c.gap < 0) fail(`${at}: BADGES OVER TITLE by ${-c.gap}px`)
      if (c.pillGap < 0) fail(`${at}: RESUME PILL OVER TITLE by ${-c.pillGap}px`)
      if (c.spill > 0.5 || c.noEllipsis) fail(`${at}: TOKENS HARD-CLIPPED — spill ${c.spill}px, ${c.noEllipsis} overrun(s) with no ellipsis`)
      if (c.hidden && !c.rowClips) fail(`${at}: ${c.hidden} wrapped token(s) are PAINTED below the row — it does not clip`)
      if (c.truncated && c.shown > 1) fail(`${at}: TOKENS SHRUNK INSTEAD OF DROPPED — ${c.truncated} of ${c.shown} truncated`)
    }
    const shown = r.cards.filter(c => !c.w.includes('lone')).map(c => `${c.w}:${c.shown}/${c.of}`).join(' ')
    console.log(`── ${String(width).padStart(4)}px  ${problems === before ? 'ok' : 'FAIL'}   ${r.bodyFamily} · page ${r.sw}px · ${r.rails.length} rail headers · meta tokens shown ${shown}`)
    await ctx.close()
  }
}
await browser.close()
console.log(`\n${problems} mobile layout problem(s).`)
process.exit(problems ? 1 : 0)
