// The lane above the player's timeline holds the Skip button on the left and
// "Tap for sound" on the right. A press that misses either lands on the
// picture, which for a watch party's host pauses the room, so the two must
// never overlap, and "Tap for sound" must never leave the row: it was moved
// up a row once to dodge Skip and landed under the voice pill and the top
// bar's buttons in a short window.
//
// Where the picture left uncovered is too narrow for both, "Tap for sound"
// drops its words and stays put (index.css, `.stage-tap-sound`). That is CSS
// keyed on a window width and on whether the party rail is open, which a
// unit test cannot see: this lays the two out in a real engine with the real
// built stylesheet and measures them.
//
// At each width, with the rail open over the picture and without:
//   - the two are in the same row, and "Tap for sound" is 48px tall;
//   - there are at least 8px between them;
//   - "Tap for sound" ends inside the part of the picture the rail leaves;
//   - it keeps its words wherever the two fit with them (so the wordless
//     form is not used more widely than it has to be), and always when no
//     Skip button is showing.
//
// And one more thing the same lane has to stay clear of. In a short window
// (a phone held sideways) the party's minimal face keeps its chip and its
// voice pill in a row under the title bar, fixed above the player, and the
// lane is the next row down. With a two-row transport (a timeline 160px up,
// which is what the player measures there) the lane's buttons must start
// below a voice pill with people in it at 360px high and up; the row of
// range names is not drawn there, and IS drawn for everyone else in a short
// window, who has no such row to clear.
//
// The class lists are READ FROM THE SOURCE, each required to be found exactly
// once, so a call site that drifts from this model fails as out of date. The
// longest Skip label is used. Fonts are the engine's fallback (the built
// stylesheet's font files are not served to a page set from a string), which
// moves a label's width by a few pixels and is why the widths probed sit
// either side of each switch and not on a knife edge.
//
// MUTATION-TESTED, by passing a changed stylesheet as the first argument:
// without the rule for windows under 360px the two overlap at 320 (and the
// words stay at 340 and 359); without the rule for the open rail they
// overlap at 640, 667 and 700; without the restore at 768 the words are
// missing at 768 and up beside the rail; with the button moved to the upper
// row while a Skip button shows, it is not in Skip's row at any width and
// moves 60px when one appears; with the chip's row left at 104px the buttons
// start under the voice pill at 360px high; with the range names hidden for
// everyone in a short window, the solo case fails.

import { chromium } from 'playwright'
import fs from 'node:fs'

const cssPath = process.argv[2] ?? fs
  .readdirSync('../../v2/assets')
  .filter(f => /^index-.*\.css$/.test(f))
  .map(f => `../../v2/assets/${f}`)[0]
if (!cssPath) throw new Error('verify: no built CSS found — run `npm run build` first')
const css = fs.readFileSync(cssPath, 'utf8')
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = fs.existsSync(PINNED) ? PINNED : undefined

const PLAYER = 'src/components/VideoPlayer.tsx'
function classesOf(file, marker) {
  const src = fs.readFileSync(file, 'utf8')
  const hits = [...src.matchAll(/className="([^"]*)"/g)].map(m => m[1]).filter(v => v.includes(marker))
  if (hits.length !== 1) {
    throw new Error(`verify: expected exactly one className containing "${marker}" in ${file}, found ${hits.length} — this check is out of date, not passing`)
  }
  return hits[0]
}
const C = {
  skip: classesOf(PLAYER, 'stage-skip-pill'),
  tap: classesOf(PLAYER, 'stage-tap-sound player-lane'),
  label: classesOf(PLAYER, 'stage-tap-sound-label'),
  // The voice pill with people in it (the taller of its two forms).
  voice: classesOf('src/components/VoicePill.tsx', 'stage-voice-pill fixed top-4 right-4 z-[67] inline-flex'),
  rangeNames: classesOf('src/components/PlayerControls.tsx', 'hidden md:block'),
}
if (!fs.readFileSync('src/components/PlayerControls.tsx', 'utf8').includes('data-range-labels=""')) {
  throw new Error('verify: PlayerControls.tsx no longer marks the row of range names with data-range-labels — this check is out of date, not passing')
}
if (!fs.readFileSync('src/components/PartyPanel.tsx', 'utf8').includes("el.dataset.partyDock = 'open'")) {
  throw new Error('verify: PartyPanel.tsx no longer stamps data-party-dock for its minimal face — this check is out of date, not passing')
}
// The marks the stylesheet keys on must still be what the player writes.
const src = fs.readFileSync(PLAYER, 'utf8')
for (const mark of ['data-beside-skip={activeSkipMarker', 'data-tap-for-sound=""']) {
  if (!src.includes(mark)) throw new Error(`verify: ${PLAYER} no longer has ${mark} — this check is out of date, not passing`)
}

const page = ({ rail, skip }) => `<!doctype html>
<html data-player-surface="theater"${rail ? ' data-party-rail=""' : ''}><head><meta charset="utf-8"><style>${css}</style></head>
<body style="margin:0;background:#000">
<div style="position:fixed;inset:0">
  ${skip ? `<button type="button" id="skip" class="${C.skip}">Skip credits</button>` : ''}
  <button type="button" id="tap" data-tap-for-sound=""${skip ? ' data-beside-skip=""' : ''} class="${C.tap}">
    <svg width="18" height="18" class="flex-none"></svg><span id="label" class="${C.label}">Tap for sound</span>
  </button>
</div></body></html>`

// [width, height, rail open, whether the words are expected]
const CASES = [
  [320, 640, false, false], [340, 700, false, false], [359, 700, false, false],
  [360, 740, false, true], [390, 844, false, true], [667, 375, false, true], [844, 390, false, true], [1280, 800, false, true],
  [640, 600, true, false], [667, 375, true, false], [700, 600, true, false], [767, 600, true, false],
  [768, 600, true, true], [812, 375, true, true], [1024, 768, true, true], [1440, 900, true, true],
]
const MIN_GAP = 8
const browser = await chromium.launch({ executablePath: EXE })
let problems = 0
const fail = (line) => { problems++; console.log(`   *** FAIL  ${line}`) }
console.log('## The player\'s lane: Skip and "Tap for sound"')
for (const [width, height, rail, words] of CASES) {
  const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  const measure = async (skip) => {
    await tab.setContent(page({ rail, skip }))
    return tab.evaluate(() => {
      const r = id => { const el = document.getElementById(id); if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } }
      const cover = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--theater-rail-cover')) || 0
      return { skip: r('skip'), tap: r('tap'), words: getComputedStyle(document.getElementById('label')).display !== 'none', cover }
    })
  }
  const m = await measure(true)
  const alone = await measure(false)
  await tab.close()
  const where = `${width}x${height}${rail ? ' beside the rail' : ''}`
  const gap = m.tap.left - m.skip.right
  console.log(`── ${where.padEnd(26)} Skip ${Math.round(m.skip.left)}-${Math.round(m.skip.right)}  Tap ${Math.round(m.tap.left)}-${Math.round(m.tap.right)}  gap ${Math.round(gap)}px  ${m.words ? 'with its words' : 'icon only'}`)
  if (Math.abs(m.tap.top - m.skip.top) > 1 || Math.abs(m.tap.bottom - m.skip.bottom) > 1) fail(`not in Skip's row (Skip ${Math.round(m.skip.top)}-${Math.round(m.skip.bottom)}, Tap ${Math.round(m.tap.top)}-${Math.round(m.tap.bottom)})`)
  if (Math.abs(alone.tap.bottom - m.tap.bottom) > 1) fail(`moves ${Math.round(alone.tap.bottom - m.tap.bottom)}px when a Skip button appears`)
  if (Math.round(m.tap.height) !== 48 || m.tap.width < 48) fail(`is ${Math.round(m.tap.width)}x${Math.round(m.tap.height)}px, under 48`)
  if (gap < MIN_GAP) fail(`${Math.round(gap)}px between the two (need ${MIN_GAP})`)
  if (m.tap.right > width - m.cover - 11) fail(`ends at ${Math.round(m.tap.right)}, under the rail or off the picture (which ends at ${width - m.cover})`)
  if (rail !== (m.cover > 0)) fail(`the rail's cover is ${m.cover}px, expected ${rail ? 'some' : 'none'}: this model is out of date`)
  if (m.words !== words) fail(words ? 'has lost its words where the two fit with them' : 'kept its words where the two do not fit')
  if (!alone.words) fail('has no words with no Skip button showing')
}
// ── A short window: the lane against the party's chip row ────────────────
// TIMELINE_TOP is what the player publishes there for a two-row transport
// with no row of range names (measured in the app at 667x375 and 812x375).
const TIMELINE_TOP = 160
const short = ({ dock }) => `<!doctype html>
<html data-player-surface="theater"${dock ? ' data-party-dock="open"' : ''} style="--player-timeline-top:${TIMELINE_TOP}px"><head><meta charset="utf-8"><style>${css}</style></head>
<body style="margin:0;background:#000">
<div id="voice" class="${C.voice}"><span style="display:block;width:180px;height:36px"></span></div>
<div style="position:fixed;inset:0">
  <button type="button" id="skip" class="${C.skip}">Skip intro</button>
  <button type="button" id="tap" data-tap-for-sound="" data-beside-skip="" class="${C.tap}"><svg width="18" height="18" class="flex-none"></svg><span class="${C.label}">Tap for sound</span></button>
  <div id="names" class="${C.rangeNames}" data-range-labels=""></div>
</div></body></html>`
console.log('\n## A short window: the lane under the party\'s chip row')
for (const [width, height] of [[640, 360], [800, 360], [667, 375], [812, 375], [844, 390]]) {
  const tab = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  const read = async (dock) => {
    await tab.setContent(short({ dock }))
    return tab.evaluate(() => {
      const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom } }
      return { voice: r('voice'), tap: r('tap'), skip: r('skip'), names: getComputedStyle(document.getElementById('names')).display }
    })
  }
  const party = await read(true)
  const solo = await read(false)
  await tab.close()
  const clear = party.tap.top - party.voice.bottom
  console.log(`── ${`${width}x${height}`.padEnd(10)} voice pill ${Math.round(party.voice.top)}-${Math.round(party.voice.bottom)}  lane ${Math.round(party.tap.top)}-${Math.round(party.tap.bottom)}  clear by ${Math.round(clear)}px  range names: ${party.names === 'none' ? 'not drawn' : 'drawn'} (alone: ${solo.names === 'none' ? 'not drawn' : 'drawn'})`)
  if (clear < 0) fail(`"Tap for sound" starts ${Math.round(-clear)}px inside the voice pill's row`)
  if (party.skip.top < party.voice.bottom) fail(`Skip starts ${Math.round(party.voice.bottom - party.skip.top)}px inside the chip's row`)
  if (party.names !== 'none') fail('the row of range names is drawn in the minimal face, whose 20px the lane needs')
  // From md, where the row exists at all, a viewer with no chip row keeps it.
  if (width >= 768 && solo.names === 'none') fail('the range names are hidden for a viewer with no chip row to clear')
}
await browser.close()
console.log(`\n${problems} player-lane problem(s).`)
process.exit(problems ? 1 : 0)
