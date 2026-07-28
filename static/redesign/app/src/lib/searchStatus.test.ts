import { describe, expect, it } from 'vitest'
import { searchStatusMessage } from './searchStatus'

const at = (query: string, loading: boolean, settled: string, count: number) =>
  searchStatusMessage({ query, loading, settled, count })

describe('searchStatusMessage', () => {
  it('is silent with no query', () => {
    expect(at('', false, '', 0)).toBe('')
  })

  it('is silent for a whitespace-only query', () => {
    // Not the same as "no results for a query of spaces".
    expect(at('   ', false, '', 0)).toBe('')
  })

  it('says Searching while the fetch is in flight', () => {
    expect(at('blade', true, '', 0)).toBe('Searching')
  })

  it('says Searching in the window BEFORE loading flips — the bug this exists for', () => {
    // The regression. `loading` lags the render by one commit, so on the first
    // keystroke the component renders with the new query, loading still false, and
    // the PREVIOUS results still in state. Keying off `loading` alone made this
    // announce "No matches for b" as the opening line of every search — and, with
    // an `initialQuery`, inserted the region into the DOM already saying it.
    expect(at('b', false, '', 0)).toBe('Searching')
    // Same shape on the had-results-now-typing-again transition, which announced a
    // stale count instead: settled is the OLD query, so it is still Searching.
    expect(at('bl', false, 'b', 3)).toBe('Searching')
  })

  it('reports zero only once the results belong to this query', () => {
    expect(at('zzzz', false, 'zzzz', 0)).toBe('No matches for zzzz')
  })

  it('singularises one result and pluralises the rest', () => {
    expect(at('dune', false, 'dune', 1)).toBe('1 result for dune')
    expect(at('dune', false, 'dune', 2)).toBe('2 results for dune')
    expect(at('dune', false, 'dune', 12)).toBe('12 results for dune')
  })

  it('reports the TRIMMED query, not the raw one', () => {
    // A reviewer found this leak in the inline version: the emptiness check
    // trimmed, the message did not, so a padded query read its padding out loud.
    expect(at('  a  ', false, 'a', 2)).toBe('2 results for a')
    expect(at('  a  ', false, 'a', 0)).toBe('No matches for a')
  })

  it('treats settled as the TRIMMED query, so padding does not force a false Searching', () => {
    // `settled` is stored trimmed at the call site. If this compared against the raw
    // query the widget would sit on "Searching" for ever whenever the user left a
    // trailing space.
    expect(at('dune ', false, 'dune', 4)).toBe('4 results for dune')
  })
})
