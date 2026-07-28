// @vitest-environment jsdom
//
// Phase 11.1 — the other three hand-rolled keyboard widgets from Phases 9 and 10.
//
// Every bug asserted here actually happened and was found by a human reading the
// diff, which is the cost this file exists to remove:
//
//   - The roving tabIndex DID NOT ROVE. Both widgets rendered `tabIndex` off a
//     ref, and writing a ref does not re-render, so the tab stop never moved.
//   - DetailTabs called preventDefault on ArrowUp/ArrowDown, which broke page
//     scroll on a HORIZONTAL tablist.
//   - ContextMenu's Escape dismissed the menu AND navigated back off the title,
//     because App's handler guarded only on `paletteOpen`.

import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ContextMenu } from './ContextMenu'
import { DetailTabs } from './detail/DetailTabs'

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

describe('DetailTabs — APG tabs contract', () => {
  const tabs = [
    { id: 'episodes', label: 'Episodes' },
    { id: 'cast', label: 'Cast' },
    { id: 'files', label: 'Files' },
  ]
  const open = (active = 'episodes', onChange = vi.fn()) => {
    const r = render(<DetailTabs tabs={tabs} active={active} onChange={onChange} />)
    return { ...r, onChange }
  }

  it('marks exactly one tab selected and points every tab at the panel', () => {
    open()
    const list = screen.getAllByRole('tab')
    expect(list.filter(t => t.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    // "Every tab has the property aria-controls referring to its associated
    // tabpanel" — every tab, not just the selected one.
    for (const t of list) expect(t).toHaveAttribute('aria-controls', 'detail-panel')
  })

  it('roves the tab stop with Left/Right and activates automatically', async () => {
    const user = userEvent.setup()
    const { onChange } = open()
    const list = screen.getAllByRole('tab')
    list[0].focus()

    await user.keyboard('{ArrowRight}')
    expect(list[1]).toHaveFocus()
    const stops = list.filter(t => t.getAttribute('tabindex') === '0')
    expect(stops).toHaveLength(1)
    expect(stops[0]).toBe(list[1])
    // Automatic activation: the criterion is latency, and these panels are
    // already-loaded local state.
    expect(onChange).toHaveBeenCalledWith('cast')

    await user.keyboard('{ArrowLeft}')
    expect(list[0]).toHaveFocus()
  })

  it('wraps horizontally and honours Home/End', async () => {
    const user = userEvent.setup()
    open()
    const list = screen.getAllByRole('tab')
    list[0].focus()
    await user.keyboard('{ArrowLeft}')
    expect(list[2]).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(list[0]).toHaveFocus()
    await user.keyboard('{End}')
    expect(list[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(list[0]).toHaveFocus()
  })

  it('leaves ArrowUp/ArrowDown ALONE so the page can still scroll', async () => {
    const user = userEvent.setup()
    open()
    const list = screen.getAllByRole('tab')
    list[0].focus()

    // This is a horizontal tablist. APG maps Up/Down for VERTICAL ones only, and
    // an earlier version called preventDefault on them — which on a horizontal
    // strip does nothing useful and stops the page scrolling while a tab has
    // focus. Assert the default is intact rather than that focus stayed put:
    // "focus did not move" would also pass if the handler swallowed the event.
    let defaultPrevented: boolean | null = null
    const probe = (e: KeyboardEvent) => { defaultPrevented = e.defaultPrevented }
    window.addEventListener('keydown', probe)
    await user.keyboard('{ArrowDown}')
    window.removeEventListener('keydown', probe)

    expect(defaultPrevented).toBe(false)
    expect(list[0]).toHaveFocus()
  })
})
