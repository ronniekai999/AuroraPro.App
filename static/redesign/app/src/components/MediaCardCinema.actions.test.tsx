// @vitest-environment jsdom
//
// What a card shows and does beyond its caption. A poster carries nothing on
// its art at rest; Play, Add and More sit in one actions layer (CSS reveals it
// under a pointer or focus, and keeps More up on a touch screen); More and a
// long press open the same menu a right click does, so nothing a card can do
// is reachable only by a right click. The menu is required (the type refuses
// a card without one), because Play and Add are out of the tab order and
// absent on a touch screen.
//
// The art is the button that opens the title, and the action buttons are its
// siblings: a button's descendants are pruned from the accessibility tree,
// and More is the route a screen reader and a phone take to everything else.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LONG_PRESS_MS, MediaCardCinema } from './MediaCardCinema'

const item = { id: 7, title: 'Kestrel', year: 2026, rating: 8.7, genre: 'Science Fiction', poster: '/p.jpg' }
/** The art: the control that opens the title and carries the card's name. */
const card = () => screen.getByRole('button', { name: /^Kestrel \(2026\)/ })
const menu = () => {}

afterEach(cleanup)

describe('what is on the poster', () => {
  it('paints nothing over the art but the actions layer: no badge, gem, chip, title or scrim text', () => {
    const { container } = render(
      <MediaCardCinema item={{ ...item, reason: 'Because you finished Small Hours', tags: ['4K', 'HDR', 'PG-13'] }} onSelect={() => {}} onCardContext={() => {}} onToggleLib={() => {}} libraryIds={new Set([7])} />,
    )
    const wrap = container.querySelector('.poster-wrap')!
    expect([...wrap.children].map(c => c.className.split(' ')[0])).toEqual(['card-open', 'card-actions'])
    // The art button holds the image and nothing else.
    expect([...wrap.querySelector('.card-open')!.children].map(c => c.className.split(' ')[0])).toEqual(['poster-img'])
    // None of the old on-art furniture, anywhere on the card.
    for (const gone of ['.lib-badge', '.ai-gem', '.reason-scrim', '.card-badges', '.card-badge', '.card-overlay', '.resume-pill', '.card-hover-preview']) {
      expect(container.querySelector(gone), gone).toBeNull()
    }
    // Quality and rating chips are not drawn on a card at all; they stay in
    // its accessible name.
    expect(wrap.textContent).toBe('')
    expect(container.textContent).not.toContain('4K')
    expect(card().getAttribute('aria-label')).toContain('4K, HDR, PG-13')
  })

  // progress is a FRACTION, 0..1 (lib/api.ts normalises the server's 0-100).
  // Read as a percentage it drew every bar a hundred times too short.
  it('adds a progress bar, and only that, when there is progress, as wide as the fraction watched', () => {
    const { container, rerender } = render(<MediaCardCinema item={{ ...item, progress: 0.4 }} onSelect={() => {}} onCardContext={menu} />)
    const wrap = container.querySelector('.poster-wrap')!
    expect([...wrap.children].map(c => c.className.split(' ')[0])).toEqual(['card-open', 'progress-bar', 'card-actions'])
    const width = () => (container.querySelector('.progress-fill') as HTMLElement).style.width
    expect(width()).toBe('40%')
    rerender(<MediaCardCinema item={{ ...item, progress: 0.6 }} onSelect={() => {}} onCardContext={menu} />)
    expect(width()).toBe('60%')
    rerender(<MediaCardCinema item={{ ...item, progress: 1 }} onSelect={() => {}} onCardContext={menu} />)
    expect(width()).toBe('100%')
    // Out of range is clamped, never drawn past the poster.
    rerender(<MediaCardCinema item={{ ...item, progress: 1.4 }} onSelect={() => {}} onCardContext={menu} />)
    expect(width()).toBe('100%')
    rerender(<MediaCardCinema item={{ ...item, progress: 0 }} onSelect={() => {}} onCardContext={menu} />)
    expect(container.querySelector('.progress-bar')).toBeNull()
  })

  it('says how far in the viewer is to assistive tech: a progressbar with its value, outside the art button', () => {
    render(<MediaCardCinema item={{ ...item, progress: 0.6 }} onSelect={() => {}} onCardContext={menu} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('60')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-label')).toContain('Kestrel')
    expect(card().contains(bar)).toBe(false)
  })

  it('puts the title and facts in a caption under the art, not on it', () => {
    const { container } = render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={menu} />)
    const caption = container.querySelector('.card-caption')!
    expect(container.querySelector('.poster-wrap')!.contains(caption)).toBe(false)
    expect(caption.querySelector('.cc-title')?.textContent).toBe('Kestrel')
    expect(caption.querySelector('.co-meta')?.textContent).toContain('2026')
  })

  it('says a title is saved with a tick in the caption and in its name, not with a badge on the art', () => {
    const { container, rerender } = render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={menu} libraryIds={new Set([7])} />)
    const saved = container.querySelector('.co-meta > .co-saved')
    expect(saved).not.toBeNull()
    // It leads the facts row, before the first token, and is not one of them.
    expect(container.querySelector('.co-meta')!.firstElementChild).toBe(saved)
    expect(container.querySelectorAll('.co-meta > .co-tok')).toHaveLength(3)
    expect(card().getAttribute('aria-label')).toContain('in My Library')
    rerender(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={menu} libraryIds={new Set()} />)
    expect(container.querySelector('.co-saved')).toBeNull()
    expect(card().getAttribute('aria-label')).not.toContain('in My Library')
  })

  // The reason is drawn: in the facts line's place under a pointer or
  // keyboard focus (CSS swaps the two rows on .has-reason). It was sr-only
  // for a release, and sighted viewers lost it altogether.
  it('draws a pick\'s reason in the caption, and describes the card with it', () => {
    const { container } = render(<MediaCardCinema item={{ ...item, reason: 'Because you finished Small Hours' }} onSelect={() => {}} onCardContext={menu} />)
    const id = card().getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    const el = container.querySelector(`[id="${id}"]`)!
    expect(el.textContent).toBe('Because you finished Small Hours')
    expect(el.className).toBe('co-reason')
    expect(el.className).not.toContain('sr-only')
    expect(container.querySelector('.card-caption')!.contains(el)).toBe(true)
    // The class the CSS swap hangs on, and only for a card with a reason.
    expect(container.querySelector('.media-card-cinema')!.classList.contains('has-reason')).toBe(true)
    cleanup()
    const plain = render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={menu} />)
    expect(plain.container.querySelector('.co-reason')).toBeNull()
    expect(plain.container.querySelector('.media-card-cinema')!.classList.contains('has-reason')).toBe(false)
  })
})

describe('Play, Add and More', () => {
  it('always has More, and offers Play and Add only when given handlers for them', () => {
    const { container, rerender } = render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={menu} />)
    expect([...container.querySelectorAll('.card-act')].map(b => b.getAttribute('aria-label'))).toEqual(['More actions for Kestrel'])
    rerender(<MediaCardCinema item={item} onSelect={() => {}} onPlay={() => {}} onToggleLib={() => {}} onCardContext={menu} />)
    expect([...container.querySelectorAll('.card-act')].map(b => b.getAttribute('aria-label'))).toEqual([
      'Play Kestrel', 'Add Kestrel to My Library', 'More actions for Kestrel',
    ])
  })

  // One handler: the caller's onPlay resumes when there is a position (the
  // menu's first row does the same). `resumable` only changes what the
  // button says.
  it('plays through the one handler, saying Resume when the caller will resume, without opening the title', () => {
    const onSelect = vi.fn()
    const onPlay = vi.fn()
    const { rerender } = render(<MediaCardCinema item={item} onSelect={onSelect} onPlay={onPlay} onCardContext={menu} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play Kestrel' }))
    expect(onPlay).toHaveBeenCalledWith(item)
    rerender(<MediaCardCinema item={item} onSelect={onSelect} onPlay={onPlay} resumable onCardContext={menu} />)
    expect(screen.queryByRole('button', { name: 'Play Kestrel' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Resume Kestrel' }))
    expect(onPlay).toHaveBeenCalledTimes(2)
    expect(onPlay).toHaveBeenLastCalledWith(item)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('adds to and removes from My Library without opening the title, and says which it will do', () => {
    const onSelect = vi.fn()
    const onToggleLib = vi.fn()
    const { rerender } = render(<MediaCardCinema item={item} onSelect={onSelect} onToggleLib={onToggleLib} onCardContext={menu} libraryIds={new Set()} />)
    const add = screen.getByRole('button', { name: 'Add Kestrel to My Library' })
    // The label says what a press does. No pressed state beside it: "Remove,
    // pressed" says the opposite of what it means.
    expect(add.hasAttribute('aria-pressed')).toBe(false)
    fireEvent.click(add)
    expect(onToggleLib).toHaveBeenCalledWith(item)
    rerender(<MediaCardCinema item={item} onSelect={onSelect} onToggleLib={onToggleLib} onCardContext={menu} libraryIds={new Set([7])} />)
    expect(screen.getByRole('button', { name: 'Remove Kestrel from My Library' }).hasAttribute('aria-pressed')).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('opens the menu from More with the click itself, so the menu can anchor to the button', () => {
    const onSelect = vi.fn()
    // currentTarget is only set while the event is being handled, which is
    // when the menu reads it.
    let anchor: EventTarget | null = null
    const onCardContext = vi.fn((e: { currentTarget: EventTarget | null }, _item: typeof item) => { anchor = e.currentTarget })
    render(<MediaCardCinema item={item} onSelect={onSelect} onCardContext={onCardContext} />)
    const more = screen.getByRole('button', { name: 'More actions for Kestrel' })
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    // Closed until the menu says otherwise (it sets this on its opener).
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(onCardContext).toHaveBeenCalledTimes(1)
    expect(onCardContext.mock.calls[0][1]).toBe(item)
    expect(anchor).toBe(more)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('still opens the same menu on a right click', () => {
    const onCardContext = vi.fn()
    render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={onCardContext} />)
    fireEvent.contextMenu(card())
    expect(onCardContext).toHaveBeenCalledTimes(1)
    expect(onCardContext.mock.calls[0][1]).toBe(item)
  })

  it('keeps More in the tab order and Play and Add out of it: two stops a card, and the menu holds the rest', () => {
    render(<MediaCardCinema item={item} onSelect={() => {}} onPlay={() => {}} onToggleLib={() => {}} onCardContext={() => {}} />)
    expect(card().tabIndex).toBe(0)
    expect(screen.getByRole('button', { name: 'More actions for Kestrel' }).tabIndex).toBe(0)
    expect(screen.getByRole('button', { name: 'Play Kestrel' }).tabIndex).toBe(-1)
    expect(screen.getByRole('button', { name: 'Add Kestrel to My Library' }).tabIndex).toBe(-1)
  })

  // A button's descendants are presentational: nested inside one, More was
  // the advertised route for a screen reader and may not have been in its
  // tree at all.
  it('makes the art a real button and its actions siblings of it, inside no other control', () => {
    const { container } = render(<MediaCardCinema item={{ ...item, progress: 0.5 }} onSelect={() => {}} onPlay={() => {}} onToggleLib={() => {}} onCardContext={() => {}} />)
    const root = container.querySelector('.media-card-cinema')!
    expect(card().tagName).toBe('BUTTON')
    expect(card().getAttribute('type')).toBe('button')
    // The card's root is not a control: no role, not in the tab order.
    expect(root.hasAttribute('role')).toBe(false)
    expect(root.hasAttribute('tabindex')).toBe(false)
    for (const el of [...container.querySelectorAll('.card-act'), screen.getByRole('progressbar')]) {
      expect(el.parentElement!.closest('button, [role="button"], a[href]'), el.getAttribute('aria-label') ?? '').toBeNull()
    }
    // The caption repeats the art button's name for sighted users only.
    expect(container.querySelector('.card-caption')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('opens the title once on a click on the art, on Enter or Space on it, and on a click on the caption', async () => {
    const onSelect = vi.fn()
    const { container } = render(<MediaCardCinema item={item} onSelect={onSelect} onCardContext={() => {}} />)
    const user = userEvent.setup()
    await user.click(card())
    expect(onSelect).toHaveBeenCalledTimes(1)
    card().focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledTimes(2)
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenCalledTimes(3)
    await user.click(container.querySelector('.cc-title')!)
    expect(onSelect).toHaveBeenCalledTimes(4)
    expect(onSelect).toHaveBeenLastCalledWith(item)
    // A key on a button inside the card is that button's.
    screen.getByRole('button', { name: 'More actions for Kestrel' }).focus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledTimes(4)
  })
})

describe('a long press on a touch screen', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const down = (el: Element, over: Partial<PointerEventInit> = {}) =>
    fireEvent.pointerDown(el, { pointerType: 'touch', clientX: 100, clientY: 200, ...over })

  it('opens the menu at the finger, and the lift that follows does not also open the title', () => {
    const onSelect = vi.fn()
    const onCardContext = vi.fn()
    render(<MediaCardCinema item={item} onSelect={onSelect} onCardContext={onCardContext} />)
    down(card())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 1) })
    expect(onCardContext).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onCardContext).toHaveBeenCalledTimes(1)
    const [event, passed] = onCardContext.mock.calls[0]
    expect(passed).toBe(item)
    expect([event.clientX, event.clientY]).toEqual([100, 200])
    expect(typeof event.preventDefault).toBe('function')
    // The finger lifts: a click follows, and it is swallowed, once.
    fireEvent.pointerUp(card())
    fireEvent.click(card())
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(card())
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('is a tap, not a press, when the finger lifts first: the title opens and no menu does', () => {
    const onSelect = vi.fn()
    const onCardContext = vi.fn()
    render(<MediaCardCinema item={item} onSelect={onSelect} onCardContext={onCardContext} />)
    down(card())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 50) })
    fireEvent.pointerUp(card())
    fireEvent.click(card())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(onCardContext).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('is a scroll, not a press, when the finger moves: nothing opens', () => {
    const onCardContext = vi.fn()
    render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={onCardContext} />)
    down(card())
    fireEvent.pointerMove(card(), { pointerType: 'touch', clientX: 100, clientY: 230 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    expect(onCardContext).not.toHaveBeenCalled()
  })

  it('tolerates a finger that only trembles', () => {
    const onCardContext = vi.fn()
    render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={onCardContext} />)
    down(card())
    fireEvent.pointerMove(card(), { pointerType: 'touch', clientX: 103, clientY: 204 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(onCardContext).toHaveBeenCalledTimes(1)
  })

  it('is cancelled when the browser takes the gesture (a scroll starting, the pointer leaving)', () => {
    const onCardContext = vi.fn()
    render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={onCardContext} />)
    down(card())
    fireEvent.pointerCancel(card())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    down(card())
    fireEvent.pointerLeave(card())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    expect(onCardContext).not.toHaveBeenCalled()
  })

  it('does not fire for a mouse held down, which has its own right click', () => {
    const onCardContext = vi.fn()
    render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={onCardContext} />)
    fireEvent.pointerDown(card(), { pointerType: 'mouse', clientX: 10, clientY: 10 })
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    expect(onCardContext).not.toHaveBeenCalled()
  })

  it('does not fire for a press that starts on one of the card\'s own buttons', () => {
    const onCardContext = vi.fn()
    render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={onCardContext} />)
    down(screen.getByRole('button', { name: 'More actions for Kestrel' }))
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    expect(onCardContext).not.toHaveBeenCalled()
  })

  it('does not open the menu twice when the platform also sends a contextmenu for the press', () => {
    // Android fires contextmenu for a long press before our timer would.
    const onCardContext = vi.fn()
    render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={onCardContext} />)
    down(card())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 100) })
    fireEvent.contextMenu(card())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(onCardContext).toHaveBeenCalledTimes(1)
  })

  // A card replaced within the half second (a live recompose, "Not
  // interested", a profile switch) must not open a menu for the item it
  // used to hold, nor may one that has gone.
  it('is dropped when the card is given another item, or unmounts, mid-press', () => {
    const onCardContext = vi.fn()
    const other = { ...item, id: 8, title: 'Glass Harbor' }
    const { rerender, unmount } = render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={onCardContext} />)
    down(card())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 100) })
    rerender(<MediaCardCinema item={other} onSelect={() => {}} onCardContext={onCardContext} />)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(onCardContext).not.toHaveBeenCalled()
    down(screen.getByRole('button', { name: /^Glass Harbor/ }))
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 100) })
    unmount()
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(onCardContext).not.toHaveBeenCalled()
  })

  it('starts on the art, which is a button, as well as on the caption', () => {
    const onCardContext = vi.fn()
    const { container } = render(<MediaCardCinema item={item} onSelect={() => {}} onCardContext={onCardContext} />)
    down(container.querySelector('.poster-img')!)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(onCardContext).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(card())
    down(container.querySelector('.cc-title')!)
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS) })
    expect(onCardContext).toHaveBeenCalledTimes(2)
  })
})
