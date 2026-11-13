// The A to Z strip over a Library grid sorted by title: which letter a title
// is filed under, and what is known about each letter from the part of the
// list that has been loaded.
//
// The server has no "titles from M" request, and every page it serves is a
// pass over the whole library. So the strip is drawn only for a list short
// enough to be loaded whole in the pages a grid keeps live
// (CATALOG_REFRESH_MAX_PAGES; App decides), works from the pages the grid
// holds, and asks for the rest only when a letter not yet seen is chosen
// (hooks/useLetterJump).
//
// Nothing here assumes the ORDER the server lists titles in. It sorts by
// `sort_title` under the database's collation, which follows the machine's
// locale: one puts "iCarly" after Z, another files "'71" among the sevens,
// and "Æon Flux" sorts with the A's while filing under '#'. A letter is on
// when a loaded title files under it, and a jump goes to the first such
// title in the list as it is; until the whole list is loaded, a letter not
// seen may still be further on.

/** The strip's entries, in order. '#' is everything that is not A to Z. */
export const JUMP_LETTERS: readonly string[] = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']

export interface Filed { title: string; sortTitle?: string }

/** What the server sorts a title by when it stores none: the title without a
 *  leading "The", "A" or "An" (internal/library's GenerateSortTitle). */
function withoutArticle(title: string): string {
  const m = /^(the|an|a) /i.exec(title)
  return m ? title.slice(m[0].length).trim() : title
}

/** The letter a title is filed under: the first character of what the server
 *  sorted it by, without its accent and in capitals; '#' for a digit, a
 *  symbol or another script. */
export function jumpLetter(m: Filed): string {
  const sorted = m.sortTitle || withoutArticle(m.title)
  const first = [...sorted][0] ?? ''
  const plain = first.normalize('NFD').charAt(0).toUpperCase()
  return plain >= 'A' && plain <= 'Z' && plain.length === 1 ? plain : '#'
}

/** What the loaded pages say about a letter:
 *  - 'here': a loaded title is filed under it;
 *  - 'none': no title is, and the whole list is loaded;
 *  - 'further': none is loaded yet, and the list has pages still to come. */
export type LetterState = 'here' | 'none' | 'further'

export interface LetterIndex {
  /** Each letter's state. */
  states: Record<string, LetterState>
  /** Where each letter that is 'here' first appears in the list, as listed. */
  first: Record<string, number>
}

/** Reads the loaded part of a list. `complete` is whether that is the whole
 *  list. */
export function letterIndex(items: readonly Filed[], complete: boolean): LetterIndex {
  const first: Record<string, number> = {}
  items.forEach((item, at) => {
    const letter = jumpLetter(item)
    if (!(letter in first)) first[letter] = at
  })
  const states: Record<string, LetterState> = {}
  for (const letter of JUMP_LETTERS) {
    states[letter] = letter in first ? 'here' : complete ? 'none' : 'further'
  }
  return { states, first }
}

/** Whether a list of `total` titles, served `perPage` at a time, can be
 *  loaded whole within `maxPages` pages: the only lists the strip is drawn
 *  for. Unknown totals are not. */
export function fitsInPages(total: number | null | undefined, perPage: number, maxPages: number): boolean {
  return total != null && total <= perPage * maxPages
}
