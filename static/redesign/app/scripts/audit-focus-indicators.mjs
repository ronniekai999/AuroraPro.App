// Guard against the project's most-repeated bug: a control that suppresses the
// global :focus-visible outline and supplies nothing visible in its place.
//
// It has happened four times (the admin tabpanel in Phase 6, twice more in 7a,
// and the whole input population found in Phase 8). It keeps happening because
// the suppression is one innocuous-looking utility, and because a comment on the
// floor rule asserted — wrongly — that the floor could not be suppressed. See the
// corrected note above `:focus-visible` in index.css.
//
// ⚠️ CHECK 1 REWRITTEN after review. Its first version had four independent
// surviving mutations, including the exact defect class it exists to catch:
//   - Its `REPLACEMENT` regex accepted `focus:bg-*` and `focus:border-*`. The SAME
//     COMMIT measured those at 1.047:1 and 2.42:1 and called them "a tint, not an
//     indicator". 11 of 18 sites passed on nothing else. Swapping a real ring on
//     ProfileSwitcher (a <button>) for `focus:bg-white/[0.06]` — 1.024:1, total
//     loss of focus indication — reported 0 problems.
//   - It searched a ±4-LINE window with no tie to the element, so a replacement
//     belonging to a different element four lines away counted.
//   - `stripComments` blanked the rest of any line containing a regex literal
//     with `//` in it (live in six files today), and a regex containing `/*`
//     opened a fake block comment swallowing everything to the next `*/`.
//   - It skipped all of `src/components/ui/`, three of which ARE imported by
//     first-party code, and which carry bare unprefixed `outline-none` too.
//
// Five checks:
//   1. Every first-party outline suppression must be on an element whose own
//      opening tag supplies a real indicator (ring / shadow / explicit outline),
//      or be an input-family element covered by check 2, or be listed in ALLOWED.
//   2. The global input :focus treatment — which the input exemption makes the
//      only indicator for text fields that don't reset it — must clear 3:1.
//   3. Every container that resets that treatment supplies its own indicator.
//   4. Those resets still outrank the global focus rule.
//   5. Every <button> whose content names nothing has an accessible name
//      (aria-label, aria-labelledby or title). The notification panel's close
//      button had none: a screen reader announced it as "button".
//
// Run: node scripts/audit-focus-indicators.mjs

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { selectorSpecificity, compareSpecificity } from './resolve-focus.mjs'

const ts = createRequire(import.meta.url)('typescript')

const SRC = 'src'
const CSS = 'src/index.css'

// A real indicator PAINTS something: a ring, a shadow, or an explicit outline.
// `focus:bg-*` and `focus:border-*` are deliberately NOT accepted — see the note
// above. If a control genuinely relies on one, measure it and put it in ALLOWED
// with the figure, which is what "deliberate" should cost.
const REAL_INDICATOR = /focus(-visible)?:(ring(-|\b)|shadow-|outline-(?!none))/
const INPUT_FAMILY = new Set(['input', 'textarea', 'select'])

const ALLOWED = new Map([
  ['src/companion/JoinScreen.tsx:176',
    'Invisible (opacity-0) overlay input for OTP-style entry. NOTE: the box ' +
    'treatment it delegates to is gated on `isCursor && !filled`, so once all ' +
    'six characters are entered NOTHING indicates focus — tracked as a real ' +
    'defect, fixed separately; this entry documents the delegation, not that it works.'],
])

let problems = 0

/** Blank every comment while preserving line numbers. Handles regex literals and
 *  division, which the first version did not: a `/^https?:\/\//` blanked the rest
 *  of its line, and a regex containing `/*` opened a fake block comment. */
function stripComments(src) {
  const out = src.split('')
  let i = 0, inS = null, inLine = false, inBlock = false, inRe = false
  // Tokens after which a `/` starts a REGEX rather than a division.
  const reAllowedBefore = /[=(,:[!&|?{};+\-*%~^<>]|\breturn\b|\btypeof\b|\bcase\b/
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (inLine) { if (c === '\n') inLine = false; else out[i] = ' '; i++; continue }
    if (inBlock) {
      if (c === '*' && n === '/') { out[i] = out[i + 1] = ' '; inBlock = false; i += 2; continue }
      if (c !== '\n') out[i] = ' '
      i++; continue
    }
    if (inRe) {
      if (c === '\\') { i += 2; continue }
      if (c === '[') { while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++ } i++; continue }
      if (c === '/') inRe = false
      if (c === '\n') inRe = false   // unterminated; bail rather than run away
      i++; continue
    }
    if (inS) {
      if (c === '\\') { i += 2; continue }
      if (c === inS) inS = null
      i++; continue
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; i++; continue }
    if (c === '/') {
      // Regex or comment? Look back at the last non-space character.
      let j = i - 1
      while (j >= 0 && /\s/.test(src[j])) j--
      const prev = src.slice(Math.max(0, j - 6), j + 1)
      if (n === '/' ) { out[i] = out[i + 1] = ' '; inLine = true; i += 2; continue }
      if (n === '*') { out[i] = out[i + 1] = ' '; inBlock = true; i += 2; continue }
      if (j < 0 || reAllowedBefore.test(prev.slice(-1)) || /\b(return|typeof|case)$/.test(prev)) {
        inRe = true; i++; continue
      }
      i++; continue   // division
    }
    i++
  }
  return out.join('')
}

/** The full JSX opening tag containing `pos`, and its tag name. Scoping to the
 *  real element is what kills the ±4-line-window false negative. */
function enclosingTag(src, pos) {
  // Collect candidate tag starts before `pos`, nearest first, and return the
  // first whose own closing '>' lies at or after `pos`. Scanning backward and
  // stopping at the first '>' does NOT work: attribute values routinely contain
  // one (`onChange={e => …}`), which made every site report "cannot judge".
  const starts = []
  for (let i = pos; i >= 0; i--) {
    if (src[i] === '<' && /[A-Za-z]/.test(src[i + 1] ?? '')) starts.push(i)
    if (starts.length > 40) break
  }
  const tagEnd = start => {
    let depth = 0, q = null
    for (let i = start; i < src.length; i++) {
      const c = src[i]
      if (q) { if (c === '\\') { i++; continue } if (c === q) q = null; continue }
      if (c === '"' || c === "'" || c === '`') { q = c; continue }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) return i
    }
    return -1
  }
  let start = -1, end = -1
  for (const cand of starts) {
    const e = tagEnd(cand)
    if (e >= pos) { start = cand; end = e; break }
  }
  if (start < 0) return null
  const text = src.slice(start, end + 1)
  const name = (text.match(/^<([A-Za-z][\w.]*)/) ?? [])[1] ?? ''
  return { text, name }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

// Vendored shadcn/ui primitives that NOTHING outside src/components/ui/ imports.
// They are scaffolding: present in the tree, mounted nowhere, so their focus
// behaviour is unreachable and reporting it is noise.
//
// Computed rather than hard-coded, because a hard-coded allowlist for this would
// be a lie the moment someone actually used one. If a single file outside ui/
// imports the module, the exemption evaporates and the suppression is reported
// like any other. The allowlist decays loudly instead of silently.
const UI_DIR = path.join(SRC, 'components', 'ui')
const importedFromOutsideUi = (() => {
  const importers = new Set()
  for (const file of walk(SRC)) {
    if (file.startsWith(UI_DIR)) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/from\s+['"](?:@\/components\/ui|\.\/ui|\.\.\/ui)\/([\w-]+)['"]/g)) {
      importers.add(m[1])
    }
  }
  return importers
})()

console.log('## Check 1 — outline suppression without a real indicator')
let checked = 0
let dormant = 0
for (const file of walk(SRC)) {
  const stripped = stripComments(fs.readFileSync(file, 'utf8'))
  // Bare `outline-none` counts too: at (0,1,0) it loses to the floor, but inside
  // a rule that also carries a focus variant it is a second suppression, and in
  // vendored components it is often the only one.
  //
  // The regex used to be /focus(-visible)?:outline-none/, which cannot match bare
  // `outline-none` at all — so for three phases this comment described a behaviour
  // the code did not have, and the vendored case it calls out ("often the only
  // one") was the exact case being missed: every one of the nine sites the widened
  // pattern finds is in src/components/ui/.
  for (const m of stripped.matchAll(/(?:focus(?:-visible)?:)?outline-none/g)) {
    checked++
    const line = stripped.slice(0, m.index).split('\n').length
    const ref = `${file}:${line}`
    const mod = file.startsWith(UI_DIR) ? path.basename(file).replace(/\.tsx?$/, '') : null
    if (mod && !importedFromOutsideUi.has(mod)) { dormant++; continue }
    const tag = enclosingTag(stripped, m.index)
    if (!tag) { console.log(`  *** ${ref} suppression not inside a JSX tag — cannot judge`); problems++; continue }
    if (REAL_INDICATOR.test(tag.text)) continue
    if (INPUT_FAMILY.has(tag.name)) continue          // covered by check 2
    if (ALLOWED.has(ref)) { console.log(`  allowed  ${ref}\n           ${ALLOWED.get(ref)}`); continue }
    console.log(`  *** ${ref} <${tag.name}> suppresses the focus outline with no ring/shadow/outline`)
    problems++
  }
}
if (dormant) {
  console.log(`  (${dormant} site(s) skipped in unmounted vendored ui/ primitives —`)
  console.log('   reported as soon as anything outside components/ui/ imports them)')
}
console.log(`  (${checked} suppression site(s) examined)`)
if (!problems) console.log('  no unguarded suppressions.')

/** Containers whose descendant rule resets the global input :focus treatment.
 *
 *  Matches the WHOLE `:not()` chain before `:focus`. This used to be
 *  `input:not\(\[type="range"\]\):focus` — i.e. `:focus` directly after the
 *  range exclusion — which stopped matching every real resetter the day the
 *  global rule gained its checkbox/radio exclusions and the resets were widened
 *  to match it (`…:not([type="range"]):not([type="checkbox"]):not([type="radio"]):focus`).
 *  From then on Check 3 printed "no containers reset the global treatment —
 *  nothing to check" while Check 4, three lines further down the same output,
 *  listed two of them: the check existed, ran, and verified nothing. Deleting
 *  `.convo-search:focus-within` — the vibe bar's only focus indicator — left
 *  the gate green. Same family as Check 4's own selector scan below, so the two
 *  checks can no longer disagree about which containers exist. */
function resettersIn(text) {
  return [...new Set(
    [...text.matchAll(/^\s*(\.[\w-]+) input:not\(\[type="range"\]\)(?::not\([^)]*\))*:focus(?=[,\s{])/gm)].map(x => x[1])
  )]
}

console.log('\n## Check 2 — the global input :focus treatment still clears 3:1')
const css = fs.readFileSync(CSS, 'utf8')
// Located by its select/textarea branches rather than by the full selector text.
// Pinning the exact string made this check fail the moment checkbox/radio
// exclusions were added to the input branch — a guard that breaks when the rule
// it guards is legitimately edited trains people to delete the guard.
const m = css.match(/select:not\(\[hidden\]\):focus,\s*\n?\s*textarea:not\(\[hidden\]\):focus\s*\{([^}]*)\}/)
if (!m) {
  console.log('  *** the global select/textarea :focus branches are not in the expected form.')
  console.log('      NOTE the `:not([hidden])` on the select/textarea branches is required:')
  console.log('      bare `select:focus, textarea:focus` scores (0,1,1) and LOSES to a')
  console.log('      call-site focus:border-* at (0,2,0), which is how two textareas kept')
  console.log('      a 2.19:1 indicator while the input branch at (0,2,1) overrode its call sites.')
  problems++
} else {
  const body = m[1]
  const bc = body.match(/border-color:\s*(rgba?\([^)]*\))/)
  const bg = body.match(/background:\s*(rgba?\([^)]*\))/)
  if (!bc || !bg) { console.log('  *** rule no longer sets border-color + background'); problems++ }
  else {
    const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
    const Y = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    const over = (f, a, b) => f.map((c, i) => a * c + (1 - a) * b[i])
    const ratio = (a, b) => { const [l1, l2] = [Y(a), Y(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05) }
    const parse = str => { const n = str.match(/[\d.]+/g).map(Number); return { rgb: n.slice(0, 3).map(v => v / 255), a: n[3] ?? 1 } }
    const B = parse(bc[1]), G = parse(bg[1])
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    for (const [name, panel] of [['#0a0a0f', hex('#0a0a0f')], ['#050505', hex('#050505')], ['#141420', hex('#141420')]]) {
      const fill = over(G.rgb, G.a, panel)
      const border = over(B.rgb, B.a, fill)
      const r = ratio(border, fill)
      const ok = r >= 3
      if (!ok) problems++
      console.log(`  on ${name}: focus border vs field fill ${r.toFixed(2)}:1  ${ok ? 'PASS' : '*** FAIL (need 3.0)'}`)
    }
    // Containers that RESET this treatment take on the duty themselves. Check 2's
    // premise used to be "this is the ONLY indicator for every text field", which
    // is false wherever a `.x input:...:focus` descendant rule nulls it — those
    // are (0,5,1) and win. List them so the claim stays honest.
    const resetters = resettersIn(css)
    if (resetters.length) {
      console.log(`  note: ${resetters.length} container(s) reset this treatment (see Check 4) and`)
      console.log(`        must supply their own indicator — ${resetters.join(', ')}`)
      console.log('        (checked below)')
    }
  }
}

// ── Check 3 — the resetters actually DO supply one ────────────────────────────
//
// Check 2 used to end at the `note:` above: it named the containers that null the
// global treatment, stated in so many words that they "must supply their own
// :focus-within indicator", and then never looked. The block only console.log'd —
// it never touched `problems`. So deleting `.convo-search:focus-within` outright,
// which is the vibe search bar's ONLY focus indicator once the global rule is
// nulled at (0,3,1), left the gate at exit 0 with the words "must supply their own
// :focus-within indicator" still printed in its own passing output.
//
// That is precisely the defect class this file's header says it exists to catch,
// and it is worse than having no check: a guard that names a duty and does not
// enforce it reads, to anyone skimming the output, as evidence the duty is met.
console.log('\n## Check 3 — every container that resets it supplies its own indicator')
{
  const resetters = resettersIn(css)
  if (!resetters.length) {
    console.log('  no containers reset the global treatment — nothing to check.')
  }
  for (const name of resetters) {
    // `:focus-within`, not `:focus`: the container is a wrapper, the focus lands on
    // a descendant input, so `.x:focus` would never match. Matched inside a selector
    // LIST so a rule shared with a sibling container still counts.
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // `:focus-within` must be followed by whitespace and then `{` or `,` — nothing
    // else. Written loosely first (`[^{,]*` before the brace) it also matched
    // `.convo-search:focus-within::before`, the halo's opacity bump at
    // index.css:476, and reported "exists but sets no indicator" for a rule that
    // had been DELETED. Right verdict, wrong reason — and a pseudo-element or a
    // descendant rule is not the container's own indicator in any case.
    const rule = css.match(new RegExp(`(^|,)\\s*${esc}:focus-within\\s*(,[^{]*)?\\{([^}]*)\\}`, 'm'))
    if (!rule) {
      console.log(`  *** ${name} nulls the global :focus treatment and defines no`)
      console.log(`      ${name}:focus-within rule — the field has NO focus indicator.`)
      problems++
      continue
    }
    const body = rule[3]
    // What counts as visible. `border-color` alone counts because that is exactly
    // what `.stage-navsearch:focus-within` leads with, and its 7.07–8.27:1 is
    // measured in Check 2's own comment. A `box-shadow: none` does not count.
    // Read the VALUE out and compare it, rather than trying to express "not none"
    // as a lookahead. The first version was `/box-shadow:\s*(?!none)[^;]+/`, and it
    // passed `box-shadow: none` — `\s*` backtracks to zero width, so the lookahead
    // ran against " none" (leading space) and succeeded. A mutation caught it; the
    // regex would have declared a gutted indicator healthy.
    const value = prop => {
      const d = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]*)`))
      return d ? d[1].trim().replace(/\s+/g, ' ') : null
    }
    const shadow = value('box-shadow')
    const outline = value('outline')
    const border = value('border-color')
    const hasShadow = !!shadow && shadow !== 'none'
    const hasOutline = !!outline && outline !== 'none' && outline !== '0'
    const hasBorder = !!border
    if (!hasShadow && !hasOutline && !hasBorder) {
      console.log(`  *** ${name}:focus-within exists but sets no box-shadow, outline`)
      console.log('      or border-color — nothing visible marks the focused field.')
      problems++
      continue
    }
    const via = [hasShadow && 'box-shadow', hasOutline && 'outline', hasBorder && 'border-color']
      .filter(Boolean).join(' + ')
    console.log(`  ${name}:focus-within supplies an indicator (${via})  PASS`)
  }
}

// ── Check 4 — the resets actually OUTRANK the rule they reset ─────────────────
//
// Check 3 asks whether the container supplies its own indicator. This asks the
// prior question: does its reset of the inner <input> still win?
//
// It did not. Both `.stage-navsearch input…:focus` and `.convo-search input…:focus`
// were written as (0,3,1) against a global focus rule that was (0,2,1) at the
// time. The global later gained `:not([type="checkbox"]):not([type="radio"])` —
// two more class units, taking it to (0,4,1) — and silently overtook both. From
// then on the global treatment (lavender border, a fill, and a 3px purple ring)
// painted a nested ring inside each wrapper's own focus indicator, which is the
// precise thing both reset rules exist to prevent, and every comment involved
// still quoted the pre-regression figure.
//
// Nothing caught it because nothing re-derived the comparison when the global
// rule changed. Check 2's guard is deliberately loose about that rule's exact
// text — see its comment — which is right for Check 2 and is exactly what let
// this through. So compare the numbers, every run.
console.log('\n## Check 4 — those resets still outrank the global focus rule')
{
  const selectorsOf = re => [...css.matchAll(re)].map(m => m[0].trim())
  const globalFocus = selectorsOf(/^input:not\([^{]*?:focus(?:-visible)?(?=[,\s{])/gm)
  if (!globalFocus.length) {
    console.log('  *** could not find the global input :focus rule to compare against.')
    problems++
  } else {
    // The strongest global variant is what a container has to beat.
    let worst = globalFocus[0]
    for (const g of globalFocus) if (compareSpecificity(selectorSpecificity(g), selectorSpecificity(worst)) > 0) worst = g
    const gs = selectorSpecificity(worst)
    console.log(`  global: (${gs}) ${worst}`)
    const resets = [...new Set(
      [...css.matchAll(/^\.[\w-]+ input:not\([^{]*?:focus(?=[,\s{])/gm)].map(x => x[0].trim())
    )]
    if (!resets.length) { console.log('  no container :focus resets found — nothing to compare.') }
    for (const r of resets) {
      const rs = selectorSpecificity(r)
      const wins = compareSpecificity(rs, gs) > 0
      if (!wins) problems++
      console.log(`  (${rs}) ${r}`)
      console.log(`         ${wins ? 'PASS — outranks the global rule'
        : '*** FAIL — LOSES to the global rule, which will paint its own ring inside this container'}`)
    }
  }
}

// ── Check 5 — icon-only buttons have an accessible name ──────────────────────
//
// Parsed with the TypeScript compiler, not matched: whether a button's content
// names it is a question about JSX structure (`{busy ? <Spinner/> : <X/>}`
// names nothing, `{label}` may), which a regex cannot answer.
//
// What names a button: a non-empty aria-label, aria-labelledby or title on it
// (an expression counts, an empty string does not), or content that does. Its
// content names it when it holds text (JSX text, a non-blank string, or any
// expression that may hold one), an <img> with a non-empty alt, or an element
// with a non-empty aria-label or aria-labelledby. Text inside aria-hidden names
// nothing. A spread (`{...props}`) may carry the name, so it passes.
//
// One assumption, the other way: a self-closing component (`<Icon name="x"/>`)
// is taken to render no text, because that is what the icons do. A component
// that renders its own text or label inside a button would be flagged here;
// name the button. Not covered: elements given role="button", links, and the
// Radix primitives (their own components name their controls).
{
  console.log('\n## Check 5 — every icon-only button has an accessible name')
  const NAMING = new Set(['aria-label', 'aria-labelledby', 'title'])
  const attrsOf = el => (ts.isJsxElement(el) ? el.openingElement : el).attributes.properties
  const tagOf = el => (ts.isJsxElement(el) ? el.openingElement : el).tagName.getText()
  // Whether an attribute's value is non-empty. An expression may hold a name.
  const hasValue = a => {
    if (!a.initializer) return false
    if (ts.isStringLiteral(a.initializer)) return a.initializer.text.trim() !== ''
    const e = a.initializer.expression
    if (!e) return false
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text.trim() !== ''
    return true
  }
  const attr = (el, name) => attrsOf(el).find(a => ts.isJsxAttribute(a) && a.name.getText() === name)
  const hidden = el => {
    const a = attr(el, 'aria-hidden')
    if (!a) return false
    if (!a.initializer) return true
    if (ts.isStringLiteral(a.initializer)) return a.initializer.text === 'true'
    const e = a.initializer.expression
    return !!e && (e.kind === ts.SyntaxKind.TrueKeyword || (ts.isStringLiteral(e) && e.text === 'true'))
  }
  const names = node => {
    if (!node) return false
    if (ts.isJsxText(node)) return node.text.trim() !== ''
    if (ts.isJsxExpression(node)) return names(node.expression)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.trim() !== ''
    if (ts.isParenthesizedExpression(node)) return names(node.expression)
    if (ts.isConditionalExpression(node)) return names(node.whenTrue) || names(node.whenFalse)
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return names(node.right)
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return names(node.left) || names(node.right)
      return true
    }
    if ([ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(node.kind)) return false
    if (ts.isIdentifier(node) && node.text === 'undefined') return false
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (hidden(node)) return false
      const label = ['aria-label', 'aria-labelledby'].some(n => { const a = attr(node, n); return !!a && hasValue(a) })
      if (label) return true
      if (tagOf(node) === 'img') { const alt = attr(node, 'alt'); return !!alt && hasValue(alt) }
      return ts.isJsxElement(node) && node.children.some(names)
    }
    if (ts.isJsxFragment(node)) return node.children.some(names)
    return true
  }
  const unnamed = (file, src) => {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const out = []
    const visit = n => {
      if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagOf(n) === 'button') {
        const named = attrsOf(n).some(a => ts.isJsxSpreadAttribute(a) || (NAMING.has(a.name.getText()) && hasValue(a)))
        if (!named && !(ts.isJsxElement(n) && n.children.some(names))) {
          out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.getText().replace(/\s+/g, ' ').slice(0, 110) })
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }
  // Known answers, one button per line: `true` marks the ones left unnamed.
  const PROBE = [
    [true, '<button onClick={f}><Icon name="x" /></button>'],
    [true, '<button>{busy ? <Spinner /> : <svg><path d="M0" /></svg>}</button>'],
    [true, '<button><span aria-hidden="true">×</span></button>'],
    [true, "<button>{' '}<Icon name=\"x\" /></button>"],
    [true, '<button aria-label=""><Icon name="x" /></button>'],
    [true, '<button onClick={f} />'],
    [false, '<button aria-label="Close"><Icon name="x" /></button>'],
    [false, '<button aria-label={label}><Icon name="x" /></button>'],
    [false, '<button title="Delete"><Icon name="trash" /></button>'],
    [false, '<button {...props}><Icon name="x" /></button>'],
    [false, '<button><Icon name="x" /> Close</button>'],
    [false, '<button><Icon name="x" /><span className="sr-only">Close</span></button>'],
    [false, '<button>{label}</button>'],
    [false, '<button><svg><title>Close</title><path d="M0" /></svg></button>'],
    [false, '<button><svg aria-label="Close"><path d="M0" /></svg></button>'],
    [false, '<button><img src="x.png" alt="Close" /></button>'],
  ]
  const want = PROBE.flatMap(([flag], i) => (flag ? [i + 1] : [])).join(',')
  const got = unnamed('probe.tsx', `const a = <>${PROBE.map(p => p[1]).join('\n')}</>`).map(p => p.line).join(',')
  if (got !== want) {
    console.log(`  *** known-answer probe: expected lines ${want} unnamed, got ${got || 'none'}`)
    problems++
  }
  const files = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) files.push(p)
    }
  }
  walk(SRC)
  let count = 0
  for (const f of files) {
    for (const u of unnamed(f, fs.readFileSync(f, 'utf8'))) {
      console.log(`  *** ${f}:${u.line}  no text and no aria-label / aria-labelledby / title: ${u.text}`)
      problems++
      count++
    }
  }
  console.log(`  ${count} unnamed icon-only button(s) across ${files.length} files.`)
}

console.log(`\n${problems} problem(s).`)
process.exit(problems ? 1 : 0)
