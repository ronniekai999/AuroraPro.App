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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ScanProgressBar } from './ScanProgressBar'
import { followRestore, resetRestoreOutcomeForTest } from './admin/restoreOutcome'

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
afterEach(() => { cleanup(); vi.useRealTimers(); resetRestoreOutcomeForTest() })

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

  it('hides a running scan, all of it, once the session stops being an admin', async () => {
    // A switch to a restricted profile on an admin account: the polling stops,
    // and the bar must not stay frozen on the last scan it saw.
    const onScanComplete = vi.fn()
    getScanStatus.mockResolvedValue({ ...status('running'), current_file: '/m/Some Film (2020).mkv' })
    const { container, rerender } = render(<ScanProgressBar isAdmin onScanComplete={onScanComplete} onOpenLibraries={() => {}} />)
    await waitFor(() => expect(container.textContent).toContain('Scanning Movies'))

    rerender(<ScanProgressBar isAdmin={false} onScanComplete={onScanComplete} onOpenLibraries={() => {}} />)
    // Nothing at all: no library name, no count, no way to the admin page.
    expect(container.innerHTML).toBe('')
    await tick()
    expect(onScanComplete).not.toHaveBeenCalled()
  })

  // One row: which library, how far, and where to see more. The name of the
  // file being read is not on it (it was, and changed four times a second in
  // a row everything under the bar is placed against).
  it('says which library is being scanned and how far along it is, in one row, with the way to Libraries', async () => {
    const onOpenLibraries = vi.fn()
    getScanStatus.mockResolvedValue({ status: 'running', total_files: 2200, scanned_files: 1400, new_files: 3, current_file: '/m/Some Film (2020).mkv' })
    const { container } = render(<ScanProgressBar isAdmin onScanComplete={() => {}} onOpenLibraries={onOpenLibraries} />)
    await waitFor(() => expect(container.querySelector('.scanbar-row')).not.toBeNull())
    const row = container.querySelector('.scanbar-row')!
    expect(container.querySelectorAll('.scanbar-row')).toHaveLength(1)
    expect(row.querySelector('.scanbar-name')!.textContent).toBe('Scanning Movies')
    expect(row.querySelector('.scanbar-count')!.textContent).toBe('1,400 of 2,200 files · 3 new')
    expect((row.querySelector('.scanbar-track > span') as HTMLElement).style.width).toMatch(/^63\.6/)
    expect(container.textContent).not.toContain('Some Film')
    fireEvent.click(screen.getByRole('button', { name: 'Open Libraries' }))
    expect(onOpenLibraries).toHaveBeenCalledTimes(1)
  })

  // What a screen reader hears: which libraries are being scanned, when that
  // changes. The bar's counts change at every poll, so the bar is not the
  // live region: the status is an element of its own, there before a scan
  // starts (a live region inserted already filled is often not read).
  it('says which libraries are being scanned as a status of its own, without the counts, and is silent when none is', async () => {
    const OTHER = { id: 2, name: 'Shows', type: 'show', path: '/s' }
    listLibraries.mockResolvedValue([LIB, OTHER])
    const running = { status: 'running', total_files: 2200, scanned_files: 1400, new_files: 3 }
    getScanStatus.mockImplementation(async (id: number) => (id === 1 ? running : { status: 'idle', total_files: 0, scanned_files: 0 }))
    const { container } = render(<ScanProgressBar isAdmin onScanComplete={() => {}} />)
    const said = () => screen.getByRole('status')
    // Mounted before anything is being scanned, and empty.
    expect(said().textContent).toBe('')
    await waitFor(() => expect(said().textContent).toBe('Scanning Movies'))
    // The one live region, and the bar is outside it.
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(1)
    expect(said().contains(container.querySelector('.scanbar'))).toBe(false)
    expect(container.querySelector('.scanbar')!.closest('[role="status"]')).toBeNull()
    // The count moves on: what is said does not change.
    getScanStatus.mockImplementation(async (id: number) => (id === 1 ? { ...running, scanned_files: 1900 } : { status: 'idle', total_files: 0, scanned_files: 0 }))
    await tick()
    await waitFor(() => expect(container.querySelector('.scanbar-count')!.textContent).toContain('1,900'))
    expect(said().textContent).toBe('Scanning Movies')
    // A second library starts.
    getScanStatus.mockResolvedValue(running)
    await tick()
    await waitFor(() => expect(said().textContent).toBe('Scanning Movies, Shows'))
    // Both end.
    getScanStatus.mockResolvedValue({ status: 'idle', total_files: 0, scanned_files: 0 })
    await tick()
    await waitFor(() => expect(container.querySelector('.scanbar')).toBeNull())
    expect(said().textContent).toBe('')
  })

  it('renders nothing at all, the status included, for a session that is not an admin\'s', async () => {
    getScanStatus.mockResolvedValue({ status: 'running', total_files: 10, scanned_files: 5 })
    listLibraries.mockClear()
    const { container } = render(<ScanProgressBar isAdmin={false} onScanComplete={() => {}} />)
    await tick()
    expect(container.innerHTML).toBe('')
    expect(listLibraries).not.toHaveBeenCalled()
  })

  it('offers no way to Libraries where it is given none, and no count before the scanner has one', async () => {
    getScanStatus.mockResolvedValue({ status: 'running', total_files: 0, scanned_files: 0 })
    const { container } = render(<ScanProgressBar isAdmin onScanComplete={() => {}} />)
    await waitFor(() => expect(container.querySelector('.scanbar-row')).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Open Libraries' })).toBeNull()
    expect(container.querySelector('.scanbar-count')).toBeNull()
    expect((container.querySelector('.scanbar-track > span') as HTMLElement).style.width).toBe('0%')
  })

  it('does NOT fire when a poll transiently fails mid-scan', async () => {
    // The map used to be rebuilt from empty each poll, so one rejected request
    // dropped that library and read as "not running" — identical to finishing.
    // The in-app auto-updater restarts the service mid-scan, so this is a
    // routine event, and each outage/recovery cycle fired again.
    const onScanComplete = vi.fn()
    getScanStatus.mockResolvedValue(status('running'))
    render(<ScanProgressBar isAdmin onScanComplete={onScanComplete} />)
    await waitFor(() => expect(getScanStatus).toHaveBeenCalled())
    await tick()

    for (let cycle = 0; cycle < 3; cycle++) {
      getScanStatus.mockRejectedValueOnce(new Error('server restarting'))
      await tick()
      expect(onScanComplete).not.toHaveBeenCalled()
      getScanStatus.mockResolvedValue(status('running'))
      await tick()
      expect(onScanComplete).not.toHaveBeenCalled()
    }

    // The REAL completion still lands.
    getScanStatus.mockResolvedValue(status('idle'))
    await tick()
    await waitFor(() => expect(onScanComplete).toHaveBeenCalledTimes(1))
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

  // A database restore holds locks the scan-status read waits on. A poll
  // every 4 s used to stack requests, each holding one of the server's
  // database connections until the restore ended.
  it('polls one at a time: a poll still out holds the next back', async () => {
    getScanStatus.mockReturnValue(new Promise(() => {}))
    render(<ScanProgressBar isAdmin onScanComplete={() => {}} />)
    await waitFor(() => expect(getScanStatus).toHaveBeenCalledTimes(1))
    await tick()
    await tick()
    await tick()
    expect(getScanStatus).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while this tab follows a database restore, and goes on after it', async () => {
    getScanStatus.mockResolvedValue(status('idle'))
    followRestore(1, { id: 'j1', file: 'aurora.dump', phase: 'validating', started_at: '' })
    render(<ScanProgressBar isAdmin onScanComplete={() => {}} />)
    await waitFor(() => expect(listLibraries).toHaveBeenCalled())
    await tick()
    await tick()
    expect(getScanStatus).not.toHaveBeenCalled()
    resetRestoreOutcomeForTest()
    await tick()
    await waitFor(() => expect(getScanStatus).toHaveBeenCalled())
  })
})
