// The Library's header: one slim row instead of a page title, a featured
// band and a toolbar. Movies, TV Shows, Collections, My Library and Upcoming
// are scopes of one destination; each is still its own view with its own
// URL, and this row moves between them. At its right sit the controls of the
// scope on screen (a grid's count, sort and density), and under it a second
// row when the scope has one (a grid's genres).
//
// App renders it, above whichever scope is on screen, so it stays put while
// a grid reloads: changing the sort used to unmount the select that changed
// it, with the keyboard's focus in it.

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { libraryScopesFor, type NavScope } from '@/lib/navScope'

// Where a scope that keeps its own state (My Library's kind, Upcoming's
// List or Month, a collection count) puts its controls: the right of the
// header's row. The header is App's and the state is the view's, so the
// view hands its controls over through a portal into this element.
const LibraryToolsSlot = createContext<HTMLElement | null>(null)
export const LibraryToolsProvider = LibraryToolsSlot.Provider

/** Where the scope strip scrolls to so that the scope at `left`, `width`
 *  wide, sits in the middle of a strip `view` wide (never before the start;
 *  the browser stops it at the end). */
export function scopeScrollLeft(left: number, width: number, view: number): number {
  return Math.max(0, Math.round(left - (view - width) / 2))
}

/** A scope's controls, drawn at the right of the Library header's row. With
 *  no header above (the view rendered by itself), they are drawn in place. */
export function LibraryTools({ children }: { children: ReactNode }) {
  const slot = useContext(LibraryToolsSlot)
  if (slot) return createPortal(children, slot)
  return <div className="stage-libhead-tools mb-4 flex items-center" data-library-tools="">{children}</div>
}

export interface LibraryHeaderProps {
  /** The view on screen. */
  current: string
  navScope: NavScope
  onNavigate: (view: string) => void
  onPrefetch?: (view: string) => void
  /** The page's name, as its <h1>, for a scope that draws no heading of its
   *  own (the grids). The scope row already shows it, marked current, so it
   *  is for assistive tech only, except where there is no scope row. */
  title?: string
  /** The controls of the scope on screen, at the row's right. */
  tools?: ReactNode
  /** Given the element a scope's own controls go into (LibraryTools), when
   *  `tools` is not passed. */
  toolsRef?: (el: HTMLElement | null) => void
  /** A second row, under the scope names. */
  children?: ReactNode
}

export function LibraryHeader({ current, navScope, onNavigate, onPrefetch, title, tools, toolsRef, children }: LibraryHeaderProps) {
  const scopes = libraryScopesFor(navScope)
  // A scope the session is not offered can still be on screen (opened by
  // URL). With nothing to mark as current the row would mislead, and a
  // restricted session reaches Movies and Shows from the bar itself: it gets
  // the page's name where the scope names would be.
  const showScopes = navScope !== 'restricted'
  // On a phone the scope names are a strip that scrolls sideways, and the
  // last ones start off its edge: the one that is on screen is brought into
  // view, so the page never opens with its own name cut off.
  // The strip's own scroll position is set, not scrollIntoView: that scrolls
  // every ancestor that can scroll, the page included.
  const bar = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const strip = bar.current
    const on = strip?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!strip || !on) return
    // Where the name starts within the strip's own content, measured from
    // the two boxes (offsetLeft would be from the offset parent, which is
    // not the strip unless the strip happens to be positioned).
    const name = on.getBoundingClientRect()
    const left = name.left - strip.getBoundingClientRect().left + strip.scrollLeft
    strip.scrollLeft = scopeScrollLeft(left, name.width, strip.clientWidth)
  }, [current])
  if (!showScopes && !title && !tools && !toolsRef && !children) return null
  return (
    <header className="stage-gutter stage-libhead" data-library-header="">
      <div className="stage-libhead-row flex flex-wrap items-center">
        {title && (showScopes
          ? <h1 className="sr-only">{title}</h1>
          : <h1 className="stage-libhead-title">{title}</h1>)}
        {showScopes && (
          <nav aria-label="Library" className="stage-scopebar flex" ref={bar}>
            {scopes.map(s => (
              <button
                key={s.id}
                type="button"
                data-scope={s.id}
                aria-current={current === s.id ? 'page' : undefined}
                className="stage-scope"
                onClick={() => onNavigate(s.id)}
                onPointerEnter={() => onPrefetch?.(s.id)}
                onFocus={() => onPrefetch?.(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>
        )}
        {tools
          ? <div className="stage-libhead-tools flex items-center">{tools}</div>
          : toolsRef && <div ref={toolsRef} className="stage-libhead-tools flex items-center" data-library-tools="" />}
      </div>
      {children}
    </header>
  )
}
