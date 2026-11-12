// @vitest-environment jsdom
//
// The title page as one column. What is pinned is the ORDER a viewer meets
// things in, at every width (jsdom has no layout, and there is no longer a
// second column whose document order could differ from its visual order):
// artwork and actions first, the synopsis directly under them, admin tools
// last and closed, and no tab strip dividing the page.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import DetailView from './DetailView'
import type { Media } from '@/lib/types'
import type { ContinueWatchingItem, Episode, MediaDetail, MediaFile } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getRecapStatus: vi.fn().mockResolvedValue({ available: false }),
    getUserRating: vi.fn().mockResolvedValue(0),
  }
})

const movie: Media = {
  id: 7, title: 'Arrival', year: 2016, rating: 8, duration: '1h 56m', genre: 'Drama', type: 'movie',
  poster: '/api/images/w500/p.jpg', backdrop: '/api/images/w1280/b.jpg', description: 'A linguist is recruited.',
}
const show: Media = { ...movie, id: 9, title: 'Harbor Lights', type: 'show', duration: '' }
const NOW = '2026-01-01T00:00:00Z'
const detailOf = (m: Media, over: Partial<MediaDetail> = {}): MediaDetail => ({
  id: m.id, library_id: 1, type: m.type, title: m.title, poster_path: '/p.jpg', backdrop_path: '/b.jpg',
  overview: 'The long synopsis.', content_rating: 'PG-13', genres: ['Drama', 'Mystery'], runtime_minutes: 116,
  added_at: NOW, updated_at: NOW,
  cast: [
    { id: 1, name: 'Ada Lindqvist', character: 'Louise', role_type: 'cast', display_order: 0 },
    { id: 2, name: 'Tomas Reyes', character: 'Ian', role_type: 'cast', display_order: 1 },
    { id: 3, name: 'Omar Haddad', role_type: 'director', display_order: 2 },
  ],
  ...over,
} as MediaDetail)
const file = (id: number, tag: string): MediaFile => ({
  id, media_item_id: 7, container: 'mkv', video_codec: 'hevc', audio_codec: 'aac', resolution: tag, version_tag: tag,
  audio_tracks: [{ index: 0, codec: 'aac', channels: 6, language: 'eng', is_default: true }],
  subtitle_tracks: [{ index: 1, codec: 'subrip', language: 'eng' }],
} as unknown as MediaFile)
const episode = (n: number, progress?: Episode['progress']): Episode => ({
  id: 100 + n, season_id: 1, media_item_id: 9, episode_number: n, title: `Episode title ${n}`,
  overview: `Synopsis ${n}`, runtime_minutes: 50, files: [{ id: 500 + n, episode_id: 100 + n }], progress,
} as unknown as Episode)

const noop = () => {}
const base = { onBack: noop, onPlay: noop, onToggleLib: noop, inLibrary: false }

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
})
afterEach(cleanup)

/** The season's rows (the page has other lists: quality chips, the cast). */
const episodeList = () => within(screen.getByRole('region', { name: 'Episodes' })).getByRole('list')

/** Document order of the page's landmarks, by a recognisable piece of each. */
function order(...nodes: Element[]) {
  for (let i = 1; i < nodes.length; i++) {
    expect(nodes[i - 1].compareDocumentPosition(nodes[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `item ${i} follows item ${i - 1}`).toBeTruthy()
  }
}

describe('DetailView — one column, in order', () => {
  it('a film: actions in the hero, then synopsis, cast, details, media info, and Manage last', () => {
    render(<DetailView {...base} media={movie} detail={detailOf(movie, { files: [file(1, '2160p')] })} files={[file(1, '2160p')]} onRefreshMetadata={noop} onIdentify={noop} onDeleteMedia={noop} />)
    const hero = screen.getByRole('region', { name: 'Arrival' })
    const play = screen.getByRole('button', { name: 'Play' })
    expect(hero).toContainElement(play)
    order(
      screen.getByRole('heading', { level: 1, name: 'Arrival' }),
      play,
      screen.getByText('The long synopsis.'),
      screen.getByRole('heading', { name: 'Cast' }),
      screen.getByRole('heading', { name: 'Details' }),
      screen.getByRole('button', { name: /Media info/ }),
      screen.getByRole('button', { name: /Manage/ }),
    )
    // The synopsis is the first thing after the hero, not after a card stack.
    expect(hero.nextElementSibling).toContainElement(screen.getByText('The long synopsis.'))
  })

  // On a phone everything is one column in document order, so the order in
  // the document IS the order on the screen: the words come before the chips
  // that describe the file and before the row that picks one.
  it('a film with two files: the synopsis text comes before the quality chips and the "Play in" row', () => {
    const files = [file(1, '2160p'), file(2, '1080p')]
    render(<DetailView {...base} media={movie} detail={detailOf(movie, { files })} files={files} onPlayFile={noop} />)
    const synopsis = screen.getByText('The long synopsis.')
    const playIn = screen.getByRole('group', { name: 'Play a specific version' })
    const region = screen.getByRole('region', { name: 'Synopsis' })
    expect(region.firstElementChild).toBe(synopsis)
    order(synopsis, within(region).getAllByRole('list')[0], playIn)
  })

  it('a show: episodes come between the synopsis and the cast', () => {
    render(<DetailView {...base} media={show} detail={detailOf(show, { season_count: 2 })} apiEpisodes={[episode(1), episode(2)]} selectedSeason={1} seasons={[{ season_number: 1 }, { season_number: 2 }]} />)
    order(
      screen.getByText('The long synopsis.'),
      screen.getByRole('heading', { name: 'Episodes' }),
      screen.getByRole('heading', { name: 'Cast' }),
      screen.getByRole('heading', { name: 'Details' }),
    )
  })

  it('has no tab strip: everything is on the page at once', () => {
    render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={[episode(1)]} />)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
  })

  it('keeps the technical media info closed until asked', () => {
    render(<DetailView {...base} media={movie} detail={detailOf(movie, { files: [file(1, '2160p'), file(2, '1080p')] })} files={[file(1, '2160p'), file(2, '1080p')]} />)
    const head = screen.getByRole('button', { name: /Media info/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toHaveTextContent('2 versions · 1 audio track · 1 subtitle')
    const panel = document.getElementById(head.getAttribute('aria-controls')!)!
    expect(panel).toHaveAttribute('hidden')
    fireEvent.click(head)
    expect(panel).not.toHaveAttribute('hidden')
    expect(within(panel).getByText('Versions')).toBeInTheDocument()
  })
})

describe('DetailView — admin tools', () => {
  it('are absent for anyone who is not handed them', () => {
    render(<DetailView {...base} media={movie} detail={detailOf(movie)} />)
    expect(screen.queryByRole('button', { name: /Manage/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove from library' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh metadata' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Fix match' })).toBeNull()
  })

  it('sit last, inside a closed "Manage" panel, and call the handlers they were given', () => {
    const onRefreshMetadata = vi.fn(), onIdentify = vi.fn(), onDeleteMedia = vi.fn()
    const { container } = render(<DetailView {...base} media={movie} detail={detailOf(movie)} onRefreshMetadata={onRefreshMetadata} onIdentify={onIdentify} onDeleteMedia={onDeleteMedia} />)
    const head = screen.getByRole('button', { name: /Manage/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    const panel = document.getElementById(head.getAttribute('aria-controls')!)!
    expect(panel).toHaveAttribute('hidden')
    // Closed means out of reach, not merely out of sight.
    expect(screen.queryByRole('button', { name: 'Remove from library' })).toBeNull()
    // Nothing on the page comes after it.
    const buttons: HTMLElement[] = [...container.querySelectorAll('button')]
    expect(buttons.indexOf(head)).toBeGreaterThan(buttons.indexOf(screen.getByRole('button', { name: 'Play' })))
    expect(buttons.slice(buttons.indexOf(head) + 1).every(b => panel.contains(b))).toBe(true)
    fireEvent.click(head)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh metadata' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fix match' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove from library' }))
    expect(onRefreshMetadata).toHaveBeenCalledExactlyOnceWith(movie)
    expect(onIdentify).toHaveBeenCalledExactlyOnceWith(movie)
    expect(onDeleteMedia).toHaveBeenCalledExactlyOnceWith(movie)
  })

  it('shows only the tools it was given', () => {
    render(<DetailView {...base} media={movie} detail={detailOf(movie)} onRefreshMetadata={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /Manage/ }))
    expect(screen.getByRole('button', { name: 'Refresh metadata' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove from library' })).toBeNull()
  })
})

describe('DetailView — a show in progress', () => {
  const watched = { position_ms: 3_000_000, duration_ms: 3_000_000, completed: true } as Episode['progress']
  const partway = { position_ms: 1_200_000, duration_ms: 3_000_000 } as Episode['progress']
  const eps = [episode(1, watched), episode(2, partway), episode(3)]
  const resumeItem = {
    media_item_id: 9, episode_id: 102, title: 'Harbor Lights', type: 'show', season_number: 1, episode_number: 2,
    position_ms: 1_200_000, duration_ms: 3_000_000, percent_complete: 40, updated_at: NOW,
  } as unknown as ContinueWatchingItem

  it('pins the episode to continue first, above the list, and plays it through the row handler', () => {
    const onPlayEpisode = vi.fn()
    render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={eps} onPlayEpisode={onPlayEpisode} />)
    const pinned = screen.getByRole('button', { name: /Continue.*2 · Episode title 2.*30 min left.*Resume/ })
    const list = episodeList()
    order(screen.getByRole('heading', { name: 'Episodes' }), pinned, list)
    // It is still in the list at its own place, in order.
    expect(within(list).getAllByRole('listitem').map(li => within(li).getAllByRole('button')[0].textContent)).toEqual([
      expect.stringContaining('Episode title 1'), expect.stringContaining('Episode title 2'), expect.stringContaining('Episode title 3'),
    ])
    fireEvent.click(pinned)
    expect(onPlayEpisode).toHaveBeenCalledExactlyOnceWith(eps[1], undefined)
  })

  it('does not scroll the page to it on load', () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    try {
      render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={eps} />)
      expect(scrollIntoView).not.toHaveBeenCalled()
      expect(scrollTo).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = original
      scrollTo.mockRestore()
    }
  })

  it('counts the season and says how much of it is watched', () => {
    render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={eps} />)
    expect(screen.getByText('3 episodes · 1 watched')).toBeInTheDocument()
  })

  // Episode 2 was left at 40%, then episode 5 was watched to 30%: the hero's
  // Resume is the latest record (episode 5), and the card under it used to
  // offer the first in-progress row (episode 2).
  it('pins the episode the hero\u2019s Resume plays, not the first one in progress', () => {
    const onPlayEpisode = vi.fn()
    const later = { position_ms: 900_000, duration_ms: 3_000_000 } as Episode['progress']
    const season = [episode(1, watched), episode(2, partway), episode(3), episode(4), episode(5, later)]
    const latest = { ...resumeItem, episode_id: 105, episode_number: 5, position_ms: 900_000, percent_complete: 30 } as ContinueWatchingItem
    render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={season} onPlayEpisode={onPlayEpisode}
      resume={{ item: latest, onPlay: noop }} />)
    expect(screen.getByRole('button', { name: /^Resume Season 1 Episode 5/ })).toBeInTheDocument()
    const pinned = screen.getByRole('button', { name: /Continue.*5 · Episode title 5.*Resume/ })
    expect(screen.queryByRole('button', { name: /Continue.*2 · Episode title 2/ })).toBeNull()
    fireEvent.click(pinned)
    expect(onPlayEpisode).toHaveBeenCalledExactlyOnceWith(season[4], undefined)
  })

  it('falls back to the first episode in progress when the resume record is in another season', () => {
    const elsewhere = { ...resumeItem, episode_id: 999, season_number: 2, episode_number: 1 } as ContinueWatchingItem
    render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={eps} resume={{ item: elsewhere, onPlay: noop }} />)
    expect(screen.getByRole('button', { name: /Continue.*2 · Episode title 2/ })).toBeInTheDocument()
  })

  it('puts Resume and the recap side by side in the hero when a recap exists', async () => {
    const api = await import('@/lib/api')
    vi.mocked(api.getRecapStatus).mockResolvedValueOnce({ available: true, has_ask_history: false })
    const onPlayResume = vi.fn()
    render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={eps} profileId={3} resume={{ item: resumeItem, onPlay: onPlayResume }} />)
    const recap = await screen.findByRole('button', { name: 'Previously on' })
    const resume = screen.getByRole('button', { name: /^Resume Season 1 Episode 2/ })
    const hero = screen.getByRole('region', { name: 'Harbor Lights' })
    expect(hero).toContainElement(resume)
    expect(hero).toContainElement(recap)
    expect(resume.parentElement).toBe(recap.parentElement)
    order(resume, recap)
    fireEvent.click(resume)
    expect(onPlayResume).toHaveBeenCalledExactlyOnceWith(resumeItem)
    // The hero says how much is left, once.
    expect(within(hero).getByRole('progressbar', { name: 'Resume progress' })).toHaveAttribute('aria-valuenow', '40')
    expect(within(hero).getByText('30 min left')).toBeInTheDocument()
  })

  it('offers no recap for a film', async () => {
    const api = await import('@/lib/api')
    vi.mocked(api.getRecapStatus).mockResolvedValueOnce({ available: true, has_ask_history: true })
    render(<DetailView {...base} media={movie} detail={detailOf(movie)} profileId={3} />)
    await Promise.resolve(); await Promise.resolve()
    expect(screen.queryByRole('button', { name: 'Previously on' })).toBeNull()
  })
})

describe('DetailView — episodes', () => {
  // A row's visible number is for the eye (a column on a wide window, a
  // prefix on a phone); its name carries the number once, at every width.
  it('names each row with its episode number exactly once', () => {
    render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={[episode(3)]} />)
    const row = within(episodeList()).getByRole('button')
    // What a screen reader is given: everything not aria-hidden.
    const spoken = [...row.querySelectorAll('*')].filter(el => el.children.length === 0 && !el.closest('[aria-hidden="true"]')).map(el => el.textContent).join(' ')
    expect(spoken.match(/Episode 3:/g)).toHaveLength(1)
    expect(spoken).not.toMatch(/(^|\s)3\.(\s|$)/)
    expect(row.textContent).toContain('Episode title 3')
  })

  it('an episode with no file says so and reports the press instead of playing', () => {
    const onPlayEpisode = vi.fn(), onEpisodeUnavailable = vi.fn()
    const missing = { ...episode(4), files: [] } as unknown as Episode
    render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={[missing]} onPlayEpisode={onPlayEpisode} onEpisodeUnavailable={onEpisodeUnavailable} />)
    const row = within(episodeList()).getByRole('button')
    expect(row).toHaveTextContent('Not available')
    fireEvent.click(row)
    expect(onEpisodeUnavailable).toHaveBeenCalledExactlyOnceWith(missing)
    expect(onPlayEpisode).not.toHaveBeenCalled()
  })

  it('an episode with two versions offers each as its own control beside the row', () => {
    const onPlayEpisode = vi.fn()
    const two = { ...episode(1), files: [{ id: 901, episode_id: 101, resolution: '2160p' }, { id: 902, episode_id: 101, resolution: '1080p' }] } as unknown as Episode
    render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={[two]} onPlayEpisode={onPlayEpisode} />)
    const group = screen.getByRole('group', { name: 'Play episode 1 in' })
    const chips = within(group).getAllByRole('button')
    expect(chips).toHaveLength(2)
    // Siblings of the row's own button, never nested inside it.
    expect(chips[0].closest('button')).toBe(chips[0])
    expect(within(episodeList()).getAllByRole('button')[0]).not.toContainElement(chips[0])
    fireEvent.click(chips[1])
    expect(onPlayEpisode).toHaveBeenCalledExactlyOnceWith(two, 902)
  })
})

// Going from one title straight to another (a cast link, the search palette),
// the host still holds the previous title's episodes and files when the new
// page first renders: it clears them only on leaving the title page.
describe('DetailView — the previous title\u2019s rows are not shown under the next title', () => {
  it('a show: the old show\u2019s episodes are neither listed nor playable under the new name', () => {
    const onPlayEpisode = vi.fn()
    const old = [episode(1), episode(2)]
    const next: Media = { ...show, id: 11, title: 'Night Ferry' }
    const { rerender } = render(<DetailView {...base} media={show} detail={detailOf(show)} apiEpisodes={old} onPlayEpisode={onPlayEpisode} />)
    expect(within(episodeList()).getAllByRole('listitem')).toHaveLength(2)
    rerender(<DetailView {...base} media={next} detail={detailOf(show)} apiEpisodes={old} onPlayEpisode={onPlayEpisode} loading />)
    expect(screen.getByRole('heading', { level: 1, name: 'Night Ferry' })).toBeInTheDocument()
    expect(screen.queryByText(/Episode title/)).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Episodes' })).queryAllByRole('button')).toEqual([])
    // Its own episodes, when they arrive, are shown.
    const own = [{ ...episode(1), id: 301, media_item_id: 11, title: 'Castoff' } as Episode]
    rerender(<DetailView {...base} media={next} detail={detailOf(next)} apiEpisodes={own} onPlayEpisode={onPlayEpisode} />)
    fireEvent.click(within(episodeList()).getByRole('button', { name: /Castoff/ }))
    expect(onPlayEpisode).toHaveBeenCalledExactlyOnceWith(own[0], undefined)
  })

  it('a film: the old film\u2019s "Play in" chips are not offered under the new name', () => {
    const onPlayFile = vi.fn()
    const old = [file(1, '2160p'), file(2, '1080p')]
    const next: Media = { ...movie, id: 8, title: 'Contact' }
    const { rerender } = render(<DetailView {...base} media={movie} detail={detailOf(movie, { files: old })} files={old} onPlayFile={onPlayFile} />)
    expect(within(screen.getByRole('group', { name: 'Play a specific version' })).getAllByRole('button')).toHaveLength(2)
    rerender(<DetailView {...base} media={next} detail={detailOf(movie, { files: old })} files={old} onPlayFile={onPlayFile} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Contact' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Play a specific version' })).toBeNull()
  })

  // The same film in a second library is offered as a version on purpose:
  // its file belongs to another item.
  it('a film: keeps a version that is another library\u2019s copy, beside its own file', () => {
    const onPlayFile = vi.fn()
    const own = file(1, '1080p')
    const copy = { ...file(2, '2160p'), media_item_id: 55, library_name: '4K' } as MediaFile
    render(<DetailView {...base} media={movie} detail={detailOf(movie)} files={[own, copy]} onPlayFile={onPlayFile} />)
    const chips = within(screen.getByRole('group', { name: 'Play a specific version' })).getAllByRole('button')
    expect(chips).toHaveLength(2)
    fireEvent.click(chips[1])
    expect(onPlayFile).toHaveBeenCalledExactlyOnceWith(movie, 2)
  })
})
