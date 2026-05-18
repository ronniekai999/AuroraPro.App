// Phase 6 — Dynamic Theming from image.
//
// Given an image URL (typically a poster), extract a dominant
// "accent" color and a complementary "glow" color via a tiny canvas-
// based histogram. Used by the detail view to tint accent buttons +
// glow shadows to match the artwork.
//
// Pure client-side, runs at most a few times per session-visited
// detail item. Cached by URL so revisiting the same media doesn't
// recompute. Failure path is silent — we return a sensible default
// (Aurora purple) and let the UI fall back to the existing styling.

const cache = new Map<string, ExtractedPalette>()

export interface ExtractedPalette {
  // CSS color strings (rgb format) ready to drop into style/var.
  accent: string
  accentSoft: string // 30% mix toward white — for button bg
  glow: string       // alpha-applied accent for box-shadow
}

// Default — Aurora's purple. Returned when extraction fails or the
// image hasn't loaded yet.
export const DEFAULT_PALETTE: ExtractedPalette = {
  accent: 'rgb(168, 85, 247)',
  accentSoft: 'rgba(168, 85, 247, 0.18)',
  glow: 'rgba(168, 85, 247, 0.45)',
}

// Extract a palette by drawing the image to an offscreen canvas at a
// tiny resolution (32×32) and computing the average of the most-
// saturated quartile of pixels. We use saturated pixels (not just
// brightest) so the accent matches the artwork's intent rather than
// catching a stray white/black background tile.
export async function extractPalette(imageURL: string): Promise<ExtractedPalette> {
  if (!imageURL) return DEFAULT_PALETTE
  const cached = cache.get(imageURL)
  if (cached) return cached

  try {
    const img = await loadImage(imageURL)
    const palette = computePalette(img)
    cache.set(imageURL, palette)
    return palette
  } catch {
    // Network failure, CORS rejection, decode error — all silent
    // fall-through to the default. The detail view continues to
    // render with the standard purple accent.
    return DEFAULT_PALETTE
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // crossOrigin='anonymous' makes the request CORS-mode but
    // without credentials. The canvas extraction below requires
    // either (a) a same-origin image OR (b) a cross-origin image
    // served with `Access-Control-Allow-Origin`. In production
    // Aurora's image proxy (`/api/images/...`) is same-origin with
    // the SPA, so extraction works regardless of CORS headers. If
    // the SPA ever moves to a different origin (CDN, subdomain),
    // the image proxy would need explicit ACAO headers to keep
    // extraction working. External TMDB URLs (used in the Requests
    // create flow) fall back to DEFAULT_PALETTE because TMDB
    // doesn't echo CORS headers for non-credentialed image GETs.
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(e)
    img.src = url
  })
}

function computePalette(img: HTMLImageElement): ExtractedPalette {
  const SIZE = 32
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return DEFAULT_PALETTE
  ctx.drawImage(img, 0, 0, SIZE, SIZE)
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE)

  // Score each pixel by saturation × brightness. Top quartile by
  // score gets averaged into the accent color.
  type Scored = { r: number; g: number; b: number; score: number }
  const pixels: Scored[] = []
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a = data[i + 3]
    if (a < 128) continue // skip transparent
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max === 0 ? 0 : (max - min) / max
    const brightness = (max / 255)
    // Combined score: saturated mid-brightness pixels win. Pure
    // black/white drops to near-zero; saturated mid-tones score
    // highest.
    const score = sat * brightness * (1 - Math.abs(brightness - 0.55))
    pixels.push({ r, g, b, score })
  }
  if (pixels.length === 0) return DEFAULT_PALETTE

  pixels.sort((a, b) => b.score - a.score)
  const top = pixels.slice(0, Math.max(8, Math.floor(pixels.length / 4)))
  let r = 0, g = 0, b = 0
  for (const p of top) {
    r += p.r
    g += p.g
    b += p.b
  }
  r = Math.round(r / top.length)
  g = Math.round(g / top.length)
  b = Math.round(b / top.length)

  // Avoid washed-out greys — if saturation is too low, fall back to
  // the default purple. Threshold tuned to reject mostly-black
  // posters (where the algorithm would pick near-grey).
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max - min < 30) return DEFAULT_PALETTE

  return {
    accent: `rgb(${r}, ${g}, ${b})`,
    accentSoft: `rgba(${r}, ${g}, ${b}, 0.18)`,
    glow: `rgba(${r}, ${g}, ${b}, 0.45)`,
  }
}
