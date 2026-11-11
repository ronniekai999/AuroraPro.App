// @vitest-environment jsdom
//
// What a card shows and does beyond its caption. A poster carries nothing on
// its art at rest; Play, Add and More sit in one actions layer (CSS reveals it
// under a pointer or focus, and keeps More up on a touch screen); More and a
// long press open the same menu a right click does, so nothing a card can do
// is reachable only by a right click.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LONG_PRESS_MS, MediaCardCinema } from './MediaCardCinema'

const item = { id: 7, title: 'Kestrel', year: 2026, rating: 8.7, genre: 'Science Fiction', poster: '/p.jpg' }
const card = () => screen.getByRole('button', { name: /^Kestrel \(2026\)/ })

afterEach(cleanup)

describe('what is on the poster', () => {
  it('paints nothing over the art but the actions layer: no badge, gem, chip, title or scrim text', () => {
    const { container } = render(
      <MediaCardCinema item={{ ...item, reason: 'Because you finished Small Hours', tags: ['4K', 'HDR', 'PG-13'] }} onSelect={() => {}} onCardContext={() => {}} onToggleLib={() => {}} libraryIds={new Set([7])} />,
    )
    const wrap = container.querySelector('.poster-wrap')!
    expect([...wrap.children].map(c => c.className.split(' ')[0])).toEqual(['poster-img', 'card-actions'])
    // None of the old on-art furniture, anywhere on the card.
    for (const gone of ['.lib-badge', '.ai-gem', '.reason-scrim', '.card-badges', '.card-badge', '.card-overlay', '.resume-pill', '.card-hover-preview']) {
      expect(container.querySelector(gone), gone).toBeNull()
    }
    // Quality and rating chips are not drawn on a card at all.
    expect(wrap.textContent).toBe('')
    expect(container.textContent).not.toContain('4K')
  })

  it('adds a progress bar, and only that, when there is progress', () => {
    const { container } = render(<MediaCardCinema item={{ ...item, progress: 40 }} onSelect={() => {}} />)
    const wrap = container.querySelector('.poster-wrap')!
    expect([...wrap.children].map(c => c.className.split(' ')[0])).toEqual(['poster-img', 'progress-bar'])
    expect((container.querySelector('.progress-fill') as HTMLElement).style.width).toBe('40%')
  })

  it('puts the title and facts in a caption under the art, not on it', () => {
    const { container } = render(<MediaCardCinema item={item} onSelect={() => {}} />)
    const caption = container.querySelector('.card-caption')!
    expect(container.querySelector('.poster-wrap')!.contains(caption)).toBe(false)
    expect(caption.querySelector('.cc-title')?.textContent).toBe('Kestrel')
    expect(caption.querySelector('.co-meta')?.textContent).toContain('2026')
  })

  it('says a title is saved with a tick in the caption and in its name, not with a badge on the art', () => {
    const { container, rerender } = render(<MediaCardCinema item={item} onSelect={() => {}} libraryIds={new Set([7])} />)
    const saved = container.querySelector('.co-meta > .co-saved')
    expect(saved).not.toBeNull()
    // It leads the facts row, before the first token, and is not one of them.
    expect(container.querySelector('.co-meta')!.firstElementChild).toBe(saved)
    expect(container.querySelectorAll('.co-meta > .co-tok')).toHaveLength(3)
    expect(card().getAttribute('aria-label')).toContain('in My Library')
    rerender(<MediaCardCinema item={item} onSelect={() => {}} libraryIds={new Set()} />)
    expect(container.querySelector('.co-saved')).toBeNull()
    expect(card().getAttribute('aria-label')).not.toContain('in My Library')
  })

  it('keeps a pick\'s reason for assistive tech without drawing it', () => {
    const { container } = render(<MediaCardCinema item={{ ...item, reason: 'Because you finished Small Hours' }} onSelect={() => {}} />)
    const id = card().getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    const el = container.querySelector(`[id="${id}"]`)!
    expect(el.textContent).toBe('Because you finished Small Hours')
    expect(el.className).toContain('sr-only')
  })
})

describe('Play, Add and More', () => {
  it('offers only the actions it was given handlers for', () => {
    const { container, rerender } = render(<MediaCardCinema item={item} onSelect={() => {}} />)
    expect(container.querySelector('.card-actions')).toBeNull()
    rerender(<MediaCardCinema item={item} onSelect={() => {}} onPlay={() => {}} onToggleLib={() => {}} onCardContext={() => {}} />)
    expect([...container.querySelectorAll('.card-act')].map(b => b.getAttribute('aria-label'))).toEqual([
      'Play Kestrel', 'Add Kestrel to My Library', 'More actions for Kestrel',
    ])
  })

  it('plays, or resumes when there is somewhere to resume from, without opening the title', () => {
    const onSelect = vi.fn()
    const onPlay = vi.fn()
    const onResume = vi.fn()
    const { rerender } = render(<MediaCardCinema item={item} onSelect={onSelect} onPlay={onPlay} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play Kestrel' }))
    expect(onPlay).toHaveBeenCalledWith(item)
    rerender(<MediaCardCinema item={item} onSelect={onSelect} onPlay={onPlay} onResume={onResume} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resume Kestrel' }))
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onPlay).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('adds to and removes from My Library without opening the title, and says which it will do', () => {
    const onSelect = vi.fn()
    const onToggleLib = vi.fn()
    const { rerender } = render(<MediaCardCinema item={item} onSelect={onSelect} onToggleLib={onToggleLib} libraryIds={new Set()} />)
    const add = screen.getByRole('button', { name: 'Add Kestrel to My Library' })
    expect(add.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(add)
    expect(onToggleLib).toHaveBeenCalledWith(item)
    rerender(<MediaCardCinema item={item} onSelect={onSelect} onToggleLib={onToggleLib} libraryIds={new Set([7])} />)
    expect(screen.getByRole('button', { name: 'Remove Kestrel from My Library' }).getAttribute('aria-pressed')).toBe('true')
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

  it('opens the title on a click, Enter or Space on the card itself, and not from a key pressed on a button inside it', () => {
    const onSelect = vi.fn()
    render(<MediaCardCinema item={item} onSelect={onSelect} onCardContext={() => {}} />)
    fireEvent.click(card())
    fireEvent.keyDown(card(), { key: 'Enter' })
    fireEvent.keyDown(card(), { key: ' ' })
    expect(onSelect).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for Kestrel' }), { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(3)
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

  it('needs a menu to open: a card with none ignores the press', () => {
    const onSelect = vi.fn()
    render(<MediaCardCinema item={item} onSelect={onSelect} />)
    down(card())
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2) })
    fireEvent.click(card())
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
