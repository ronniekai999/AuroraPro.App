// @vitest-environment jsdom
//
// Collections: the index (a grid of collections, with the count and "New
// collection" handed to the Library header's row) and a collection's own
// page.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import type { Collection, ServerMediaItem } from '@/lib/api'

const api = vi.hoisted(() => ({
  listCollections: vi.fn<() => Promise<unknown[]>>(),
  getCollection: vi.fn<(id: number) => Promise<{ items: unknown[] | null }>>(),
  deleteCollection: vi.fn<(id: number) => Promise<void>>(),
}))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  listCollections: api.listCollections,
  getCollection: api.getCollection,
  deleteCollection: api.deleteCollection,
}))

import { APIError } from '@/lib/api'
import CollectionsView from './CollectionsView'
import { LibraryHeader, LibraryToolsProvider } from './LibraryHeader'

const NOW = '2026-10-01T00:00:00Z'
const col = (id: number, name: string, over: Partial<Collection> = {}): Collection => ({
  id, owner_user_id: 1, name, kind: 'manual', is_public: false, item_count: 3, created_at: NOW, updated_at: NOW, ...over,
} as Collection)
const item = (id: number, title: string) => ({ id, library_id: 1, type: 'movie', title, year: 2020, added_at: NOW, updated_at: NOW }) as unknown as ServerMediaItem
const noop = () => {}

function Page({ isAdmin = false, onOpenCreate = noop, open, onOpenTaken, rewindNonce }: {
  isAdmin?: boolean; onOpenCreate?: () => void
  open?: { id: number; n: number } | null; onOpenTaken?: () => void; rewindNonce?: number
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <>
      <LibraryHeader current="collections" navScope="full" onNavigate={noop} toolsRef={setSlot} />
      <LibraryToolsProvider value={slot}>
        <main><CollectionsView isAdmin={isAdmin} onOpenCreate={onOpenCreate} onOpenMedia={noop} onCardContext={noop} open={open} onOpenTaken={onOpenTaken} rewindNonce={rewindNonce} /></main>
      </LibraryToolsProvider>
    </>
  )
}
const header = () => document.querySelector<HTMLElement>('[data-library-header]')!

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  api.listCollections.mockResolvedValue([
    col(1, 'Space, but make it sad', { kind: 'ai', prompt: 'sad science fiction', is_public: true, item_count: 9, poster_paths: ['/a.jpg', '/b.jpg', '/c.jpg', '/d.jpg'], description: 'For rainy nights.' }),
    col(2, 'Best of 2026', { item_count: 1, poster_paths: ['/e.jpg'] }),
    col(3, 'Empty One', { item_count: 0 }),
  ])
  api.getCollection.mockResolvedValue({ items: [item(11, 'Kestrel'), item(12, 'Static Bloom')] })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('the collections index', () => {
  it('puts its count and "New collection" in the Library header\'s row, and has no heading block of its own', async () => {
    const onOpenCreate = vi.fn()
    render(<Page onOpenCreate={onOpenCreate} />)
    await screen.findByText('Best of 2026')
    expect(within(header()).getByRole('status').textContent).toBe('3 collections')
    fireEvent.click(within(header()).getByRole('button', { name: 'New collection' }))
    expect(onOpenCreate).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Collections'])
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('sr-only')
  })

  it('has its heading while the list is still loading', () => {
    api.listCollections.mockReturnValue(new Promise(() => {}))
    render(<Page />)
    expect(screen.getByRole('status').textContent).toBe('Loading collections…')
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Collections'])
  })

  it('says one collection in the singular', async () => {
    api.listCollections.mockResolvedValue([col(1, 'Only')])
    render(<Page />)
    await screen.findByText('Only')
    expect(within(header()).getByRole('status').textContent).toBe('1 collection')
  })

  it('draws each as its posters, its name, and one line of facts in words', async () => {
    render(<Page />)
    await screen.findByText('Best of 2026')
    const cards = screen.getAllByRole('listitem')
    const facts = (name: string) => cards.find(c => c.querySelector('.stage-colcard-name')?.textContent === name)!.querySelector('.stage-colcard-meta')!.textContent
    expect(facts('Space, but make it sad')).toBe('9 titles · built by Aurora · public')
    expect(facts('Best of 2026')).toBe('1 title · private')
    expect(facts('Empty One')).toBe('0 titles · private')
    // Aurora's mark is on the one she filled, and only there.
    expect(cards.map(c => !!c.querySelector('.aurora-dot'))).toEqual([true, false, false])
    // As many strips as the collection has posters to show, up to four.
    expect(cards.map(c => c.querySelectorAll('.stage-colcard-art img').length)).toEqual([4, 1, 0])
    // The whole of it is the button's name; the posters are decoration.
    expect(screen.getByRole('button', { name: 'Open collection Space, but make it sad, 9 titles, built by Aurora, public' })).toBeInTheDocument()
    expect(cards[0].querySelector('.stage-colcard-art')).toHaveAttribute('aria-hidden', 'true')
  })

  it('offers delete to an admin only, as a button beside the one that opens the collection', async () => {
    const { unmount } = render(<Page />)
    await screen.findByText('Best of 2026')
    expect(screen.queryByRole('button', { name: /^Delete collection/ })).toBeNull()
    unmount()
    render(<Page isAdmin />)
    await screen.findByText('Best of 2026')
    const del = screen.getByRole('button', { name: 'Delete collection Best of 2026' })
    const open = screen.getByRole('button', { name: /^Open collection Best of 2026/ })
    expect(open.contains(del)).toBe(false)
    expect(del.parentElement).toBe(open.parentElement)
  })

  it('says so when there are none, and when they cannot be loaded, in words', async () => {
    api.listCollections.mockResolvedValue([])
    const { unmount } = render(<Page />)
    expect(await screen.findByRole('heading', { name: 'No collections yet' })).toBeInTheDocument()
    expect(within(header()).getByRole('status').textContent).toBe('0 collections')
    unmount()
    api.listCollections.mockRejectedValue(new Error('HTTP 500'))
    render(<Page />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Collections could not be loaded. Reload the page to try again.')
    // The page still has its heading when it has nothing else.
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Collections'])
    expect(document.body.textContent).not.toContain('500')
  })
})

describe('a collection\'s own page', () => {
  async function open(name: string) {
    render(<Page />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^Open collection ${name}`) }))
    return screen.findByRole('heading', { level: 1, name })
  }
  const facts = () => document.querySelector('[data-collection-facts]')!.textContent

  it('is headed by its name, with who filled it and from what, how many titles, and who can see it', async () => {
    await open('Space, but make it sad')
    await screen.findByText('Kestrel')
    expect(facts()).toBe('Built by Aurora from “sad science fiction” · 2 titles · public')
    expect(document.querySelector('[data-collection-facts] .aurora-dot')).not.toBeNull()
    expect(screen.getByText('For rainy nights.')).toBeInTheDocument()
    // One heading: the index's is gone with the index.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    // Nothing of the index's controls is left in the header.
    expect(within(header()).queryByRole('button', { name: 'New collection' })).toBeNull()
  })

  it('says only what is true of a collection made by hand', async () => {
    await open('Best of 2026')
    await screen.findByText('Kestrel')
    expect(facts()).toBe('2 titles · private')
    expect(document.querySelector('[data-collection-facts] .aurora-dot')).toBeNull()
  })

  it('goes back to the index from its Back button, which takes the focus on arrival', async () => {
    await open('Best of 2026')
    const back = screen.getByRole('button', { name: 'Back to collections' })
    // What it shows is the word, with an arrow.
    expect(back.textContent).toBe('Collections')
    expect(document.activeElement).toBe(back)
    fireEvent.click(back)
    expect(await screen.findByText('Empty One')).toBeInTheDocument()
    expect(within(header()).getByRole('status').textContent).toBe('3 collections')
  })

  // A server that answers an empty collection with no list at all.
  it('reads a missing list of titles as an empty collection', async () => {
    api.getCollection.mockResolvedValue({ items: null })
    await open('Empty One')
    expect(await screen.findByText('This collection is empty.')).toBeInTheDocument()
    expect(facts()).toBe('0 titles · private')
  })
})

// A collection picked on the search page: Collections opens on it.
describe('opened on a collection picked elsewhere', () => {
  it('shows that collection\'s own page, once per ask, and says the ask was taken', async () => {
    const onOpenTaken = vi.fn()
    const view = render(<Page open={{ id: 2, n: 1 }} onOpenTaken={onOpenTaken} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Best of 2026' })).toBeInTheDocument()
    expect(api.getCollection).toHaveBeenCalledTimes(1)
    expect(api.getCollection.mock.calls[0][0]).toBe(2)
    expect(onOpenTaken).toHaveBeenCalledTimes(1)
    // Back to the index; the same ask does not open it again.
    fireEvent.click(screen.getByRole('button', { name: 'Back to collections' }))
    view.rerender(<Page open={{ id: 2, n: 1 }} onOpenTaken={onOpenTaken} />)
    expect(screen.queryByRole('heading', { level: 1, name: 'Best of 2026' })).toBeNull()
    expect(await screen.findByText('Empty One')).toBeInTheDocument()
    // A new ask does.
    view.rerender(<Page open={{ id: 1, n: 2 }} onOpenTaken={onOpenTaken} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Space, but make it sad' })).toBeInTheDocument()
    expect(api.getCollection.mock.calls[1][0]).toBe(1)
  })

  // The rewind counter is the app's, one for every destination: by the time
  // this page mounts it may be well above zero (a nav item was pressed
  // again somewhere earlier). That is not a press made here, and must not
  // send the page back to the index it was just opened past.
  it('opens on the collection though a nav item was re-pressed earlier in the session', async () => {
    const view = render(<Page open={{ id: 2, n: 1 }} rewindNonce={3} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Best of 2026' })).toBeInTheDocument()
    // A press made now does go back to the index.
    view.rerender(<Page open={{ id: 2, n: 1 }} rewindNonce={4} />)
    expect(await screen.findByText('Empty One')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: 'Best of 2026' })).toBeNull()
  })

  it('goes back to the index when the Collections nav item is pressed again, from a collection opened by hand', async () => {
    const view = render(<Page rewindNonce={0} />)
    fireEvent.click(await screen.findByRole('button', { name: /Best of 2026/ }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Best of 2026' })).toBeInTheDocument()
    view.rerender(<Page rewindNonce={1} />)
    expect(await screen.findByText('Empty One')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: 'Best of 2026' })).toBeNull()
  })

  it('opens on the index when there is no ask', async () => {
    render(<Page open={null} />)
    expect(await screen.findByText('Best of 2026')).toBeInTheDocument()
    expect(api.getCollection).not.toHaveBeenCalled()
  })
})

// A delete the server refused said "Delete failed: " and the server's own
// words in the dialog. It says it in the app's.
describe('a collection\'s delete that fails', () => {
  it('is said in the dialog in the app\'s words, not the server\'s', async () => {
    api.deleteCollection.mockRejectedValue(new APIError(500, 'pq: deadlock detected', { error: { code: 500, message: 'pq: deadlock detected' } }))
    render(<Page isAdmin />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete collection Best of 2026' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const said = await screen.findByRole('alert')
    expect(said.textContent).toBe('Could not delete the collection just now.')
    expect(document.body.textContent).not.toContain('deadlock')
  })
})
