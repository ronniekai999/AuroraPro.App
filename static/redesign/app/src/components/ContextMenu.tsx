// Aurora V2 — right-click context menu on media cards.
// Phase 5.2 parity port of V1's `showContextMenu`. Anchors at the
// cursor, closes on Escape / outside-click. Caller decides which
// items to expose (admin gates the Refresh-Metadata item).
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

import { useEffect, useRef, useState } from 'react'

export interface MediaContextItem {
  label: string
  // 'danger' tints red (e.g. Clear Progress). 'admin' is just a hint
  // for the caller — not rendered differently here.
  tone?: 'default' | 'danger'
  onClick: () => void
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

export function ContextMenu({ x, y, items, onClose, title }: Props) {
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
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const raf = requestAnimationFrame(() => {
      setActive(0)
      itemRefs.current[0]?.focus()
    })
    return () => {
      cancelAnimationFrame(raf)
      if (opener && opener.isConnected) opener.focus({ preventScroll: true })
    }
    // Mount/unmount only — re-running would yank focus mid-interaction. No
    // disable comment needed: the effect closes over nothing but refs.
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // Bind on next tick so the same right-click that opened us
    // doesn't immediately close us via this listener.
    const t = window.setTimeout(() => window.addEventListener('mousedown', onClick), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
      window.clearTimeout(t)
    }
  }, [onClose])

  // Clamp to viewport so the menu never overflows the right/bottom edge.
  const maxX = typeof window !== 'undefined' ? window.innerWidth - 220 : x
  const maxY = typeof window !== 'undefined' ? window.innerHeight - items.length * 36 - 16 : y
  const clampedX = Math.min(x, Math.max(0, maxX))
  const clampedY = Math.min(y, Math.max(0, maxY))

  const move = (delta: number) => {
    const n = items.length
    if (!n) return
    // Wraps, per APG: Down from the last item goes to the first.
    const next = (active + delta + n) % n
    setActive(next)
    itemRefs.current[next]?.focus()
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={title ? `Actions for ${title}` : 'Media actions'}
      // Enter animation only. It was the one popover in the app that simply
      // appeared. No exit: this menu's close contract is synchronous — App
      // unmounts it on onClose, and keyboardWidgets.test asserts onClose has
      // fired by the time Escape's keydown returns — so a delayed unmount
      // would change tested behaviour for a 150ms fade.
      className="fixed z-[100] min-w-[200px] bg-[#1a1a22] border border-white/[0.08] rounded-lg shadow-2xl py-1 animate-fade-in"
      style={{ left: clampedX, top: clampedY }}
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
      {items.map((it, i) => (
        <button
          key={i}
          ref={el => { itemRefs.current[i] = el }}
          type="button"
          role="menuitem"
          tabIndex={i === active ? 0 : -1}
          onFocus={() => setActive(i)}
          onClick={() => { it.onClick(); onClose() }}
          className={`w-full text-left px-3 py-2 text-sm transition-colors ${
            it.tone === 'danger'
              ? 'text-red-300 hover:bg-red-500/10'
              : 'text-white/85 hover:bg-white/[0.06]'
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}
