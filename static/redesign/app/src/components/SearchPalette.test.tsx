// @vitest-environment jsdom
//
// The first DOM tests in this repo (Phase 11.1), and they exist because of a
// specific, documented failure: a Phase 10 reviewer applied SIX simultaneous
// mutations to everything that phase added —
//
//   role="option"           -> "listitem"
//   role="listbox"          -> "list"
//   aria-expanded           -> false
//   aria-activedescendant   -> undefined
//   aria-selected           -> false
//   the zero-result message -> a wrong string
//
// — and the entire gate stayed green. 132/132, tsc 0, lint unchanged. Every
// semantic the phase existed to add could have been deleted without one check
// noticing, because the whole suite was pure functions over extracted helpers and
// nothing rendered anything. `searchStatus.ts` was pulled out precisely because it
// was the only piece testable without a DOM.
//
// Each of those six now has an assertion below, plus the two focus bugs that
// actually shipped to users: the opener-capture race that made ⌘K unusable, and
// mousedown-drag on a `<div>` row escaping the modal to `<body>`.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SearchPalette } from './SearchPalette'
import type { UIMedia } from '@/lib/api'

// The debounce is 250ms of real time. Fake timers would need to be threaded
// through user-event's own scheduler (`advanceTimers`), which is more moving parts
// than this needs — `findBy*` polls, so real timers with a generous timeout is both
// simpler and closer to what a user does.
const SETTLE = { timeout: 3000 }

const media = (id: number, title: string): UIMedia => ({
  id, title, year: 2020 + id, rating: 7, duration: '1h 40m', genre: 'Drama',
  type: 'movie', poster: '', description: '',
})

const RESULTS = [media(1, 'Blade Runner'), media(2, 'Blue Velvet'), media(3, 'Brazil')]

const searchMedia = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ searchMedia }))
// scrollLock touches document.body.style and a scrollbar-width measurement; the
// real one is fine under jsdom, but its cleanup is asserted in its own unit test.
vi.mock('@/lib/scrollLock', () => ({ lockBodyScroll: () => () => {} }))

beforeEach(() => {
  searchMedia.mockReset()
  searchMedia.mockResolvedValue({ items: RESULTS, mode: 'literal' })
})

/** Render the palette with a REAL focused opener, the way App does.
 *
 *  Load-bearing, and its absence made four assertions decorative. With nothing
 *  focused, `document.activeElement` is `<body>`, so the component's
 *  `openerRef.current` captures body — and jsdom's `body.focus()` is a NO-OP while
 *  a real element holds focus. Every "focus stayed in the combobox" assertion was
 *  therefore satisfied by an opener physically incapable of stealing focus.
 *
 *  Proved by mutation: re-widening the opener-capture effect's deps back to the
 *  Phase 9 shape — the shipped P0 that made Cmd+K unusable, which the test below is
 *  named after — left all 16 tests green. With a real button it is caught. */
const open = () => {
  const opener = document.createElement('button')
  opener.textContent = 'Open search'
  document.body.appendChild(opener)
  opener.focus()
  return {
    opener,
    ...render(<SearchPalette open onClose={() => {}} onSelect={() => {}} />),
  }
}

describe('SearchPalette — APG combobox contract', () => {
  it('exposes the input as a combobox with a listbox popup', async () => {
    open()
    const box = screen.getByRole('combobox')
    expect(box).toHaveAttribute('aria-autocomplete', 'list')
    // The accessible name must not come from the placeholder alone.
    expect(box).toHaveAccessibleName('Search Aurora')
  })

  it('is COLLAPSED with no query, and drops aria-controls rather than dangling it', () => {
    open()
    const box = screen.getByRole('combobox')
    expect(box).toHaveAttribute('aria-expanded', 'false')
    // Mutation target: `aria-expanded={results.length > 0}` with the listbox
    // rendered unconditionally declared the combobox collapsed while pointing
    // aria-controls at a visible 171px panel. JAWS suppresses a collapsed
    // combobox's controlled list, so it hid a panel the sighted user could see.
    expect(box).not.toHaveAttribute('aria-controls')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('EXPANDS once options exist and points aria-controls at the listbox', async () => {
    const user = userEvent.setup()
    open()
    await user.type(screen.getByRole('combobox'), 'b')
    const list = await screen.findByRole('listbox', {}, SETTLE)
    const box = screen.getByRole('combobox')
    expect(box).toHaveAttribute('aria-expanded', 'true')
    expect(box).toHaveAttribute('aria-controls', list.id)
  })

  it('renders results as OPTIONS, not list items', async () => {
    const user = userEvent.setup()
    open()
    await user.type(screen.getByRole('combobox'), 'b')
    const options = await screen.findAllByRole('option', {}, SETTLE)
    expect(options).toHaveLength(3)
    // Plain assertion rather than nested asymmetric matchers: vitest's chai bridge
    // throws "Cannot read properties of undefined (reading '__flags')" on an
    // `expect.stringContaining` nested inside `expect.arrayContaining`.
    for (const [i, title] of ['Blade Runner', 'Blue Velvet', 'Brazil'].entries()) {
      expect(options[i]).toHaveTextContent(title)
    }
  })

  it('lets the listbox own OPTIONS AND NOTHING ELSE', async () => {
    const user = userEvent.setup()
    open()
    await user.type(screen.getByRole('combobox'), 'b')
    const list = await screen.findByRole('listbox', {}, SETTLE)
    // ARIA requires a listbox to own `option`/`group` only, and Chromium does not
    // repair a violation: it hung fourteen orphaned text nodes straight off the
    // listbox when the hint block, the "Searching…" line and the "No matches"
    // block were all inside it. In a combobox+activedescendant inside an
    // aria-modal dialog, NVDA/JAWS are in focus mode with the virtual cursor off,
    // so everything in that container became unreachable — including the app's
    // only documentation of its own keyboard model.
    for (const child of Array.from(list.children)) {
      expect(child).toHaveAttribute('role', 'option')
    }
    expect(within(list).queryByText(/navigate|select|close/i)).toBeNull()
  })

  it('marks exactly one option selected and names it via aria-activedescendant', async () => {
    const user = userEvent.setup()
    open()
    await user.type(screen.getByRole('combobox'), 'b')
    const options = await screen.findAllByRole('option', {}, SETTLE)
    expect(options.filter(o => o.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', options[0].id)
  })
})

describe('SearchPalette — keyboard', () => {
  it('moves the ACTIVE DESCENDANT with the arrows while DOM focus never leaves the input', async () => {
    const user = userEvent.setup()
    open()
    const box = screen.getByRole('combobox')
    await user.type(box, 'b')
    const options = await screen.findAllByRole('option', {}, SETTLE)

    await user.keyboard('{ArrowDown}')
    expect(box).toHaveAttribute('aria-activedescendant', options[1].id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
    // The load-bearing half of the pattern: focus stays put. As tabbable
    // <button> rows this widget had THREE competing cursors and the ⏎ affordance
    // could advertise on a row Enter would not act on.
    expect(box).toHaveFocus()

    await user.keyboard('{ArrowUp}')
    expect(box).toHaveAttribute('aria-activedescendant', options[0].id)
    expect(box).toHaveFocus()
  })

  it('clamps at both ends rather than wrapping', async () => {
    const user = userEvent.setup()
    open()
    const box = screen.getByRole('combobox')
    await user.type(box, 'b')
    const options = await screen.findAllByRole('option', {}, SETTLE)

    await user.keyboard('{ArrowUp}')
    expect(box).toHaveAttribute('aria-activedescendant', options[0].id)
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(box).toHaveAttribute('aria-activedescendant', options[2].id)
  })

  it('selects the ACTIVE option on Enter and closes', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<SearchPalette open onClose={onClose} onSelect={onSelect} />)
    await user.type(screen.getByRole('combobox'), 'b')
    await screen.findAllByRole('option', {}, SETTLE)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].title).toBe('Blue Velvet')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<SearchPalette open onClose={onClose} onSelect={() => {}} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('SearchPalette — outside click', () => {
  // Regression for #472: the backdrop is a covering CHILD of the overlay, not
  // the overlay itself, so `e.target === e.currentTarget` never matched a
  // backdrop click and the palette could never be dismissed by clicking out.
  it('closes when the backdrop behind the panel is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(<SearchPalette open onClose={onClose} onSelect={() => {}} />)
    const backdrop = container.querySelector('.backdrop-blur-xl')
    expect(backdrop).not.toBeNull()
    await user.click(backdrop as Element)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not close when the panel itself is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<SearchPalette open onClose={onClose} onSelect={() => {}} />)
    await user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('SearchPalette — the Tab trap', () => {
  // Eighteen lines of WCAG rationale sat above this trap with ZERO assertions.
  // A reviewer disabled it outright — `if (e.key !== 'Tab') return` made
  // unreachable — and all 16 tests stayed green.
  //
  // `aria-modal` is a hint to AT's virtual cursor and does nothing whatsoever to
  // the browser's tab ring, so without the trap Tab walked out of a full-viewport
  // overlay into TopNav and painted a focus ring on content the user cannot see.

  /** A focusable standing in for the chrome behind the overlay. */
  const behind = () => {
    const b = document.createElement('button')
    b.textContent = 'TopNav Home tab'
    document.body.appendChild(b)
    return b
  }

  it('does not let Tab reach content behind the overlay', async () => {
    const user = userEvent.setup()
    const { opener } = open()
    const outside = behind()
    const panel = screen.getByRole('dialog')

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus())
    // Several presses: one Tab could stop somewhere harmless by luck, and the
    // shipped bug took two to reach the nav.
    await user.tab()
    await user.tab()
    await user.tab()

    expect(outside).not.toHaveFocus()
    expect(opener).not.toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('does not let Shift+Tab reach it either', async () => {
    const user = userEvent.setup()
    const { opener } = open()
    const outside = behind()
    const panel = screen.getByRole('dialog')

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus())
    await user.tab({ shift: true })
    await user.tab({ shift: true })

    expect(outside).not.toHaveFocus()
    expect(opener).not.toHaveFocus()
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('keeps Tab inside once the results have added controls to the ring', async () => {
    const user = userEvent.setup()
    open()
    const outside = behind()
    const panel = screen.getByRole('dialog')

    // With a query there are more focusables (Clear, the Search chip), so the
    // first/last pair the trap wraps between is a different pair entirely.
    await user.type(screen.getByRole('combobox'), 'b')
    await screen.findAllByRole('option', {}, SETTLE)
    for (let i = 0; i < 5; i++) await user.tab()

    expect(outside).not.toHaveFocus()
    expect(panel.contains(document.activeElement)).toBe(true)
  })
})

describe('SearchPalette — the focus bugs that shipped', () => {
  it('focuses the input on open — the ⌘K race', async () => {
    open()
    // This was a P0 that reached users. The opener capture and scroll lock lived
    // in an effect keyed on [open, results, highlighted, onClose, onSelect], so
    // its cleanup ran on every re-render and stole focus back ~2ms after the
    // input got it. In the whitelisted flow the user's query went into the input
    // BEHIND the modal. Splitting it into an [open]-keyed effect is the fix.
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus())
  })

  it('keeps focus in the combobox when a row is pressed', async () => {
    const user = userEvent.setup()
    open()
    const box = screen.getByRole('combobox')
    await user.type(box, 'b')
    const options = await screen.findAllByRole('option', {}, SETTLE)

    // `<div>` text is selectable where `<button>` text is not, so once the rows
    // stopped being buttons a mousedown-drag blurred the input and left
    // activeElement === body — OUTSIDE the panel. The Tab trap is bound to the
    // panel's onKeyDown, so it stopped firing and the next Tabs walked into
    // TopNav behind a full-viewport aria-modal overlay.
    await user.pointer({ keys: '[MouseLeft>]', target: options[2] })
    expect(document.activeElement).not.toBe(document.body)
    expect(box).toHaveFocus()
  })

  it('still selects on click despite the suppressed mousedown', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<SearchPalette open onClose={() => {}} onSelect={onSelect} />)
    await user.type(screen.getByRole('combobox'), 'b')
    const options = await screen.findAllByRole('option', {}, SETTLE)
    await user.click(options[2])
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].title).toBe('Brazil')
  })
})

describe('SearchPalette — the live region', () => {
  it('announces the result count once the results belong to the query', async () => {
    const user = userEvent.setup()
    open()
    await user.type(screen.getByRole('combobox'), 'b')
    await waitFor(
      () => expect(screen.getByRole('status')).toHaveTextContent('3 results for b'),
      SETTLE,
    )
  })

  it('announces no-match with the query, and keeps the listbox out of the tree', async () => {
    searchMedia.mockResolvedValue({ items: [], mode: 'literal' })
    const user = userEvent.setup()
    open()
    await user.type(screen.getByRole('combobox'), 'zzzz')
    await waitFor(
      () => expect(screen.getByRole('status')).toHaveTextContent('No matches for zzzz'),
      SETTLE,
    )
    // Zero options means no listbox element, so the combobox is collapsed again.
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false')
  })

  it('never opens a search by announcing a false negative', async () => {
    const user = userEvent.setup()
    open()
    const box = screen.getByRole('combobox')
    await user.type(box, 'b')
    // Synchronously after the keystroke: `loading` lags a commit, so keying the
    // region off it announced "No matches for b" as the opening line of every
    // search. It must say Searching, or nothing — never a count.
    expect(screen.getByRole('status').textContent).not.toMatch(/No matches/)
  })
})
