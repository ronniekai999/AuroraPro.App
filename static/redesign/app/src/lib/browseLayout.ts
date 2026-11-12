// How a Library grid is laid out: comfortable posters, compact posters, or a
// list. The viewer's choice is kept in the prefs blob (density as
// `library_density`, the list as `library_view`); the Library header's
// control is the only place it is made. With nothing chosen, a library of
// more than a few hundred titles opens compact: at that size a comfortable
// grid is mostly scrolling.
import { useState } from 'react'
import { applyDensity, currentDensity, readPrefsSnapshot, writePrefKey } from '@/lib/appearance'

export type BrowseLayout = 'comfortable' | 'compact' | 'list'

/** Above this many titles a grid opens compact, unless the viewer chose. */
export const COMPACT_ABOVE = 300

/** The viewer's stored choice, or null when they have made none. */
export function readBrowseLayout(): BrowseLayout | null {
  const view = readPrefsSnapshot().library_view
  if (view === 'list') return 'list'
  if (view !== 'grid') {
    // The browse page's own key, from before the choice lived in the prefs.
    try {
      if (localStorage.getItem('aurora.browse.density') === 'list') return 'list'
    } catch { /* no storage: no stored choice */ }
  }
  return currentDensity()
}

export function writeBrowseLayout(layout: BrowseLayout): void {
  if (layout === 'list') {
    writePrefKey('library_view', 'list')
    return
  }
  writePrefKey('library_view', 'grid')
  applyDensity(layout)
}

/** The layout to draw: the choice, else by the size of what is listed.
 *  `total` is null while the count is unknown, which reads as small. */
export function resolveBrowseLayout(chosen: BrowseLayout | null, total: number | null | undefined): BrowseLayout {
  if (chosen) return chosen
  return total != null && total > COMPACT_ABOVE ? 'compact' : 'comfortable'
}

/** The layout a grid draws with, steady across its reloads.
 *
 *  A grid's total is unknown while it reloads (a new sort, a new genre), and
 *  a genre narrows it: decided afresh each time, a library of a thousand
 *  films would flash comfortable skeletons on every sort and change layout
 *  under a filter. So the by-size answer is taken from the whole list (no
 *  genre) when its total is known, and held until that is known again. */
export function useGridLayout(chosen: BrowseLayout | null, total: number | null | undefined, genre: string): BrowseLayout {
  const [bySize, setBySize] = useState<BrowseLayout>('comfortable')
  const known = total != null && genre === ''
  const now = known ? resolveBrowseLayout(null, total) : bySize
  // Kept for the renders where it cannot be worked out (React's "information
  // from previous renders": a set during render, which re-renders at once).
  if (now !== bySize) setBySize(now)
  return chosen ?? now
}

export type BrowseSort = 'rating' | 'title' | 'year' | 'recent'
/** The sort a grid opens with, and what "Reset" goes back to. */
export const DEFAULT_BROWSE_SORT: BrowseSort = 'title'
/** The sorts a grid offers, in the order they are offered. */
export const BROWSE_SORTS: readonly { id: BrowseSort; label: string }[] = [
  { id: 'recent', label: 'Recently added' },
  { id: 'rating', label: 'Top rated' },
  { id: 'year', label: 'Newest' },
  { id: 'title', label: 'Title, A to Z' },
]

/** The genres to offer when the library's own list could not be read: those
 *  of the titles a grid holds, in order, with the genre that is on (so that
 *  it can be turned off again). Fewer than the library has; null while
 *  there is nothing to read them from. */
export function fallbackGenres(items: readonly { genre: string }[] | null, selected: string): string[] | null {
  if (!items) return selected ? [selected] : null
  const found = new Set(items.map(m => m.genre).filter(Boolean))
  if (selected) found.add(selected)
  return [...found].sort((a, b) => a.localeCompare(b))
}
