import { describe, expect, it } from 'vitest'
import { buildCardMeta } from './MediaCardCinema'

// Aurora Stage Phase 3 — the card's meta row.
//
// Phase 3 moved title + meta from a text shelf below the poster onto the art
// itself. The row's assembly is the part with actual rules, and it's shared by
// six surfaces (home rails, Movies, TV, My Library, Search, Collections) plus
// Continue Watching, so a regression here is visible everywhere at once.
//
// Pure function, no DOM — jsdom isn't in devDependencies (same constraint as
// lib/appearance.test.ts and TopNav.test.ts).

const FULL = { rating: 8.42, year: 2008, genre: 'Crime', duration: '2h 32m' }
const values = (tokens: { value: string }[]) => tokens.map(t => t.value)

describe('buildCardMeta', () => {
  it('orders tokens rating → year → runtime → genre', () => {
    // The runtime sits before genre deliberately, so the row reads
    // "★ 8.4 · 2008 · 2h 32m · Crime".
    expect(values(buildCardMeta(FULL, { showLength: true })))
      .toEqual(['8.4', '2008', '2h 32m', 'Crime'])
  })

  it('marks only the rating as a rating token', () => {
    const tokens = buildCardMeta(FULL, { showLength: true })
    expect(tokens.filter(t => t.kind === 'rating').map(t => t.value)).toEqual(['8.4'])
  })

  it('rounds the rating to one decimal', () => {
    expect(values(buildCardMeta({ rating: 9 }))).toEqual(['9.0'])
    expect(values(buildCardMeta({ rating: 6.75 }))).toEqual(['6.8'])
  })

  // The guard that matters: Continue-Watching items come from the progress
  // endpoint, which returns no TMDB rating. "★ 0" is a visible lie, not a
  // missing value.
  it('omits a zero or absent rating rather than showing ★ 0', () => {
    expect(values(buildCardMeta({ rating: 0, year: 2020 }))).toEqual(['2020'])
    expect(values(buildCardMeta({ year: 2020 }))).toEqual(['2020'])
  })

  it('omits a zero or absent year', () => {
    expect(values(buildCardMeta({ rating: 7, year: 0 }))).toEqual(['7.0'])
    expect(values(buildCardMeta({ rating: 7 }))).toEqual(['7.0'])
  })

  // showLength is opt-in (browse grid only); rails keep the compact row.
  it('includes the runtime only when showLength is set', () => {
    expect(values(buildCardMeta(FULL))).toEqual(['8.4', '2008', 'Crime'])
    expect(values(buildCardMeta(FULL, { showLength: true }))).toContain('2h 32m')
  })

  // mapMedia yields '' for a title with no runtime_minutes. An empty token
  // would render as a bare separator on the art.
  it('never emits an empty runtime token', () => {
    const tokens = buildCardMeta({ ...FULL, duration: '' }, { showLength: true })
    expect(values(tokens)).toEqual(['8.4', '2008', 'Crime'])
    expect(values(tokens)).not.toContain('')
  })

  it('lets a subtitle replace the whole row', () => {
    // Continue Watching passes "S2E4 · 23m left"; it must not be joined onto
    // the rating/year/genre tokens.
    const tokens = buildCardMeta(FULL, { subtitle: 'S2E4 · 23m left', showLength: true })
    expect(tokens).toEqual([{ kind: 'text', value: 'S2E4 · 23m left' }])
  })

  it('returns an empty row for an item with no metadata at all', () => {
    // A search hit mid-enrichment. The renderer skips the meta line entirely
    // rather than drawing an empty flex row over the art.
    expect(buildCardMeta({})).toEqual([])
  })

  // Separators are emitted BETWEEN tokens at render time; this list is what
  // that logic consumes, so no token may be blank or need its own separator
  // bookkeeping. This is the whole reason the row became a token list.
  it('produces no blank tokens for any partial combination', () => {
    const partials = [
      {}, { rating: 8 }, { year: 1999 }, { genre: 'Drama' }, { duration: '1h' },
      { rating: 8, genre: 'Drama' }, { year: 1999, duration: '1h' },
      { rating: 0, year: 0, genre: '', duration: '' },
    ]
    for (const p of partials) {
      for (const showLength of [false, true]) {
        const tokens = buildCardMeta(p, { showLength })
        expect(tokens.every(t => t.value.length > 0), JSON.stringify({ p, showLength })).toBe(true)
      }
    }
  })
})
