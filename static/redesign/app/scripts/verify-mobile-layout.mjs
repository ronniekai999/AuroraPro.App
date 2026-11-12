// Phone-width layout guards, measured in a REAL layout engine against the real
// built stylesheet and the real web fonts — the same approach as
// verify-page-alignment.mjs, and for the same reason: both defects below were
// invisible to arithmetic and to jsdom, and were found by rendering the SPA at
// 390px.
//
//   1. RAIL HEADER OVERFLOW. A rail title was `white-space: nowrap` beside a
//      chip in a non-wrapping row. "Hidden gems in your library" + chip pushed
//      the chip 17px past the rail, which widened the whole page's layout
//      viewport to 407px on 320/360/390px phones. The visible symptom was not
//      the chip: fixed, right-anchored sheets resolved against the widened
//      viewport and were clipped off the right edge. Titles and subtitles are
//      user- and LLM-written (the conversational rail's title is the query
//      the user typed), so an unbroken word and a long subtitle are cases.
//      The header is now a title (a "see all" link when the rail has one)
//      over one line of subtitle or AI attribution; the same cases are held
//      against that markup.
//
//   2. CARD FACTS WRAPPING. The facts row (`.co-meta`) is ONE line, and that
//      is load-bearing: captions in a rail or a grid row must be the same
//      height or the row's posters stop lining up. Each token span used to
//      wrap its OWN text: at a two-up phone grid's ~165px, "2h 16m" broke
//      over two lines and the row grew. Tokens that do not fit must drop
//      WHOLE, a lone token must ellipsize, and the caption must be the same
//      height on every card that has a facts line, whatever its facts are (a
//      card with none is the title alone, one line shorter, and is not held
//      to that). A pick's reason takes the facts line's place under a pointer
//      or keyboard focus, and must not change the caption's height either.
//
//   3. CARD ACTIONS. Play, Add and More sit on the poster's foot (under a
//      pointer or keyboard focus; More alone on a touch screen). Each must
//      be a 44px TARGET: what is measured is the hit area, by hit-testing,
//      not the drawn disc, which on a narrow card (the compact grid, a
//      two-up phone grid) is 36px inside a 44px area, with Add dropping out
//      on the narrowest. An earlier version of this check measured the disc
//      and set its floor at 36 to pass; the requirement is 44 and so is the
//      floor now. The areas must not overlap each other, leave the poster or
//      sit on the progress bar.
//
//      A button that is not drawn must not be hit-testable: at rest, with a
//      pointer device, a point over any of the three must reach the art, not
//      the button (a tap on a touchscreen laptop landed on an invisible
//      Play), and Play and Add must be out of the accessibility tree
//      (visibility). After a MOUSE click on More, with the pointer gone, the
//      layer must be hidden again (:focus-within kept it up).
//      And at rest nothing but the art (and a progress bar) may be painted
//      on the poster.
//
// Class lists are READ FROM THE SOURCE (see classesOf / mustHave), so a call
// site drifting away from the fix fails here rather than passing against a
// stale copy. The page is served over HTTP, not setContent: the built CSS
// points its @font-face rules at absolute /v2/assets/ URLs, which an
// about:blank page cannot resolve — the first version of this script measured
// every case in the fallback font without knowing it. It now fails if any web
// font errors.
//
// MUTATION-TESTED: each of these, applied ALONE to index.css, turns this check
// red — the facts row losing its clip or its one-line height; a token losing
// nowrap; `.co-txt` losing its ellipsis; the caption title wrapping; either
// narrow-card tier for the action buttons removed; the narrow tier's or the
// touch More's 44px hit area (its ::before) removed; the actions layer shown
// at rest; a hidden button left hit-testable (pointer-events) or in the
// accessibility tree (visibility); focus or a pointer no longer revealing
// the layer; the layer held up by :focus-within after a mouse click; a touch
// screen showing all three buttons; the rail title or subtitle unable to
// break a word; the AI dot allowed to shrink; the buttons sitting on the
// progress bar; the reason line changing the caption's height or not
// replacing the facts.
//
// What this cannot see is the card markup itself — the probe rebuilds it from
// class names — so the token / separator STRUCTURE and the action buttons'
// behaviour are pinned by MediaCardCinema.meta.test.tsx and
// MediaCardCinema.actions.test.tsx instead.
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
/** Dies unless `file` contains `text` verbatim: for class names this probe
 *  writes by hand because the source builds them (a template literal). */
function mustHave(file, text) {
  if (!fs.readFileSync(path.join(APP, file), 'utf8').includes(text)) {
    throw new Error(`verify-mobile: ${file} no longer contains ${JSON.stringify(text)} — this check is out of date, not passing`)
  }
}
const RAIL_HEADER = classesOf(RAIL, 'rail-header')
const RAIL_TITLE = classesOf(RAIL, 'rail-title')
const SEE_ALL = classesOf(RAIL, 'rail-see-all')
const RAIL_CHEV = classesOf(RAIL, 'rail-chev')
// `rail-sub` is also a prefix of rail-sub-text, so it is matched whole.
mustHave(RAIL, 'className="rail-sub"')
const RAIL_SUB = 'rail-sub'
const RAIL_DOT = classesOf(RAIL, 'rail-dot')
const RAIL_SUB_TEXT = classesOf(RAIL, 'rail-sub-text')
const CO_META = classesOf(CARD, 'co-meta')
const CC_TITLE = classesOf(CARD, 'cc-title')
const CO_TOK = classesOf(CARD, 'co-tok')
const CO_TXT = classesOf(CARD, 'co-txt')
const CO_SAVED = classesOf(CARD, 'co-saved')
const CAPTION = classesOf(CARD, 'card-caption')
const POSTER_WRAP = classesOf(CARD, 'poster-wrap')
const ACT_PLAY = classesOf(CARD, 'card-act-play')
const ACT_MORE = classesOf(CARD, 'card-act-more')
// The Add button is plain `card-act`; the actions layer and the card root
// are built with template literals.
mustHave(CARD, 'className="card-act"')
mustHave(CARD, '`card-actions${')
mustHave(CARD, '`media-card-cinema group ')
mustHave(CARD, 'className="progress-bar"')
mustHave(CARD, 'className="card-open"')
mustHave(CARD, 'className="co-reason"')
mustHave(CARD, "'has-reason '")

// Small buttons outside a card: drawn at 36px, with a 44px target on a touch
// screen (.stage-hit44). Tonight's live strip (Join; I'm in, Maybe, Open
// lobby, side by side) and the search page's "Search by description" and
// "Try again". Built from the components' own class lists, in the rows they
// sit in.
const LIVE = 'src/components/TonightLive.tsx'
const SEARCH = 'src/components/SearchView.tsx'
const LIVE_JOIN = classesOf(LIVE, 'tonight-live-act stage-hit44')
const LIVE_RSVP = classesOf(LIVE, 'tonight-live-rsvp')
const LIVE_OPEN = classesOf(LIVE, 'tonight-live-open')
mustHave(LIVE, 'className="tonight-live"')
mustHave(LIVE, 'className="tonight-live-row"')
mustHave(LIVE, 'className="tonight-live-acts"')
mustHave(LIVE, 'className="tonight-live-text"')
const DESCRIBE_LINE = classesOf(SEARCH, 'search-describe-line')
const FAILED_LINE = classesOf(SEARCH, 'search-failed-line')
const DESCRIBE_BTN = classesOf(SEARCH, 'search-describe-btn')
const RETRY_BTN = classesOf(SEARCH, 'search-retry-btn')
const smallHtml = `
  <section class="tonight-live" data-small="live">
    <div class="tonight-live-row"><div class="tonight-live-text"><span class="tonight-live-title">3 watching Night Train to Meridian</span></div>
      <button type="button" class="${LIVE_JOIN}" data-small-btn="Join">Join</button></div>
    <div class="tonight-live-row"><div class="tonight-live-text"><span class="tonight-live-title">Jonah invited you to watch Kestrel</span></div>
      <div class="tonight-live-acts">
        <button type="button" class="${LIVE_RSVP}" data-small-btn="I'm in">I'm in</button>
        <button type="button" class="${LIVE_RSVP}" data-small-btn="Maybe">Maybe</button>
        <button type="button" class="${LIVE_OPEN}" data-small-btn="Open lobby">Open lobby</button>
      </div></div>
  </section>
  <p class="${DESCRIBE_LINE}" data-small="describe">These match the title.
    <button type="button" class="${DESCRIBE_BTN}" data-small-btn="Search by description">Search by description</button></p>
  <p class="${FAILED_LINE}" data-small="failed">Nothing is wrong with what you typed. The server could not run it.
    <button type="button" class="${RETRY_BTN}" data-small-btn="Try again">Try again</button></p>`

const SUBTITLE = 'Hand-picked by Aurora for your taste'
// [title, AI attribution, subtitle, See All]
const RAILS = [
  ['Hidden gems in your library', true, SUBTITLE, false],
  ['Because you watched Everything Everywhere All at Once', true, null, false],
  ['Because you watched Everything Everywhere All at Once', false, null, true],
  ['Continue Watching', false, null, true],
  // The conversational rail: title = the user's typed query, with attribution.
  ['a cozy mystery set in a small coastal town with a quirky detective and no gore', true, 'Your conversational search', false],
  // An unbroken word — a typed query can be anything — as a link.
  ['Supercalifragilisticexpialidociousmarathonnight', true, null, true],
  // An LLM-written subtitle carrying one long UNBROKEN token. Underscores, not
  // "/" or "-": Chromium breaks after those, and a fixture it could break was
  // caught by the subtitle's missing break rule in 1 of 24 passes.
  ['Mind-bending sci-fi', true, 'Seeded from collection_1241_harry_potter_extended_directors_cuts_boxset', false],
]
const railHtml = RAILS.map(([t, ai, sub, seeAll], i) => `
  <section class="rail-container" data-rail="${i}">
    <div class="${RAIL_HEADER}">
      <h2 class="${RAIL_TITLE}">${seeAll
        ? `<button type="button" class="${SEE_ALL}"><span>${t}</span><svg class="${RAIL_CHEV}" width="18" height="18"></svg></button>`
        : t}</h2>
      ${ai || sub ? `<p class="${RAIL_SUB}">${ai ? `<span class="${RAIL_DOT}"></span>` : ''}<span class="${RAIL_SUB_TEXT}">${
        ai ? (sub ? `Picked by Aurora: ${sub}` : 'Picked by Aurora') : sub}</span></p>` : ''}
    </div>
  </section>`).join('')

// The widest facts row (rating · year · runtime · genre), which is the row
// that wrapped, built the way MediaCardCinema renders it: one .co-tok per
// token carrying the dot that precedes it, the rating as the star <svg> +
// value, text in .co-txt.
const STAR = '<span class="star"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15 9 22 9 16.5 13.5 18.5 21 12 16.5 5.5 21 7.5 13.5 2 9 9 9"/></svg> 9.2</span>'
const tok = (inner, i) => `<span class="${CO_TOK}">${i ? '<span class="sep" aria-hidden="true">·</span>' : ''}${inner}</span>`
const SAVED = `<span class="${CO_SAVED}"><svg width="12" height="12"></svg></span>`
const META = [STAR, `<span class="${CO_TXT}">1999</span>`, `<span class="${CO_TXT}">2h 16m</span>`,
  `<span class="${CO_TXT}">Science Fiction</span>`].map(tok).join('')
// A single token wider than any phone card — the Continue Watching subtitle
// shape — which cannot wrap away and must ellipsize inside the row instead.
const META_LONE = tok(`<span class="${CO_TXT}">S12E104 · 1h 23m left of 1h 58m</span>`, 0)
// Card widths: the compact grid and a three-up phone grid land ~100–140px, a
// two-up phone grid ~130–190px; 176 is the rail card, 232 the children's.
const CARD_WIDTHS = [104, 120, 128, 140, 150, 165, 176, 190, 232]
// Per width: the full facts row, the same on a saved title, a lone long
// token, a pick with a reason (longer than any card is wide), and a card
// with no facts at all (its caption is the title alone).
mustHave(CARD, 'className="co-reason-dot"')
mustHave(CARD, 'className="co-reason-txt"')
const REASON = '<div class="co-reason"><span class="co-reason-dot"></span><span class="co-reason-txt">A slow-burn thriller with the patient tension you gave five stars last month</span></div>'
const VARIANTS = [['full', META], ['saved', SAVED + META], ['lone', META_LONE], ['reason', META], ['bare', null]]
// The card as MediaCardCinema builds it: the art is a button, and the
// progress bar and the actions are its siblings.
const cardHtml = CARD_WIDTHS.flatMap(w => VARIANTS.map(([kind, meta]) => `
  <div class="media-card-cinema group ${kind === 'reason' ? 'has-reason ' : ''}" style="width:${w}px" data-card="${w} ${kind}">
    <div class="${POSTER_WRAP}">
      <button type="button" class="card-open"><span class="poster-img" style="aspect-ratio:2/3;background:#345"></span></button>
      <div class="progress-bar"><div class="progress-fill" style="width:40%"></div></div>
      <div class="card-actions has-progress">
        <button tabindex="-1" class="${ACT_PLAY}"><svg width="18" height="18"></svg></button>
        <button tabindex="-1" class="card-act"><svg width="20" height="20"></svg></button>
        <button class="${ACT_MORE}"><svg width="20" height="20"></svg></button>
      </div>
    </div>
    <div class="${CAPTION}">
      <div class="${CC_TITLE}">The Grand Budapest Hotel and the Very Long Subtitle</div>
      ${meta ? `<div class="${CO_META}">${meta}</div>` : ''}
      ${kind === 'reason' ? REASON : ''}
    </div>
  </div>`)).join('')

const ORIGIN = 'http://aurora.probe'
// The app has one typeface system (Bricolage Grotesque display, Inter body),
// so one pass per width measures every face a viewer can see. The page fails
// below if either face errors or the measured text resolves to a fallback.
const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/v2/assets/${cssFile}">
<style>body{margin:0}
/* End states only: the actions layer fades in over 150ms, and a computed
   opacity read in the same task as the focus would be the fade's first frame. */
*,*::before,*::after{transition:none!important;animation:none!important}</style></head><body>
<div class="stage-gutter" id="rails">${railHtml}</div>
<div class="stage-gutter" id="cards" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start">${cardHtml}</div>
<div class="stage-gutter" id="small" style="padding-top:40px;padding-bottom:40px">${smallHtml}</div>
</body></html>`

const browser = await chromium.launch({ executablePath: EXE })
let problems = 0
const fail = msg => { console.log(`   *** ${msg}`); problems++ }
// Two input modes per width: a touch screen (no hover: More alone shows) and
// a pointer (hover: all three actions show under it).
for (const touch of [true, false]) {
  console.log(`\n══ ${touch ? 'touch (no hover)' : 'pointer (hover)'}`)
  for (const width of [320, 360, 390, 430, 767, 1440]) {
    // isMobile: a phone browser WIDENS the layout viewport to fit overflowing
    // content (the 407px symptom) where a desktop viewport would just scroll, so
    // this is the mode in which the original defect is visible at all.
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: touch, hasTouch: touch })
    await ctx.route(`${ORIGIN}/**`, route => {
      const p = new URL(route.request().url()).pathname
      if (p === '/') return route.fulfill({ body: PAGE_HTML, contentType: 'text/html' })
      const f = path.join(ASSETS, path.basename(p))
      if (p.startsWith('/v2/assets/') && fs.existsSync(f)) {
        const type = f.endsWith('.css') ? 'text/css' : f.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream'
        return route.fulfill({ body: fs.readFileSync(f), contentType: type })
      }
      return route.fulfill({ status: 404, body: '' })
    })
    const page = await ctx.newPage()
    await page.goto(`${ORIGIN}/`)
    // A real key press, so the focus() calls below are keyboard focus to the
    // browser (:focus-visible), which is what reveals a card's actions.
    await page.keyboard.press('Tab')
    await page.evaluate(() => document.activeElement?.blur?.())
    const r = await page.evaluate(async () => {
      await document.fonts.ready
      // The family body text resolves to — the one the card caption and the
      // rail subtitle are set in. It must be among the faces that loaded.
      const bodyFamily = getComputedStyle(document.body).fontFamily.split(',')[0].trim().replace(/['"]/g, '')
      // The rail title is set in the DISPLAY face, so the body face loading
      // does not prove the title was measured in its own font.
      const titleFamily = getComputedStyle(document.querySelector('.rail-title')).fontFamily.split(',')[0].trim().replace(/['"]/g, '')
      // Faces the page actually requested; `unloaded` ones are declared but unused.
      const faces = [...document.fonts].filter(f => f.status !== 'unloaded')
      const fontErrors = faces.filter(f => f.status === 'error').map(f => f.family)
      const fontsLoaded = faces.filter(f => f.status === 'loaded').map(f => f.family)
      const hover = matchMedia('(hover: hover)').matches

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
        // The AI dot must stay a dot: a flex row that squeezed it would erase
        // the one mark that says who picked the rail.
        const dot = header.querySelector('.rail-dot')?.getBoundingClientRect()
        return { i: sec.dataset.rail, worst: +worst.toFixed(1), contentRight: +contentRight.toFixed(1), spilling,
                 dot: dot ? [Math.round(dot.width), Math.round(dot.height)] : null }
      })

      const boxOf = el => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height } }
      const shown = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' }
      /** Whether a press at (x, y) reaches `el` (its ::before included). */
      const hits = (el, x, y) => { const at = document.elementFromPoint(x, y); return !!at && (at === el || el.contains(at)) }
      /** The button's TARGET, measured by hit-testing in half-pixel steps out
       *  from its centre: how far a press may land and still reach it. A
       *  neighbour's area laid over it, or the poster clipping it, shortens
       *  this, where the drawn box would not show either. */
      const hitArea = el => {
        const b = el.getBoundingClientRect()
        const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2
        if (!hits(el, cx, cy)) return { w: 0, h: 0, l: cx, r: cx, t: cy, b: cy }
        const run = (dx, dy) => { let n = 0; while (n < 200 && hits(el, cx + dx * (n + 1) * 0.5, cy + dy * (n + 1) * 0.5)) n++; return n }
        const [left, right, up, down] = [run(-1, 0), run(1, 0), run(0, -1), run(0, 1)]
        return { w: (left + right + 1) * 0.5, h: (up + down + 1) * 0.5,
                 l: cx - left * 0.5, r: cx + (right + 1) * 0.5, t: cy - up * 0.5, b: cy + (down + 1) * 0.5 }
      }
      const cards = []
      for (const card of document.querySelectorAll('[data-card]')) {
        // Hit-testing only answers for points on screen.
        card.scrollIntoView({ block: 'center' })
        const wrap = card.querySelector('.poster-wrap')
        const layer = card.querySelector('.card-actions')
        const all = [...card.querySelectorAll('.card-act')]
        const nameOf = a => (a.className.includes('card-act-play') ? 'play' : a.className.includes('card-act-more') ? 'more' : 'add')
        const centreHit = a => { const b = a.getBoundingClientRect(); return b.width > 0 && hits(a, (b.left + b.right) / 2, (b.top + b.bottom) / 2) }
        const caption0 = card.querySelector('.card-caption').getBoundingClientRect().height
        const reasonEl = card.querySelector('.co-reason')
        const metaEl = card.querySelector('.co-meta')
        const atRest = { layerOpacity: getComputedStyle(layer).opacity,
          // What a press would reach, and what assistive tech is offered,
          // while nothing is drawn.
          hittable: all.filter(centreHit).map(nameOf),
          inTree: all.filter(shown).map(nameOf),
          reasonShown: reasonEl ? getComputedStyle(reasonEl).display !== 'none' : null }
        // Keyboard focus on the card's art is what reveals the actions
        // without a pointer; measure them in that state.
        card.querySelector('.card-open').focus({ preventScroll: true })
        const poster = boxOf(wrap)
        const acts = all.filter(shown).map(a => ({ cls: a.className, ...boxOf(a), hit: hitArea(a) }))
        const focused = { layerOpacity: getComputedStyle(layer).opacity,
          captionH: card.querySelector('.card-caption').getBoundingClientRect().height,
          reasonShown: reasonEl ? getComputedStyle(reasonEl).display !== 'none' : null,
          metaShown: metaEl ? getComputedStyle(metaEl).display !== 'none' : null,
          reasonSpill: reasonEl ? Math.max(0, ...[reasonEl, ...reasonEl.querySelectorAll('*')].map(e => e.getBoundingClientRect().right - card.getBoundingClientRect().right)) : 0,
          reasonH: reasonEl ? reasonEl.getBoundingClientRect().height : 0 }
        document.activeElement.blur()
        const title = card.querySelector('.cc-title')
        const meta = card.querySelector('.co-meta')
        const caption = boxOf(card.querySelector('.card-caption'))
        const out = { w: card.dataset.card, poster, acts, atRest, focused, captionH: +caption.h.toFixed(1), caption0,
                      titleLines: +(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight)).toFixed(2),
                      titleClips: title.scrollWidth <= title.clientWidth + 1 || getComputedStyle(title).textOverflow === 'ellipsis' }
        if (meta) {
          const ms = getComputedStyle(meta)
          const lh = parseFloat(ms.lineHeight) || parseFloat(ms.fontSize) * 1.5
          const row = meta.getBoundingClientRect()
          // Tokens that start inside the row are the visible ones; the rest
          // have wrapped to a second line that the row must CLIP away —
          // without the clip they paint below it, over the next row's poster.
          const toks = [...meta.querySelectorAll(':scope > .co-tok')]
          const visibleToks = toks.filter(c => c.getBoundingClientRect().top < row.bottom - 0.5)
          const hiddenToks = toks.filter(c => !visibleToks.includes(c))
          const rowClips = /hidden|clip/.test(ms.overflowY) && /hidden|clip/.test(ms.overflowX)
          const visible = visibleToks.map(c => c.getBoundingClientRect())
          // Every ELEMENT inside a visible token, not just the token's own box:
          // a token can be shrunk to fit while its text runs on past it.
          const inner = visibleToks.flatMap(c => [c, ...c.querySelectorAll('*')]).map(e => e.getBoundingClientRect())
          const spill = Math.max(0, ...inner.map(b => b.right - row.right), ...visible.map(b => b.bottom - row.bottom))
          // Truncated tokens (ellipsis engaged). Only legitimate for a token
          // ALONE on the row; with company, the tokens that do not fit must
          // drop whole — not every token shrink to "19…" / "2h…".
          const cut = visibleToks.flatMap(c => [c, ...c.querySelectorAll('*')]).filter(e => e.scrollWidth > e.clientWidth + 1)
          const truncated = visibleToks.filter(c => cut.some(e => c === e || c.contains(e))).length
          // Overrunning content only shows an ELLIPSIS if its element also
          // clips; otherwise the text runs on and is hard-clipped by the row.
          const noEllipsis = cut.filter(e => {
            const s = getComputedStyle(e)
            return !(s.textOverflow === 'ellipsis' && /hidden|clip/.test(s.overflowX))
          }).length
          const saved = meta.querySelector(':scope > .co-saved')?.getBoundingClientRect()
          Object.assign(out, { metaH: +row.height.toFixed(1), lh: +lh.toFixed(1),
            // The tallest thing inside a visible token, not the token's own
            // box: a token has a fixed height, so text that wrapped INSIDE it
            // (a second line, clipped away with no ellipsis) would hide
            // behind that box.
            tallestToken: +Math.max(0, ...inner.map(b => b.height)).toFixed(1),
            shown: visible.length, of: toks.length, hidden: hiddenToks.length, rowClips, truncated, noEllipsis,
            spill: +spill.toFixed(1),
            savedInRow: saved ? (saved.width >= 10 && saved.right <= row.right + 0.5 && saved.top < row.bottom - 0.5) : null })
        }
        cards.push(out)
      }
      // The small buttons: each one's drawn box and its target.
      const small = [...document.querySelectorAll('[data-small-btn]')].map(b => {
        b.scrollIntoView({ block: 'center' })
        return { name: b.dataset.smallBtn, ...boxOf(b), hit: hitArea(b) }
      })
      return { rails, cards, small, fontErrors, fontsLoaded, bodyFamily, titleFamily, hover, iw: window.innerWidth, sw: document.documentElement.scrollWidth }
    })

    const before = problems
    if (!touch) {
      // With a real pointer, on one card of each tier: hovering reveals the
      // actions and makes them take presses; a click on More, and the pointer
      // then leaving, hides them again though More still has focus.
      for (const w of [128, 150, 176]) {
        const sel = `[data-card="${w} full"]`
        await page.locator(sel).scrollIntoViewIfNeeded()
        await page.mouse.move(0, 0)
        const art = await page.locator(`${sel} .card-open`).boundingBox()
        await page.mouse.move(art.x + art.width / 2, art.y + art.height / 3)
        const more = await page.locator(`${sel} .card-act-more`).boundingBox()
        const state = () => page.evaluate(s => {
          const card = document.querySelector(s)
          const m = card.querySelector('.card-act-more').getBoundingClientRect()
          const at = document.elementFromPoint((m.left + m.right) / 2, (m.top + m.bottom) / 2)
          return { opacity: getComputedStyle(card.querySelector('.card-actions')).opacity, moreHit: !!at?.closest?.('.card-act-more'),
                   focusOnMore: document.activeElement?.classList.contains('card-act-more') }
        }, sel)
        const hovered = await state()
        if (hovered.opacity !== '1' || !hovered.moreHit) fail(`card ${w}px: a pointer over the card does not reveal its actions (opacity ${hovered.opacity}, More takes a press: ${hovered.moreHit})`)
        await page.mouse.click(more.x + more.width / 2, more.y + more.height / 2)
        await page.mouse.move(0, 0)
        const after = await state()
        if (!after.focusOnMore) fail(`card ${w}px: the click did not land on More, so this pass proves nothing`)
        if (after.opacity !== '0' || after.moreHit) fail(`card ${w}px: after a mouse click on More the actions stay up with the pointer gone (opacity ${after.opacity}, More takes a press: ${after.moreHit})`)
        await page.evaluate(() => document.activeElement?.blur?.())
      }
    }
    if (r.hover === touch) fail(`this pass is meant to be ${touch ? 'without' : 'with'} hover, and the page reports the opposite — the action checks below would be measuring the wrong mode`)
    if (r.fontErrors.length) fail(`web fonts failed to load: ${[...new Set(r.fontErrors)].join(', ')} — measurements would use a fallback font`)
    if (!r.fontsLoaded.includes(r.bodyFamily)) fail(`body font "${r.bodyFamily}" did not load (loaded: ${[...new Set(r.fontsLoaded)].join(', ') || 'none'}) — measurements would use a fallback font`)
    if (!r.fontsLoaded.includes(r.titleFamily)) fail(`rail title font "${r.titleFamily}" did not load (loaded: ${[...new Set(r.fontsLoaded)].join(', ') || 'none'}) — the title would be measured in a fallback font`)
    if (r.iw !== width || r.sw > width) fail(`the page is wider than the device: ${r.sw}px on a ${width}px viewport`)
    for (const rail of r.rails) {
      if (rail.worst > rail.contentRight + 0.5) fail(`rail ${rail.i}: header reaches ${rail.worst}, past the rail's content edge ${rail.contentRight}`)
      if (rail.spilling.length) fail(`rail ${rail.i}: text overruns its box in ${rail.spilling.join(', ')}`)
      if (rail.dot && (rail.dot[0] !== 8 || rail.dot[1] !== 8)) fail(`rail ${rail.i}: the AI dot is ${rail.dot[0]}x${rail.dot[1]}, not 8x8 — it was squeezed`)
    }
    // Every caption of a kind must be the same height at every width: the
    // row's posters line up only if they do.
    const withMeta = r.cards.filter(c => c.metaH !== undefined)
    const capHeights = [...new Set(withMeta.map(c => c.captionH))]
    if (capHeights.length !== 1) fail(`captions with a facts line are not one height: ${capHeights.join(', ')}px`)
    for (const c of r.cards) {
      const at = `card ${c.w.replace(' ', 'px, ')}`
      // 3. Actions.
      if (c.atRest.layerOpacity !== (touch ? '1' : '0')) fail(`${at}: the actions layer is at opacity ${c.atRest.layerOpacity} at rest; ${touch ? 'a touch screen needs More always there' : 'a poster shows nothing on its art at rest'}`)
      if (c.focused.layerOpacity !== '1') fail(`${at}: keyboard focus on the card does not reveal its actions (opacity ${c.focused.layerOpacity})`)
      // A button that is not drawn takes no press and is not offered to
      // assistive tech. With a pointer nothing is drawn at rest; on a touch
      // screen More is, alone.
      const restWant = touch ? 'more' : ''
      if (c.atRest.hittable.join() !== restWant) fail(`${at}: at rest a press reaches ${c.atRest.hittable.join(', ') || 'no button'}; ${touch ? 'a touch screen offers More alone' : 'an action that is not drawn must not be hit-testable'}`)
      if (c.atRest.inTree.join() !== 'more') fail(`${at}: at rest the accessibility tree holds ${c.atRest.inTree.join(', ') || 'no button'}, expected More alone (Play and Add are not drawn and a keyboard never reaches them)`)
      const names = c.acts.map(a => (a.cls.includes('card-act-play') ? 'play' : a.cls.includes('card-act-more') ? 'more' : 'add'))
      if (!names.includes('more')) fail(`${at}: no More button is shown — on a card this narrow the menu is the only way to everything`)
      if (touch && names.join() !== 'more') fail(`${at}: a touch screen shows ${names.join(', ') || 'nothing'}, expected More alone`)
      for (const a of c.acts) {
        if (a.l < c.poster.l - 0.5 || a.r > c.poster.r + 0.5 || a.t < c.poster.t - 0.5 || a.b > c.poster.b + 0.5) fail(`${at}: an action button leaves the poster (${a.l.toFixed(0)}..${a.r.toFixed(0)} in ${c.poster.l.toFixed(0)}..${c.poster.r.toFixed(0)})`)
        // The TARGET, by hit-testing: 44px, the requirement. The drawn disc
        // may be smaller (36px on a narrow card) and is not what is held.
        if (a.hit.w < 44 || a.hit.h < 44) fail(`${at}: an action's target is ${a.hit.w}x${a.hit.h}px by hit-testing (its disc is ${a.w.toFixed(0)}x${a.h.toFixed(0)}), under the 44px a touch target needs`)
        if (a.w < 35.5 || a.h < 35.5) fail(`${at}: an action's disc is drawn at ${a.w.toFixed(0)}x${a.h.toFixed(0)}, too small to read`)
        if (a.hit.l < c.poster.l - 0.5 || a.hit.r > c.poster.r + 0.5 || a.hit.t < c.poster.t - 0.5 || a.hit.b > c.poster.b + 0.5) fail(`${at}: an action's target leaves the poster`)
        // The progress bar is 3px at the poster's foot; a button must not sit on it.
        if (a.b > c.poster.b - 3 + 0.5) fail(`${at}: an action button covers the progress bar`)
      }
      for (let i = 0; i < c.acts.length; i++) for (let j = i + 1; j < c.acts.length; j++) {
        const [a, b] = [c.acts[i], c.acts[j]]
        if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) fail(`${at}: action buttons OVERLAP`)
      }
      // The reason: hidden at rest, in the facts line's place under focus,
      // inside the card, and the caption no taller for it.
      if (c.atRest.reasonShown !== null) {
        if (c.atRest.reasonShown) fail(`${at}: the pick's reason is drawn at rest, under the facts`)
        if (!touch) {
          if (!c.focused.reasonShown || c.focused.metaShown) fail(`${at}: keyboard focus does not swap the facts line for the pick's reason`)
          if (Math.abs(c.focused.captionH - c.caption0) > 0.5) fail(`${at}: the caption is ${c.focused.captionH}px with the reason and ${c.caption0}px without — the row's posters would jump`)
          if (c.focused.reasonSpill > 0.5) fail(`${at}: the reason runs ${c.focused.reasonSpill.toFixed(1)}px past the card`)
          if (c.focused.reasonH > 17) fail(`${at}: the reason wraps (${c.focused.reasonH}px tall)`)
        }
      }
      // The title is one line, ellipsized.
      if (c.titleLines > 1.1) fail(`${at}: the caption title wraps to ${c.titleLines} lines`)
      if (!c.titleClips) fail(`${at}: the caption title overruns with no ellipsis`)
      if (c.metaH === undefined) continue
      // 2. Facts.
      if (c.shown < 1) fail(`${at}: shows no facts at all`)
      if (!(c.tallestToken <= c.lh + 1 && c.metaH <= c.lh + 1)) fail(`${at}: FACTS WRAP — row ${c.metaH}px, tallest token ${c.tallestToken}px, line ${c.lh}px`)
      if (c.spill > 0.5 || c.noEllipsis) fail(`${at}: TOKENS HARD-CLIPPED — spill ${c.spill}px, ${c.noEllipsis} overrun(s) with no ellipsis`)
      if (c.hidden && !c.rowClips) fail(`${at}: ${c.hidden} wrapped token(s) are PAINTED below the row — it does not clip`)
      if (c.truncated && c.shown > 1) fail(`${at}: TOKENS SHRUNK INSTEAD OF DROPPED — ${c.truncated} of ${c.shown} truncated`)
      if (c.savedInRow === false) fail(`${at}: the saved mark is squeezed or pushed out of the facts row`)
    }
    // 4. Small buttons outside a card. On a touch screen each is a 44px
    // target by hit-testing, whatever it is drawn at; a neighbour's area
    // laid over it shortens what is measured, so an overlap fails here too.
    if (r.small.length !== 6) fail(`the small-button probe found ${r.small.length} buttons, expected 6 — this check is out of date`)
    for (const b of r.small) {
      if (b.w < 1 || b.h < 1) { fail(`"${b.name}" is not drawn`); continue }
      if (touch && (b.hit.w < 44 || b.hit.h < 44)) fail(`"${b.name}": its target is ${b.hit.w}x${b.hit.h}px by hit-testing (drawn ${b.w.toFixed(0)}x${b.h.toFixed(0)}), under the 44px a touch target needs`)
    }
    const shownStr = r.cards.filter(c => c.w.endsWith('full')).map(c => `${parseInt(c.w)}:${c.shown}/${c.of}`).join(' ')
    const actsStr = r.cards.filter(c => c.w.endsWith('full')).map(c => `${parseInt(c.w)}:${c.acts.length}`).join(' ')
    console.log(`── ${String(width).padStart(4)}px  ${problems === before ? 'ok' : 'FAIL'}   ${r.bodyFamily} / ${r.titleFamily} · page ${r.sw}px · ${r.rails.length} rail headers · facts shown ${shownStr} · actions ${actsStr}`)
    await ctx.close()
  }
}
await browser.close()
console.log(`\n${problems} mobile layout problem(s).`)
process.exit(problems ? 1 : 0)
