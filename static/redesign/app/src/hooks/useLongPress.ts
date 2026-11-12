// A long press on a touch screen, for a surface that offers a title's menu
// on right click: a mouse has its own contextmenu event and Android fires
// one for a long press, but iOS Safari does not, so a timer does it there.
// Without it the menu could not be reached from that surface on an iPhone
// except through its More button.
//
// MediaCardCinema has its own copy, wound into its hover and focus state;
// this is the same rule (the same time, the same slop) for the plainer
// surfaces: a list row, the search page's best match.

import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { LONG_PRESS_MS } from '@/components/MediaCardCinema'

/** How far a finger may drift and still be pressing, not scrolling. */
const LONG_PRESS_SLOP_PX = 10

/** `onLongPress` is handed what the menu needs of a mouse event: where the
 *  press is, and the element it is on. `resetKey` is what the surface shows
 *  (a title's id): a surface replaced mid-press must not open a menu for the
 *  title it held. A press that starts inside `ownSelector` is that element's
 *  own (a button beside the title), not the surface's. */
export function useLongPress(
  onLongPress: ((e: ReactMouseEvent) => void) | undefined,
  resetKey: unknown,
  ownSelector: string,
) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const cancel = () => {
    if (press.current) { window.clearTimeout(press.current.timer); press.current = null }
  }
  useEffect(() => () => {
    if (press.current) { window.clearTimeout(press.current.timer); press.current = null }
  }, [resetKey])
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    suppressClick.current = false
    if (e.pointerType !== 'touch' || !onLongPress) return
    if ((e.target as Element).closest?.(ownSelector)) return
    cancel()
    const el = e.currentTarget
    const { clientX, clientY } = e
    press.current = {
      x: clientX,
      y: clientY,
      timer: window.setTimeout(() => {
        press.current = null
        suppressClick.current = true
        // The menu takes a mouse event for its position; a press has one.
        onLongPress({ preventDefault() {}, clientX, clientY, detail: 1, currentTarget: el } as unknown as ReactMouseEvent)
      }, LONG_PRESS_MS),
    }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) cancel()
  }
  return {
    /** Stops a press that is still counting (a right click arrived first). */
    cancel,
    /** True, once, when the press just opened the menu: the click that
     *  follows the finger lifting is not a tap, and must not open the title. */
    swallowClick() {
      if (!suppressClick.current) return false
      suppressClick.current = false
      return true
    },
    handlers: { onPointerDown, onPointerMove, onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel },
  }
}
