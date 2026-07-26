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

// Resolved relative to this script, not hardcoded. The absolute path this used
// to carry meant that running it from a git worktree silently compared the
// worktree's source against the MAIN checkout's build — an audit that can
// validate foreign or stale output is worse than none. Newest file, not
// alphabetically first, for the same reason.
const dir = path.resolve(import.meta.dirname, '../../../v2/assets')
const cssFile = fs.readdirSync(dir).filter(f => f.endsWith('.css'))
  .map(f => path.join(dir, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
if (!cssFile) { console.error('resolve-focus: no built CSS — run `npm run build` first.'); process.exit(2) }
const root = postcss.parse(fs.readFileSync(cssFile, 'utf8'))

// Native cascade layers would outrank specificity. Assert there are none, so the
// rest of this reasoning (specificity, then source order) is valid.
let nativeLayers = 0
root.walkAtRules('layer', () => nativeLayers++)

// Functional pseudos whose specificity is that of their most specific argument.
const FN_MAX = new Set([':not', ':is', ':has', ':matches', ':-moz-any', ':-webkit-any'])

/**
 * Specificity of a SINGLE complex selector, as [id, class, type].
 *
 * The first version of this was wrong in three ways, and since every conclusion
 * this tool draws rests on it, they were not cosmetic:
 *   1. It used `sels.walk()`, which recurses INTO :not()/:is()/:has() children —
 *      after the handler had already added those children's specificity. Every
 *      argument was counted twice, so `input:not([type="range"]):focus` reported
 *      (0,3,1) instead of (0,2,1), and `a:not(.b):not(.c)` reported (0,4,1)
 *      instead of (0,2,1). The bad (0,3,1) reached the commit message, the plan
 *      and two comments in index.css — where a note 2260 lines earlier had the
 *      correct (0,2,1) for the same selector all along.
 *   2. `:where()` fell through to the generic pseudo-class branch and scored
 *      (0,1,0). Per Selectors 4 it contributes ZERO, always.
 *   3. Comma-separated selectors were summed into one figure rather than
 *      evaluated individually.
 * The conclusions happened to survive — (0,2,1) still beats (0,2,0) on the type
 * component — but the margin is one TYPE unit, not one class unit, so any
 * (0,3,0) selector matching an input would really win while the inflated figure
 * said otherwise. That is a live false-negative class.
 */
function specificityOne(sel) {
  const s = [0, 0, 0]
  selparser(sels => {
    // sels is a Root of one selector here; walk but skip anything nested inside
    // a functional pseudo, which we account for ourselves.
    sels.walk(n => {
      // Skip anything nested inside ANY pseudo's parentheses. FN_MAX and :where
      // are accounted for explicitly below by recursing on their argument text;
      // every other functional pseudo's argument is NOT a selector list — the
      // `2n+1` in `:nth-child(2n+1)` was being read as tags and scored, which the
      // self-test at the bottom of this file caught.
      for (let p = n.parent; p; p = p.parent) {
        if (p.type === 'pseudo') return
      }
      if (n.type === 'id') s[0]++
      else if (n.type === 'class' || n.type === 'attribute') s[1]++
      else if (n.type === 'pseudo') {
        if (n.value === ':where') return                    // always zero
        if (FN_MAX.has(n.value)) {
          let best = [0, 0, 0]
          for (const g of n.nodes ?? []) {
            const inner = specificityOne(String(g).trim())
            if (cmp(inner, best) > 0) best = inner
          }
          s[0] += best[0]; s[1] += best[1]; s[2] += best[2]
        } else if (n.value.startsWith('::')) s[2]++
        // Pseudo-ELEMENTS count as type; pseudo-classes as class. `:nth-child(n)`
        // is a pseudo-class and its argument is not a selector, so it scores once.
        else s[1]++
      } else if (n.type === 'tag') s[2]++
    })
  }).processSync(sel)
  return s
}

/** Kept for call sites that pass one selector; asserts it really is one. */
function specificity(sel) {
  return specificityOne(sel)
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])

/** Does `sel` match this element?
 *
 *  Deliberately narrow — and it now actually REPORTS what it cannot judge, which
 *  the previous docstring claimed while `resolve()` allocated the `unknown` array
 *  inside its own loop and never read it. Combined with every CASE passing
 *  `ancestors: []`, that meant EVERY descendant-selector rule was silently
 *  discarded, including the four `.stage-navsearch input…` overrides that are
 *  exactly the kind of higher-specificity input rule this tool exists to find.
 *  A resolver that drops candidates without saying so reports a winner that may
 *  not be the winner. */
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
  // No tokens means we did not understand the selector — NOT that it matches.
  // Returning true here is what let `50%` match everything.
  if (!toks.length) { unknown.push(sel); return false }
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
  const unknown = []
  let i = 0
  root.walkRules(rule => {
    // Skip @keyframes. Its step selectors (`50%`, `from`) are not selectors at
    // all: the tokenizer produced ZERO tokens for `50%` and matches() returned
    // true on an empty token list, so every keyframe step matched every element.
    // That is how a plain <button> was reported as taking its winning box-shadow
    // from a rule called `50%` — which made every box-shadow answer this tool
    // printed unreliable.
    for (let a = rule.parent; a; a = a.parent) {
      if (a.type === 'atrule' && /keyframes$/.test(a.name)) return
    }
    const inMedia = rule.parent.type === 'atrule' && rule.parent.name === 'media'
    // Only unconditional rules and the always-true media contexts.
    const skip = inMedia && !/^\s*(screen|all)?\s*$/.test(rule.parent.params)
    for (const sel of rule.selectors) {
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
  // Expand the shorthands we care about to the longhand the cascade actually
  // resolves, so a (0,2,1) `background: X` and a (0,2,0) `background-color: Y`
  // compete for ONE property instead of being reported as two winners. Without
  // this the tool printed the call-site utility as winning `background-color`
  // while the commit that cited it said — correctly — that the global rule wins.
  const SHORTHAND = { background: 'background-color', border: 'border-color' }
  for (const c of cands) {
    if (SHORTHAND[c.prop]) {
      const m = c.value.match(/(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|transparent|currentColor)/)
      if (m) cands.push({ ...c, prop: SHORTHAND[c.prop], value: m[1], viaShorthand: c.prop })
    }
  }
  const winners = {}
  for (const c of cands) {
    const cur = winners[c.prop]
    const better = !cur
      || (c.important && !cur.important)
      || (c.important === cur.important && (cmp(c.spec, cur.spec) > 0
        || (cmp(c.spec, cur.spec) === 0 && c.i > cur.i)))
    if (better) winners[c.prop] = c
  }
  return { cands, winners, unknown }
}

const PROPS = ['outline', 'outline-color', 'outline-width', 'border', 'border-color',
  'border-width', 'border-style', 'background', 'background-color', 'box-shadow', 'all', 'opacity']

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
// This is the premise the whole cascade argument in index.css rests on, so it has
// to FAIL the run rather than print a warning and exit 0 — which is what it did
// while a comment claimed the claim was "enforced rather than asserted". If a
// Tailwind 4 upgrade introduces native layers, every conclusion here flips and the
// build should stop until the notes are rewritten.
if (nativeLayers !== 0) {
  console.error(`  -> FAIL: ${nativeLayers} native @layer at-rule(s) present. Layer precedence now`)
  console.error('     outranks specificity, so the reasoning in index.css above :focus-visible')
  console.error('     (and this tool\'s model) is no longer valid. Rewrite both before proceeding.')
  process.exit(1)
}
console.log('  -> layer precedence NEVER applies; specificity then source order decide.\n')

for (const c of CASES) {
  console.log(`## ${c.name}`)
  const { winners } = resolve(c.el, PROPS)
  for (const p of ['outline', 'border-color', 'background', 'background-color', 'box-shadow']) {
    const w = winners[p]
    if (w) console.log(`   ${p.padEnd(17)} ${w.value}${w.important ? ' !important' : ''}   <- ${w.sel} (${w.spec.join(',')}) #${w.i}${w.viaShorthand ? ` [via ${w.viaShorthand}]` : ''}`)
  }
  if (!winners['outline']) console.log('   outline           (none set by any matching rule)')
  const { unknown } = resolve(c.el, PROPS)
  if (unknown.length) {
    const uniq = [...new Set(unknown)]
    console.log(`   ⚠ ${uniq.length} selector(s) NOT EVALUATED (combinators or ancestor context this`)
    console.log(`     tool cannot judge). Any of these could be the real winner:`)
    for (const u of uniq.slice(0, 12)) console.log(`       ${u}`)
    if (uniq.length > 12) console.log(`       … and ${uniq.length - 12} more`)
  }
  console.log()
}

// Self-test the specificity function against the cases that were wrong before,
// so this file cannot silently regress into producing confident bad numbers.
const SPEC_TESTS = [
  ['input:not([type="range"]):focus', [0, 2, 1]],
  ['input:not([type="range"]):focus-visible', [0, 2, 1]],
  ['a:not(.b):not(.c)', [0, 2, 1]],
  [':where(.a) p', [0, 0, 1]],
  [':is(.a, #b) p', [1, 0, 1]],
  ['.focus\\:outline-none:focus', [0, 2, 0]],
  [':focus-visible', [0, 1, 0]],
  ['div::before', [0, 0, 2]],
  ['[data-x="y"] .c', [0, 2, 0]],
  ['li:nth-child(2n+1)', [0, 1, 1]],
]
let specFails = 0
for (const [sel, want] of SPEC_TESTS) {
  const got = specificity(sel)
  if (got.join(',') !== want.join(',')) {
    console.log(`SPEC SELF-TEST FAIL  ${sel}  got (${got.join(',')}) want (${want.join(',')})`)
    specFails++
  }
}
console.log(specFails ? `\n${specFails} specificity self-test failure(s).` : '\nspecificity self-tests: all pass.')
process.exit(specFails ? 1 : 0)
