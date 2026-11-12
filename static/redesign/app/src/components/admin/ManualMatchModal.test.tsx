// @vitest-environment jsdom

import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MatchSearchResult, ServerMediaItem } from '@/lib/api'

const searchForMatch = vi.fn<(q: string, type: 'movie' | 'show', signal?: AbortSignal) => Promise<MatchSearchResult[]>>()
const manualMatch = vi.fn<(id: number, body: { tmdb_id?: number; tvdb_id?: number; type: 'movie' | 'show' }) => Promise<void>>()
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
function Harness({ item = FILM, onMatched = vi.fn() }: { item?: ServerMediaItem; onMatched?: () => void }) {
  const [target, setTarget] = useState<ServerMediaItem | null>(null)
  return (
    <div>
      <button type="button" onClick={() => setTarget(item)}>Identify</button>
      {target && (
        <ManualMatchModal
          target={target}
          onClose={() => setTarget(null)}
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
    expect(manualMatch).toHaveBeenCalledWith(41, { tmdb_id: 901, type: 'movie' })
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
    // Escape waits for the answer too: the write is not left running
    // behind a closed dialog.
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    finish()
    await waitFor(() => expect(onMatched).toHaveBeenCalledTimes(1))
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
    expect(manualMatch).toHaveBeenCalledWith(41, { tmdb_id: 603, type: 'movie' })
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
    expect(manualMatch).toHaveBeenCalledWith(52, { tvdb_id: 7781, type: 'show' })
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
