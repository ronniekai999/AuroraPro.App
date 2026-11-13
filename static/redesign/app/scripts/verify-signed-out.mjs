// The signed-out pages, in real Chromium: sign in, and create an account.
//
// No other audit renders them, which is how a layout fault got through: the
// sign-in page wrapped its wall of frames and its form by their base widths
// (560 + 420), so from 900 to 979px the wall took the first line at the
// window's full height and the form, with its button, was a whole screen
// further down. A window snapped to half of a 1920px display is 960px wide.
//
// This serves the BUILT app the way the server does (the /v2/ mount, the
// SPA fallback) with nobody signed in, and at each size checks what a
// visitor needs to get in:
//
//   - the page is no wider than the window;
//   - the first field and the button that submits the form are inside the
//     first screenful, with nothing over the button (hit-tested);
//   - the wall is drawn only where it fits BESIDE the form, never above it;
//   - on a touch screen, each link in a sentence ("Create an account",
//     "Connect a TV with a code", "Sign in") is a 44px target over its whole
//     width, which two links on wrapped lines are only when their targets do
//     not overlap.
//
// The form that makes an account has four fields, a heading and a bar. On
// the smallest phone (320x568) that is taller than the screen, so there, and
// only there, its button is checked to be reachable by scrolling instead.
//
// Run after a build (the audit chain does): node scripts/verify-signed-out.mjs

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(SCRIPTS, '..', '..', '..', 'v2')

// Same pin + fallback contract as scripts/verify-page-alignment.mjs.
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = existsSync(PINNED) ? PINNED : undefined

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2',
}

let problems = 0
function fail(msg) {
  console.error(`   *** ${msg}`)
  problems++
}

try {
  await access(path.join(DIST, 'index.html'))
} catch {
  console.error(`No build output at ${DIST} — run \`npm run build\` first (the audit chain does).`)
  process.exit(1)
}

// A server with accounts and two sign-in providers switched on: the tallest
// the two forms get (an invite field; a row of provider links under each).
const SETUP = {
  setup_complete: true, has_users: true,
  oauth_google_enabled: true, oauth_discord_enabled: true,
  oauth_twitch_enabled: false, oauth_facebook_enabled: false, oauth_twitter_enabled: false,
}
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (pathname.startsWith('/api/')) {
    const signedOut = pathname !== '/api/auth/setup-status'
    res.writeHead(signedOut ? 401 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(signedOut ? { error: { code: 401, message: 'not authenticated' } } : SETUP))
    return
  }
  const rel = pathname.replace(/^\/v2\/?/, '')
  let file = path.normalize(path.join(DIST, rel))
  if (rel === '' || !file.startsWith(DIST + path.sep)) file = path.join(DIST, 'index.html')
  let body
  try {
    body = await readFile(file)
  } catch {
    file = path.join(DIST, 'index.html')
    body = await readFile(file)
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
  res.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ executablePath: EXE }).catch(err => {
  console.error(`Could not launch Chromium (tried ${EXE ?? "Playwright's own browser"}) — set CHROMIUM_PATH or run: npx playwright install chromium`)
  throw err
})

// [width, height, touch]. The phones and tablets are touch screens; the
// widths around the wall's break (900 to 980) are a desktop window being
// narrowed, and 960x900 is one snapped to half a 1920px display.
const SIZES = [
  [320, 568, true], [390, 844, true], [768, 1024, true],
  [900, 900, false], [960, 900, false], [979, 900, false], [980, 900, false],
  [1024, 768, true], [1440, 900, false],
]
/** The width from which the wall and the form fit on one line. */
const WALL_FROM = 980
/** The one size the account form is taller than: its button is scrolled to. */
const tallerThanScreen = (w, h) => w === 320 && h === 568

/** Measured in the page: where things are, and what a press reaches. */
function measure() {
  const hits = (el, x, y) => { const at = document.elementFromPoint(x, y); return !!at && (at === el || el.contains(at)) }
  // The height a press reaches the element over, in the column at x.
  const column = (el, x) => {
    const b = el.getBoundingClientRect()
    const cy = (b.top + b.bottom) / 2
    if (!hits(el, x, cy)) return 0
    const run = d => { let n = 0; while (n < 200 && hits(el, x, cy + d * (n + 1) * 0.5)) n++; return n }
    return (run(-1) + run(1) + 1) * 0.5
  }
  const box = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height } }
  const page = document.querySelector('[data-auth]')
  const submit = page.querySelector('.auth-submit')
  const first = page.querySelector('input')
  const wall = page.querySelector('.auth-wall')
  const main = page.querySelector('.auth-main')
  const sb = submit.getBoundingClientRect()
  const seen = {
    kind: page.getAttribute('data-auth'),
    sw: document.documentElement.scrollWidth, vw: window.innerWidth, vh: window.innerHeight,
    scrollY: window.scrollY, docH: document.documentElement.scrollHeight,
    submit: box(submit), submitHit: hits(submit, (sb.left + sb.right) / 2, (sb.top + sb.bottom) / 2),
    first: box(first),
    wall: wall && getComputedStyle(wall).display !== 'none' ? box(wall) : null,
    main: box(main),
    providers: page.querySelectorAll('.auth-provider').length,
    coarse: matchMedia('(pointer: coarse)').matches,
  }
  // Each link in a sentence: the least height a press reaches it over,
  // across its width. Overlapping targets show as a column cut short.
  // Hit-testing only answers for points on screen, so each is scrolled to
  // first (everything above was measured with the page at its top).
  seen.links = [...page.querySelectorAll('.auth-link')].map(el => {
    el.scrollIntoView({ block: 'center' })
    const b = el.getBoundingClientRect()
    const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map(f => b.left + b.width * f)
    return { name: el.textContent, least: Math.min(...xs.map(x => column(el, x))) }
  })
  window.scrollTo(0, 0)
  return seen
}

try {
  for (const [width, height, touch] of SIZES) {
    const before = problems
    const ctx = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch })
    const page = await ctx.newPage()
    await page.goto(`${origin}/v2/`, { waitUntil: 'load' })
    const at = `${width}x${height}${touch ? ' touch' : ''}`
    // The sign-in page, with the server's providers drawn (the tallest it gets).
    await page.waitForSelector('[data-auth="signin"] .auth-provider', { timeout: 15_000 })
    await page.evaluate(() => document.fonts.ready)
    const notes = []
    for (const kind of ['signin', 'register']) {
      if (kind === 'register') {
        await page.click('[data-auth="signin"] .auth-foot button.auth-link')
        await page.waitForSelector('[data-auth="register"] #auth-invite', { timeout: 15_000 })
        await page.evaluate(() => window.scrollTo(0, 0))
      }
      const r = await page.evaluate(measure)
      const name = kind === 'signin' ? 'sign-in' : 'create-an-account'
      if (r.kind !== kind) fail(`${at}: expected the ${name} page, found "${r.kind}" — this check is out of date`)
      if (r.coarse !== touch) fail(`${at}: the ${name} page was measured on the wrong kind of pointer`)
      if (r.providers !== 2) fail(`${at}: the ${name} page drew ${r.providers} provider links, expected 2 — this check is out of date`)
      if (r.sw > r.vw + 0.5) fail(`${at}: the ${name} page is ${r.sw}px wide in a ${r.vw}px window`)
      if (r.scrollY !== 0) fail(`${at}: the ${name} page opened scrolled to ${r.scrollY}px`)
      if (r.first.top < 0 || r.first.bottom > r.vh + 0.5) fail(`${at}: the ${name} page's first field is at ${r.first.top.toFixed(0)}–${r.first.bottom.toFixed(0)}px, outside the first ${r.vh}px`)
      const inFirstScreen = r.submit.top >= 0 && r.submit.bottom <= r.vh + 0.5
      if (kind === 'register' && tallerThanScreen(width, height)) {
        // The exception is checked both ways, so it cannot outlive its reason.
        if (inFirstScreen) fail(`${at}: the create-an-account button now fits the first screen — drop this size's exception in verify-signed-out.mjs`)
        const reached = await page.evaluate(() => {
          const el = document.querySelector('.auth-submit')
          el.scrollIntoView({ block: 'center' })
          const b = el.getBoundingClientRect()
          const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)
          return { top: b.top, bottom: b.bottom, vh: window.innerHeight, hit: !!hit && (hit === el || el.contains(hit)) }
        })
        if (!reached.hit || reached.top < 0 || reached.bottom > reached.vh + 0.5) fail(`${at}: the create-an-account button cannot be scrolled to and pressed (at ${reached.top.toFixed(0)}–${reached.bottom.toFixed(0)}px after scrolling)`)
        await page.evaluate(() => window.scrollTo(0, 0))
      } else {
        if (!inFirstScreen) fail(`${at}: the ${name} button is at ${r.submit.top.toFixed(0)}–${r.submit.bottom.toFixed(0)}px, outside the first ${r.vh}px a visitor sees`)
        else if (!r.submitHit) fail(`${at}: something is over the ${name} button`)
      }
      if (kind === 'signin') {
        if (width >= WALL_FROM && !r.wall) fail(`${at}: the wall of frames is not drawn, though it fits beside the form from ${WALL_FROM}px`)
        if (width < WALL_FROM && r.wall) fail(`${at}: the wall of frames is drawn in a window too narrow to hold it beside the form`)
        if (r.wall) {
          if (r.wall.right > r.main.left + 0.5) fail(`${at}: the wall (to ${r.wall.right.toFixed(0)}px) overlaps the form's column (from ${r.main.left.toFixed(0)}px)`)
          if (Math.abs(r.wall.top - r.main.top) > 0.5) fail(`${at}: the wall and the form are not on one line (tops ${r.wall.top.toFixed(0)}px and ${r.main.top.toFixed(0)}px)`)
        }
        if (r.main.top > 0.5) fail(`${at}: the form's column starts ${r.main.top.toFixed(0)}px down the page, under something`)
        if (r.main.w < 300) fail(`${at}: the form's column is ${r.main.w.toFixed(0)}px wide`)
        if (r.links.length !== 2) fail(`${at}: the sign-in page has ${r.links.length} links in its foot, expected 2 — this check is out of date`)
      } else if (r.links.length !== 1) fail(`${at}: the create-an-account page has ${r.links.length} links in a sentence, expected 1 — this check is out of date`)
      if (touch) {
        for (const l of r.links) {
          if (l.least < 44) fail(`${at}: "${l.name}" on the ${name} page is a ${l.least}px target at its narrowest by hit-testing, under the 44px a touch target needs`)
        }
      }
      notes.push(`${name}: button to ${r.submit.bottom.toFixed(0)}px${r.wall ? `, wall ${r.wall.w.toFixed(0)}px` : ''}${touch ? `, links ${r.links.map(l => l.least).join('/')}px` : ''}`)
    }
    console.log(`── ${at.padEnd(15)} ${problems === before ? 'ok  ' : 'FAIL'}  ${notes.join(' · ')}`)
    await ctx.close()
  }
} finally {
  await browser.close()
  server.close()
}

console.log(`\n${problems} signed-out page problem(s).`)
process.exit(problems ? 1 : 0)
