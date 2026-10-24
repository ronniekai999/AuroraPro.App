// Phase 11.3 — is every animation actually disabled under prefers-reduced-motion?
//
// WHY. `index.css` carries nine `prefers-reduced-motion` blocks and NOTHING
// verified any of them. (Nine, not the "11 rules" the first version of this
// comment and the plan both claimed — that figure was written before the work and
// never measured. The script itself printed 10 for a while, because its `@media`
// scan matched a PROSE mention of the query and brace-matched a live rule's body
// in as a tenth block; comments are stripped before scanning now.) A bug that only exists under a media query is invisible to every check
// that renders one state, and this codebase has already shipped two:
//
//   - `.stage-orb` had a transform-on-hover that "sat outside every
//     prefers-reduced-motion block in the file" — its own comment now says so.
//   - Phase 10b's review found the inverse failure: `.animate-fade-in { animation:
//     none !important }` under reduced motion stops that element being a STACKING
//     CONTEXT, which would have sent `.convo-search::before`'s `z-index: -1` halo
//     behind `.aurora-bg` and made it invisible — for exactly the users least
//     likely to report a missing animation.
//
// WHAT IT CHECKS.
//   1. Every `animation:` shorthand that names a keyframes set must be neutralised
//      inside some `@media (prefers-reduced-motion: reduce)` block, or be listed
//      in EXEMPT with a reason.
//   2. Every rule that declares `z-index: <negative>` must have a stacking-context
//      owner that does NOT depend on motion. This is check 1's blind spot: nulling
//      an animation is the RIGHT thing for accessibility and the exact thing that
//      broke the halo, so "is it disabled?" and "what did disabling it destroy?"
//      are different questions and only one of them was ever asked.
//
// Note the scope honestly: this reads index.css only. Animations declared in JSX
// via Tailwind's `animate-*` utilities resolve to the same keyframes, but a
// utility's reduced-motion behaviour is Tailwind's business, not this file's.

import fs from 'node:fs'
import path from 'node:path'

const CSS = 'src/index.css'
// Comments blanked, offsets preserved. The `@media … prefers-reduced-motion` scan
// matched PROSE: a comment mentioning the query (index.css does, above
// `.convo-search::before`) matched, then the body-extractor consumed forward to the
// next `{` and swallowed a LIVE rule into the "covered" set. It reported 10 blocks
// where there are 9, injected `animation: convo-breathe …` into that set, and let
// the class harvester read gradient numbers as class names (`.2rem`, `.45`, `.18s`).
// It is also an injection vector: naming the media query in a comment above any
// rule marked that rule covered.
const cssRaw = fs.readFileSync(CSS, 'utf8')
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))

/** Every className string in the app, so a base/variant pair can be resolved.
 *
 *  Needed because the reduced-motion rule and the animation rule routinely name
 *  DIFFERENT classes on the SAME element: `animation: onbDrift1` is declared on
 *  `.neb-l1`, the escape hatch is written against `.neb-l`, and the markup is
 *  `<span className="neb-l neb-l1" />`. The first version of this check compared
 *  only the first class of the declaring selector and reported seven covered
 *  animations as uncovered — a new gate's false positives are how a gate gets
 *  disabled, so this resolves the pair instead of guessing. */
function classSiblings(cls) {
  const bare = cls.replace(/^\./, '')
  const found = new Set()
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(e.name)) {
        const text = fs.readFileSync(full, 'utf8')
        for (const m of text.matchAll(/className=(?:"([^"]*)"|{`([^`]*)`}|{'([^']*)'})/g)) {
          const list = (m[1] ?? m[2] ?? m[3] ?? '').split(/\s+/)
          if (list.includes(bare)) for (const c of list) if (c) found.add('.' + c)
        }
      }
    }
  }
  walk('src')
  return found
}

// Animations that legitimately have no reduced-motion counterpart, each with the
// reason. An empty allowlist would be a lie; a silent skip would be worse.
// EMPTY, and it must stay empty until something genuinely needs it.
//
// It shipped with one entry, for `fadeIn`, and BOTH stated grounds were false — a
// review checked them against the CSS:
//   "a 0.4s opacity ramp with no movement"  — `@keyframes fadeIn` is
//        `from { opacity: 0; transform: translateY(10px) }`. That is real motion,
//        and index.css says so in its own words two thousand lines later.
//   "left running deliberately"             — it is nulled, at
//        `.animate-fade-in, .animate-slide-in { animation: none !important }`.
// So the check's "0 problems" was obtained by exempting the one animation whose
// nulling is the documented hazard, on a rationale the stylesheet contradicts.
// An allowlist entry is a claim; this one was two false claims, and the check
// passes without it.
const EXEMPT = new Map([])

let problems = 0

/** Every `@media (prefers-reduced-motion: reduce) { … }` body, brace-matched.
 *  A regex to the next `}` stops at the first nested rule's brace and silently
 *  reads a fraction of the block. */
function reducedMotionBodies() {
  const bodies = []
  const re = /@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{/g
  for (let m; (m = re.exec(css));) {
    let depth = 1, i = m.index + m[0].length
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
    }
    bodies.push(css.slice(m.index + m[0].length, i - 1))
  }
  return bodies
}

const rmBodies = reducedMotionBodies()
const rmText = rmBodies.join('\n')

console.log('## Check 1 — every animation has a reduced-motion escape hatch')
console.log(`  (${rmBodies.length} prefers-reduced-motion block(s) found)`)
if (!rmBodies.length) {
  console.log('  *** no reduced-motion blocks at all — that cannot be right.')
  problems++
}

const declared = new Set()
for (const m of css.matchAll(/(?:^|[;{])\s*animation:\s*([^;]+);/g)) {
  const value = m[1].trim()
  if (value === 'none' || value.startsWith('none')) continue
  // First identifier that is not a time, timing function or keyword.
  const name = value.split(/\s+/).find(t =>
    /^[A-Za-z][\w-]*$/.test(t) &&
    !['infinite', 'alternate', 'both', 'forwards', 'backwards', 'linear', 'ease',
      'ease-in', 'ease-out', 'ease-in-out', 'normal', 'reverse', 'running',
      'paused', 'none'].includes(t))
  if (name) declared.add(name)
}

for (const name of [...declared].sort()) {
  if (EXEMPT.has(name)) {
    console.log(`  exempt  ${name}\n          ${EXEMPT.get(name)}`)
    continue
  }
  // Neutralised if some reduced-motion block sets `animation: none` on a rule
  // whose selector mentions the same class the animation was declared on, OR the
  // keyframe name itself appears there.
  const owners = [...css.matchAll(
    new RegExp(String.raw`([^{}]+)\{[^{}]*animation:\s*${name}\b[^;]*;`, 'g'),
  )].map(x => x[1].trim().split('\n').pop().trim())
  // Per-RULE, not per-file. The first version tested `/animation:\s*none/` against
  // every reduced-motion body joined together, so once ANY block anywhere
  // contained `animation: none` the test was permanently true for EVERY animation
  // and the only remaining check was "does a class name appear somewhere in the
  // reduced-motion text". A review proved it: changing the real block's
  // `animation: none !important` to `opacity: 1 !important` let NINE animations run
  // at full speed under prefers-reduced-motion and the script still reported 0
  // problems. That was the entire premise of this check, and it did not hold.
  //
  // Now: find the rules inside reduced-motion blocks that actually null an
  // animation, and require one of THOSE rules' selectors to match the declaring
  // element.
  const nullingSelectors = new Set()
  for (const body of rmBodies) {
    for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/animation:\s*none/.test(m[2])) continue
      for (const c of m[1].matchAll(/\.[\w-]+/g)) nullingSelectors.add(c[0])
    }
  }
  const covered = owners.some(sel => {
    // EVERY class in the declaring selector, not just the first: `onbShine` is
    // declared on `.onb-mosaic-shimmer .onb-shine` and nulled on `.onb-shine`.
    const classes = [...sel.matchAll(/\.[\w-]+/g)].map(m => m[0])
    if (classes.some(c => nullingSelectors.has(c))) return true
    // …and any class that shares an element with one of them in the markup.
    return classes.some(c => [...classSiblings(c)].some(sib => nullingSelectors.has(sib)))
  })
  if (covered) {
    console.log(`  ok      ${name} (${owners.join(', ')})`)
  } else {
    console.log(`  ***     ${name} runs under prefers-reduced-motion — declared on ${owners.join(', ') || '?'}`)
    console.log('          Either null it in a reduced-motion block or add it to EXEMPT with a reason.')
    problems++
  }
}

console.log('\n## Check 1b — an element that STARTS hidden must be revealed, not just stilled')
// Check 1 asks whether an animation is nulled under reduced motion. That is the
// wrong question for a class that sets `opacity: 0` and relies on a `forwards`
// animation to become visible: `animation: none` on such a class freezes it at
// opacity 0 and the content is permanently invisible — strictly worse than the
// motion it was avoiding. index.css already documents this and keeps two
// separate selector lists for it, but nothing enforced the split, so the next
// author to add a rising element to the WRONG list would be told "ok".
//
// So: for every rule that sets opacity:0 AND a named animation, the
// reduced-motion block must actually restore its opacity, not merely stop it.
{
  let hiddenStarters = 0
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().split('\n').pop().trim()
    const body = m[2]
    if (!/opacity:\s*0(?![.\d])/.test(body)) continue
    if (!/animation:\s*(?!none)/.test(body)) continue
    hiddenStarters++
    const classes = [...sel.matchAll(/\.[\w-]+/g)].map(c => c[0])
    // Does some reduced-motion rule set a non-zero opacity on one of them?
    let revealed = false
    for (const rmBody of rmBodies) {
      for (const r of rmBody.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/opacity:\s*1/.test(r[2])) continue
        const rmClasses = [...r[1].matchAll(/\.[\w-]+/g)].map(c => c[0])
        if (classes.some(c => rmClasses.includes(c))) { revealed = true; break }
      }
      if (revealed) break
    }
    if (revealed) {
      console.log(`  ok      ${sel} starts hidden and is revealed under reduced motion`)
    } else {
      console.log(`  ***     ${sel} sets opacity:0 with a forwards-style animation but no`)
      console.log('          reduced-motion rule restores its opacity — it would be INVISIBLE,')
      console.log('          not merely still. Add opacity:1 for it in a reduced-motion block.')
      problems++
    }
  }
  if (!hiddenStarters) console.log('  (no rules start at opacity:0 with an animation)')
}

console.log('\n## Check 2 — negative z-index needs a MOTION-INDEPENDENT stacking context')
// The Phase 10b defect, generalised. An element painted at z-index:-1 escapes to
// the nearest ancestor stacking context; if that ancestor is only a stacking
// context because it is animating, then turning the animation off relocates the
// element behind an opaque background — visible ONLY under reduced motion.
const negZ = [...css.matchAll(/([^{}]+)\{[^{}]*z-index:\s*-\d+[^{}]*\}/g)]
  .map(m => m[1].trim().split('\n').pop().trim())

// …AND Tailwind's `-z-*` utilities in the markup. Scanning only the stylesheet was
// this check's own blind spot, and it was caught the hard way: Phase 11.4 added a
// `-z-10` band in HeroSection whose stacking context came from an animation, i.e.
// precisely the defect this check exists for, and the check reported the run
// clean because the class was in TSX. Its comment even anticipated
// utility-expressed contexts ("the vibe bar's comes from a `z-20` utility in
// App.tsx") while the scan never left the CSS.
const walkTsx = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkTsx(full, out)
    else if (/\.tsx$/.test(e.name)) out.push(full)
  }
  return out
}
const negZJsx = []
for (const file of walkTsx('src')) {
  const raw = fs.readFileSync(file, 'utf8')
  // Comments blanked, offsets preserved — same discipline as the CSS side, and for
  // the same reason it was needed there: the first version counted `-z-10` where it
  // appeared in PROSE, so the very comment explaining a usage was reported as a
  // second unannotated usage. These files are ~60% comment by volume.
  const text = raw
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
  for (const m of text.matchAll(/-z-\d+/g)) {
    const line = text.slice(0, m.index).split('\n').length
    negZJsx.push({ file, line, cls: m[0], raw, at: m.index })
  }
}
if (!negZ.length) console.log('  no negative z-index rules.')
for (const sel of negZ) {
  // The owner must be annotated with where its stacking context comes from. This
  // is a documentation-forcing check on purpose: whether a given ancestor is a
  // stacking context is not decidable from the stylesheet alone (the vibe bar's
  // comes from a `z-20` utility in App.tsx), so the check requires the author to
  // have said, and fails when nobody has.
  // The comment block IMMEDIATELY above the rule, not "somewhere in the previous
  // 1400 characters". The wide window auto-approved any negative-z rule authored
  // near an existing annotation — a review inserted `.brand-new-halo { z-index: -3 }`
  // and it passed on a token 1278 chars away belonging to a different rule.
  const at = cssRaw.indexOf(sel)
  const upto = cssRaw.slice(0, at)
  const lastClose = upto.lastIndexOf('}')
  const before = upto.slice(lastClose + 1)
  // An explicit `STACKING CONTEXT:` token, not the phrase "stacking context"
  // occurring anywhere nearby. A mutation caught the difference: deleting the
  // actual declaration still passed, because the surrounding prose discusses
  // stacking contexts in four other sentences — including one saying which
  // element is NOT one. Matching incidental prose would let a note that says the
  // opposite satisfy the check.
  const annotated = /STACKING CONTEXT:/.test(before)
  if (annotated) {
    console.log(`  ok      ${sel} — stacking context documented above the rule`)
  } else {
    console.log(`  ***     ${sel} paints at a negative z-index with no note saying`)
    console.log('          which ancestor contains it. If that ancestor is a stacking')
    console.log('          context only because it animates, this element disappears')
    console.log('          under prefers-reduced-motion. Say where it comes from.')
    problems++
  }
}

for (const hit of negZJsx) {
  // Same rule as the CSS side: an explicit token, near the usage.
  // Look in the RAW source (comments intact) immediately before the usage.
  const before = hit.raw.slice(Math.max(0, hit.at - 2500), hit.at)
  if (/STACKING CONTEXT:/.test(before)) {
    console.log(`  ok      ${hit.file}:${hit.line} ${hit.cls} — stacking context documented`)
  } else {
    console.log(`  ***     ${hit.file}:${hit.line} uses ${hit.cls} with no STACKING CONTEXT: note.`)
    console.log('          If the containing context comes from an animation, this')
    console.log('          element disappears under prefers-reduced-motion.')
    problems++
  }
}

console.log('\n## Check 3 — motion utilities in TSX have a reduced-motion path')
// Checks 1-2 read index.css. Motion written as Tailwind utilities in the markup —
// `hover:scale-105`, `data-[state=open]:animate-in` — never passes through this
// file's @media blocks, so it was invisible here: a review of the Stage refresh
// found nine call sites that scaled or lifted on hover with no reduced-motion
// path, and the Radix dialogs' zoom-and-fade ran for everyone.
//
// The rule, per class token in src/**/*.{ts,tsx} (tests excluded, comments
// blanked):
//   - A TRANSFORM utility (scale-, translate-, rotate-, skew-) behind a STATE
//     variant (hover:, focus:, active:, group-hover:, data-[…]:, aria-…:, …)
//     must also carry `motion-safe:` (or be a `motion-reduce:` override). A
//     state-driven transform is motion whenever a transition is on the element,
//     and when one is not it is still a jump the user did not ask for.
//   - An ANIMATION utility (`animate-*`, other than animate-none) must carry
//     `motion-safe:`/`motion-reduce:`, or — only when it has NO variant, so its
//     class name is literally `.animate-x` — be nulled by an
//     `animation: none` rule for `.animate-x` inside a reduced-motion block in
//     index.css (that is how .animate-fade-in, .animate-pulse and .animate-spin
//     are handled). A variant-prefixed one cannot be reached by such a rule: the
//     element's class is `data-[state=open]:animate-in`, not `animate-in`.
//   - An arbitrary-property animation class (`[animation:…]`) is an animation
//     utility like any other and needs `motion-safe:`.
//   - CSS injected through a component's own `<style>{`…`}</style>` may declare
//     `animation:` only inside a `prefers-reduced-motion: no-preference` block.
//   - An inline `animation:` in a style object beats every non-!important rule,
//     so it must be listed in INLINE_COVERED below with the index.css selector
//     that nulls it, and this check verifies that selector really sets
//     `animation: none !important` inside a reduced-motion block.
//
//   - A bare transform utility that shares a string literal with a bare
//     transition covering transform (`transition`, `transition-all`,
//     `transition-transform`, `transition-ui`) is a component-toggled transform
//     that animates: `isExpanded ? 'rotate-180 transition-transform' : …`. The
//     transition needs `motion-safe:` (or a `motion-reduce:transition-none`
//     beside it); the transform itself may stay, since it is the state.
//
// KNOWN LIMITS, stated rather than implied: a toggled bare transform whose
// transition sits in a DIFFERENT literal (`sel ? 'scale-110' : ''` beside a
// static `transition-ui`) is motion too, and this cannot see it — the token
// alone does not say whether it is toggled. Class names assembled from
// fragments at runtime are invisible. Neither is a reason to skip what IS
// decidable.
// Style-object animations and the index.css rule that nulls each — a claim this
// check verifies, not an exemption it takes on trust.
const INLINE_COVERED = new Map([
  ['src/components/ReactionOverlay.tsx',
    '.stage-party-reactions > div'],
])
{
  // `data-[side=…]`, `data-[align=…]` and `data-[orientation=…]` are PLACEMENT
  // facts Radix sets once per open (which side a popover opened on), not states
  // that toggle under the pointer, so a translate behind them is an offset, not
  // motion. Every other data-/aria- variant counts as state.
  const PLACEMENT = /^data-\[(side|align|orientation)\b/
  const STATE = /^(hover|focus|focus-visible|focus-within|active|visited|checked|disabled|enabled|open|target|group-[\w-]+|peer-[\w-]+|data-\[.*\]|aria-[\w-]+|aria-\[.*\]|group-data-\[.*\]|group-aria-[\w-]+)$/
  const TRANSFORM = /^-?(scale|translate|rotate|skew)(-[xy])?-/
  // Classes an index.css reduced-motion rule sets `animation: none` on.
  const nulled = new Set()
  for (const body of rmBodies) {
    for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/animation:\s*none/.test(m[2])) continue
      for (const c of m[1].matchAll(/\.([\w-]+)/g)) nulled.add(c[1])
    }
  }
  /** Split a class token on its top-level ':' — not the ones inside `[…]`. */
  const segments = tok => {
    const out = []; let depth = 0, cur = ''
    for (const ch of tok) {
      if (ch === '[') depth++
      else if (ch === ']') depth--
      if (ch === ':' && depth === 0) { out.push(cur); cur = '' } else cur += ch
    }
    out.push(cur)
    return out
  }
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, out)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full)
    }
    return out
  }
  let checked = 0, bad = 0
  for (const file of walk('src')) {
    const raw = fs.readFileSync(file, 'utf8')
    const text = raw
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
    const lineOf = i => text.slice(0, i).split('\n').length
    for (const m of text.matchAll(/[^\s"'`{}(),;<>]+/g)) {
      const tok = m[0]
      const seg = segments(tok)
      const util = seg[seg.length - 1]
      const variants = seg.slice(0, -1)
      const isTransform = TRANSFORM.test(util) && variants.length > 0
      const isAnim = (/^animate-[\w[\]-]+$/.test(util) && util !== 'animate-none') || /^\[animation:/.test(util)
      if (!isTransform && !isAnim) continue
      // Only class-like tokens: a bare word in prose (`scale-` in an identifier)
      // has no variant and is not an animate- utility, so it never gets here.
      checked++
      const guarded = variants.includes('motion-safe') || variants.includes('motion-reduce')
      let why = null
      if (isTransform && !guarded && variants.some(v => STATE.test(v) && !PLACEMENT.test(v))) {
        why = 'state-driven transform without motion-safe:'
      } else if (isAnim && !guarded) {
        if (variants.length || util.startsWith('[')) why = 'variant-prefixed or arbitrary animation without motion-safe: (an index.css rule cannot reach it)'
        else if (!nulled.has(util)) why = `.${util} is not nulled by an animation: none rule in a reduced-motion block`
      }
      if (why) {
        bad++
        console.log(`  ***     ${file}:${lineOf(m.index)} ${tok}`)
        console.log(`          ${why}`)
      }
    }
    // A toggled bare transform and its transition in one literal (see the rule
    // list above). Missed by the first version of this check, which only read
    // variant-prefixed transforms: the request rows' chevron kept rotating for
    // reduced-motion users after the commit that said everything was guarded.
    for (const lit of text.matchAll(/(['"`])((?:(?!\1)[^\\\n])*)\1/g)) {
      const toks = lit[2].split(/\s+/)
      if (!toks.some(t => TRANSFORM.test(t))) continue
      const trans = toks.filter(t => /^(transition|transition-all|transition-transform|transition-ui)$/.test(t))
      if (!trans.length || toks.includes('motion-reduce:transition-none')) continue
      checked++
      bad++
      console.log(`  ***     ${file}:${lineOf(lit.index)} ${toks.filter(t => TRANSFORM.test(t)).join(' ')} … ${trans.join(' ')}`)
      console.log('          a toggled transform animates through an unguarded transition: use motion-safe:' + trans[0])
    }
    // CSS a component injects itself: every `animation:` must sit inside a
    // no-preference block of that same stylesheet.
    for (const sm of text.matchAll(/<style>\{`([\s\S]*?)`\}<\/style>/g)) {
      const sheet = sm[1]
      const safe = []
      for (const q of sheet.matchAll(/@media[^{]*prefers-reduced-motion:\s*no-preference[^{]*\{/g)) {
        let depth = 1, i = q.index + q[0].length
        for (; i < sheet.length && depth > 0; i++) { if (sheet[i] === '{') depth++; else if (sheet[i] === '}') depth-- }
        safe.push([q.index, i])
      }
      for (const a of sheet.matchAll(/(?<![\w-])animation\s*:\s*(?!none)/g)) {
        if (safe.some(([lo, hi]) => a.index > lo && a.index < hi)) continue
        bad++
        console.log(`  ***     ${file}:${lineOf(sm.index + 9 + a.index)} injected <style> declares an animation outside a prefers-reduced-motion: no-preference block`)
      }
    }
    // Style objects: `animation: '…'` / `animation: \`…\`` (a quoted value — CSS
    // text and arbitrary classes have none).
    for (const m of text.matchAll(/(?<![\w[-])animation(Name)?\s*:\s*[`'"]/g)) {
      const cover = INLINE_COVERED.get(file)
      const esc = cover && cover.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (cover && new RegExp(String.raw`${esc}\s*(,[^{]*)?\{[^}]*animation:\s*none\s*!important`).test(rmText)) {
        console.log(`  ok      ${file}:${lineOf(m.index)} inline animation — nulled by ${cover} { animation: none !important }`)
        continue
      }
      bad++
      console.log(`  ***     ${file}:${lineOf(m.index)} inline animation in a style object with no verified reduced-motion null${cover ? ` (${cover} was named, but no reduced-motion block sets animation: none !important on it)` : ''}`)
    }
  }
  console.log(`  (${checked} motion utilit${checked === 1 ? 'y' : 'ies'} examined)`)
  if (!bad) console.log('  every one has a reduced-motion path.')
  problems += bad
}

// ── Check 4 — an animation that never ends is compositor-only ─────────────
// Not a reduced-motion rule, but a motion one this file is placed to see. The
// Stage refresh's first loading sheen animated `background-position` with
// `infinite`; a lazy poster that is never requested never loads, so on an idle
// Home 16-51 of them repainted on the main thread every frame (~350ms per 3s,
// measured). A keyframe set that runs forever may move only `transform` and
// `opacity`, which the compositor animates without main-thread paints. A
// bounded one (a count, not `infinite`) is not held to this. Scope: index.css.
{
  console.log('\n## Check 4 — infinite animations animate only transform and opacity')
  // Pre-existing, from before the rule; listed by name so anything NEW fails,
  // and checked for staleness so the list cannot outlive its reason.
  const KNOWN = new Map([
    ['onbShimmer', "the onboarding headline's background-clip:text gradient (#482); a fill that IS the text cannot move by transform. Reported for follow-up."],
  ])
  const COMPOSITOR = new Set(['transform', 'opacity'])
  const keyframeProps = new Map()
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1, i = m.index + m[0].length
    for (; i < css.length && depth > 0; i++) { if (css[i] === '{') depth++; else if (css[i] === '}') depth-- }
    const body = css.slice(m.index + m[0].length, i - 1)
    const props = new Set([...body.matchAll(/(?:^|[{;\s])([a-z-]+)\s*:/g)].map(x => x[1]))
    keyframeProps.set(m[1], new Set([...(keyframeProps.get(m[1]) ?? []), ...props]))
  }
  const forever = new Map() // keyframe name → first line that runs it forever
  for (const m of css.matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1]
    const line = css.slice(0, m.index).split('\n').length
    for (const d of body.matchAll(/(?:^|;)\s*animation\s*:\s*([^;]*)/g)) {
      for (const layer of d[1].split(/,(?![^(]*\))/)) {
        if (!/\binfinite\b/.test(layer)) continue
        for (const tok of layer.trim().split(/\s+/)) if (keyframeProps.has(tok) && !forever.has(tok)) forever.set(tok, line)
      }
    }
    if (/animation-iteration-count\s*:\s*infinite/.test(body)) {
      const n = body.match(/animation-name\s*:\s*([\w-]+)/)
      if (n && keyframeProps.has(n[1]) && !forever.has(n[1])) forever.set(n[1], line)
    }
  }
  let bad = 0
  for (const [name, line] of forever) {
    const off = [...keyframeProps.get(name)].filter(p => !COMPOSITOR.has(p))
    if (!off.length) { console.log(`  ok      ${name} (index.css:${line})`); continue }
    if (KNOWN.has(name)) { console.log(`  known   ${name} animates ${off.join(', ')} forever — ${KNOWN.get(name)}`); continue }
    bad++
    console.log(`  ***     ${name} (index.css:${line}) runs forever and animates ${off.join(', ')}: main-thread paint every frame. Animate transform/opacity, or bound the count.`)
  }
  for (const name of KNOWN.keys()) {
    const off = forever.has(name) && [...(keyframeProps.get(name) ?? [])].some(p => !COMPOSITOR.has(p))
    if (!off) { bad++; console.log(`  ***     ${name} is listed as a known exception but no longer is one; remove it from KNOWN`) }
  }
  if (!bad) console.log('  every infinite animation is compositor-only (or a listed pre-existing exception).')
  problems += bad
}

console.log(`\n${problems} reduced-motion problem(s).`)
process.exit(problems ? 1 : 0)
