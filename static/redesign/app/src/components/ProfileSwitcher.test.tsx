// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Profile } from '@/lib/api'
import { ProfileSwitcher } from './ProfileSwitcher'

const profile = (id: number, extra: Partial<Profile> = {}): Profile => ({
  id, user_id: 1, name: `Profile ${id}`, is_default: id === 1, created_at: '', updated_at: '', ...extra,
})
const profiles = [profile(1), profile(2)]

describe('ProfileSwitcher', () => {
  // The nav names only the profile the server confirmed. While the binding
  // is unknown the host forces the picker open, and naming the default
  // here showed a guess behind it.
  it('names no profile until one is active', () => {
    const { rerender } = render(<ProfileSwitcher profiles={profiles} activeProfileId={null} onSelect={() => {}} />)
    expect(screen.queryByText('Profile 1')).not.toBeInTheDocument()
    rerender(<ProfileSwitcher profiles={profiles} activeProfileId={2} onSelect={() => {}} />)
    expect(screen.getByText('Profile 2')).toBeInTheDocument()
  })
})
