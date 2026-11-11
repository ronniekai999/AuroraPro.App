// The card menu: what a right click, a card's More button, the context-menu
// key and a long press all open. Anchored at the pointer (or under the
// control that opened it) on a wide screen; a bottom sheet on a phone, where
// there is no pointer position worth anchoring to and the rows need to be
// reachable by a thumb. Closes on Escape or a click outside. The caller
// decides which items to offer (admin gates Refresh metadata).
//
// Phase 9 — made keyboard-operable. This was a WCAG 2.1.1 (Level A) failure, and
// not a marginal one: four of its items — Mark as Watched, Clear Progress, "More
// like this", "Not interested" — have NO other route anywhere in the app, so a
// keyboard-only user could not reach them at all.
//
// The trigger was never the problem. Media cards are `role="button" tabIndex={0}`,
// and browsers fire a real `contextmenu` event for Shift+F10 and the Menu key on a
// focused element, so the menu already opened. Two things then went wrong:
//
//   1. A keyboard-generated `contextmenu` carries clientX/clientY of 0, so the
//      menu appeared pinned to the top-left corner of the viewport, nowhere near
//      the card it belonged to. `anchorFor` below fixes that by falling back to
//      the target's own bounding box.
//   2. Once open it was a dead widget: no `role="menu"`, no roving tabIndex, no
//      arrow keys, and focus never entered it — so there was no way to reach an
//      item even though the items were already `<button>`s.
//
// ARIA note: `role="menu"` puts NVDA and JAWS into forms/focus mode and hands the
// arrow keys to the application, so implementing them is not optional politeness —
// a `role="menu"` without arrow-key support is a WORSE widget than a plain div,
// because the screen reader stops offering its own navigation in exchange.

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

export interface MediaContextItem {
  label: string
  // 'danger' sets the label in the destructive text colour.
  tone?: 'default' | 'danger'
  onClick: () => void
  // Starts a new group: a rule is drawn above this item.
  group?: boolean
  // The first action of the menu (Resume, Play): set in semibold.
  primary?: boolean
  // Feedback to the recommender: marked with the aurora dot, the one sign
  // for "Aurora is involved".
  ai?: boolean
  // A quiet word at the row's end ("Admin").
  note?: string
}

interface Props {
  x: number
  y: number
  items: MediaContextItem[]
  onClose: () => void
  /**
   * The title this menu acts on, for the accessible name.
   *
   * Without it a screen reader announced "Media actions, menu. Mark as Watched."
   * — Mark WHAT as watched? Every item label is a bare verb, and the menu opens
   * from a grid of dozens of cards, so the one piece of context the user lacks is
   * the only piece the name didn't carry. "Media actions" meanwhile duplicated
   * what they already knew: they just pressed the Menu key on a card.
   */
  title?: string
  /**
   * Why Aurora picked this title, when it did. Shown above the items, with
   * the aurora dot, and read as the menu's description: on a card it has one
   * clipped line under a pointer, and a touch screen has no pointer at all.
   */
  reason?: string
  /**
   * The control that opened the menu (a card's More button), when one did.
   * Focus goes back to it on close, and while the menu is open it carries
   * `aria-expanded="true"`. Without it, focus returns to whatever held it
   * when the menu opened.
   */
  opener?: HTMLElement | null
}

// ── a press that is still held when the menu opens ─────────────────────────
// A long press on a touch screen opens this menu while the finger is still
// down. On a phone the menu is a sheet with a scrim across the whole screen,
// so whatever the browser sends when that finger lifts lands on the scrim:
// the release itself, and, on engines that follow a touch with compatibility
// mouse events, a `mousedown` and a `click`. Read as a press outside, any of
// them closed the sheet the moment it opened. Which engines send what after a
// half-second hold is not something this project has measured on a device, so
// the menu does not depend on it: presses outside are ignored until the touch
// that was down when it opened has been released, and for a short grace after
// that release, which is when its compatibility events arrive.
//
// Touches are tracked at module level because the menu mounts mid-press and
// cannot learn afterwards whether a finger is down.
const touchesDown = new Set<number>()
/** How long after the opening touch lifts its own compatibility mouse events
 *  may still arrive. They are sent in the same task or within the legacy
 *  ~300ms tap delay. */
export const PRESS_RELEASE_GRACE_MS = 500
/** The longest a menu waits for the touch that opened it to lift. A release
 *  can go unseen (a native dialog taking the screen, the page going to the
 *  background mid-touch), and a menu that waited for ever would never close
 *  for a press outside again; on a phone the sheet has no Escape key. */
export const PRESS_HOLD_CAP_MS = 4000
if (typeof window !== 'undefined') {
  const down = (e: PointerEvent) => { if (e.pointerType === 'touch') touchesDown.add(e.pointerId) }
  const up = (e: PointerEvent) => { touchesDown.delete(e.pointerId) }
  window.addEventListener('pointerdown', down, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  // A touch whose release this page never saw is not still down: when the
  // page is hidden or loses the window, forget them all, so a later menu
  // does not open believing a finger is on the screen.
  const forget = () => { touchesDown.clear() }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') forget() })
  window.addEventListener('blur', forget)
  window.addEventListener('pagehide', forget)
}

/**
 * Where to put the menu for a `contextmenu` event.
 *
 * Exported and pure so the keyboard/pointer distinction can be tested — it is a
 * behavioural difference that is invisible in a mouse-driven manual pass, which
 * is exactly how it shipped.
 *
 * ⚠️ CORRECTED. This was introduced on a stated browser fact that is FALSE, and
 * the header here, the commit message and the whole test file asserted it: "a
 * keyboard-generated `contextmenu` carries clientX/clientY of 0". Measured in
 * Chromium 141 on a card at left:240 top:300 right:440 bottom:420 — Shift+F10 and
 * the Menu key BOTH report clientX:340 clientY:360, the element's CENTRE:
 *
 *     Shift+F10    clientX=340 clientY=360  detail=0  button=-1  buttons=0
 *     Menu key     clientX=340 clientY=360  detail=0  button=-1  buttons=0
 *     right-click  clientX=300 clientY=350  detail=0  button=2   buttons=2
 *
 * So Chromium never reports 0/0, the fallback below is unreachable there, and the
 * keyboard menu was ALREADY anchored on the card before any of this — arguably
 * better placed than the bottom-left drop this would have given it. Two reviewers
 * measured it independently. The tests are green over a branch production never
 * takes, which is exactly the failure mode this project has now hit three times.
 *
 * It is kept, deliberately narrowed to what it actually is: a defensive fallback
 * for an engine that reports unusable 0/0 coordinates (plausible for WebKit, which
 * I could not measure — only Chromium is installed here). Because it triggers on
 * the coordinates being unusable rather than on the event being keyboard-driven,
 * Chromium's correct centre anchoring is left untouched.
 *
 * Note for anyone extending this: `button`/`buttons` ARE a clean keyboard
 * discriminator per UI Events (-1/0 for a non-pointer event vs 2/2 for a
 * right-click), and `detail` is NOT — a real right-click also reports `detail: 0`,
 * unlike `click`. An earlier draft used `detail` and mis-anchored every mouse open;
 * the test written for the ordinary pointer case caught that on its first run.
 */
export function anchorFor(e: {
  clientX: number
  clientY: number
  /**
   * ACCEPTED AND DELIBERATELY IGNORED. It is in the signature purely so a test can
   * pass it and assert that it changes nothing.
   *
   * A reviewer showed the previous test file could not catch reintroducing
   * `detail === 0`: no fixture set `detail`, so `undefined === 0` was false and the
   * mutant was behaviourally identical — it passed all five tests AND `tsc`. The
   * commit's story that "the test caught this on its first run" was therefore
   * unverifiable from the shipped artifact, whatever happened while writing it.
   * Naming the property here makes the trap a typed, asserted one instead.
   */
  detail?: number
  currentTarget?: { getBoundingClientRect?: () => { left: number; bottom: number } } | null
}): { x: number; y: number } {
  // A genuine right-click at exactly (0, 0) is not reachable in practice, and if
  // it were, anchoring to the card is still a sensible answer.
  if (e.clientX === 0 && e.clientY === 0) {
    const rect = e.currentTarget?.getBoundingClientRect?.()
    // Bottom-left of the card — the conventional drop position.
    if (rect) return { x: rect.left, y: rect.bottom }
  }
  return { x: e.clientX, y: e.clientY }
}

const MENU_W_PX = 280
const ROW_PX = 44
const RULE_PX = 13

export function ContextMenu({ x, y, items, onClose, title, reason, opener }: Props) {
  const reasonId = useId()
  const ref = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // STATE, not a ref: `tabIndex` has to re-render to move, and the previous
  // version rendered `tabIndex={i === 0 ? 0 : -1}` off a ref, so the tab stop sat
  // on item 0 for ever while focus was elsewhere. APG: "set tabindex='-1' on the
  // element that has tabindex='0'. Set tabindex='0' on the element that will
  // become focused as a result of the key event."
  const [active, setActive] = useState(0)

  // Focus the first item on open and restore the opener on close. Without the
  // restore, activating an item unmounts the focused element and focus falls to
  // <body> — the card you opened the menu from is then gone from under the
  // user (WCAG 2.4.3).
  //
  // The control that opened it is given when there is one (a card's More
  // button): Safari does not focus a button on a click, so "whatever has
  // focus" is not it there. A right click or a long press has no control, and
  // focus returns to wherever it was.
  const openerRef = useRef(opener)
  useEffect(() => {
    const given = openerRef.current
    const control = given && given.matches('button, [href], [tabindex]') ? given : null
    const back = control ?? (document.activeElement as HTMLElement | null)
    const popup = control && control.getAttribute('aria-haspopup') === 'menu' ? control : null
    popup?.setAttribute('aria-expanded', 'true')
    const raf = requestAnimationFrame(() => {
      setActive(0)
      itemRefs.current[0]?.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      popup?.setAttribute('aria-expanded', 'false')
      if (back && back.isConnected) back.focus({ preventScroll: true })
    }
    // Mount/unmount only — re-running would yank focus mid-interaction.
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    // A touch that was down when the menu opened (a long press): its release,
    // and the compatibility mouse events that may follow it, are not a press
    // outside. See the note at touchesDown.
    const held = new Set(touchesDown)
    // Outside presses count from this time on: at once for a menu no touch
    // was holding, else from the grace after the last such touch lifts, and
    // in any case once the cap has passed, so a release that is never seen
    // cannot leave the menu deaf to them.
    let listenFrom = held.size > 0 ? performance.now() + PRESS_HOLD_CAP_MS : 0
    const onRelease = (e: PointerEvent) => {
      if (held.delete(e.pointerId) && held.size === 0) listenFrom = Math.min(listenFrom, performance.now() + PRESS_RELEASE_GRACE_MS)
    }
    const onClick = (e: MouseEvent) => {
      if (performance.now() < listenFrom) return
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerup', onRelease, true)
    window.addEventListener('pointercancel', onRelease, true)
    window.addEventListener('keydown', onKey)
    // Bind on next tick so the same right-click that opened us
    // doesn't immediately close us via this listener.
    const t = window.setTimeout(() => window.addEventListener('mousedown', onClick), 0)
    return () => {
      window.removeEventListener('pointerup', onRelease, true)
      window.removeEventListener('pointercancel', onRelease, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
      window.clearTimeout(t)
    }
  }, [onClose])

  // Clamp to viewport so the menu never overflows the right/bottom edge.
  // A phone gets a bottom sheet. Decided once, when the menu opens: a
  // rotation mid-menu is not worth re-laying it out under the user's thumb.
  const [sheet] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches)
  // Keep the popover on screen: 280px wide, 44px rows, 13px per group rule,
  // 8px padding top and bottom.
  // The reason wraps at about 30 characters a line (13px text, 18px lines).
  // An estimate for the first layout; the measured height corrects it below.
  const reasonPx = reason ? Math.ceil(('Picked by Aurora: '.length + reason.length) / 30) * 18 + 14 : 0
  const height = items.length * ROW_PX + items.filter((it, i) => it.group && i > 0).length * RULE_PX + 16 + reasonPx
  const maxX = typeof window !== 'undefined' ? window.innerWidth - MENU_W_PX - 8 : x
  const maxY = typeof window !== 'undefined' ? window.innerHeight - height - 8 : y
  const clampedX = Math.min(x, Math.max(8, maxX))
  const clampedY = Math.min(y, Math.max(8, maxY))

  // The height above is arithmetic. What was drawn is measured before the
  // first paint, and a menu that would run off the bottom (a long reason
  // wraps to more lines than estimated) is lifted to fit.
  const [liftedY, setLiftedY] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (sheet || !ref.current) return
    const box = ref.current.getBoundingClientRect()
    if (box.height > 0 && box.bottom > window.innerHeight - 8) setLiftedY(Math.max(8, window.innerHeight - box.height - 8))
  }, [sheet, clampedY])

  const move = (delta: number) => {
    const n = items.length
    if (!n) return
    // Wraps, per APG: Down from the last item goes to the first.
    const next = (active + delta + n) % n
    setActive(next)
    itemRefs.current[next]?.focus()
  }

  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={title ? `Actions for ${title}` : 'Media actions'}
      aria-describedby={reason ? reasonId : undefined}
      className={sheet
        ? 'fixed inset-x-0 bottom-0 z-[100] max-h-[80vh] overflow-y-auto rounded-t-sheet bg-surface-raised-2 p-2 pb-[calc(8px+env(safe-area-inset-bottom,0px))] shadow-[0_-24px_64px_rgba(0,0,0,0.6)] stage-sheet-in'
        : 'fixed z-[100] w-[280px] rounded-control bg-surface-raised-2 p-2 shadow-[0_24px_64px_rgba(0,0,0,0.6)] animate-fade-in'}
      style={sheet ? undefined : { left: clampedX, top: liftedY ?? clampedY }}
      onKeyDown={e => {
        // Handled here rather than per item so the contract lives in one place.
        //
        // The `stopPropagation` calls are NOT for the card: this menu renders at
        // App level as a sibling of the grid, so the card's onKeyDown is never in
        // the propagation path (and it guards on `e.target !== e.currentTarget`
        // anyway) — an earlier comment here claimed otherwise. What they do stop is
        // App's WINDOW-level handlers: React 18's createRoot attaches at the
        // container, so a synthetic stopPropagation does block them. Measured: a
        // window keydown spy saw nothing for arrow presses inside the menu.
        switch (e.key) {
          case 'ArrowDown': e.preventDefault(); e.stopPropagation(); move(1); break
          case 'ArrowUp': e.preventDefault(); e.stopPropagation(); move(-1); break
          case 'Home':
            e.preventDefault(); e.stopPropagation()
            setActive(0)
            itemRefs.current[0]?.focus()
            break
          case 'End':
            e.preventDefault(); e.stopPropagation()
            setActive(items.length - 1)
            itemRefs.current[items.length - 1]?.focus()
            break
          case 'Escape':
            // Stopped HERE as well as handled by the window listener. App's
            // Escape handler guards only on `paletteOpen`, so with a context menu
            // open on a detail page the fall-through reached
            // `else if (view === 'detail') handleBack()` — pressing Escape to
            // dismiss the menu dismissed it AND navigated back off the title.
            // Measured: the window spy saw "Escape" while the menu was open.
            e.stopPropagation()
            onClose()
            break
          case 'Tab':
            // A menu is not part of the tab ring, so Tab dismisses it rather than
            // walking into content behind the overlay. APG's Tab row actually says
            // to move focus OUT of the menu and advance the tab ring; returning to
            // the opener is a defensible variation, not the letter of the pattern,
            // and the earlier comment here overstated it as "what APG specifies".
            e.preventDefault()
            onClose()
            break
        }
      }}
    >
      {sheet && title && (
        <p className="truncate px-3 pb-2 pt-2.5 text-[13px] font-semibold text-ink-2" aria-hidden="true">{title}</p>
      )}
      {reason && (
        // Not an item: the menu's description (aria-describedby above).
        <p id={reasonId} role="none" data-menu-reason className="flex gap-2 px-3 pb-2 pt-1.5 text-[13px] leading-[18px] text-ink-2">
          <span aria-hidden="true" className="mt-[5px] h-2 w-2 flex-none rounded-full [background:var(--aurora)]" />
          <span className="min-w-0">Picked by Aurora: {reason}</span>
        </p>
      )}
      {items.map((it, i) => (
        <Fragment key={i}>
          {it.group && i > 0 && <div className="mx-3 my-1.5 h-px bg-line-strong" role="separator" />}
          <button
            ref={el => { itemRefs.current[i] = el }}
            type="button"
            role="menuitem"
            tabIndex={i === active ? 0 : -1}
            onFocus={() => setActive(i)}
            onClick={() => { it.onClick(); onClose() }}
            className={`flex h-11 w-full items-center gap-2.5 rounded-art px-3 text-left text-[15px] transition-colors hover:bg-white/[0.08] ${
              it.tone === 'danger' ? 'text-danger-ink' : 'text-ink'
            } ${it.primary ? 'font-semibold' : ''}`}
          >
            {it.ai && <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full [background:var(--aurora)]" />}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.note && <span className="flex-none text-xs text-ink-3">{it.note}</span>}
          </button>
        </Fragment>
      ))}
    </div>
  )
  if (!sheet) return menu
  // The sheet's scrim. A click on it is "outside" to the listener above, so
  // it closes the menu; it only has to dim the page and block it.
  return (
    <>
      <div className="fixed inset-0 z-[99] bg-[var(--scrim)] stage-scrim-in" aria-hidden="true" />
      {menu}
    </>
  )
}
