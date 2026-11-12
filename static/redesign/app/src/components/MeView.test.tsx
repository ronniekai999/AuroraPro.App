// @vitest-environment jsdom
//
// The phone's "Me" page names who is watching and states what that profile
// is, in one line under the name. The line's longest form does not fit a
// phone's width; cut off at the end it used to lose the profile's limit,
// which is the fact the line is there to state.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import MeView, { type MeViewProps } from './MeView'
import type { Profile } from '@/lib/api'

const profile = (id: number, name: string, over: Partial<Profile> = {}): Profile => ({
  id, user_id: 1, name, is_default: id === 1, created_at: '', updated_at: '', ...over,
})
const noop = vi.fn()
const props = (over: Partial<MeViewProps> = {}): MeViewProps => ({
  user: { id: 1, username: 'owner', email: 'owner@example.test', role: 'user' },
  navScope: 'full', adminUI: false, profiles: [profile(1, 'Parent', { has_pin: true }), profile(2, 'Kid', { max_age_rating: 'PG' })],
  activeProfileId: 1, notifCount: 0,
  onSelectProfile: noop, onOpenNotifications: noop, onOpenSettings: noop, onOpenAdmin: noop, onOpenServer: noop, onSignOut: noop,
  ...over,
})
const summary = () => document.querySelector('header [data-profile-summary]')

afterEach(cleanup)

describe("the Me page's header", () => {
  it('states the whole of what the profile is, the limit first, on a line that wraps rather than being cut', () => {
    render(<MeView {...props()} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Parent')
    expect(summary()).toHaveTextContent(/^No limit · default · locked with a PIN$/)
    expect(summary()).not.toHaveClass('truncate')
  })

  it('states a limit the same way', () => {
    render(<MeView {...props({ activeProfileId: 2, navScope: 'restricted' })} />)
    expect(summary()).toHaveTextContent(/^Up to PG$/)
  })

  it('says who is signed in when no profile is bound', () => {
    render(<MeView {...props({ activeProfileId: null, navScope: 'unknown' })} />)
    expect(summary()).toHaveTextContent(/^Signed in as owner$/)
  })
})
