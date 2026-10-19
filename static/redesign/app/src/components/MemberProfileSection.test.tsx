// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { Profile } from '@/lib/api'
import { MemberProfileSection } from './SettingsView'

const api = vi.hoisted(() => ({ getMyProfile: vi.fn() }))
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
})
