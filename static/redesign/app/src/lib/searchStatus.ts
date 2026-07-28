// The palette's live-region message (Aurora Stage Phase 10).
//
// Extracted and tested because a reviewer proved the point empirically: it applied
// SIX simultaneous mutations to everything Phase 10 added — role="option" to
// "listitem", role="listbox" to "list", aria-expanded to false, activedescendant to
// undefined, aria-selected to false, and the zero-result message to a wrong string —
// and the entire gate stayed green. 132/132, tsc 0, lint unchanged. Every semantic
// the phase exists to add could be deleted without a single check noticing.
//
// Most of those need a DOM assertion, and this repo has no jsdom. This one does not:
// it is a pure function of four values with six distinct outputs, and it is the piece
// that already went wrong once — the first version keyed off `loading`, which lags a
// commit, so the opening line of every search was "No matches for b". A 15-line test
// would have caught that before a browser did.

export interface SearchStatusInput {
  /** The raw query, exactly as typed. */
  query: string
  /** The fetch's own in-flight flag. */
  loading: boolean
  /** The trimmed query the current `count` actually belongs to. */
  settled: string
  /** How many results are being displayed. */
  count: number
  /**
   * Whether the server answered semantically rather than literally.
   *
   * Phase 11.4. The palette shows this as a "Smart" chip beside the input and
   * nothing else — a `<span>` with an icon and a word, appearing only after a
   * semantic result lands. It is the one piece of state that changes what the
   * results MEAN (matched by description, not by title), and it was conveyed by
   * colour and position alone. Folded into this message rather than given its own
   * live region: two polite regions updating on the same commit race, and a
   * screen reader may drop one.
   */
  smart?: boolean
}

/**
 * What a screen reader should hear about the current search, or '' for silence.
 *
 * `settled` rather than `loading` alone is the load-bearing part. `loading` lags the
 * render by one commit — `onChange` re-renders with the new query while `loading` is
 * still false and the results are still the PREVIOUS array — so relying on it made
 * the region announce a false negative before it announced "Searching", and flash
 * the empty state visually for a frame. Comparing the query the results belong to
 * is the honest test, and it also covers the `initialQuery` path, where the region
 * was inserted into the DOM already containing the wrong string.
 */
export function searchStatusMessage({ query, loading, settled, count, smart }: SearchStatusInput): string {
  const trimmed = query.trim()
  // Whitespace-only is silence, not a search. The first version tested `query.trim()`
  // for emptiness but then interpolated the RAW query into the message, so a query of
  // "  a  " announced "2 results for   a  " with the padding read out.
  if (trimmed === '') return ''
  if (loading || settled !== trimmed) return 'Searching'
  if (count === 0) return `No matches for ${trimmed}`
  // "Smart" is what the chip says, so the announcement uses the same word — a
  // reader and a sighted user describing the same screen to each other should be
  // using the same vocabulary. The qualifier trails the count so the number, which
  // is what the user is waiting for, is still the first thing heard.
  const how = smart ? ', matched by description' : ''
  return `${count} result${count === 1 ? '' : 's'} for ${trimmed}${how}`
}
