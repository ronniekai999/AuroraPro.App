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
const read = f => {
  if (!fileCache.has(f)) fileCache.set(f, fs.readFileSync(f, 'utf8'))
  return fileCache.get(f)
}

const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const Y = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const over = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i])
const ratio = (a, b) => {
  const [l1, l2] = [Y(a), Y(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
const W = [1, 1, 1]

/** rgba()/rgb()/#hex -> { rgb: [0..1 x3], a }. */
function parseColor(str) {
  const s = str.trim()
  if (s.startsWith('#')) return { rgb: hex(s), a: 1 }
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

/** The FIRST solid colour in a value — a flat rgba(), or a linear-gradient's first
 *  stop. `.convo-search`'s fill is a two-layer gradient whose padding-box layer is
 *  a flat rgba() expressed as a gradient between two identical stops. */
function firstColorOf(value) {
  const m = value.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/)
  if (!m) throw new Error(`audit: no colour found in "${value}"`)
  return parseColor(m[0])
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
  const m = tag.match(new RegExp(String.raw`${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\/(\d+)`))
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
const CONVO = firstColorOf(cssValue('.convo-search', 'background'))
const NAVSEARCH = firstColorOf(cssValue('.stage-navsearch', 'background'))
const RAIL = firstColorOf(cssValue('.rail-container', 'background'))

/** Composite a stack of {rgb,a} fills onto the ink, bottom-first. */
const stack = (...fills) => fills.reduce((bg, f) => over(f.rgb, f.a, bg), INK)

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
    on: () => over(hex('#a855f7'), twAlpha(APP, 'aria-label="Search"', 'bg-purple-500'), stack(CONVO)),
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
  let bg, fg, r
  try {
    bg = resolve(s.on)
    fg = over(resolve(s.color), resolve(s.alpha), bg)
    r = ratio(fg, bg)
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
