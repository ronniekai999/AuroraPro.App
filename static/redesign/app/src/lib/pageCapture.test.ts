// @vitest-environment jsdom
//
// What lib/pageCapture gives html-to-image so that a capture is the page as
// it is on screen. jsdom lays nothing out and draws nothing, so these pin
// the inputs: which nodes are copied, the copy's own rules, the fonts
// written in, and that the page is put back. Whether the picture comes out
// right is checked in Chromium by scripts/verify-bug-capture.mjs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturePage, embeddedFontCSS, prepareCopy } from './pageCapture'

const byId = (id: string) => document.getElementById(id)!

function scrolledTo(x: number, y: number) {
  Object.defineProperty(window, 'scrollX', { configurable: true, value: x })
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y })
}

afterEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute('style')
  scrolledTo(0, 0)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the copy of the page', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main id="main"><h1 id="heading">That did not load.</h1></main>
      <aside id="panel" data-screenshot-exclude="true"><label id="label">Title<input id="field" value="typed"></label></aside>
      <div id="toasts" data-screenshot-exclude="true" style="position: fixed"><p id="toast">Saved</p></div>
      <div id="dialog" data-screenshot-exclude="true" style="position: absolute"><p id="inDialog">Report</p></div>`
  })

  it('keeps the place of an excluded part in the page\'s flow, and copies nothing of what is in it', () => {
    const { filter } = prepareCopy('window')
    expect(filter(byId('main'))).toBe(true)
    expect(filter(byId('heading'))).toBe(true)
    expect(filter(byId('heading').firstChild!)).toBe(true)
    // The panel is copied as a box, so the page around it stays where it is…
    expect(filter(byId('panel'))).toBe(true)
    // …with nothing in it: no field, no words.
    expect(filter(byId('label'))).toBe(false)
    expect(filter(byId('label').firstChild!)).toBe(false)
    expect(filter(byId('field'))).toBe(false)
  })

  it('leaves out an excluded part placed over the page, and all that is in it', () => {
    const { filter } = prepareCopy('window')
    expect(filter(byId('toasts'))).toBe(false)
    expect(filter(byId('toast'))).toBe(false)
    expect(filter(byId('dialog'))).toBe(false)
    expect(filter(byId('inDialog'))).toBe(false)
  })

  it('leaves out a part that appears during the capture', () => {
    const { filter } = prepareCopy('window')
    // A toast, or a field marked to be left out, that arrives after the
    // capture began and before the copy reaches it.
    document.body.insertAdjacentHTML('beforeend', `
      <div id="late" data-screenshot-exclude="true" style="position: fixed"><p id="lateToast">Copied</p></div>
      <section id="lateBox" data-screenshot-exclude="true"><p id="lateText">Key</p></section>`)
    expect(filter(byId('late'))).toBe(false)
    expect(filter(byId('lateToast'))).toBe(false)
    expect(filter(byId('lateBox'))).toBe(true)
    expect(filter(byId('lateText'))).toBe(false)
    expect(filter(byId('lateText').firstChild!)).toBe(false)
  })

  it('draws nothing of the boxes it keeps, nor of their ::before and ::after', () => {
    const { css } = prepareCopy('window')
    expect(css).toContain('[data-screenshot-exclude="true"]{visibility:hidden!important}')
    expect(css).toContain('[data-screenshot-exclude="true"]::before,[data-screenshot-exclude="true"]::after{content:none!important}')
  })

  it('moves the copy by the window\'s scroll, by position, letting its content show', () => {
    scrolledTo(12, 600)
    const { css } = prepareCopy('window')
    const body = css.split('\n').find(rule => rule.startsWith('body{'))!
    expect(body).toContain('overflow:visible!important')
    expect(body).toContain('position:relative!important')
    expect(body).toContain('left:-12px!important')
    expect(body).toContain('top:-600px!important')
    // A transform would carry what is fixed to the window (the phone's tab
    // bar) along with the page.
    expect(body).not.toContain('transform')
  })

  it('takes the copy from the top of the page, wherever the window is, when asked', () => {
    scrolledTo(12, 600)
    const body = prepareCopy('top').css.split('\n').find(rule => rule.startsWith('body{'))!
    expect(body).toContain('left:0px!important')
    expect(body).toContain('top:0px!important')
  })

  it('clamps text cut to a number of lines again, and only while it captures', () => {
    document.body.insertAdjacentHTML('beforeend', `
      <p id="clamped" style="display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2">A long title</p>
      <p id="hidden" style="display: none; -webkit-box-orient: vertical; -webkit-line-clamp: 2">Not shown</p>`)
    const { css, restore } = prepareCopy('window')
    expect(byId('clamped')).toHaveAttribute('data-capture-clamp', 'block')
    // Not drawn on screen: the copy must not draw it either.
    expect(byId('hidden')).not.toHaveAttribute('data-capture-clamp')
    expect(css).toContain('[data-capture-clamp="block"]{display:-webkit-box!important}')
    restore()
    expect(byId('clamped')).not.toHaveAttribute('data-capture-clamp')
  })
})

/** A stand-in for the document's fonts and sheets: jsdom has no
 *  document.fonts, and drops `src` from an @font-face rule. */
function fontDocument(faces: Array<{ family: string; status: string }>, rules: Array<{ family: string; url: string }>, href = 'http://aurora.test/v2/assets/index.css') {
  const cssRules = rules.map(({ family, url }) => {
    const rule = Object.create(CSSFontFaceRule.prototype)
    Object.defineProperty(rule, 'cssText', { value: `@font-face { font-family: "${family}"; font-weight: 200 800; src: url("${url}") format("woff2"); }` })
    Object.defineProperty(rule, 'style', { value: { getPropertyValue: (name: string) => (name === 'font-family' ? `"${family}"` : '') } })
    return rule
  })
  const unreadable = { href: 'https://elsewhere.test/a.css', get cssRules(): never { throw new DOMException('cross-origin', 'SecurityError') } }
  return {
    fonts: { forEach: (fn: (face: { family: string; status: string }) => void) => faces.forEach(fn) },
    styleSheets: [unreadable, { href, cssRules }],
    baseURI: 'http://aurora.test/v2/',
  } as unknown as Document
}

// A response as fetch() gives it, as far as the capture reads one (jsdom's
// Blob, which jsdom's FileReader reads; Node's Response cannot hold it).
const fontFile = () => ({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([119, 79, 70, 50])], { type: 'font/woff2' }) })

describe('the fonts written into the copy', () => {
  it('writes in the families the page has loaded, as data: URLs read from the browser\'s cache', async () => {
    const fetch = vi.fn(async () => fontFile())
    vi.stubGlobal('fetch', fetch)
    const css = await embeddedFontCSS(fontDocument(
      [{ family: 'Bricolage Grotesque', status: 'loaded' }, { family: 'Never Used', status: 'unloaded' }],
      [{ family: 'Bricolage Grotesque', url: '/v2/assets/display-a.woff2' }, { family: 'Never Used', url: '/v2/assets/unused-a.woff2' }],
    ))
    expect(css).toContain('font-family: "Bricolage Grotesque"')
    expect(css).toContain('url("data:font/woff2;base64,d09GMg==")')
    expect(css).not.toContain('/v2/assets/display-a.woff2')
    // A family the page has not drawn with is not drawn with in the copy.
    expect(css).not.toContain('Never Used')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('http://aurora.test/v2/assets/display-a.woff2', expect.objectContaining({ cache: 'force-cache' }))
  })

  it('reads a file once', async () => {
    const fetch = vi.fn(async () => fontFile())
    vi.stubGlobal('fetch', fetch)
    const doc = fontDocument([{ family: 'Inter', status: 'loaded' }], [{ family: 'Inter', url: '/v2/assets/text-b.woff2' }])
    const first = await embeddedFontCSS(doc)
    expect(await embeddedFontCSS(doc)).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('leaves out a face whose file cannot be read, and tries it again the next time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: false, status: 404, blob: async () => new Blob([]) })
      .mockImplementation(async () => fontFile())
    vi.stubGlobal('fetch', fetch)
    const doc = fontDocument([{ family: 'Inter', status: 'loaded' }], [{ family: 'Inter', url: '/v2/assets/text-c.woff2' }])
    expect(await embeddedFontCSS(doc)).toBe('')
    expect(await embeddedFontCSS(doc)).toBe('')
    expect(warn).toHaveBeenCalled()
    expect(await embeddedFontCSS(doc)).toContain('url("data:font/woff2;base64,')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('writes in nothing when the page has loaded no font', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await embeddedFontCSS(fontDocument([], [{ family: 'Inter', url: '/v2/assets/text-d.woff2' }]))).toBe('')
    expect(await embeddedFontCSS({ styleSheets: [], baseURI: '' } as unknown as Document)).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('a capture', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="main"><p id="text">Words</p><p id="clamped" style="display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2">Title</p></main>'
    document.body.style.backgroundColor = 'rgb(14, 15, 17)'
    document.body.style.fontSize = '17px'
  })

  it('is the window\'s size, on the page\'s background, with the copy\'s rules and fonts', async () => {
    const toBlob = vi.fn(async () => new Blob(['png']))
    await capturePage(toBlob as never, { from: 'window', pixelRatio: 2 })
    expect(toBlob).toHaveBeenCalledTimes(1)
    const [node, options] = toBlob.mock.calls[0] as unknown as [Node, Record<string, unknown>]
    expect(node).toBe(document.body)
    expect(options).toMatchObject({
      pixelRatio: 2,
      width: window.innerWidth,
      height: window.innerHeight,
      canvasWidth: window.innerWidth,
      canvasHeight: window.innerHeight,
      backgroundColor: 'rgb(14, 15, 17)',
    })
    expect(options.fontEmbedCSS).toContain('[data-screenshot-exclude="true"]{visibility:hidden!important}')
    // Fonts are given as written in, never skipped (the library then reads
    // no files of its own).
    expect(options.skipFonts).toBeUndefined()
    // An image that cannot be read is drawn as nothing; it does not fail the
    // capture.
    expect(options.imagePlaceholder).toMatch(/^data:image\//)
    expect(options.onImageErrorHandler).toEqual(expect.any(Function))
  })

  it('lets the capture library read font sizes as they are, and only while it captures', async () => {
    const real = window.getComputedStyle
    let during = ''
    const toBlob = vi.fn(async () => {
      during = window.getComputedStyle(document.body).getPropertyValue('font-size')
      return new Blob(['png'])
    })
    await capturePage(toBlob as never, { from: 'window', pixelRatio: 1 })
    // html-to-image shrinks a size that ends in "px".
    expect(during).toBe('17px ')
    expect(window.getComputedStyle).toBe(real)
    expect(window.getComputedStyle(document.body).getPropertyValue('font-size')).toBe('17px')
  })

  it('puts the page back when the capture library fails', async () => {
    const real = window.getComputedStyle
    const toBlob = vi.fn(async () => {
      expect(byId('clamped')).toHaveAttribute('data-capture-clamp')
      throw new Event('error')
    })
    await expect(capturePage(toBlob as never, { from: 'window', pixelRatio: 1 })).rejects.toBeInstanceOf(Event)
    expect(window.getComputedStyle).toBe(real)
    expect(byId('clamped')).not.toHaveAttribute('data-capture-clamp')
  })
})
