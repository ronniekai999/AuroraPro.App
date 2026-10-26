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
// Now each surface's colour, alpha, size, weight and fill are read from the
// classes of its element, or of the element it inherits them from (`text()`
// below); whether it sits over the match veil is read from the tree; every
// element enclosing it up to the hero's root is checked for opacity, fills,
// z-index and anything else this audit does not model; the root's own layers,
// the scrim, glow and vignette composited beneath the text, are pinned in their
// paint order and their strength, with the index.css rules their values come
// from, their gradients' directions and the veil's shape (LAYERS,
// PINNED_RULES); every other element in the text's two layers must have
// classes this audit can read, dies if it leaves the flow unless listed
// (OVERLAP_OK), and has its box-shadow glow measured into every surface it can
// reach (GLOWS). The run fails if a value it depends on has moved or cannot be
// read. NOT derived: each surface's sample point (x, y), measured by hand at
// the 1440x900 frame its classes are resolved at, and the list of surfaces
// itself, so text HeroSection gains is measured only once it is listed. Not
// read at all: anything above the hero's root, rules in index.css that select
// by element rather than class, what a component renders, SVG geometry, other
// widths, and interaction states (hover, focus, active).

const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(import.meta.dirname, '..')
const THEME = require('tailwindcss/resolveConfig')(require('tailwindcss/loadConfig')(path.join(APP_DIR, 'tailwind.config.js'))).theme
const ts = require('typescript')
const postcss = require('postcss')
const selparser = require('postcss-selector-parser')

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
const heroRaw = fs.readFileSync(SRC_HERO, 'utf8')
const hero = codeOnly(heroRaw)

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
  if (stops.some((s, i) => i > 0 && s[0] < stops[i - 1][0])) throw new Error('audit: a hero scrim layer lists its stops out of order; model it')
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
// Variants that hold only while someone interacts, so never at rest. Not
// `disabled:` or `visited:`: those states persist, so a class under them can be
// what shows at rest, and they die below like any other variant.
const INTERACTION = new Set(['hover', 'focus', 'focus-visible', 'focus-within', 'active',
  'group-hover', 'group-focus', 'group-focus-within', 'peer-hover', 'peer-focus'])

// Utilities that cannot change a text's colour, alpha, size or weight, or
// paint behind it: layout, spacing, borders, transitions, transforms, the
// `group`/`peer` markers, and text and drop shadows, which this audit never
// credits. A transform does change the paint order (it paints the element as
// a positioned one would), which `veilUnder` counts on, and that matters only
// against the veil. Not `z-*` (classified below), `order-*` (a flex item's
// order is its paint order; `order-first` put the eyebrow under the veil in
// Chromium) or `ring-*` (an inset ring is a box-shadow painted behind the
// text). A class neither classified nor matched here dies unless index.css
// defines it, and then its rules are checked (`checkCssRules`). Skipped
// instead, `[color:…]` beside `text-white/75` painted 0.3 while the audit read
// 0.75.
const INERT = new RegExp('^(?:' + [
  String.raw`-?(?:m[xytrblse]?|p[xytrblse]?|gap(?:-[xy])?|space-[xy]|w|h|size|min-w|min-h|max-w|max-h|inset(?:-[xy])?|top|right|bottom|left|start|end|basis|translate-[xy]|rotate|scale(?:-[xy])?)-.+`,
  'block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents|hidden|isolate|group|peer|antialiased|subpixel-antialiased',
  'flex-.+|grow(?:-.+)?|shrink(?:-.+)?|items-.+|justify-.+|content-.+|self-.+|place-.+',
  'overflow-.+|whitespace-.+|break-.+|truncate|line-clamp-.+|sr-only|not-sr-only',
  'italic|not-italic|uppercase|lowercase|capitalize|normal-case|tracking-.+|leading-.+|underline|no-underline',
  'rounded(?:-.+)?|border(?:-.+)?|outline(?:-.+)?',
  'transition(?:-.+)?|duration-.+|ease-.+|delay-.+|cursor-.+|pointer-events-.+|select-.+|align-.+|aspect-.+|object-.+',
  String.raw`drop-shadow(?:-(?:sm|md|lg|xl|2xl|none))?|font-(?:sans|serif|mono)`,
].join('|') + ')$')
// The theme's drop shadows are black. An arbitrary one, or an arbitrary
// text-shadow, is INERT only while every colour in it is black (`darkShadow`):
// `[text-shadow:0_0_20px_white]` puts a light halo round the glyphs.
const inertShadow = util => {
  const m = util.match(/^(?:\[text-shadow:(.+)\]|drop-shadow-\[(.+)\])$/)
  return !!m && darkShadow((m[1] ?? m[2]).replace(/_/g, ' '))
}

// Declarations index.css may give a class on a surface or on an element
// enclosing one without changing what the surface is measured on: layout,
// spacing, borders, type metrics, transitions, an animation's delay, shadows.
// Anything else dies unless the class's classification models it (MODELS):
// colour, opacity, size, weight, fills, filters, masks, clip paths, blend
// modes, z-index, position, transforms, and custom properties, since
// `text-white` paints `rgb(255 255 255 / var(--tw-text-opacity, 1))`. An
// allowlist, not a list of the dangerous: a review found a list of those
// missing mask-image, custom properties and infinite animations.
const SAFE = new RegExp('^(?:' + [
  'font-family|line-height|letter-spacing|word-spacing|text-transform|text-align|text-wrap|white-space|text-overflow',
  'display|overflow(?:-[xy])?|-webkit-line-clamp|-webkit-box-orient|cursor|pointer-events|user-select',
  '(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|(?:min-|max-)?(?:width|height)',
  'gap|row-gap|column-gap|flex(?:-(?:grow|shrink|basis|direction|wrap))?|align-(?:items|self|content)|justify-(?:content|items|self)',
  'border(?:-.+)?|outline(?:-.+)?|transition(?:-.+)?|animation-(?:delay|duration|timing-function|name)',
].join('|') + ')$')
// What each classified property already accounts for.
const MODELS = { color: ['color'], size: ['font-size'], weight: ['font-weight'], opacity: ['opacity'],
  fill: ['background', 'background-color', 'background-image'], position: ['position'], z: ['z-index'] }

/** index.css rules that can style an element carrying a class, by class name,
 *  each as { rule, pseudo }: every rule naming `.cls` in a selector, including
 *  inside :is(), :where() or :has(), unless its compound holds only under
 *  interaction (`:hover`). A rule for a pseudo-element of the class carries its
 *  name (`before`), since one with content paints a box of its own. A class used
 *  as an ancestor (`.cls p`) or inside :not() counts too, failing closed. */
const CSS_RULES = (() => {
  const map = new Map()
  const interaction = /^:(hover|focus|focus-visible|focus-within|active)$/
  postcss.parse(css).walkRules(rule => {
    for (const sel of rule.selectors) {
      selparser(root => root.walkClasses(c => {
        const nodes = c.parent.nodes
        let a = nodes.indexOf(c), b = a
        while (a > 0 && nodes[a - 1].type !== 'combinator') a--
        while (b < nodes.length - 1 && nodes[b + 1].type !== 'combinator') b++
        const compound = nodes.slice(a, b + 1)
        if (compound.some(n => n.type === 'pseudo' && interaction.test(n.value))) return
        const pe = compound.find(n => n.type === 'pseudo' && /^(::|:before$|:after$|:first-line$|:first-letter$)/.test(n.value))
        map.set(c.value, [...(map.get(c.value) ?? []), { rule, pseudo: pe ? pe.value.replace(/^:+/, '') : null }])
      })).processSync(sel)
    }
  })
  return map
})()

/** Dies when index.css gives `cls` a declaration this audit does not model:
 *  one not SAFE and not covered by its classification (`allowed`). Of the
 *  rest, `opacity: 1` and `transform: none` change nothing, and an animation
 *  must neither hold its end state (`forwards`, `both`: the last keyframe is
 *  then the resting style) nor run for ever. A rule for its ::before or
 *  ::after that sets content paints a box this audit does not model. */
function checkCssRules(cls, token, allowed = []) {
  for (const { rule, pseudo } of CSS_RULES.get(cls) ?? []) {
    const refuse = (d, why = 'which this audit does not model') => {
      throw new Error(`audit: ${token}: index.css (${rule.selector}) sets ${d.prop}: ${d.value}, ${why} — the audit is out of date, not passing`)
    }
    // A plain loop, not walkDecls: an error thrown inside a postcss walk carries
    // the node graph, and Node prints all of it (a review measured 147 KB).
    for (const d of declsOf(rule)) {
      const prop = d.prop.toLowerCase(), v = d.value.trim()
      if (pseudo) {
        if (/^(before|after)$/.test(pseudo) && prop === 'content' && !/^(none|normal)$/.test(v)) refuse(d, `so its ::${pseudo} paints a box this audit does not model`)
        if (/^first-(line|letter)$/.test(pseudo) && !SAFE.test(prop)) refuse(d)
        continue
      }
      if (prop === 'animation' || prop === 'animation-fill-mode' || prop === 'animation-iteration-count') {
        if (/\b(forwards|both|infinite)\b/.test(v)) refuse(d, 'so it holds or never leaves a keyframe')
        continue
      }
      if (prop === 'text-shadow') { if (v !== 'none' && !darkShadow(v)) refuse(d, 'a light or coloured shadow this audit does not model'); continue }
      if (allowed.includes(prop) || SAFE.test(prop) || (prop === 'opacity' && Number(v) === 1) || (prop === 'transform' && v === 'none')) continue
      refuse(d)
    }
  }
}

/** Whether a resolved z value restacks anything: `z-auto` is the default. */
const stacks = z => z !== undefined && z !== 'auto'

/** A rule's own declarations. Anything else inside it dies: an `@apply` is
 *  compiled into declarations this audit would not see (a review dimmed the
 *  scrim with `@apply opacity-40`), and so would a nested rule. */
function declsOf(rule) {
  const other = (rule.nodes ?? []).find(n => n.type !== 'decl' && n.type !== 'comment')
  if (other) throw new Error(`audit: index.css's ${rule.selector} holds ${other.type === 'atrule' ? `@${other.name} ${other.params}` : `a nested ${other.type}`}; this audit reads plain declarations only — the audit is out of date, not passing`)
  return (rule.nodes ?? []).filter(n => n.type === 'decl')
}

/** Whether every colour in a shadow value is black at some alpha. A dark
 *  shadow only darkens what is under it, which cannot lower the contrast of
 *  this hero's light text; a light or coloured one can. */
function darkShadow(value) {
  const cols = value.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|\b(?:white|black|transparent)\b/g) ?? []
  return cols.length > 0 && cols.every(c => c === 'black' || c === 'transparent' || (c !== 'white' && parseColor(c).rgb.every(v => v === 0)))
}

// The hero, parsed. Elements are found in the tree rather than by scanning the
// text back to a `<`, which a comparison inside an expression also satisfies.
const HERO_SF = ts.createSourceFile(SRC_HERO, heroRaw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
// The parser recovers from errors, so a file that does not parse still yields a
// tree, just not the one the browser gets. Refuse it.
if (HERO_SF.parseDiagnostics?.length) {
  const d = HERO_SF.parseDiagnostics[0]
  throw new Error(`audit: ${SRC_HERO}:${HERO_SF.getLineAndCharacterOfPosition(d.start).line + 1} does not parse (${ts.flattenDiagnosticMessageText(d.messageText, ' ')})`)
}
const lineOf = pos => HERO_SF.getLineAndCharacterOfPosition(pos).line + 1
const openingOf = el => (ts.isJsxElement(el) ? el.openingElement : el)
const tagName = el => openingOf(el).tagName.getText(HERO_SF)
const where = el => `<${tagName(el)}> at ${SRC_HERO}:${lineOf(openingOf(el).getStart(HERO_SF))}`

/** The JSX element `anchor` names — the one whose opening tag holds it, or
 *  whose direct text or {expression} child does — and the anchor's position.
 *  The anchor must occur exactly once in the hero's code: one that occurs
 *  twice silently measures whichever comes first. */
function elementAt(anchor) {
  const i = hero.indexOf(anchor)
  if (i < 0) throw new Error(`audit: anchor not found in ${SRC_HERO}: ${anchor} — the audit is out of date, not passing`)
  if (hero.indexOf(anchor, i + 1) >= 0) throw new Error(`audit: anchor "${anchor}" is not unique in ${SRC_HERO} — it cannot identify one element`)
  let node = HERO_SF
  for (let next; (next = node.getChildren(HERO_SF).find(c => c.getStart(HERO_SF) <= i && i < c.end));) node = next
  for (let n = node; n; n = n.parent) {
    if (ts.isJsxOpeningElement(n)) return { el: n.parent, pos: i }
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxElement(n)) return { el: n, pos: i }
  }
  throw new Error(`audit: anchor "${anchor}" is not in a JSX element in ${SRC_HERO}`)
}

/** An element's attributes by name. A spread could set anything, so it dies. */
function attrsOf(el) {
  const out = new Map()
  for (const a of openingOf(el).attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) throw new Error(`audit: ${where(el)} spreads props; this audit cannot read them`)
    out.set(a.name.getText(HERO_SF), a.initializer)
  }
  return out
}

/** The className literals of `el`, each { text, from, to }: one for a string,
 *  two for `cond ? 'A' : 'B'` (the hero titles, the <section>), none without a
 *  className. Anything else — a template with `${…}`, a cn() call — dies:
 *  classes built at runtime cannot be read here. */
function classBranches(el) {
  const init = attrsOf(el).get('className')
  if (init === undefined) return []
  const bare = n => { while (n && ts.isParenthesizedExpression(n)) n = n.expression; return n }
  const lit = n => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    ? { text: n.text, from: n.getStart(HERO_SF), to: n.end } : null)
  const e = bare(ts.isJsxExpression(init) ? init.expression : init)
  if (lit(e)) return [lit(e)]
  if (e && ts.isConditionalExpression(e) && lit(bare(e.whenTrue)) && lit(bare(e.whenFalse))) return [lit(bare(e.whenTrue)), lit(bare(e.whenFalse))]
  throw new Error(`audit: the className of ${where(el)} is built at runtime; this audit cannot read it`)
}

/** The class list a surface's own element paints with, and the line to report:
 *  for a two-branch className (the hero titles) the branch the anchor sits in,
 *  so anchor those inside the literal. An inline style dies: this audit reads
 *  classes, and a `style={{ opacity: 0.3 }}` would otherwise pass unseen. */
function classesOf({ el, pos }) {
  if (attrsOf(el).has('style')) throw new Error(`audit: ${where(el)} carries an inline style; this audit reads classes only — model it`)
  const branches = classBranches(el)
  if (branches.length <= 1) return { classes: branches[0]?.text ?? '', line: lineOf(openingOf(el).getStart(HERO_SF)) }
  const hit = branches.find(b => pos >= b.from && pos < b.to)
  if (!hit) throw new Error(`audit: ${where(el)} has a two-branch className; anchor it inside the branch measured`)
  return { classes: hit.text, line: lineOf(hit.from) }
}

/** The hero's root: the element carrying `ref={sectionRef}`, which owns the
 *  parallax and the rotation pause. Not "the first <section> up the tree": a
 *  <section> wrapped around the text column would be taken for it, and its
 *  fill let through. */
const HERO_ROOT = (() => {
  const found = []
  const visit = n => {
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && openingOf(n).attributes.properties.some(a =>
      ts.isJsxAttribute(a) && a.name.getText(HERO_SF) === 'ref' && a.initializer?.getText(HERO_SF) === '{sectionRef}')) found.push(n)
    ts.forEachChild(n, visit)
  }
  visit(HERO_SF)
  if (found.length !== 1 || !ts.isJsxElement(found[0])) throw new Error(`audit: ${SRC_HERO} has ${found.length} elements with ref={sectionRef}; this audit needs exactly one hero root — the audit is out of date, not passing`)
  return found[0]
})()

/** The JSX elements enclosing `el`, nearest first, up to and including the
 *  hero's root. */
function ancestorsOf(el) {
  const out = []
  for (let n = el.parent; n; n = n.parent) {
    if (!ts.isJsxElement(n)) continue
    out.push(n)
    if (n === HERO_ROOT) return out
  }
  throw new Error(`audit: ${where(el)} is not inside the hero's root (ref={sectionRef})`)
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
  if (/^(static|relative|absolute|fixed|sticky)$/.test(util)) return { key: 'position', value: util }
  if ((m = util.match(/^(-?)z-(.+)$/))) return { key: 'z', value: m[1] + m[2] }
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

/** Whether a class with these variants applies at rest at VIEWPORT_W, the
 *  breakpoint it applies from (`rank`), and why it cannot be placed when that
 *  is unknown (`unplaced`). */
function variantState(variants) {
  let rank = 0, applies = true, unplaced = null
  for (const v of variants) {
    const max = v.match(/^max-(\w+)$/)
    if (INTERACTION.has(v)) applies = false
    else if (v in SCREENS) { if (VIEWPORT_W >= SCREENS[v]) rank = Math.max(rank, SCREENS[v]); else applies = false }
    else if (max && max[1] in SCREENS) { if (VIEWPORT_W < SCREENS[max[1]]) unplaced = `applies at ${VIEWPORT_W}px; this audit does not model max-* breakpoints`; else applies = false }
    else unplaced = `this audit cannot tell whether the ${v}: variant applies at rest`
  }
  return { applies, rank, unplaced }
}
const isInert = util => INERT.test(util) || inertShadow(util)
  || (/^text-/.test(util) && NON_COLOUR_TEXT.test(util.slice(5))) || (/^bg-/.test(util) && NON_COLOUR_BG.test(util.slice(3)))

/** What `classes` set at rest at VIEWPORT_W: { color, size, weight, opacity,
 *  fill, position, z }, each from the one class that wins. An interaction
 *  variant (hover:, focus: …) is not at rest. A breakpoint applies once
 *  VIEWPORT_W reaches it, and the widest that applies wins, as Tailwind orders
 *  its media queries. Every class that applies must be one this audit can
 *  place: classified above, INERT, or defined in index.css with nothing it does
 *  not model. Anything else dies: an unknown class, a `max-*` breakpoint that
 *  applies, any other variant on a class that matters, an `!important` one, or
 *  two classes for one property at one breakpoint (CSS order decides those, not
 *  class order). */
function resting(classes) {
  const won = {}
  for (const token of classes.split(/\s+/).filter(Boolean)) {
    const [variants, raw] = splitVariants(token)
    const important = raw.startsWith('!')
    const util = important ? raw.slice(1) : raw
    const { applies, rank, unplaced } = variantState(variants)
    if (!applies) continue
    const prop = classify(util)
    if (!prop && isInert(util) && !CSS_RULES.has(util)) continue
    if (unplaced) throw new Error(`audit: ${token}: ${unplaced}`)
    if (important) throw new Error(`audit: ${token} is !important; this audit does not model it`)
    if (!prop && !CSS_RULES.has(util)) throw new Error(`audit: ${token} is not a class this audit can place (not a colour, size, weight, opacity, fill or position, not INERT, not in index.css) — the audit is out of date, not passing`)
    checkCssRules(util, token, prop ? MODELS[prop.key] : [])
    if (!prop) continue
    const prev = won[prop.key]
    if (prev && prev.rank === rank) throw new Error(`audit: ${prev.token} and ${token} both set ${prop.key} at one breakpoint; CSS order decides which wins, not class order`)
    if (!prev || rank > prev.rank) won[prop.key] = { ...prop, rank, token }
  }
  return Object.fromEntries(Object.entries(won).map(([k, v]) => [k, v.value]))
}

/** A text surface: colour, alpha, size, weight and fill from the element
 *  holding `anchor`, with `parent` (an anchor for the element directly
 *  enclosing it) filling in what it does not set itself. One parent at most: an
 *  element that sets no colour or size, and names no parent that does, dies
 *  rather than being given a default. An unset weight is read as normal, the
 *  stricter threshold. Opacity composes down the tree, so both elements'
 *  multiply; under a fill it would dim the fill too, which is not modelled.
 *  Every other enclosing element is checked by `checkAncestors`, and the match
 *  veil is found by `veilUnder`. */
function text(anchor, parent) {
  const at = elementAt(anchor)
  const own = classesOf(at)
  const chain = ancestorsOf(at.el)
  const par = parent ? elementAt(parent) : null
  if (par && chain[0] !== par.el) throw new Error(`audit: "${parent}" is not the element directly enclosing "${anchor}" — the audit is out of date, not passing`)
  const r = resting(own.classes)
  const p = par ? resting(classesOf(par).classes) : {}
  const color = r.color ?? p.color
  const px = r.size ?? p.size
  if (!color) throw new Error(`audit: the element anchored by "${anchor}" sets no text colour${parent ? ', nor does its named parent' : ''} — the audit is out of date, not passing`)
  if (px === undefined) throw new Error(`audit: the element anchored by "${anchor}" sets no font size${parent ? ', nor does its named parent' : ''} — the audit is out of date, not passing`)
  const fills = [p.fill, r.fill].filter(Boolean)
  if (fills.includes('gradient')) throw new Error(`audit: the element anchored by "${anchor}" has a gradient fill; this audit models flat fills only`)
  if (((r.opacity ?? 1) < 1 && r.fill) || ((p.opacity ?? 1) < 1 && fills.length))
    throw new Error(`audit: the element anchored by "${anchor}" has a fill under opacity < 1; this audit does not model group opacity`)
  if (stacks(r.z) || stacks(p.z)) throw new Error(`audit: the element anchored by "${anchor}"${stacks(r.z) ? '' : "'s named parent"} sets a z-index; this audit does not model where that paints it`)
  checkAncestors(chain, par?.el)
  return { file: `HeroSection.tsx:${own.line}`, color: color.rgb, alpha: color.a * (r.opacity ?? 1) * (p.opacity ?? 1), px,
    bold: (r.weight ?? p.weight ?? 400) >= 700, fills, veil: veilUnder(at.el, chain), nodes: [at.el, ...chain] }
}

/** A non-text stroke, from an SVG element's own `stroke="…"`. */
function stroke(anchor) {
  const { el } = elementAt(anchor)
  const attrs = attrsOf(el)
  for (const a of ['opacity', 'strokeOpacity', 'className', 'style'])
    if (attrs.has(a)) throw new Error(`audit: ${where(el)} now carries ${a}; model it`)
  const s = attrs.get('stroke')
  if (!s || !ts.isStringLiteral(s)) throw new Error(`audit: ${where(el)} has no literal stroke`)
  const c = parseColor(s.text)
  const chain = ancestorsOf(el)
  checkAncestors(chain)
  return { file: `HeroSection.tsx:${lineOf(openingOf(el).getStart(HERO_SF))}`, color: c.rgb, alpha: c.a, px: 0, nonText: true,
    veil: veilUnder(el, chain), nodes: [el, ...chain] }
}

/** What the elements enclosing a surface may do to it without colouring it:
 *  dim it (opacity), paint behind it (a fill), restack it (a z-index), or
 *  style it in ways this audit does not read. Each one up to the hero's root is
 *  read like the surface, at rest at this frame, and any of those dies, as does
 *  a component (what it renders is not in this file), an inline style or a
 *  spread. Two exceptions, both pinned elsewhere: the root's own fill paints
 *  under the artwork, which the black and white frames stand in for; and the
 *  z-20 on the surface's layer is LAYERS'. A named parent is read by `text()`.
 *  Nothing above the root is read. */
function checkAncestors(chain, skip) {
  const layer = chain[chain.length - 2]
  if (!SURFACE_LAYERS.has(layer)) throw new Error(`audit: ${where(chain[0])} is not inside a layer LAYERS lists as holding surfaces`)
  for (const a of chain) {
    if (a === skip) continue
    if (!/^[a-z]/.test(tagName(a))) throw new Error(`audit: ${where(a)} encloses a surface and is a component; this audit cannot see what it renders`)
    if (attrsOf(a).has('style')) throw new Error(`audit: ${where(a)} encloses a surface and carries an inline style; model it`)
    for (const b of classBranches(a)) {
      const r = resting(b.text)
      if ((r.opacity ?? 1) < 1) throw new Error(`audit: ${where(a)} dims the surfaces inside it (opacity ${r.opacity}); this audit does not model a dimmed ancestor`)
      if (r.fill && a !== HERO_ROOT) throw new Error(`audit: ${where(a)} paints a fill behind the surfaces inside it; model it`)
      if (stacks(r.z) && a !== layer && a !== HERO_ROOT) throw new Error(`audit: ${where(a)} sets a z-index; this audit does not model where that paints the surfaces inside it`)
    }
  }
}

/** Whether `c` is the match veil. Read loosely: a sibling's className need not
 *  be one this audit can resolve. */
function isVeil(c) {
  return (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && openingOf(c).attributes.properties.some(p =>
    ts.isJsxAttribute(p) && p.name.getText(HERO_SF) === 'className' && p.initializer
    && p.initializer.getText(HERO_SF).split(/[^\w-]+/).includes('stage-hero-match-veil'))
}

/** The match veil's alpha when a surface sits over it, else 0. It does when an
 *  enclosing element holds the veil as an earlier child than the branch leading
 *  to the surface, and something on that branch is positioned or transformed at
 *  rest. The veil is `position: absolute`, so it paints over a static sibling
 *  (CSS 2.1 App. E, step 6 over step 5): that is the eyebrow's 1.35:1 in the
 *  note at `backdropFor`. A surface the veil would paint over dies, rather than
 *  being measured with the veil on the wrong side. The veil element itself is
 *  pinned: its own class and aria-hidden, nothing else (its rule is pinned at
 *  VEIL), since a `hidden`, an `opacity-20` or a `z-30` on it changed what the
 *  surfaces sit on while the audit still credited it. A veil inside a {…}
 *  expression is not seen, and the surface is measured without it, the
 *  stricter answer. */
function veilUnder(el, chain) {
  const lifted = x => {
    const bs = classBranches(x)
    return bs.length > 0 && bs.every(b => /^(relative|absolute|fixed|sticky)$/.test(resting(b.text).position ?? 'static')
      || b.text.split(/\s+/).some(t => /^-?(translate-[xy]|rotate|scale(-[xy])?)-/.test(t)))
  }
  for (const [k, a] of chain.entries()) {
    const veil = a.children.find(isVeil)
    if (!veil) continue
    const attrs = attrsOf(veil)
    const own = classBranches(veil)
    if ([...attrs.keys()].some(n => n !== 'className' && n !== 'aria-hidden') || own.length !== 1 || own[0].text.trim() !== 'stage-hero-match-veil' || ts.isJsxElement(veil))
      throw new Error(`audit: the match veil ${where(veil)} carries more than its class (or children); model it — the audit is out of date, not passing`)
    const branch = [el, ...chain.slice(0, k)]
    if (branch[branch.length - 1].getStart(HERO_SF) < veil.getStart(HERO_SF) || !branch.some(lifted))
      throw new Error(`audit: .stage-hero-match-veil paints over ${where(el)}; give the surface position, or model the veil above it`)
    return VEIL
  }
  return 0
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
/** A background's layers, split on its top-level commas. */
function bgLayers(value) {
  const out = []
  let depth = 0, start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth--
    else if (value[i] === ',' && depth === 0) { out.push(value.slice(start, i).trim()); start = i + 1 }
  }
  return [...out, value.slice(start).trim()]
}
// The model reads stops, not directions, so the directions and the layer count
// are pinned: a review flipped the horizontal ramp to 270deg (10 surfaces really
// failing) and added a light radial layer first, both unread.
{
  const L = bgLayers(scrim)
  if (L.length !== 2 || !/^linear-gradient\(\s*90deg\s*,/.test(L[0]) || !/^linear-gradient\(\s*0deg\s*,/.test(L[1]))
    throw new Error(`audit: .stage-hero-scrim's background is no longer a 90deg linear-gradient over a 0deg one and nothing else; model it — the audit is out of date, not passing`)
}
const HERO = {
  // linear-gradient(90deg, ...) → 0% is the LEFT edge. Layer 0 = painted on top.
  horiz: parseLinearStops(scrim, 0),
  // linear-gradient(0deg, ...) → 0% is the BOTTOM edge.
  vert: parseLinearStops(scrim, 1),
}
// ── the hero's layers, pinned ─────────────────────────────────────────────
// The text sits above the scrim, the glow and the corner vignette because its
// two layers carry z-20 and those carry none, and those three composite in
// tree order. All of that is the hero root's children, so it is read from them
// and pinned: a layer added, removed or reordered, or a z-index on any of them
// (a class, an inline style, or its index.css rules), dies rather than being
// painted in an order this model does not know. A review showed each passing
// unseen before: `z-30` on the scrim, a new `bg-white/40` overlay, `-z-10` on
// the content row. Each entry names its layer by text its opening tag carries.
//
// The three layers the model composites are pinned for strength as well as
// order: exactly the attributes and classes listed (`attrs`, `classes`), and an
// inline style, where there is one, that sets `background` and nothing else.
// The next review showed why order was not enough: `opacity-40` or `lg:hidden`
// on the scrim left every figure as it was while 11 of 13 surfaces really
// failed. The artwork layers and the base under them are left free: the black
// and white frames stand in for whatever they paint. The two surface layers are
// read as ancestors (`checkAncestors`) and for overlap (`checkLayerContents`).
const LAYOUT = ['absolute', 'inset-0', 'pointer-events-none']
const LAYERS = [
  { what: 'brand-gradient base (under the artwork; the frames stand in for it)', tag: 'div', has: 'bg-gradient-to-br', free: true },
  { what: 'settled backdrop (the artwork)', tag: 'img', has: 'className="stage-hero-img', free: true },
  { what: 'incoming backdrop (the artwork)', tag: 'img', has: 'stage-hero-img is-incoming', free: true },
  { what: 'scrim and its ::before feather', tag: 'div', has: 'stage-hero-scrim', attrs: ['className'], classes: ['stage-hero-scrim'] },
  { what: 'purple glow', tag: 'div', has: 'mix-blend-screen', attrs: ['className', 'style'], classes: [...LAYOUT, 'mix-blend-screen', /^opacity-/] },
  { what: 'top-right corner vignette', tag: 'div', has: 'radial-gradient(ellipse 42%', attrs: ['className', 'style'], classes: LAYOUT },
  { what: 'match cluster', tag: 'div', has: 'flex flex-col items-center', z: '20', surfaces: true },
  { what: 'content row', tag: 'div', has: 'stage-gutter', z: '20', surfaces: true },
]
/** A pinned layer's inline background: the style must be `{{ background: '…' }}`
 *  and nothing else. */
function layerBackground(el) {
  const init = attrsOf(el).get('style')
  const obj = init && ts.isJsxExpression(init) && init.expression && ts.isObjectLiteralExpression(init.expression) ? init.expression : null
  const p = obj?.properties
  if (!p || p.length !== 1 || !ts.isPropertyAssignment(p[0]) || p[0].name.getText(HERO_SF) !== 'background' || !ts.isStringLiteral(p[0].initializer))
    throw new Error(`audit: ${where(el)}'s inline style is no longer exactly { background: '…' }; model it — the audit is out of date, not passing`)
  return p[0].initializer.text
}
const LAYER_ELS = (() => {
  const els = []
  const collect = n => { if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) els.push(n); else ts.forEachChild(n, collect) }
  for (const c of HERO_ROOT.children) collect(c)
  const opening = el => openingOf(el).getText(HERO_SF)
  const got = els.map(el => `<${tagName(el)}> ${opening(el).replace(/\s+/g, ' ').slice(0, 70)}`)
  if (els.length !== LAYERS.length || LAYERS.some((l, i) => tagName(els[i]) !== l.tag || !opening(els[i]).includes(l.has)))
    throw new Error(`audit: the hero's layers are not the ${LAYERS.length} this audit models, in order — re-model them, do not pass. Found:\n  ${got.join('\n  ')}`)
  els.forEach((el, i) => {
    const L = LAYERS[i]
    if (/zIndex/.test(attrsOf(el).get('style')?.getText(HERO_SF) ?? '')) throw new Error(`audit: ${where(el)} (${L.what}) sets zIndex inline; re-model the paint order`)
    const tokens = (attrsOf(el).get('className')?.getText(HERO_SF) ?? '').split(/[\s"'`{}$]+/).filter(Boolean)
    const z = tokens.map(t => splitVariants(t)[1].match(/^(-?)z-(.+)$/)).filter(Boolean)
    if (L.z) {
      if (resting(classBranches(el).map(b => b.text).join(' ')).z !== L.z || z.length !== 1)
        throw new Error(`audit: ${where(el)} (${L.what}) is no longer z-${L.z}; re-model the paint order`)
    } else if (z.length) throw new Error(`audit: ${where(el)} (${L.what}) now carries ${z[0][0]}; re-model the paint order`)
    for (const t of tokens) for (const { rule, pseudo } of CSS_RULES.get(t) ?? []) for (const d of declsOf(rule)) {
      if (!pseudo && d.prop === 'z-index') throw new Error(`audit: ${where(el)} (${L.what}): index.css (${rule.selector}) sets z-index; re-model the paint order`)
    }
    if (L.attrs) {
      const names = [...attrsOf(el).keys()].filter(n => n !== 'aria-hidden').sort()
      if (names.join() !== [...L.attrs].sort().join()) throw new Error(`audit: ${where(el)} (${L.what}) carries ${names.join(', ')}, not exactly ${L.attrs.join(', ')}; model it — the audit is out of date, not passing`)
      const branches = classBranches(el)
      const own = branches.length === 1 ? branches[0].text.split(/\s+/).filter(Boolean) : null
      const stray = own?.filter(t => !L.classes.some(c => (c instanceof RegExp ? c.test(t) : c === t)))
      if (!own || stray.length || L.classes.some(c => !(c instanceof RegExp) && !own.includes(c)))
        throw new Error(`audit: ${where(el)} (${L.what}) is no longer exactly ${L.classes.map(String).join(' ')}${stray?.length ? ` (it carries ${stray.join(' ')})` : ''}; model it — the audit is out of date, not passing`)
      if (L.attrs.includes('style')) layerBackground(el)
    }
  })
  return els
})()
const SURFACE_LAYERS = new Set(LAYER_ELS.filter((_, i) => LAYERS[i].surfaces))

// The index.css rules the model reads its values from, pinned the same way:
// exactly these rules, each with exactly its own selector at the top level (a
// copy inside a media query would override it at some width unseen, and
// `cssValue` reads only the first), and only these properties, those with a
// pattern held to it. A review dimmed the scrim with `opacity: 0.4` in its own
// rule, and overrode the veil's alpha to 0.15 in a media query, both unseen.
const PINNED_RULES = [
  { selector: '.stage-hero-scrim', props: { position: /^absolute$/, inset: /^0$/, 'pointer-events': null, background: null } },
  { selector: '.stage-hero-scrim::before', props: { content: null, position: /^absolute$/, inset: /^0 0 auto$/, height: null, background: null } },
  { selector: '.stage-hero-match-veil', props: { position: /^absolute$/, inset: /^-28px$/, 'pointer-events': null, background: null } },
]
for (const cls of ['stage-hero-scrim', 'stage-hero-match-veil']) {
  const got = CSS_RULES.get(cls) ?? []
  const want = PINNED_RULES.filter(p => p.selector.startsWith(`.${cls}`))
  const selectors = got.map(g => g.rule.selector)
  if (got.length !== want.length || want.some(w => selectors.filter(s => s === w.selector).length !== 1))
    throw new Error(`audit: index.css styles .${cls} with ${selectors.join(' | ') || 'nothing'}; this audit reads exactly ${want.map(w => w.selector).join(' | ')} — model the rest, do not pass`)
  for (const { rule } of got) {
    const w = want.find(x => x.selector === rule.selector)
    if (rule.parent.type !== 'root') throw new Error(`audit: index.css's ${rule.selector} is inside @${rule.parent.name ?? rule.parent.type}; this audit reads it at the top level only`)
    for (const d of declsOf(rule)) {
      if (!(d.prop in w.props) || (w.props[d.prop] && !w.props[d.prop].test(d.value.trim())))
        throw new Error(`audit: index.css's ${rule.selector} sets ${d.prop}: ${d.value}, which this audit does not model — the audit is out of date, not passing`)
    }
  }
}

// The corner vignette is an INLINE style on its own div — which is why a grep of
// index.css never found it:
//   radial-gradient(ellipse 42% 48% at 100% 0%, rgba(5,5,5,0.72), transparent 70%)
// It predates Phase 8 and exists for exactly this widget; its own comment says
// so ("on a backdrop that's bright in this corner … the white score number +
// ring vanished"). Radii are 42% of width and 48% of height, centred on the
// TOP-RIGHT corner, ramping to transparent at 70% along the ray.
const cornerDecl = layerBackground(LAYER_ELS[5]).match(/radial-gradient\(ellipse ([\d.]+)% ([\d.]+)% at 100% 0%,\s*rgba\(([^)]*)\),\s*transparent ([\d.]+)%\)/)
if (!cornerDecl) throw new Error(`audit: the top-right corner vignette is no longer in ${SRC_HERO} in the expected form`)
const CORNER = {
  rx: Number(cornerDecl[1]) / 100,
  ry: Number(cornerDecl[2]) / 100,
  a0: Number(cornerDecl[3].split(',')[3]),
  end: Number(cornerDecl[4]) / 100,
}
// The purple glow between the scrim and the vignette: a radial purple at
// `opacity-30` under `mix-blend-screen`, which lightens whatever is beneath
// it. The model left it out until a review composited it and measured the
// left column's figures up to about 6% high. Read from its own element, which
// LAYERS pins to its layout classes, `mix-blend-screen` and one `opacity-*`:
// the gradient from its inline style, the opacity from its class.
const GLOW = (() => {
  const el = LAYER_ELS[4]
  const m = layerBackground(el).match(/^radial-gradient\(ellipse ([\d.]+)% ([\d.]+)% at ([\d.]+)% ([\d.]+)%,\s*rgba\(([^)]*)\),\s*transparent ([\d.]+)%\)$/)
  if (!m) throw new Error(`audit: the hero glow ${where(el)} is no longer a radial-gradient in the expected form`)
  const ops = classBranches(el)[0].text.split(/\s+/).filter(t => /^opacity-/.test(t))
  if (ops.length !== 1) throw new Error(`audit: the hero glow ${where(el)} needs exactly one opacity-* class, not ${ops.length}`)
  const opacity = twOpacity(ops[0].slice(8), ops[0])
  const c = parseColor(`rgba(${m[5]})`)
  return { rx: Number(m[1]) / 100, ry: Number(m[2]) / 100, cx: Number(m[3]) / 100, cy: Number(m[4]) / 100,
    rgb: c.rgb, a0: c.a * opacity, end: Number(m[6]) / 100 }
})()
// The fourth layer: .stage-hero-scrim::before, the top feather (Stage refresh
// H1). A fixed-px band, so its alpha at a fractional y depends on the hero's
// real height — read from the hero's own height utilities at the 1440x900 frame
// the coordinates below were taken at (VIEWPORT_H), not assumed.
const FEATHER = (() => {
  const bg = cssValue('.stage-hero-scrim::before', 'background')
  if (bgLayers(bg).length !== 1 || !/^linear-gradient\(\s*180deg\s*,/.test(bg)) throw new Error('audit: the hero top feather is no longer one top-down (180deg) linear-gradient')
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

/** The glow screened over `bg` at (x from left, y from bottom): screen is
 *  1 - (1 - glow)(1 - backdrop) per channel, then laid over the backdrop at the
 *  glow's alpha there (its gradient times the element's opacity). */
function glowOver(x, yFromBottom, bg) {
  const d = Math.hypot((x - GLOW.cx) / GLOW.rx, ((1 - yFromBottom) - GLOW.cy) / GLOW.ry)
  if (d >= GLOW.end) return bg
  const a = GLOW.a0 * (1 - d / GLOW.end)
  return bg.map((b, i) => a * (1 - (1 - GLOW.rgb[i]) * (1 - b)) + (1 - a) * b)
}

/** Composite the hero's layers at (x from left, y from bottom) over `frame`,
 *  in paint order: artwork, vertical ramp, horizontal ramp, top feather (the
 *  scrim's own ::before, so above both of its layers), glow, corner vignette. */
function heroBackdrop(x, yFromBottom, frame) {
  let bg = over(INK, rampA(HERO.vert, yFromBottom), frame)
  bg = over(INK, rampA(HERO.horiz, x), bg)
  bg = over(INK, featherAlpha(yFromBottom), bg)
  bg = glowOver(x, yFromBottom, bg)
  return over(INK, cornerAlpha(x, yFromBottom), bg)
}

// The veil's rule is pinned with the scrim's (PINNED_RULES): it may only place
// it and paint its background. The surfaces are credited the veil's plateau,
// so the background's shape is pinned too: closest-side, flat to 72%, clear at
// 100%, with only the plateau's alpha read. A review deleted the 72% stop, so
// the veil faded from its centre and the eyebrow sat on about 0.32 of it,
// while the audit still credited 0.72.
const VEIL = (() => {
  const v = cssValue('.stage-hero-match-veil', 'background')
  const m = v.match(/^radial-gradient\(\s*closest-side,\s*rgba\(\s*5,\s*5,\s*5,\s*([\d.]+)\)\s+0%,\s*rgba\(\s*5,\s*5,\s*5,\s*([\d.]+)\)\s+72%,\s*rgba\(\s*5,\s*5,\s*5,\s*0\)\s+100%\s*\)$/)
  if (!m || m[1] !== m[2]) throw new Error('audit: .stage-hero-match-veil is no longer a closest-side radial plateau, flat to 72% — model its shape, do not pass')
  return Number(m[1])
})()
{
  const veils = []
  const find = n => { if (isVeil(n)) veils.push(n); ts.forEachChild(n, find) }
  find(HERO_ROOT)
  if (veils.length !== 1) throw new Error(`audit: the hero has ${veils.length} .stage-hero-match-veil elements; this audit models exactly one — a second paints over whatever follows it`)
}

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
  PROBE.push(['relative drop-shadow-lg [text-shadow:0_1px_3px_rgba(0,0,0,0.5)] line-clamp-2 max-sm:sr-only aria-selected:px-4',
    r => r.position === 'relative' && Object.keys(r).length === 1])
  PROBE.push(['z-auto', r => r.z === 'auto' && !stacks(r.z)])
  const DIES = ['text-white/97', 'text-white/70 text-white/50', 'md:!text-white', 'max-2xl:text-white/40',
    'aria-selected:text-white/40', 'disabled:text-white/20', 'visited:text-white/20', 'text-current',
    'text-[color:var(--no-such-token)]', '[color:rgba(255,255,255,0.3)]', '[opacity:0.3]', 'brightness-50',
    'mix-blend-screen', 'shadow-inner', 'no-such-class', '[text-shadow:0_0_20px_white]', 'drop-shadow-[0_0_20px_rgba(255,255,255,0.8)]',
    'order-first', 'ring-2']
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
// Each surface's colour, alpha, size, weight and fill come from its element
// (`text()`), found by an anchor that must occur exactly once in the hero's code;
// the line reported is that element's, or for a title its className branch's.
// x/y are fractions (x from the left edge, y from the BOTTOM edge), read off the
// hero's own layout: the text column starts at --page-gutter (~3% at 1440px)
// and the stack runs title → meta → description → buttons up from the lower
// third. They are typed in, and moving an element does not move them.
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
  // `veilUnder` finds the veil from the tree; it is not listed here.
  // Geometry derived from the cluster's `md:top-11` and its 52px right inset at
  // this width + an 84px ring + a gap-1.5 + a 10px caption at 1440x900, not
  // estimated: the earlier x:0.95,
  // y:0.72 was off by 0.12-0.18 on y. It happened not to change any verdict
  // (the vertical ramp is already 0 above y=0.55) but a sample point that is
  // wrong for a reason you have not checked is a coin flip, not a measurement.
  { what: 'MATCH/SCORE eyebrow', ...text("{showingPersonal ? 'Match' : 'Score'}"), x: 0.935, y: 0.844 },
  { what: 'match numeral "NN%"', ...text('{matchScore}%'), x: 0.935, y: 0.904 },
  { what: 'ring track vs backdrop', ...stroke('stroke="rgba('), x: 0.935, y: 0.904,
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

// ── what else the two text layers hold ────────────────────────────────────
// Every other element in the text's two layers (the buttons, badges, pill,
// icons, the ring's arc) is read too, because it can reach measured text
// without enclosing it, in two ways.
//
// Out of the flow: positioned absolute, fixed or sticky, offset, transformed,
// pulled by a negative margin, or drawing a ::before or ::after box, through a
// class, an inline style or its index.css rules. Such an element can sit over
// or under any text, so it dies unless it is the veil (modelled) or listed in
// OVERLAP_OK, matched by its tag and exact classes, with the reason it covers
// no measured text; an entry that no longer matches dies as unneeded. A review
// added a purple halo behind the match ring (`absolute inset-0
// bg-purple-400/40`): the eyebrow measured 4.22:1 with it while the audit
// passed unchanged.
//
// Past its own box, in the flow: a box-shadow glow. Those are measured (GLOWS
// below). A dark shadow only darkens what it reaches, which cannot lower the
// contrast of this hero's light text, so it passes; filters and Tailwind's
// coloured shadow and ring utilities die.
//
// So every class such an element can carry must be readable: its className is
// a literal, or literals chosen by conditions and template slots, enumerated
// (a class list held in a variable, as a review's `className={HALO}` was, dies),
// and every class in it is classified, INERT, or an index.css class whose
// rules this audit reads. Its inline style may size it or dash an SVG stroke,
// nothing else. What a component renders is not read, and neither is SVG
// geometry: a shape drawn over the ring's track is not seen.
const OVERLAP_OK = [
  { tag: 'span', classes: 'absolute left-0 right-0 bottom-0 h-[3px] bg-white/25',
    why: "the Resume button's 3px progress bar, along that button's own bottom edge, and its fill's 8px glow below it, where nothing is measured; the button holds no measured text" },
]

/** Every class string an element's className can produce: a literal, either
 *  branch of a condition, and each combination of a template's slots, so a
 *  class list held in a variable or built by a call dies. */
function classStrings(el) {
  const init = attrsOf(el).get('className')
  if (init === undefined) return ['']
  const strs = n => {
    while (n && ts.isParenthesizedExpression(n)) n = n.expression
    if (!n) return null
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text]
    if (ts.isConditionalExpression(n)) { const a = strs(n.whenTrue), b = strs(n.whenFalse); return a && b ? [...a, ...b] : null }
    if (ts.isTemplateExpression(n)) {
      let out = [n.head.text]
      for (const span of n.templateSpans) {
        const v = strs(span.expression)
        if (!v) return null
        out = out.flatMap(o => v.map(x => o + x + span.literal.text))
        if (out.length > 64) return null
      }
      return out
    }
    return null
  }
  const v = strs(ts.isJsxExpression(init) ? init.expression : init)
  if (!v) throw new Error(`audit: the className of ${where(el)} is not a literal this audit can enumerate (a variable, a call); spell it out — the audit is out of date, not passing`)
  return v
}

/** A box-shadow value's layers that paint outside the box and could lighten
 *  text: not inset, not dark. Each as { x, y, blur, spread, rgb, a }. */
function glowLayers(value, where_) {
  let v = value.trim()
  const tok = v.match(/^var\((--[\w-]+)\)$/)
  if (tok) v = rootToken(tok[1])
  if (v === 'none') return []
  return bgLayers(v).flatMap(layer => {
    if (/\binset\b/.test(layer) || darkShadow(layer)) return []
    const colour = layer.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}/)
    const lens = layer.replace(colour?.[0] ?? '', '').trim().split(/\s+/).filter(Boolean)
      .map(l => (l === '0' ? 0 : Number(l.match(/^(-?[\d.]+)px$/)?.[1] ?? NaN)))
    if (!colour || lens.length < 2 || lens.length > 4 || lens.some(Number.isNaN)) throw new Error(`audit: ${where_}: cannot read the box-shadow layer "${layer}" — the audit is out of date, not passing`)
    const c = parseColor(colour[0])
    return [{ x: lens[0], y: lens[1], blur: lens[2] ?? 0, spread: lens[3] ?? 0, rgb: c.rgb, a: c.a }]
  })
}

/** What an element in a text layer that encloses no surface does beyond its
 *  own box: { out } when it leaves the flow (why), and { glows } for the
 *  box-shadow layers it casts. Dies on anything it cannot read. */
function neighbourOf(el) {
  const res = { out: null, glows: [] }
  const attrs = openingOf(el).attributes.properties
  if (attrs.some(a => ts.isJsxSpreadAttribute(a))) throw new Error(`audit: ${where(el)} spreads props; this audit cannot read them`)
  const style = attrsOf(el).get('style')
  if (style !== undefined) {
    const e = ts.isJsxExpression(style) ? style.expression : null
    if (!e || !ts.isObjectLiteralExpression(e)) throw new Error(`audit: ${where(el)} has an inline style this audit cannot read`)
    for (const p of e.properties) {
      const name = ts.isPropertyAssignment(p) ? p.name.getText(HERO_SF) : null
      if (name && /^(position|inset|top|right|bottom|left|transform|translate|margin.*)$/.test(name)) res.out ??= `sets ${name} inline`
      else if (!name || !/^((min|max)?(width|height|Width|Height)|strokeDash(array|offset))$/.test(name))
        throw new Error(`audit: ${where(el)} sets ${name ?? 'a spread'} inline; this audit reads only sizes and stroke dashes there — model it`)
    }
  }
  // Each class once, though it may appear in several of the strings: a glow
  // counted per string was counted twice on the Play button.
  for (const t of new Set(classStrings(el).flatMap(str => str.split(/\s+/).filter(Boolean)))) {
    const [variants, raw] = splitVariants(t)
    const util = raw.replace(/^!/, '')
    const { applies, unplaced } = variantState(variants)
    if (!applies) continue
    const fail = why => { throw new Error(`audit: ${where(el)}: ${t} ${why} — the audit is out of date, not passing`) }
    if (/^(absolute|fixed|sticky)$/.test(util) || /^-?(top|right|bottom|left|inset(-[xy])?|translate-[xy]|rotate|scale(-[xy])?|skew-[xy])-/.test(util)
      || /^-m[xytrblse]?-/.test(util) || /^m[xytrblse]?-\[-/.test(util)) { res.out ??= `carries ${t}`; continue }
    if (/^(shadow|ring|blur|brightness|contrast|saturate|hue-rotate|invert|sepia|grayscale|drop-shadow)(-|$)/.test(util)
      && !/^shadow(-(sm|md|lg|xl|2xl|inner|none))?$/.test(util) && !isInert(util)) fail('paints past its box in a way this audit does not model')
    if (/^(from|via|to)-/.test(util)) continue // a gradient's stops: its own fill, inside its box
    const prop = classify(util)
    if (prop?.key === 'z' && stacks(prop.value)) fail('sets a z-index; this audit does not model where that paints it')
    if (unplaced && (prop || !isInert(util))) fail(unplaced)
    if (prop || (isInert(util) && !CSS_RULES.has(util)) || /^shadow(-(sm|md|lg|xl|2xl|inner|none))?$/.test(util)) continue
    if (!CSS_RULES.has(util)) fail('is not a class this audit can place')
    for (const { rule, pseudo } of CSS_RULES.get(util)) {
      const decls = declsOf(rule)
      if (pseudo) {
        if (/^(before|after)$/.test(pseudo) && decls.some(d => d.prop === 'content' && !/^(none|normal)$/.test(d.value.trim()))) res.out ??= `draws a ::${pseudo} box through ${rule.selector}`
        continue
      }
      for (const d of decls) {
        const v = d.value.trim()
        if ((d.prop === 'position' && !/^(relative|static)$/.test(v)) || /^(inset|top|right|bottom|left|translate)$/.test(d.prop)
          || (d.prop === 'transform' && v !== 'none') || (/^margin/.test(d.prop) && v.includes('-'))) res.out ??= `is ${d.prop}: ${v} through ${rule.selector}`
        else if (d.prop === 'box-shadow') res.glows.push(...glowLayers(v, `${where(el)} (${rule.selector})`))
        else if (/^(filter|z-index|-webkit-text-stroke.*)$/.test(d.prop) || (d.prop === 'text-shadow' && v !== 'none' && !darkShadow(v))
          || (/^animation(-fill-mode|-iteration-count)?$/.test(d.prop) && /\b(forwards|both|infinite)\b/.test(v)))
          fail(`gets ${d.prop}: ${v} from ${rule.selector}, which this audit does not model`)
      }
    }
  }
  return res
}

/** The elements in the text layers that enclose no surface, each with what
 *  `neighbourOf` found, allowed overlays' contents skipped. */
const NEIGHBOURS = (() => {
  const ENCLOSING = new Set(SURFACES.flatMap(s => s.nodes))
  const out = [], used = new Set()
  const visit = n => {
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && !ENCLOSING.has(n) && !isVeil(n)) {
      const nb = neighbourOf(n)
      if (nb.out) {
        const strs = classStrings(n)
        const ok = OVERLAP_OK.find(o => tagName(n) === o.tag && strs.length === 1 && strs[0] === o.classes)
        if (!ok) throw new Error(`audit: ${where(n)} in a text layer ${nb.out}, so it can sit over or under measured text; model it or list it in OVERLAP_OK with the reason it cannot`)
        used.add(ok)
        return // what an allowed overlay holds sits inside it
      }
      if (nb.glows.length) out.push({ el: n, glows: nb.glows })
    }
    ts.forEachChild(n, visit)
  }
  for (const layer of SURFACE_LAYERS) ts.forEachChild(layer, visit)
  for (const o of OVERLAP_OK) if (!used.has(o)) throw new Error(`audit: OVERLAP_OK lists <${o.tag} className="${o.classes}">, which no longer matches an out-of-flow element in a text layer; remove the entry`)
  return out
})()

// ── GLOWS: how far each neighbour's glow reaches into each surface ──────────
// For a glowing element G and a surface S in the same layer, take A, the
// nearest element enclosing both, and A's two children leading to them. Their
// gap is read from the layout at its smallest: in a flex row, A's column gap
// (or its row gap when it wraps, if smaller); in a block or a flex column, the
// earlier child's bottom margin (plus a column gap), as if nothing rendered
// between them and the margins collapsed in the glow's favour. A negative
// margin there, or a reversed flex direction, dies. Across that gap each
// shadow layer falls off as a blurred edge does, alpha·½·erfc(d / (σ√2)) with
// σ = blur/2 and d the gap less its spread, plus or minus its offset along the
// axis; its corner, where it is fainter, is not modelled. A glow painted after
// the text (G later in tree order, or positioned where S is not) lies over the
// glyphs and their backdrop alike; one painted before lies under them. Each
// surface is then measured under every set of glows that can render together
// (the two branches of one condition cannot), and its worst figure is
// asserted with the rest. A pairing that never renders together (separate
// `compact` conditions, say) is still counted, the stricter answer.
const erfc = x => {
  // Abramowitz and Stegun 7.1.26, |error| < 1.5e-7.
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x)
  return x >= 0 ? y : 2 - y
}
const spacingPx = (v, token) => {
  const s = v.startsWith('[') ? v.slice(1, -1) : THEME.spacing[v]
  if (s === undefined) throw new Error(`audit: ${token} is off the spacing scale`)
  return cssLengthPx(String(s))
}
/** The resting classes of an element (every branch) as tokens. */
const restingTokens = el => classStrings(el).flatMap(s => s.split(/\s+/).filter(Boolean))
  .map(t => splitVariants(t)).filter(([v]) => variantState(v).applies).map(([, u]) => u.replace(/^!/, ''))
/** The smallest spacing token matching `re` on an element, in px (0 if none);
 *  a negative one dies. */
function spacing(el, re) {
  let px = Infinity
  for (const u of restingTokens(el)) {
    const m = u.match(re)
    if (!m || m[1] === 'auto') continue
    if (u.startsWith('-') || m[1].startsWith('[-')) throw new Error(`audit: ${where(el)} carries ${u}, a negative spacing that brings neighbours closer than this audit models`)
    px = Math.min(px, spacingPx(m[1], u))
  }
  return px === Infinity ? 0 : px
}
const positioned = el => restingTokens(el).some(u => /^(relative|absolute|fixed|sticky)$/.test(u))
  || restingTokens(el).some(u => (CSS_RULES.get(u) ?? []).some(({ rule, pseudo }) => !pseudo && declsOf(rule).some(d => d.prop === 'position' && d.value.trim() !== 'static')))
/** The ConditionalExpression whose two branches hold `a` and `b`, if any. */
function exclusive(a, b) {
  for (let n = a.parent; n; n = n.parent) {
    if (ts.isConditionalExpression(n)) {
      const inT = x => x.pos >= n.whenTrue.pos && x.end <= n.whenTrue.end
      const inF = x => x.pos >= n.whenFalse.pos && x.end <= n.whenFalse.end
      if ((inT(a) && inF(b)) || (inF(a) && inT(b))) return true
    }
  }
  return false
}
const GLOWS = []
for (const s of SURFACES) {
  const sChain = s.nodes
  const layer = sChain[sChain.length - 2]
  for (const g of NEIGHBOURS) {
    const gChain = [g.el]
    for (let n = g.el.parent; n; n = n.parent) if (ts.isJsxElement(n)) gChain.push(n)
    if (!gChain.includes(layer)) continue
    const A = gChain.find(n => sChain.includes(n))
    const cG = gChain[gChain.indexOf(A) - 1], cS = sChain[sChain.indexOf(A) - 1]
    const after = cG.getStart(HERO_SF) > cS.getStart(HERO_SF)
    const aTok = restingTokens(A)
    if (aTok.some(u => /^flex-(row|col)-reverse$/.test(u))) throw new Error(`audit: ${where(A)} reverses its flex direction; this audit does not model which side its glows reach`)
    const row = aTok.some(u => /^(inline-)?flex$/.test(u)) && !aTok.includes('flex-col')
    let gap
    const colGap = () => spacing(A, /^gap-(?!y-)(?:x-)?(.+)$/), rowGap = () => spacing(A, /^gap-(?!x-)(?:y-)?(.+)$/)
    if (row) gap = aTok.includes('flex-wrap') ? Math.min(colGap(), rowGap()) : colGap()
    else gap = spacing(after ? cS : cG, /^m[by]?-(.+)$/) + (aTok.includes('flex-col') ? rowGap() : 0)
    for (const c of [cG, cS]) spacing(c, /^-?m[xytrblse]?-(.+)$/) // dies on a negative margin
    const posG = gChain.slice(0, gChain.indexOf(A)).some(positioned)
    const posS = sChain.slice(0, sChain.indexOf(A)).some(n => classBranches(n).some(b => /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/.test(b.text)))
    const side = posG !== posS ? (posG ? 'over' : 'under') : (after ? 'over' : 'under')
    const layers = g.glows.map(L => {
      const off = row ? L.x : L.y
      const d = gap - L.spread + (after ? off : -off)
      const a = L.blur === 0 ? (d < 0 ? L.a : 0) : L.a * 0.5 * erfc(d / ((L.blur / 2) * Math.SQRT2))
      return { rgb: L.rgb, a: Math.min(L.a, a) }
    }).filter(L => L.a > 1e-4)
    if (layers.length) GLOWS.push({ s, g: g.el, side, gap, layers })
  }
}

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
{
  const bySurface = new Map()
  for (const r of GLOWS) bySurface.set(r.s, [...(bySurface.get(r.s) ?? []), r])
  console.log(`\nunder neighbour glows (GLOWS): each surface's worst frame under every set of glows that can render together`)
  for (const [s, rs] of bySurface) {
    let worst = Infinity, worstSet = []
    for (let mask = 1; mask < 1 << rs.length; mask++) {
      const set = rs.filter((_, i) => mask & (1 << i))
      if (set.some((a, i) => set.some((b, j) => j > i && exclusive(a.g, b.g)))) continue
      for (const frame of [K, W]) {
        let bg = backdropFor(s, frame)
        for (const r of set) if (r.side === 'under') for (const L of r.layers) bg = over(L.rgb, L.a, bg)
        let fg = over(s.color, s.alpha, bg)
        for (const r of set) if (r.side === 'over') for (const L of r.layers) { fg = over(L.rgb, L.a, fg); bg = over(L.rgb, L.a, bg) }
        const v = ratio(fg, bg)
        if (v < worst) { worst = v; worstSet = set }
      }
    }
    const req = need(s)
    const ok = worst >= req
    if (!ok && !s.advisory) fails++
    const from = worstSet.map(r => `${where(r.g).replace(` at ${SRC_HERO}`, '')} ${r.side} ${r.layers.reduce((t, L) => t + L.a, 0).toFixed(3)} at ${r.gap}px`).join(', ')
    console.log(`${`${s.what} (${s.file})`.padEnd(LABEL_W)}${String(s.px).padStart(3)} ${req.toFixed(1).padStart(5)}   ${worst.toFixed(2).padStart(10)}  ${(ok ? 'PASS' : '*** FAIL ***').padStart(11)}  ${from}`)
  }
  console.log('-'.repeat(LABEL_W + 54))
}
console.log(`${fails} surface(s) below threshold at their worst frame; ${advisories} advisory.`)
process.exit(fails ? 1 : 0)
