// A capture of the page for a bug report: what "Capture this page" draws.
//
// html-to-image copies the page (document.body) element by element, with each
// element's computed style written onto it, into an SVG <foreignObject>, and
// draws that SVG as an image. The copy is laid out again inside that image, in
// a document of its own, so whatever the page's layout took from outside the
// elements themselves has to be given to it here, or the picture is not what
// is on screen:
//
//   - Fonts. An SVG drawn as an image cannot load anything, the page's fonts
//     included. With no fonts the copy is set in a fallback face with other
//     widths, while every element keeps the height the real face gave it: a
//     large heading wrapped onto one more line and was drawn over the
//     paragraph under it. The faces the document has loaded go in as data:
//     URLs (embeddedFontCSS). The files are read with fetch() from the page's
//     own origin, which the Content-Security-Policy's connect-src 'self'
//     already allows, and from the browser's cache when it has them; the SVG
//     image is drawn from a data: URL, which img-src already allows. Nothing
//     in the policy changes. A face whose file cannot be read is left out:
//     that face falls back in the picture, and the capture still happens.
//   - html-to-image writes every font size 0.1px to 1px smaller than it is
//     (floor(size) - 0.1, as a margin against wrapping). With the real faces
//     that margin is what moves words between lines, so for the length of a
//     capture the size reaches it in a form it does not shrink
//     (keepFontSizes).
//   - The parts a capture leaves out (data-screenshot-exclude: the report
//     dialog, the error screen's report panel, toasts, the admin key fields) keep
//     their place. Removed from the copy, a part in the page's flow let the
//     rest move into its room: on the error screen on a phone, the page's
//     text moved down into the panel's place. An excluded part in the page's
//     flow is copied as an empty box with nothing drawn in it (nothing inside
//     it is copied); one taken out of the flow (fixed or absolutely placed,
//     like the dialog) changes nothing around it and is left out as before.
//   - Scrolling. The copy cannot be scrolled, so it is moved up and left by
//     the window's scroll. The body is the page's scroller only through the
//     window; in the copy its `overflow-x: hidden` made it a scroll box of
//     the window's height that cut off everything below, and moving it up
//     left a blank band at the bottom of the picture. The copy's body lets
//     its content show (overflow: visible) and is moved by position, not by
//     a transform, so that what is fixed to the window (the phone's tab bar)
//     stays where it is in the window; what sticks to the window while it
//     scrolls (the top bar) then sticks to the copy's window as it does on
//     screen.
//   - The page's own background is drawn under everything, as the browser
//     draws it under the whole window.
//   - Text cut to a number of lines (-webkit-line-clamp) keeps its ellipsis:
//     Chromium reports such a box's display as flow-root, which in the copy
//     turned the clamp off. A field's placeholder keeps its colour, which
//     html-to-image does not copy.
//   - An image that cannot be read for the copy is drawn as nothing, rather
//     than failing the whole capture.
//
// What a capture shows is the window's size, from where the window is on the
// page ('window'), or from the top of the page ('top', for a frame that is in
// the page's flow and that the window moves to when it opens).

import type { toBlob as ToBlob } from 'html-to-image'

type CaptureOptions = NonNullable<Parameters<typeof ToBlob>[1]>

/** Where a capture is taken from: where the window is on the page, or the
 *  top of the page. Either way it is the window's size. */
export type CaptureFrom = 'window' | 'top'

const EXCLUDED = '[data-screenshot-exclude="true"]'
// Set on elements of the page for the length of one capture, so that rules
// in the copy's style sheet can reach their copies.
const CLAMP_ATTR = 'data-capture-clamp'
const PLACEHOLDER_ATTR = 'data-capture-placeholder'
// An image that cannot be read for the copy: one transparent pixel.
const NOTHING = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
// A font file not read by then is left out of this capture.
const FONT_READ_MS = 5000

// Font files already read, as data: URLs, by their address. A file that
// could not be read is not kept, so the next capture tries again.
const fontData = new Map<string, string>()

async function fontFileAsDataURL(url: string): Promise<string> {
  const known = fontData.get(url)
  if (known) return known
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FONT_READ_MS)
  try {
    // The page has drawn with this file, so the browser has it: take that
    // copy, stale or not (the files' names carry their content's hash), and
    // go to the server only when there is none.
    const res = await fetch(url, { cache: 'force-cache', signal: ac.signal })
    if (!res.ok) throw new Error(`font ${res.status}`)
    const blob = await res.blob()
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
    fontData.set(url, data)
    return data
  } finally {
    clearTimeout(timer)
  }
}

const familyKey = (family: string) => family.replace(/["']/g, '').trim().toLowerCase()

function isFontFaceRule(rule: CSSRule): rule is CSSFontFaceRule {
  return typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule
}

/** The @font-face rules of the families the document has loaded a face of,
 *  each file in them written in as a data: URL. A family the page has not
 *  loaded is not drawn with on screen either, and is left out. */
export async function embeddedFontCSS(doc: Document = document): Promise<string> {
  const loaded = new Set<string>()
  doc.fonts?.forEach(face => { if (face.status === 'loaded') loaded.add(familyKey(face.family)) })
  if (loaded.size === 0) return ''
  const rules: Promise<string>[] = []
  for (const sheet of Array.from(doc.styleSheets)) {
    let list: CSSRuleList
    try {
      list = sheet.cssRules
    } catch {
      continue // Another origin's sheet: its rules cannot be read.
    }
    for (const rule of Array.from(list)) {
      if (!isFontFaceRule(rule)) continue
      if (!loaded.has(familyKey(rule.style.getPropertyValue('font-family')))) continue
      const base = sheet.href ?? doc.baseURI
      rules.push((async () => {
        let text = rule.cssText
        for (const match of Array.from(rule.cssText.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g))) {
          if (match[2].startsWith('data:')) continue
          text = text.replace(match[0], `url("${await fontFileAsDataURL(new URL(match[2], base).href)}")`)
        }
        return text
      })().catch((err: unknown) => {
        console.warn('[Aurora] capture: a font could not be read, so the capture draws its text in a fallback', err)
        return ''
      }))
    }
  }
  return (await Promise.all(rules)).filter(Boolean).join('\n')
}

const isExcluded = (node: Node): node is Element => node instanceof Element && node.matches(EXCLUDED)

/** Whether `node` is inside an excluded part (not one itself). Read as the
 *  copy is made, so that a part that appears during a capture (a toast) is
 *  left out too. */
function insideExcluded(node: Node): boolean {
  for (let n = node.parentNode; n; n = n instanceof ShadowRoot ? n.host : n.parentNode) {
    if (isExcluded(n)) return true
  }
  return false
}

/** Whether an excluded part is copied as an empty box that keeps its place:
 *  when it is in the page's flow. One placed over the page (fixed or
 *  absolutely) moves nothing when it is left out; an iframe's copy would be
 *  its document's body, not an empty box. */
function keepsPlace(el: Element): boolean {
  if (el instanceof HTMLIFrameElement) return false
  const position = getComputedStyle(el).position
  return position !== 'fixed' && position !== 'absolute'
}

/** The colour the browser draws under the whole window: the root element's
 *  background, or the body's when the root has none. */
function pageBackground(): string | undefined {
  const clear = (c: string) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c)
  for (const el of [document.documentElement, document.body]) {
    const colour = getComputedStyle(el).backgroundColor
    if (!clear(colour)) return colour
  }
  return undefined
}

/** For the length of a capture, html-to-image reads every font size in a form
 *  it copies as it is: it shrinks a size that ends in "px". The returned
 *  function puts window.getComputedStyle back. */
function keepFontSizes(): () => void {
  const real = window.getComputedStyle
  window.getComputedStyle = function (elt: Element, pseudo?: string | null) {
    const style = real.call(window, elt, pseudo)
    return new Proxy(style, {
      get(target, key) {
        if (key === 'getPropertyValue') {
          return (name: string) => {
            const value = target.getPropertyValue(name)
            // The same length; the trailing space is dropped when it is set.
            return name === 'font-size' && value.endsWith('px') ? `${value} ` : value
          }
        }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  } as typeof window.getComputedStyle
  return () => { window.getComputedStyle = real }
}

/** What the copy needs besides the page's elements: the rules of its own
 *  style sheet, which elements are copied, and how to put the page back. */
export function prepareCopy(from: CaptureFrom): { css: string; filter: (node: Node) => boolean; restore: () => void } {
  const x = from === 'top' ? 0 : window.scrollX
  const y = from === 'top' ? 0 : window.scrollY
  const rules = [
    // An excluded part: its box keeps its place, nothing of it is drawn.
    `${EXCLUDED}{visibility:hidden!important}`,
    `${EXCLUDED}::before,${EXCLUDED}::after{content:none!important}`,
    `[${CLAMP_ATTR}="block"]{display:-webkit-box!important}`,
    `[${CLAMP_ATTR}="inline"]{display:-webkit-inline-box!important}`,
    // Important, because the computed style written onto the copy's body
    // also holds the logical insets (inset-block, inset-inline), which come
    // after `top` and `left` and would win over them.
    `body{overflow:visible!important;position:relative!important;inset:auto!important;left:${-x}px!important;top:${-y}px!important}`,
  ]

  const tagged: Array<[Element, string]> = []
  const placeholders = new Map<string, number>()
  for (const el of Array.from(document.body.getElementsByTagName('*'))) {
    if (!(el instanceof HTMLElement) || el.closest(EXCLUDED)) continue
    // A field's placeholder is styled by its ::placeholder, which
    // html-to-image does not copy: the copy drew it in the field's own text
    // colour (the -webkit-text-fill-color written onto the field, which the
    // placeholder inherits and which paints over `color`).
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.placeholder && !el.value) {
      const ph = getComputedStyle(el, '::placeholder')
      const look = `color:${ph.color}!important;-webkit-text-fill-color:${ph.getPropertyValue('-webkit-text-fill-color') || ph.color}!important;opacity:${ph.opacity}!important`
      let n = placeholders.get(look)
      if (n === undefined) {
        n = placeholders.size
        placeholders.set(look, n)
        rules.push(`[${PLACEHOLDER_ATTR}="${n}"]::placeholder{${look}}`)
      }
      el.setAttribute(PLACEHOLDER_ATTR, String(n))
      tagged.push([el, PLACEHOLDER_ATTR])
    }
    const style = getComputedStyle(el)
    const clamp = style.getPropertyValue('-webkit-line-clamp')
    if (clamp && clamp !== 'none' && style.getPropertyValue('-webkit-box-orient') === 'vertical') {
      const kind = style.display === 'flow-root' || style.display === '-webkit-box' ? 'block'
        : style.display === 'inline-flow-root' || style.display === '-webkit-inline-box' ? 'inline' : null
      if (kind) {
        el.setAttribute(CLAMP_ATTR, kind)
        tagged.push([el, CLAMP_ATTR])
      }
    }
  }

  return {
    css: rules.join('\n'),
    // Called for every node under the body as it is copied. An excluded
    // part in the page's flow is copied (as an empty box), one out of it is
    // not, and nothing inside either is.
    filter: (node: Node) => (isExcluded(node) ? keepsPlace(node) : !insideExcluded(node)),
    restore: () => { for (const [el, attr] of tagged) el.removeAttribute(attr) },
  }
}

/** A picture of the page, the window's size, at `pixelRatio`. Rejects when
 *  the capture library does; the page is left as it was either way. */
export async function capturePage(toBlob: typeof ToBlob, { from, pixelRatio }: { from: CaptureFrom; pixelRatio: number }): Promise<Blob | null> {
  const fontCSS = await embeddedFontCSS()
  const width = window.innerWidth
  const height = window.innerHeight
  const copy = prepareCopy(from)
  const putBack = keepFontSizes()
  try {
    const options: CaptureOptions = {
      pixelRatio,
      // The window's size. Without it html-to-image draws the body's whole
      // height (8,000 to 30,000px on a long grid), past the 16,384px a
      // canvas can be, and reads every image on the page.
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
      backgroundColor: pageBackground(),
      // The style sheet html-to-image puts into the copy for fonts: the
      // faces, then the copy's own rules.
      fontEmbedCSS: `${fontCSS}\n${copy.css}`,
      filter: copy.filter as CaptureOptions['filter'],
      imagePlaceholder: NOTHING,
      onImageErrorHandler: () => undefined,
    }
    return await toBlob(document.body, options)
  } finally {
    putBack()
    copy.restore()
  }
}
