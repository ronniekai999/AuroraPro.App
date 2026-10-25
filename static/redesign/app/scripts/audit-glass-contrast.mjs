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
//
// STATIC CHECKS RUN FIRST, over every source file rather than a list, because they
// protect the premise the measured surfaces below rest on: that a `cls/NN` in the
// JSX is the colour the browser paints, and that the surfaces listed are not the
// only ones that matter.
//   0. Opacity modifiers that compile to nothing (`deadModifiers`).
//   1. Faint white text below a floor computed from the app's surfaces
//      (`faintText`), with an explicit, self-expiring exemption list.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import postcss from 'postcss'
import selparser from 'postcss-selector-parser'

const require = createRequire(import.meta.url)
const tailwind = require('tailwindcss')
const loadConfig = require('tailwindcss/loadConfig')

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

// ── Source scanning, shared by the static checks ─────────────────────────────

const APP_DIR = path.resolve(import.meta.dirname, '..')

/** The files Tailwind scans for classes (tailwind.config.js `content`: index.html
 *  and src/**), minus tests and their setup, which render nothing. Paths are
 *  relative to the app directory, as every other path in this script is. */
function uiSources() {
  const out = ['index.html']
  const walk = dir => {
    for (const e of fs.readdirSync(path.join(APP_DIR, dir), { withFileTypes: true })) {
      const p = path.posix.join(dir, e.name)
      if (e.isDirectory()) { if (p !== 'src/test') walk(p) }
      else if (/\.[jt]sx?$/.test(e.name) && !/\.test\.[jt]sx?$/.test(e.name)) out.push(p)
    }
  }
  walk('src')
  return out.sort()
}

/** `raw` with comments blanked, offsets and line breaks preserved.
 *
 *  Not `read()`: that one opens a `//` comment anywhere, so it blanks the rest of
 *  any line holding `https://`, and a line like SettingsView's TVDB credit (a
 *  URL, then the className) would hide its classes from a scan. Here a comment
 *  opens only where code can open one: at a line start or after whitespace, `{`,
 *  `(`, `;` or `,`. That also keeps `accept="image/*"` from opening a block
 *  comment. Quotes are not tracked, for the reason `read()` gives (JSX prose is
 *  full of apostrophes). */
function codeOnly(raw) {
  const out = raw.split('')
  const opener = k => k === 0 || /[\s{(;,]/.test(raw[k - 1])
  let i = 0, line = false, block = false
  while (i < raw.length) {
    if (line) { if (raw[i] === '\n') line = false; else out[i] = ' '; i++; continue }
    if (block) {
      if (raw[i] === '*' && raw[i + 1] === '/') { out[i] = out[i + 1] = ' '; block = false; i += 2; continue }
      if (raw[i] !== '\n') out[i] = ' '
      i++; continue
    }
    if (raw[i] === '/' && raw[i + 1] === '/' && opener(i)) { out[i] = out[i + 1] = ' '; line = true; i += 2; continue }
    if (raw[i] === '/' && raw[i + 1] === '*' && opener(i)) { out[i] = out[i + 1] = ' '; block = true; i += 2; continue }
    i++
  }
  return out.join('')
}
const codeCache = new Map()
const code = f => {
  if (!codeCache.has(f)) codeCache.set(f, codeOnly(fs.readFileSync(path.join(APP_DIR, f), 'utf8')))
  return codeCache.get(f)
}
const lineAt = (src, i) => src.slice(0, i).split('\n').length

// ── 0. Opacity modifiers that compile to nothing ─────────────────────────────
//
// The phone menu sheet (TopNav) had no fill of its own: `bg-[#0a0a0f]/97`. Tailwind
// 3 resolves a bare `/N` against the theme's opacity scale (0-100 in steps of 5;
// tailwind.config.js does not extend it), and a value off that scale is not an
// error. It just emits no rule. Ten such classes shipped, four of them text
// alphas that `twAlpha` below would have read as real: it parses `/(\d+)` and
// cannot know the class is dead.
//
// The oracle is Tailwind itself, run with the project's own config, so this does
// not restate the scale and follows the config if it is ever extended. A token
// `X/N` is dead when `X` alone emits a rule and `X/N` does not. That needs no list
// of colour utilities, ignores paths, dates and prose (their `X` compiles to
// nothing either), and also catches the same silent failure in a fraction
// (`w-1/7`) or a line-height (`text-sm/13`). The `opacity-N` family is checked
// the same way, with `opacity-0` as the sibling that must compile. Comments are
// skipped: a class in a comment styles nothing.

const twConfig = loadConfig(path.join(APP_DIR, 'tailwind.config.js'))

/** The subset of `candidates` that Tailwind, under this project's config, emits a
 *  rule for. One compile for the whole set. */
async function compiling(candidates) {
  const result = await postcss([tailwind({
    ...twConfig,
    content: [{ raw: [...candidates].join(' '), extension: 'html' }],
    safelist: [],
  })]).process('@tailwind utilities;', { from: undefined })
  const emitted = new Set()
  result.root.walkRules(rule => {
    try {
      selparser(sels => sels.walkClasses(c => { emitted.add(c.value) })).processSync(rule.selector)
    } catch { /* keyframe stops and the like are not class selectors */ }
  })
  return new Set([...candidates].filter(c => emitted.has(c)))
}

const OPACITY_UTILITY = /^((?:[^\s:]+:)*!?(?:bg-|text-|border-|ring-|divide-|placeholder-)?opacity-)\d+$/

// Class candidates are the ones Tailwind itself finds: its default extractor,
// the one the build runs over these files. A home-made split missed shapes the
// build reads: it split `[&>svg]:text-white/38` at the `>`, and kept the `$` of
// a class written right before `${` in a template literal. The extractor gives
// strings, not offsets, and also yields fragments of a longer candidate
// (`:text-white/38` out of `[&>svg]:text-white/38`), so each candidate is placed
// at every offset where it stands as a whole class, longest first, and never
// inside one already placed.
const extract = require('tailwindcss/lib/lib/defaultExtractor')
  .defaultExtractor({ tailwindConfig: { prefix: twConfig.prefix ?? '', separator: twConfig.separator ?? ':' } })
const STARTS_CLASS = c => c === undefined || !/[\w\-:\]/.#%&>!@[]/.test(c)
const ENDS_CLASS = c => c === undefined || !/[\w\-/.%[\]]/.test(c)

/** The classes in `src` that `keep` accepts, as { token, index }, in order. */
function classesIn(src, keep) {
  const placed = []
  const candidates = [...new Set(extract(src))].filter(keep).sort((a, b) => b.length - a.length)
  for (const token of candidates) {
    for (let i = src.indexOf(token); i >= 0; i = src.indexOf(token, i + 1)) {
      const j = i + token.length
      if (!STARTS_CLASS(src[i - 1]) || !ENDS_CLASS(src[j])) continue
      if (placed.some(p => i < p.index + p.token.length && j > p.index)) continue
      placed.push({ token, index: i })
    }
  }
  return placed.sort((a, b) => a.index - b.index)
}

/** Every dead modifier in `texts` ({ where, text } pairs), as { where, line, token }. */
async function deadModifiers(texts) {
  const uses = []
  for (const { where, text } of texts) {
    for (const { token, index } of classesIn(text, t => /\/\d+$/.test(t) || OPACITY_UTILITY.test(t))) {
      const mod = token.match(/^(.+)\/(\d+)$/)
      const op = token.match(OPACITY_UTILITY)
      if (mod) uses.push({ where, line: lineAt(text, index), token, base: mod[1] })
      else if (op) uses.push({ where, line: lineAt(text, index), token, base: `${op[1]}0` })
    }
  }
  const live = await compiling(new Set(uses.flatMap(u => [u.token, u.base])))
  return uses.filter(u => live.has(u.base) && !live.has(u.token))
}

// Known answers, run every time: a check whose oracle quietly broke (a config
// that failed to load, a Tailwind that emits nothing) would flag nothing and pass.
// If an upgrade starts compiling one of the DEAD probes (Tailwind 4 accepts any
// number), this fails and says so instead of reporting on a changed premise.
const MOD_PROBE = {
  dead: ['bg-[#0a0a0f]/97', 'hover:text-white/38', 'bg-purple-500/12', 'w-1/7', 'opacity-97'],
  live: ['bg-[#0a0a0f]/95', 'bg-[#0a0a0f]/[0.97]', 'hover:text-white/40', 'w-1/2', 'text-sm/6', 'opacity-95', 'text-white/[38%]'],
  ignored: ['/v2/assets/12', '2026-10/25', 'a/b/40'],
  // Shapes a whitespace split got wrong, each holding one dead class.
  shapes: {
    '<i className="[&>svg]:text-white/12" />': '[&>svg]:text-white/12',
    "`ring-white/13${on ? ' ring-2' : ''}`": 'ring-white/13',
  },
}
let staticFails = 0
{
  console.log('## 0. Opacity modifiers that compile to nothing')
  const probe = await deadModifiers([{ where: 'probe',
    text: [...MOD_PROBE.dead, ...MOD_PROBE.live, ...MOD_PROBE.ignored, ...Object.keys(MOD_PROBE.shapes)].join(' ') }])
  const got = probe.map(u => u.token).sort().join(' ')
  const want = [...MOD_PROBE.dead, ...Object.values(MOD_PROBE.shapes)].sort().join(' ')
  if (got !== want) {
    console.log(`  *** known-answer probe: expected exactly [${want}] dead, got [${got}] — the oracle or its premise has changed`)
    staticFails++
  }
  const files = uiSources()
  const dead = await deadModifiers(files.map(f => ({ where: f, text: code(f) })))
  for (const u of dead) console.log(`  ${u.where}:${u.line}  ${u.token}  — emits no CSS; use an arbitrary value (/[0.NN]) or a step on the scale`)
  console.log(`  ${dead.length} dead modifier(s) across ${files.length} files.\n`)
  staticFails += dead.length
}

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

// ── 1. Faint white text, everywhere, against a computed floor ────────────────
//
// The surfaces below are measured one by one, and only those. Everything else
// was measured by nothing: about 330 uses of text-white/20 to /45 across 44
// files, and white at 45% is under 4.5:1 even on pure black. So every
// `text-white/N` (and `placeholder-white/N`) in the UI sources is held to a
// FLOOR: the smallest step on the opacity scale that clears the threshold on
// every surface faint text sits on, computed from those surfaces' own CSS. It
// is a floor, not a measurement: a use above it can still fail on a lighter
// fill than these, which is what the measured surfaces are for.
//
// Normal text needs 4.5:1. Large text (24px, or 18.66px bold, read from the
// same tag's classes; an inherited size reads as normal) and an icon that
// carries meaning (WCAG 1.4.11) need 3:1. A use below its floor fails unless it
// is EXEMPT below, by kind:
//   decorative   separators and ornaments that say nothing (no floor)
//   placeholder  a placeholder repeating the field's visible label (no floor)
//   disabled     shown only while the control is disabled (no floor); a
//                `disabled:` variant is exempt without an entry
//   non-text     an icon that carries meaning (held to the 3:1 floor)
//   large        large text whose size the tag does not show (3:1 floor)
//   deferred     left for later, each named here like any other exemption
// Each entry's anchor is source text that includes the class itself and must
// occur exactly `count` times (1 by default). An entry whose anchor no longer
// covers a use below the floor fails as unneeded, so raising a class to the
// floor means deleting its entry, and an exemption cannot outlive its reason.
//
// Classes are found the way the build finds them (Tailwind's extractor, see
// `classesIn`), and `color:` declarations in index.css are held to the same
// floor: the global placeholder colour styled every input without a
// placeholder class, and nothing measured it.
//
// NOT COVERED: other faint colours (text-gray-*, tinted alphas such as
// text-purple-200/40); alpha stacked by a parent's opacity-*; class names
// built at runtime; fills lighter than the floor surfaces (/50 holds 4.5:1 up
// to about white/0.10); and translucent overlays over video. The party rail
// (rgba(12,10,20,0.4)) and the mini dock (rgba(8,6,14,0.5)) sit on the
// picture: over a white frame, /50 text measures 1.7 and 2.1:1, and even
// full white only 2.7 and 3.8:1. /50 needs fills of about 0.85 and 0.83
// there, near the opaque 0.92 the Subtle glow setting already uses, which is
// a design decision rather than a contrast fix.

const FLOOR_SURFACES = {
  'page ink #050505': [INK],
  '.aurora-bg (page tints)': stack(PAGE),
  '.glass-panel on the page': stack(backgroundLayers(cssValue('.glass-panel', 'background')), PAGE),
  '.glass-card on the page': stack(backgroundLayers(cssValue('.glass-card', 'background')), PAGE),
  '.glass-card:hover on the page': stack(backgroundLayers(cssValue('.glass-card:hover', 'background')), PAGE),
  'panel ink --surface-1': [rootToken('--surface-1').rgb],
  'raised panel --surface-2': [rootToken('--surface-2').rgb],
}
const THEME = require('tailwindcss/resolveConfig')(twConfig).theme
const OPACITY_STEPS = Object.keys(THEME.opacity).map(Number).sort((a, b) => a - b)
/** The smallest step on the scale that clears `need` on every floor surface. */
function floorFor(need) {
  const step = OPACITY_STEPS.find(s => Object.values(FLOOR_SURFACES).flat()
    .every(bg => ratio(over(W, s / 100, bg), bg) >= need))
  if (step === undefined) throw new Error(`audit: no opacity step clears ${need}:1 on every floor surface`)
  return step
}
const FLOOR = { normal: floorFor(4.5), large: floorFor(3.0) }

// Font sizes in px, from the resolved theme, for the large-text test.
const FONT_PX = Object.fromEntries(Object.entries(THEME.fontSize)
  .map(([k, v]) => [k, parseFloat(Array.isArray(v) ? v[0] : v) * (String(Array.isArray(v) ? v[0] : v).endsWith('rem') ? 16 : 1)]))

const EXEMPT = [
  // ── App.tsx ──
  { file: 'src/App.tsx', anchor: 'absolute top-3 right-3 text-white/40 hover:text-white transition-colors"', kind: 'non-text',
    why: 'the server panel\'s icon-only close button; its X is the control' },
  { file: 'src/App.tsx', anchor: 'className="text-white/40 hover:text-white transition-colors" aria-label="Close notifications">', kind: 'non-text',
    why: 'the notification panel\'s icon-only close button' },
  { file: 'src/App.tsx', anchor: "stat.tone === 'idle' ? 'bg-white/[0.04] text-white/40'", kind: 'non-text',
    why: 'a server stat tile\'s icon in its idle tone; the label and value beside it are the text' },
  { file: 'src/App.tsx', anchor: 'text-white/35 text-[10px]">ⓘ</span>', kind: 'non-text',
    why: 'the glyph that marks a stat tile as having a hover hint' },
  // ── companion, browse ──
  { file: 'src/companion/JoinScreen.tsx', anchor: "'border-[var(--glow-border)] bg-white/[0.04] text-white/30',", kind: 'decorative',
    why: 'an empty code cell, which shows only a "·" slot marker; the heading above says what to enter' },
  { file: 'src/components/BrowseView.tsx', anchor: '<span className="text-white/30 mx-1.5">•</span>', kind: 'decorative',
    why: 'the bullet between the page subtitle and its count' },
  { file: 'src/components/CalendarView.tsx', anchor: '<span className="text-white/30 mx-1.5">•</span>', kind: 'decorative',
    why: 'the bullet between the page subtitle and its count' },
  { file: 'src/components/BugReportModal.tsx', anchor: 'className="text-white/40 hover:text-rose-300 transition-colors disabled:opacity-50 self-start"', kind: 'non-text',
    why: 'the attachment\'s icon-only "×" remove button' },
  { file: 'src/components/MediaCardCinema.tsx', anchor: 'aria-hidden="true" className="text-white/20">', kind: 'decorative',
    why: 'the film glyph a card shows where its poster is missing; the title is on the card' },
  { file: 'src/components/MembersView.tsx', anchor: '<Icon name="users" size={28} className="text-white/25 mx-auto" />', kind: 'decorative',
    why: 'the illustration above the members list\'s error message' },
  { file: 'src/components/OnboardingFlow.tsx', anchor: 'transition-colors placeholder:text-white/35 focus:border-[#a855f7]"', kind: 'large',
    why: 'the "Type your name" instruction, set at clamp(2rem, 6vw, 3rem) bold, which the size test cannot read (raised from /15)' },
  // ── party ──
  { file: 'src/components/PartyInvite.tsx', anchor: 'rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white"', kind: 'non-text',
    why: 'the invite\'s icon-only close button' },
  { file: 'src/components/PartyPanel.tsx', anchor: "className={speaking ? 'text-emerald-300' : 'text-white/40'}>", kind: 'non-text',
    why: 'the microphone that marks a participant on voice, at rest (it turns green while they speak)' },
  { file: 'src/components/PartyShareCardModal.tsx', anchor: 'className="text-white/40 hover:text-white/80 text-sm transition-colors"', kind: 'non-text',
    why: 'the share card\'s icon-only "✕" close button' },
  { file: 'src/components/ProfileSwitcher.tsx', anchor: 'strokeWidth="2.5" className="text-white/40" aria-hidden="true">', kind: 'non-text',
    why: 'the chevron that shows the profile button opens a menu' },
  // ── requests, search, top bar ──
  { file: 'src/components/RequestsView.tsx', anchor: "r.media_type === 'tv' ? 'tv' : 'film'} size={20} className=\"text-white/25\" />", kind: 'decorative',
    why: 'the glyph a search result shows where its poster is missing; the title and "TV"/"Movie" are beside it' },
  { file: 'src/components/RequestsView.tsx', anchor: "req.media_type === 'tv' ? 'tv' : 'film'} size={22} className=\"text-white/25\" />", kind: 'decorative',
    why: 'the same glyph on a request row without a poster' },
  { file: 'src/components/RequestsView.tsx', anchor: '<Icon name="download" size={48} className="mx-auto text-white/20 mb-4" />', kind: 'decorative',
    why: 'the illustration above the empty requests list\'s message' },
  { file: 'src/components/RequestsView.tsx', anchor: '{req.username && <span className="text-white/25">·</span>}', kind: 'decorative',
    why: 'the dot between a request\'s requester and its date' },
  { file: 'src/components/RequestsView.tsx', anchor: 'className="w-9 h-9 rounded-[10px] grid place-items-center text-white/45 bg-white/[0.04]', kind: 'non-text',
    why: 'a request\'s icon-only delete button' },
  { file: 'src/components/SearchPalette.tsx', anchor: '<span className="text-white/20 mx-1" aria-hidden="true">·</span>', count: 2, kind: 'decorative',
    why: 'the dots between the key legend\'s entries' },
  { file: 'src/components/SearchView.tsx', anchor: '<Icon name="search" size={48} className="mx-auto text-white/20 mb-4" />', kind: 'decorative',
    why: 'the illustration above "No results found"' },
  { file: 'src/components/TopNav.tsx', anchor: '<Icon name="search" size={16} className="text-white/35 flex-none" />', kind: 'non-text',
    why: 'the magnifier that marks the phone sheet\'s field as search' },
  { file: 'src/components/TopNav.tsx', anchor: '<Icon name="search" size={15} className="text-white/35 flex-none" />', kind: 'non-text',
    why: 'the magnifier that marks the top bar\'s field as search' },
  // ── member pages, voice, the match tool ──
  { file: 'src/components/UserProfileView.tsx', anchor: '<Icon name="user" size={28} className="text-white/25 mx-auto" />', kind: 'decorative',
    why: 'the illustration above a member page\'s error message' },
  { file: 'src/components/UserProfileView.tsx', anchor: '<span className="text-white/20">&middot;</span>', kind: 'decorative',
    why: 'the dot between the follower and following counts' },
  { file: 'src/components/UserProfileView.tsx', anchor: '<Icon name="globe" size={12} className="text-white/40" />', kind: 'decorative',
    why: 'the globe on a social link chip, which names the network in text' },
  { file: 'src/components/UserProfileView.tsx', anchor: '<Icon name="eye" size={14} className="text-white/25" />', kind: 'decorative',
    why: 'the eye before the hidden-history message, which says it in words' },
  { file: 'src/components/VoicePill.tsx', anchor: 'text-white/45 hover:text-red-300 hover:bg-red-500/15 transition-colors"', kind: 'non-text',
    why: 'the voice pill\'s icon-only leave button' },
  { file: 'src/components/admin/ManualMatchModal.tsx', anchor: '<Icon name="film" size={20} className="text-white/25" />', kind: 'decorative',
    why: 'the glyph a match candidate shows where its poster is missing' },
  // ── detail ──
  { file: 'src/components/detail/DetailHero.tsx', anchor: '{i > 0 && <span className="text-white/45" aria-hidden="true">·</span>}', kind: 'decorative',
    why: 'the dots between the hero\'s metadata items' },
  { file: 'src/components/detail/DetailRail.tsx', anchor: "n <= shown ? 'text-yellow-400' : 'text-white/35 hover:text-white/50',", kind: 'non-text',
    why: 'an unfilled rating star; each star is a "rate N stars" button (raised from /25, about 2:1)' },
  // ── admin ──
  { file: 'src/components/admin/AdminView.tsx', anchor: "req.media_type === 'tv' ? 'tv' : 'film'} size={16} className=\"text-white/25\" />", kind: 'decorative',
    why: 'the glyph a held request shows where its poster is missing' },
  { file: 'src/components/admin/AdminView.tsx', anchor: '{isCastRow && <span className="text-white/25 mr-1" aria-hidden="true">└</span>}', kind: 'decorative',
    why: 'the tree corner on a cast receiver\'s row; an sr-only line says what the row is' },
  { file: 'src/components/admin/AdminView.tsx', anchor: 'className="text-white/40 hover:text-white" aria-label="Close">', kind: 'non-text',
    why: 'the session diagnostic\'s icon-only close button' },
  { file: 'src/components/admin/AdminView.tsx', anchor: "${hostedChat ? 'text-white/30' : 'text-white/70'}", kind: 'disabled',
    why: 'the Structured outputs label while its checkbox is disabled (hosted providers always use it)' },
  { file: 'src/components/admin/AdminView.tsx', anchor: 'className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/[0.06] disabled:opacity-50', kind: 'non-text',
    why: 'a user row\'s icon-only actions button' },
  { file: 'src/components/admin/AdminView.tsx', anchor: "color: empty ? 'text-white/40' : behind ? 'text-amber-400' : 'text-emerald-400',", kind: 'non-text',
    why: 'the Skip Analysis tile\'s state icon with nothing analysed yet; the figures beside it are the text' },
  { file: 'src/components/admin/AdminView.tsx', anchor: '{hint && <span className="text-white/35">ⓘ</span>}', kind: 'non-text',
    why: 'the glyph that marks a dashboard tile as having a hover hint' },
  { file: 'src/components/admin/AdminView.tsx', anchor: 'mb-1 cursor-help">Memory <span className="text-white/35">ⓘ</span>', kind: 'non-text',
    why: 'the same glyph on the Memory figure' },
  // ── index.css ──
  { file: 'src/index.css', anchor: '.media-card-cinema .card-overlay .co-meta .sep { color: rgba(255, 255, 255, 0.45); }', kind: 'non-text',
    why: 'the dots between a card\'s meta items, set at 0.45 for 3:1 over the scrim on a bright poster (see the rule)' },
  // ── deferred: the player, which a separate change was working in ──
  { file: 'src/components/VideoPlayer.tsx', anchor: '<span className="text-white/40 text-xs">{a.codec}', kind: 'deferred',
    why: 'an audio track\'s codec and channels in the track menu' },
  { file: 'src/components/VideoPlayer.tsx', anchor: '{!loaded && <p className="text-white/40 text-sm">Loading…</p>}', kind: 'deferred',
    why: 'the skip-marker editor\'s loading line' },
  { file: 'src/components/VideoPlayer.tsx', anchor: '<span className="text-white/40 text-xs font-mono">', kind: 'deferred',
    why: 'a skip marker\'s current value in the editor' },
  { file: 'src/components/VideoPlayer.tsx', anchor: '<p className="text-white/30 text-[11px] mt-2 leading-snug">', kind: 'deferred',
    why: 'the skip-marker editor\'s hint' },
]

const EXEMPT_KINDS = { decorative: null, placeholder: null, disabled: null, deferred: null, 'non-text': 'large', large: 'large' }
const DISABLED_VARIANT = /(?:^|:)(?:group-|peer-|aria-)?disabled(?:\/[\w-]+)?:$/
// A whole faint-white class: variants (`hover:`, `md:`, `[&>svg]:`, a named
// group `group-hover/row:`, the child variant `*:`), then the utility and its
// alpha, bare (/40) or arbitrary (/[0.4], /[.4], /[40%]).
const FAINT = /^((?:(?:\*|[\w-]*(?:\[[^\]]*\])?[\w-]*(?:\/[\w-]+)?):)*)!?(text|placeholder)-white\/(\d+|\[(?:\d*\.?\d+%?)\])$/
const alphaOf = raw => raw.startsWith('[')
  ? (raw.endsWith('%]') ? parseFloat(raw.slice(1)) : Math.round(parseFloat(raw.slice(1)) * 100))
  : Number(raw)

/** The JSX opening tag around offset `i` in `src`, or else the string literal
 *  holding it: where the classes that size the text live. */
function classContext(src, i) {
  const lt = src.lastIndexOf('<', i)
  if (lt >= 0 && /[A-Za-z]/.test(src[lt + 1] ?? '')) {
    let depth = 0, quote = null
    for (let k = lt; k < src.length; k++) {
      const c = src[k]
      if (quote) { if (c === '\\') { k++; continue } if (c === quote) quote = null; continue }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) { if (k > i) return src.slice(lt, k + 1); break }
    }
  }
  const lineStart = src.lastIndexOf('\n', i) + 1
  const lineEnd = src.indexOf('\n', i)
  return src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
}

/** Large text per WCAG, from the size and weight classes in `ctx`. The size is
 *  the smallest at any breakpoint (a `max-sm:text-sm` makes it small on phones);
 *  the weight counts only unprefixed. */
function isLarge(ctx) {
  let px = null
  for (const m of ctx.matchAll(/(?<![\w-])text-(xs|sm|base|lg|[2-9]?xl)(?![\w-])/g)) px = Math.min(px ?? Infinity, FONT_PX[m[1]])
  for (const m of ctx.matchAll(/(?<![\w-])text-\[([\d.]+)(px|rem)\]/g)) px = Math.min(px ?? Infinity, Number(m[1]) * (m[2] === 'rem' ? 16 : 1))
  const bold = /(?<![\w:-])font-(bold|extrabold|black)(?![\w-])/.test(ctx)
  return px !== null && (px >= 24 || (px >= 18.66 && bold))
}

/** Every faint-white class in `src`, as a use. */
function faintUsesIn(f, src) {
  const uses = []
  for (const { token, index } of classesIn(src, t => FAINT.test(t))) {
    const [, variants, utility, raw] = token.match(FAINT)
    const kind = DISABLED_VARIANT.test(variants) ? 'disabled-variant'
      : (utility === 'placeholder' || /(?:^|:)placeholder:$/.test(variants)) ? 'placeholder' : 'text'
    const large = kind === 'text' && isLarge(classContext(src, index))
    uses.push({ f, i: index, end: index + token.length, line: lineAt(src, index), cls: token, alpha: alphaOf(raw), kind, large })
  }
  return uses
}

/** White's alpha in a CSS colour, 0-100, or null when it is not white. Reads
 *  rgb()/rgba() with commas or spaces and a `,` or `/` alpha, hsl()/hsla() at
 *  100% lightness, and #fffA / #ffffffAA. */
function whiteAlpha(value) {
  const v = value.toLowerCase()
  const alpha = (n, pct) => (n === undefined ? 100 : Math.round(pct ? parseFloat(n) : parseFloat(n) * 100))
  let m
  if ((m = v.match(/#fff([0-9a-f])(?![0-9a-f])/))) return Math.round(parseInt(m[1] + m[1], 16) / 2.55)
  if ((m = v.match(/#ffffff([0-9a-f]{2})(?![0-9a-f])/))) return Math.round(parseInt(m[1], 16) / 2.55)
  const W255 = String.raw`(?:255(?:\.0*)?|100%)`
  if ((m = v.match(new RegExp(String.raw`rgba?\(\s*${W255}\s*[,\s]\s*${W255}\s*[,\s]\s*${W255}\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)`)))) return alpha(m[1], m[2])
  if ((m = v.match(/hsla?\(\s*[\d.]+(?:deg)?\s*[,\s]\s*[\d.]+%\s*[,\s]\s*100%\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)/))) return alpha(m[1], m[2])
  return null
}

/** White `color:` declarations in `text` (index.css), as uses. A use's span
 *  runs from its rule's selector to the declaration, so an exemption anchors on
 *  the rule as written. Sizes are not read: CSS text is judged as normal text. */
function faintCssUses(text = css, file = CSS) {
  const uses = []
  postcss.parse(text).walkDecls(/^(?:color|-webkit-text-fill-color)$/, d => {
    const alpha = whiteAlpha(d.value)
    if (alpha === null || d.parent.type !== 'rule') return
    const i = d.parent.source.start.offset
    uses.push({
      f: file, i, end: d.source.end.offset + 1, line: d.source.start.line, cls: `${d.parent.selector} { ${d.prop}: ${d.value} }`,
      alpha, kind: /::?placeholder/.test(d.parent.selector) ? 'placeholder' : 'text', large: false,
    })
  })
  return uses
}

// The shapes a regex scan missed, each a use below the floor that must be found.
const FAINT_PROBE = {
  text: '<i className="[&>svg]:text-white/38" /> `text-white/40${on ? " ring-2" : ""}` <b className="text-white/[38%]" />' +
    ' <s className="group-hover/row:text-white/30 *:text-white/25" />',
  want: ['[&>svg]:text-white/38', 'text-white/40', 'text-white/[38%]', 'group-hover/row:text-white/30', '*:text-white/25'],
}
// Each white the CSS scan must read, with its alpha; the last is not white.
const CSS_PROBE = {
  text: '.a { color: rgb(255 255 255 / 40%) } .b { color: hsla(0, 0%, 100%, .4) } .c { color: #fff6 }' +
    ' .d { color: rgba(255, 255, 255, 0.45) } .e { color: #ffffff66 } .f { color: hsl(0 0% 100% / 0.3) } .g { color: #fffa0a }',
  want: [40, 40, 40, 45, 40, 30],
}

function faintText() {
  const problems = []
  const probe = faintUsesIn('probe', FAINT_PROBE.text).filter(u => u.alpha < FLOOR.normal).map(u => u.cls)
  if (probe.join(' ') !== FAINT_PROBE.want.join(' ')) {
    problems.push(`known-answer probe: expected [${FAINT_PROBE.want.join(' ')}] below the floor, found [${probe.join(' ')}]`)
  }
  const cssProbe = faintCssUses(CSS_PROBE.text, 'probe.css').map(u => u.alpha)
  if (cssProbe.join(' ') !== CSS_PROBE.want.join(' ')) {
    problems.push(`CSS known-answer probe: expected alphas [${CSS_PROBE.want.join(' ')}], read [${cssProbe.join(' ')}]`)
  }
  const uses = [...uiSources().flatMap(f => faintUsesIn(f, code(f))), ...faintCssUses()]
  const below = uses.filter(u => u.kind !== 'disabled-variant' && u.alpha < (u.large ? FLOOR.large : FLOOR.normal))

  // Exemptions: each anchor must still sit over a use below its floor.
  const covered = new Map()
  for (const e of EXEMPT) {
    if (!(e.kind in EXEMPT_KINDS)) { problems.push(`exemption ${e.file} "${e.anchor}": unknown kind "${e.kind}"`); continue }
    if (!e.why) { problems.push(`exemption ${e.file} "${e.anchor}": no reason given`); continue }
    const src = code(e.file)
    const spans = []
    for (let k = src.indexOf(e.anchor); k >= 0; k = src.indexOf(e.anchor, k + 1)) spans.push([k, k + e.anchor.length])
    if (spans.length !== (e.count ?? 1)) {
      problems.push(`exemption ${e.file} "${e.anchor}": anchor occurs ${spans.length}x, expected ${e.count ?? 1}` +
        (spans.length ? ' — out of date' : ' — if its class was raised to the floor, delete the entry; otherwise update the anchor'))
      continue
    }
    for (const [a, b] of spans) {
      const hit = below.filter(u => u.f === e.file && u.i >= a && u.end <= b)
      if (!hit.length) { problems.push(`exemption ${e.file}:${lineAt(src, a)} "${e.anchor}": covers no use below the floor — delete it`); continue }
      for (const u of hit) {
        covered.set(u, e)
        const floor = EXEMPT_KINDS[e.kind] && FLOOR[EXEMPT_KINDS[e.kind]]
        if (floor && u.alpha < floor) problems.push(`${u.f}:${u.line}  ${u.cls}  — exempt as ${e.kind}, but under its ${floor}% floor (3:1)`)
      }
    }
  }
  for (const u of below.filter(u => !covered.has(u))) {
    problems.push(`${u.f}:${u.line}  ${u.cls}  — below the ${u.large ? FLOOR.large : FLOOR.normal}% floor${u.large ? ' (large text)' : ''}: raise it, or exempt it with a reason`)
  }
  return { uses, below, covered, problems }
}

{
  console.log('## 1. Faint white text against the computed floor')
  for (const [name, bgs] of Object.entries(FLOOR_SURFACES)) {
    const min = need => OPACITY_STEPS.find(s => bgs.every(bg => ratio(over(W, s / 100, bg), bg) >= need))
    console.log(`  ${name.padEnd(32)} 4.5:1 from /${min(4.5)}   3:1 from /${min(3)}`)
  }
  console.log(`  floor: /${FLOOR.normal} for normal text, /${FLOOR.large} for large text and meaningful icons`)
  const r = faintText()
  for (const p of r.problems) console.log(`  *** ${p}`)
  const kinds = {}
  for (const e of r.covered.values()) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
  console.log(`  ${r.uses.length} faint-white uses (classes, and white colors in ${CSS}); ${r.below.length} below the floor: ` +
    `${Object.entries(kinds).map(([k, n]) => `${n} ${k === 'deferred' ? 'deferred' : `exempt as ${k}`}`).join(', ') || 'none exempt'}; ` +
    `${r.uses.filter(u => u.kind === 'disabled-variant').length} \`disabled:\` variant(s) not judged.\n`)
  staticFails += r.problems.length
}

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
if (staticFails) console.log(`${staticFails} static check failure(s) above (dead modifiers, faint text).`)
process.exit(fails || staticFails ? 1 : 0)
