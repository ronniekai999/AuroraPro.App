// The ambient colour of a piece of artwork: the wash a title in focus casts
// on the page behind it. Sampled in the browser from an image that is already
// on screen, so it costs no request.
//
// The result is deliberately not the artwork's colour as such. It is clamped
// dark and low in saturation, so the wash can never become garish, never
// competes with the artwork, and never moves the text on top of it out of its
// contrast range: whatever the hue, the page's primary text keeps more than
// 9:1 on the wash at full strength and its secondary text more than 5:1 (the
// page lays it at 0.6 over graphite, which is darker still). Anything that
// goes wrong (no canvas, a tainted canvas, a picture with no colour to speak
// of) yields null, and the page stays neutral.

const SIZE = 16
// HSL bounds of the clamp.
const MAX_SATURATION = 0.5
const MIN_LIGHTNESS = 0.14
const MAX_LIGHTNESS = 0.22
// HSL lightness is not luminance: at the same lightness a green is far
// brighter to the eye than a blue. The result is therefore also held under
// this relative luminance, which is what the contrast figures above rest on.
const MAX_LUMINANCE = 0.045
// A picture whose weighted average is this close to grey (as a share of its
// brightest channel) has no colour worth borrowing: a grey wash on a graphite
// page would only look like a smudge. Below MIN_BRIGHTEST the ratio is noise.
const MIN_CHROMA_SHARE = 0.12
const MIN_BRIGHTEST = 12
const ALPHA = 0.6

// Results by picture URL, newest last, and no more than this many: a session
// that opens hundreds of titles must not keep a colour for each.
const CACHE_LIMIT = 64
const cache = new Map<string, string | null>()
function remember(key: string, color: string | null) {
  cache.delete(key)
  cache.set(key, color)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
}
// One sample per picture at a time: the same image is asked about from its
// ref callback and from its load event, and from every render while the
// first answer is still on its way.
const inflight = new Map<string, Promise<string | null>>()
/** For tests. */
export function ambientCacheSize(): number { return cache.size }
export function clearAmbientCache(): void { cache.clear(); inflight.clear() }

/** RGB (0..255) → the clamped wash colour as a CSS colour, or null when the
 *  input is too grey to be worth showing. Exported for tests. */
export function clampAmbient(r: number, g: number, b: number): string | null {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  if (mx < MIN_BRIGHTEST || (mx - mn) / mx < MIN_CHROMA_SHARE) return null
  const [h, s, l] = rgbToHsl(r, g, b)
  let rgb = hslToRgb(
    h,
    Math.min(s, MAX_SATURATION),
    Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, l)),
  )
  // Scaling all three channels together darkens without moving the hue.
  for (let i = 0; i < 12 && luminance(rgb) > MAX_LUMINANCE; i++) {
    rgb = [Math.round(rgb[0] * 0.92), Math.round(rgb[1] * 0.92), Math.round(rgb[2] * 0.92)]
  }
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${ALPHA})`
}

/** The saturation-weighted average of RGBA pixel data: colourful pixels pull
 *  harder than grey ones, so a picture that is mostly night sky with one warm
 *  window comes out warm rather than black. Exported for tests. */
export function weightedAverage(data: ArrayLike<number>): [number, number, number] | null {
  let r = 0, g = 0, b = 0, n = 0
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 8) continue // transparent: says nothing about colour
    const mx = Math.max(data[i], data[i + 1], data[i + 2])
    const mn = Math.min(data[i], data[i + 1], data[i + 2])
    const w = (mx - mn) + 8
    r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; n += w
  }
  if (n === 0) return null
  return [r / n, g / n, b / n]
}

/** The ambient colour of an image element that has finished loading, or null
 *  (no colour worth showing, or no way to read one). Never rejects.
 *
 *  How to call it: from the image's `onLoad`, and from a ref callback for one
 *  that was complete before `onLoad` was attached, then set `--ambient` on
 *  whatever should carry the wash:
 *
 *      void ambientFor(img).then(color => { if (stillShowing(img)) setColor(color) })
 *
 *  The answer comes later, so check that the picture is still the one on
 *  screen before using it. Results are cached by URL (a bounded cache). An
 *  image that has not decoded yet answers null and is NOT cached, so asking
 *  again once it has loaded works.
 *
 *  The sample is taken off the critical path: after the browser is idle, and
 *  from a 16px bitmap the browser makes itself, so a large backdrop is not
 *  decoded synchronously on the main thread to read sixteen rows of it. */
export async function ambientFor(img: HTMLImageElement | null | undefined): Promise<string | null> {
  if (!img) return null
  const key = img.currentSrc || img.src
  if (!key) return null
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  if (!img.complete || img.naturalWidth === 0) return null
  const pending = inflight.get(key)
  if (pending) return pending
  const sampling = sample(img, key).finally(() => { inflight.delete(key) })
  inflight.set(key, sampling)
  return sampling
}

async function sample(img: HTMLImageElement, key: string): Promise<string | null> {
  await idle()
  let color: string | null = null
  try {
    let source: CanvasImageSource = img
    let bitmap: ImageBitmap | null = null
    if (typeof createImageBitmap === 'function') {
      try {
        bitmap = await createImageBitmap(img, { resizeWidth: SIZE, resizeHeight: SIZE, resizeQuality: 'low' })
        source = bitmap
      } catch {
        // No resizing bitmaps here: read the element itself.
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) {
      ctx.drawImage(source, 0, 0, SIZE, SIZE)
      // Throws on a picture from another origin without CORS approval (the
      // canvas is tainted). The app's artwork is same-origin; if that ever
      // stops being true the page simply stays neutral.
      const avg = weightedAverage(ctx.getImageData(0, 0, SIZE, SIZE).data)
      if (avg) color = clampAmbient(avg[0], avg[1], avg[2])
    }
    bitmap?.close()
  } catch {
    color = null
  }
  remember(key, color)
  return color
}

function idle(): Promise<void> {
  return new Promise(resolve => {
    const w = (typeof window === 'undefined' ? undefined : window) as
      (Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }) | undefined
    if (w && typeof w.requestIdleCallback === 'function') w.requestIdleCallback(() => resolve(), { timeout: 400 })
    else setTimeout(resolve, 0)
  })
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  let h: number
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (mx === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v] }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const ch = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [Math.round(ch(h + 1 / 3) * 255), Math.round(ch(h) * 255), Math.round(ch(h - 1 / 3) * 255)]
}
