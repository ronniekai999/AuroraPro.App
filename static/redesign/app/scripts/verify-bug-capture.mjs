// "Capture this page" (the bug report form), in real Chromium: the picture it
// makes must be the page as it is on screen.
//
// Two defects were found by making real captures and looking at them:
//
//   1. FONTS. The capture skipped the page's fonts. An SVG drawn as an image
//      loads none, so the copy of the page was set in a fallback face with
//      other widths while every element kept the height the real face gave
//      it: the error screen's heading ("That did not load.") wrapped onto a
//      second line and was drawn over the paragraph under it, and a title
//      page's heading broke in other places.
//   2. A BLANK LOWER HALF. On a phone, the error screen's report panel is in
//      the page's flow under its text, and opening it moves the window down
//      to it. The copy's body was a scroll box of the window's height that
//      cut off everything below it, then was moved up by the scroll, and the
//      panel, removed from the copy, let the page's text slide down into its
//      place: the picture was a strip of the page and then blank.
//
// This serves the BUILT app as the server does (the /v2/ mount, the SPA
// fallback, the REAL Content-Security-Policy read from internal/api/router.go,
// as verify-pwa.mjs does, since the capture reads the page's font files and
// draws through a data: image under it), signed in against a stubbed API, and
// makes captures through the form's own button:
//
//   - a title page (a large display heading, cut to two lines with an
//     ellipsis) through the dialog, at 1440px, at the top of the page, and
//     one with no artwork (an image the capture cannot read, which used to
//     fail the whole capture);
//   - the Movies grid, scrolled, through the dialog, at 1440px (the top bar
//     sticks to the window);
//   - a title page scrolled down, through the dialog, at 390px (the top bar
//     sticks, the tab bar is fixed to the window's foot);
//   - the error screen through its report panel at 1440px and at 390px,
//     where opening the panel moves the window down to it.
//
// Each picture is compared, pixel by pixel in the page, with a screenshot of
// the page at the same moment with the report's own parts hidden (for the
// error screen, scrolled to the top of the page, which is what its panel
// says a capture shows). A share of differing pixels over a small limit
// fails, and so does any difference over a band of the picture: a heading
// in another face, text drawn over text, a blank or shifted region. What the
// fixed capture leaves is antialiasing at the edges of some glyphs, well
// under the limits; each of the two defects, alone, puts several percent of
// the picture and its heading over them.
//
// What it leans on: the browser hides scrollbars (headless does; a visible
// one is drawn in the screenshot and not in the copy), and the Bricolage
// headings pin the font embedding (where Inter is installed on the machine,
// the copy draws Inter text right with no fonts embedded; CI has none).
//
// Run after a build (the audit chain does): node scripts/verify-bug-capture.mjs

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, access, mkdtemp, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(SCRIPTS, '..', '..', '..', 'v2')
const REPO_ROOT = path.join(SCRIPTS, '..', '..', '..', '..')

// Same pin + fallback contract as scripts/verify-page-alignment.mjs.
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = existsSync(PINNED) ? PINNED : undefined

// A pixel differs when a channel is off by more than this (of 255). Above
// the one difference Chromium's own drawing of an SVG image makes: a
// backdrop blur (the top bar's) samples a little past its box, so the
// bar's lower edge picks up a tint of the artwork under it, up to about 30.
// A wrong face, text over text or a blank region differs by far more.
const CHANNEL = 48
// The picture: at most this share of its pixels may differ.
const WHOLE_LIMIT = 0.006
// Each band a tenth of the picture high: at most this share. A wrong face
// or a shifted block fails one even when the picture as a whole is mostly
// background.
const BAND_LIMIT = 0.03
// The page's main heading and an empty field's placeholder, where a capture
// has gone wrong in small ways before (a clamped heading lost its
// ellipsis; a placeholder was drawn in the field's text colour): at most
// this share each. Both are 0.00% when the capture is right.
const PART_LIMIT = 0.0025

/** The production CSP, from router.go (the same extractor as verify-pwa.mjs;
 *  it fails loudly rather than test a stale copy). */
async function productionCSP() {
  const src = await readFile(path.join(REPO_ROOT, 'internal', 'api', 'router.go'), 'utf8')
  const start = src.indexOf('"Content-Security-Policy",')
  if (start === -1) throw new Error('router.go no longer sets "Content-Security-Policy" where verify-bug-capture.mjs expects — update the extractor')
  const end = src.indexOf('")', start)
  if (end === -1) throw new Error('router.go CSP block has no terminator — update the verify-bug-capture.mjs extractor')
  const csp = src.slice(start, end + 1).split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .flatMap(line => [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]))
    .slice(1).join('')
  if (!csp.includes('default-src') || !csp.includes('connect-src')) throw new Error(`extracted CSP looks wrong (${csp.slice(0, 60)}…)`)
  return csp
}

try {
  await access(path.join(DIST, 'index.html'))
} catch {
  console.error(`No build output at ${DIST} — run \`npm run build\` first (the audit chain does).`)
  process.exit(1)
}

const CSP = await productionCSP()
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2',
}
// The Go v2Handler's shape: the file, or index.html; never cached unrevalidated.
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
    'Cache-Control': 'no-cache, must-revalidate',
    'Content-Security-Policy': CSP,
  })
  res.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const USER = { id: 1, username: 'checker', email: 'checker@example.invalid', role: 'admin' }
const NOW = '2026-01-01T00:00:00Z'
const TITLE = {
  id: 5, library_id: 1, type: 'movie', title: 'The Remarkable Long Afternoon of Everybody Else',
  year: 2019, runtime_minutes: 128, content_rating: 'PG-13', genres: ['Drama', 'Comedy'],
  overview: 'Over one long summer afternoon, a family that has not been in one room for a decade finds out what everyone else already knew.',
  tagline: 'Nobody leaves until dinner.', poster_path: '/poster.png', backdrop_path: '/backdrop.png',
  added_at: NOW, updated_at: NOW,
}
const GRID = Array.from({ length: 60 }, (_, i) => ({
  ...TITLE, id: 100 + i, title: `Movie number ${i + 1} with a longer name`, tagline: undefined, overview: undefined,
}))
// Artwork: the app's own icons, so the images are real and same-origin.
const ART = { poster: path.join(DIST, 'icon-512.png'), backdrop: path.join(DIST, 'icon-maskable-512.png') }

/** A signed-in tab on the stubbed API. `crash` makes the title page throw
 *  while it draws (its title is not text), which shows the error screen. */
async function openTab(browser, [width, height], { crash = false } = {}) {
  // A phone's screen is dense: there the capture is drawn at twice the size.
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: width < 768 ? 2 : 1 })
  await ctx.route(`${ORIGIN}/api/**`, route => {
    const p = new URL(route.request().url()).pathname
    if (p.startsWith('/api/images/')) return route.fulfill({ path: p.includes('poster') ? ART.poster : ART.backdrop, contentType: 'image/png' })
    if (p === '/api/auth/me') return route.fulfill({ json: USER })
    if (p === '/api/feedback/config') return route.fulfill({ json: { enabled: true } })
    if (p === '/api/media/5') return route.fulfill({ json: crash ? { ...TITLE, title: { not: 'text' } } : TITLE })
    if (p === '/api/media/6') return route.fulfill({ json: { ...TITLE, id: 6, poster_path: undefined, backdrop_path: undefined } })
    if (p.startsWith('/api/media/')) return route.fulfill({ json: [] })
    if (p === '/api/media') return route.fulfill({ json: { data: GRID, total_items: GRID.length, page: 1, per_page: GRID.length, total_pages: 1 } })
    return route.fulfill({ json: {} })
  })
  // Nothing else reaches out (the cast SDK, the event socket).
  await ctx.route(url => !url.href.startsWith(ORIGIN), route => route.abort())
  await ctx.route(`${ORIGIN}/ws`, route => route.abort())
  await ctx.addInitScript(user => { localStorage.setItem('aurora_user', JSON.stringify(user)) }, USER)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  return { ctx, page, errors }
}

/** Waits until the fonts have loaded and the images have finished (a lazy
 *  image that is not laid out never does: at most three seconds), and a
 *  moment for what fades in after. */
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    const images = Promise.all([...document.images].map(img => (img.complete ? null : new Promise(r => { img.addEventListener('load', r); img.addEventListener('error', r) }))))
    await Promise.race([images, new Promise(r => setTimeout(r, 3000))])
  })
  await page.waitForTimeout(700)
}

/** Presses "Capture this page" with the keyboard (a pointer left over the
 *  page would hover something in one picture and not the other) and
 *  returns the attachment's preview, as a data: URL. */
async function capture(page) {
  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: /Capture this page/ }).press('Enter')
  const preview = page.locator('img[alt="Attachment preview"]')
  try {
    await preview.waitFor({ timeout: 20_000 })
  } catch (err) {
    const said = await page.locator('#bug-error, [role=alert]').allInnerTexts()
    throw new Error(`no capture was attached (the form says: ${JSON.stringify(said)})`, { cause: err })
  }
  // blob: is not in connect-src: read the preview through a canvas.
  return preview.evaluate(async img => {
    if (!img.complete) await new Promise(r => { img.onload = r })
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    c.getContext('2d').drawImage(img, 0, 0)
    return c.toDataURL('image/png')
  })
}

/** A screenshot of the page with the report's own parts hidden, as a
 *  capture leaves them (their space kept, nothing drawn), taken just before
 *  the capture: once a capture is attached, the form grows by its preview,
 *  and on the error screen the page's text, centred beside the panel,
 *  moves. `fromTop` takes it from the top of the page; the window goes back
 *  to the form when its button is pressed. */
async function reference(page, { fromTop = false } = {}) {
  const hide = await page.addStyleTag({ content: '[data-screenshot-exclude="true"]{visibility:hidden!important}' })
  const y = await page.evaluate(() => window.scrollY)
  if (fromTop) await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(300)
  const png = await page.screenshot()
  const parts = await page.evaluate(() => {
    const box = el => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
    }
    const out = []
    const heading = document.querySelector('h1')
    if (heading && box(heading)) out.push({ name: 'heading', ...box(heading) })
    const field = [...document.querySelectorAll('input[placeholder]')]
      .find(el => !el.value && !el.closest('[data-screenshot-exclude="true"]') && box(el))
    if (field) out.push({ name: `field "${field.placeholder}"`, ...box(field) })
    // Every element with words of its own in the window, to say where a
    // difference is when there is one.
    const texts = []
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('[data-screenshot-exclude="true"]')) continue
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
      const b = own && box(el)
      if (b) texts.push({ name: `<${el.tagName.toLowerCase()}> "${own.slice(0, 32)}" (${getComputedStyle(el).fontFamily.split(',')[0]})`, ...b })
    }
    return { list: out, texts, width: innerWidth }
  })
  await hide.evaluate(el => el.remove())
  if (fromTop) await page.evaluate(top => window.scrollTo(0, top), y)
  await page.waitForTimeout(300)
  return { url: `data:image/png;base64,${png.toString('base64')}`, parts }
}

/** Compares the two pictures in the page. */
async function compare(page, shot, ref) {
  return page.evaluate(async ({ shot, ref, CHANNEL }) => {
    const load = src => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src })
    const [a, b] = await Promise.all([load(shot), load(ref.url)])
    if (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight) {
      return { size: `${a.naturalWidth}x${a.naturalHeight} against ${b.naturalWidth}x${b.naturalHeight}` }
    }
    const w = a.naturalWidth
    const h = a.naturalHeight
    const pixels = img => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      return g.getImageData(0, 0, w, h).data
    }
    const pa = pixels(a)
    const pb = pixels(b)
    const off = new Uint8Array(w * h)
    let transparent = 0
    for (let i = 0; i < w * h; i++) {
      const k = i * 4
      if (pa[k + 3] < 255) transparent++
      if (Math.abs(pa[k] - pb[k]) > CHANNEL || Math.abs(pa[k + 1] - pb[k + 1]) > CHANNEL || Math.abs(pa[k + 2] - pb[k + 2]) > CHANNEL) off[i] = 1
    }
    const share = (x0, y0, x1, y1) => {
      let n = 0
      let t = 0
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) { n++; t += off[y * w + x] }
      }
      return n ? t / n : 0
    }
    const bands = []
    for (let i = 0; i < 10; i++) bands.push(share(0, (h * i) / 10, w, (h * (i + 1)) / 10))
    return {
      whole: share(0, 0, w, h),
      // The boxes are in CSS pixels; the pictures in device pixels.
      parts: ref.parts.list.map(p => {
        const k = w / ref.parts.width
        return { name: p.name, share: share(p.x * k, p.y * k, (p.x + p.w) * k, (p.y + p.h) * k) }
      }),
      // Where the differing pixels are, in CSS pixels, and the elements with
      // words that differ most: what a failure in CI is about.
      where: (() => {
        const k = w / ref.parts.width
        let x0 = w, y0 = h, x1 = -1, y1 = -1
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          if (off[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
        }
        if (x1 < 0) return null
        const texts = ref.parts.texts
          .map(t => ({ name: t.name, share: share(t.x * k, t.y * k, (t.x + t.w) * k, (t.y + t.h) * k) }))
          .filter(t => t.share > 0.01)
          .sort((a, b) => b.share - a.share)
          .slice(0, 5)
        return { box: [x0, y0, x1, y1].map(v => Math.round(v / k)), texts }
      })(),
      band: Math.max(...bands),
      transparent: transparent / (w * h),
    }
  }, { shot, ref, CHANNEL })
}

let failed = false
// Every pair is written here when BUG_CAPTURE_PICTURES names a directory (to
// look at them); otherwise only a failing pair is, to a temporary one.
const KEEP = process.env.BUG_CAPTURE_PICTURES
const saved = KEEP || await mkdtemp(path.join(tmpdir(), 'aurora-bug-capture-'))
async function judge(name, page, shot, ref) {
  const r = await compare(page, shot, ref)
  const pct = v => `${(v * 100).toFixed(2)}%`
  const problems = []
  if (r.size) problems.push(`the picture is ${r.size}`)
  else {
    if (r.transparent > 0) problems.push(`${pct(r.transparent)} of the picture is not drawn at all`)
    if (r.whole > WHOLE_LIMIT) problems.push(`${pct(r.whole)} of its pixels differ from the screen (limit ${pct(WHOLE_LIMIT)})`)
    if (r.band > BAND_LIMIT) problems.push(`a tenth of it differs by ${pct(r.band)} (limit ${pct(BAND_LIMIT)})`)
    for (const part of r.parts) {
      if (part.share > PART_LIMIT) problems.push(`its ${part.name} differs by ${pct(part.share)} (limit ${pct(PART_LIMIT)})`)
    }
  }
  const base = path.join(saved, name.replace(/[^a-z0-9]+/gi, '-'))
  if (problems.length || KEEP) {
    await writeFile(`${base}-capture.png`, Buffer.from(shot.split(',')[1], 'base64'))
    await writeFile(`${base}-screen.png`, Buffer.from(ref.url.split(',')[1], 'base64'))
  }
  if (problems.length) {
    failed = true
    if (r.where) {
      const texts = r.where.texts.map(t => `${t.name} ${pct(t.share)}`).join('; ')
      problems.push(`differing pixels within x ${r.where.box[0]}-${r.where.box[2]}, y ${r.where.box[1]}-${r.where.box[3]}${texts ? `, most in: ${texts}` : ''}`)
    }
    console.error(`✗ ${name}: ${problems.join('; ')} (pictures in ${base}-*.png)`)
  } else {
    const parts = r.parts.map(part => `${part.name} ${pct(part.share)}`).join(', ')
    console.log(`✓ ${name}: ${pct(r.whole)} of pixels differ, worst tenth ${pct(r.band)}${parts ? `; ${parts}` : ''}`)
  }
}

/** The dialog, opened where the app offers it: the identity menu in a wide
 *  window, the Me page's list on a phone. */
async function openDialog(page, phone) {
  if (phone) {
    // Its name starts with the avatar's initial.
    await page.locator('nav[aria-label="Main"] [data-nav="me"]').click()
    await page.getByRole('button', { name: 'Report a bug' }).click()
  } else {
    await page.getByRole('button', { name: /account menu/ }).click()
    await page.getByRole('button', { name: 'Report a bug' }).click()
    // The menu closes with a fade: a capture taken during it draws it.
    await page.getByRole('group', { name: 'Account and profiles' }).waitFor({ state: 'detached' })
  }
  await page.getByRole('dialog').waitFor()
}

const browser = await chromium.launch({ executablePath: EXE }).catch(err => {
  console.error(`Could not launch Chromium (tried ${EXE ?? "Playwright's own browser"}) — set CHROMIUM_PATH or run: npx playwright install chromium`)
  throw err
})

try {
  const WIDE = [1440, 900]
  const PHONE = [390, 844]

  // A title page, at its top, through the dialog.
  {
    const { ctx, page } = await openTab(browser, WIDE)
    await page.goto(`${ORIGIN}/v2/title/5`)
    await page.locator('h1').waitFor()
    await settle(page)
    await openDialog(page, false)
    const ref = await reference(page)
    await judge('title page, 1440px', page, await capture(page), ref)
    await ctx.close()
  }

  // A title with no artwork: its poster is an <img> with nothing to show,
  // which html-to-image cannot read, and which used to fail the whole
  // capture ("The capture failed").
  {
    const { ctx, page } = await openTab(browser, WIDE)
    await page.goto(`${ORIGIN}/v2/title/6`)
    await page.locator('h1').waitFor()
    await settle(page)
    await openDialog(page, false)
    const ref = await reference(page)
    await judge('title page with no artwork, 1440px', page, await capture(page), ref)
    await ctx.close()
  }

  // The Movies grid, scrolled, through the dialog.
  {
    const { ctx, page } = await openTab(browser, WIDE)
    await page.goto(`${ORIGIN}/v2/movies`)
    await page.getByText('Movie number 60 with a longer name').first().waitFor()
    await settle(page)
    await openDialog(page, false)
    await page.evaluate(() => window.scrollTo(0, 700))
    await settle(page)
    const y = await page.evaluate(() => window.scrollY)
    if (y < 300) throw new Error(`the Movies grid did not scroll (scrollY ${y}); the check needs a scrolled page`)
    const ref = await reference(page)
    await judge('Movies grid scrolled, 1440px', page, await capture(page), ref)
    await ctx.close()
  }

  // A title page scrolled down, through the dialog, on a phone. "Report a
  // bug" is on the Me page there, and the app goes back to the page the
  // person came from, where they were, to open it (docs/bug-report-setup.md).
  {
    const { ctx, page } = await openTab(browser, PHONE)
    await page.goto(`${ORIGIN}/v2/title/5`)
    await page.locator('h1').waitFor()
    await settle(page)
    await page.evaluate(() => window.scrollTo(0, 400))
    await settle(page)
    await openDialog(page, true)
    await page.locator('h1').waitFor()
    await settle(page)
    const y = await page.evaluate(() => window.scrollY)
    if (y < 200) throw new Error(`the title page is not scrolled behind the dialog on a phone (scrollY ${y}); the check needs a scrolled page`)
    const ref = await reference(page)
    await judge('title page scrolled, 390px', page, await capture(page), ref)
    await ctx.close()
  }

  // The error screen, through its panel.
  for (const size of [WIDE, PHONE]) {
    const { ctx, page, errors } = await openTab(browser, size, { crash: true })
    await page.goto(`${ORIGIN}/v2/title/5`)
    try {
      await page.locator('[data-error-screen]').waitFor({ timeout: 10_000 })
    } catch (err) {
      throw new Error(`the error screen did not show (a title that is not text no longer stops the title page: give the check another way to stop it). Page errors: ${errors.join(' | ')}`, { cause: err })
    }
    await page.getByRole('button', { name: 'Report a problem' }).click()
    await page.locator('[data-error-report]').waitFor()
    await settle(page)
    const ref = await reference(page, { fromTop: true })
    const shot = await capture(page)
    const y = await page.evaluate(() => window.scrollY)
    if (size === PHONE && y < 200) throw new Error(`opening the panel on a phone no longer moves the window to it (scrollY ${y}); the check needs that`)
    await judge(`error screen, ${size[0]}px (window at ${Math.round(y)}px)`, page, shot, ref)
    await ctx.close()
  }
} finally {
  await browser.close()
  server.close()
}

if (failed) {
  console.error('✗ verify-bug-capture: a capture is not the page as it is on screen')
  process.exit(1)
}
console.log('✓ verify-bug-capture: every capture is the page as it is on screen')
