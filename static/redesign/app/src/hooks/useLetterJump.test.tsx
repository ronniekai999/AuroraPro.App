// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useLayoutEffect, useState } from 'react'
import { useLetterJump, type LetterJump } from './useLetterJump'

afterEach(cleanup)

interface T { id: number; title: string }
const titles = (...names: string[]): T[] => names.map((title, i) => ({ id: title.charCodeAt(0) * 100 + i, title }))

/** A grid as App keeps one: the loaded titles, the server's pages still to
 *  come, and a "load more" that appends the next page when its request is
 *  answered (`answer()`), or never when it fails (`fail()`). */
interface Api { jump: LetterJump; answer: () => void; fail: () => void; reset: (to: T[] | null) => void; setSorted: (on: boolean) => void }
function grid(first: T[], more: T[][], { sorted = true } = {}) {
  const revealed: string[] = []
  const state: Api & { asks: number } =
    { jump: null as unknown as LetterJump, asks: 0, answer: () => {}, fail: () => {}, reset: () => {}, setSorted: () => {} }
  const total = first.length + more.reduce((n, p) => n + p.length, 0)
  const asked = () => { state.asks++ }
  const show = (title: string) => { revealed.push(title) }
  // What the grid offers the test, handed over after each commit.
  const report = (api: Api) => { Object.assign(state, api) }
  function Grid() {
    const [items, setItems] = useState<T[] | null>(first)
    const [pagesLeft, setPagesLeft] = useState(more)
    const [loadingMore, setLoadingMore] = useState(false)
    const [enabled, setEnabled] = useState(sorted)
    const jump = useLetterJump({
      items, total, enabled, loadingMore,
      loadMore: () => { asked(); setLoadingMore(true) },
      reveal: item => show(item.title),
    })
    useLayoutEffect(() => {
      report({
        jump,
        answer: () => {
          setItems(prev => [...(prev ?? []), ...(pagesLeft[0] ?? [])])
          setPagesLeft(p => p.slice(1))
          setLoadingMore(false)
        },
        fail: () => setLoadingMore(false),
        reset: to => { setItems(to); setLoadingMore(false) },
        setSorted: setEnabled,
      })
    }, [jump, pagesLeft])
    return null
  }
  render(<Grid />)
  return { state, revealed }
}

describe('a jump to a letter', () => {
  it('shows a letter that is loaded at once, at its first title, and asks for nothing', () => {
    const { state, revealed } = grid(titles('Alien', 'Arrival', 'Brazil', 'Brick'), [titles('Dune')])
    act(() => state.jump.jump('B'))
    expect(revealed).toEqual(['Brazil'])
    expect(state.asks).toBe(0)
    expect(state.jump.pending).toBeNull()
  })

  it('loads the next pages, one at a time, until the letter is there, and then shows it', () => {
    const { state, revealed } = grid(titles('Alien'), [titles('Brazil'), titles('Dune'), titles('Memento', 'Moon'), titles('Zodiac')])
    act(() => state.jump.jump('M'))
    expect(state.jump.pending).toBe('M')
    // It says how far the loading has got.
    expect(state.jump.progress).toEqual({ loaded: 1, total: 6 })
    expect(state.asks).toBe(1)
    act(() => state.answer())
    expect(state.jump.progress).toEqual({ loaded: 2, total: 6 })
    expect(state.asks).toBe(2)
    act(() => state.answer())
    expect(state.asks).toBe(3)
    expect(revealed).toEqual([])
    act(() => state.answer())
    expect(revealed).toEqual(['Memento'])
    // No further than it had to.
    expect(state.asks).toBe(3)
    expect(state.jump.pending).toBeNull()
    expect(state.jump.progress).toBeNull()
    expect(state.jump.states.Z).toBe('further')
  })

  // Nothing is read into the order of the list: a letter has no title only
  // once the whole list says so.
  it('loads the rest of the list for a letter that is not in it, and then says it has no title', () => {
    const { state, revealed } = grid(titles('Alien'), [titles('Brazil'), titles('Dune'), titles('Zodiac')])
    act(() => state.jump.jump('C'))
    act(() => state.answer())
    // Past where C would be, in an alphabet: still looking.
    act(() => state.answer())
    expect(state.jump.pending).toBe('C')
    act(() => state.answer())
    expect(state.jump.pending).toBeNull()
    expect(state.jump.missing).toBe('C')
    expect(state.jump.states.C).toBe('none')
    expect(revealed).toEqual([])
    // Every page, and none past the last.
    expect(state.asks).toBe(3)
  })

  it('finds a letter whose titles the server filed after everything else', () => {
    const { state, revealed } = grid(titles('Alien'), [titles('Zodiac'), titles('eXistenZ')])
    act(() => state.jump.jump('E'))
    act(() => state.answer())
    act(() => state.answer())
    expect(revealed).toEqual(['eXistenZ'])
    expect(state.jump.missing).toBeNull()
  })

  // The grid has already said the page could not be loaded.
  it('gives up when a page does not come, instead of asking again and again', () => {
    const { state, revealed } = grid(titles('Alien'), [titles('Brazil'), titles('Memento')])
    act(() => state.jump.jump('M'))
    expect(state.asks).toBe(1)
    act(() => state.fail())
    expect(state.asks).toBe(1)
    expect(state.jump.pending).toBeNull()
    expect(state.jump.missing).toBeNull()
    expect(revealed).toEqual([])
    // Asked again by the viewer, it tries again.
    act(() => state.jump.jump('M'))
    expect(state.asks).toBe(2)
  })

  it('is dropped with the list it was asked of', () => {
    const { state, revealed } = grid(titles('Alien'), [titles('Brazil'), titles('Memento')])
    act(() => state.jump.jump('M'))
    // Another genre: the grid reloads.
    act(() => state.reset(null))
    expect(state.jump.pending).toBeNull()
    act(() => state.reset(titles('Magnolia', 'Memento')))
    expect(revealed).toEqual([])
  })

  it('is dropped when the list stops being sorted by title', () => {
    const { state, revealed } = grid(titles('Alien'), [titles('Memento')])
    act(() => state.jump.jump('M'))
    act(() => state.setSorted(false))
    act(() => state.answer())
    expect(revealed).toEqual([])
    expect(state.jump.pending).toBeNull()
  })

  // Under another sort the first letters are in no order, and "past C"
  // means nothing.
  it('says nothing about the letters of a list that is not sorted by title', () => {
    const { state, revealed } = grid(titles('Zodiac', 'Alien', 'Memento'), [], { sorted: false })
    expect(Object.values(state.jump.states).filter(s => s === 'here')).toEqual([])
    act(() => state.jump.jump('A'))
    expect(revealed).toEqual([])
    expect(state.jump.pending).toBeNull()
  })

  it('forgets an empty letter when it is no longer empty, or another is asked for', () => {
    const { state } = grid(titles('Alien'), [titles('Dune')])
    act(() => state.jump.jump('C'))
    act(() => state.answer())
    expect(state.jump.missing).toBe('C')
    act(() => state.jump.jump('A'))
    expect(state.jump.missing).toBeNull()
    act(() => state.jump.jump('C'))
    expect(state.jump.missing).toBe('C')
    // A refresh brings a title under C.
    act(() => state.reset(titles('Alien', 'Casablanca', 'Dune')))
    expect(state.jump.missing).toBeNull()
  })
})
