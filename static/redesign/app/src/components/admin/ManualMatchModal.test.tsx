// @vitest-environment jsdom

import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MatchSearchResult, ServerMediaItem } from '@/lib/api'

const searchForMatch = vi.fn<(q: string, type: 'movie' | 'show', signal?: AbortSignal) => Promise<MatchSearchResult[]>>()
const manualMatch = vi.fn<(id: number, body: { tmdb_id?: number; tvdb_id?: number; type: 'movie' | 'show' }, signal?: AbortSignal) => Promise<void>>()
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  searchForMatch: (...a: Parameters<typeof searchForMatch>) => searchForMatch(...a),
  manualMatch: (...a: Parameters<typeof manualMatch>) => manualMatch(...a),
}))

import ManualMatchModal from './ManualMatchModal'

const FILM = {
  id: 41,
  title: 'Kestrel',
  type: 'movie',
  file_path: '/media/films/Kestrel (2019)/kestrel.mkv',
} as ServerMediaItem
const SHOW = { ...FILM, id: 52, title: 'Harbour Lights', type: 'show', file_path: '/media/tv/Harbour Lights' } as ServerMediaItem

const CANDIDATES: MatchSearchResult[] = [
  { source: 'tmdb', id: 900, title: 'Kestrel', year: 2019, overview: 'A falconer goes north.', poster_path: '/k.jpg' },
  { source: 'tmdb', id: 901, title: 'Kestrel', year: 1987, overview: '', poster_path: '' },
] as MatchSearchResult[]

// A caller as the app has it: a button that sets the item, and the dialog
// mounted only while one is set.
function Harness({ item = FILM, onMatched = vi.fn(), onClose = vi.fn() }: {
  item?: ServerMediaItem
  onMatched?: () => void
  onClose?: (matchInFlight?: boolean) => void
}) {
  const [target, setTarget] = useState<ServerMediaItem | null>(null)
  return (
    <div>
      <button type="button" onClick={() => setTarget(item)}>Identify</button>
      {target && (
        <ManualMatchModal
          target={target}
          onClose={matchInFlight => { setTarget(null); onClose(matchInFlight) }}
          onMatched={() => { setTarget(null); onMatched() }}
        />
      )}
    </div>
  )
}

async function open(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: 'Identify' }))
  return screen.findByRole('dialog', { name })
}

describe('ManualMatchModal', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    searchForMatch.mockReset().mockResolvedValue(CANDIDATES)
    manualMatch.mockReset().mockResolvedValue(undefined)
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
  })
  afterEach(() => { alertSpy.mockRestore() })

  it('is a dialog named for the item and described by its file, and searches for its title', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await open(user, 'Match “Kestrel”')
    expect(dialog).toHaveAccessibleDescription('/media/films/Kestrel (2019)/kestrel.mkv')
    const field = within(dialog).getByRole('searchbox', { name: 'Search TMDB for the film' })
    expect(field).toHaveValue('Kestrel')
    await waitFor(() => expect(searchForMatch).toHaveBeenCalledTimes(1))
    expect(searchForMatch.mock.calls[0].slice(0, 2)).toEqual(['Kestrel', 'movie'])
    // Each candidate's button says which candidate it is.
    expect(await within(dialog).findByRole('button', { name: 'Match Kestrel (2019), from TMDB' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Match Kestrel (1987), from TMDB' })).toBeInTheDocument()
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 found.')
    // A TMDB poster is a path: it gets the image host in front.
    const poster = dialog.querySelector('img')
    expect(poster?.getAttribute('src')).toMatch(/^https?:\/\/.+\/k\.jpg$/)
  })

  it('posts the candidate picked and hands back to the caller, with no browser alert', async () => {
    const user = userEvent.setup()
    const onMatched = vi.fn()
    render(<Harness onMatched={onMatched} />)
    const dialog = await open(user, 'Match “Kestrel”')
    await user.click(await within(dialog).findByRole('button', { name: 'Match Kestrel (1987), from TMDB' }))
    await waitFor(() => expect(onMatched).toHaveBeenCalledTimes(1))
    expect(manualMatch.mock.calls[0].slice(0, 2)).toEqual([41, { tmdb_id: 901, type: 'movie' }])
    expect(alertSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('says a refused match in the dialog and keeps the candidates for another try', async () => {
    const user = userEvent.setup()
    const onMatched = vi.fn()
    manualMatch.mockRejectedValueOnce(new Error('TMDB did not answer'))
    render(<Harness onMatched={onMatched} />)
    const dialog = await open(user, 'Match “Kestrel”')
    const pick = await within(dialog).findByRole('button', { name: 'Match Kestrel (2019), from TMDB' })
    await user.click(pick)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The match was not saved: TMDB did not answer')
    expect(alertSpy).not.toHaveBeenCalled()
    expect(onMatched).not.toHaveBeenCalled()
    // The button pressed is still there, still focused, and works again.
    expect(pick).toHaveFocus()
    await user.click(pick)
    await waitFor(() => expect(onMatched).toHaveBeenCalledTimes(1))
    expect(manualMatch).toHaveBeenCalledTimes(2)
  })

  it('sends one match for a double press', async () => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    manualMatch.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const onMatched = vi.fn()
    render(<Harness onMatched={onMatched} />)
    const dialog = await open(user, 'Match “Kestrel”')
    const pick = await within(dialog).findByRole('button', { name: 'Match Kestrel (2019), from TMDB' })
    await user.click(pick)
    await user.click(pick)
    await user.click(within(dialog).getByRole('button', { name: 'Match Kestrel (1987), from TMDB' }))
    expect(manualMatch).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(onMatched).toHaveBeenCalledTimes(1))
  })

  // A server that does not answer must not hold anyone in the dialog. A
  // match closed on may have been saved all the same: the caller is told so
  // (and reads again what it shows), and the dropped request's answer,
  // whichever it is, reports nothing.
  it.each([
    ['Escape', 'answers late'],
    ['Escape', 'fails late'],
    ['Close', 'answers late'],
  ])('can be closed with %s while a match is being sent, and the match that %s reports nothing', async (how, late) => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    let fail: (e: Error) => void = () => {}
    manualMatch.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject }))
    const onMatched = vi.fn()
    const onClose = vi.fn()
    render(<Harness onMatched={onMatched} onClose={onClose} />)
    const opener = screen.getByRole('button', { name: 'Identify' })
    const dialog = await open(user, 'Match “Kestrel”')
    await user.click(await within(dialog).findByRole('button', { name: 'Match Kestrel (2019), from TMDB' }))
    const signal = manualMatch.mock.calls[0][2]
    expect(signal?.aborted).toBe(false)
    if (how === 'Escape') await user.keyboard('{Escape}')
    else await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(true)
    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(opener).toHaveFocus())
    if (late === 'answers late') finish()
    else fail(new Error('boom'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(onMatched).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // A list's row leaves when its item is matched, and can be gone before the
  // dialog is: the caller says where the focus goes then.
  it('gives the focus to the caller\'s fallback when what opened it has gone by the time it closes', async () => {
    const user = userEvent.setup()
    function Rows() {
      const [open, setOpen] = useState(false)
      const [matched, setMatched] = useState(false)
      return (
        <div>
          <ul id="rows" tabIndex={-1}>
            {!matched && <li><button type="button" onClick={() => setOpen(true)}>Identify</button></li>}
          </ul>
          {open && (
            <ManualMatchModal
              target={FILM}
              fallbackFocus={() => document.getElementById('rows')}
              onClose={() => setOpen(false)}
              // The row goes in the same commit as the dialog.
              onMatched={() => { setMatched(true); setOpen(false) }}
            />
          )}
        </div>
      )
    }
    render(<Rows />)
    await user.click(screen.getByRole('button', { name: 'Identify' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(await within(dialog).findByRole('button', { name: 'Match Kestrel (2019), from TMDB' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Identify' })).toBeNull()
    await waitFor(() => expect(document.getElementById('rows')).toHaveFocus())
  })

  it('tells the caller nothing was in flight when it is closed at rest, also after a refused match', async () => {
    const user = userEvent.setup()
    manualMatch.mockRejectedValueOnce(new Error('TMDB did not answer'))
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const dialog = await open(user, 'Match “Kestrel”')
    await user.click(await within(dialog).findByRole('button', { name: 'Match Kestrel (2019), from TMDB' }))
    await within(dialog).findByText(/The match was not saved/)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onClose).toHaveBeenCalledWith(false)
  })

  // The search: what one search finds must not be reported as the next
  // one's, and a field emptied before the search has started is not one.
  it('does not stay on "Searching…" when the field is emptied before the search starts', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const dialog = await open(user, 'Match “Kestrel”')
    await within(dialog).findByRole('button', { name: 'Match Kestrel (2019), from TMDB' })
    const field = within(dialog).getByRole('searchbox')
    fireEvent.change(field, { target: { value: 'Kes' } })
    expect(within(dialog).getByRole('status')).toHaveTextContent('Searching…')
    fireEvent.change(field, { target: { value: '' } })
    expect(within(dialog).getByRole('status')).not.toHaveTextContent('Searching…')
    expect(within(dialog).queryByRole('button', { name: /^Match Kestrel/ })).toBeNull()
    expect(searchForMatch).toHaveBeenCalledTimes(1)
  })

  it('keeps "Searching…" up for the newer search when the one before it is dropped', async () => {
    const user = userEvent.setup()
    // The first search never answers by itself: it is aborted by the second.
    searchForMatch.mockReset()
    searchForMatch.mockImplementationOnce((_q, _t, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    let found: (r: MatchSearchResult[]) => void = () => {}
    searchForMatch.mockImplementationOnce(() => new Promise(resolve => { found = resolve }))
    render(<Harness />)
    const dialog = await open(user, 'Match “Kestrel”')
    await waitFor(() => expect(searchForMatch).toHaveBeenCalledTimes(1))
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'Kestrel 2019' } })
    await waitFor(() => expect(searchForMatch).toHaveBeenCalledTimes(2))
    // The dropped search's rejection has run by now: it says nothing.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(within(dialog).getByRole('status')).toHaveTextContent('Searching…')
    expect(within(dialog).queryByText(/Nothing found/)).toBeNull()
    await act(async () => { found(CANDIDATES) })
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 found.')
  })

  it('says a search that failed failed, not that nothing was found', async () => {
    const user = userEvent.setup()
    searchForMatch.mockReset().mockRejectedValue(new Error('upstream'))
    render(<Harness />)
    const dialog = await open(user, 'Match “Kestrel”')
    expect(await within(dialog).findByText('The search could not be run. Try again, or match by the id below.')).toHaveAttribute('role', 'status')
    expect(within(dialog).queryByText(/Nothing found/)).toBeNull()
    // The next search starts clean.
    searchForMatch.mockResolvedValue([])
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'Kestrel again' } })
    expect(await within(dialog).findByText(/Nothing found\./)).toBeInTheDocument()
    expect(within(dialog).queryByText(/could not be run/)).toBeNull()
  })

  it('matches by an id typed in, and only once it is a number', async () => {
    const user = userEvent.setup()
    const onMatched = vi.fn()
    render(<Harness onMatched={onMatched} />)
    const dialog = await open(user, 'Match “Kestrel”')
    const byId = within(dialog).getByRole('button', { name: 'Match by id' })
    expect(byId).toHaveAttribute('aria-disabled', 'true')
    await user.click(byId)
    expect(manualMatch).not.toHaveBeenCalled()
    const id = within(dialog).getByRole('textbox', { name: 'Id' })
    await user.type(id, '12a')
    expect(byId).toHaveAttribute('aria-disabled', 'true')
    await user.clear(id)
    await user.type(id, ' 603 ')
    expect(byId).toHaveAttribute('aria-disabled', 'false')
    // A film has no TVDB entry to match.
    const source = within(dialog).getByRole('combobox', { name: 'Where the id is from' })
    expect(within(source).queryByRole('option', { name: 'TVDB' })).toBeNull()
    await user.click(byId)
    await waitFor(() => expect(onMatched).toHaveBeenCalledTimes(1))
    expect(manualMatch.mock.calls[0].slice(0, 2)).toEqual([41, { tmdb_id: 603, type: 'movie' }])
  })

  it('offers TVDB for a show and sends its id as a TVDB id', async () => {
    const user = userEvent.setup()
    searchForMatch.mockResolvedValue([])
    const onMatched = vi.fn()
    render(<Harness item={SHOW} onMatched={onMatched} />)
    const dialog = await open(user, 'Match “Harbour Lights”')
    expect(within(dialog).getByRole('searchbox', { name: 'Search TMDB or TVDB for the show' })).toHaveValue('Harbour Lights')
    await waitFor(() => expect(searchForMatch.mock.calls[0]?.slice(0, 2)).toEqual(['Harbour Lights', 'show']))
    expect(await within(dialog).findByText(/Nothing found\./)).toBeInTheDocument()
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Where the id is from' }), 'TVDB')
    await user.type(within(dialog).getByRole('textbox', { name: 'Id' }), '7781')
    await user.click(within(dialog).getByRole('button', { name: 'Match by id' }))
    await waitFor(() => expect(onMatched).toHaveBeenCalledTimes(1))
    expect(manualMatch.mock.calls[0].slice(0, 2)).toEqual([52, { tvdb_id: 7781, type: 'show' }])
  })

  it('keeps focus inside, closes on Escape and on Close, and gives focus back to what opened it', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Identify' })
    const dialog = await open(user, 'Match “Kestrel”')
    expect(dialog.contains(document.activeElement)).toBe(true)
    for (let i = 0; i < 12; i++) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(opener).toHaveFocus())
    expect(manualMatch).not.toHaveBeenCalled()

    const again = await open(user, 'Match “Kestrel”')
    await user.click(within(again).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(opener).toHaveFocus())
  })
})
