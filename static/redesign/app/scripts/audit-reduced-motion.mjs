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

console.log(`\n${problems} reduced-motion problem(s).`)
process.exit(problems ? 1 : 0)
