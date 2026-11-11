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

// Reproduces every contrast figure quoted in the player's CSS comments.
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

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
const INK = hex('#f4f4f5'), INK2 = hex('#b4b6bc'), ON_ACTION = hex('#0e0f11')

// The player's control band (index.css .stage-controls-scrim, .player-band).
// Heights, bottom up, in px: the band's bottom padding, the transport row(s),
// the gap, the row of range names (md up), the 20px timeline row, and the
// fade above it. `y` is how far up the band a thing's centre sits.
const scrim = [[0, 0.94], [0.66, 0.86], [0.86, 0.5], [1, 0]]   // `to top`
const bands = {
  'md and up (192px band)': { h: 192, timeline: 118, labels: 96, readout: 52 },
  'phone (204px band, two transport rows)': { h: 204, timeline: 138, labels: null, readout: 40 },
}
for (const [name, b] of Object.entries(bands)) {
  console.log(`=== .stage-controls-scrim : ${name} ===`)
  const at = px => rampAlpha(scrim, px / b.h)
  console.log(`  alpha at the timeline ${f(at(b.timeline))}, at the readout ${f(at(b.readout))}${b.labels ? `, at the range names ${f(at(b.labels))}` : ''}`)
  for (const [frameName, frame] of [['black frame', K], ['white frame', W]]) {
    const bg = over(K, at(b.timeline), frame)
    const track = over(W, 0.36, bg)
    const buf = over(W, 0.6, track)
    console.log(`  ${frameName}:`)
    console.log(`     track 0.36 vs backdrop        : ${f(ratio(track, bg))}:1  (need 3.0)`)
    console.log(`     played (white) vs track       : ${f(ratio(W, track))}:1  (need 3.0)`)
    console.log(`     buffered 0.6 vs track         : ${f(ratio(buf, track))}:1  (a secondary cue; stated as short of 3.0)`)
    const rbg = over(K, at(b.readout), frame)
    console.log(`     time readout --ink 15px       : ${f(ratio(INK, rbg))}:1  (need 4.5)`)
    console.log(`     total duration --ink-2 15px   : ${f(ratio(INK2, rbg))}:1  (need 4.5)`)
    if (b.labels) {
      const lbg = over(K, at(b.labels), frame)
      console.log(`     range names --ink-2 12px      : ${f(ratio(INK2, lbg))}:1  (need 4.5)`)
    }
  }
}

console.log('\n=== .stage-player-topbar : text ends 70% down the bar (92px of 132px) ===')
// `to bottom`: 0%=0.88, 70%=0.72, 100%=0. The last line of text is the worst
// case; the lines above it sit higher on the same ramp.
const barA = rampAlpha([[0, 0.88], [0.70, 0.72], [1, 0]], 0.70)
console.log('  effective alpha at the last line of text:', f(barA))
for (const [name, frame] of [['black frame', K], ['white frame', W]]) {
  const bg = over(K, barA, frame)
  console.log(`  ${name}: title white 22px/600 : ${f(ratio(W, bg))}:1  (need 4.5)`)
  console.log(`             episode --ink 14px   : ${f(ratio(INK, bg))}:1  (need 4.5)`)
  console.log(`             notice --ink-2 13px  : ${f(ratio(INK2, bg))}:1  (need 4.5)`)
}

console.log('\n=== .stage-skip-pill boundary ===')
for (const [name, frame] of [['black frame', K], ['white frame', W]]) {
  const fill = W
  const border = over(K, 0.42, fill)
  console.log(`  ${name}: fill vs frame ${f(ratio(fill, frame))}:1 · border vs fill ${f(ratio(border, fill))}:1 · border vs frame ${f(ratio(border, frame))}:1 · label --on-action vs fill ${f(ratio(ON_ACTION, fill))}:1`)
}
