// @vitest-environment jsdom
//
// The search page's keyboard: one field, the results as buttons, the arrows
// between them. (It took the place of a palette that was a combobox with a
// listbox and an active descendant; here the focus moves for real.)

import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusResult, onResultsKeyDown, searchField } from './searchKeys'

/** A bar field, a page field, and results in the order the page draws them:
 *  the best match (with Play and More beside it), two cards, a collection. */
function page({ bar = true, own = true } = {}) {
  document.body.innerHTML = `
    ${bar ? '<header><div class="stage-navsearch"><input aria-label="Search titles"></div></header>' : ''}
    <div data-search-results>
      ${own ? '<form role="search"><input aria-label="Search titles"></form>' : ''}
      <div class="search-main">
        <button class="genre-chip">Movies</button>
        <div class="search-best"><button class="search-best-open">Best</button><div class="search-best-acts"><button id="play">Play</button><button class="search-best-more">More</button></div></div>
        <div><button class="card-open">Card one</button><button class="card-act">Add</button></div>
        <div><button class="card-open">Card two</button></div>
        <button class="search-colrow">A collection</button>
      </div>
      <aside><button class="search-action-row">Request a title</button></aside>
    </div>`
}
const text = () => (document.activeElement as HTMLElement | null)?.textContent ?? null
const key = (target: Element, k: string, mods: Partial<KeyboardEvent> = {}) => {
  const e = { key: k, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn(), ...mods }
  onResultsKeyDown(e)
  return e
}
afterEach(() => { document.body.innerHTML = '' })

describe('moving the focus through the results', () => {
  it('goes to the first and the last, and from one to the next in the order they are drawn', () => {
    page()
    expect(focusResult('first')).toBe(true)
    expect(text()).toBe('Best')
    for (const next of ['Card one', 'Card two', 'A collection']) {
      expect(focusResult('next', document.activeElement)).toBe(true)
      expect(text()).toBe(next)
    }
    // Past the last there is nowhere to go, and the focus stays.
    expect(focusResult('next', document.activeElement)).toBe(false)
    expect(text()).toBe('A collection')
    expect(focusResult('prev', document.activeElement)).toBe(true)
    expect(text()).toBe('Card two')
    focusResult('last')
    expect(text()).toBe('A collection')
  })

  it('skips what is not a result: a filter, Play, More, a card\'s own actions, the second column', () => {
    page()
    focusResult('first')
    const seen: (string | null)[] = [text()]
    while (focusResult('next', document.activeElement)) seen.push(text())
    expect(seen).toEqual(['Best', 'Card one', 'Card two', 'A collection'])
  })

  it('goes back to the search field from the first result', () => {
    page()
    focusResult('first')
    expect(focusResult('prev', document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('.stage-navsearch input'))
  })

  it('says it moved nowhere when there are no results', () => {
    document.body.innerHTML = '<div data-search-results><div class="search-main"></div></div>'
    expect(focusResult('first')).toBe(false)
    expect(focusResult('last')).toBe(false)
  })

  it('starts from the first when asked for the next from somewhere that is not a result', () => {
    page()
    expect(focusResult('next', document.querySelector('.genre-chip'))).toBe(true)
    expect(text()).toBe('Best')
  })
})

describe('the search field that is drawn', () => {
  // A box is what "drawn" means; this DOM lays nothing out, so a box is given.
  const drawn = (sel: string, yes: boolean) => {
    const el = document.querySelector<HTMLElement>(sel)!
    el.getClientRects = () => (yes ? [{}] : []) as unknown as DOMRectList
  }

  it('is the top bar\'s where the bar has one, and the page\'s own where it does not', () => {
    page()
    drawn('.stage-navsearch input', true); drawn('form[role="search"] input', false)
    expect(searchField()).toBe(document.querySelector('.stage-navsearch input'))
    drawn('.stage-navsearch input', false); drawn('form[role="search"] input', true)
    expect(searchField()).toBe(document.querySelector('form[role="search"] input'))
    // Both at once (a width where the two breakpoints disagree): the bar's,
    // which is the one Ctrl or Cmd K and Escape are wired to.
    drawn('.stage-navsearch input', true)
    expect(searchField()).toBe(document.querySelector('.stage-navsearch input'))
  })

  it('is the bar\'s when nothing is laid out, the page\'s when that is all there is, and none when there is none', () => {
    page()
    expect(searchField()).toBe(document.querySelector('.stage-navsearch input'))
    page({ bar: false })
    expect(searchField()).toBe(document.querySelector('form[role="search"] input'))
    page({ bar: false, own: false })
    expect(searchField()).toBeNull()
  })
})

describe('a key pressed on a result', () => {
  it('moves with the arrows, Home and End, and keeps the key from the page', () => {
    page()
    focusResult('first')
    const steps: [string, string][] = [['ArrowDown', 'Card one'], ['ArrowRight', 'Card two'], ['ArrowUp', 'Card one'], ['ArrowLeft', 'Best'], ['End', 'A collection'], ['Home', 'Best']]
    for (const [k, lands] of steps) {
      const e = key(document.activeElement!, k)
      expect(text()).toBe(lands)
      expect(e.preventDefault).toHaveBeenCalledTimes(1)
    }
    // Up from the first: the field.
    key(document.activeElement!, 'ArrowUp')
    expect(document.activeElement).toBe(document.querySelector('.stage-navsearch input'))
  })

  it('keeps Down on the last result from scrolling the page away from it', () => {
    page()
    focusResult('last')
    const e = key(document.activeElement!, 'ArrowDown')
    expect(text()).toBe('A collection')
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('leaves every other key alone, and an arrow with a modifier', () => {
    page()
    focusResult('first')
    for (const e of [key(document.activeElement!, 'Enter'), key(document.activeElement!, 'a'), key(document.activeElement!, ' '),
      key(document.activeElement!, 'ArrowDown', { shiftKey: true }), key(document.activeElement!, 'ArrowDown', { altKey: true }),
      key(document.activeElement!, 'ArrowDown', { ctrlKey: true }), key(document.activeElement!, 'ArrowDown', { metaKey: true })]) {
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(text()).toBe('Best')
  })

  it('is that control\'s own when it is not a result: a text field, Play, a filter', () => {
    page()
    for (const sel of ['form[role="search"] input', '#play', '.genre-chip', '.search-best-more']) {
      const el = document.querySelector<HTMLElement>(sel)!
      el.focus()
      const e = key(el, 'ArrowDown')
      expect(e.preventDefault).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(el)
    }
  })
})
