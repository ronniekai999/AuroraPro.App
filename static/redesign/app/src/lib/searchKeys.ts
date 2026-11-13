// The keyboard on the search page. There is one search field (the top
// bar's; below md, where the bar has none, the page's own) and one page of
// results. From the field the arrow keys move through the results, Enter on
// a result opens it (it is a button), and Escape clears the field, then
// leaves it. Ctrl or Cmd K puts the focus in the field from anywhere.
//
// Left and Right go through the results in the order they are drawn. Down
// and Up go by where the results are on the page: to the row below or
// above, and in it to the result nearest the column the focus is in. (They
// went in drawn order too, so in the grid of cards Down moved sideways.)
// The last row of a section leads on to the next section's first row, and
// Up from the top row is the field. Where nothing has been laid out, the
// drawn order is all there is to go by, and Down and Up use it.
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

/** Two results are in one row when their tops are this close (cards in a
 *  row share a top; a pixel of rounding must not split them). */
const SAME_ROW = 4

/** The result in the row below (`dir` 1) or above (-1) `from`, nearest the
 *  column `from` is in: the one whose left edge is closest to its own, the
 *  earlier in drawn order on a tie. A full-width row over a grid so leads
 *  to the grid's first card, and a column the next row does not reach to
 *  that row's last card. Undefined when there is no row that way; null when
 *  `from` has no box to go by (nothing is laid out). */
function inRow(all: HTMLElement[], from: HTMLElement, dir: 1 | -1): HTMLElement | undefined | null {
  const here = from.getBoundingClientRect()
  if (here.width === 0 && here.height === 0) return null
  const middle = here.top + here.height / 2
  const boxes = all.filter(el => el !== from).map(el => ({ el, box: el.getBoundingClientRect() }))
    .filter(({ box }) => (box.width > 0 || box.height > 0) && (dir === 1 ? box.top >= middle : box.top + box.height <= middle))
  if (boxes.length === 0) return undefined
  // The nearest row that way: the smallest top below, the largest above.
  const rowTop = dir === 1 ? Math.min(...boxes.map(b => b.box.top)) : Math.max(...boxes.map(b => b.box.top))
  let best: { el: HTMLElement; off: number } | undefined
  for (const { el, box } of boxes) {
    if (Math.abs(box.top - rowTop) > SAME_ROW) continue
    const off = Math.abs(box.left - here.left)
    if (!best || off < best.off) best = { el, off }
  }
  return best?.el
}

/** Moves the focus to a result: the first, the last, the one after or
 *  before `from` in drawn order (`next`, `prev`), or the one below or above
 *  it on the page (`down`, `up`). Before the first and above the top row,
 *  back to the field; past the last and below the bottom row, nowhere.
 *  Says whether the focus moved. */
export function focusResult(to: 'first' | 'last' | 'next' | 'prev' | 'down' | 'up', from?: Element | null, root: ParentNode = document): boolean {
  const all = stops(root)
  if (all.length === 0) return false
  const at = from ? all.findIndex(el => el === from || el.contains(from)) : -1
  let target: HTMLElement | null | undefined
  if ((to === 'down' || to === 'up') && at >= 0) {
    const found = inRow(all, all[at], to === 'down' ? 1 : -1)
    // No layout to go by: drawn order.
    if (found === null) to = to === 'down' ? 'next' : 'prev'
    else target = found ?? (to === 'up' ? searchField(root) : undefined)
  } else if (to === 'down' || to === 'up') {
    // Not from a result: where drawn order starts.
    to = to === 'down' ? 'next' : 'prev'
  }
  if (to === 'first') target = all[0]
  else if (to === 'last') target = all[all.length - 1]
  else if (to === 'next') target = at < 0 ? all[0] : all[at + 1]
  else if (to === 'prev') target = at <= 0 ? searchField(root) : all[at - 1]
  if (!target) return false
  target.focus()
  return true
}

/** The key handler for the results: the arrows (Down and Up by row, Left
 *  and Right in drawn order), Home and End. Anything else, and a key
 *  pressed in a text field or with a modifier, is left alone. */
export function onResultsKeyDown(e: { key: string; target: EventTarget | null; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; preventDefault: () => void }): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const from = e.target as Element | null
  if (!from || from.closest?.('input, textarea, select, [contenteditable="true"]')) return
  // Only from a result itself: a key pressed on Play, More or a filter is that control's.
  if (!from.matches?.(STOPS)) return
  const to = e.key === 'ArrowDown' ? 'down'
    : e.key === 'ArrowUp' ? 'up'
      : e.key === 'ArrowRight' ? 'next'
        : e.key === 'ArrowLeft' ? 'prev'
          : e.key === 'Home' ? 'first'
            : e.key === 'End' ? 'last'
              : null
  if (!to) return
  // The key is the page's now, whether or not there was anywhere to go
  // (the last result's Down must not scroll the page away from it).
  e.preventDefault()
  focusResult(to, from)
}
