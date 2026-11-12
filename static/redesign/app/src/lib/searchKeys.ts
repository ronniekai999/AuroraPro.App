// The keyboard on the search page. There is one search field (the top
// bar's; below md, where the bar has none, the page's own) and one page of
// results. From the field the arrow keys move through the results, Enter on
// a result opens it (it is a button), and Escape clears the field, then
// leaves it. Ctrl or Cmd K puts the focus in the field from anywhere.
//
// This replaced a separate palette (a modal with a field and a list of its
// own). The results are ordinary buttons in the page, so the focus moves
// for real: nothing here is a combobox, and a screen reader reads each
// result as what it is.

/** The results a key can land on, in the order they are drawn: the best
 *  match's title, each card's and row's title, each collection. */
const STOPS = '.search-main .search-best-open, .search-main .card-open, .search-main .mlr-main, .search-main .search-colrow'

function stops(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(STOPS)]
}

/** The search field that is drawn: the top bar's from md up, the page's own
 *  below it. A field that is not drawn has no box. Where nothing has one
 *  (no layout at all, as in a test without a stylesheet), the bar's. */
export function searchField(root: ParentNode = document): HTMLInputElement | null {
  const bar = root.querySelector<HTMLInputElement>('.stage-navsearch input')
  const page = root.querySelector<HTMLInputElement>('[data-search-results] form[role="search"] input')
  const drawn = (el: HTMLElement | null) => !!el && el.getClientRects().length > 0
  if (drawn(bar)) return bar
  if (drawn(page)) return page
  return bar ?? page
}

/** Moves the focus to a result: the first, the last, or the one after or
 *  before `from`. Past the first, back to the field; past the last, nowhere.
 *  Says whether the focus moved. */
export function focusResult(to: 'first' | 'last' | 'next' | 'prev', from?: Element | null, root: ParentNode = document): boolean {
  const all = stops(root)
  if (all.length === 0) return false
  const at = from ? all.findIndex(el => el === from || el.contains(from)) : -1
  let target: HTMLElement | null | undefined
  if (to === 'first') target = all[0]
  else if (to === 'last') target = all[all.length - 1]
  else if (to === 'next') target = at < 0 ? all[0] : all[at + 1]
  else target = at <= 0 ? searchField(root) : all[at - 1]
  if (!target) return false
  target.focus()
  return true
}

/** The key handler for the results: the arrows, Home and End. Anything
 *  else, and a key pressed in a text field or with a modifier, is left
 *  alone. */
export function onResultsKeyDown(e: { key: string; target: EventTarget | null; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; preventDefault: () => void }): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const from = e.target as Element | null
  if (!from || from.closest?.('input, textarea, select, [contenteditable="true"]')) return
  // Only from a result itself: a key pressed on Play, More or a filter is that control's.
  if (!from.matches?.(STOPS)) return
  const to = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 'next'
    : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? 'prev'
      : e.key === 'Home' ? 'first'
        : e.key === 'End' ? 'last'
          : null
  if (!to) return
  // The key is the page's now, whether or not there was anywhere to go
  // (the last result's Down must not scroll the page away from it).
  e.preventDefault()
  focusResult(to, from)
}
