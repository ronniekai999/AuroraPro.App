// The title page's hero, measured two ways that pull against each other.
//
// 1. The text can be read over the worst artwork there is: a pure white
//    frame. The hero's text (the title, the line of facts, the tagline, the
//    action row's unfilled buttons, Back) is laid over the title's own
//    artwork, which can be anything, and whether its backing is under it
//    depends on LAYOUT: from lg the content sits at the foot of a hero whose
//    height grows with it, and a show in progress has eight actions that
//    wrap. A scrim sized from the art alone passed every case anyone had
//    looked at and gave 2.38:1 for the title of a show in progress with a
//    two-line name at 1280x720.
//
// 2. The picture is still a picture. The first fix for (1) backed the text
//    with a dark band the full width of the hero, and passed (1) by turning
//    the hero into a dark box: on a phone no part of the art was lighter
//    than about 0.6 of the page colour. The art is the colour on this page.
//    So the picture is measured over a mid-grey frame where the text's
//    backing has no business being at strength, with the tallest content
//    the page makes:
//      below lg   the upper half of the art band        keeps 100%, floor 85%
//      from lg    the right-hand tenth of the window, and everything to the
//                 right of the text column:
//                   width   right-hand tenth    right of the text
//                   1024    65%, floor 58%      36%, floor 30%
//                   1200    98%, floor 90%      55%, floor 48%
//                   1280    100%, floor 90%     59%, floor 52%
//                   1440    100%, floor 90%     67%, floor 60%
//    A band the full width of the hero keeps 18%, 20%, 20% and 28% in both
//    regions, so every floor is at least twelve points above it. The ellipse
//    is gone 200px past its full-strength zone at every width; an earlier
//    one whose falloff was a share of the column ran off the window, kept
//    37% and 46% beside the text, and its floors had to be set three points
//    above the band to pass.
//
// 3. The backing has no hard edge: along three lines across its boundary the
//    luminance moves by no more than a small step from one pixel to the
//    next (see MAX_STEP for what that does and does not show), and the line
//    running right from the text has left the backing before the window
//    ends (from 1200).
//
// 4. The ellipse still covers the block. Its full-strength zone holds the
//    block's corners only while the block is no taller than about 0.87 of
//    its width; (1) proves that for the content this model lays out, and
//    this keeps a margin for content it does not: from lg the block's
//    height may be at most MAX_BLOCK_RATIO of its width.
//
// None of this is arithmetic on gradients. The hero is laid out in a real engine
// with the real built stylesheet, at the widths that matter, with the
// tallest content the page can produce; for (1) the text is hidden and the
// pixels behind each piece of it are read, and the LIGHTEST is compared with
// that text's colour.
//
// Every class list is READ FROM THE SOURCE (classesOf / constOf), each one
// required to be found exactly once, so a call site drifting away from the
// stylesheet, or from this model of it, fails here as out of date instead of
// passing against a stale copy.
//
// MUTATION-TESTED, by passing a changed stylesheet as the first argument:
// with both backings removed, (1) fails for the title at every width; with
// the band used at every width in place of the ellipse, (2) fails at 1024,
// 1200, 1280 and 1440 in both regions; with the phone's `--detail-foot-ramp`
// raised to the whole fade, (2) fails at 390; with the mask cut off at half
// strength, (3) fails on the step; with the falloff tripled to 600px (it
// runs off the window, as the ellipse before this one did), (2) fails at
// every desktop width and (3) fails on its last 24px; with the text column
// capped at 300px (a block taller than it is wide), (4) fails at every
// desktop width.

import { chromium } from 'playwright'
import fs from 'node:fs'
import zlib from 'node:zlib'

const cssPath = process.argv[2] ?? fs
  .readdirSync('../../v2/assets')
  .filter(f => /^index-.*\.css$/.test(f))
  .map(f => `../../v2/assets/${f}`)[0]
if (!cssPath) throw new Error('verify: no built CSS found — run `npm run build` first')
const css = fs.readFileSync(cssPath, 'utf8')
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = fs.existsSync(PINNED) ? PINNED : undefined

function classesOf(file, marker) {
  const src = fs.readFileSync(file, 'utf8')
  const hits = [...src.matchAll(/className="([^"]*)"/g)].map(m => m[1]).filter(v => v.includes(marker))
  if (hits.length !== 1) {
    throw new Error(`verify: expected exactly one className containing "${marker}" in ${file}, found ${hits.length}` +
      ' — this check is out of date, not passing')
  }
  return hits[0]
}
// A className that IS exactly this list (for one too plain to pick out by a
// marker), found exactly once.
function classIs(file, exact) {
  const hits = [...fs.readFileSync(file, 'utf8').matchAll(/className="([^"]*)"/g)].filter(m => m[1] === exact)
  if (hits.length !== 1) {
    throw new Error(`verify: expected exactly one className="${exact}" in ${file}, found ${hits.length} — this check is out of date, not passing`)
  }
  return exact
}
// A class list kept in a named constant (`const NAME =\n  '…'`).
function constOf(file, name) {
  const m = fs.readFileSync(file, 'utf8').match(new RegExp(`const ${name} =\\s*'([^']*)'`))
  if (!m) throw new Error(`verify: could not read the constant ${name} from ${file} — this check is out of date, not passing`)
  return m[1]
}

const HERO = 'src/components/detail/DetailHero.tsx'
const ACTIONS = 'src/components/detail/DetailActions.tsx'
const C = {
  hero: classesOf(HERO, 'stage-detail-hero relative'),
  art: classesOf(HERO, 'stage-detail-art'),
  scrim: classesOf(HERO, 'stage-detail-scrim'),
  backRow: classesOf(HERO, 'stage-gutter pt-3'),
  back: classesOf(HERO, 'stage-detail-back'),
  foot: classesOf(HERO, 'stage-detail-foot'),
  row: classesOf(HERO, 'stage-detail-herorow'),
  block: classesOf(HERO, 'stage-detail-block'),
  poster: classesOf(HERO, 'stage-detail-poster'),
  text: classesOf(HERO, 'stage-detail-text'),
  title: classesOf(HERO, 'stage-detail-title'),
  facts: classesOf(HERO, 'flex flex-wrap items-center gap-x-3'),
  tagline: classesOf(HERO, 'italic'),
  actionsCol: classesOf(ACTIONS, 'flex flex-col gap-3.5'),
  actionsRow: classesOf(ACTIONS, 'flex flex-wrap items-center gap-x-2'),
  primary: classesOf(ACTIONS, 'stage-btn-primary'),
  quiet: constOf(ACTIONS, 'QUIET'),
  // The star rating: its wrapper, its group, one star, and the verdict in
  // words beside it (which takes room from lg).
  rating: classesOf(ACTIONS, 'flex items-center gap-2 sm:ml-2'),
  ratingGroup: classIs(ACTIONS, 'flex items-center'),
  star: classesOf(ACTIONS, 'w-11 h-11 grid place-items-center'),
  verdict: classesOf(ACTIONS, 'min-w-[7.5em]'),
  // The resume bar under the actions.
  progressRow: classesOf(ACTIONS, 'max-w-[460px]'),
  progressTrack: classesOf(ACTIONS, 'bg-[var(--track)]'),
  progressLeft: classesOf(ACTIONS, 'tabular-nums flex-none'),
}
// The ghost pills (Play from start, Previously on) share one class list at
// two call sites.
const ghost = [...fs.readFileSync(ACTIONS, 'utf8').matchAll(/className="([^"]*stage-btn-ghost[^"]*)"/g)].map(m => m[1])
if (ghost.length !== 2 || new Set(ghost).size !== 1) {
  throw new Error('verify: expected the two ghost buttons in DetailActions to share one class list — this check is out of date, not passing')
}

// The tallest hero the page produces: a show in progress (eight actions and
// the resume bar) whose name takes both lines of the clamp, with every fact
// and a long tagline. `art` is the frame behind it all.
const page = art => `<!doctype html><html><head><style>${css}</style>
<style>body{margin:0}</style></head><body class="aurora-bg">
<div class="stage-detail relative">
<section class="${C.hero}">
  <div class="${C.art}" id="art">
    <div style="width:100%;height:100%;background:${art}"></div>
    <div class="${C.scrim}"></div>
  </div>
  <!-- Back's text is probed, not its box: the box is a pill, and the corners
       of a pill's bounding box are the picture, not the pill. -->
  <div class="${C.backRow}"><button class="${C.back}" id="back"><span data-probe="Back">Back</span></button></div>
  <div class="${C.foot}"><div class="${C.row}"><div class="${C.block}" id="block">
    <div class="${C.poster}"></div>
    <div class="${C.text}" id="text">
      <h1 class="${C.title}" data-probe="title">The Unlikely Voyage of the Good Ship Marguerite and Her Crew</h1>
      <p class="${C.facts}">
        <span data-probe="facts">2022 · TV-MA · 3 seasons · Drama · 8.6</span>
        <span class="${C.tagline}" data-probe="tagline">&ldquo;Some lights are worth keeping, and some are worth following all the way home.&rdquo;</span>
      </p>
      <div class="${C.actionsCol}">
        <div class="${C.actionsRow}">
          <button class="${C.primary}">Resume S2E4 · 23:00</button>
          <button class="${ghost[0]}">Play from start</button>
          <button class="${ghost[0]}">Previously on</button>
          <button class="${C.quiet}" data-probe="quiet action (Trailer)">Trailer</button>
          <button class="${C.quiet}" data-probe="quiet action (My Library)">My Library</button>
          <button class="${C.quiet}" data-probe="quiet action (List)">List</button>
          <button class="${C.quiet}" data-probe="quiet action (Watch together)">Watch together</button>
          <div class="${C.rating}">
            <div class="${C.ratingGroup}">${`<button class="${C.star}"></button>`.repeat(5)}</div>
            <span class="${C.verdict}" data-probe="rating in words">Really liked it</span>
          </div>
        </div>
        <div class="${C.progressRow}">
          <div class="${C.progressTrack}"></div>
          <span class="${C.progressLeft}" data-probe="time left">29 min left</span>
        </div>
      </div>
    </div>
  </div></div></div>
</section>
</div></body></html>`

// Minimal PNG reader: 8-bit RGB or RGBA, not interlaced, which is what a
// Chromium screenshot is.
function decodePng(buf) {
  let p = 8, width = 0, height = 0, colorType = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]
      if (data[8] !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) throw new Error('verify: unexpected PNG format from the screenshot')
    } else if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  const bpp = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let pred = 0
      if (f === 1) pred = a
      else if (f === 2) pred = b
      else if (f === 3) pred = (a + b) >> 1
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      out[y * stride + x] = (v + pred) & 255
    }
  }
  return { width, height, bpp, data: out }
}
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)

const NEED = 4.5
// (2): the share of the bare frame's luminance a region must keep, on
// average, with the TALLEST content the page makes. A mid-grey frame under a
// tenth-strength veil of the page colour keeps about 0.82 of it, under a
// quarter-strength one about 0.6, and under the text's backing less than
// 0.05. Per width, because how much room there is beside the text is the
// width's doing; each floor is a few points under what the stylesheet keeps
// and at least ten above what a band the full width of the hero keeps in the
// same region (the header has both sets of figures).
const GREY = '#808080'
const FLOORS = {
  390: { above: 0.85 },
  1024: { edge: 0.58, beside: 0.30 },
  1200: { edge: 0.90, beside: 0.48 },
  1280: { edge: 0.90, beside: 0.52 },
  1440: { edge: 0.90, beside: 0.60 },
}
// (3): the largest luminance step allowed between neighbouring pixels along a
// line across the backing's boundary. One 8-bit grey level at mid-grey is a
// step of 0.0038, so this is three levels from one pixel to the next: the
// eased falloff moves one or two, and a hard edge (a mask that ends at some
// strength, a box clipped where it is not yet transparent) moves dozens.
// It says there is no hard edge. It does not say the curve is smooth: a
// straight ramp passes it too, and what makes a straight ramp's start
// visible is a change of slope too small, per pixel, to measure in 8 bits.
// That part is the stylesheet's (an eased curve of twelve stops) and the
// eye's (the renders).
const MAX_STEP = 0.012
// and how much the rightward line may still change over its last 24px: one
// grey level. More means the backing is still easing away at the window's
// edge, that is, it runs off the window.
const MAX_TAIL = 0.004
// (4): the corners of the block leave the ellipse's full-strength zone when
// the block's height passes about 0.87 of its width (the stylesheet's
// comment has the geometry). 0.8 leaves room for what this model does not
// lay out.
const MAX_BLOCK_RATIO = 0.8
const VIEWPORTS = [[390, 844], [1024, 768], [1200, 800], [1280, 720], [1440, 900]]
const browser = await chromium.launch({ executablePath: EXE })
let problems = 0
for (const [width, height] of VIEWPORTS) {
  // ── (1) the text over white ────────────────────────────────────────────
  const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await tab.setContent(page('#fff'))
  const probes = await tab.evaluate(() => [...document.querySelectorAll('[data-probe]')].map(el => {
    const r = el.getBoundingClientRect()
    return { name: el.getAttribute('data-probe'), color: getComputedStyle(el).color, x: r.left, y: r.top, w: r.width, h: r.height }
  }))
  const box = await tab.evaluate(() => {
    const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
    const hero = document.querySelector('section').getBoundingClientRect()
    const back = document.getElementById('back').getBoundingClientRect()
    return { hero: { top: hero.top, bottom: hero.bottom, height: hero.height }, art: rect('art'), text: rect('text'), block: rect('block'), backBottom: back.bottom }
  })
  // What is BEHIND the text: the same page with the text made invisible.
  await tab.addStyleTag({ content: '[data-probe], [data-probe] * { color: transparent !important; }' })
  const shot = decodePng(await tab.screenshot({ fullPage: true }))
  console.log(`\n── ${width}x${height}  (hero ${Math.round(box.hero.height)}px tall)`)
  for (const pr of probes) {
    if (pr.w < 1 || pr.h < 1) { console.log(`   ${pr.name.padEnd(34)} not shown at this width`); continue }
    const m = pr.color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/)
    if (!m) throw new Error(`verify: could not read the colour of ${pr.name} (${pr.color})`)
    const text = lum(+m[1], +m[2], +m[3])
    let worst = -1
    const x0 = Math.max(0, Math.floor(pr.x)), x1 = Math.min(shot.width, Math.ceil(pr.x + pr.w))
    const y0 = Math.max(0, Math.floor(pr.y)), y1 = Math.min(shot.height, Math.ceil(pr.y + pr.h))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * shot.width + x) * shot.bpp
        const l = lum(shot.data[i], shot.data[i + 1], shot.data[i + 2])
        if (l > worst) worst = l
      }
    }
    const c = ratio(text, worst)
    const ok = c >= NEED
    if (!ok) problems++
    console.log(`   ${pr.name.padEnd(34)} ${c.toFixed(2).padStart(6)}:1  (need ${NEED})  ${ok ? 'PASS' : '*** FAIL'}`)
  }
  await tab.close()

  // ── (2) the picture over mid-grey ──────────────────────────────────────
  const grey = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await grey.setContent(page(GREY))
  const g = decodePng(await grey.screenshot({ fullPage: true }))
  await grey.close()
  // Where the picture is supposed to be left alone.
  //   Below lg: the upper half of the art band, under Back.
  //   From lg, where the backing is an ellipse round the block: everything
  //   to the right of the text column, and the right-hand tenth of the
  //   window, each from under Back down to where the art's own bottom fade
  //   begins.
  const mean = (r) => {
    let sum = 0, n = 0
    for (let y = Math.ceil(r.y0); y < Math.floor(r.y1); y++) {
      for (let x = Math.ceil(r.x0); x < Math.floor(r.x1); x++) {
        const i = (y * g.width + x) * g.bpp
        sum += lum(g.data[i], g.data[i + 1], g.data[i + 2]); n++
      }
    }
    return n ? (sum / n) / lum(0x80, 0x80, 0x80) : NaN
  }
  const elliptical = width >= 1024
  const floors = FLOORS[width]
  const yTop = box.backBottom + 8, yBottom = box.hero.bottom - 256
  const checks = elliptical
    ? [
        ['picture at the right-hand edge', { x0: width * 0.9, x1: width, y0: yTop, y1: yBottom }, floors.edge],
        ['picture beside the text', { x0: box.text.right, x1: width, y0: yTop, y1: yBottom }, floors.beside],
      ]
    : [['picture above the title', { x0: 0, x1: width, y0: yTop, y1: box.art.top + (box.art.bottom - box.art.top) / 2 }, floors.above]]
  for (const [name, r, floor] of checks) {
    const share = mean(r)
    const ok = share >= floor
    if (!ok) problems++
    console.log(`   ${name.padEnd(34)} keeps ${(share * 100).toFixed(0)}% of the frame's luminance over ${Math.floor(r.x1) - Math.ceil(r.x0)}x${Math.floor(r.y1) - Math.ceil(r.y0)}px  (need ${Math.round(floor * 100)}%)  ${ok ? 'PASS' : '*** FAIL'}`)
  }

  // ── (3) no edge ────────────────────────────────────────────────────────
  // Along three lines that cross the backing's boundary over the grey frame
  // (rightwards from the text column at its mid-height, upwards from the
  // title, and up-and-right from the block's corner), the luminance of
  // neighbouring pixels may not differ by more than a small step. The
  // rightward line must also get OUT of the backing before the window ends:
  // its last 24px have to be level (the art's own bottom fade is still over
  // them, but that does not change from left to right). At 1024 the ellipse
  // runs a little past the window, and the line is only held to the step.
  if (elliptical) {
    const at = (x, y) => { const i = (Math.round(y) * g.width + Math.round(x)) * g.bpp; return lum(g.data[i], g.data[i + 1], g.data[i + 2]) }
    const midY = (box.block.top + box.block.bottom) / 2
    const lines = [
      ['rightwards beside the text', box.text.right + 4, midY, 1, 0, width - box.text.right - 6, width >= 1200],
      ['upwards above the title', box.text.left + 12, box.text.top - 4, 0, -1, box.text.top - box.backBottom - 12, false],
      ['up and right from the corner', box.text.right + 4, box.text.top - 4, 1, -1, Math.min(width - box.text.right - 6, box.text.top - box.hero.top - 6), false],
    ]
    // ── (4) the block's proportions ──────────────────────────────────────
    const blockW = box.block.right - box.block.left, blockH = box.block.bottom - box.block.top
    const tall = blockH / blockW
    const fits = tall <= MAX_BLOCK_RATIO
    if (!fits) problems++
    console.log(`   ${'block the ellipse must cover'.padEnd(38)} ${Math.round(blockW)}x${Math.round(blockH)}px, height ${tall.toFixed(2)} of width  (at most ${MAX_BLOCK_RATIO})  ${fits ? 'PASS' : '*** FAIL'}`)
    for (const [name, x0, y0, dx, dy, len, mustLeave] of lines) {
      let step = 0
      for (let k = 1; k < len; k++) step = Math.max(step, Math.abs(at(x0 + dx * k, y0 + dy * k) - at(x0 + dx * (k - 1), y0 + dy * (k - 1))))
      const tail = Math.abs(at(x0 + dx * (len - 1), y0 + dy * (len - 1)) - at(x0 + dx * (len - 25), y0 + dy * (len - 25)))
      const left = !mustLeave || tail <= MAX_TAIL
      const ok = step <= MAX_STEP && left
      if (!ok) problems++
      console.log(`   ${('no edge ' + name).padEnd(38)} largest step ${(step * 1000).toFixed(1)} over ${Math.floor(len)}px  (at most ${MAX_STEP * 1000})${mustLeave ? `, last 24px change by ${(tail * 1000).toFixed(1)} (at most ${MAX_TAIL * 1000})` : ''}  ${ok ? 'PASS' : '*** FAIL'}`)
    }
  }
}
await browser.close()
console.log(`\n${problems} title-page contrast problem(s).`)
process.exit(problems ? 1 : 0)
