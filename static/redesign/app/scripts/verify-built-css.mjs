// Resolve the BUILT stylesheet with PostCSS: specificity, source order, at-rule
// context, and which rule actually wins.
//
// Committed because grepping minified, escaped selectors produced six false
// verification reports across Phases 6 and 7 — a class is `.stage-scrub-knob` in
// source and `.stage-scrub-knob` in output, but `hover\:scale-110` is
// `.hover\:scale-110:hover`, colours are re-encoded as hex, and an order
// assertion is structurally blind to a specificity bug in the first place.
// Specificity resolves BEFORE source order; only a parser sees that.
//
// Run: npm run build && node scripts/verify-built-css.mjs   (from static/redesign/app)

// Resolve the built CSS with PostCSS. Never grep escaped selectors in minified
// output — that has produced six false reports across these phases.
import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import selparser from 'postcss-selector-parser'

const assets = '/home/user/AuroraPro.App/static/v2/assets'
const cssFile = fs.readdirSync(assets).filter(f => f.endsWith('.css')).sort()[0]
const css = fs.readFileSync(path.join(assets, cssFile), 'utf8')
const root = postcss.parse(css)

// Collect flat rules with source order + specificity, tracking at-rule context.
const rules = []
let i = 0
root.walkRules(rule => {
  const atctx = []
  let p = rule.parent
  while (p && p.type === 'atrule') { atctx.unshift(`@${p.name} ${p.params}`); p = p.parent }
  for (const sel of rule.selectors) {
    let spec = [0, 0, 0]
    try {
      selparser(sels => {
        sels.walk(n => {
          if (n.type === 'id') spec[0]++
          else if (n.type === 'class' || n.type === 'attribute') spec[1]++
          else if (n.type === 'pseudo') {
            if (n.value.startsWith('::')) spec[2]++
            else if ([':not', ':is', ':has'].includes(n.value)) { /* takes max of args; skip */ }
            else spec[1]++
          } else if (n.type === 'tag') spec[2]++
        })
      }).processSync(sel)
    } catch { /* ignore */ }
    rules.push({ i: i++, sel, spec, at: atctx.join(' | '), decls: rule.nodes.filter(n => n.type === 'decl') })
  }
})

const find = (pred) => rules.filter(pred)
const show = (label, pred, prop) => {
  const hits = find(pred)
  console.log(`\n## ${label}  (${hits.length} rule(s))`)
  for (const r of hits) {
    const d = prop ? r.decls.filter(x => x.prop === prop) : r.decls
    console.log(`  #${r.i} (${r.spec.join(',')}) ${r.at ? '[' + r.at + '] ' : ''}${r.sel}`)
    for (const x of d) console.log(`      ${x.prop}: ${x.value}`)
  }
}

// 1. The knob transform bug: is any rule still setting transform on the knob at
//    higher specificity than the centring rule?
show('scrub knob — every rule touching it', r => /stage-scrub-knob/.test(r.sel), 'transform')
show('scrub hover/focus rules', r => /stage-scrub(?!-)/.test(r.sel))
console.log('\n>> Winner for `transform` on .stage-scrub-knob under :hover of .stage-scrub:')
{
  const cands = find(r => /stage-scrub-knob/.test(r.sel) && r.decls.some(d => d.prop === 'transform'))
  const cmp = (a, b) => (a.spec[0] - b.spec[0]) || (a.spec[1] - b.spec[1]) || (a.spec[2] - b.spec[2]) || (a.i - b.i)
  const applicable = cands.filter(r => !r.at || /prefers-reduced-motion/.test(r.at) === false)
  applicable.sort(cmp)
  const w = applicable[applicable.length - 1]
  console.log(`   ${w.sel}  →  ${w.decls.filter(d => d.prop === 'transform').map(d => d.value).join('; ')}`)
  console.log(`   contains translate(-50%: ${/translate\(\s*-50%/.test(w.decls.map(d => d.value).join(''))}`)
}

// 2. New primitives emitted?
// `stage-party-dock` is gone on purpose: the theater re-anchor parked the
// minimized-party chip on the player title, so the chip is viewport-anchored
// again and the class + rule were removed.
const wanted = ['stage-controls-scrim', 'stage-player-topbar', 'stage-orb', 'stage-scrub',
  'stage-party-rail', 'stage-party-reactions']
console.log('\n## New primitives emitted')
for (const w of wanted) {
  const n = find(r => new RegExp(`\\.${w}(?![-\\w])`).test(r.sel)).length
  console.log(`  ${w}: ${n} rule(s)  ${n ? 'OK' : 'MISSING'}`)
}

// 3. Media-query forms — any remaining max-width boundary gaps?
console.log('\n## Media queries mentioning max-width (boundary-gap shape)')
const mq = new Set()
root.walkAtRules('media', a => { if (/max-width/.test(a.params)) mq.add(a.params) })
for (const m of mq) console.log('  ' + m)
console.log('\n## Media queries mentioning max-height')
const mh = new Set()
root.walkAtRules('media', a => { if (/max-height/.test(a.params)) mh.add(a.params) })
for (const m of mh) console.log('  ' + m)

// 4. reduced-motion coverage for the two transforms
console.log('\n## prefers-reduced-motion blocks containing stage-orb / stage-scrub')
root.walkAtRules('media', a => {
  if (!/prefers-reduced-motion/.test(a.params)) return
  const sels = []
  a.walkRules(r => sels.push(r.selector))
  const rel = sels.filter(s => /stage-orb|stage-scrub/.test(s))
  if (rel.length) console.log('  ' + rel.join(' | '))
})

// 5. Dead CSS: every stage-* class in CSS must appear in the built JS.
const js = fs.readdirSync(assets).filter(f => f.endsWith('.js'))
  .map(f => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n')
const cssClasses = new Set()
for (const r of rules) {
  for (const m of r.sel.matchAll(/\.(stage-[\w-]+)/g)) cssClasses.add(m[1])
}
const dead = [...cssClasses].filter(c => !js.includes(c)).sort()
console.log(`\n## stage-* classes in CSS: ${cssClasses.size}; not found in built JS: ${dead.length}`)
console.log('  ' + (dead.join(', ') || '(none)'))

// 6. scrollbar-gutter present on body?
show('body rules with scrollbar-gutter', r => r.decls.some(d => d.prop === 'scrollbar-gutter'))

// 7. theater inset variables
show('theater inset variables', r => r.decls.some(d => d.prop.startsWith('--theater-inset')))
