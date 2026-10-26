// Phase 8 — contrast audit of every on-artwork text surface introduced in
// Phases 3–5.
//
// IMPLEMENTATION_PLAN names this as a risk in its own words: "Text-on-art
// contrast replaces a purpose-built AA text shelf — scrim must guarantee ≥4.5:1
// for meta; audited again in Phase 8." This is that audit.
//
// Method. The scrims are MULTI-LAYER gradients (a horizontal ramp painted over a
// vertical one, over the artwork), so a single "the scrim is 0.72" figure is
// meaningless — the alpha that matters is the one at each string's own x AND y.
// Every layer is composited in sRGB, in paint order, then luminance is taken.
// Each surface is evaluated over a BLACK frame and a WHITE frame, because the
// artwork is arbitrary and only the worse of the two is a real answer.
//
// WCAG thresholds applied:
//   normal text  4.5:1   (< 18.66px, or < 24px unless bold)
//   large text   3.0:1   (>= 18.66px bold, or >= 24px)
//   non-text UI  3.0:1   (1.4.11 — boundaries of controls, state indicators)
// Text shadows and drop-shadows are NOT credited: WCAG has no provision for
// them, and this project has consistently declined to count them.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// ⚠️ F1, the reason this file was rewritten. The first version imported nothing
// and read nothing: the scrim stops and every colour/alpha/px/coordinate were
// hand-transcribed literals. Blanking the entire hero scrim in index.css AND
// dropping the description to `text-white/15` produced BYTE-IDENTICAL output and
// exit 0. It was a passing test that could not fail — worse than no test, because
// `npm run audit:contrast` reported PASS and the commit claimed it was
// mutation-tested. It was: its own literals were mutated, which proves nothing
// about the code.
// The rewrite derived the scrims, but ten of its eleven text surfaces still
// carried a typed-in alpha, so reverting the "Not tonight" contrast fix
// (`text-white/75` back to `/60`) again left the output byte-identical and exit 0.
// Now each surface's colour, alpha, size, weight and fill are read from its own
// element's classes (`text()` below), and the run fails if a value it depends on
// has moved. NOT derived: each surface's sample point (x, y), measured by hand
// at the 1440x900 frame its classes are resolved at.

const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(import.meta.dirname, '..')
const THEME = require('tailwindcss/resolveConfig')(require('tailwindcss/loadConfig')(path.join(APP_DIR, 'tailwind.config.js'))).theme

const SRC_CSS = 'src/index.css'
const SRC_HERO = 'src/components/HeroSection.tsx'

/** `raw` with comments blanked, offsets and line breaks preserved. The hero's
 *  comments quote the very classes this audit reads ("text-white/75, not /60"),
 *  so every lookup below runs on code only. A comment opens only where code can
 *  open one, as in audit-glass-contrast.mjs's `codeOnly`, which says why. */
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

const css = fs.readFileSync(SRC_CSS, 'utf8')
const hero = codeOnly(fs.readFileSync(SRC_HERO, 'utf8'))

/** Pull a declaration's value out of a named rule, or die loudly. */
function cssValue(selector, prop) {
  const rule = css.match(new RegExp(String.raw`\n${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*\{([\s\S]*?)\n\}`))
  if (!rule) throw new Error(`audit: rule ${selector} not found in ${SRC_CSS} — the audit is out of date, not passing`)
  const m = rule[1].match(new RegExp(String.raw`(?:^|;|\{)\s*${prop}:\s*([\s\S]*?);`))
  if (!m) throw new Error(`audit: ${selector} no longer sets ${prop} — the audit is out of date, not passing`)
  return m[1].replace(/\s+/g, ' ').trim()
}

/** Every `rgba(...) P%` / `#hex P%` pair in a linear-gradient, as [pos, alpha]. */
function parseLinearStops(value, which) {
  const layers = value.split(/,(?![^(]*\))/)
  void layers
  const g = value.match(/linear-gradient\(([^;]*?)\)(?=\s*[,;]|\s*$)/g) ?? []
  const chosen = g[which]
  if (!chosen) throw new Error('audit: expected two linear-gradient layers in the hero scrim')
  const stops = []
  for (const m of chosen.matchAll(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|transparent)\s*([\d.]+)%/g)) {
    const col = m[1]
    // heroBackdrop composites #050505 at each stop's alpha and never reads the
    // stop's colour, so a layer that changed hue would be measured as ink.
    // Refuse it instead of reporting a figure for a colour that is not there.
    if (col !== 'transparent' && !/^(#050505|rgba\(\s*5\s*,\s*5\s*,\s*5\s*,[^)]*\))$/i.test(col))
      throw new Error(`audit: a hero scrim stop is ${col}; this audit composites #050505 only — model the new colour, do not pass`)
    let a
    if (col === 'transparent') a = 0
    else if (col.startsWith('rgba')) a = Number(col.match(/[\d.]+/g)[3] ?? 1)
    else a = 1
    stops.push([Number(m[2]) / 100, a])
  }
  if (stops.length < 3) throw new Error('audit: could not parse the hero scrim stops')
  return stops
}

// ── reading a surface from its own element ────────────────────────────────
// The frame the sample points below were taken at. Classes are resolved as they
// apply at rest at its width, and fluid lengths (vw, vh) are evaluated in it.
const VIEWPORT_W = 1440, VIEWPORT_H = 900
const SCREENS = Object.fromEntries(Object.entries(THEME.screens).map(([k, v]) => {
  if (typeof v !== 'string' || !/^\d+px$/.test(v)) throw new Error(`audit: screen ${k} is ${JSON.stringify(v)}, not a px min-width this audit can place`)
  return [k, parseFloat(v)]
}))
// Variants that hold only while someone interacts, so never at rest.
const INTERACTION = new Set(['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited', 'disabled',
  'group-hover', 'group-focus', 'group-focus-within', 'peer-hover', 'peer-focus'])

/** The JSX opening tag holding `anchor` (in it, or in the element's direct
 *  text), and the line it starts on. The anchor must occur exactly once: one
 *  that occurs twice silently measures whichever comes first. Walk back to this
 *  element's `<`, forward to the tag's own `>`, skipping quotes and braces so an
 *  arrow function's `>` does not end it — audit-glass-contrast.mjs's `tagOf`. */
function tagAt(anchor) {
  const i = hero.indexOf(anchor)
  if (i < 0) throw new Error(`audit: anchor not found in ${SRC_HERO}: ${anchor} — the audit is out of date, not passing`)
  if (hero.indexOf(anchor, i + 1) >= 0) throw new Error(`audit: anchor "${anchor}" is not unique in ${SRC_HERO} — it cannot identify one element`)
  const start = hero.lastIndexOf('<', i)
  if (start < 0 || hero[start + 1] === '/') throw new Error(`audit: anchor "${anchor}" is not in an opening tag or its direct text in ${SRC_HERO}`)
  let end = -1, depth = 0, quote = null
  for (let k = start; k < hero.length; k++) {
    const c = hero[k]
    if (quote) { if (c === '\\') { k++; continue } if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) { end = k; break }
  }
  if (end < 0) throw new Error(`audit: could not find the end of the tag holding "${anchor}" in ${SRC_HERO}`)
  const lineAt = k => hero.slice(0, start + k).split('\n').length
  return { tag: hero.slice(start, end + 1), at: i - start, line: lineAt(0), lineAt }
}

/** The class list the element holding `anchor` paints with. A className that
 *  is one string is that string. One that is `cond ? 'A' : 'B'` (the two hero
 *  titles) is the branch the anchor sits in, so anchor those inside the
 *  literal. Anything else — a template with `${…}`, a cn() call — dies: classes
 *  built at runtime cannot be read here. */
function classesOf(anchor) {
  const { tag, at, line, lineAt } = tagAt(anchor)
  const attr = tag.match(/\sclassName=/)
  if (!attr) throw new Error(`audit: the element anchored by "${anchor}" has no className — the audit is out of date, not passing`)
  const from = attr.index + attr[0].length
  let to
  if (tag[from] === '"') to = tag.indexOf('"', from + 1) + 1
  else if (tag[from] === '{') {
    let depth = 0, quote = null
    for (let k = from; k < tag.length; k++) {
      const c = tag[k]
      if (quote) { if (c === quote) quote = null; continue }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) { to = k + 1; break }
    }
  }
  if (!to) throw new Error(`audit: cannot read the className of the element anchored by "${anchor}"`)
  const value = tag.slice(from, to)
  const lits = [...value.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)]
    .map(m => ({ text: m[1] ?? m[2] ?? m[3], from: from + m.index, to: from + m.index + m[0].length }))
  if (lits.some(l => l.text.includes('${'))) throw new Error(`audit: the className anchored by "${anchor}" is built at runtime; this audit cannot read it`)
  if (lits.length === 1 && value === `"${lits[0].text}"`) return { classes: lits[0].text, line }
  if (lits.length === 2 && /^\{\s*!?[\w.]+\s*\?\s*(["'`])[^"'`]*\1\s*:\s*(["'`])[^"'`]*\2\s*\}$/.test(value)) {
    const hit = lits.find(l => at >= l.from && at < l.to)
    if (hit) return { classes: hit.text, line: lineAt(hit.from) }
    throw new Error(`audit: "${anchor}" is on an element whose className has two branches; anchor it inside the one measured`)
  }
  throw new Error(`audit: the className anchored by "${anchor}" is not a string or a two-branch condition; this audit cannot read it`)
}

/** `md:hover:text-white/70` -> [['md', 'hover'], 'text-white/70']. Splits on `:`
 *  outside brackets, so `text-[color:var(--x)]` and `[text-shadow:…]` stay whole. */
function splitVariants(token) {
  const parts = []
  let depth = 0, start = 0
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '[') depth++
    else if (token[i] === ']') depth--
    else if (token[i] === ':' && depth === 0) { parts.push(token.slice(start, i)); start = i + 1 }
  }
  return [parts, token.slice(start)]
}

/** A Tailwind opacity modifier or `opacity-*` value as 0..1: a step on the
 *  theme's scale, or an arbitrary `[0.04]` / `[4%]`. A step off the scale
 *  emits no CSS (audit-glass-contrast.mjs check 0), so it dies here rather than
 *  being measured as if it painted. */
function twOpacity(mod, token) {
  const arb = mod.match(/^\[([\d.]+)(%?)\]$/)
  if (arb) return Number(arb[1]) / (arb[2] ? 100 : 1)
  if (!(mod in THEME.opacity)) throw new Error(`audit: ${token} is off the opacity scale and emits no CSS`)
  return Number(THEME.opacity[mod])
}

/** A theme colour by its utility name (`white`, `purple-100`), walking nested
 *  palettes with the longest key first, as Tailwind does. */
function themeColor(name) {
  const walk = (node, rest) => {
    if (typeof node === 'string') return rest === '' ? node : undefined
    if (!node || typeof node !== 'object') return undefined
    if (rest === '') return typeof node.DEFAULT === 'string' ? node.DEFAULT : undefined
    const parts = rest.split('-')
    for (let n = parts.length; n >= 1; n--) {
      const key = parts.slice(0, n).join('-')
      if (key in node) { const hit = walk(node[key], parts.slice(n).join('-')); if (hit !== undefined) return hit }
    }
    return undefined
  }
  return walk(THEME.colors, name)
}

/** A `:root` custom property from index.css. */
function rootToken(name) {
  const all = [...css.matchAll(new RegExp(String.raw`\n\s*${name.replace(/[-]/g, '\\-')}\s*:\s*([^;]+);`, 'g'))]
  if (all.length !== 1) throw new Error(`audit: ${name} is defined ${all.length} times in ${SRC_CSS}; this audit reads exactly one — the audit is out of date, not passing`)
  return all[0][1].trim()
}

/** rgb()/rgba()/#hex -> { rgb: [0..1 x3], a }. */
function parseColor(str) {
  const s = str.trim()
  if (s.startsWith('#')) {
    const h = s.slice(1)
    return { rgb: hex(s), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
  }
  const n = s.match(/^rgba?\(([^)]*)\)$/)?.[1].split(/[\s,/]+/).filter(Boolean).map(Number)
  if (!n || n.length < 3 || n.some(Number.isNaN)) throw new Error(`audit: cannot parse the colour ${str}`)
  return { rgb: n.slice(0, 3).map(v => v / 255), a: n[3] ?? 1 }
}

/** A colour utility's value (`white/75`, `purple-100/85`, `[#0a0a0f]/95`,
 *  `[color:var(--text-secondary)]`) as { rgb, a }. Dies on anything it cannot
 *  turn into a colour (`current`, a theme colour behind a CSS variable). */
function twColor(value, token) {
  let depth = 0, cut = -1
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '[') depth++
    else if (value[i] === ']') depth--
    else if (value[i] === '/' && depth === 0) cut = i
  }
  const name = cut < 0 ? value : value.slice(0, cut)
  const mod = cut < 0 ? 1 : twOpacity(value.slice(cut + 1), token)
  let col
  const tok = name.match(/^\[color:var\((--[\w-]+)\)\]$/)
  if (tok) col = parseColor(rootToken(tok[1]))
  else if (/^\[(#[0-9a-fA-F]{3,8}|rgba?\([^\]]*\))\]$/.test(name)) col = parseColor(name.slice(1, -1).replace(/_/g, ' '))
  else {
    const t = themeColor(name)
    if (!t || !/^#[0-9a-fA-F]{3,8}$/.test(t)) throw new Error(`audit: ${token} is not a colour this audit can resolve${t ? ` (${t})` : ''}`)
    col = parseColor(t)
  }
  return { rgb: col.rgb, a: col.a * mod }
}

/** A CSS length in px at this frame: rem/px/vw/vh, and min()/max()/clamp() of them. */
function cssLengthPx(expr) {
  const s = expr.trim()
  const unit = s.match(/^([\d.]+)(rem|px|vw|vh)$/)
  if (unit) return Number(unit[1]) * { rem: 16, px: 1, vw: VIEWPORT_W / 100, vh: VIEWPORT_H / 100 }[unit[2]]
  const fn = s.match(/^(min|max|clamp)\(([\s\S]*)\)$/)
  if (fn) {
    const args = []
    let depth = 0, start = 0
    for (let i = 0; i < fn[2].length; i++) {
      if (fn[2][i] === '(') depth++
      else if (fn[2][i] === ')') depth--
      else if (fn[2][i] === ',' && depth === 0) { args.push(fn[2].slice(start, i)); start = i + 1 }
    }
    const px = [...args, fn[2].slice(start)].map(cssLengthPx)
    if (fn[1] === 'min') return Math.min(...px)
    if (fn[1] === 'max') return Math.max(...px)
    if (px.length !== 3) throw new Error(`audit: clamp() needs three arguments: ${s}`)
    return Math.max(px[0], Math.min(px[1], px[2]))
  }
  throw new Error(`audit: cannot evaluate the length ${s} — the audit is out of date, not passing`)
}

/** The display scale (`type-hero` …): index.css's rule, through its token. */
function typeScalePx(name) {
  const rule = css.match(new RegExp(String.raw`\n\s*\.type-${name}\s*\{([^}]*)\}`))
  if (!rule) throw new Error(`audit: .type-${name} not found in ${SRC_CSS} — the audit is out of date, not passing`)
  const v = rule[1].match(/font-size:\s*([^;]+);/)?.[1].trim()
  if (!v) throw new Error(`audit: .type-${name} no longer sets font-size`)
  const tok = v.match(/^var\((--[\w-]+)\)$/)
  return cssLengthPx(tok ? rootToken(tok[1]) : v)
}

const NON_COLOUR_TEXT = /^(left|center|right|justify|start|end|ellipsis|clip|wrap|nowrap|balance|pretty)$/
const NON_COLOUR_BG = /^(none|auto|cover|contain|fixed|local|scroll|repeat|no-repeat|repeat-[xy]|repeat-round|repeat-space|bottom|center|top|left|right|left-bottom|left-top|right-bottom|right-top|(clip|origin|blend)-.+)$/

/** Which property a utility sets, as { key, value }, or null for one this audit
 *  does not read. A `text-*` or `bg-*` it cannot place dies rather than being
 *  skipped: skipped, a colour would silently fall back to an inherited one. */
function classify(util) {
  let m
  if ((m = util.match(/^opacity-(.+)$/))) return { key: 'opacity', value: twOpacity(m[1], util) }
  if ((m = util.match(/^font-(\w+)$/)) && m[1] in THEME.fontWeight) return { key: 'weight', value: Number(THEME.fontWeight[m[1]]) }
  if ((m = util.match(/^type-([\w-]+)$/))) return { key: 'size', value: typeScalePx(m[1]) }
  if ((m = util.match(/^bg-(.+)$/))) {
    if (NON_COLOUR_BG.test(m[1])) return null
    if (/^gradient-/.test(m[1])) return { key: 'fill', value: 'gradient' }
    return { key: 'fill', value: twColor(m[1], util) }
  }
  if (!(m = util.match(/^text-(.+)$/))) return null
  const v = m[1]
  if (NON_COLOUR_TEXT.test(v)) return null
  const len = v.match(/^\[(?:length:)?([\d.]+)(px|rem)\]$/)
  if (len) return { key: 'size', value: Number(len[1]) * (len[2] === 'rem' ? 16 : 1) }
  // `text-sm` and `text-sm/6` (a line-height modifier) are sizes.
  const size = v.split('/')[0]
  if (size in THEME.fontSize) {
    const s = THEME.fontSize[size]
    return { key: 'size', value: cssLengthPx(Array.isArray(s) ? s[0] : s) }
  }
  return { key: 'color', value: twColor(v, util) }
}

/** What `classes` set at rest at VIEWPORT_W: { color, size, weight, opacity,
 *  fill }, each from the one class that wins. An interaction variant (hover:,
 *  focus: …) is not at rest. A breakpoint applies once VIEWPORT_W reaches it, and
 *  the widest that applies wins, as Tailwind orders its media queries. Anything
 *  else this cannot place dies: a `max-*` breakpoint that applies, any other
 *  variant, an `!important` class, or two classes for one property at one
 *  breakpoint (CSS order decides those, not class order). */
function resting(classes) {
  const won = {}
  for (const token of classes.split(/\s+/).filter(Boolean)) {
    const [variants, raw] = splitVariants(token)
    const important = raw.startsWith('!')
    const prop = classify(important ? raw.slice(1) : raw)
    if (!prop) continue
    if (important) throw new Error(`audit: ${token} is !important; this audit does not model it`)
    let rank = 0, atRest = true
    for (const v of variants) {
      if (INTERACTION.has(v)) { atRest = false; continue }
      if (v in SCREENS) { if (VIEWPORT_W >= SCREENS[v]) rank = Math.max(rank, SCREENS[v]); else atRest = false; continue }
      const max = v.match(/^max-(\w+)$/)
      if (max && max[1] in SCREENS) {
        if (VIEWPORT_W < SCREENS[max[1]]) throw new Error(`audit: ${token} applies at ${VIEWPORT_W}px; this audit does not model max-* breakpoints`)
        atRest = false; continue
      }
      throw new Error(`audit: ${token}: this audit cannot tell whether the ${v}: variant applies at rest`)
    }
    if (!atRest) continue
    const prev = won[prop.key]
    if (prev && prev.rank === rank) throw new Error(`audit: ${prev.token} and ${token} both set ${prop.key} at one breakpoint; CSS order decides which wins, not class order`)
    if (!prev || rank > prev.rank) won[prop.key] = { ...prop, rank, token }
  }
  return Object.fromEntries(Object.entries(won).map(([k, v]) => [k, v.value]))
}

/** A text surface: colour, alpha, size, weight and fill from the element
 *  holding `anchor`, with `parent` (an anchor for the element it inherits from)
 *  filling in what it does not set itself. One parent at most: an element that
 *  sets no colour or size, and names no parent that does, dies rather than
 *  being given a default. An unset weight is read as normal, the stricter
 *  threshold. Opacity composes down the tree, so both elements' multiply. */
function text(anchor, parent) {
  const own = classesOf(anchor)
  const r = resting(own.classes)
  const p = parent ? resting(classesOf(parent).classes) : {}
  const color = r.color ?? p.color
  const px = r.size ?? p.size
  if (!color) throw new Error(`audit: the element anchored by "${anchor}" sets no text colour${parent ? ', nor does its named parent' : ''} — the audit is out of date, not passing`)
  if (px === undefined) throw new Error(`audit: the element anchored by "${anchor}" sets no font size${parent ? ', nor does its named parent' : ''} — the audit is out of date, not passing`)
  const fills = [p.fill, r.fill].filter(Boolean)
  if (fills.includes('gradient')) throw new Error(`audit: the element anchored by "${anchor}" has a gradient fill; this audit models flat fills only`)
  const opacity = (r.opacity ?? 1) * (p.opacity ?? 1)
  if (opacity < 1 && fills.length) throw new Error(`audit: the element anchored by "${anchor}" has a fill under opacity < 1; this audit does not model group opacity`)
  return { file: `HeroSection.tsx:${own.line}`, color: color.rgb, alpha: color.a * opacity, px,
    bold: (r.weight ?? p.weight ?? 400) >= 700, fills }
}

/** A non-text stroke, from an SVG element's own `stroke="…"`. */
function stroke(anchor) {
  const { tag, line } = tagAt(anchor)
  if (/\s(?:opacity|strokeOpacity|className|style)=/.test(tag)) throw new Error(`audit: the element anchored by "${anchor}" now carries opacity or classes; model them`)
  const m = tag.match(/\sstroke="([^"]+)"/)
  if (!m) throw new Error(`audit: the element anchored by "${anchor}" has no literal stroke`)
  const c = parseColor(m[1])
  return { file: `HeroSection.tsx:${line}`, color: c.rgb, alpha: c.a, px: 0, nonText: true }
}

const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const Y = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const over = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i])
const ratio = (a, b) => {
  const [l1, l2] = [Y(a), Y(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
/** #rgb, #rrggbb and #rrggbbaa (theme white is `#fff`). */
function hex(h) {
  const s = h.replace('#', '')
  if (s.length === 3) return [...s].map(c => parseInt(c + c, 16) / 255)
  if (s.length === 6 || s.length === 8) return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255)
  throw new Error(`audit: cannot parse hex colour #${s}`)
}
const W = [1, 1, 1], K = [0, 0, 0]
const INK = hex('#050505')

// Interpolate a stop list [[position 0..1, alpha], ...] at t.
const rampA = (stops, t) => {
  if (t <= stops[0][0]) return stops[0][1]
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, a0] = stops[i], [p1, a1] = stops[i + 1]
    if (t >= p0 && t <= p1) return a0 + (a1 - a0) * ((t - p0) / (p1 - p0))
  }
  return stops[stops.length - 1][1]
}

// ── the hero's THREE scrim layers, transcribed from source ────────────────
// The first version of this file modelled only two and therefore reported a
// failure that did not exist (the match numeral at "2.16:1" — really 6.01:1).
// A partial layer model is worse than none: it produces confident wrong numbers.
// .stage-hero-scrim, in index.css — first layer listed paints ON TOP.
const scrim = cssValue('.stage-hero-scrim', 'background')
const HERO = {
  // linear-gradient(90deg, ...) → 0% is the LEFT edge. Layer 0 = painted on top.
  horiz: parseLinearStops(scrim, 0),
  // linear-gradient(0deg, ...) → 0% is the BOTTOM edge.
  vert: parseLinearStops(scrim, 1),
}
// The third layer is an INLINE style on its own div in HeroSection.tsx — which
// is why a grep of index.css never found it:
//   radial-gradient(ellipse 42% 48% at 100% 0%, rgba(5,5,5,0.72), transparent 70%)
// It predates Phase 8 and exists for exactly this widget; its own comment says
// so ("on a backdrop that's bright in this corner … the white score number +
// ring vanished"). Radii are 42% of width and 48% of height, centred on the
// TOP-RIGHT corner, ramping to transparent at 70% along the ray.
const cornerDecl = hero.match(/radial-gradient\(ellipse ([\d.]+)% ([\d.]+)% at 100% 0%,\s*rgba\(([^)]*)\),\s*transparent ([\d.]+)%\)/)
if (!cornerDecl) throw new Error(`audit: the top-right corner vignette is no longer in ${SRC_HERO} in the expected form`)
const CORNER = {
  rx: Number(cornerDecl[1]) / 100,
  ry: Number(cornerDecl[2]) / 100,
  a0: Number(cornerDecl[3].split(',')[3]),
  end: Number(cornerDecl[4]) / 100,
}
// The fourth layer: .stage-hero-scrim::before, the top feather (Stage refresh
// H1). A fixed-px band, so its alpha at a fractional y depends on the hero's
// real height — read from the hero's own height utilities at the 1440x900 frame
// the coordinates below were taken at (VIEWPORT_H), not assumed.
const FEATHER = (() => {
  const bg = cssValue('.stage-hero-scrim::before', 'background')
  if (!/linear-gradient\(180deg/.test(bg)) throw new Error('audit: the hero top feather is no longer a top-down (180deg) linear-gradient')
  const h = cssValue('.stage-hero-scrim::before', 'height').match(/^([\d.]+)px$/)
  if (!h) throw new Error('audit: the hero top feather height is no longer a px length')
  const sizes = hero.match(/'relative w-full h-\[(\d+)vh\] min-h-\[(\d+)px\] max-h-\[(\d+)px\]/)
  if (!sizes) throw new Error(`audit: the full hero's h-[Nvh] min-h-[px] max-h-[px] sizing is no longer in ${SRC_HERO}`)
  const heroPx = Math.min(Number(sizes[3]), Math.max(Number(sizes[2]), (Number(sizes[1]) / 100) * VIEWPORT_H))
  // `transparent 100%` has no rgba, so the last stop is parsed as alpha 0.
  return { stops: parseLinearStops(bg, 0), px: Number(h[1]), heroPx }
})()
function featherAlpha(yFromBottom) {
  const fromTop = (1 - yFromBottom) * FEATHER.heroPx
  return fromTop >= FEATHER.px ? 0 : rampA(FEATHER.stops, fromTop / FEATHER.px)
}

function cornerAlpha(x, yFromBottom) {
  const dx = (1 - x) / CORNER.rx
  const dy = (1 - yFromBottom) / CORNER.ry
  const d = Math.hypot(dx, dy)
  if (d >= CORNER.end) return 0
  return CORNER.a0 * (1 - d / CORNER.end)
}

/** Composite all four scrim layers at (x from left, y from bottom) over `frame`,
 *  in paint order: artwork, vertical ramp, horizontal ramp, top feather (the
 *  scrim's own ::before, so above both of its layers), corner vignette. */
function heroBackdrop(x, yFromBottom, frame) {
  let bg = over(INK, rampA(HERO.vert, yFromBottom), frame)
  bg = over(INK, rampA(HERO.horiz, x), bg)
  bg = over(INK, featherAlpha(yFromBottom), bg)
  return over(INK, cornerAlpha(x, yFromBottom), bg)
}

const VEIL = (() => {
  const v = cssValue('.stage-hero-match-veil', 'background')
  const m = v.match(/rgba\(([^)]*)\)/)
  if (!m) throw new Error('audit: .stage-hero-match-veil no longer uses an rgba plateau')
  return Number(m[1].split(',')[3])
})()

// Known answers for the class reader, run every time: a reader that quietly
// misread a class (a hover alpha taken as the resting one, a breakpoint that
// does not apply at this width) would report a wrong figure and pass, which is
// the defect this file's header records twice.
{
  const near = (a, b) => Math.abs(a - b) < 1e-9
  const PROBE = [
    ['hover:text-white/95 text-white/25', r => near(r.color.a, 0.25)],
    ['text-white/70 md:text-white/40 max-sm:text-white/10 2xl:text-white/20', r => near(r.color.a, 0.40)],
    ['text-purple-100/85', r => near(r.color.a, 0.85) && r.color.rgb.every((c, i) => near(c, hex('#f3e8ff')[i]))],
    ['text-white/[0.42]', r => near(r.color.a, 0.42)],
    ['text-sm md:text-base 2xl:text-xs', r => r.size === 16],
    ['text-4xl xl:text-[10px] text-center', r => r.size === 10],
    ['font-semibold', r => r.weight === 600],
    ['opacity-60 bg-white/[0.04] hover:bg-purple-500/10', r => near(r.opacity, 0.6) && near(r.fill.a, 0.04)],
  ]
  const DIES = ['text-white/97', 'text-white/70 text-white/50', 'md:!text-white', 'max-2xl:text-white/40',
    'aria-selected:text-white/40', 'text-current', 'text-[color:var(--no-such-token)]']
  const wrong = []
  for (const [classes, ok] of PROBE) {
    let r
    try { r = resting(classes) } catch (e) { wrong.push(`${classes} died: ${e.message}`); continue }
    if (!ok(r)) wrong.push(`${classes} read as ${JSON.stringify(r)}`)
  }
  for (const classes of DIES) {
    try { resting(classes); wrong.push(`${classes} should die and did not`) } catch { /* expected */ }
  }
  if (wrong.length) throw new Error(`audit: the class reader's known answers changed — the audit is out of date, not passing:\n  ${wrong.join('\n  ')}`)
}

// ── the surfaces, with where they actually sit ────────────────────────────
// Each surface's colour, alpha, size, weight and fill come from its own element
// (`text()`), found by an anchor that must occur exactly once in the hero's code;
// the line reported is that element's, or for a title its className branch's.
// x/y are fractions (x from
// the left edge, y from the BOTTOM edge), read off the hero's own layout: the
// text column starts at --page-gutter (~3% at 1440px) and the stack runs title →
// meta → description → buttons up from the lower third. They are the one part
// typed in, and moving an element does not move them.
const SURFACES = [
  // lg:type-hero extrabold → large text, 3:1
  { what: 'hero title', ...text('lg:type-hero'), x: 0.03, y: 0.40 },
  // the browse variant, md:type-browse extrabold → large text
  { what: 'browse hero title', ...text('md:type-browse'), x: 0.03, y: 0.40 },
  // description, 16px at md+ → normal text, 4.5:1
  { what: 'hero description', ...text('desc-${hero.id}'), x: 0.03, y: 0.27 },
  // The compact band's "Featured: X — N titles" line. Every glyph on it is in a
  // child span with its own colour; the line's own colour paints only the
  // ellipsis line-clamp-1 adds when the line is cut short (Chromium draws that
  // in the block's colour, not the last span's), so it is measured for that.
  { what: 'meta line (its clamp ellipsis)', ...text('featured-${hero.id}'), x: 0.03, y: 0.33 },
  // the spans INSIDE that line, which take its size
  { what: 'meta label span ("Featured: ")', ...text('>Featured: <', 'featured-${hero.id}'), x: 0.03, y: 0.33 },
  { what: 'meta title span', ...text('>{hero.title}</span>', 'featured-${hero.id}'), x: 0.03, y: 0.33 },
  { what: 'meta count span (" — N titles")', ...text('{countLabel}</span>', 'featured-${hero.id}'), x: 0.03, y: 0.33 },
  // the AI reason, 14px italic
  { what: 'AI reason', ...text('reason-${hero.id}'), x: 0.03, y: 0.47 },
  // the cold-start hint, in the same slot when there is no reason, 12px italic
  { what: 'cold-start hint', ...text('to unlock personalized picks'), x: 0.03, y: 0.47 },
  // genre/year line, 14px
  { what: 'genre / year line', ...text('genre-${hero.id}'), x: 0.03, y: 0.52 },
  // The "MATCH" / "SCORE" eyebrow and the percentage numeral. RIGHT
  // side of the hero, near the top, where the horizontal ramp is at its WEAKEST
  // (0.15 at 72%, 0.35 at 100%). Both sit over .stage-hero-match-veil, the local
  // backing Phase 8 added precisely because this corner has no scrim worth the
  // name — without it the eyebrow measured 1.22:1 and the numeral 2.16:1.
  // Geometry derived from `absolute top-11 right-[52px]` + an 84px ring + a
  // gap-1.5 + a 10px caption at 1440x900, not estimated: the earlier x:0.95,
  // y:0.72 was off by 0.12-0.18 on y. It happened not to change any verdict
  // (the vertical ramp is already 0 above y=0.55) but a sample point that is
  // wrong for a reason you have not checked is a coin flip, not a measurement.
  { what: 'MATCH/SCORE eyebrow', ...text("{showingPersonal ? 'Match' : 'Score'}"), x: 0.935, y: 0.844, veil: VEIL },
  { what: 'match numeral "NN%"', ...text('{matchScore}%'), x: 0.935, y: 0.904, veil: VEIL },
  { what: 'ring track vs backdrop', ...stroke('stroke="rgba('), x: 0.935, y: 0.904, veil: VEIL,
    // Redundant encoding — see the note at the call site. The arc's purple end
    // cannot clear 3:1 against any track that itself clears 3:1 above the
    // backdrop; the value is carried by the numeral above and by the wrapper's
    // aria-label. Tracked here so it stays visible, not asserted.
    advisory: true },
  // "Not tonight" control, bottom-right. The label is a span that takes its
  // colour, size and fill from the button. Its 0.06 border is deliberately
  // NOT audited as a 1.4.11 surface: the control is identified by a permanent
  // visible text label, so the border is decoration. See the call site.
  // y from the pb-9 bottom bar's real centre (~57px up), not the 0.15 first
  // guessed — at which this measured 4.42:1 and looked like a failure. It was
  // not one: at its actual position `text-white/60` was already 6.56:1. The
  // /60 -> /75 change is harmless and mildly beneficial, but it was made on a
  // bad number and this comment says so rather than keeping the credit.
  { what: '"Not tonight" label', ...text('>Not tonight<', 'onClick={onNextPick}'), x: 0.93, y: 0.063 },
]

const need = s => (s.nonText ? 3.0 : (s.px >= 24 || (s.px >= 18.66 && s.bold)) ? 3.0 : 4.5)

/** The backdrop a surface actually sits on: scrim, then any local veil, then any
 *  translucent fills of its own element and its named parent. */
function backdropFor(s, frame) {
  let bg = heroBackdrop(s.x, s.y, frame)
  // The veil sits UNDER these surfaces — which is only true since the eyebrow
  // was given `relative`. Before that the veil painted over it (CSS 2.1 App. E
  // step 6 vs step 5) and the honest figure for the eyebrow was 1.35:1, not the
  // 6.94:1 this function reported. Modelling a layer on the wrong side of the
  // text is the same class of error as omitting one.
  if (s.veil) bg = over(INK, s.veil, bg)
  for (const f of s.fills ?? []) bg = over(f.rgb, f.a, bg)
  return bg
}

let fails = 0, advisories = 0
const LABEL_W = Math.max(46, ...SURFACES.map(s => `${s.what} (${s.file})`.length + 1))
console.log(`${'surface'.padEnd(LABEL_W)}px  need   black-frame  white-frame  verdict`)
console.log('-'.repeat(LABEL_W + 54))
for (const s of SURFACES) {
  const rk = (() => { const bg = backdropFor(s, K); return ratio(over(s.color, s.alpha, bg), bg) })()
  const rw = (() => { const bg = backdropFor(s, W); return ratio(over(s.color, s.alpha, bg), bg) })()
  const worst = Math.min(rk, rw)
  const req = need(s)
  const ok = worst >= req
  if (!ok) { if (s.advisory) advisories++; else fails++ }
  const label = `${s.what} (${s.file})`.padEnd(LABEL_W)
  const verdict = ok ? 'PASS' : (s.advisory ? 'advisory (see note)' : '*** FAIL ***')
  console.log(`${label}${String(s.px).padStart(3)} ${req.toFixed(1).padStart(5)}   ${rk.toFixed(2).padStart(10)}  ${rw.toFixed(2).padStart(11)}  ${verdict}`)
}
console.log('-'.repeat(LABEL_W + 54))
console.log(`${fails} surface(s) below threshold at their worst frame; ${advisories} advisory.`)
process.exit(fails ? 1 : 0)
