// A Library grid's controls, for its header: how many titles there are, the
// sort, the layout (comfortable or compact posters, or a list) and the
// genres. On a wide screen they sit in the header's row with the genres as a
// wrapping row of chips under it; on a phone the row has no room, so it
// keeps the count and one "Filters" button, which opens them all in a sheet.
//
// Every choice applies at once (the grid behind the sheet reloads), so the
// sheet's main button only closes it, and says how many titles there now are.

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon } from '@/components/Icon'
import { BROWSE_SORTS, DEFAULT_BROWSE_SORT, type BrowseLayout, type BrowseSort } from '@/lib/browseLayout'
import { JUMP_LETTERS, type LetterState } from '@/lib/letterJump'

export interface BrowseControlsProps {
  /** What is counted: "movie" or "show". */
  noun: 'movie' | 'show'
  /** How many titles the list holds on the server; null while unknown. */
  total: number | null
  sortBy: BrowseSort
  onSortChange: (s: BrowseSort) => void
  layout: BrowseLayout
  onLayoutChange: (l: BrowseLayout) => void
  /** '' is every genre. */
  genre: string
  onGenreChange: (g: string) => void
  /** The library's genres; null while they load. */
  genres: string[] | null
}

const LAYOUTS: readonly { id: BrowseLayout; label: string; short: string; icon: string }[] = [
  { id: 'comfortable', label: 'Comfortable grid', short: 'Posters', icon: 'grid' },
  { id: 'compact', label: 'Compact grid', short: 'Compact', icon: 'grid-small' },
  { id: 'list', label: 'List', short: 'List', icon: 'list' },
]

/** "1,284 movies", "1 show", "212 Drama movies". */
export function countLabel(total: number | null, noun: 'movie' | 'show', genre: string): string {
  if (total === null) return ''
  return `${total.toLocaleString()} ${genre ? `${genre} ` : ''}${noun}${total === 1 ? '' : 's'}`
}

/** The header row's controls. */
export function BrowseTools(props: BrowseControlsProps) {
  const { noun, total, sortBy, onSortChange, layout, onLayoutChange, genre } = props
  const sortLabel = BROWSE_SORTS.find(s => s.id === sortBy)?.label ?? ''
  return (
    <>
      {/* The count is the page's live region: it is the whole answer to
          "did my filter do anything". */}
      <p className="stage-browse-count" role="status" aria-live="polite" data-browse-count="">
        {countLabel(total, noun, genre)}
        {/* A phone has no sort control in the row to say this. */}
        {total !== null && <span className="md:hidden"> · {sortLabel.toLowerCase()}</span>}
      </p>
      <label className="stage-browse-sort flex items-center max-md:hidden">
        <span>Sort</span>
        <select
          value={sortBy}
          onChange={e => onSortChange(e.target.value as BrowseSort)}
          // Native: every platform keeps its own picker.
          className="stage-select"
          aria-label="Sort titles"
        >
          {BROWSE_SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <div className="stage-seg flex max-md:hidden" role="group" aria-label="View density">
        {LAYOUTS.map(l => (
          <button
            key={l.id}
            type="button"
            onClick={() => onLayoutChange(l.id)}
            aria-pressed={layout === l.id}
            aria-label={l.label}
            title={l.label}
            className="stage-seg-btn"
          >
            <Icon name={l.icon} size={16} />
          </button>
        ))}
      </div>
      <BrowseFilters {...props} />
    </>
  )
}

/** The genres as a wrapping row of chips: the header's second row, on a
 *  screen wide enough for it. */
export function GenreChips({ genre, onGenreChange, genres }: Pick<BrowseControlsProps, 'genre' | 'onGenreChange' | 'genres'>) {
  if (!genres || genres.length === 0) return null
  return (
    <div role="group" aria-label="Genre" className="stage-genres flex flex-wrap max-md:hidden">
      <GenreButtons genre={genre} onGenreChange={onGenreChange} genres={genres} />
    </div>
  )
}

function GenreButtons({ genre, onGenreChange, genres, touch = false }: { genre: string; onGenreChange: (g: string) => void; genres: string[]; touch?: boolean }) {
  return (
    <>
      {['', ...genres].map(g => (
        <button
          key={g || 'all'}
          type="button"
          onClick={() => onGenreChange(g)}
          aria-pressed={genre === g}
          className={touch ? 'genre-chip is-touch' : 'genre-chip'}
        >
          {g || 'All genres'}
        </button>
      ))}
    </>
  )
}

/** The A to Z strip of a grid sorted by title. It stays under the top bar
 *  while the grid scrolls, since the place it is wanted is deep in the list.
 *
 *  A letter with a loaded title jumps to its first; one with none in the
 *  whole list is off; one not seen yet, while pages are still to come, loads
 *  them first (hooks/useLetterJump), and the strip says how far it has got.
 *
 *  A letter that is off is `aria-disabled`, not `disabled`: one that is
 *  pressed from the keyboard and turns out to have nothing would otherwise
 *  be disabled while it held the focus, which drops the focus to the page.
 *
 *  One tab stop: the arrow keys, Home and End move along the letters that
 *  can be pressed, so the grid is one Tab away, not twenty-seven. A wide
 *  screen only: a phone's row has no room for it.
 *
 *  The strip wraps to a second row where its letters do not fit (a narrow
 *  window; a touch screen, where each letter is a 44px target), so its
 *  height is measured and published as --jumpbar-h: the page's scroll
 *  padding is taken from it, and a title the strip scrolls to stops under
 *  the strip whatever its height. */
export function LetterStrip({ states, pending, progress, missing, onJump }: {
  states: Record<string, LetterState>
  /** The letter whose pages are being loaded. */
  pending: string | null
  /** While that is so: how much of the list is loaded. */
  progress?: { loaded: number; total: number } | null
  /** A letter that was asked for and has no title. */
  missing: string | null
  onJump: (letter: string) => void
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const bar = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const root = document.documentElement
    const publish = () => root.style.setProperty('--jumpbar-h', `${Math.ceil(el.getBoundingClientRect().height)}px`)
    publish()
    const seen = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    seen?.observe(el)
    return () => { seen?.disconnect(); root.style.removeProperty('--jumpbar-h') }
  }, [])
  // The letter that holds the tab stop: the one last used, while it can
  // still be pressed, else the first that can.
  const [held, setHeld] = useState<string | null>(null)
  const open = JUMP_LETTERS.filter(l => states[l] !== 'none')
  const stop = held && open.includes(held) ? held : open[0]
  const onKeyDown = (e: KeyboardEvent, from: string) => {
    // From where the letter stands among all of them: the one in hand may
    // itself be off (it was pressed, and has nothing).
    const at = JUMP_LETTERS.indexOf(from)
    const after = open.filter(l => JUMP_LETTERS.indexOf(l) > at)
    const before = open.filter(l => JUMP_LETTERS.indexOf(l) < at)
    // Past either end there is no letter, and the key is left alone.
    const to = e.key === 'ArrowRight' ? after[0]
      : e.key === 'ArrowLeft' ? before[before.length - 1]
      : e.key === 'Home' ? open[0]
      : e.key === 'End' ? open[open.length - 1]
      : undefined
    if (to === undefined || to === from) return
    e.preventDefault()
    setHeld(to)
    buttons.current.get(to)?.focus()
  }
  return (
    <div ref={bar} className="stage-gutter stage-jumpbar max-md:hidden" data-letter-strip="">
      <div role="toolbar" aria-label="Jump to letter" aria-orientation="horizontal" className="stage-jump flex flex-wrap items-center">
        {JUMP_LETTERS.map(letter => {
          const off = states[letter] === 'none'
          return (
            <button
              key={letter}
              type="button"
              ref={el => { if (el) buttons.current.set(letter, el); else buttons.current.delete(letter) }}
              className="stage-jump-btn"
              data-state={states[letter]}
              aria-disabled={off || undefined}
              tabIndex={letter === stop ? 0 : -1}
              aria-label={letter === '#' ? 'Numbers and symbols' : undefined}
              aria-busy={pending === letter || undefined}
              onClick={() => { if (off) return; setHeld(letter); onJump(letter) }}
              onKeyDown={e => onKeyDown(e, letter)}
            >
              {letter}
            </button>
          )
        })}
        <span role="status" className="stage-jump-status">
          {pending
            ? `Loading titles to find ${pending}…${progress ? ` ${progress.loaded.toLocaleString()} of ${progress.total.toLocaleString()}` : ''}`
            : missing ? `No titles under ${missing}.` : ''}
        </span>
      </div>
    </div>
  )
}

/** The phone's way to all of it: one button, and a sheet. */
function BrowseFilters({ noun, total, sortBy, onSortChange, layout, onLayoutChange, genre, onGenreChange, genres }: BrowseControlsProps) {
  const [open, setOpen] = useState(false)
  const changed = genre !== '' || sortBy !== DEFAULT_BROWSE_SORT
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="stage-filters-btn inline-flex items-center md:hidden" data-filters-trigger="">
          <Icon name="sliders" size={16} />
          Filters
          {changed && <span className="sr-only">, some applied</span>}
          {changed && <span className="stage-filters-dot" aria-hidden="true" />}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[99] bg-[var(--scrim)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="stage-sheet-in fixed inset-x-0 bottom-0 z-[100] flex max-h-[88dvh] flex-col gap-5 overflow-y-auto rounded-t-sheet bg-surface-raised-2 px-4 pb-[calc(20px+env(safe-area-inset-bottom,0px))] pt-2"
        >
          <span className="mx-auto h-1 w-10 flex-none rounded-full bg-[var(--track)]" aria-hidden="true" />
          <div className="flex items-center">
            <Dialog.Title className="flex-1 font-display text-[26px] font-bold tracking-[-0.015em] text-ink">Filters</Dialog.Title>
            <button
              type="button"
              disabled={!changed}
              onClick={() => { onGenreChange(''); onSortChange(DEFAULT_BROWSE_SORT) }}
              className="h-11 rounded-control px-3 text-[15px] font-semibold text-ink-2 hover:text-ink disabled:opacity-40"
            >
              Reset
            </button>
          </div>
          <fieldset className="stage-sheet-set">
            <legend>Sort by</legend>
            <div className="flex flex-wrap gap-2">
              {BROWSE_SORTS.map(s => (
                <button key={s.id} type="button" aria-pressed={sortBy === s.id} onClick={() => onSortChange(s.id)} className="genre-chip is-touch">
                  {s.label}
                </button>
              ))}
            </div>
          </fieldset>
          {genres && genres.length > 0 && (
            <fieldset className="stage-sheet-set">
              <legend>Genre</legend>
              <div className="flex flex-wrap gap-2">
                <GenreButtons genre={genre} onGenreChange={onGenreChange} genres={genres} touch />
              </div>
            </fieldset>
          )}
          <fieldset className="stage-sheet-set">
            <legend>Show as</legend>
            <div className="stage-seg flex">
              {LAYOUTS.map(l => (
                <button key={l.id} type="button" aria-pressed={layout === l.id} onClick={() => onLayoutChange(l.id)} className="stage-seg-btn is-touch">
                  {l.short}
                </button>
              ))}
            </div>
          </fieldset>
          <Dialog.Close asChild>
            <button type="button" className="stage-btn stage-btn-lg stage-btn-primary w-full flex-none">
              {total === null ? 'Done' : `Show ${countLabel(total, noun, genre)}`}
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
