// @vitest-environment jsdom
//
// Travel: the pressed poster moves to the title page's. This DOM has no view
// transitions (so the rest of the suite runs the open made at once, as it
// always was); here the browser's API is stood in for by a stub that hands
// back its update callback and its promises, so each thing a browser can do
// with a transition is done to this code in turn.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALLBACK_WAIT_MS, TRAVEL_NAME, dropWaitingOpen, lessMotionAsked, travelToTitle, watchCardPresses } from './posterTravel'

interface Started {
  /** The browser's "next frame": runs the update callback. */
  frame: () => void
  /** The animation ends. */
  finish: () => void
  /** The browser skips the transition (a duplicate name, a hidden tab). */
  skip: (how?: 'cleanly' | 'and its end is a rejection too') => void
  /** What was named in the page when the transition was started. */
  namedAtStart: string[]
}
const browser = { started: [] as Started[], mode: 'ok' as 'ok' | 'throws', skipped: 0 }
const namedNow = () => [...document.querySelectorAll<HTMLElement>('[style*="view-transition-name"]')]
  .map(el => `${el.id}=${el.style.getPropertyValue('view-transition-name')}`)
function withViewTransitions(on = true) {
  const doc = document as unknown as { startViewTransition?: unknown }
  if (!on) { doc.startViewTransition = undefined; return }
  doc.startViewTransition = (update: () => void) => {
    if (browser.mode === 'throws') throw new DOMException('no', 'InvalidStateError')
    let ready!: () => void, notReady!: (e: unknown) => void, finished!: () => void, notFinished!: (e: unknown) => void
    const t = {
      ready: new Promise<void>((res, rej) => { ready = res; notReady = rej }),
      finished: new Promise<void>((res, rej) => { finished = res; notFinished = rej }),
      updateCallbackDone: Promise.resolve(),
      skipTransition() { browser.skipped++ },
      types: new Set<string>(),
    }
    browser.started.push({
      namedAtStart: namedNow(),
      frame: () => { update(); ready() },
      finish: () => finished(),
      skip: (how = 'cleanly') => {
        notReady(new DOMException('skipped', 'AbortError'))
        if (how === 'cleanly') finished(); else notFinished(new DOMException('skipped', 'AbortError'))
      },
    })
    return t
  }
}
const media = (wide: boolean, reduce = false) => vi.stubGlobal('matchMedia', (q: string) => ({
  matches: q === '(min-width: 64rem)' ? wide : q === '(prefers-reduced-motion: reduce)' ? reduce : false,
  media: q, addEventListener() {}, removeEventListener() {},
}))
/** A picture as the browser would report it: loaded or not, and its box. */
function picture(id: string, { loaded = true, w = 176, h = 264 } = {}) {
  const img = document.getElementById(id) as HTMLImageElement
  Object.defineProperty(img, 'complete', { value: loaded, configurable: true })
  Object.defineProperty(img, 'naturalWidth', { value: loaded ? 500 : 0, configurable: true })
  img.getBoundingClientRect = () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {} }) as DOMRect
}
function page() {
  document.body.innerHTML = `
    <div data-media-id="7"><div class="poster-wrap"><button class="card-open" id="open7"><img class="poster-img" id="pic7"></button>
      <div class="card-actions"><button class="card-act card-act-play" id="play7">Play</button><button class="card-act card-act-more" id="more7">More</button></div></div></div>
    <div data-media-id="8"><div class="poster-wrap"><button class="card-open" id="open8"><img class="poster-img" id="pic8"></button></div></div>
    <div data-media-id="9"><div class="poster-wrap"><button class="card-open" id="open9"><img class="poster-img" id="wide9"></button></div></div>
    <div data-media-id="10" class="media-list-row"><button class="mlr-main" id="row10"><span class="mlr-thumb"><img class="mlr-thumb-img" id="thumb10"></span></button></div>
    <div data-media-id="11" class="search-best"><button class="search-best-open" id="best11"><span class="search-best-art"><img id="art11"></span></button></div>`
  picture('pic7'); picture('pic8'); picture('wide9', { w: 256, h: 144 }); picture('thumb10', { w: 40, h: 60 }); picture('art11', { w: 256, h: 144 })
}
const click = (id: string, init: MouseEventInit = {}) => document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...init }))
/** The title page arriving: what `change` does to the document.
 *  `null`: its code is still loading, so there is no poster in it yet. */
const titlePage = (posterReady: boolean | null) => () => {
  document.body.innerHTML = posterReady === null ? '<main>the title page, its code still loading</main>'
    : '<main><div data-title-poster id="dest"><img id="destpic"></div></main>'
  if (posterReady !== null) picture('destpic', { loaded: posterReady })
}
const tick = () => new Promise<void>(done => setTimeout(done, 0))
let stop: () => void

beforeEach(() => { browser.started = []; browser.mode = 'ok'; browser.skipped = 0; withViewTransitions(); media(true); page(); stop = watchCardPresses() })
afterEach(() => { stop(); withViewTransitions(false); vi.unstubAllGlobals(); vi.useRealTimers(); document.documentElement.removeAttribute('data-effects'); document.body.innerHTML = '' })

describe('the open is made exactly once, whatever the browser does with the transition', () => {
  it('in the transition\'s update callback, one frame after the press', () => {
    const change = vi.fn(titlePage(true))
    click('open7')
    expect(travelToTitle(7, change)).toBe(true)
    expect(change).not.toHaveBeenCalled()
    browser.started[0].frame()
    expect(change).toHaveBeenCalledTimes(1)
    browser.started[0].finish()
  })

  it('at once where the browser has no view transitions', () => {
    withViewTransitions(false)
    const change = vi.fn()
    click('open7')
    expect(travelToTitle(7, change)).toBe(false)
    expect(change).toHaveBeenCalledTimes(1)
    expect(namedNow()).toEqual([])
  })

  it('at once when the browser refuses to start one, with the name taken off again', () => {
    browser.mode = 'throws'
    const change = vi.fn()
    click('open7')
    expect(travelToTitle(7, change)).toBe(false)
    expect(change).toHaveBeenCalledTimes(1)
    expect(namedNow()).toEqual([])
  })

  it('once when the open itself throws inside the callback, and not again later', async () => {
    vi.useFakeTimers()
    const change = vi.fn(() => { throw new Error('the open failed') })
    click('open7')
    travelToTitle(7, change)
    expect(() => browser.started[0].frame()).toThrow('the open failed')
    expect(namedNow()).toEqual([])
    await vi.advanceTimersByTimeAsync(CALLBACK_WAIT_MS * 3)
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('once when the browser skips the transition, whose callback it still runs, and no rejection is left unhandled', async () => {
    const unhandled = vi.fn()
    // The test runner's own process: where a promise nobody listens to ends up.
    const proc = (globalThis as unknown as { process: { on(e: string, f: () => void): void; off(e: string, f: () => void): void } }).process
    proc.on('unhandledRejection', unhandled)
    const change = vi.fn(titlePage(true))
    click('open7')
    travelToTitle(7, change)
    browser.started[0].frame()
    browser.started[0].skip()
    await tick(); await tick()
    expect(change).toHaveBeenCalledTimes(1)
    expect(namedNow()).toEqual([])
    // And when the end of it is a rejection too.
    page()
    click('open8')
    travelToTitle(8, change)
    browser.started[1].frame()
    browser.started[1].skip('and its end is a rejection too')
    await tick(); await tick()
    proc.off('unhandledRejection', unhandled)
    expect(change).toHaveBeenCalledTimes(2)
    expect(unhandled).not.toHaveBeenCalled()
    expect(namedNow()).toEqual([])
  })

  it('without the callback if the browser never runs it, and not a second time if it runs late', async () => {
    vi.useFakeTimers()
    const change = vi.fn(titlePage(true))
    click('open7')
    expect(travelToTitle(7, change)).toBe(true)
    await vi.advanceTimersByTimeAsync(CALLBACK_WAIT_MS - 1)
    expect(change).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(change).toHaveBeenCalledTimes(1)
    browser.started[0].frame()
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('for the latest press when a second arrives before the first open is made: the first is never made', async () => {
    vi.useFakeTimers()
    const first = vi.fn(), second = vi.fn(titlePage(true))
    click('open7')
    travelToTitle(7, first)
    expect(namedNow()).toEqual([`pic7=${TRAVEL_NAME}`])
    click('open8')
    travelToTitle(8, second)
    // The first card's name is off before the second transition's picture.
    expect(browser.started[1].namedAtStart).toEqual([`pic8=${TRAVEL_NAME}`])
    // The browser runs the superseded callback as well as the new one.
    browser.started[0].frame()
    browser.started[1].frame()
    await vi.advanceTimersByTimeAsync(CALLBACK_WAIT_MS * 3)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('for the latest open when it is one made at once: the earlier, still waiting, is dropped', async () => {
    vi.useFakeTimers()
    const first = vi.fn(), second = vi.fn()
    click('open7')
    travelToTitle(7, first)
    // An open with no press behind it (a notification, say).
    expect(travelToTitle(8, second)).toBe(false)
    expect(second).toHaveBeenCalledTimes(1)
    browser.started[0].frame()
    await vi.advanceTimersByTimeAsync(CALLBACK_WAIT_MS * 3)
    expect(first).not.toHaveBeenCalled()
    expect(namedNow()).toEqual([])
  })
})

describe('which presses start a transition', () => {
  const opens = (id: string, mediaId: number, init?: MouseEventInit) => { click(id, init); return travelToTitle(mediaId, () => {}) }

  it('a plain press on the card\'s own open control, for the title it is the card of', () => {
    expect(opens('open7', 7)).toBe(true)
    // Another title's open, with that press behind it: not this card's.
    click('open7')
    expect(travelToTitle(8, () => {})).toBe(false)
  })

  it('not Play or More on the card', () => {
    expect(opens('play7', 7)).toBe(false)
    expect(opens('more7', 7)).toBe(false)
    expect(browser.started).toHaveLength(0)
  })

  it('not a press with a modifier key, or with another button', () => {
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(opens('open7', 7, init)).toBe(false)
    }
    expect(browser.started).toHaveLength(0)
  })

  it('not an open made later, by anything else: the press is good for the click it was, and for one open', async () => {
    click('open7')
    await tick()
    expect(travelToTitle(7, () => {})).toBe(false)
    click('open7')
    expect(travelToTitle(7, () => {})).toBe(true)
    expect(travelToTitle(7, () => {})).toBe(false)
    // Nor with no press at all (a deep link, Back, "Find it").
    expect(travelToTitle(8, () => {})).toBe(false)
  })

  it('not once the pressed card has left the page', () => {
    click('open7')
    document.querySelector('[data-media-id="7"]')!.remove()
    expect(travelToTitle(7, () => {})).toBe(false)
  })

  it('not while something is over the page, the tab is hidden, or less motion was asked for, of the system or of the app', () => {
    const change = vi.fn()
    click('open7')
    expect(travelToTitle(7, change, { blocked: true })).toBe(false)
    media(true, true)
    click('open7')
    expect(travelToTitle(7, change)).toBe(false)
    media(true)
    document.documentElement.setAttribute('data-effects', 'reduced')
    click('open7')
    expect(travelToTitle(7, change)).toBe(false)
    document.documentElement.removeAttribute('data-effects')
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    click('open7')
    expect(travelToTitle(7, change)).toBe(false)
    hidden.mockRestore()
    expect(browser.started).toHaveLength(0)
    expect(change).toHaveBeenCalledTimes(4)
    expect(namedNow()).toEqual([])
    // With none of them, it does.
    click('open7')
    expect(travelToTitle(7, change)).toBe(true)
  })

  it('stops noting presses when told to', () => {
    stop()
    click('open7')
    expect(travelToTitle(7, () => {})).toBe(false)
  })
})

describe('what travels: one name, on one element in each of the browser\'s two pictures', () => {
  it('a loaded 2:3 poster, named for the first picture and not for the second, with the title page\'s poster left to its own name', async () => {
    click('open7')
    travelToTitle(7, titlePage(true))
    expect(browser.started[0].namedAtStart).toEqual([`pic7=${TRAVEL_NAME}`])
    browser.started[0].frame()
    // The second picture: nothing named inline. The title page's poster has
    // the name from the stylesheet, and it is not held back.
    expect(namedNow()).toEqual([])
    browser.started[0].finish()
    await tick()
    expect(namedNow()).toEqual([])
  })

  // With nothing to travel no transition is started at all: the open is
  // made at once, as it was before any of this.
  const madeAtOnce = (id: string, mediaId: number, opts?: { arrives?: boolean }) => {
    const change = vi.fn()
    click(id)
    expect(travelToTitle(mediaId, change, opts)).toBe(false)
    expect(change).toHaveBeenCalledTimes(1)
    expect(browser.started).toEqual([])
    expect(namedNow()).toEqual([])
  }

  it('not a 16:9 picture, a list row\'s thumbnail, or the best match\'s backdrop: those open at once', () => {
    for (const [id, mediaId] of [['open9', 9], ['row10', 10], ['best11', 11]] as const) {
      page()
      madeAtOnce(id, mediaId)
    }
  })

  it('not a poster that has not loaded, and not where the title page draws none (below lg)', () => {
    picture('pic7', { loaded: false })
    madeAtOnce('open7', 7)
    page()
    media(false)
    madeAtOnce('open7', 7)
  })

  it('not when the title page cannot draw its poster at once (its code not here, or no poster)', () => {
    madeAtOnce('open7', 7, { arrives: false })
  })

  // A captured picture is drawn without its card's clipping: one cut off at
  // a rail's edge, or partly under the top bar, would show whole.
  it('not a poster any corner of which is covered or off screen', () => {
    const bar = document.createElement('nav')
    document.body.append(bar)
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null }
    try {
      // Its top left corner under the bar.
      doc.elementFromPoint = (x, y) => (x < 10 && y < 10 ? bar : document.getElementById('pic7'))
      madeAtOnce('open7', 7)
      // Every corner on the card: it travels.
      doc.elementFromPoint = () => document.getElementById('pic7')
      click('open7')
      expect(travelToTitle(7, () => {})).toBe(true)
    } finally {
      delete doc.elementFromPoint
    }
  })

  it('not from a page that already draws a title\'s poster: that poster holds the name', () => {
    document.body.insertAdjacentHTML('beforeend', '<div data-title-poster id="here"></div>')
    madeAtOnce('open7', 7)
  })

  // Two opens of the same card before the first's frame: the first's end
  // must not take the name off the picture the second has named.
  it('leaves the latest transition its name when a superseded one ends', async () => {
    click('open7')
    travelToTitle(7, () => {})
    click('open7')
    travelToTitle(7, titlePage(true))
    expect(browser.started[1].namedAtStart).toEqual([`pic7=${TRAVEL_NAME}`])
    browser.started[0].frame()
    browser.started[0].finish()
    await tick()
    expect(namedNow()).toEqual([`pic7=${TRAVEL_NAME}`])
  })

  // The callback has not come in time: the open is made without it, and the
  // transition is skipped, so the named picture never grows into a page
  // that was not flushed.
  it('skips the transition when the open is made without its callback', async () => {
    vi.useFakeTimers()
    const change = vi.fn()
    click('open7')
    travelToTitle(7, change)
    await vi.advanceTimersByTimeAsync(CALLBACK_WAIT_MS)
    expect(change).toHaveBeenCalledTimes(1)
    expect(browser.skipped).toBe(1)
    expect(namedNow()).toEqual([])
  })

  // Back, a destination or Play elsewhere before the browser's next frame:
  // the waiting open is not made over where the viewer went.
  it('drops a waiting open when something leaves the page first', async () => {
    vi.useFakeTimers()
    const change = vi.fn()
    click('open7')
    travelToTitle(7, change)
    dropWaitingOpen()
    expect(namedNow()).toEqual([])
    browser.started[0].frame()
    await vi.advanceTimersByTimeAsync(CALLBACK_WAIT_MS * 3)
    expect(change).not.toHaveBeenCalled()
  })

  // No morph into nothing: the pressed picture is in the first picture
  // already, so the title page's poster is taken out of the second.
  it('keeps the title page\'s poster out of the transition when its picture is not ready, and gives it back after', async () => {
    click('open7')
    travelToTitle(7, titlePage(false))
    browser.started[0].frame()
    expect(namedNow()).toEqual(['dest=none'])
    browser.started[0].finish()
    await tick()
    expect(namedNow()).toEqual([])
  })

  it('has nothing to hold back when the title page has no poster in the second picture', () => {
    click('open7')
    travelToTitle(7, titlePage(null))
    browser.started[0].frame()
    expect(namedNow()).toEqual([])
  })

  it('leaves no name behind for the next press on the same page', async () => {
    // The open is made but the page stays (a stand-in for any reason the
    // card is still there): its name must be off for the next transition.
    click('open7')
    travelToTitle(7, () => {})
    browser.started[0].frame()
    browser.started[0].finish()
    await tick()
    click('open8')
    travelToTitle(8, () => {})
    expect(browser.started[1].namedAtStart).toEqual([`pic8=${TRAVEL_NAME}`])
  })
})

describe('whether less motion was asked for', () => {
  it('is the system\'s setting or the app\'s own Reduce effects', () => {
    expect(lessMotionAsked()).toBe(false)
    media(true, true)
    expect(lessMotionAsked()).toBe(true)
    media(true)
    document.documentElement.setAttribute('data-effects', 'reduced')
    expect(lessMotionAsked()).toBe(true)
  })
})
