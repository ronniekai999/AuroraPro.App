// @vitest-environment jsdom
//
// The app passes `held` while the player is open: a refresh due then waits,
// and one runs when the player closes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { CATALOG_UPDATE_DELAY_MS } from '@/lib/catalogUpdates'
import { useCatalogVersion } from './useCatalogVersion'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useCatalogVersion', () => {
  it('moves the version once per coalesced batch, the ref first', () => {
    const { result } = renderHook(() => useCatalogVersion())
    expect(result.current.catalogVersion).toBe(0)
    act(() => {
      result.current.notifyCatalogChanged()
      result.current.notifyCatalogChanged()
    })
    act(() => { vi.advanceTimersByTime(CATALOG_UPDATE_DELAY_MS) })
    expect(result.current.catalogVersion).toBe(1)
    expect(result.current.catalogVersionRef.current).toBe(1)
  })

  it('holds a refresh while held and runs one when released', () => {
    const { result, rerender } = renderHook(({ held }) => useCatalogVersion({ held }), {
      initialProps: { held: true },
    })
    act(() => { result.current.notifyCatalogChanged() })
    act(() => { vi.advanceTimersByTime(CATALOG_UPDATE_DELAY_MS * 10) })
    expect(result.current.catalogVersion).toBe(0)
    rerender({ held: false })
    act(() => { vi.advanceTimersByTime(0) })
    expect(result.current.catalogVersion).toBe(1)
  })
})
