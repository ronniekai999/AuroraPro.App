// Tonight's hero below 1024px, measured.
//
// audit-onart-contrast.mjs models the hero at 1440x900: it reads the wide
// scrim's stops and composites them at each string's worst point. Below
// 1024px the hero is a different layout (the picture is a 260px band across
// the top, the text starts inside its lower part and runs on below it) with
// a scrim of its own, which that audit only pins as "not painted at the
// width I model". Nothing measured it. A review estimated about 7:1 for the
// secondary text over a white picture, by eye.
//
// So this lays the hero out in a real engine with the real built stylesheet,
// at phone and tablet widths, with the tallest content the page makes (a
// title on both lines of its clamp, a two-line reason, the progress row,
// the actions, the picks) and, for a profile with a content limit, the
// calmer hero. The picture is the worst there is for light text: pure
// white. Then, the way verify-title-contrast.mjs does it for the title page:
//
// 1. The text is made invisible, the page is photographed, and the LIGHTEST
//    pixel behind each piece of text is compared with that text's colour.
//    4.5:1, or 3:1 for the titles (large text).
// 2. The picture is still a picture: over a mid-grey frame, the top fifth of
//    the band keeps at least 90% of the frame's brightness. The scrim is
//    written to be gone by 85% of the band's height, so that fifth is all
//    but untouched (it measures 98%); a veil of the page colour over the
//    whole band at even a twentieth strength keeps under 90%, and a scrim
//    that passed (1) by darkening the band all the way up keeps almost
//    nothing.
//
// Every class list is READ FROM THE SOURCE, each found exactly once (or, for
// a list written at several call sites, the same at each), so a call site
// that drifts from this model fails as out of date rather than passing
// against a stale copy. The NESTING is not read: which element holds which
// is copied here by hand from HeroSection.tsx. An element given another
// parent there (moved out of the picture band, say) keeps its class list, so
// this check would go on measuring it where it used to be.
//
// MUTATION-TESTED by passing a changed stylesheet as the first argument
// (each run fails at all six widths):
//   - the phone scrim's gradient removed: (1) fails for the eyebrow and
//     both titles;
//   - its second stop weakened from 0.9 to 0.3: (1) fails for the eyebrow
//     and the child's title;
//   - the scrim made the page colour all the way up: (2) fails, 2% kept;
//   - its last stop left at 0.05 rather than 0: (2) fails, 89% kept.
//
//   npm run build && node scripts/verify-hero-phone.mjs

import { chromium } from 'playwright'
import fs from 'node:fs'
import zlib from 'node:zlib'

const cssPath = process.argv[2] ?? fs
  .readdirSync('../../v2/assets')
  .filter(f => /^index-.*\.css$/.test(f))
  .map(f => `../../v2/assets/${f}`)
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
if (!cssPath) throw new Error('verify: no built CSS found — run `npm run build` first')
const css = fs.readFileSync(cssPath, 'utf8')
// Same fallback-only pin as verify-page-alignment.mjs; see its header.
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = fs.existsSync(PINNED) ? PINNED : undefined

const HERO = 'src/components/HeroSection.tsx'
const src = fs.readFileSync(HERO, 'utf8')
/** The string literals in the hero's source (either quote) that contain
 *  `marker`. The hero writes some class lists as one of two literals chosen
 *  by a condition, so `className="…"` alone would not find them. */
const literals = marker => [...src.matchAll(/(["'])((?:(?!\1)[^\\\n])*)\1/g)].map(m => m[2]).filter(v => v.includes(marker))
/** The one class list containing `marker`. `sites`: how many call sites
 *  write it; they must all write the same list. */
function classOf(marker, sites = 1) {
  const hits = literals(marker)
  if (hits.length !== sites || new Set(hits).size !== 1) {
    throw new Error(`verify: expected ${sites} class list(s) containing "${marker}" in ${HERO}, all the same; found ${hits.length} (${new Set(hits).size} different) — this check is out of date, not passing`)
  }
  return hits[0]
}
const C = {
  hero: classOf('flex-col justify-end overflow-hidden'),
  base: classOf('absolute inset-0 bg-surface-page'),
  art: classOf('stage-hero-img', 1) && 'stage-hero-img',
  row: classOf('stage-gutter relative z-20'),
  col: classOf('max-w-[620px]'),
  eyebrow: classOf('uppercase tracking-[0.08em] text-ink-2'),
  title: classOf('lg:text-[72px]'),
  titleLong: classOf('stage-hero-title-long'),
  // The line under the title: where the viewer is, or the cold-start hint
  // (one list), and the reason or the description (clamped to two lines).
  line: classOf('stage-hero-swap text-[15px] text-ink line-clamp-2 lg:text-[17px]', 2),
  progressRow: classOf('max-w-[420px]'),
  track: classOf('h-[3px] min-w-0 flex-1 rounded-full bg-white/[0.22]'),
  left: classOf('flex-none text-[13px] tabular-nums text-ink-2'),
  facts: classOf('stage-hero-swap text-[13px] tabular-nums text-ink-2'),
  actions: classOf('flex flex-wrap items-center gap-3 max-sm:gap-2'),
  primary: classOf('stage-btn stage-btn-lg stage-btn-primary'),
  secondary: classOf('inline-flex h-12 items-center rounded-full bg-white/[0.14] px-5'),
  add: classOf('grid h-12 w-12 flex-none place-items-center rounded-full bg-white/[0.14]'),
  picksHead: classOf('flex flex-wrap items-center gap-2.5'),
  picksLabel: classOf('text-[13px] font-semibold text-ink'),
  // Pause and Refresh share one list.
  control: classOf('grid h-11 w-11 flex-none place-items-center rounded-control bg-black/60', 2),
  // A child's hero.
  kidsCol: classOf('max-w-[680px]'),
  kidsTitle: classOf('lg:text-[80px]'),
  kidsLine: classOf('stage-hero-swap text-lg text-ink lg:text-xl'),
  kidsPrimary: classOf('stage-btn stage-btn-xl stage-btn-primary'),
  kidsSecondary: classOf('inline-flex h-16 items-center rounded-full bg-white/[0.16]'),
}
// Written whole in the source, not through a literal this can single out.
for (const whole of ['className="stage-hero-scrim"', 'className="stage-hero-scrim-phone"', 'className="stage-hero-picks"', 'className="stage-hero-strip"', 'className="stage-hero-strip-item"', 'className="stage-hero-thumb"', 'className="aurora-dot"']) {
  if (!src.includes(whole)) throw new Error(`verify: ${HERO} no longer contains ${whole} — this check is out of date, not passing`)
}

const LONG_TITLE = 'The Unlikely Voyage of the Good Ship Marguerite and Her Crew'
const REASON = 'Because you finished Harbor Lights and gave five stars to slow, patient mysteries with a small cast and a long memory'
const layers = art => `
  <div class="${C.base}"></div>
  <div class="${C.art}" id="art" style="background:${art}"></div>
  <div class="stage-hero-scrim"></div>
  <div class="stage-hero-scrim-phone"></div>`
const thumbs = ['Kestrel', 'Night Train to Meridian', 'The Archivists', 'Halcyon Days', 'Low Tide'].map(t => `
  <li class="stage-hero-strip-item"><button class="stage-hero-thumb"><span class="stage-hero-thumb-art opacity-80" style="background:#456"></span></button></li>`).join('')
// Two heroes, each with the tallest content the page makes for it.
const page = art => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>
<style>body{margin:0}*,*::before,*::after{transition:none!important;animation:none!important}</style></head><body class="aurora-bg">
<section class="${C.hero}" data-hero="standard">${layers(art)}
  <div class="${C.row}">
    <div class="${C.col}">
      <p class="${C.eyebrow}" data-probe="eyebrow"><span class="aurora-dot"></span>Picked by Aurora</p>
      <h2 class="${C.titleLong}" data-probe="title (long)" data-need="3">${LONG_TITLE}</h2>
      <p class="${C.line}" data-probe="line under the title">${REASON}</p>
      <div class="${C.progressRow}"><div class="${C.track}"></div><span class="${C.left}" data-probe="time left">1 h 29 min left</span></div>
      <p class="${C.facts}" data-probe="facts line">2024 · Science Fiction · 2h 16m</p>
      <div class="${C.actions}">
        <button class="${C.primary}">Resume</button>
        <button class="${C.secondary}"><span data-probe="second action's label">Episodes</span></button>
        <button class="${C.add}"></button>
      </div>
    </div>
    <div class="stage-hero-picks">
      <div class="${C.picksHead}">
        <span class="aurora-dot"></span>
        <h3 class="${C.picksLabel}" data-probe="picks' label">Tonight&rsquo;s picks from Aurora</h3>
        <span class="min-w-2 flex-1"></span>
        <button class="${C.control}"></button><button class="${C.control}"></button>
      </div>
      <ul class="stage-hero-strip">${thumbs}</ul>
    </div>
  </div>
</section>
<section class="${C.hero}" data-hero="short title" style="margin-top:40px">${layers(art)}
  <div class="${C.row}">
    <div class="${C.col}">
      <p class="${C.eyebrow}" data-probe="eyebrow, short stack">Pick up where you left off</p>
      <h2 class="${C.title}" data-probe="title, short stack" data-need="3">Kestrel</h2>
      <div class="${C.actions}"><button class="${C.primary}">Play</button></div>
    </div>
  </div>
</section>
<section class="${C.hero}" data-hero="child" style="margin-top:40px">${layers(art)}
  <div class="${C.row}">
    <div class="${C.kidsCol}">
      <h2 class="${C.kidsTitle}" data-probe="child's title" data-need="3">${LONG_TITLE}</h2>
      <p class="${C.kidsLine}" data-probe="child's line">Season 2, episode 4 · The Weight of Water · 29 min left</p>
      <div class="flex flex-wrap gap-3">
        <button class="${C.kidsPrimary}">Keep watching</button>
        <button class="${C.kidsSecondary}"><span data-probe="child's second action">All episodes</span></button>
      </div>
    </div>
  </div>
</section>
</body></html>`

// Minimal PNG reader: 8-bit RGB or RGBA, not interlaced, which is what a
// Chromium screenshot is. (The same reader as verify-title-contrast.mjs.)
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

// (2): the share of a mid-grey frame's luminance the top fifth of the
// picture must keep, on average (see the header for where 90% comes from).
const GREY = '#808080'
const KEEP = 0.9
// Every width below the 1024px switch, where the phone layout is the one
// drawn, from the narrowest phone the app supports to the last pixel before
// the wide layout.
const VIEWPORTS = [[320, 568], [360, 740], [390, 844], [430, 932], [767, 1024], [1023, 768]]
// A capture the browser refuses is not a finding. Chromium on a small CI
// runner now and then answers a screenshot of a page that is laid out and
// idle with "Unable to capture screenshot"; that failed this script once with
// every measurement before it passing. Ask again, twice, before giving up.
// Any other error, and a third refusal, still fail the run: nothing is
// measured from a picture that was not taken.
async function capture(pg) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pg.screenshot({ fullPage: true })
    } catch (err) {
      if (attempt >= 3 || !/Unable to capture screenshot/.test(String(err && err.message))) throw err
      console.log(`   (the browser refused a capture, attempt ${attempt} of 3; asking again)`)
      await new Promise(done => setTimeout(done, 300 * attempt))
    }
  }
}
const browser = await chromium.launch({ executablePath: EXE })
let problems = 0
for (const [width, height] of VIEWPORTS) {
  const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await tab.setContent(page('#fff'))
  const wide = await tab.evaluate(() => getComputedStyle(document.querySelector('.stage-hero-scrim-phone')).display === 'none')
  if (wide) throw new Error(`verify: at ${width}px the phone's scrim is not drawn, so this is not the phone layout — the check is out of date, not passing`)
  const probes = await tab.evaluate(() => [...document.querySelectorAll('[data-probe]')].map(el => {
    const r = el.getBoundingClientRect()
    return { name: el.getAttribute('data-probe'), need: Number(el.getAttribute('data-need') ?? 4.5), color: getComputedStyle(el).color,
      x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }
  }))
  // What is BEHIND the text: the same page with the text made invisible.
  await tab.addStyleTag({ content: '[data-probe], [data-probe] * { color: transparent !important; } .aurora-dot { visibility: hidden !important; }' })
  const shot = decodePng(await capture(tab))
  console.log(`\n── ${width}x${height}`)
  for (const pr of probes) {
    if (pr.w < 1 || pr.h < 1) { console.log(`   ${pr.name.padEnd(28)} *** not drawn`); problems++; continue }
    const m = pr.color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/)
    if (!m) throw new Error(`verify: could not read the colour of ${pr.name} (${pr.color})`)
    const text = lum(+m[1], +m[2], +m[3])
    let worst = -1
    const x0 = Math.max(0, Math.floor(pr.x)), x1 = Math.min(shot.width, Math.ceil(pr.x + pr.w))
    const y0 = Math.max(0, Math.floor(pr.y)), y1 = Math.min(shot.height, Math.ceil(pr.y + pr.h))
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * shot.width + x) * shot.bpp
      const l = lum(shot.data[i], shot.data[i + 1], shot.data[i + 2])
      if (l > worst) worst = l
    }
    const c = ratio(text, worst)
    const ok = c >= pr.need
    if (!ok) problems++
    console.log(`   ${pr.name.padEnd(28)} ${c.toFixed(2).padStart(6)}:1  (need ${pr.need})  ${ok ? 'PASS' : '*** FAIL'}`)
  }
  await tab.close()

  // ── (2) the picture over mid-grey ──────────────────────────────────────
  const grey = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await grey.setContent(page(GREY))
  const bands = await grey.evaluate(() => [...document.querySelectorAll('#art')].map(a => {
    const r = a.getBoundingClientRect()
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }
  }))
  const g = decodePng(await capture(grey))
  const bare = lum(0x80, 0x80, 0x80)
  for (const [n, b] of bands.entries()) {
    let sum = 0, count = 0
    for (let y = Math.floor(b.y); y < Math.floor(b.y + b.h / 5); y++) for (let x = Math.floor(b.x); x < Math.floor(b.x + b.w); x++) {
      const i = (y * g.width + x) * g.bpp
      sum += lum(g.data[i], g.data[i + 1], g.data[i + 2]); count++
    }
    const kept = count ? sum / count / bare : 0
    const ok = kept >= KEEP
    if (!ok) problems++
    console.log(`   picture ${n + 1}: top fifth keeps ${(kept * 100).toFixed(0)}% of the frame (floor ${KEEP * 100}%)  ${ok ? 'PASS' : '*** FAIL'}`)
  }
  await grey.close()
}
await browser.close()
console.log(`\n${problems} phone hero problem(s).`)
process.exit(problems ? 1 : 0)
