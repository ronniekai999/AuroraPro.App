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

// ── The minimised cast card ──────────────────────────────────────────────
// While a cast runs the player is tucked away and a card stands at the
// bottom right (`.player-cast-widget`), above the phone's tab bar, above the
// party's mini dock when one is on screen (both span a phone's width), and
// to the left of the party's rail when that is open (from 640px, where the
// rail is a column; under it the rail is the window's width). The page
// leaves room under its last row for the card and the dock while a card is
// on the page (`html:has(.player-cast-widget) .stage-shell`, also for the
// card with no title, which has no player surface), so nothing at the end
// of a page is held under them. Measured here:
//   - the card is 360px at most, 16px in from the right (or from the
//     rail's left edge) and never wider than the room it has;
//   - under 300px wide (a 320px phone; beside the rail at 640px) it does not
//     write the position, and from 300px it does;
//   - it is no taller than the height index.css publishes for it
//     (--castcard-h), which the page's room and the toasts' lift use;
//   - it ends above the tab bar where there is one, and at least 8px above
//     the dock;
//   - it does not touch the rail, and the middle of each of its buttons is
//     the button itself (nothing drawn over it);
//   - scrolled to the end, the page's last control is clear of the card
//     and the dock;
//   - on a touch screen (a coarse pointer), each button's target is 44px
//     each way and no two targets overlap;
//   - with the dock's reaction picker open (it opens upward from the dock,
//     towards the card), the middle of each emoji is that emoji's button;
//     and a dialog's scrim (`fixed inset-0 z-[70]`) over all of it still
//     covers every emoji and every button of the card. The card goes under
//     the dock for that, not the dock over the card: the picker can stay
//     open while a dialog comes up, and raising the dock would put it over
//     the scrim.
// The CLASSES of every element of the card, of the dock's box, field, Send
// button and reaction trigger, of the picker's row and its emoji, and of
// the rail are read from the source, in the card's source order; the
// fixture's STRUCTURE (which element holds which) and its words are this
// file's model of the components, so a change of structure that keeps the
// classes is not seen here.
// MUTATION-TESTED: without the page's room the last control is under the
// card at every width; without the lift the card is 56px into the dock;
// with the card's old bottom (16px above the safe area) it is 40px over the
// tab bar; without the rule for the rail the card is under the rail and its
// buttons are not reachable; with 4px between its buttons their touch
// targets overlap; without the rule that puts the card under an open
// picker, emoji in the picker's bottom row are covered by the card; with
// the dock raised over the card instead, the scrim no longer covers the
// picker.
const cardSrc = (() => {
  const from = src.indexOf('{minimizedActive && (')
  const to = src.indexOf('\n    )}\n', from)
  if (from < 0 || to < 0) throw new Error(`verify: ${PLAYER} no longer renders the card under {minimizedActive && ( — this check is out of date, not passing`)
  return src.slice(from, to)
})()
// The classes of the card's own elements: an icon component's (<Play
// className=…>) is the icon's, not a box of the card's.
const CARD = [...cardSrc.matchAll(/className="([^"]*)"/g)]
  .filter(m => /^<[a-z]/.test(cardSrc.slice(cardSrc.lastIndexOf('<', m.index))))
  .map(m => m[1])
// card, progress line, its fill, row, text column, title, second line, its
// words, the written time, then three buttons.
if (CARD.length !== 12 || CARD[0] !== 'player-cast-widget' || CARD[1] !== 'player-cast-progress' || !CARD.slice(9).every(c => c.includes('w-10 h-10'))) {
  throw new Error(`verify: the card in ${PLAYER} no longer has the twelve elements this check models (${CARD.length}) — this check is out of date, not passing`)
}
if (!cardSrc.includes('data-cast-position=""')) throw new Error(`verify: the card's written time no longer carries data-cast-position — this check is out of date, not passing`)
const DOCK = classesOf('src/components/MiniDock.tsx', 'stage-party-minidock')
const DOCK_FIELD = classesOf('src/components/MiniDock.tsx', 'stage-minidock-field')
const DOCK_SEND = classesOf('src/components/MiniDock.tsx', 'bg-action-soft text-ink')
const RAIL = classesOf('src/components/PartyPanel.tsx', 'stage-party-rail')
// The picker: its trigger's dock variant, the row (a template literal, read
// up to its first static class), and the emoji, as many as lib/reactions
// lists.
const PICKER_SRC = fs.readFileSync('src/components/ReactionOverlay.tsx', 'utf8')
const TRIGGER = (PICKER_SRC.match(/'(stage-minidock-reaction [^']*)'/) ?? [])[1]
const ROW_TAIL = (PICKER_SRC.match(/className=\{`absolute \$\{popoverV\} \$\{popoverAnchor\} ([^`]*)`\}/) ?? [])[1]
const EMOJI = classesOf('src/components/ReactionOverlay.tsx', 'w-12 h-12')
const QUICK = (fs.readFileSync('src/lib/reactions.ts', 'utf8').match(/QUICK_REACTIONS[^=]*=\s*\[([^\]]*)\]/) ?? [])[1]
if (!TRIGGER || !ROW_TAIL || !QUICK || !PICKER_SRC.includes("const popoverAnchor = placement === 'left' ? 'left-0' : 'right-0'") || !PICKER_SRC.includes("const popoverV = vertical === 'down' ? 'top-full mt-1' : 'bottom-full mb-1'")) {
  throw new Error('verify: ReactionOverlay.tsx no longer builds the picker this check models — this check is out of date, not passing')
}
const EMOJI_COUNT = QUICK.split(',').length
// The dialogs' scrim, as the app's dialogs draw it.
const SCRIM = 'fixed inset-0 z-[70]'
if (!fs.readFileSync('src/components/BugReportModal.tsx', 'utf8').includes(`className="${SCRIM} `)) throw new Error('verify: BugReportModal.tsx no longer draws its scrim at fixed inset-0 z-[70] — this check is out of date, not passing')
const castPage = ({ dock, rail, tabbar, picker, scrim, surface = true }) => `<!doctype html>
<html${surface ? ' data-player-surface="minimized"' : ''}${dock ? ' data-party-dock="open"' : ''}${rail ? ' data-party-rail="open"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body style="margin:0">
<main class="min-h-screen stage-shell"><div style="height:1400px"></div><button type="button" id="last" style="display:block;width:100%;height:44px">The page's last control</button></main>
${tabbar ? '<nav id="tabbar" class="stage-tabbar"></nav>' : ''}
<div id="card" class="${CARD[0]}"><div class="${CARD[1]}"><div class="${CARD[2]}" style="width:40%"></div></div><div class="${CARD[3]}">
  <div class="${CARD[4]}"><p class="${CARD[5]}">Night Train to Meridian</p><p class="${CARD[6]}"><span class="${CARD[7]}">Casting to Living Room TV</span><span class="${CARD[8]}" data-cast-position="">· 1:41:07</span></p></div>
  <button type="button" class="${CARD[9]}">P</button><button type="button" class="${CARD[10]}">E</button><button type="button" class="${CARD[11]}">X</button>
</div></div>
${dock ? `<div id="dock" class="${DOCK}"><div class="relative flex-none"><button type="button" class="${TRIGGER}"${picker ? ' data-open="true" aria-expanded="true"' : ' aria-expanded="false"'}>:)</button>${picker ? `<div id="picker" role="group" class="absolute bottom-full mb-1 left-0 ${ROW_TAIL}">${Array.from({ length: EMOJI_COUNT }, (_, i) => `<button type="button" class="${EMOJI}">${i}</button>`).join('')}</div>` : ''}</div><input type="text" class="${DOCK_FIELD}"><button type="button" class="${DOCK_SEND}">m</button></div>` : ''}
${rail ? `<aside id="rail" class="${RAIL}"></aside>` : ''}
${scrim ? `<div id="scrim" class="${SCRIM}"></div>` : ''}
</body></html>`
const measureCard = () => {
  scrollTo(0, document.documentElement.scrollHeight)
  const box = el => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } }
  const r = id => box(document.getElementById(id))
  const centre = el => { const x = el.getBoundingClientRect(); return document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2) }
  const buttons = [...document.querySelectorAll('#card button')].map(b => {
    const x = b.getBoundingClientRect()
    const before = getComputedStyle(b, '::before')
    const grow = before.content !== 'none' && before.position === 'absolute' ? -parseFloat(before.top || '0') : 0
    const at = centre(b)
    return { left: x.left - grow, right: x.right + grow, top: x.top - grow, bottom: x.bottom + grow, reachable: !!at && b.contains(at), scrim: at?.id === 'scrim' }
  })
  const emoji = [...document.querySelectorAll('#picker button')].map(b => { const at = centre(b); return { reachable: !!at && b.contains(at), scrim: at?.id === 'scrim' } })
  const published = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--castcard-h'))
  const position = getComputedStyle(document.querySelector('#card [data-cast-position]')).display !== 'none'
  return { position, card: r('card'), dock: r('dock'), tabbar: r('tabbar'), rail: r('rail'), last: r('last'), buttons, emoji, published, coarse: matchMedia('(pointer: coarse)').matches }
}
const checkCard = (m, width, { touch, picker, scrim }) => {
  if (scrim) {
    m.buttons.forEach((b, i) => { if (!b.scrim) fail(`with a dialog's scrim up, the card's button ${i + 1} is drawn over it`) })
    m.emoji.forEach((e, i) => { if (!e.scrim) fail(`with a dialog's scrim up, emoji ${i + 1} of the open picker is drawn over it`) })
    if (m.emoji.length !== EMOJI_COUNT) fail(`the picker has ${m.emoji.length} emoji, not ${EMOJI_COUNT}`)
    return
  }
  const room = m.rail && width >= 640 ? m.rail.left - 16 : width - 16
  if (!(m.published > 0)) fail('index.css publishes no --castcard-h: this check is out of date')
  if (m.card.height > m.published + 0.5) fail(`the card is ${m.card.height}px high, taller than the ${m.published}px index.css publishes for it`)
  if (m.card.width > 360.5) fail(`the card is ${Math.round(m.card.width)}px wide, over 360`)
  if (m.position !== (m.card.width >= 300)) fail(`the card is ${Math.round(m.card.width)}px wide and ${m.position ? 'writes' : 'does not write'} the position (it is left out under 300px, where it took the device's name down to "Casting to…")`)
  if (m.card.left < 15.5 || Math.abs(m.card.right - room) > 0.5) fail(`the card is not 16px in from ${m.rail && width >= 640 ? "the rail's left edge" : 'the right'} within the window (${Math.round(m.card.left)}-${Math.round(m.card.right)})`)
  if (m.rail && width >= 640 && m.card.right > m.rail.left - 0.5) fail(`the card runs ${Math.round(m.card.right - m.rail.left)}px under the rail`)
  if (!picker) m.buttons.forEach((b, i) => { if (!b.reachable) fail(`the card's button ${i + 1} has something drawn over its middle`) })
  if (picker) {
    if (m.emoji.length !== EMOJI_COUNT) fail(`the picker has ${m.emoji.length} emoji, not ${EMOJI_COUNT}`)
    const covered = m.emoji.filter(e => !e.reachable).length
    if (covered) fail(`${covered} of ${m.emoji.length} emoji in the open picker have something drawn over their middle`)
  }
  if (m.tabbar && m.card.bottom > m.tabbar.top + 0.5) fail(`the card ends ${Math.round(m.card.bottom - m.tabbar.top)}px over the tab bar`)
  if (m.dock && m.card.bottom > m.dock.top - 8 + 0.5) fail(`the card ends ${Math.round(m.card.bottom - m.dock.top)}px from the dock's top (need 8px clear)`)
  if (m.last.bottom > m.card.top + 0.5) fail(`the page's last control, scrolled to the end, is ${Math.round(m.last.bottom - m.card.top)}px under the card`)
  if (m.dock && m.last.bottom > m.dock.top + 0.5) fail(`the page's last control, scrolled to the end, is under the dock`)
  if (touch) {
    if (!m.coarse) fail('the touch pass has no coarse pointer: this model is out of date')
    m.buttons.forEach((b, i) => {
      if (b.right - b.left < 43.5 || b.bottom - b.top < 43.5) fail(`the card's button ${i + 1} is a ${Math.round(b.right - b.left)}x${Math.round(b.bottom - b.top)}px target on a touch screen, under 44`)
      const next = m.buttons[i + 1]
      if (next && b.right > next.left + 0.5) fail(`the touch targets of the card's buttons ${i + 1} and ${i + 2} overlap by ${Math.round(b.right - next.left)}px`)
    })
  }
}
console.log('\n## The minimised cast card: its place, the rail, the picker, and the page\'s room for it')
const PICKER_WIDTHS = [320, 390, 768]
for (const [width, height, touch] of [[320, 640, true], [390, 844, true], [640, 800, true], [768, 1024, true], [1024, 768, false], [1440, 900, false]]) {
  const cases = ['none', 'dock', 'rail', 'bare', 'picker', 'scrim']
  for (const party of cases) {
    if (party === 'rail' && width < 640) continue
    if ((party === 'picker' || party === 'scrim') && !PICKER_WIDTHS.includes(width)) continue
    if (party === 'bare' && width !== 390 && width !== 1440) continue
    const picker = party === 'picker' || party === 'scrim'
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ...(touch ? { hasTouch: true, isMobile: true } : {}) })
    const tab = await context.newPage()
    await tab.setContent(castPage({ dock: party === 'dock' || picker, rail: party === 'rail', tabbar: width < 768, picker, scrim: party === 'scrim', surface: party !== 'bare' }))
    const m = await tab.evaluate(measureCard)
    await context.close()
    const label = { none: '', dock: ' with the dock', rail: ' with the rail', bare: ', no player surface', picker: ' with the picker open', scrim: ', picker open, under a scrim' }[party]
    const where = `${width}x${height}${label}${touch ? ', touch' : ''}`
    console.log(`── ${where.padEnd(44)} card ${Math.round(m.card.left)}-${Math.round(m.card.right)} x ${Math.round(m.card.top)}-${Math.round(m.card.bottom)}${m.rail ? `  rail from ${Math.round(m.rail.left)}` : ''}${m.dock ? `  dock from ${Math.round(m.dock.top)}` : ''}${m.tabbar ? `  tab bar from ${Math.round(m.tabbar.top)}` : ''}${m.emoji.length ? `  emoji reachable ${m.emoji.filter(e => e.reachable).length}/${m.emoji.length}` : ''}  last control ends ${Math.round(m.last.bottom)}`)
    checkCard(m, width, { touch, picker, scrim: party === 'scrim' })
  }
}
await browser.close()
console.log(`\n${problems} player-lane problem(s).`)
process.exit(problems ? 1 : 0)
