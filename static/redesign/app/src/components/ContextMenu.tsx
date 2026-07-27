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

import { useEffect, useRef } from 'react'

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
}

/**
 * Where to put the menu for a `contextmenu` event.
 *
 * Exported and pure so the keyboard/pointer distinction can be tested — it is a
 * behavioural difference that is invisible in a mouse-driven manual pass, which
 * is exactly how it shipped.
 *
 * A pointer-driven contextmenu carries real viewport coordinates; a
 * keyboard-driven one (Shift+F10, or the Menu key) reports 0/0. Anchoring to the
 * focused element's box in that case is both correct and what every native menu
 * does.
 *
 * ⚠️ The coordinates are the ONLY signal used, deliberately. The first version of
 * this also treated `detail === 0` as keyboard-driven, which is wrong: unlike
 * `click`, a `contextmenu` event fired by a real right-click ALSO reports
 * `detail: 0`, so that check misclassified every mouse open and anchored the menu
 * to the card instead of the cursor. The test written for the pointer case caught
 * it immediately — which is the argument for extracting this at all, since a
 * mouse-driven manual pass is exactly what missed the original bug.
 */
export function anchorFor(e: {
  clientX: number
  clientY: number
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

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // Which item holds the single tab stop. The set is ONE tab stop (APG Menu), so
  // this is a roving index rather than every item being tabbable.
  const activeRef = useRef(0)

  // Focus the first item on open and restore the opener on close. Without the
  // restore, activating an item unmounts the focused element and focus falls to
  // <body> — the card you opened the menu from is then gone from under the
  // user (WCAG 2.4.3).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const raf = requestAnimationFrame(() => {
      activeRef.current = 0
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
    const next = (activeRef.current + delta + n) % n
    activeRef.current = next
    itemRefs.current[next]?.focus()
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Media actions"
      className="fixed z-[100] min-w-[200px] bg-[#1a1a22] border border-white/[0.08] rounded-lg shadow-2xl py-1"
      style={{ left: clampedX, top: clampedY }}
      onKeyDown={e => {
        // Handled here rather than per item so the contract lives in one place,
        // and stopped so the card underneath — which has its own Enter/Space
        // handler — cannot also act on the same key.
        switch (e.key) {
          case 'ArrowDown': e.preventDefault(); e.stopPropagation(); move(1); break
          case 'ArrowUp': e.preventDefault(); e.stopPropagation(); move(-1); break
          case 'Home':
            e.preventDefault(); e.stopPropagation()
            activeRef.current = 0
            itemRefs.current[0]?.focus()
            break
          case 'End':
            e.preventDefault(); e.stopPropagation()
            activeRef.current = items.length - 1
            itemRefs.current[items.length - 1]?.focus()
            break
          case 'Tab':
            // A menu is not part of the tab ring — Tab dismisses it. That is what
            // APG specifies, and it is what stops focus landing on something
            // behind an open overlay.
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
          tabIndex={i === 0 ? 0 : -1}
          onFocus={() => { activeRef.current = i }}
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
