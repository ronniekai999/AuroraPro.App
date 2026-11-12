// @vitest-environment jsdom
//
// Tonight's hero: the filmstrip that replaced the unseen rotation, what its
// actions do, and what it tells the recommender and the page.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { Media } from '@/lib/types'
import type { ContinueWatchingItem } from '@/lib/api'
import type { SlateEntry } from '@/lib/tonightSlate'

const exposure = vi.fn<(input: unknown) => Promise<boolean>>()
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  recordRecommendationExposure: (input: unknown) => exposure(input),
}))
// The picture's colour is sampled off the critical path and answered later.
const ambient = vi.fn<(img: HTMLImageElement) => string | null>()
vi.mock('@/lib/ambient', async (original) => ({
  ...(await original<typeof import('@/lib/ambient')>()),
  ambientFor: async (img: HTMLImageElement) => ambient(img),
}))

import { HeroSection } from './HeroSection'

const media = (id: number, title: string, type: 'movie' | 'show' = 'movie'): Media => ({
  id, title, year: 2024, rating: 8, duration: '2h', genre: 'Drama', type,
  poster: '', backdrop: `/art/${id}.jpg`, description: `About ${title}.`,
})
const record = (id: number, title: string): ContinueWatchingItem => ({
  media_item_id: id, title, type: 'movie', year: 2024, genre: 'Drama',
  position_ms: 30 * 60_000, duration_ms: 120 * 60_000, percent_complete: 25,
})
const LEAD = media(10, 'Halfway House')
const P1 = media(1, 'First Pick'), P2 = media(2, 'Second Pick', 'show'), P3 = media(3, 'Third Pick')
const SLATE: SlateEntry[] = [
  { key: 'resume:10', kind: 'resume', media: LEAD, poolIndex: null, position: null, record: record(10, 'Halfway House') },
  { key: 'pick:1', kind: 'pick', media: P1, poolIndex: 0, position: 0, reason: 'Because of one' },
  { key: 'pick:2', kind: 'pick', media: P2, poolIndex: 1, position: 1, reason: 'Because of two' },
  { key: 'pick:3', kind: 'pick', media: P3, poolIndex: 2, position: 2 },
]
const base = { onPlay: vi.fn(), onInfo: vi.fn() }

// jsdom has no IntersectionObserver: the hero's report is driven by one.
type IOEntry = { isIntersecting: boolean; intersectionRatio: number }
let observers: { cb: (entries: IOEntry[]) => void; disconnected: boolean }[] = []
const onScreen = (ratio: number) => act(() => {
  for (const o of observers) if (!o.disconnected) o.cb([{ isIntersecting: ratio > 0, intersectionRatio: ratio }])
})

beforeEach(() => {
  observers = []
  exposure.mockReset().mockResolvedValue(true)
  ambient.mockReset().mockReturnValue('rgb(10, 20, 30)')
  base.onPlay.mockReset(); base.onInfo.mockReset()
  vi.stubGlobal('IntersectionObserver', class {
    private self: { cb: (entries: IOEntry[]) => void; disconnected: boolean }
    constructor(cb: (entries: IOEntry[]) => void) { this.self = { cb, disconnected: false }; observers.push(this.self) }
    observe() { /* the test says when it is on screen */ }
    disconnect() { this.self.disconnected = true }
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the hero's filmstrip", () => {
  // The strip is "Tonight's picks from Aurora": the picks, and only them.
  // The title to resume is the hero's own, and the first card of Continue
  // Watching under it; listed here too it was on screen three times.
  it('shows every pick and not the title to resume, says which is showing, and lets any be chosen', () => {
    const onPick = vi.fn()
    render(<HeroSection {...base} hero={LEAD} kind="resume" slate={SLATE} slateIndex={0} onPick={onPick} />)
    const strip = screen.getByRole('list', { name: /Tonight.s picks from Aurora/ })
    const thumbs = within(strip).getAllByRole('button')
    expect(thumbs.map(b => b.getAttribute('aria-label'))).toEqual(['First Pick', 'Second Pick', 'Third Pick'])
    // The hero is on the title to resume: none of the picks is showing.
    expect(thumbs.map(b => b.getAttribute('aria-current'))).toEqual([null, null, null])

    // A pick is asked for by its place in the slate (the lead is entry 0).
    fireEvent.click(thumbs[1])
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(2)
  })

  it('moves "showing now" with the entry shown', () => {
    const { rerender } = render(<HeroSection {...base} hero={LEAD} kind="resume" slate={SLATE} slateIndex={0} onPick={vi.fn()} />)
    rerender(<HeroSection {...base} hero={P2} kind="pick" slate={SLATE} slateIndex={2} onPick={vi.fn()} />)
    const thumbs = within(screen.getByRole('list')).getAllByRole('button')
    expect(thumbs.map(b => b.getAttribute('aria-current'))).toEqual([null, 'true', null])
    expect(thumbs[0]).toHaveAccessibleName('First Pick')
    expect(thumbs[1]).toHaveAccessibleName('Second Pick, showing now')
  })

  it('is drawn for a title to resume and a single pick: there is somewhere else to go', () => {
    render(<HeroSection {...base} hero={LEAD} kind="resume" slate={SLATE.slice(0, 2)} slateIndex={0} onPick={vi.fn()} />)
    expect(within(screen.getByRole('list')).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['First Pick'])
  })

  // A thumb that holds keyboard focus can leave the strip under it: the
  // picks were refreshed, or its title was rated away. Focus is not left on
  // the body, at the top of the page.
  it('keeps keyboard focus in the hero when the focused pick leaves the strip', () => {
    const props = { ...base, hero: LEAD, kind: 'resume' as const, slateIndex: 0, onPick: vi.fn() }
    const { rerender } = render(<HeroSection {...props} slate={SLATE} />)
    const second = screen.getByRole('button', { name: 'Second Pick' })
    second.focus()
    expect(document.activeElement).toBe(second)
    // "Second Pick" is gone; "Third Pick" is now in its place.
    rerender(<HeroSection {...props} slate={[SLATE[0], SLATE[1], SLATE[3]]} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Third Pick' }))
    // The last one goes: the one before it.
    rerender(<HeroSection {...props} slate={[SLATE[0], SLATE[1]]} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First Pick' }))
    // No picks left, so no strip: the hero's main action.
    rerender(<HeroSection {...props} slate={[SLATE[0]]} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Play Halfway House' }))
  })

  it('does not move focus that the viewer has taken elsewhere, or that was never in the strip', () => {
    const props = { ...base, hero: LEAD, kind: 'resume' as const, slateIndex: 0, onPick: vi.fn() }
    const { rerender } = render(<><HeroSection {...props} slate={SLATE} /><button>Outside</button></>)
    const outside = screen.getByRole('button', { name: 'Outside' })
    screen.getByRole('button', { name: 'Second Pick' }).focus()
    outside.focus()
    rerender(<><HeroSection {...props} slate={[SLATE[0], SLATE[1], SLATE[3]]} /><button>Outside</button></>)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }))
  })

  it('is not drawn for one entry, for a child, or with no way to choose', () => {
    const one = render(<HeroSection {...base} hero={P1} slate={SLATE.slice(1, 2)} slateIndex={0} onPick={vi.fn()} />)
    expect(one.container.querySelector('[data-hero-picks]')).toBeNull()
    one.unmount()
    const kid = render(<HeroSection {...base} hero={P1} slate={SLATE} slateIndex={1} onPick={vi.fn()} kids />)
    expect(kid.container.querySelector('[data-hero-picks]')).toBeNull()
    kid.unmount()
    const inert = render(<HeroSection {...base} hero={P1} slate={SLATE} slateIndex={1} />)
    expect(inert.container.querySelector('[data-hero-picks]')).toBeNull()
  })

  it('has a button that pauses the rotation, labelled with what a press does', () => {
    const onToggle = vi.fn()
    const props = { ...base, hero: P1, slate: SLATE, slateIndex: 1, onPick: vi.fn(), onToggleRotation: onToggle }
    const { rerender } = render(<HeroSection {...props} rotationPaused={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause the rotation' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Play the rotation' })).toBeNull()
    rerender(<HeroSection {...props} rotationPaused />)
    expect(screen.getByRole('button', { name: 'Play the rotation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pause the rotation' })).toBeNull()
    // Nothing rotates (one entry is not a strip; reduced motion): no control.
    rerender(<HeroSection {...props} onToggleRotation={undefined} />)
    expect(screen.queryByRole('button', { name: /the rotation/ })).toBeNull()
  })

  it('holds the rotation while the pointer or keyboard focus is in the hero', () => {
    const onPause = vi.fn()
    const { container } = render(<HeroSection {...base} hero={P1} slate={SLATE} slateIndex={1} onPick={vi.fn()} onPauseChange={onPause} />)
    const section = container.querySelector('section')!
    fireEvent.mouseEnter(section)
    expect(onPause).toHaveBeenLastCalledWith(true)
    fireEvent.mouseLeave(section)
    expect(onPause).toHaveBeenLastCalledWith(false)
    const play = screen.getByRole('button', { name: 'Play First Pick' })
    const details = screen.getByRole('button', { name: 'Details of First Pick' })
    fireEvent.focus(play)
    expect(onPause).toHaveBeenLastCalledWith(true)
    onPause.mockClear()
    // Focus moving between two controls of the hero is not leaving it.
    fireEvent.blur(play, { relatedTarget: details })
    expect(onPause).not.toHaveBeenCalledWith(false)
    fireEvent.blur(details, { relatedTarget: document.body })
    expect(onPause).toHaveBeenLastCalledWith(false)
  })
})

describe("the hero's actions", () => {
  it('resumes from the record when it is the hero\'s own, and says how far in it is', () => {
    const onResume = vi.fn()
    const rec = record(10, 'Halfway House')
    render(<HeroSection {...base} hero={LEAD} kind="resume" resume={{ item: rec, onPlay: onResume }} />)
    expect(screen.getByText('Pick up where you left off')).toBeInTheDocument()
    expect(screen.getByText('1 h 30 min left')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Halfway House: watched' })).toHaveAttribute('aria-valuenow', '25')
    fireEvent.click(screen.getByRole('button', { name: /^Resume/ }))
    expect(onResume).toHaveBeenCalledWith(rec)
    expect(base.onPlay).not.toHaveBeenCalled()
  })

  it('plays from the start, and shows no progress, when the record is another title\'s', () => {
    const onResume = vi.fn()
    render(<HeroSection {...base} hero={P1} kind="pick" resume={{ item: record(10, 'Halfway House'), onPlay: onResume }} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(/min left/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Play First Pick' }))
    expect(base.onPlay).toHaveBeenCalledWith(P1)
    expect(onResume).not.toHaveBeenCalled()
  })

  it('opens the title page from "Details", or "Episodes" for a show', () => {
    const { rerender } = render(<HeroSection {...base} hero={P1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Details of First Pick' }))
    expect(base.onInfo).toHaveBeenLastCalledWith(P1)
    expect(screen.getByRole('button', { name: 'Details of First Pick' })).toHaveTextContent('Details')
    rerender(<HeroSection {...base} hero={P2} />)
    expect(screen.getByRole('button', { name: 'Episodes of Second Pick' })).toHaveTextContent('Episodes')
  })

  it('offers "Watch together" and the My Library toggle only when given them', () => {
    const onTogether = vi.fn(), onLib = vi.fn()
    const { rerender } = render(<HeroSection {...base} hero={P1} />)
    expect(screen.queryByRole('button', { name: /together/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /My Library/ })).toBeNull()
    rerender(<HeroSection {...base} hero={P1} onWatchTogether={onTogether} libraryIds={new Set([1])} onToggleLib={onLib} />)
    fireEvent.click(screen.getByRole('button', { name: 'Watch First Pick together' }))
    expect(onTogether).toHaveBeenCalledWith(P1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove First Pick from My Library' }))
    expect(onLib).toHaveBeenCalledWith(P1)
    rerender(<HeroSection {...base} hero={P1} onWatchTogether={onTogether} libraryIds={new Set()} onToggleLib={onLib} />)
    expect(screen.getByRole('button', { name: 'Add First Pick to My Library' })).toBeInTheDocument()
  })

  it('says why Aurora picked it, else the cold-start hint, else what it is', () => {
    const { rerender } = render(<HeroSection {...base} hero={P1} kind="pick" reason="Because of one" />)
    expect(screen.getByText('Because of one')).toBeInTheDocument()
    expect(screen.queryByText('About First Pick.')).toBeNull()
    rerender(<HeroSection {...base} hero={P1} kind="pick" personalization={{ coldStart: true, historyCount: 1, threshold: 3 }} />)
    expect(screen.getByText('Watch 2 more titles to unlock personalized picks')).toBeInTheDocument()
    rerender(<HeroSection {...base} hero={P1} kind="catalog" personalization={{ coldStart: true, historyCount: 1, threshold: 3 }} />)
    expect(screen.getByText('About First Pick.')).toBeInTheDocument()
    expect(screen.getByText('Recently added')).toBeInTheDocument()
  })

  it("gives a child two actions and bigger words, and none of an adult's", () => {
    const onResume = vi.fn()
    const rec = record(10, 'Halfway House')
    render(<HeroSection {...base} hero={LEAD} kind="resume" kids resume={{ item: rec, onPlay: onResume }}
      onWatchTogether={vi.fn()} libraryIds={new Set()} onToggleLib={vi.fn()} onRefreshPicks={vi.fn()} onSurprise={vi.fn()} slate={SLATE} slateIndex={0} onPick={vi.fn()} />)
    expect(screen.getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Keep watching Halfway House', 'More about Halfway House'])
    fireEvent.click(screen.getByRole('button', { name: 'Keep watching Halfway House' }))
    expect(onResume).toHaveBeenCalledWith(rec)
    fireEvent.click(screen.getByRole('button', { name: 'More about Halfway House' }))
    expect(base.onInfo).toHaveBeenCalledWith(LEAD)
  })
})

describe('what the hero tells the recommender', () => {
  const picked = { ...base, kind: 'pick' as const, slateToken: 't'.repeat(32), profileId: 9 }

  it('reports a pick as seen, at its place in the slate, after a second and a half at least half on screen', async () => {
    vi.useFakeTimers()
    render(<HeroSection {...picked} hero={P3} slatePosition={2} />)
    onScreen(0.6)
    await act(async () => { await vi.advanceTimersByTimeAsync(1499) })
    expect(exposure).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(exposure).toHaveBeenCalledTimes(1)
    expect(exposure).toHaveBeenCalledWith({ slateToken: 't'.repeat(32), mediaItemId: 3, position: 2, visibleMs: 1500, profileId: 9 })
    // One report per showing, however long it stays up, and however often
    // the tab is left and come back to meanwhile.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    visibility.mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    onScreen(0)
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    visibility.mockRestore()
    expect(exposure).toHaveBeenCalledTimes(1)
  })

  it('reports a pick chosen from the filmstrip as a new showing, at that pick\'s own place', async () => {
    vi.useFakeTimers()
    const { rerender } = render(<HeroSection {...picked} hero={P1} slatePosition={0} slate={SLATE} slateIndex={1} onPick={vi.fn()} />)
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(exposure).toHaveBeenCalledTimes(1)
    rerender(<HeroSection {...picked} hero={P3} slatePosition={2} slate={SLATE} slateIndex={3} onPick={vi.fn()} />)
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(exposure).toHaveBeenCalledTimes(2)
    expect(exposure).toHaveBeenLastCalledWith({ slateToken: 't'.repeat(32), mediaItemId: 3, position: 2, visibleMs: 1500, profileId: 9 })
  })

  it('does not report a pick the viewer moved off before the time was up', async () => {
    vi.useFakeTimers()
    const { rerender } = render(<HeroSection {...picked} hero={P1} slatePosition={0} />)
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    rerender(<HeroSection {...picked} hero={P2} slatePosition={1} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    // The first was up for a second; the second has not been seen on screen
    // by its own observer yet.
    expect(exposure).not.toHaveBeenCalled()
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(exposure).toHaveBeenCalledTimes(1)
    expect(exposure).toHaveBeenCalledWith(expect.objectContaining({ mediaItemId: 2, position: 1 }))
  })

  // The server credits what the viewer watches afterwards to the exposure.
  // A title shown as "Pick up where you left off" is one they were already
  // watching, so it is never reported, whether or not Aurora picked it too.
  it('reports nothing for a title to resume, or for the catalog\'s fallback', async () => {
    vi.useFakeTimers()
    const lead = render(<HeroSection {...picked} kind="resume" hero={LEAD} slatePosition={undefined} />)
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    lead.unmount()
    // Even handed a place in the slate.
    const alsoPicked = render(<HeroSection {...picked} kind="resume" hero={P2} slatePosition={1} />)
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    alsoPicked.unmount()
    const fallback = render(<HeroSection {...picked} kind="catalog" hero={P1} slatePosition={0} />)
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    fallback.unmount()
    // No slate to report against.
    render(<HeroSection {...picked} slateToken={undefined} hero={P1} slatePosition={0} />)
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(exposure).not.toHaveBeenCalled()
  })

  it('does not count time less than half on screen, or in a hidden tab', async () => {
    vi.useFakeTimers()
    render(<HeroSection {...picked} hero={P1} slatePosition={0} />)
    onScreen(0.4)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(exposure).not.toHaveBeenCalled()

    onScreen(0.9)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(exposure).not.toHaveBeenCalled()
    // Back: the clock starts again from nothing.
    visibility.mockReturnValue('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1499) })
    expect(exposure).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(exposure).toHaveBeenCalledTimes(1)
    visibility.mockRestore()
  })

  it('asks once more when the server has not recorded the slate yet', async () => {
    vi.useFakeTimers()
    exposure.mockResolvedValueOnce(false)
    render(<HeroSection {...picked} hero={P1} slatePosition={0} />)
    onScreen(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(exposure).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(exposure).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(exposure).toHaveBeenCalledTimes(2)
  })
})

describe('what the hero tells the page', () => {
  const art = (container: HTMLElement) => container.querySelector<HTMLImageElement>('img.stage-hero-img.is-incoming')!
  /** Lets an answer that was asked for arrive. */
  const answered = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

  it("reports the picture's colour once it has loaded, with the picture, and once per picture", async () => {
    const onAmbient = vi.fn()
    const { container, rerender } = render(<HeroSection {...base} hero={P1} onAmbient={onAmbient} />)
    expect(onAmbient).not.toHaveBeenCalled()
    fireEvent.load(art(container))
    await answered()
    expect(onAmbient).toHaveBeenCalledTimes(1)
    expect(onAmbient).toHaveBeenCalledWith('rgb(10, 20, 30)', '/art/1.jpg')
    // Re-rendering, as the page does on every tick of anything, reports
    // nothing more: a report per render was a render per report.
    for (let i = 0; i < 5; i++) rerender(<HeroSection {...base} hero={P1} onAmbient={onAmbient} reason={`r${i}`} />)
    await answered()
    expect(onAmbient).toHaveBeenCalledTimes(1)

    ambient.mockReturnValue('rgb(40, 50, 60)')
    rerender(<HeroSection {...base} hero={P2} onAmbient={onAmbient} />)
    await answered()
    expect(onAmbient).toHaveBeenCalledTimes(1)
    fireEvent.load(art(container))
    await answered()
    expect(onAmbient).toHaveBeenCalledTimes(2)
    expect(onAmbient).toHaveBeenLastCalledWith('rgb(40, 50, 60)', '/art/2.jpg')
  })

  // The colour is answered later. By then the hero may be on another
  // picture: the first one's colour is not reported for it, nor at all.
  it('does not report a colour that arrives after the hero has moved to another picture', async () => {
    const onAmbient = vi.fn()
    const { container, rerender } = render(<HeroSection {...base} hero={P1} onAmbient={onAmbient} />)
    fireEvent.load(art(container))
    // Asked, not yet answered: the hero changes, and the new picture loads.
    ambient.mockReturnValue('rgb(40, 50, 60)')
    rerender(<HeroSection {...base} hero={P2} onAmbient={onAmbient} />)
    fireEvent.load(art(container))
    await answered()
    expect(onAmbient.mock.calls.map(c => c[1])).toEqual(['/art/2.jpg'])
  })

  it('reports a picture served from cache once, however often the hero renders', async () => {
    // A cached image is complete before its load handler is attached, so the
    // hero also reads it from a ref callback, which runs on every render.
    // Reporting from there each time made the page set state per render,
    // which re-rendered the hero: React stopped the loop with an error.
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
    const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1280)
    try {
      const onAmbient = vi.fn()
      const { rerender } = render(<HeroSection {...base} hero={P1} onAmbient={onAmbient} />)
      for (let i = 0; i < 5; i++) rerender(<HeroSection {...base} hero={P1} onAmbient={onAmbient} reason={`r${i}`} />)
      await answered()
      expect(onAmbient).toHaveBeenCalledTimes(1)
      expect(onAmbient).toHaveBeenCalledWith('rgb(10, 20, 30)', '/art/1.jpg')
      expect(ambient).toHaveBeenCalledTimes(1)
    } finally {
      complete.mockRestore()
      width.mockRestore()
    }
  })

  it('reports no colour for a picture that failed, by name', () => {
    const onAmbient = vi.fn()
    const { container } = render(<HeroSection {...base} hero={P1} onAmbient={onAmbient} />)
    fireEvent.error(art(container))
    expect(onAmbient).toHaveBeenCalledTimes(1)
    expect(onAmbient).toHaveBeenCalledWith(null, '/art/1.jpg')
    expect(container.querySelector('img.stage-hero-img')).toBeNull()
  })
})
