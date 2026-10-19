// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { Profile } from '@/lib/api'
import { ProfilesAndWatchlistsCard } from './SettingsView'

const api = vi.hoisted(() => ({ listProfiles: vi.fn(), listWatchlists: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const profile = (id: number, extra: Partial<Profile> = {}): Profile => ({
  id, user_id: 1, name: `Profile ${id}`, is_default: id === 1, created_at: '', updated_at: '', ...extra,
})
const parent = profile(1)
const kid = profile(2, { name: 'Kid', max_age_rating: 'PG' })

describe('ProfilesAndWatchlistsCard', () => {
  beforeEach(() => {
    api.listProfiles.mockReset().mockResolvedValue([parent, kid])
    api.listWatchlists.mockReset().mockResolvedValue([])
  })

  // The server refuses a restricted session any other profile's lists, so a
  // selection left on the parent showed "No watchlists yet." for the parent.
  it('moves a restricted session onto its own profile when the acting profile changes', async () => {
    const view = render(<ProfilesAndWatchlistsCard actingProfile={parent} profileKnown />)
    await waitFor(() => expect(api.listWatchlists).toHaveBeenCalledWith(1))

    view.rerender(<ProfilesAndWatchlistsCard actingProfile={kid} profileKnown />)
    await waitFor(() => expect(api.listWatchlists).toHaveBeenLastCalledWith(2))
    expect(screen.queryByRole('button', { name: /Profile 1/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Kid/ })).toBeTruthy()
  })

  // Until the session's profile is known it could be a restricted one, so
  // nothing is listed; once the kid's arrives, only the kid's.
  it('selects a restricted session’s own profile when the acting profile arrives late', async () => {
    const view = render(<ProfilesAndWatchlistsCard actingProfile={null} profileKnown={false} />)
    await waitFor(() => expect(api.listProfiles).toHaveBeenCalled())
    expect(api.listWatchlists).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Profile 1/ })).toBeNull()

    view.rerender(<ProfilesAndWatchlistsCard actingProfile={kid} profileKnown />)
    await waitFor(() => expect(api.listWatchlists).toHaveBeenLastCalledWith(2))
    expect(api.listWatchlists).not.toHaveBeenCalledWith(1)
  })
})

describe('ProfilesAndWatchlistsCard stale loads', () => {
  beforeEach(() => {
    api.listProfiles.mockReset()
    api.listWatchlists.mockReset().mockResolvedValue([])
  })

  // A load started as the unrestricted parent, which lists every profile,
  // answers after the switch to the kid's.
  it('ignores a profile list that a newer load has superseded', async () => {
    let early!: (ps: Profile[]) => void
    api.listProfiles
      .mockImplementationOnce(() => new Promise<Profile[]>(r => { early = r }))
      .mockResolvedValue([parent, kid])
    const view = render(<ProfilesAndWatchlistsCard actingProfile={parent} profileKnown />)
    view.rerender(<ProfilesAndWatchlistsCard actingProfile={kid} profileKnown />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Kid/ })).toBeTruthy())
    await act(async () => { early([parent, kid]) })
    expect(screen.queryByRole('button', { name: /Profile 1/ })).toBeNull()
  })
})
