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
export function searchStatusMessage({ query, loading, settled, count }: SearchStatusInput): string {
  const trimmed = query.trim()
  // Whitespace-only is silence, not a search. The first version tested `query.trim()`
  // for emptiness but then interpolated the RAW query into the message, so a query of
  // "  a  " announced "2 results for   a  " with the padding read out.
  if (trimmed === '') return ''
  if (loading || settled !== trimmed) return 'Searching'
  if (count === 0) return `No matches for ${trimmed}`
  return `${count} result${count === 1 ? '' : 's'} for ${trimmed}`
}
