import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG_UPDATE_DELAY_MS,
  createCatalogUpdateScheduler,
  loadedPageCount,
  refetchLoadedPages,
} from './catalogUpdates'

describe('createCatalogUpdateScheduler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('turns a burst of events into one refresh after the delay', () => {
    const onFlush = vi.fn()
    const s = createCatalogUpdateScheduler({ onFlush, isHidden: () => false })
    s.notify()
    vi.advanceTimersByTime(CATALOG_UPDATE_DELAY_MS - 1)
    s.notify()
    s.notify()
    expect(onFlush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('starts a new refresh for an event after the last one flushed', () => {
    const onFlush = vi.fn()
    const s = createCatalogUpdateScheduler({ onFlush, isHidden: () => false })
    s.notify()
    vi.advanceTimersByTime(CATALOG_UPDATE_DELAY_MS)
    s.notify()
    vi.advanceTimersByTime(CATALOG_UPDATE_DELAY_MS)
    expect(onFlush).toHaveBeenCalledTimes(2)
  })

  it('holds a refresh due while hidden until the tab is visible, once', () => {
    let hidden = true
    const onFlush = vi.fn()
    const s = createCatalogUpdateScheduler({ onFlush, isHidden: () => hidden })
    s.notify()
    vi.advanceTimersByTime(CATALOG_UPDATE_DELAY_MS)
    s.notify()
    vi.advanceTimersByTime(CATALOG_UPDATE_DELAY_MS)
    expect(onFlush).not.toHaveBeenCalled()
    s.visible() // still hidden: nothing
    expect(onFlush).not.toHaveBeenCalled()
    hidden = false
    s.visible()
    s.visible()
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('does nothing on visible when no refresh was held', () => {
    const onFlush = vi.fn()
    const s = createCatalogUpdateScheduler({ onFlush, isHidden: () => false })
    s.visible()
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('flushes nothing after dispose', () => {
    const onFlush = vi.fn()
    const s = createCatalogUpdateScheduler({ onFlush, isHidden: () => false })
    s.notify()
    s.dispose()
    vi.advanceTimersByTime(CATALOG_UPDATE_DELAY_MS * 2)
    s.notify()
    s.visible()
    vi.advanceTimersByTime(CATALOG_UPDATE_DELAY_MS * 2)
    expect(onFlush).not.toHaveBeenCalled()
  })
})

describe('loadedPageCount', () => {
  it('counts the pages a list has fetched, at least one', () => {
    expect(loadedPageCount(0, 100)).toBe(1)
    expect(loadedPageCount(1, 100)).toBe(1)
    expect(loadedPageCount(100, 100)).toBe(1)
    expect(loadedPageCount(101, 100)).toBe(2)
    expect(loadedPageCount(250, 100)).toBe(3)
  })
})

describe('refetchLoadedPages', () => {
  const page = (ids: number[], total: number) => ({ items: ids.map(id => ({ id })), total })

  it('refetches pages 1..n in order and moves the cursor past them', async () => {
    const fetchPage = vi.fn(async (p: number) =>
      p === 1 ? page([1, 2], 5) : p === 2 ? page([3, 4], 5) : page([5], 5))
    const got = await refetchLoadedPages(fetchPage, 3)
    expect(fetchPage.mock.calls.map(c => c[0])).toEqual([1, 2, 3])
    expect(got.items.map(i => i.id)).toEqual([1, 2, 3, 4, 5])
    expect(got.total).toBe(5)
    expect(got.nextPage).toBe(4)
  })

  it('keeps the first copy of a title that crossed a page boundary between requests', async () => {
    const fetchPage = async (p: number) => (p === 1 ? page([1, 2], 4) : page([2, 3], 4))
    const got = await refetchLoadedPages(fetchPage, 2)
    expect(got.items.map(i => i.id)).toEqual([1, 2, 3])
  })

  it('rejects when any page fails, so the caller keeps its list', async () => {
    const fetchPage = async (p: number) => {
      if (p === 2) throw new Error('boom')
      return page([1], 2)
    }
    await expect(refetchLoadedPages(fetchPage, 2)).rejects.toThrow('boom')
  })
})
