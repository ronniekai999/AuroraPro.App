// @vitest-environment jsdom
//
// useExitTransition — the keep-mounted-for-the-exit contract every overlay
// now relies on. Two of these are load-bearing for existing behaviour: the
// re-open case is what partyPanelLeave.test exercises through PartyPanel
// (close and re-open the same confirm inside one test), and the
// reduced-motion case is what keeps a stilled exit from stranding a surface.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useExitTransition } from './useExitTransition'

describe('useExitTransition', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts unmounted when initially closed, mounts as soon as it opens', () => {
    const { result, rerender } = renderHook(({ open }) => useExitTransition(open, 150), {
      initialProps: { open: false },
    })
    expect(result.current).toEqual({ mounted: false, closing: false })
    rerender({ open: true })
    expect(result.current).toEqual({ mounted: true, closing: false })
  })

  it('stays mounted and closing for the duration after close, then unmounts', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ open }) => useExitTransition(open, 150), {
      initialProps: { open: true },
    })
    rerender({ open: false })
    expect(result.current).toEqual({ mounted: true, closing: true })
    act(() => { vi.advanceTimersByTime(149) })
    expect(result.current.mounted).toBe(true)
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current).toEqual({ mounted: false, closing: false })
  })

  it('re-open during the exit cancels the pending unmount', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ open }) => useExitTransition(open, 150), {
      initialProps: { open: true },
    })
    rerender({ open: false })
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current.closing).toBe(true)
    rerender({ open: true })
    expect(result.current).toEqual({ mounted: true, closing: false })
    // The original timer must not fire late and unmount an open surface.
    act(() => { vi.advanceTimersByTime(500) })
    expect(result.current).toEqual({ mounted: true, closing: false })
  })

  it('unmounts immediately under prefers-reduced-motion (no exit to wait for)', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const { result, rerender } = renderHook(({ open }) => useExitTransition(open, 150), {
      initialProps: { open: true },
    })
    rerender({ open: false })
    expect(result.current).toEqual({ mounted: false, closing: false })
  })

  it('a zero duration unmounts immediately as well', () => {
    const { result, rerender } = renderHook(({ open }) => useExitTransition(open, 0), {
      initialProps: { open: true },
    })
    rerender({ open: false })
    expect(result.current).toEqual({ mounted: false, closing: false })
  })
})
