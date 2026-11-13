// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { APIError, NetworkError, type Profile } from '@/lib/api'
import { MemberProfileSection } from './MemberProfileEditor'

const api = vi.hoisted(() => ({ getMyProfile: vi.fn(), updateMyProfile: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const profile = (extra: Partial<Profile> = {}): Profile => ({
  id: 1, user_id: 1, name: 'p', is_default: true, created_at: '', updated_at: '', ...extra,
})

describe('MemberProfileSection', () => {
  beforeEach(() => { api.getMyProfile.mockReset().mockReturnValue(new Promise(() => {})) })

  // The server refuses a restricted session's edits: the member profile is
  // the account's, and its sharing switch publishes the default's history.
  it('offers a restricted session a note, not the editor', () => {
    render(<MemberProfileSection activeProfile={profile({ max_age_rating: 'PG' })} profileKnown />)
    expect(screen.getByText(/member profile can only be edited from a profile without a content limit/)).toBeTruthy()
    expect(api.getMyProfile).not.toHaveBeenCalled()
  })

  // Until the session's profile is known it could be a restricted one.
  it('offers a note while the profile is unknown', () => {
    render(<MemberProfileSection activeProfile={profile()} profileKnown={false} />)
    expect(screen.getByText(/member profile can only be edited from a profile without a content limit/)).toBeTruthy()
    expect(api.getMyProfile).not.toHaveBeenCalled()
  })

  it('shows an unrestricted session the editor', async () => {
    render(<MemberProfileSection activeProfile={profile()} profileKnown />)
    await waitFor(() => expect(api.getMyProfile).toHaveBeenCalled())
    expect(screen.queryByText(/member profile can only be edited/)).toBeNull()
  })

  // A refused save or sharing change is said in the app's words.
  it('says a save and a sharing change that did not go through in the app\'s words', async () => {
    api.getMyProfile.mockReset().mockResolvedValue({ user_id: 1, username: 'morgan', member_since: '2026-01-01T00:00:00Z', share_watch_history: false })
    api.updateMyProfile.mockReset()
      .mockRejectedValueOnce(new APIError(500, 'pq: connection refused', null))
      .mockRejectedValueOnce(new NetworkError('Failed to fetch'))
    const onToast = vi.fn()
    render(<MemberProfileSection activeProfile={profile()} profileKnown onToast={onToast} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Could not save your member profile just now.', 'error'))
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Could not reach the server. Check the connection and try again.', 'error'))
    expect(onToast.mock.calls.flat().join(' ')).not.toMatch(/pq:|Failed to fetch/)
  })
})
