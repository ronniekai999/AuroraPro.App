// @vitest-environment jsdom
//
// Phase 11.1 — the other three hand-rolled keyboard widgets from Phases 9 and 10.
//
// Every bug asserted here actually happened and was found by a human reading the
// diff, which is the cost this file exists to remove:
//
//   - The roving tabIndex DID NOT ROVE. Both widgets rendered `tabIndex` off a
//     ref, and writing a ref does not re-render, so the tab stop never moved.
//   - The title page's tab strip called preventDefault on ArrowUp/ArrowDown,
//     which broke page scroll on a HORIZONTAL tablist. The strip is gone; the
//     same "do not swallow the arrow keys" rule is held for what replaced it.
//   - ContextMenu's Escape dismissed the menu AND navigated back off the title,
//     because App's handler guarded only on `paletteOpen`.

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContextMenu } from './ContextMenu'
import { Disclosure } from './detail/Disclosure'
import { EpisodeList } from './detail/EpisodeList'

describe('ContextMenu — APG menu contract', () => {
  const items = [
    { label: 'Play', onClick: vi.fn() },
    { label: 'Mark as Watched', onClick: vi.fn() },
    { label: 'Remove', onClick: vi.fn(), tone: 'danger' as const },
  ]
  const open = (props = {}) => render(
    <ContextMenu x={10} y={10} items={items} onClose={() => {}} title="Blade Runner" {...props} />,
  )

  // The mount effect focuses item 0 inside a requestAnimationFrame, so it has NOT
  // happened by the time render() returns. Asserting before it lands leaves focus
  // on <body>, the menu's onKeyDown never fires, and every keyboard test fails for
  // a reason that has nothing to do with the widget.
  const ready = async () => {
    const first = screen.getAllByRole('menuitem')[0]
    await waitFor(() => expect(first).toHaveFocus())
    return screen.getAllByRole('menuitem')
  }

  // Identity, not structural equality: `toEqual` on DOM nodes deep-compares and
  // reports "expected [button] to deeply equal [button]" when two DIFFERENT
  // buttons happen to have the same shape.
  const tabStops = (list: HTMLElement[]) => list.filter(m => m.getAttribute('tabindex') === '0')

  it('names the menu after the title it acts on', () => {
    open()
    // Every item label is a bare verb and the menu opens from a grid of dozens of
    // cards, so "Mark as Watched" alone leaves out the only thing the user lacks.
    expect(screen.getByRole('menu')).toHaveAccessibleName('Actions for Blade Runner')
  })

  it('exposes exactly one tab stop, and it MOVES with the arrows', async () => {
    const user = userEvent.setup()
    open()
    const menuitems = await ready()

    expect(tabStops(menuitems)).toHaveLength(1)
    expect(tabStops(menuitems)[0]).toBe(menuitems[0])
    await user.keyboard('{ArrowDown}')
    // The regression: built on a ref, `tabIndex` never re-rendered, so this
    // assertion is the whole point of the widget's "roving" claim.
    expect(tabStops(menuitems)).toHaveLength(1)
    expect(tabStops(menuitems)[0]).toBe(menuitems[1])
    expect(menuitems[1]).toHaveFocus()

    await user.keyboard('{ArrowUp}')
    expect(tabStops(menuitems)[0]).toBe(menuitems[0])
    expect(menuitems[0]).toHaveFocus()
  })

  it('wraps at both ends and honours Home/End', async () => {
    const user = userEvent.setup()
    open()
    const menuitems = await ready()
    await user.keyboard('{ArrowUp}')
    expect(menuitems[2]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(menuitems[0]).toHaveFocus()
    await user.keyboard('{End}')
    expect(menuitems[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(menuitems[0]).toHaveFocus()
  })

  it('closes on Escape WITHOUT letting it reach the window', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const windowSpy = vi.fn()
    open({ onClose })
    await ready()
    // Bound AFTER the menu mounts: its own window listener is installed on mount,
    // and this spy is only interested in what escapes the menu's onKeyDown.
    window.addEventListener('keydown', windowSpy)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
    // App's Escape handler guards only on `paletteOpen`, so an Escape that reached
    // the window fell through to `view === 'detail' && handleBack()` — dismissing
    // the menu AND navigating off the title. stopPropagation is the fix.
    const escapes = windowSpy.mock.calls.filter(c => (c[0] as KeyboardEvent).key === 'Escape')
    expect(escapes).toHaveLength(0)
    window.removeEventListener('keydown', windowSpy)
  })

  it('dismisses on Tab rather than walking into content behind it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    open({ onClose })
    await ready()
    await user.keyboard('{Tab}')
    expect(onClose).toHaveBeenCalled()
  })

  it('invokes the item and closes on activation', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onClick = vi.fn()
    render(
      <ContextMenu x={0} y={0} onClose={onClose} title="X"
        items={[{ label: 'Play', onClick }]} />,
    )
    await user.click(screen.getByRole('menuitem', { name: 'Play' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })
})

// The title page lost its tab strip: it is one column now, and what the tabs
// used to divide is on the page in order. The two hand-rolled keyboard
// widgets that remain on it are held to their own patterns here instead.

describe('Disclosure — APG disclosure contract', () => {
  const open = (defaultOpen = false) => render(
    <Disclosure title="Media info" summary="2 versions" defaultOpen={defaultOpen}>
      <p>Technical details</p>
    </Disclosure>,
  )
  const head = () => screen.getByRole('button', { name: /Media info/ })

  it('is one button that says whether its panel is open and points at it, open or closed', () => {
    open()
    expect(head()).toHaveAttribute('aria-expanded', 'false')
    // aria-controls must reference a real element even while closed.
    const panel = document.getElementById(head().getAttribute('aria-controls')!)!
    expect(panel).not.toBeNull()
    expect(panel).toHaveAttribute('hidden')
    expect(panel).toHaveTextContent('Technical details')
  })

  it('derives its starting state from the prop, not from a constant', () => {
    open(true)
    expect(head()).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(head().getAttribute('aria-controls')!)).not.toHaveAttribute('hidden')
  })

  it('toggles with Enter and with Space, and keeps focus on the button', async () => {
    const user = userEvent.setup()
    open()
    head().focus()
    await user.keyboard('{Enter}')
    expect(head()).toHaveAttribute('aria-expanded', 'true')
    expect(head()).toHaveFocus()
    await user.keyboard(' ')
    expect(head()).toHaveAttribute('aria-expanded', 'false')
    expect(head()).toHaveFocus()
  })

  it('leaves the arrow keys ALONE so the page can still scroll', async () => {
    const user = userEvent.setup()
    open()
    head().focus()
    // Assert the default is intact rather than that nothing visibly changed:
    // "nothing changed" would also pass if a handler swallowed the event.
    const prevented: boolean[] = []
    const probe = (e: KeyboardEvent) => { prevented.push(e.defaultPrevented) }
    window.addEventListener('keydown', probe)
    await user.keyboard('{ArrowDown}{ArrowUp}{ArrowLeft}{ArrowRight}')
    window.removeEventListener('keydown', probe)
    expect(prevented).toEqual([false, false, false, false])
    expect(head()).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('EpisodeList — the season switch', () => {
  const seasons = [{ season_number: 1 }, { season_number: 2 }, { season_number: 3 }]
  const open = (selected: number, onSelectSeason = vi.fn()) => {
    const r = render(
      <EpisodeList count={0} seasons={seasons} selectedSeason={selected} onSelectSeason={onSelectSeason} rows={[]} onPlay={vi.fn()} onUnavailable={vi.fn()} />,
    )
    return { ...r, onSelectSeason }
  }
  const chips = () => within(screen.getByRole('group', { name: 'Season' })).getAllByRole('button')

  it('marks exactly one season pressed, and derives it from the selection, not from position', () => {
    // Rendered on a season that is not the first: a chip row that hard-coded
    // "the first one is on" would pass every test that starts at season 1.
    open(2)
    expect(chips().map(c => c.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
  })

  it('follows the selection when it changes underneath it', () => {
    const { rerender } = open(1)
    rerender(<EpisodeList count={0} seasons={seasons} selectedSeason={3} onSelectSeason={vi.fn()} rows={[]} onPlay={vi.fn()} onUnavailable={vi.fn()} />)
    expect(chips().map(c => c.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
  })

  it('asks for the pressed season by NUMBER, from the chips and from the menu alike', async () => {
    const user = userEvent.setup()
    const { onSelectSeason } = open(1)
    await user.click(chips()[2])
    expect(onSelectSeason).toHaveBeenLastCalledWith(3)
    // The same choice as a menu, for a phone (CSS shows one of the two).
    const menu = screen.getByRole('combobox', { name: 'Season' })
    expect(menu).toHaveValue('1')
    await user.selectOptions(menu, '2')
    expect(onSelectSeason).toHaveBeenLastCalledWith(2)
  })

  it('every chip is an ordinary tab stop: no roving index to get stuck', () => {
    open(2)
    for (const c of chips()) expect(c).not.toHaveAttribute('tabindex')
  })

  it('offers no switch for a show with one season', () => {
    render(<EpisodeList count={0} seasons={[{ season_number: 1 }]} selectedSeason={1} rows={[]} onPlay={vi.fn()} onUnavailable={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'Season' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Season' })).toBeNull()
  })

  it('becomes a menu alone once a show has more seasons than fit as chips', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ season_number: i + 1 }))
    render(<EpisodeList count={0} seasons={many} selectedSeason={7} rows={[]} onPlay={vi.fn()} onUnavailable={vi.fn()} />)
    expect(screen.queryByRole('group', { name: 'Season' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Season' })).toHaveValue('7')
  })

  // The count used to be hidden from md up exactly when the menu replaced
  // the chips: a long-running show lost its "N episodes" line on a desktop.
  it('keeps the episode count on screen at every width when the seasons are a menu', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ season_number: i + 1 }))
    const row = { id: 1, number: 1, title: 'Pilot', still: '', hasFile: true, state: 'watched' as const }
    render(<EpisodeList count={1} seasons={many} selectedSeason={7} rows={[row]} onPlay={vi.fn()} onUnavailable={vi.fn()} />)
    const count = screen.getByText('1 episode · 1 watched')
    // No class that hides it at any breakpoint.
    expect(count.className.split(/\s+/).filter(c => /(^|:)hidden$/.test(c))).toEqual([])
  })

  it('calls season 0 what it is', () => {
    render(<EpisodeList count={0} seasons={[{ season_number: 0 }, { season_number: 1 }]} selectedSeason={1} rows={[]} onPlay={vi.fn()} onUnavailable={vi.fn()} />)
    expect(chips().map(c => c.textContent)).toEqual(['Specials', 'Season 1'])
    expect(within(screen.getByRole('combobox', { name: 'Season' })).getAllByRole('option').map(o => o.textContent)).toEqual(['Specials', 'Season 1'])
  })
})
