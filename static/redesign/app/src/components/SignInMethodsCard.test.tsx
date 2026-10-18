// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { Profile } from '@/lib/api'
import { SignInMethodsCard } from './SettingsView'

const api = vi.hoisted(() => ({ listOAuthLinks: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const profile = (extra: Partial<Profile> = {}): Profile => ({
  id: 1, user_id: 1, name: 'p', is_default: true, created_at: '', updated_at: '', ...extra,
})

describe('SignInMethodsCard', () => {
  beforeEach(() => { api.listOAuthLinks.mockReset().mockResolvedValue({ linked: [], available: [], hasPassword: true, canUnlinkAny: false }) })

  // A fresh sign-in through a link a kid added would land on the account
  // default without its PIN; the server refuses, and the card is not offered.
  it('offers a restricted session a note, not the sign-in methods', () => {
    render(<SignInMethodsCard activeProfile={profile({ max_age_rating: 'PG' })} />)
    expect(screen.getByText(/can only be managed from a profile without a content limit/)).toBeTruthy()
    expect(api.listOAuthLinks).not.toHaveBeenCalled()
  })

  it('shows an unrestricted session its sign-in methods', async () => {
    render(<SignInMethodsCard activeProfile={profile()} />)
    await waitFor(() => expect(api.listOAuthLinks).toHaveBeenCalled())
    expect(screen.queryByText(/can only be managed from a profile without a content limit/)).toBeNull()
  })
})
