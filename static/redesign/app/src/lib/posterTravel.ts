// Travel: the poster that was pressed moves to where the title page draws
// it, while the page it was pressed on cross-fades into the title page.
//
// The browser does the moving (the View Transitions API). For the length of
// the transition <html> carries TRAVELLING (index.css): the page itself is
// captured (the root's name), and so are the pressed card's picture and the
// title page's poster, under one name. The browser draws the old page fading
// out as the title page fades in, and the first picture growing into the
// second over both. Nothing is named before or after: the attribute and the
// picture's name are put on as the transition starts and taken off as it ends.
//
// WHAT IT COSTS. A captured root takes every press for the length of the
// transition: Chromium sends each hit to <html> while it runs, whatever
// pointer-events says. So a press during it does nothing; the owner chose the
// cross-fade knowing that, and the transition is kept short to keep that
// window short (--dur-travel). The title page's own entrance
// (.animate-fade-in) is finished as it arrives, so it is not faded twice, once
// by itself and once by the cross-fade.
//
// THE OPEN COMES FIRST. Whatever the browser does with the transition, the
// title is opened exactly once: `change` runs once, in the transition's
// update callback where there is one, and directly otherwise (no API, the
// call throws, the callback does not come: then the transition is skipped,
// so nothing is drawn growing into a page that was not flushed). A press
// that arrives while an earlier open has not been made yet takes its
// place: the latest press wins, and the earlier one is not made at all; so
// does anything that leaves the page meanwhile (dropWaitingOpen), and the
// transition of an open that is not made is skipped, so the captured page
// does not hold presses for a cross-fade between a page and itself.
//
// WHAT TRAVELS. Only a plain press on a card's own open control, during
// that press: a click with the main button and no modifier key, on the
// card's art or title (not Play, Add or More). Only a 2:3 poster that has
// loaded (a 16:9 backdrop, a list row's thumbnail and a placeholder do
// not), and only one wholly on screen and uncovered: a captured picture is
// drawn without its card's clipping, so one cut off at a rail's edge or
// partly under the top bar would show whole. Only where the title page
// will draw a poster (from lg) and its code is here (`arrives`). And only
// when, once the title page is in the document, its poster is there with
// its picture ready; otherwise the pressed picture has nothing to grow
// into, and it fades out where it was (the pages still cross-fade).
//
// NO TRANSITION AT ALL, so no cross-fade either, where the browser has none;
// where the viewer asked for less motion, of the system
// (prefers-reduced-motion) or of the app (Reduce effects,
// <html data-effects="reduced">); while the tab is hidden; while the caller
// says something is over the page (the player, a party's panel); for an open
// with no picture that travels (which includes every open below lg, a phone's
// or a tablet's: the title page draws no poster there, and a cross-fade alone
// would cost the dead window without the travel it is paid for); and for an
// open that no plain press on that title's card is behind (a deep link, a
// notification, "Find it", Back). There the change is made at once, as it
// always was, and the title page fades in by its own entrance.
//
// WHAT IT COSTS THE PRESS. The browser takes its picture of the page first
// and runs the change at its next frame, so the title page is in the
// document about one frame later than it would have been.

import { flushSync } from 'react-dom'

/** The one name the travelling poster has, for the length of the
 *  transition: the pressed picture's (set here) and the title page's
 *  poster's (index.css, under TRAVELLING). */
export const TRAVEL_NAME = 'title-poster'
/** The attribute <html> carries for the length of a transition. index.css
 *  names the root (so the two pages cross-fade) and the title page's poster
 *  under it, and only under it. */
export const TRAVELLING = 'data-title-travel'

/** The title page's poster (DetailHero). */
const DESTINATION = '[data-title-poster]'
/** Width from which the title page draws its poster (Tailwind's lg). */
const POSTER_FROM = '(min-width: 64rem)'
/** If the browser has not run the update callback by then, the open is
 *  made without it. */
export const CALLBACK_WAIT_MS = 400

let press: { card: Element } | null = null

/** Notes a plain press on a card's open control, for the length of that
 *  press: the open it causes happens while the click is being handled, and
 *  the note is gone by the next task, so an open made any other way never
 *  finds one. Returns a function that stops watching. */
export function watchCardPresses(root: Document = document): () => void {
  const note = (e: MouseEvent) => {
    const target = e.target as Element | null
    const card = target?.closest?.('[data-media-id]') ?? null
    const plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
    // Play, Add and More are the card's own buttons, not its open.
    const own = !!target?.closest?.('.card-actions, .mlr-acts, .search-best-acts')
    const noted = card && plain && !own ? { card } : null
    press = noted
    if (noted) setTimeout(() => { if (press === noted) press = null }, 0)
  }
  root.addEventListener('click', note, true)
  return () => {
    root.removeEventListener('click', note, true)
    press = null
  }
}

/** Whether the viewer has asked for less motion: the system's setting, or
 *  the app's own Reduce effects. Every caller of startViewTransition asks
 *  this first (scripts/audit-reduced-motion.mjs, Check 5). */
export function lessMotionAsked(doc: Document = document): boolean {
  return !!doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    || doc.documentElement.getAttribute('data-effects') === 'reduced'
}

/** The pressed card's picture, when it is one that can travel: a loaded
 *  2:3 poster, wholly on screen and covered by nothing outside its card. */
function travellingPicture(card: Element, doc: Document): HTMLImageElement | null {
  const img = card.querySelector<HTMLImageElement>('.poster-wrap img.poster-img')
  if (!img || !img.complete || img.naturalWidth === 0) return null
  const box = img.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return null
  // 2:3, within what rounding does to a box.
  if (Math.abs(box.width / box.height - 2 / 3) >= 0.04) return null
  // Each corner, just inside, hits the card: not the top bar, not whatever
  // is beside a rail's clipped edge, not nothing (off screen).
  if (typeof doc.elementFromPoint !== 'function') return img
  const corners: [number, number][] = [[box.left + 2, box.top + 2], [box.right - 2, box.top + 2], [box.left + 2, box.bottom - 2], [box.right - 2, box.bottom - 2]]
  return corners.every(([x, y]) => { const hit = doc.elementFromPoint(x, y); return !!hit && card.contains(hit) }) ? img : null
}

/** The title page's own entrance, finished as it arrives inside the
 *  transition: the cross-fade brings the page in, and the entrance run
 *  under it as well would fade its content twice (it would come up after
 *  its own background). Only the page entrance (`fadeIn`, .animate-fade-in);
 *  a picture's own fade as it loads is the picture's. */
function finishEntrances(doc: Document): void {
  for (const el of doc.querySelectorAll('.animate-fade-in')) {
    // getAnimations flushes style first, so an entrance the change has just
    // mounted is there to finish. A browser without it has no transitions.
    for (const a of el.getAnimations?.() ?? []) {
      if ((a as CSSAnimation).animationName !== 'fadeIn') continue
      try { a.finish() } catch { /* nothing to finish */ }
    }
  }
}

/** The open that has been asked for and not made yet. */
let waiting: { cancel: () => void } | null = null
/** The latest transition started: only it may take off the names it put on
 *  (a superseded one's end comes after the next has named the same picture,
 *  and <html>, again). */
let current: object | null = null

/** Drops an open asked for and not made yet: for whatever leaves the page
 *  before the browser's next frame (Back, a destination, Play elsewhere). */
export function dropWaitingOpen(): void {
  waiting?.cancel()
  waiting = null
}

/** Opens a title: runs `change` exactly once, with the pressed card's
 *  poster travelling to the title page's, and the pages cross-fading,
 *  where it can (see the top of the file). `change` sets state and
 *  navigates; it is flushed, so the title page is in the document when the
 *  browser takes its second picture. `blocked`: something is over the page,
 *  so no transition. `arrives`: the title page can draw its poster at once
 *  (its code is loaded, the title has a poster). Says whether a transition
 *  was started. */
export function travelToTitle(mediaId: number, change: () => void, { blocked = false, arrives = true, doc = document }: { blocked?: boolean; arrives?: boolean; doc?: Document } = {}): boolean {
  // The latest press wins: an earlier open that has not been made is not made.
  dropWaitingOpen()
  const card = press && press.card.isConnected && press.card.getAttribute('data-media-id') === String(mediaId) ? press.card : null
  press = null

  if (typeof doc.startViewTransition !== 'function' || blocked || lessMotionAsked(doc) || doc.visibilityState === 'hidden' || !card || !arrives) {
    change()
    return false
  }

  // The picture travels only to a title page that draws a poster. A page
  // that already draws one (a title opened from another) would hold the
  // name too, and two elements with one name void the whole transition:
  // that open is made at once.
  const picture = doc.defaultView?.matchMedia?.(POSTER_FROM).matches && !doc.querySelector(DESTINATION) ? travellingPicture(card, doc) : null
  if (!picture) {
    change()
    return false
  }
  const token = {}
  current = token
  const root = doc.documentElement
  // Takes off what this transition put on: the picture's name and <html>'s
  // attribute (with it the root's name and the title page's poster's).
  const untag = () => {
    if (current !== token) return
    picture.style.removeProperty('view-transition-name')
    root.removeAttribute(TRAVELLING)
  }
  // Set when the title page's poster is kept out of this transition.
  let unhold = () => {}

  let state: 'waiting' | 'made' | 'cancelled' = 'waiting'
  let timer: ReturnType<typeof setTimeout> | undefined = undefined
  let transition: ViewTransition | undefined = undefined
  const settle = () => {
    if (timer !== undefined) clearTimeout(timer)
    if (waiting === mine) waiting = null
  }
  const make = (inTransition: boolean) => {
    if (state !== 'waiting') return
    state = 'made'
    settle()
    if (!inTransition) { untag(); change(); return }
    try {
      // Flushed: the browser takes its second picture when this returns,
      // and the title page must be in it. Safe here: the browser calls this
      // from a task of its own, never from inside a React render or effect.
      flushSync(change)
    } catch (e) {
      untag()
      throw e
    } finally {
      // The first picture is taken: the name comes off the card (which the
      // open has usually removed from the page anyway), so the second
      // picture holds it once at most. <html> keeps its attribute: the
      // second picture is of the page too.
      if (current === token) picture.style.removeProperty('view-transition-name')
    }
    finishEntrances(doc)
    // Nothing to grow into (the title page's poster or its picture is not
    // there yet): the title page's poster is kept out of this transition,
    // and the pressed picture fades out where it was.
    const poster = doc.querySelector<HTMLElement>(DESTINATION)
    const img = poster?.querySelector('img')
    if (poster && !(img && img.complete && img.naturalWidth > 0)) {
      poster.style.setProperty('view-transition-name', 'none')
      unhold = () => { poster.style.removeProperty('view-transition-name') }
    }
  }
  const mine = {
    cancel: () => {
      if (state !== 'waiting') return
      state = 'cancelled'
      settle()
      untag()
      // Not made: nothing is to cross-fade, and the captured page would
      // hold every press while the browser drew the page into itself.
      try { transition?.skipTransition() } catch { /* already over */ }
    },
  }
  waiting = mine

  picture.style.setProperty('view-transition-name', TRAVEL_NAME)
  root.setAttribute(TRAVELLING, '')
  try {
    transition = doc.startViewTransition(() => { make(true) })
  } catch {
    // The browser refused to start one: the open is made all the same.
    make(false)
    return false
  }
  const started = transition
  // The browser calls the update callback even for a transition it skips.
  // Should it not have by then, the transition is skipped (nothing may be
  // drawn growing into a page that was not flushed) and the open is made
  // without it.
  timer = setTimeout(() => {
    try { started.skipTransition() } catch { /* already over */ }
    make(false)
  }, CALLBACK_WAIT_MS)
  const done = () => { untag(); unhold() }
  // A skipped transition rejects `ready` (a duplicate name, a hidden tab):
  // not an error of this code's, and the open has been made.
  started.ready.catch(() => {})
  started.finished.then(done, done)
  return true
}
