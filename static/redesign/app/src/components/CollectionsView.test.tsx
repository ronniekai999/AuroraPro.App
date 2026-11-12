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
}))
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  listCollections: api.listCollections,
  getCollection: api.getCollection,
}))

import CollectionsView from './CollectionsView'
import { LibraryHeader, LibraryToolsProvider } from './LibraryHeader'

const NOW = '2026-10-01T00:00:00Z'
const col = (id: number, name: string, over: Partial<Collection> = {}): Collection => ({
  id, owner_user_id: 1, name, kind: 'manual', is_public: false, item_count: 3, created_at: NOW, updated_at: NOW, ...over,
} as Collection)
const item = (id: number, title: string) => ({ id, library_id: 1, type: 'movie', title, year: 2020, added_at: NOW, updated_at: NOW }) as unknown as ServerMediaItem
const noop = () => {}

function Page({ isAdmin = false, onOpenCreate = noop }: { isAdmin?: boolean; onOpenCreate?: () => void }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return (
    <>
      <LibraryHeader current="collections" navScope="full" onNavigate={noop} toolsRef={setSlot} />
      <LibraryToolsProvider value={slot}>
        <main><CollectionsView isAdmin={isAdmin} onOpenCreate={onOpenCreate} onOpenMedia={noop} onCardContext={noop} /></main>
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
