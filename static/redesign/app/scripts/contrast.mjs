// WCAG contrast checker for the Stage's video-overlay chrome.
//
// Committed because every contrast claim in index.css's Phase 6/7 comments is
// supposed to be reproducible, and across those phases four of them weren't —
// including two where the reasoning was inverted (a lower alpha justified "for
// the 3:1 floor" when the higher one measured better) and one where the quoted
// figure belonged to a different element. Numbers in comments are worth exactly
// as much as the script that regenerates them.
//
// Run: node scripts/contrast.mjs   (from static/redesign/app)
//
// Alpha compositing happens in sRGB space, THEN luminance is taken — doing it in
// the other order is the classic way to get a plausible wrong answer.

// Reproduce every contrast figure asserted in the Phase 7b CSS comments.
const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const Y = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const over = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i])
const ratio = (a, b) => {
  const [l1, l2] = [Y(a), Y(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
const W = [1, 1, 1], K = [0, 0, 0]
const f = n => n.toFixed(2)

// Gradient alpha at a fraction `t` of the way along a multi-stop black ramp.
const rampAlpha = (stops, t) => {
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, a0] = stops[i], [p1, a1] = stops[i + 1]
    if (t >= p0 && t <= p1) return a0 + (a1 - a0) * ((t - p0) / (p1 - p0))
  }
  return stops[stops.length - 1][1]
}

console.log('=== .stage-controls-scrim : scrub row sits 62% up the 150.75px band ===')
// to top: 0%=0.94, 55%=0.86, 80%=0.62, 100%=0
const scrimA = rampAlpha([[0, 0.94], [0.55, 0.86], [0.80, 0.62], [1, 0]], 0.62)
console.log('  effective alpha at scrub row:', f(scrimA))
for (const [name, frame] of [['black frame', K], ['white frame', W]]) {
  const bg = over(K, scrimA, frame)
  console.log(`  ${name}: backdrop Y=${Y(bg).toFixed(4)}`)
  console.log(`     elapsed readout text-white/85 12.5px : ${f(ratio(over(W, 0.85, bg), bg))}:1  (need 4.5)`)
  console.log(`     remaining readout text-white/70 12.5px: ${f(ratio(over(W, 0.70, bg), bg))}:1  (need 4.5)`)
  const track = over(W, 0.36, bg)
  const buf = over(W, 0.75, track)
  const purple = [168 / 255, 85 / 255, 247 / 255]
  console.log(`     track 0.36 vs backdrop  : ${f(ratio(track, bg))}:1  (need 3.0)`)
  console.log(`     buffered 0.75 vs track  : ${f(ratio(buf, track))}:1  (need 3.0)`)
  console.log(`     played purple vs buffered: ${f(ratio(purple, buf))}:1  (stated as short of 3.0)`)
}

console.log('\n=== .stage-player-topbar : 68.75px bar, subtitle ~70% down ===')
// to bottom: 0%=0.92, 70%=0.72, 100%=0
const barA = rampAlpha([[0, 0.92], [0.70, 0.72], [1, 0]], 0.70)
console.log('  effective alpha at the text:', f(barA))
for (const [name, frame] of [['black frame', K], ['white frame', W]]) {
  const bg = over(K, barA, frame)
  console.log(`  ${name}: title text-white 17px/700 : ${f(ratio(over(W, 1, bg), bg))}:1  (need 4.5 — 17px is NOT large text)`)
  console.log(`             subtitle text-white/60 11.5px: ${f(ratio(over(W, 0.60, bg), bg))}:1  (need 4.5)`)
}

console.log('\n=== the OLD values, for the record ===')
const oldScrim = rampAlpha([[0, 1], [0.5, 0.70], [1, 0]], 0.62)
const oldBar = rampAlpha([[0, 0.80], [1, 0]], 0.70)
console.log('  old scrim alpha at scrub row:', f(oldScrim), ' old topbar alpha at text:', f(oldBar))
{
  const bg = over(K, oldScrim, W)
  console.log(`  old: elapsed readout on a white frame: ${f(ratio(over(W, 0.85, bg), bg))}:1`)
  console.log(`  old: remaining readout on white frame: ${f(ratio(over(W, 0.70, bg), bg))}:1`)
  const bg2 = over(K, oldBar, W)
  console.log(`  old: title on a white frame          : ${f(ratio(over(W, 1, bg2), bg2))}:1`)
  console.log(`  old: subtitle on a white frame       : ${f(ratio(over(W, 0.60, bg2), bg2))}:1`)
  console.log(`  old: white subtitle ceiling          : ${f(ratio(W, bg2))}:1`)
}

console.log('\n=== .stage-skip-pill boundary ===')
for (const [name, frame] of [['black frame', K], ['white frame', W]]) {
  const fill = over(W, 0.95, frame)
  const border = over(K, 0.42, fill)
  console.log(`  ${name}: fill vs frame ${f(ratio(fill, frame))}:1 · new border vs fill ${f(ratio(border, fill))}:1 · text #0a0a0a vs fill ${f(ratio([10 / 255, 10 / 255, 10 / 255], fill))}:1`)
}
