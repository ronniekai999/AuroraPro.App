// @vitest-environment jsdom
//
// The dashboard's counts follow a scan that adds titles (App's catalogVersion,
// from library_update events) while the dashboard is open. They used to be
// read once per visit to /admin.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ServerStats } from '@/lib/api'

const { getAdminDashboard, getEmbeddingStatus, getSkipMarkerStatus } = vi.hoisted(() => ({
  getAdminDashboard: vi.fn(),
  getEmbeddingStatus: vi.fn(),
  getSkipMarkerStatus: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getAdminDashboard,
  getEmbeddingStatus,
  getSkipMarkerStatus,
}))

import AdminView from './AdminView'

const stats = (movies: number): ServerStats => ({
  movie_count: movies, show_count: 0, episode_count: 0, user_count: 1, active_streams: 0,
  disk_free_gb: 100, version: 'test', uptime: '1m', memory_alloc_mb: 1, goroutines: 1,
  library_count: 1, total_file_size_bytes: 0, active_parties: 0,
} as ServerStats)

beforeEach(() => {
  // Everything else on the dashboard (updates, libraries…) is unavailable,
  // which each panel already handles.
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'unavailable' }), {
    status: 503, headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  getAdminDashboard.mockReset()
  getEmbeddingStatus.mockReset().mockRejectedValue(new Error('off'))
  getSkipMarkerStatus.mockReset().mockRejectedValue(new Error('off'))
})
afterEach(() => vi.unstubAllGlobals())

const moviesTile = () => screen.getByText('Movies + Shows').closest('div')?.parentElement?.textContent ?? ''

describe('AdminView dashboard and live catalog updates', () => {
  it('refetches its counts when the catalog version moves, keeping the old ones meanwhile', async () => {
    getAdminDashboard.mockResolvedValueOnce(stats(1234))
    const view = (v: number) => <MemoryRouter><AdminView currentAdminId={1} catalogVersion={v} /></MemoryRouter>
    const { rerender } = render(view(0))
    await waitFor(() => expect(moviesTile()).toContain('1,234'))
    expect(getAdminDashboard).toHaveBeenCalledTimes(1)

    rerender(view(0))
    expect(getAdminDashboard).toHaveBeenCalledTimes(1)

    let land!: (s: ServerStats) => void
    getAdminDashboard.mockReturnValueOnce(new Promise<ServerStats>(done => { land = done }))
    rerender(view(1))
    expect(getAdminDashboard).toHaveBeenCalledTimes(2)
    // The previous numbers stay up while the refetch is out.
    expect(screen.queryByText('Loading stats…')).toBeNull()
    expect(moviesTile()).toContain('1,234')
    land(stats(5678))
    await waitFor(() => expect(moviesTile()).toContain('5,678'))
    expect(getAdminDashboard).toHaveBeenCalledTimes(2)
  })
})
