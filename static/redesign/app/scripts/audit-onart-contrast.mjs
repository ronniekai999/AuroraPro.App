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

const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const Y = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const over = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i])
const ratio = (a, b) => {
  const [l1, l2] = [Y(a), Y(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
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

// ── the two scrims, transcribed from index.css ────────────────────────────
// .stage-hero-scrim — first layer listed paints ON TOP.
const HERO = {
  // linear-gradient(90deg, ...) → 0% is the LEFT edge.
  horiz: [[0, 0.95], [0.40, 0.72], [0.72, 0.15], [1, 0.35]],
  // linear-gradient(0deg, ...) → 0% is the BOTTOM edge.
  vert: [[0.02, 1.0], [0.30, 0.25], [0.55, 0]],
}

/** Composite both scrim layers at (x from left, y from bottom) over `frame`. */
function heroBackdrop(x, yFromBottom, frame) {
  const afterVert = over(INK, rampA(HERO.vert, yFromBottom), frame)
  return over(INK, rampA(HERO.horiz, x), afterVert)
}

// ── the surfaces, with where they actually sit ────────────────────────────
// x/y are fractions (x from the left edge, y from the BOTTOM edge), read off the
// hero's own layout: the text column starts at --page-gutter (~3% at 1440px) and
// the stack runs title → meta → description → buttons up from the lower third.
const SURFACES = [
  // HeroSection.tsx:368 — lg:type-hero, 84px extrabold → large text, 3:1
  { file: 'HeroSection.tsx:368', what: 'hero title', color: W, alpha: 1, px: 84, bold: true, x: 0.03, y: 0.40 },
  // :363 — the browse variant, md:type-browse 52px extrabold → large text
  { file: 'HeroSection.tsx:363', what: 'browse hero title', color: W, alpha: 1, px: 52, bold: true, x: 0.03, y: 0.40 },
  // :391 — description, 16px at md+ → normal text, 4.5:1
  { file: 'HeroSection.tsx:391', what: 'hero description', color: W, alpha: 0.70, px: 16, x: 0.03, y: 0.27 },
  // :384 — "Featured: X — N titles", 14px
  { file: 'HeroSection.tsx:384', what: 'meta line', color: W, alpha: 0.70, px: 14, x: 0.03, y: 0.33 },
  // :385/:387 — the dimmer spans INSIDE that same line
  { file: 'HeroSection.tsx:385', what: 'meta label span ("Featured: ")', color: W, alpha: 0.50, px: 14, x: 0.03, y: 0.33 },
  // :332 — the AI reason, purple-100 at 0.85, 14px italic
  { file: 'HeroSection.tsx:332', what: 'AI reason', color: hex('#f3e8ff'), alpha: 0.85, px: 14, x: 0.03, y: 0.47 },
  // :334 — the fallback note, purple-200 at 0.70, 12px italic
  { file: 'HeroSection.tsx:334', what: 'catalog-fallback note', color: hex('#e9d5ff'), alpha: 0.70, px: 12, x: 0.03, y: 0.47 },
  // :321 — genre/year line, 14px
  { file: 'HeroSection.tsx:321', what: 'genre / year line', color: W, alpha: 0.60, px: 14, x: 0.03, y: 0.52 },
  // :282 — "MATCH" / "SCORE" eyebrow, and :278 the percentage numeral. RIGHT
  // side of the hero, near the top, where the horizontal ramp is at its WEAKEST
  // (0.15 at 72%, 0.35 at 100%). Both sit over .stage-hero-match-veil, the local
  // backing Phase 8 added precisely because this corner has no scrim worth the
  // name — without it the eyebrow measured 1.22:1 and the numeral 2.16:1.
  { file: 'HeroSection.tsx:282', what: 'MATCH/SCORE eyebrow', color: hex('#d8b4fe'), alpha: 1, px: 10, bold: true, x: 0.95, y: 0.72, veil: 0.72 },
  { file: 'HeroSection.tsx:278', what: 'match numeral "NN%"', color: W, alpha: 1, px: 20, bold: true, x: 0.95, y: 0.72, veil: 0.72 },
  { file: 'HeroSection.tsx:272', what: 'ring track vs backdrop', color: W, alpha: 0.28, px: 0, nonText: true, x: 0.95, y: 0.72, veil: 0.72,
    // Redundant encoding — see the note at the call site. The arc's purple end
    // cannot clear 3:1 against any track that itself clears 3:1 above the
    // backdrop; the value is carried by the numeral above and by the wrapper's
    // aria-label. Tracked here so it stays visible, not asserted.
    advisory: true },
  // :513 — "Not tonight" control, bottom-right. Its 0.06 border is deliberately
  // NOT audited as a 1.4.11 surface: the control is identified by a permanent
  // visible text label, so the border is decoration. See the call site.
  { file: 'HeroSection.tsx:513', what: '"Not tonight" label', color: W, alpha: 0.75, px: 14, x: 0.93, y: 0.15, fillOver: 0.04 },
]

const need = s => (s.nonText ? 3.0 : (s.px >= 24 || (s.px >= 18.66 && s.bold)) ? 3.0 : 4.5)

/** The backdrop a surface actually sits on: scrim, then any local veil, then any
 *  translucent control fill of its own. */
function backdropFor(s, frame) {
  let bg = heroBackdrop(s.x, s.y, frame)
  if (s.veil) bg = over(INK, s.veil, bg)
  if (s.fillOver) bg = over(W, s.fillOver, bg)
  return bg
}

let fails = 0, advisories = 0
console.log('surface                                       px  need   black-frame  white-frame  verdict')
console.log('-'.repeat(100))
for (const s of SURFACES) {
  const rk = (() => { const bg = backdropFor(s, K); return ratio(over(s.color, s.alpha, bg), bg) })()
  const rw = (() => { const bg = backdropFor(s, W); return ratio(over(s.color, s.alpha, bg), bg) })()
  const worst = Math.min(rk, rw)
  const req = need(s)
  const ok = worst >= req
  if (!ok) { if (s.advisory) advisories++; else fails++ }
  const label = `${s.what} (${s.file})`.padEnd(46)
  const verdict = ok ? 'PASS' : (s.advisory ? 'advisory (see note)' : '*** FAIL ***')
  console.log(`${label}${String(s.px).padStart(3)} ${req.toFixed(1).padStart(5)}   ${rk.toFixed(2).padStart(10)}  ${rw.toFixed(2).padStart(11)}  ${verdict}`)
}
console.log('-'.repeat(100))
console.log(`${fails} surface(s) below threshold at their worst frame; ${advisories} advisory.`)
process.exit(fails ? 1 : 0)
