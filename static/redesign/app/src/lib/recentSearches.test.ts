// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetRecentSearches, readRecentSearches, rememberSearch } from './recentSearches'

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('the searches a profile is offered again', () => {
  it('are none to begin with', () => {
    expect(readRecentSearches('1:1')).toEqual([])
  })

  it('are kept newest first, trimmed', () => {
    rememberSearch('1:1', 'night train')
    expect(rememberSearch('1:1', '  harbor ')).toEqual(['harbor', 'night train'])
    expect(readRecentSearches('1:1')).toEqual(['harbor', 'night train'])
  })

  it('move up when searched again, in whatever case, instead of appearing twice', () => {
    rememberSearch('1:1', 'night train')
    rememberSearch('1:1', 'harbor')
    expect(rememberSearch('1:1', 'Night Train')).toEqual(['Night Train', 'harbor'])
  })

  it('are the last eight', () => {
    for (let n = 1; n <= 10; n++) rememberSearch('1:1', `search ${n}`)
    expect(readRecentSearches('1:1')).toEqual([10, 9, 8, 7, 6, 5, 4, 3].map(n => `search ${n}`))
  })

  it('leave out a single character, and nothing at all', () => {
    rememberSearch('1:1', 'harbor')
    expect(rememberSearch('1:1', 'a')).toEqual(['harbor'])
    expect(rememberSearch('1:1', '   ')).toEqual(['harbor'])
  })

  // One profile is not shown what another looked for.
  it('are kept apart for each account and profile', () => {
    rememberSearch('1:1', 'grown-up thriller')
    rememberSearch('1:2', 'dinosaurs')
    expect(readRecentSearches('1:2')).toEqual(['dinosaurs'])
    expect(readRecentSearches('2:1')).toEqual([])
  })

  it('can be forgotten, for that profile alone', () => {
    rememberSearch('1:1', 'harbor')
    rememberSearch('1:2', 'dinosaurs')
    forgetRecentSearches('1:1')
    expect(readRecentSearches('1:1')).toEqual([])
    expect(readRecentSearches('1:2')).toEqual(['dinosaurs'])
  })

  it('read as none when what is stored is not a list of words, or storage cannot be read', () => {
    localStorage.setItem('aurora_recent_searches:1:1', '{"not":"a list"}')
    expect(readRecentSearches('1:1')).toEqual([])
    localStorage.setItem('aurora_recent_searches:1:1', JSON.stringify(['harbor', 7, '', null, 'night train']))
    expect(readRecentSearches('1:1')).toEqual(['harbor', 'night train'])
    localStorage.setItem('aurora_recent_searches:1:1', 'not json')
    expect(readRecentSearches('1:1')).toEqual([])
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readRecentSearches('1:1')).toEqual([])
  })

  it('still answer when the list cannot be stored', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(rememberSearch('1:1', 'harbor')).toEqual(['harbor'])
  })
})
