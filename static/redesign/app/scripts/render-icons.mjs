// Rasterize the PWA icon set from the favicon mark, deterministically, using
// the same pinned Chromium the audit chain already requires — no sharp, no
// ImageMagick, nothing new to install. Outputs are committed; re-run this
// script only when the mark or the set changes:
//
//   node scripts/render-icons.mjs
//
// Variants (see docs/push.md):
//   icon-192 / icon-512              purpose "any": the favicon mark as-is,
//                                    transparent outside the circle.
//   icon-maskable-192 / -512         purpose "maskable": full-bleed gradient,
//                                    mark held inside the central 80% safe
//                                    zone so any OS mask shape keeps it whole.
//   apple-touch-icon (180)           opaque #050505 matte — iOS composites
//                                    transparency onto black unpredictably,
//                                    so bake the app background in.
//   badge-96                         Android status-bar badge: alpha-only
//                                    white silhouette (circle with the play
//                                    triangle punched out). Unreferenced
//                                    until Phase 2's push payload uses it.

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

// Same pin + fallback contract as scripts/verify-page-alignment.mjs: pinned
// browser when present, Playwright's own resolution elsewhere, CHROMIUM_PATH
// overrides both.
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const EXE = existsSync(PINNED) ? PINNED : undefined

// The shared gradient from public/favicon.svg / App.tsx's aurora marks.
const GRADIENT = `
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#A855F7" />
    <stop offset="0.5" stop-color="#7C3AED" />
    <stop offset="1" stop-color="#22D3EE" />
  </linearGradient>`

// viewBox 36 mark, identical geometry to favicon.svg.
const CIRCLE_MARK = `<circle cx="18" cy="18" r="16" fill="url(#g)" /><path d="M14 11L26 18L14 25Z" fill="#FFFFFF" />`

const VARIANTS = [
  // purpose "any" — transparent corners are fine (and look right in
  // circular contexts like the Chrome install dialog).
  { file: 'icon-192.png', size: 192, transparent: true, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><defs>${GRADIENT}</defs>${CIRCLE_MARK}</svg>` },
  { file: 'icon-512.png', size: 512, transparent: true, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><defs>${GRADIENT}</defs>${CIRCLE_MARK}</svg>` },

  // purpose "maskable" — the OS crops an arbitrary shape out of the full
  // square; the triangle spans ~28% of the width, centered with the play
  // glyph's usual slight rightward optical shift, well inside the 80% zone.
  ...[192, 512].map(size => ({
    file: `icon-maskable-${size}.png`,
    size,
    transparent: false,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><defs>${GRADIENT}</defs><rect width="36" height="36" fill="url(#g)" /><path d="M13.5 11L24.5 18L13.5 25Z" fill="#FFFFFF" /></svg>`,
  })),

  // iOS home-screen icon: opaque matte in the app background color, mark at
  // ~89% so the circle reads edge-to-edge after iOS rounds the corners.
  { file: 'apple-touch-icon.png', size: 180, transparent: false, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><defs>${GRADIENT}</defs><rect width="36" height="36" fill="#050505" />${CIRCLE_MARK}</svg>` },

  // Alpha-only badge: Android ignores color and uses the alpha channel, so
  // the glyph is a white circle with the triangle cut out via mask.
  { file: 'badge-96.png', size: 96, transparent: true, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><defs><mask id="m"><circle cx="18" cy="18" r="16" fill="#FFFFFF" /><path d="M14 11L26 18L14 25Z" fill="#000000" /></mask></defs><rect width="36" height="36" fill="#FFFFFF" mask="url(#m)" /></svg>` },
]

const browser = await chromium.launch({ executablePath: EXE }).catch(err => {
  console.error(`Could not launch Chromium (tried ${EXE ?? "Playwright's own browser"}) — set CHROMIUM_PATH or run: npx playwright install chromium`)
  throw err
})

try {
  await mkdir(OUT, { recursive: true })
  const page = await browser.newPage()
  for (const v of VARIANTS) {
    await page.setViewportSize({ width: v.size, height: v.size })
    // The SVG fills the viewport exactly; margin 0 + block display kill the
    // default body gap and inline descender space.
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${v.size}px;height:${v.size}px}</style>${v.svg}`,
    )
    const png = await page.screenshot({ omitBackground: v.transparent, type: 'png' })
    await writeFile(path.join(OUT, v.file), png)
    console.log(`wrote public/${v.file} (${v.size}x${v.size}, ${png.length} bytes)`)
  }
} finally {
  await browser.close()
}
