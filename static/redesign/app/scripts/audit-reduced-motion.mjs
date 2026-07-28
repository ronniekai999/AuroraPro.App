// Phase 11.3 — is every animation actually disabled under prefers-reduced-motion?
//
// WHY. `index.css` carries reduced-motion blocks and NOTHING verified any of
// them. A bug that only exists under a media query is invisible to every check
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
const css = fs.readFileSync(CSS, 'utf8')

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
const EXEMPT = new Map([
  ['fadeIn', 'A 0.4s opacity ramp with no movement. WCAG 2.3.3 targets motion, and ' +
             'this element is ALSO a stacking context by virtue of its animation — ' +
             'nulling it is what broke the vibe bar halo in Phase 10b. Left running ' +
             'deliberately; see check 2.'],
])

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
  const covered = owners.some(sel => {
    if (!/animation:\s*none/.test(rmText)) return false
    // EVERY class in the declaring selector, not just the first: `onbShine` is
    // declared on `.onb-mosaic-shimmer .onb-shine` and nulled on `.onb-shine`.
    const classes = [...sel.matchAll(/\.[\w-]+/g)].map(m => m[0])
    const rmClasses = new Set([...rmText.matchAll(/\.[\w-]+/g)].map(m => m[0]))
    if (classes.some(c => rmClasses.has(c))) return true
    // …and any class that shares an element with one of them in the markup.
    return classes.some(c => [...classSiblings(c)].some(sib => rmClasses.has(sib)))
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
if (!negZ.length) console.log('  no negative z-index rules.')
for (const sel of negZ) {
  // The owner must be annotated with where its stacking context comes from. This
  // is a documentation-forcing check on purpose: whether a given ancestor is a
  // stacking context is not decidable from the stylesheet alone (the vibe bar's
  // comes from a `z-20` utility in App.tsx), so the check requires the author to
  // have said, and fails when nobody has.
  const at = css.indexOf(sel)
  const before = css.slice(Math.max(0, at - 1400), at)
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

console.log(`\n${problems} reduced-motion problem(s).`)
process.exit(problems ? 1 : 0)
