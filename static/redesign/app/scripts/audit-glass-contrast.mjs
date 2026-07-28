// Phase 11.2 — contrast for text on GLASS, as opposed to text on ARTWORK.
//
// WHY A SECOND SCRIPT. `audit-onart-contrast.mjs` reads exactly two files —
// src/index.css and src/components/HeroSection.tsx — and its whole model is the
// hero scrim's geometry: every surface carries an (x, y) sample point and the
// backdrop is computed from two linear-gradient layers. That model is correct for
// the hero and meaningless anywhere else, so extending it would have meant bolting
// a second, unrelated model into it.
//
// WHAT IT EXISTS FOR. The vibe search bar's placeholder sat at 3.18-3.53:1 — under
// the 4.5 floor — for THREE PHASES, and the on-art audit was structurally
// incapable of seeing it: the bar is not in HeroSection. A human reviewer found it
// by hand in Phase 10. Every other panel-and-glass surface in the app is still in
// that position, and this closes the class rather than the instance.
//
// THE MODEL. Text on glass has a knowable backdrop, unlike text on artwork: an
// opaque page ink, then one or more translucent panel fills, then the text's own
// alpha. No sample points, no gradients to integrate.
//
// EVERY NUMBER IS DERIVED FROM SOURCE. Not one threshold or colour below is a
// literal repeated from the CSS. The on-art audit's own header records why: its
// first version was all literals, "structurally incapable of failing", and the
// mutation that proved it changed the CSS while the script kept reporting the old
// value. So each surface names a CSS selector + property and a JSX anchor, and the
// run DIES if either has moved rather than passing on a stale number.

import fs from 'node:fs'

const CSS = 'src/index.css'
const css = fs.readFileSync(CSS, 'utf8')
const fileCache = new Map()
/** Source with every `//` and block comment blanked, line lengths preserved.
 *
 *  Load-bearing, not tidy. The tag scanner tracks quote state, and these files are
 *  ~60% prose containing apostrophes — "you're", "TopNav's", "HeroSection's" — each
 *  of which flipped it. Measured on the real file: the "tag" extracted for the
 *  placeholder anchor spanned 3341 characters across THREE elements, so the
 *  scoping the previous comment claimed ("widening to the whole file would be
 *  worse — it would silently match a DIFFERENT element's alpha") was already
 *  doing exactly that. */
const read = f => {
  if (!fileCache.has(f)) {
    const raw = fs.readFileSync(f, 'utf8')
    const out = raw.split('')
    let i = 0, line = false, block = false
    while (i < raw.length) {
      if (line) { if (raw[i] === '\n') line = false; else out[i] = ' '; i++; continue }
      if (block) {
        if (raw[i] === '*' && raw[i + 1] === '/') { out[i] = out[i + 1] = ' '; block = false; i += 2; continue }
        if (raw[i] !== '\n') out[i] = ' '
        i++; continue
      }
      if (raw[i] === '/' && raw[i + 1] === '/') { out[i] = out[i + 1] = ' '; line = true; i += 2; continue }
      if (raw[i] === '/' && raw[i + 1] === '*') { out[i] = out[i + 1] = ' '; block = true; i += 2; continue }
      i++
    }
    fileCache.set(f, out.join(''))
  }
  return fileCache.get(f)
}

const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const Y = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const over = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i])
const ratio = (a, b) => {
  const [l1, l2] = [Y(a), Y(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
/** #rgb, #rrggbb and #rrggbbaa. The first version indexed [1,3,5] blindly, so
 *  `#fff` became [1, 0.0588, NaN] — and NaN poisons the ratio silently, since
 *  `NaN >= 4.5` is false, so it reported a FAIL with a NaN figure rather than
 *  dying. `firstColorOf` explicitly admitted 3- and 8-digit forms. */
function hex(h) {
  const s = h.replace('#', '')
  if (s.length === 3) return [...s].map(c => parseInt(c + c, 16) / 255)
  if (s.length === 6 || s.length === 8) return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255)
  throw new Error(`audit: cannot parse hex colour #${s}`)
}
const hexAlpha = h => {
  const s = h.replace('#', '')
  return s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1
}
const W = [1, 1, 1]

/** rgba()/rgb()/#hex -> { rgb: [0..1 x3], a }. */
function parseColor(str) {
  const s = str.trim()
  if (s.startsWith('#')) return { rgb: hex(s), a: hexAlpha(s) }
  const n = s.match(/[\d.]+/g)?.map(Number)
  if (!n || n.length < 3) throw new Error(`audit: cannot parse colour ${str}`)
  return { rgb: n.slice(0, 3).map(v => v / 255), a: n[3] ?? 1 }
}

/** A declaration's value from a named CSS rule, or die loudly. */
function cssValue(selector, prop) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(String.raw`(?:^|\n)\s*${esc}\s*\{([\s\S]*?)\n\s*\}`))
  if (!rule) throw new Error(`audit: rule ${selector} not found in ${CSS} — the audit is out of date, not passing`)
  const m = rule[1].match(new RegExp(String.raw`(?:^|;|\{)\s*${prop}\s*:\s*([\s\S]*?);`))
  if (!m) throw new Error(`audit: ${selector} no longer sets ${prop} — the audit is out of date, not passing`)
  return m[1].replace(/\s+/g, ' ').trim()
}

/** EVERY background layer's representative colour, bottom-layer LAST.
 *
 *  The first version took only the first layer and composited it straight onto the
 *  ink. A review measured the cost: `.convo-search` is two layers — a
 *  `padding-box` fill at 0.66 alpha OVER a `border-box` gradient — and the
 *  border-box layer paints beneath the padding box, showing through at 34%.
 *  Dropping it made the modelled backdrop 4-9x darker than the real one and
 *  overstated every figure the script reported (placeholder 9.69 vs a true
 *  7.28-8.69). Worse, it opened a false-PASS window: at `placeholder:text-white/45`
 *  the script said exactly 4.50 PASS while the real bar measures 3.93 at its cyan
 *  end. That is the precise defect class this script exists to catch, so the model
 *  missing a layer is not a rounding issue — it is the script failing at its one job.
 *
 *  In CSS, earlier layers paint ON TOP of later ones, so the returned array is
 *  ordered top-first and `stack()` reduces it in reverse.
 *
 *  A gradient contributes its WORST stop rather than its first: a backdrop that
 *  varies across the element has to be judged at the point where contrast is
 *  lowest, and picking the first stop is only right by accident. */
function backgroundLayers(value) {
  // Split on top-level commas — the ones between layers, not inside rgba()/gradients.
  const layers = []
  let depth = 0, start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) { layers.push(value.slice(start, i)); start = i + 1 }
  }
  layers.push(value.slice(start))
  const out = []
  for (const layer of layers) {
    const cols = [...layer.matchAll(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/g)].map(m => parseColor(m[0]))
    if (!cols.length) continue
    out.push(cols)
  }
  if (!out.length) throw new Error(`audit: no colour found in "${value}"`)
  return out
}

/** A Tailwind `cls/NN` alpha read from the JSX TAG containing `anchor`, in `file`.
 *  The point is that changing `/70` to `/40` in the JSX MOVES the number this
 *  script reports.
 *
 *  Tag-scoped, not line-scoped. The on-art audit's version reads a single line,
 *  which works there because every hero anchor happens to share a line with its
 *  className. It does not generalise: `aria-label="Clear search"` and the
 *  `text-white/55` that styles it are four lines apart, and a line-scoped lookup
 *  reported all three of these surfaces as unresolvable. Widening to the whole
 *  file would be worse — it would silently match a DIFFERENT element's alpha. */
function twAlpha(file, anchor, cls) {
  const src = read(file)
  const i = src.indexOf(anchor)
  if (i < 0) throw new Error(`audit: anchor not found in ${file}: ${anchor}`)
  // An anchor that appears twice silently measures whichever comes first. Since
  // `indexOf` is file-wide, that is how a `/15` placeholder could be reported as
  // the `/70` on an unrelated element 600 lines earlier.
  if (src.indexOf(anchor, i + 1) >= 0) {
    throw new Error(`audit: anchor "${anchor}" is not unique in ${file} — it cannot identify one element`)
  }
  // Walk back to this element's `<`, forward to the tag's closing `>`, ignoring
  // the `>` inside arrow functions in attribute values (`onClick={() => …}`).
  const start = src.lastIndexOf('<', i)
  if (start < 0) throw new Error(`audit: anchor "${anchor}" is not inside a JSX tag in ${file}`)
  let end = -1, depth = 0, quote = null
  for (let k = start; k < src.length; k++) {
    const c = src[k]
    if (quote) { if (c === '\\') { k++; continue } if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) { end = k; break }
  }
  if (end < 0) throw new Error(`audit: could not find the end of the tag holding "${anchor}" in ${file}`)
  const tag = src.slice(start, end + 1)
  // `(?:^|[\s"'\`])` guards the START of the class. Without it, `text-white/NN`
  // also matched `hover:text-white/95` — so writing the variant before the base
  // class reported the HOVER alpha as the resting one. Measured: a Clear button at
  // `hover:text-white/95 text-white/25` reported 17.73:1 when its resting state is
  // 2.19:1. It read correctly only because base classes happen to be written first.
  const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = tag.match(new RegExp(String.raw`(?:^|[\s"'\`{])${esc}\/(\d+)`))
  if (!m) throw new Error(`audit: ${cls}/N not found on the element anchored by "${anchor}" in ${file}`)
  return Number(m[1]) / 100
}

// The page ink, derived from the app root's own utility rather than from CSS:
// `.aurora-bg` sets only the radial tint layers, and the opaque base is
// `bg-[#050505]` on the root element in App.tsx. Reading the wrong one is how a
// backdrop model ends up off by the whole base colour, so this dies if the
// utility moves rather than defaulting.
const INK = (() => {
  const m = read('src/App.tsx').match(/min-h-screen bg-\[(#[0-9a-fA-F]{3,8})\]/)
  if (!m) throw new Error('audit: app root no longer carries min-h-screen bg-[#…] — the audit is out of date, not passing')
  return hex(m[1])
})()

// Panel fills, each named by the rule that owns it.
const CONVO = backgroundLayers(cssValue('.convo-search', 'background'))
const NAVSEARCH = backgroundLayers(cssValue('.stage-navsearch', 'background'))
const RAIL = backgroundLayers(cssValue('.rail-container', 'background'))

/** Composite layered fills onto the ink and return EVERY backdrop the element can
 *  present, so the caller can judge the worst one.
 *
 *  Each argument is one element's layer list (top-first, each layer a list of that
 *  layer's gradient stops). Layers are applied bottom-first; the cartesian product
 *  of stops is enumerated because a two-layer element with a three-stop gradient
 *  under a flat fill genuinely has three different backdrops across its width. */
function stack(...elements) {
  let backdrops = [INK]
  // Bottom element first, and within an element, bottom layer first.
  for (const layers of [...elements].reverse()) {
    for (const stops of [...layers].reverse()) {
      const next = []
      for (const bg of backdrops) for (const st of stops) next.push(over(st.rgb, st.a, bg))
      backdrops = next
    }
  }
  return backdrops
}

const APP = 'src/App.tsx'

const SURFACES = [
  // ── The vibe search bar. THE case this script exists for. ──
  {
    what: 'vibe bar placeholder', where: `${APP} (.convo-search input)`,
    color: W, alpha: () => twAlpha(APP, 'placeholder:text-white', 'placeholder:text-white'),
    px: 14, on: () => stack(CONVO),
  },
  {
    what: 'vibe bar "Clear"', where: `${APP} (.convo-search)`,
    color: W, alpha: () => twAlpha(APP, 'aria-label="Clear search"', 'text-white'),
    px: 12, on: () => stack(CONVO),
  },
  // ── The nav search pill. Same shape, different fill. ──
  {
    what: 'nav search input text', where: `${CSS} (.stage-navsearch input)`,
    // cssValue escapes the selector itself — passing it pre-escaped double-escapes
    // and the rule is never found, which this script correctly reported as a
    // failure rather than a skip.
    color: () => parseColor(cssValue('.stage-navsearch input:not([type="range"])', 'color')).rgb,
    alpha: () => parseColor(cssValue('.stage-navsearch input:not([type="range"])', 'color')).a,
    px: 12.5, on: () => stack(NAVSEARCH),
  },
  // ── The bar's submit chip: text on a tint on the bar on the ink. Three
  //    composites deep, which is exactly the case eyeballing gets wrong. ──
  {
    what: 'vibe bar "↵ Search" chip', where: `${APP} (.convo-search)`,
    color: () => hex('#f3e8ff'),                                   // purple-100
    alpha: () => twAlpha(APP, 'aria-label="Search"', 'text-purple-100'),
    px: 11,
    on: () => stack(CONVO).map(bg => over(hex('#a855f7'), twAlpha(APP, 'aria-label="Search"', 'bg-purple-500'), bg)),
  },
]

// `.rail-container` is read so the fill is validated even though no surface below
// currently sits on it — the rule existing is part of this model's premise, and a
// silent `undefined` here would make any future rail surface measure against the
// bare ink. Referenced explicitly so linters do not strip it.
void RAIL

const need = s => (s.px >= 24 || (s.px >= 18.66 && s.bold)) ? 3.0 : 4.5
const resolve = v => (typeof v === 'function' ? v() : v)

let fails = 0
console.log('surface                                  px   need    ratio   verdict')
console.log('-'.repeat(72))
for (const s of SURFACES) {
  let r
  try {
    // `on` returns EVERY backdrop this surface can sit on (gradient stops x layers).
    // Judge the worst, exactly as the on-art audit judges the worst artwork frame:
    // a surface that clears 4.5 at one end of a gradient and fails at the other
    // fails, and reporting the first stop would have hidden that.
    const backdrops = resolve(s.on)
    const color = resolve(s.color)
    const alpha = resolve(s.alpha)
    r = Math.min(...backdrops.map(bg => ratio(over(color, alpha, bg), bg)))
  } catch (err) {
    // A missing rule/anchor is a FAILURE, not a skip. The on-art audit learned
    // this the hard way: a check that silently drops what it cannot resolve
    // reports a clean run over surfaces it never measured.
    console.log(`${s.what.padEnd(40)}  *** ${err.message}`)
    fails++
    continue
  }
  const req = need(s)
  const ok = r >= req
  if (!ok) fails++
  console.log(
    `${s.what.padEnd(40)}${String(s.px).padStart(5)} ${req.toFixed(1).padStart(6)} ${r.toFixed(2).padStart(8)}   ${ok ? 'PASS' : '*** FAIL ***'}`,
  )
  console.log(`  ${s.where}`)
}
console.log('-'.repeat(72))
console.log(`${fails} glass surface(s) below threshold.`)
process.exit(fails ? 1 : 0)
