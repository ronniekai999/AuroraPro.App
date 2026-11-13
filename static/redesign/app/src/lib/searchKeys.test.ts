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

// Down and Up go by where the results are on the page. This DOM lays
// nothing out, so each result is given the box it would have: a best match
// across the page, cards four to a row with a short last row, two
// collections side by side.
describe('moving down and up, by where the results are', () => {
  const box = (el: Element, left: number, top: number, width: number, height: number) => {
    (el as HTMLElement).getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect
  }
  /** best / c1 c2 c3 c4 / c5 c6 / k1 k2 */
  function laidOut() {
    document.body.innerHTML = `
      <header><div class="stage-navsearch"><input aria-label="Search titles"></div></header>
      <div data-search-results><div class="search-main">
        <button class="search-best-open">best</button>
        ${[1, 2, 3, 4, 5, 6].map(n => `<div><button class="card-open">c${n}</button><button class="card-act">Add</button></div>`).join('')}
        <button class="search-colrow">k1</button><button class="search-colrow">k2</button>
      </div></div>`
    const by = (name: string) => [...document.querySelectorAll('button')].find(b => b.textContent === name)!
    box(by('best'), 0, 100, 1000, 176)
    ;[0, 150, 300, 450].forEach((left, i) => box(by(`c${i + 1}`), left, i === 1 ? 401 : 400, 130, 195))
    box(by('c5'), 0, 660, 130, 195); box(by('c6'), 150, 660, 130, 195)
    box(by('k1'), 0, 950, 480, 72); box(by('k2'), 500, 950, 480, 72)
    return by
  }
  const down = (by: (n: string) => HTMLElement, from: string) => { by(from).focus(); return focusResult('down', by(from)) ? text() : null }
  const up = (by: (n: string) => HTMLElement, from: string) => { by(from).focus(); return focusResult('up', by(from)) ? text() : null }

  it('goes down to the result below, not to the next one along', () => {
    const by = laidOut()
    expect(down(by, 'c1')).toBe('c5')
    expect(down(by, 'c2')).toBe('c6')
    // From a row across the page, to the first of the row under it.
    expect(down(by, 'best')).toBe('c1')
  })

  it('goes to the nearest result in a row that does not reach the column', () => {
    const by = laidOut()
    expect(down(by, 'c3')).toBe('c6')
    expect(down(by, 'c4')).toBe('c6')
    expect(up(by, 'k2')).toBe('c6')
  })

  it('leads from the last row of the cards on to the collections, and stops below the last row', () => {
    const by = laidOut()
    expect(down(by, 'c5')).toBe('k1')
    expect(down(by, 'c6')).toBe('k1')
    expect(down(by, 'k1')).toBeNull()
    expect(down(by, 'k2')).toBeNull()
    expect(text()).toBe('k2')
  })

  it('goes up to the result above, and from the top row to the search field', () => {
    const by = laidOut()
    expect(up(by, 'c5')).toBe('c1')
    expect(up(by, 'c6')).toBe('c2')
    expect(up(by, 'k1')).toBe('c5')
    expect(up(by, 'c3')).toBe('best')
    by('best').focus()
    expect(focusResult('up', by('best'))).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('.stage-navsearch input'))
  })

  it('takes the earlier of two results equally near', () => {
    const by = laidOut()
    // Half way between the two cards of the row above.
    box(by('k1'), 75, 950, 300, 72)
    expect(up(by, 'k1')).toBe('c5')
  })

  it('keeps Left and Right to the order the results are drawn in, across the end of a row', () => {
    const by = laidOut()
    by('c4').focus()
    key(by('c4'), 'ArrowRight')
    expect(text()).toBe('c5')
    key(by('c5'), 'ArrowLeft')
    expect(text()).toBe('c4')
    // And the keys themselves: Down and Up are the moves above.
    key(by('c4'), 'ArrowDown')
    expect(text()).toBe('c6')
    key(by('c6'), 'ArrowUp')
    expect(text()).toBe('c2')
  })

  it('passes over a result that has no box, and falls back to drawn order where nothing has one', () => {
    const by = laidOut()
    // c5 is not drawn (a row scrolled out of a clipped list, say): c1's Down has only c6 in that row.
    box(by('c5'), 0, 0, 0, 0)
    expect(down(by, 'c1')).toBe('c6')
    // Nor is it "above" the top row for having no top of its own: Up from there is still the field.
    by('best').focus()
    expect(focusResult('up', by('best'))).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('.stage-navsearch input'))
    // No layout at all: the order they are drawn in.
    for (const b of document.querySelectorAll('.search-main button')) box(b, 0, 0, 0, 0)
    expect(down(by, 'c1')).toBe('c2')
    expect(up(by, 'c2')).toBe('c1')
    expect(up(by, 'best')).toBe('')
    expect(document.activeElement).toBe(document.querySelector('.stage-navsearch input'))
  })

  it('starts from the first result when asked to go down from somewhere that is not one', () => {
    laidOut()
    expect(focusResult('down', document.querySelector('.card-act'))).toBe(true)
    expect(text()).toBe('best')
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
  // (No layout here: Down and Up go by drawn order, as Right and Left do.)
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
