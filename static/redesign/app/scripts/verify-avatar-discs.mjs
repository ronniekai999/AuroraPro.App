// The avatar discs, in real Chromium: onboarding's "Pick your avatar" grid,
// Settings' avatar picker, and the avatar in the top bar.
//
// The pickers' discs have no fixed size: onboarding's are sized by a
// five-column grid in a <fieldset>, Settings' by 48px buttons. A first draft
// sized the initial on a disc in container units, which made the disc a size
// container; inside the fieldset (its minimum width is its content's)
// Chromium then laid every onboarding button out zero pixels wide, and the
// grid vanished as soon as the profile had a name. jsdom has no layout, so
// every unit test passed. This serves the BUILT app the way the server does
// (the /v2/ mount, the SPA fallback, the production CSP) with a signed-in
// profile and its API answers stubbed, and checks what a viewer sees:
//
//   - every onboarding disc is square, the size of its button, and not
//     empty, with the profile's name in it, with the name cleared (a bare
//     disc) and with another name typed;
//   - the initial is centred on its disc and about 42% of its width tall
//     (its cap height is a fraction of that);
//   - the same for Settings' picker (Your profile), and the top bar's 28px
//     avatar.
//
// Run after a build (the audit chain does): node scripts/verify-avatar-discs.mjs

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(SCRIPTS, '..', '..', '..', 'v2')
const REPO_ROOT = path.join(SCRIPTS, '..', '..', '..', '..')

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

/** The production CSP, as scripts/verify-pwa.mjs extracts it (see there). */
async function productionCSP() {
  const src = await readFile(path.join(REPO_ROOT, 'internal', 'api', 'router.go'), 'utf8')
  const start = src.indexOf('"Content-Security-Policy",')
  const end = start === -1 ? -1 : src.indexOf('")', start)
  if (end === -1) throw new Error('router.go CSP block not found — update the extractor (as in verify-pwa.mjs)')
  const csp = src.slice(start, end + 1).split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .flatMap(line => [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]))
    .slice(1).join('')
  if (!csp.includes('default-src')) throw new Error(`extracted CSP looks wrong (${csp.slice(0, 60)}…)`)
  return csp
}
const CSP = await productionCSP()

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/v2\/?/, '')
  let file = path.normalize(path.join(DIST, rel))
  if (rel === '' || !file.startsWith(DIST + path.sep)) file = path.join(DIST, 'index.html')
  let body
  try {
    body = await readFile(file)
  } catch {
    file = path.join(DIST, 'index.html')
    body = await readFile(file)
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP,
  })
  res.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ executablePath: EXE }).catch(err => {
  console.error(`Could not launch Chromium (tried ${EXE ?? "Playwright's own browser"}) — set CHROMIUM_PATH or run: npx playwright install chromium`)
  throw err
})

const USER = { id: 1, username: 'checker', email: 'checker@example.invalid', role: 'user' }
const NOW = '2026-01-01T00:00:00Z'
const PROFILE = { id: 7, user_id: 1, name: 'Sam', avatar_url: 'nebula:tidal', is_default: true, created_at: NOW, updated_at: NOW, maturity_pref: -1 }
const EMPTY_LISTS = new Set([
  '/api/libraries', '/api/parties/active', '/api/profiles/7/library', '/api/me/party-invites', '/api/me/notifications',
  '/api/progress/continue', '/api/me/anchor-rails', '/api/me/engagement-rails', '/api/me/following/recent', '/api/me/discover',
  '/api/onboarding/grid',
])

/** A signed-in tab on `route`, onboarding up or not. */
async function open(width, route, onboarding) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } })
  await ctx.route(`${ORIGIN}/api/**`, r => {
    const p = new URL(r.request().url()).pathname
    if (p === '/api/auth/me') return r.fulfill({ json: USER })
    if (p === '/api/profiles') return r.fulfill({ json: [PROFILE] })
    if (p === '/api/profiles/active') return r.fulfill({ json: PROFILE })
    if (p === '/api/onboarding/status') {
      return r.fulfill({ json: { profile_id: 7, completed: !onboarding, eligible: onboarding, library_embedded: true, min_picks: 5, threshold: 3, seed_count: 0 } })
    }
    if (EMPTY_LISTS.has(p)) return r.fulfill({ json: [] })
    if (p.startsWith('/api/media')) return r.fulfill({ json: { data: [], total_items: 0, page: 1, per_page: 0, total_pages: 0 } })
    if (p === '/api/me/gamification') return r.fulfill({ status: 404, json: { error: { message: 'none' } } })
    return r.fulfill({ json: {} })
  })
  await ctx.route(url => !url.href.startsWith(ORIGIN), r => r.abort())
  await ctx.addInitScript(user => { localStorage.setItem('aurora_user', JSON.stringify(user)) }, USER)
  const page = await ctx.newPage()
  await page.goto(`${ORIGIN}${route}`)
  await page.evaluate(() => document.fonts.ready)
  return { ctx, page }
}

/** Each disc in the buttons under `where` (a CSS selector, or "legend:<text>"
 *  for the fieldset with that legend): its box, its button's, and its
 *  initial's text box (null for a bare disc). */
function discs(where) {
  const box = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
  const root = where.startsWith('legend:')
    ? [...document.querySelectorAll('fieldset')].find(f => f.querySelector('legend')?.textContent === where.slice(7))
    : document.querySelector(where)
  if (!root) return null
  return [...root.querySelectorAll('button')].map(button => {
    const disc = button.querySelector('.nebula-disc')
    const text = disc?.querySelector('text')
    return {
      label: button.getAttribute('aria-label'),
      button: box(button),
      disc: disc ? box(disc) : null,
      letter: text?.textContent ?? '',
      ink: text ? box(text) : null,
    }
  })
}

/** Square, its button's size, at least `min` wide; the letter as expected,
 *  centred, and a plausible size. */
function judge(where, found, letter, min) {
  if (!found) return fail(`${where}: the picker is not on the page`)
  if (found.length !== 10) fail(`${where}: ${found.length} avatars, not 10`)
  const sizes = new Set()
  for (const d of found) {
    const at = `${where}, ${d.label}`
    if (!d.disc) { fail(`${at}: no disc`); continue }
    sizes.add(`${Math.round(d.disc.w)}x${Math.round(d.disc.h)}`)
    if (d.disc.w < min) fail(`${at}: disc ${d.disc.w.toFixed(1)}px wide, less than ${min}px`)
    if (Math.abs(d.disc.w - d.disc.h) > 1) fail(`${at}: disc ${d.disc.w.toFixed(1)}x${d.disc.h.toFixed(1)} is not square`)
    if (Math.abs(d.button.w - d.disc.w) > 1 || Math.abs(d.button.h - d.disc.h) > 1) {
      fail(`${at}: button ${d.button.w.toFixed(1)}x${d.button.h.toFixed(1)} is not its disc's size (the selected ring follows the button)`)
    }
    if (d.letter !== letter) fail(`${at}: shows "${d.letter}", not "${letter}"`)
    if (letter && d.ink) {
      const cx = d.ink.x + d.ink.w / 2 - (d.disc.x + d.disc.w / 2)
      const cy = d.ink.y + d.ink.h / 2 - (d.disc.y + d.disc.h / 2)
      if (Math.abs(cx) > d.disc.w * 0.08 || Math.abs(cy) > d.disc.h * 0.12) {
        fail(`${at}: the initial is off centre by ${cx.toFixed(1)}, ${cy.toFixed(1)}px`)
      }
      // The text box spans the font's ascent and descent: for 42 units of
      // font size, roughly 45% to 60% of the disc.
      const share = d.ink.h / d.disc.h
      if (share < 0.3 || share > 0.7) fail(`${at}: the initial's box is ${(share * 100).toFixed(0)}% of the disc's height`)
    }
  }
  return [...sizes].join(', ')
}

for (const width of [320, 390, 1440]) {
  const { ctx, page } = await open(width, '/v2/', true)
  try {
    await page.locator('fieldset', { has: page.locator('legend', { hasText: 'Pick your avatar' }) }).waitFor({ timeout: 10_000 })
  } catch {
    fail(`${width}px: onboarding's avatar grid never appeared`)
    await ctx.close()
    continue
  }
  const read = () => page.evaluate(discs, 'legend:Pick your avatar')
  const named = judge(`${width}px onboarding, named Sam`, await read(), 'S', 40)
  await page.getByLabel('Name').fill('')
  const bare = judge(`${width}px onboarding, no name`, await read(), '', 40)
  await page.getByLabel('Name').fill('Robin')
  const typed = judge(`${width}px onboarding, named Robin`, await read(), 'R', 40)
  console.log(`── ${String(width).padStart(4)}px  onboarding discs ${named} · bare ${bare} · retyped ${typed}`)
  await ctx.close()
}

{
  const { ctx, page } = await open(1440, '/v2/profile', false)
  const picker = '[role="radiogroup"][aria-label="Avatar for Sam"]'
  try {
    await page.locator(picker).waitFor({ timeout: 10_000 })
    const sizes = judge('Settings, Your profile', await page.evaluate(discs, picker), 'S', 47)
    console.log(`── 1440px  settings picker discs ${sizes}`)
  } catch (err) {
    fail(`Settings' avatar picker never appeared (${err.message.split('\n')[0]})`)
  }
  const bar = await page.evaluate(() => {
    const el = document.querySelector('header [data-profile-avatar], nav [data-profile-avatar]')
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { kind: el.dataset.profileAvatar, w: b.width, h: b.height, text: el.textContent }
  })
  if (!bar) fail('the top bar has no avatar')
  else {
    if (bar.kind !== 'nebula' || bar.text !== 'S') fail(`the top bar's avatar is ${bar.kind} "${bar.text}", not the nebula with "S"`)
    if (Math.round(bar.w) !== 28 || Math.round(bar.h) !== 28) fail(`the top bar's avatar is ${bar.w}x${bar.h}, not 28x28`)
    console.log(`── 1440px  top bar avatar ${bar.kind} "${bar.text}" ${Math.round(bar.w)}x${Math.round(bar.h)}`)
  }
  await ctx.close()
}

await browser.close()
server.close()
console.log(`\n${problems} avatar disc problem(s).`)
process.exit(problems ? 1 : 0)
