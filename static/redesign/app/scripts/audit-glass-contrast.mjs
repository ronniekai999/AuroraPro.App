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

/** The JSX opening tag holding `anchor` in `file` — the same scoping twAlpha
 *  uses (walk back to this element's `<`, forward to its closing `>`, skipping
 *  quotes and braces), factored out for the two lookups below. */
function tagOf(file, anchor) {
  const src = read(file)
  const i = src.indexOf(anchor)
  if (i < 0) throw new Error(`audit: anchor not found in ${file}: ${anchor}`)
  if (src.indexOf(anchor, i + 1) >= 0) {
    throw new Error(`audit: anchor "${anchor}" is not unique in ${file} — it cannot identify one element`)
  }
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
  return src.slice(start, end + 1)
}

/** A CSS colour value that may be a `var(--token)` — resolved through :root —
 *  or a literal. The rail's See All moved to the secondary-text token. */
function cssColor(selector, prop) {
  const v = cssValue(selector, prop)
  const tok = v.match(/^var\((--[\w-]+)\)$/)
  return tok ? rootToken(tok[1]) : parseColor(v)
}

/** A rule's font-size in px: `Nrem`, `Npx`, or a `var(--token)` holding one.
 *  Dies on anything else rather than guessing the threshold. */
function cssPx(selector) {
  let v = cssValue(selector, 'font-size')
  const tok = v.match(/^var\((--[\w-]+)\)$/)
  if (tok) {
    const m = css.match(new RegExp(String.raw`\n\s*${tok[1].replace(/[-]/g, '\\-')}\s*:\s*([^;]+);`))
    if (!m) throw new Error(`audit: ${tok[1]} is not defined in ${CSS}`)
    v = m[1].trim()
  }
  const n = v.match(/^([\d.]+)(rem|px)$/)
  if (!n) throw new Error(`audit: ${selector} font-size ${v} is not a rem/px length this audit can judge`)
  return Number(n[1]) * (n[2] === 'rem' ? 16 : 1)
}

/** A `:root` custom property from index.css, as a colour. The text-secondary
 *  token is what the AA fixes in this codebase reach for, so a surface styled
 *  with `text-[color:var(--x)]` has to be measurable without restating the value. */
function rootToken(name) {
  const m = css.match(new RegExp(String.raw`\n\s*${name.replace(/[-]/g, '\\-')}\s*:\s*([^;]+);`))
  if (!m) throw new Error(`audit: ${name} is not defined in ${CSS} — the audit is out of date, not passing`)
  return parseColor(m[1])
}

/** The text colour an element's OWN tag sets: `text-white/NN`, or a token via
 *  `text-[color:var(--x)]`. Returns { rgb, a }. Dies when the tag sets neither,
 *  rather than guessing an inherited colour. */
function twText(file, anchor) {
  const tag = tagOf(file, anchor)
  const tok = tag.match(/(?:^|[\s"'`{])text-\[color:var\((--[\w-]+)\)\]/)
  if (tok) return rootToken(tok[1])
  const w = tag.match(/(?:^|[\s"'`{])text-white\/(\d+)/)
  if (w) return { rgb: W, a: Number(w[1]) / 100 }
  throw new Error(`audit: no text-white/N or text-[color:var(--…)] on the element anchored by "${anchor}" in ${file}`)
}

/** An arbitrary-colour fill on an element's own tag: `bg-[#rrggbb]/NN`. */
function twFill(file, anchor) {
  const m = tagOf(file, anchor).match(/(?:^|[\s"'`{])bg-\[(#[0-9a-fA-F]{3,8})\]\/(\d+)/)
  if (!m) throw new Error(`audit: no bg-[#…]/N on the element anchored by "${anchor}" in ${file}`)
  return { rgb: hex(m[1]), a: Number(m[2]) / 100 }
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
// The page itself (Stage refresh, RS). The home rails used to sit on a glass
// shelf (`.rail-container`'s fill, read here as RAIL and measured by nothing);
// the shelf is gone, so their header text sits on `.aurora-bg` — three radial
// tints over its own #050505 base. backgroundLayers keeps every tint at its
// full stop, i.e. the lightest point of each, which is the worst case for
// light text.
const PAGE = backgroundLayers(cssValue('.aurora-bg', 'background'))

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
const ONB = 'src/components/OnboardingFlow.tsx'
const RAIL_TSX = 'src/components/MediaRail.tsx'

// The onboarding overlay is `fixed inset-0` with its OWN opaque base, so its
// text does not sit on the app ink at all. Derived from the overlay's utility
// for the same reason INK is derived from the root's: measuring onboarding text
// against the wrong base is off by the whole colour. Dies if the utility moves.
const ONB_INK = (() => {
  const m = read(ONB).match(/fixed inset-0 z-\[80\][^"]*bg-\[(#[0-9a-fA-F]{3,8})\]/)
  if (!m) throw new Error('audit: onboarding overlay no longer carries its own bg-[#…] base — the audit is out of date, not passing')
  return hex(m[1])
})()

// The search palette (Stage refresh audit-gap fix). Its secondary text sat at
// 2.59:1 and 3.77:1 for as long as the palette existed and this script passed,
// because this script measures ONLY the surfaces listed in SURFACES below and
// the palette was never listed — the same structural blind spot this file's
// header describes for the on-art audit and the vibe bar. Modelled, bottom-up:
// the page's `.aurora-bg` (its tints show through both translucent layers),
// the full-viewport scrim, then the panel's own fill; the scrim and panel are
// read from the component. NOT modelled: the two decorative blobs between the
// scrim and the panel, and whatever view is on screen beneath the scrim (hero
// art, a backdrop, video). The panel passes about 10% of the blobs, and the
// scrim and panel together about 1.5% of the view beneath; at full strength
// that costs the near-threshold text about 0.06 (6.45 → ~6.39).
const PAL = 'src/components/SearchPalette.tsx'
const PAL_SCRIM = [[twFill(PAL, 'aurora-glass-overlay')]]
const PAL_PANEL = [[twFill(PAL, 'stage-palette relative')]]
const onPalette = () => stack(PAL_PANEL, PAL_SCRIM, PAGE)

const SURFACES = [
  // ── The referral step. A one-shot question with a Skip, so every control
  //    here has to be readable the FIRST time or the answer is noise. ──
  {
    what: 'referral step body copy', where: `${ONB} (referral step)`,
    color: W, alpha: () => twAlpha(ONB, 'It helps us know where to show up', 'text-white'),
    px: 15.2, on: () => [ONB_INK],
  },
  {
    // The plan's requirement in one assertion: Skip must not be a
    // low-contrast afterthought sitting next to a full-strength Continue.
    what: 'referral step "Skip this question"', where: `${ONB} (referral step)`,
    color: W, alpha: () => twAlpha(ONB, 'Skip this question', 'text-white'),
    px: 14, on: () => [ONB_INK],
  },
  {
    what: 'referral "Other" field label', where: `${ONB} (referral step)`,
    color: W, alpha: () => twAlpha(ONB, 'Where, specifically?', 'text-white'),
    px: 12.8, on: () => [ONB_INK],
  },
  {
    // On the field's own translucent fill, not bare ink — one composite deeper
    // than it looks, which is the case eyeballing gets wrong.
    what: 'referral "Other" field placeholder', where: `${ONB} (referral step)`,
    color: W, alpha: () => twAlpha(ONB, 'A podcast, a forum', 'placeholder:text-white'),
    px: 14,
    on: () => [over(W, twAlpha(ONB, 'A podcast, a forum', 'bg-white'), ONB_INK)],
  },
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
  // ── The search palette. ──
  {
    what: 'palette query placeholder', where: `${PAL} (combobox)`,
    color: W, alpha: () => twAlpha(PAL, 'placeholder="Search Aurora', 'placeholder-white'),
    px: 16, on: onPalette,
  },
  {
    what: 'palette "Esc" hint', where: `${PAL} (header kbd)`,
    color: () => twText(PAL, 'uppercase tracking-wider text-[color:').rgb,
    alpha: () => twText(PAL, 'uppercase tracking-wider text-[color:').a,
    px: 10, on: onPalette,
  },
  {
    what: 'palette empty-state line', where: `${PAL} (empty query)`,
    color: () => twText(PAL, 'Start typing to search').rgb,
    alpha: () => twText(PAL, 'Start typing to search').a,
    px: 16, on: onPalette,
  },
  {
    what: 'palette "Try a title…" hint', where: `${PAL} (empty query)`,
    color: () => twText(PAL, 'Try <span').rgb, alpha: () => twText(PAL, 'Try <span').a,
    px: 12, on: onPalette,
  },
  {
    what: 'palette key legend', where: `${PAL} (empty query)`,
    color: () => twText(PAL, 'justify-center gap-2 text-').rgb,
    alpha: () => twText(PAL, 'justify-center gap-2 text-').a,
    px: 11, on: onPalette,
  },
  {
    what: 'palette no-match line', where: `${PAL} (no results)`,
    color: () => twText(PAL, 'No matches for "{query}"').rgb, alpha: () => twText(PAL, 'No matches for "{query}"').a,
    px: 16, on: onPalette,
  },
  {
    what: 'palette no-match hint', where: `${PAL} (no results)`,
    color: () => twText(PAL, 'Check spelling or try').rgb, alpha: () => twText(PAL, 'Check spelling or try').a,
    px: 12, on: onPalette,
  },
  {
    what: 'palette result meta', where: `${PAL} (result row)`,
    color: () => twText(PAL, '{m.year > 0 &&').rgb, alpha: () => twText(PAL, '{m.year > 0 &&').a,
    px: 12, on: onPalette,
  },
  // ── The home rail header, on the page now that the shelf is gone (RS). ──
  {
    what: 'rail title', where: `${CSS} (.rail-header .rail-title)`,
    color: () => cssColor('.rail-header .rail-title', 'color').rgb,
    alpha: () => cssColor('.rail-header .rail-title', 'color').a,
    px: cssPx('.rail-header .rail-title'), on: () => stack(PAGE),
  },
  {
    what: 'rail subtitle', where: `${RAIL_TSX} (rail header)`,
    color: () => twText(RAIL_TSX, 'break-words">{subtitle}').rgb,
    alpha: () => twText(RAIL_TSX, 'break-words">{subtitle}').a,
    px: 12, on: () => stack(PAGE),
  },
  {
    what: 'rail "See All"', where: `${CSS} (.rail-header .rail-see-all)`,
    color: () => cssColor('.rail-header .rail-see-all', 'color').rgb,
    alpha: () => cssColor('.rail-header .rail-see-all', 'color').a,
    px: cssPx('.rail-header .rail-see-all'), on: () => stack(PAGE),
  },
]

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
