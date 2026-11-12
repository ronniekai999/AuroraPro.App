import { describe, expect, it } from 'vitest'
import { JUMP_LETTERS, fitsInPages, jumpLetter, letterIndex } from './letterJump'

const t = (title: string, sortTitle?: string) => ({ title, sortTitle })

describe('the letter a title is filed under', () => {
  it('is the first letter of what the server sorted it by', () => {
    expect(jumpLetter(t('Zodiac', 'Fincher 03'))).toBe('F')
    expect(jumpLetter(t('The Matrix', 'Matrix'))).toBe('M')
  })

  // Search results and saved snapshots carry no sort title.
  it('drops a leading article as the server does when there is no sort title', () => {
    expect(jumpLetter(t('The Matrix'))).toBe('M')
    expect(jumpLetter(t('A Field Guide to Falling'))).toBe('F')
    expect(jumpLetter(t('An Education'))).toBe('E')
    expect(jumpLetter(t('the lower case'))).toBe('L')
    // Not an article: a word that only starts like one.
    expect(jumpLetter(t('Theory of Everything'))).toBe('T')
    expect(jumpLetter(t('Anomalisa'))).toBe('A')
    expect(jumpLetter(t('A'))).toBe('A')
  })

  it('reads a small letter and an accented one as the letter', () => {
    expect(jumpLetter(t('eXistenZ'))).toBe('E')
    expect(jumpLetter(t('Élite'))).toBe('E')
    expect(jumpLetter(t('Ödipussi'))).toBe('O')
  })

  it('files digits, symbols, other scripts and nothing at all under #', () => {
    expect(jumpLetter(t('2001: A Space Odyssey'))).toBe('#')
    expect(jumpLetter(t("'71"))).toBe('#')
    expect(jumpLetter(t('(500) Days of Summer'))).toBe('#')
    expect(jumpLetter(t('東京物語'))).toBe('#')
    expect(jumpLetter(t('Æon Flux'))).toBe('#')
    expect(jumpLetter(t(''))).toBe('#')
    expect(jumpLetter(t('   '))).toBe('#')
  })

  it('offers # and then A to Z', () => {
    expect(JUMP_LETTERS.join('')).toBe('#ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  })
})

describe('what the loaded pages say about each letter', () => {
  const page = [t('12 Angry Men'), t('Alien'), t('Arrival'), t('Brazil'), t('Dune')]

  it('finds where each loaded letter starts', () => {
    const { first, states } = letterIndex(page, false)
    expect(first).toEqual({ '#': 0, A: 1, B: 3, D: 4 })
    expect([states['#'], states.A, states.B, states.D]).toEqual(['here', 'here', 'here', 'here'])
  })

  // Nothing is read into the order: until the whole list is loaded, a
  // letter with no title yet may be on a page still to come, wherever the
  // list has got to.
  it('leaves every letter not seen yet open while pages are still to come', () => {
    const { states } = letterIndex(page, false)
    expect(states.C).toBe('further')
    expect(states.E).toBe('further')
    expect(states.Z).toBe('further')
    expect(letterIndex([t('Alien'), t('Brazil')], false).states['#']).toBe('further')
  })

  it('knows every letter exactly once the whole list is loaded', () => {
    const { states } = letterIndex(page, true)
    expect(JUMP_LETTERS.filter(l => states[l] === 'further')).toEqual([])
    expect(JUMP_LETTERS.filter(l => states[l] === 'here')).toEqual(['#', 'A', 'B', 'D'])
    expect(states.C).toBe('none')
    expect(states.E).toBe('none')
  })

  // The server sorts under the database's collation. One order files small
  // letters after Z, another ignores a leading apostrophe, and a ligature
  // sorts among the A's while filing under '#'. A jump lands on the first
  // title in the list AS IT IS that files under the letter, so it always
  // lands on a real title.
  it('takes a letter\'s start from the list as it is, in an order nobody would predict', () => {
    const list = [t("'71"), t('Æon Flux'), t('Alien'), t('Eraserhead'), t('Zodiac'), t('eXistenZ'), t('iCarly'), t('Élite'), t('[REC]')]
    const { first, states } = letterIndex(list, true)
    expect(first).toEqual({ '#': 0, A: 2, E: 3, Z: 4, I: 6 })
    expect(JUMP_LETTERS.filter(l => states[l] === 'here')).toEqual(['#', 'A', 'E', 'I', 'Z'])
    // Every letter that is on points at a title that files under it.
    for (const [letter, at] of Object.entries(first)) expect(jumpLetter(list[at])).toBe(letter)
  })

  it('says everything is still to come for an empty first page, and nothing is for an empty list', () => {
    expect(JUMP_LETTERS.every(l => letterIndex([], false).states[l] === 'further')).toBe(true)
    expect(JUMP_LETTERS.every(l => letterIndex([], true).states[l] === 'none')).toBe(true)
  })
})

describe('the lists the strip is drawn for', () => {
  it('are those that can be loaded whole within the pages a grid keeps live', () => {
    expect(fitsInPages(500, 100, 5)).toBe(true)
    expect(fitsInPages(501, 100, 5)).toBe(false)
    expect(fitsInPages(0, 100, 5)).toBe(true)
    expect(fitsInPages(1284, 100, 5)).toBe(false)
  })

  it('are not ones whose size is not known', () => {
    expect(fitsInPages(null, 100, 5)).toBe(false)
    expect(fitsInPages(undefined, 100, 5)).toBe(false)
  })
})
