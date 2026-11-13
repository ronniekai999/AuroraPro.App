// @vitest-environment jsdom
// Failures said in the app's own words (lib/failureWords) on the member
// pages and in Settings' push test: what the server or the browser said is
// written for a log or a developer, and never reaches the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({
  listMembers: vi.fn(),
  followMember: vi.fn(),
  unfollowMember: vi.fn(),
  getMemberProfile: vi.fn(),
  listMemberFollowers: vi.fn(),
  listMemberFollowing: vi.fn(),
  getPushConfig: vi.fn(),
  sendPushTest: vi.fn(),
}))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

import { APIError, NetworkError, type MemberSummary } from '@/lib/api'
import MembersView from './MembersView'
import UserProfileView from './UserProfileView'
import { AppPane } from './settings/AppPane'

const ROBIN = { username: 'robin', is_following: false, follower_count: 0, following_count: 0 } as unknown as MemberSummary

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset()
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the members list', () => {
  it('says the list could not be loaded, not what the server said', async () => {
    api.listMembers.mockRejectedValue(new APIError(500, 'pq: connection refused', null))
    render(<MembersView onOpenMember={() => {}} currentUsername="morgan" />)
    expect(await screen.findByText('Could not load the members just now.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/pq:/)
  })

  it('says a follow that did not go through in its own words, and puts the button back', async () => {
    api.listMembers.mockResolvedValue([ROBIN])
    api.followMember.mockRejectedValue(new NetworkError('Failed to fetch'))
    const onToast = vi.fn()
    render(<MembersView onOpenMember={() => {}} currentUsername="morgan" onToast={onToast} />)
    fireEvent.click(await screen.findByRole('button', { name: /Follow/ }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Could not reach the server. Check the connection and try again.', 'error'))
    expect(screen.getByRole('button', { name: /Follow/ })).toHaveTextContent('Follow')
  })
})

describe('a member’s page', () => {
  // The server answers a member it will not show with a 404: the page says
  // the page is not available, and never "member not found".
  it('says a page that is not available as that', async () => {
    api.getMemberProfile.mockRejectedValue(new APIError(404, 'member not found', null))
    render(<UserProfileView username="nobody" onSelect={() => {}} onCardContext={() => {}} onOpenMember={() => {}} />)
    expect(await screen.findByText('This member’s page is not available.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/member not found/)
  })
})

describe('Settings: a push test that is refused', () => {
  it('says it in the app’s words', async () => {
    // A browser that can take push, subscribed on this device.
    vi.stubGlobal('PushManager', function PushManager() {})
    vi.stubGlobal('Notification', { permission: 'granted' })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: 'x' }) } }) },
    })
    api.getPushConfig.mockResolvedValue({ enabled: true, vapid_public_key: 'k' })
    api.sendPushTest.mockRejectedValue(new APIError(502, 'push: upstream returned 410 Gone', null))
    const onToast = vi.fn()
    render(<AppPane onToast={onToast} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }))
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Could not send the test just now.', 'error'))
    expect(onToast.mock.calls.flat().join(' ')).not.toMatch(/upstream|410/)
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker
  })
})
