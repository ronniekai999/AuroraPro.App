// End-to-end PWA registration check in real Chromium (see docs/push.md):
// serves the built bundle the way Aurora's Go
// server does — /v2/ mount, SPA fallback, no-cache, and the REAL production
// Content-Security-Policy, extracted from internal/api/router.go at run
// time — then asserts the service worker registers, activates, claims the
// first-visit page, and that the manifest is fetchable and points at the
// mount.
//
// Because the CSP comes from the Go source rather than a copy, this catches
// the failures unit tests can't: a policy edit that blocks registration
// (worker-src losing 'self'), a renamed sw.js, a manifest that 404s into the
// SPA fallback. Each makes THIS fail while everything else stays green.
//
// It also checks the other half of "no service worker cache": a tab left open
// across a deploy must notice. The built index.html has to carry its build id
// (vite-build-id.ts), and when the served index.html names another build, the
// page has to fetch it under this CSP and show the update notice
// (lib/buildUpdate.ts). The deploy is simulated by rewriting the id served.
//
// Run after a build (the audit chain does): node scripts/verify-pwa.mjs

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(SCRIPTS, '..', '..', '..', 'v2')
const REPO_ROOT = path.join(SCRIPTS, '..', '..', '..', '..')

// Same pin + fallback contract as scripts/verify-page-alignment.mjs: prefer
// the canonical box's pinned browser, fall back to Playwright's own
// resolution elsewhere, CHROMIUM_PATH overrides both.
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = existsSync(PINNED) ? PINNED : undefined

/**
 * Extract the production CSP from frontendHeaders in router.go. Loud failure
 * by design: if the Go code moves or is rewritten in a way this can't parse,
 * the run errors with instructions instead of quietly testing a stale copy —
 * a hardcoded duplicate here is exactly the drift the review flagged.
 */
async function productionCSP() {
  const src = await readFile(path.join(REPO_ROOT, 'internal', 'api', 'router.go'), 'utf8')
  const start = src.indexOf('"Content-Security-Policy",')
  if (start === -1) {
    throw new Error('router.go no longer sets "Content-Security-Policy" where verify-pwa.mjs expects — update the extractor')
  }
  // The value is a multi-line Go string concatenation ending with `'none'")`.
  const end = src.indexOf('")', start)
  if (end === -1) throw new Error('router.go CSP block has no terminator — update the verify-pwa.mjs extractor')
  const parts = src
    .slice(start, end + 1)
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .flatMap(line => [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]))
  const csp = parts.slice(1).join('') // parts[0] is the header name itself
  if (!csp.includes('default-src') || !csp.includes('worker-src')) {
    throw new Error(`extracted CSP looks wrong (${csp.slice(0, 60)}…) — update the verify-pwa.mjs extractor`)
  }
  return csp
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exitCode = 1
}

try {
  await access(path.join(DIST, 'index.html'))
} catch {
  console.error(`No build output at ${DIST} — run \`npm run build\` first (the audit chain does).`)
  process.exit(1)
}

const CSP = await productionCSP()

// What a deploy changes, as far as an open tab can see: the id in the served
// index.html. null serves the build as it is.
let deployedBuildId = null
const BUILD_META = /(<meta name="aurora-build" content=")([^"]*)(")/

// Minimal mirror of the Go v2Handler: real file or index.html fallback.
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
  if (deployedBuildId !== null && path.basename(file) === 'index.html') {
    body = Buffer.from(body.toString('utf8').replace(BUILD_META, `$1${deployedBuildId}$3`))
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache, must-revalidate',
    'Content-Security-Policy': CSP,
  })
  res.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ executablePath: EXE }).catch(err => {
  console.error(`Could not launch Chromium (tried ${EXE ?? "Playwright's own browser"}) — set CHROMIUM_PATH or run: npx playwright install chromium`)
  throw err
})

try {
  const page = await browser.newPage()
  await page.goto(`${origin}/v2/`, { waitUntil: 'load' })

  // 1. The worker registers and activates under the production CSP.
  const reg = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { error: 'serviceWorker unsupported' }
    try {
      const r = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for serviceWorker.ready')), 10_000)),
      ])
      return { scope: r.scope, script: r.active?.scriptURL ?? '' }
    } catch (e) {
      return { error: String(e) }
    }
  })
  if (reg.error) fail(`service worker did not become ready: ${reg.error}`)
  else {
    if (!reg.scope.endsWith('/v2/')) fail(`registration scope = ${reg.scope}, want …/v2/ (must cover the whole app)`)
    else console.log(`✓ service worker active, scope ${new URL(reg.scope).pathname}`)
    if (!reg.script.endsWith('/v2/sw.js')) fail(`worker script = ${reg.script}, want …/v2/sw.js`)
  }

  // 2. clients.claim() means THIS page — the first visit, loaded before any
  //    worker existed — becomes controlled without a reload. This is the
  //    assertion that binds claim: after a reload any active worker controls
  //    the page regardless, which is why the old reload-based check passed
  //    the review's claim-removal mutation.
  const controlledFirstVisit = await page.evaluate(() => new Promise(resolve => {
    if (navigator.serviceWorker.controller) return resolve(true)
    const timer = setTimeout(() => resolve(false), 5_000)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(timer)
      resolve(true)
    }, { once: true })
  }))
  if (!controlledFirstVisit) fail('first-visit page never became controlled — clients.claim() regressed')
  else console.log('✓ first-visit page controlled without a reload (clients.claim)')

  // 3. …and a reloaded page is controlled from the start (registration +
  //    activation sanity, not a claim check).
  await page.reload({ waitUntil: 'load' })
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller)
  if (!controlled) fail('page is not controlled after reload — registration/activation broke')
  else console.log('✓ page controlled after reload')

  // 4. The manifest link resolves to real JSON with the right mount — not the
  //    SPA fallback (which would be text/html and prove the file is missing).
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]')
    if (!link) return { error: 'no <link rel="manifest">' }
    const res = await fetch(link.href)
    return {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      json: await res.json().catch(() => null),
    }
  })
  if (manifest.error) fail(manifest.error)
  else if (manifest.status !== 200 || !manifest.json) fail(`manifest fetch: status ${manifest.status}, parseable=${!!manifest.json}`)
  else if (manifest.json.scope !== '/v2/' || manifest.json.start_url !== '/v2/') {
    fail(`manifest scope/start_url = ${manifest.json.scope}/${manifest.json.start_url}, want /v2/ for both`)
  } else console.log(`✓ manifest ok (${manifest.type}), scope /v2/`)

  // 4. A deploy reaches an open tab. The page must carry the id it was built
  //    with, fetch /v2/ under the production CSP, and say so when it differs.
  const own = await page.evaluate(() => document.querySelector('meta[name="aurora-build"]')?.getAttribute('content') ?? '')
  if (!/^[0-9a-f]{20}$/.test(own)) {
    fail(`built index.html has no aurora-build id (got "${own}") — is auroraBuildId() still in vite.config.ts?`)
  } else {
    // The visible card; the same words also sit in a screen-reader-only live region.
    const notice = page.locator('.toast', { hasText: 'Aurora was updated' })
    // The same build deployed: a check must stay quiet.
    await page.evaluate(() => window.dispatchEvent(new Event('aurora:stale-bundle')))
    await page.waitForTimeout(1500)
    if (await notice.count()) fail('update notice shown while the deployed build is the one this tab runs')
    deployedBuildId = 'f'.repeat(20) === own ? 'e'.repeat(20) : 'f'.repeat(20)
    await page.evaluate(() => window.dispatchEvent(new Event('aurora:stale-bundle')))
    try {
      await notice.waitFor({ state: 'visible', timeout: 10_000 })
      console.log(`✓ open tab notices a newer deployed build (${own} → ${deployedBuildId})`)
    } catch {
      fail('a tab running an older build never showed the update notice (fetch blocked by the CSP, or the check broke)')
    }
  }
} finally {
  await browser.close()
  server.close()
}

if (process.exitCode) {
  console.error('PWA verification FAILED')
} else {
  console.log('PWA verification passed')
}
