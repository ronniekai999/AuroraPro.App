// A jump to a letter in a Library grid sorted by title.
//
// A letter with a loaded title is shown at once, at the first such title in
// the list as the server ordered it. One with none loaded asks the grid for
// its next page, and the next, until a title filed under the letter is in
// the list or the whole list is: the requests "Load more" makes, in the same
// order. The strip is only drawn for a list that fits in the pages a grid
// keeps live (App), so that is a few requests at most and the grid is still
// refreshed afterwards. See lib/letterJump for what is known about a letter.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { letterIndex, type Filed, type LetterState } from '@/lib/letterJump'

export interface LetterJump {
  /** Each letter's state, from the loaded pages. */
  states: Record<string, LetterState>
  /** The letter being looked for in pages not loaded yet. */
  pending: string | null
  /** While that is so: how many of the list's titles are loaded, and how
   *  many there are. */
  progress: { loaded: number; total: number } | null
  /** A letter that was looked for and has no title. */
  missing: string | null
  jump: (letter: string) => void
}

export function useLetterJump<T extends Filed>({ items, total, enabled, loadingMore, loadMore, reveal }: {
  /** The grid's titles, in the server's order; null while it loads. */
  items: readonly T[] | null
  /** How many the whole list holds; null while unknown. */
  total: number | null
  /** Whether the list is sorted by title (the strip means nothing otherwise). */
  enabled: boolean
  loadingMore: boolean
  /** Asks for the grid's next page ("Load more"). */
  loadMore: () => void
  /** Brings a title's card to the top of the page and puts focus on it. */
  reveal: (item: T) => void
}): LetterJump {
  const complete = items !== null && total !== null && items.length >= total
  const index = useMemo(() => letterIndex(enabled && items ? items : [], complete), [enabled, items, complete])
  // The letter asked for, and how long the list was when its next page was
  // last asked for: back at that length with nothing loading, the page did
  // not come (the request failed, and the grid has said so), and the jump
  // stops there instead of asking again for ever.
  const [target, setTarget] = useState<{ letter: string; askedAt: number } | null>(null)
  const [missing, setMissing] = useState<string | null>(null)

  const jump = useCallback((letter: string) => {
    setMissing(null)
    setTarget({ letter, askedAt: -1 })
  }, [])

  useEffect(() => {
    if (!target) return
    // The list it was asked of is gone (another sort, another genre, another
    // profile): so is the jump.
    if (!enabled || !items) { setTarget(null); return }
    const at = index.first[target.letter]
    if (at !== undefined) {
      setTarget(null)
      reveal(items[at])
      return
    }
    if (index.states[target.letter] === 'none') {
      setTarget(null)
      setMissing(target.letter)
      return
    }
    if (loadingMore) return
    if (target.askedAt === items.length) { setTarget(null); return }
    setTarget({ letter: target.letter, askedAt: items.length })
    loadMore()
  }, [target, enabled, items, index, loadingMore, loadMore, reveal])

  return {
    states: index.states,
    pending: target ? target.letter : null,
    progress: target && items && total !== null ? { loaded: items.length, total } : null,
    // Only while it is still true of the list on screen.
    missing: missing && enabled && index.states[missing] === 'none' ? missing : null,
    jump,
  }
}
