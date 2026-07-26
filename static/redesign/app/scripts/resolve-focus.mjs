// Resolve, against the BUILT stylesheet, which declaration actually wins for a
// hypothetical element — tag + classes + state. Written for the Phase 8 keyboard
// pass, because the question "does this input have a visible focus indicator?"
// turned out to depend on a three-way cascade fight between a Tailwind utility, a
// global element rule, and an a11y floor, and reading source order cannot answer it.
//
// Run: npm run build && node scripts/resolve-focus.mjs

import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import selparser from 'postcss-selector-parser'

const dir = '/home/user/AuroraPro.App/static/v2/assets'
const cssFile = fs.readdirSync(dir).filter(f => f.endsWith('.css')).sort()[0]
const root = postcss.parse(fs.readFileSync(path.join(dir, cssFile), 'utf8'))

// Native cascade layers would outrank specificity. Assert there are none, so the
// rest of this reasoning (specificity, then source order) is valid.
let nativeLayers = 0
root.walkAtRules('layer', () => nativeLayers++)

function specificity(sel) {
  const s = [0, 0, 0]
  selparser(sels => {
    sels.walk(n => {
      if (n.type === 'id') s[0]++
      else if (n.type === 'class' || n.type === 'attribute') s[1]++
      else if (n.type === 'pseudo') {
        // :not()/:is()/:has() take the specificity of their most specific arg.
        if ([':not', ':is', ':has'].includes(n.value)) {
          let best = [0, 0, 0]
          for (const g of n.nodes ?? []) {
            const inner = specificity(String(g).trim())
            if (cmp(inner, best) > 0) best = inner
          }
          s[0] += best[0]; s[1] += best[1]; s[2] += best[2]
        } else if (n.value.startsWith('::')) s[2]++
        else s[1]++
      } else if (n.type === 'tag') s[2]++
    })
  }).processSync(sel)
  return s
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])

/** Does `sel` match this element? Deliberately narrow: handles the compound and
 *  simple-descendant forms that actually appear here, and REPORTS anything it
 *  cannot judge instead of silently returning false. */
function matches(sel, el, unknown) {
  if (/[>+~]/.test(sel)) { unknown.push(sel); return false }
  const parts = sel.trim().split(/\s+/)
  const target = parts[parts.length - 1]           // rightmost compound
  if (parts.length > 1) {
    // Ancestor requirements we cannot evaluate without a real tree.
    const anc = parts.slice(0, -1).join(' ')
    if (!(el.ancestors ?? []).some(a => anc.includes(a))) { unknown.push(sel); return false }
  }
  const toks = target.match(/(\\.|\[[^\]]*\]|::?[a-zA-Z-]+(\([^)]*\))?|\.(?:\\.|[\w-])+|^[a-zA-Z]+|\*)/g) ?? []
  for (let t of toks) {
    if (t === '*') continue
    if (t.startsWith('.')) {
      const cls = t.slice(1).replace(/\\/g, '')
      if (!el.classes.includes(cls)) return false
    } else if (t.startsWith('[')) {
      const m = t.match(/\[([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]/)
      if (!m) { unknown.push(sel); return false }
      const [, attr, , val] = m
      if (val === undefined) { if (!(attr in el.attrs)) return false }
      else if (el.attrs[attr] !== val) return false
    } else if (t.startsWith(':')) {
      const name = t.replace(/\(.*\)$/, '')
      if (name === ':not') {
        const inner = t.slice(5, -1)
        if (matches(inner, el, [])) return false
      } else if (!el.states.includes(name)) return false
    } else {
      if (el.tag !== t) return false
    }
  }
  return true
}

function resolve(el, props) {
  const cands = []
  let i = 0
  root.walkRules(rule => {
    const inMedia = rule.parent.type === 'atrule' && rule.parent.name === 'media'
    // Only unconditional rules and the always-true media contexts.
    const skip = inMedia && !/^\s*(screen|all)?\s*$/.test(rule.parent.params)
    for (const sel of rule.selectors) {
      const unknown = []
      if (!skip && matches(sel, el, unknown)) {
        for (const d of rule.nodes) {
          if (d.type === 'decl' && props.includes(d.prop)) {
            cands.push({ i, sel, prop: d.prop, value: d.value, important: d.important,
              spec: specificity(sel), media: inMedia ? rule.parent.params : '' })
          }
        }
      }
    }
    i++
  })
  const winners = {}
  for (const c of cands) {
    const cur = winners[c.prop]
    const better = !cur
      || (c.important && !cur.important)
      || (c.important === cur.important && (cmp(c.spec, cur.spec) > 0
        || (cmp(c.spec, cur.spec) === 0 && c.i > cur.i)))
    if (better) winners[c.prop] = c
  }
  return { cands, winners }
}

const PROPS = ['outline', 'outline-color', 'outline-width', 'border-color', 'background', 'background-color', 'box-shadow']

const CASES = [
  { name: 'MiniDock chat input, focused (MiniDock.tsx:74)',
    el: { tag: 'input', classes: ['focus:outline-none', 'border-0'], attrs: { type: 'text' }, states: [':focus', ':focus-visible'], ancestors: [] } },
  { name: 'RequestsView search input, focused (RequestsView.tsx:225)',
    el: { tag: 'input', classes: ['w-full', 'bg-white/[0.04]', 'border', 'border-white/[0.06]', 'rounded-lg', 'focus:outline-none', 'focus:bg-white/[0.06]'], attrs: { type: 'text' }, states: [':focus', ':focus-visible'], ancestors: [] } },
  { name: 'BugReportModal input, focused (BugReportModal.tsx:1153)',
    el: { tag: 'input', classes: ['w-full', 'bg-white/[0.04]', 'border', 'border-white/[0.08]', 'rounded-lg', 'focus:outline-none', 'focus:border-purple-500/60'], attrs: { type: 'text' }, states: [':focus', ':focus-visible'], ancestors: [] } },
  { name: 'a plain focused BUTTON with focus:outline-none and no ring',
    el: { tag: 'button', classes: ['focus:outline-none'], attrs: {}, states: [':focus', ':focus-visible'], ancestors: [] } },
  { name: 'a plain focused BUTTON with no focus utilities at all',
    el: { tag: 'button', classes: [], attrs: {}, states: [':focus', ':focus-visible'], ancestors: [] } },
]

console.log(`native @layer at-rules in the built CSS: ${nativeLayers}`)
console.log(nativeLayers === 0
  ? '  -> layer precedence NEVER applies; specificity then source order decide.\n'
  : '  -> WARNING: layers present, this tool\'s model is incomplete.\n')

for (const c of CASES) {
  console.log(`## ${c.name}`)
  const { winners } = resolve(c.el, PROPS)
  for (const p of ['outline', 'border-color', 'background', 'background-color', 'box-shadow']) {
    const w = winners[p]
    if (w) console.log(`   ${p.padEnd(17)} ${w.value}${w.important ? ' !important' : ''}   <- ${w.sel} (${w.spec.join(',')}) #${w.i}`)
  }
  if (!winners['outline']) console.log('   outline           (none set by any matching rule)')
  console.log()
}
