// @vitest-environment jsdom
//
// ScanProgressBar's completion signal.
//
// The bar used to be purely decorative — it polled, drew itself, and told
// nobody. Home loads once and keeps its rails in component state, so a scan
// could add titles and the user would keep seeing the pre-scan library until a
// hard refresh. This asserts the edge the fix depends on: exactly one
// notification, on the running → idle transition, and never while a scan is
// merely in progress.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { ScanProgressBar } from './ScanProgressBar'

const listLibraries = vi.hoisted(() => vi.fn())
const getScanStatus = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ listLibraries, getScanStatus }))

const LIB = { id: 1, name: 'Movies', type: 'movie', path: '/m' }
const status = (s: string) => ({ status: s, total_files: 10, scanned_files: s === 'running' ? 5 : 10 })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  listLibraries.mockResolvedValue([LIB])
  getScanStatus.mockReset()
})
afterEach(() => vi.useRealTimers())

/** Advance past one 4s poll tick and let its promises settle. */
const tick = async () => {
  await vi.advanceTimersByTimeAsync(4100)
}

describe('ScanProgressBar — scan completion signal', () => {
  it('fires once when the last running scan goes idle', async () => {
    const onScanComplete = vi.fn()
    getScanStatus.mockResolvedValue(status('running'))
    render(<ScanProgressBar isAdmin onScanComplete={onScanComplete} />)

    // While it is running, nothing is announced — the bar is visible and the
    // user is watching progress; there is no new content to pick up yet.
    await waitFor(() => expect(getScanStatus).toHaveBeenCalled())
    await tick()
    expect(onScanComplete).not.toHaveBeenCalled()

    // The scan finishes.
    getScanStatus.mockResolvedValue(status('idle'))
    await tick()
    await waitFor(() => expect(onScanComplete).toHaveBeenCalledTimes(1))

    // …and staying idle must not keep firing. A repeat would refetch Home on
    // every 4s poll for as long as the tab is open.
    await tick()
    await tick()
    expect(onScanComplete).toHaveBeenCalledTimes(1)
  })

  it('does not fire when no scan was ever running', async () => {
    const onScanComplete = vi.fn()
    getScanStatus.mockResolvedValue(status('idle'))
    render(<ScanProgressBar isAdmin onScanComplete={onScanComplete} />)

    await waitFor(() => expect(getScanStatus).toHaveBeenCalled())
    await tick()
    await tick()
    // Mounting on an idle server is not a completion. Firing here would make
    // every page load refetch Home for no reason.
    expect(onScanComplete).not.toHaveBeenCalled()
  })

  it('is inert for non-admins, who never poll', async () => {
    const onScanComplete = vi.fn()
    render(<ScanProgressBar isAdmin={false} onScanComplete={onScanComplete} />)
    await tick()
    // The polling is admin-gated, so this signal is too. Non-admins rely on
    // Home's staleness gate instead — worth pinning so the split is deliberate
    // rather than a surprise later.
    expect(getScanStatus).not.toHaveBeenCalled()
    expect(onScanComplete).not.toHaveBeenCalled()
  })

  it('survives having no callback at all', async () => {
    getScanStatus.mockResolvedValue(status('running'))
    const { rerender } = render(<ScanProgressBar isAdmin />)
    await waitFor(() => expect(getScanStatus).toHaveBeenCalled())
    getScanStatus.mockResolvedValue(status('idle'))
    await tick()
    // The prop is optional; the transition must not throw when it is absent.
    rerender(<ScanProgressBar isAdmin />)
  })
})
