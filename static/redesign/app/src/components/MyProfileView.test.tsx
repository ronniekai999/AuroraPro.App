// @vitest-environment jsdom
//
// Your profile: the account's page for other members, the watching
// profile's avatar and lean, and the statistics that used to sit on Home.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { APIError, type Profile, type User } from '@/lib/api'
import MyProfileView from './MyProfileView'
import { levelProgressPct, weekHours } from './GamificationCard'

const api = vi.hoisted(() => ({ getMyProfile: vi.fn(), updateMyProfile: vi.fn(), getGamificationStats: vi.fn(), updateProfile: vi.fn(), setProfileMaturity: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const USER: User = { id: 1, username: 'morgan', email: 'm@example.test', role: 'user' }
const parent: Profile = { id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: '', updated_at: '', maturity_pref: -1 }
const MEMBER = { user_id: 1, username: 'morgan', display_name: 'Morgan', bio: '', member_since: '', share_watch_history: false }
const STATS = {
  xp: { user_id: 1, xp: 350, level: 3, current_streak: 5, longest_streak: 19, total_watches: 212, xp_to_next_level: 250, next_level_total: 600, prev_level_total: 300 },
  unlocked: [{ id: 1, user_id: 1, achievement_key: 'first', unlocked_at: '' }],
  achievement_catalog: [
    { key: 'first', title: 'First Watch', description: 'Finish a title', icon: '🎬', xp_reward: 50 },
    { key: 'owl', title: 'Night Owl', description: 'Finish one after midnight', icon: '🦉', xp_reward: 100 },
  ],
  top_genre: 'Drama', titles_this_week: 3, minutes_this_week: 400,
}

const props = () => ({ user: USER, onOpenMember: vi.fn(), onOpenSettings: vi.fn(), onToast: vi.fn(), onProfilesChanged: vi.fn() })

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getMyProfile.mockResolvedValue(MEMBER)
  api.updateMyProfile.mockImplementation(async (patch: object) => ({ ...MEMBER, ...patch }))
  api.getGamificationStats.mockResolvedValue(STATS)
  api.updateProfile.mockResolvedValue(parent)
  api.setProfileMaturity.mockResolvedValue(undefined)
})

describe('MyProfileView', () => {
  it('sits in the Settings list as Your profile, and its other entries open Settings at that section', () => {
    const p = props()
    render(<MyProfileView {...p} activeProfile={parent} profileKnown />)
    const nav = within(screen.getByRole('navigation', { name: 'Settings sections' }))
    expect(nav.getByRole('button', { name: 'Your profile' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(nav.getByRole('button', { name: 'Profiles and parental controls' }))
    expect(p.onOpenSettings).toHaveBeenCalledWith('profiles')
    fireEvent.click(screen.getByRole('button', { name: 'View my page' }))
    expect(p.onOpenMember).toHaveBeenCalledWith('morgan')
  })

  it('saves the member profile, and the sharing switch saves by itself', async () => {
    const p = props()
    render(<MyProfileView {...p} activeProfile={parent} profileKnown />)
    fireEvent.change(await screen.findByLabelText('Display name'), { target: { value: 'Mo' } })
    fireEvent.change(screen.getByLabelText('Instagram'), { target: { value: 'https://instagram.com/mo.screens/' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.updateMyProfile).toHaveBeenCalledTimes(1))
    // A pasted address is reduced to the handle; sharing is not in this save.
    expect(api.updateMyProfile.mock.calls[0][0]).toMatchObject({ display_name: 'Mo', social_instagram: 'mo.screens' })
    expect(api.updateMyProfile.mock.calls[0][0]).not.toHaveProperty('share_watch_history')

    const share = screen.getByRole('switch', { name: 'Share what I finish' })
    expect(share).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(share)
    await waitFor(() => expect(api.updateMyProfile).toHaveBeenLastCalledWith({ share_watch_history: true }))
    await waitFor(() => expect(share).toHaveAttribute('aria-checked', 'true'))
  })

  it('puts the sharing switch back when the server refuses', async () => {
    const p = props()
    api.updateMyProfile.mockRejectedValue(new APIError(403, 'server words', { error: { code: 403, message: 'server words', reason: 'profile_restricted' } }))
    render(<MyProfileView {...p} activeProfile={parent} profileKnown />)
    const share = await screen.findByRole('switch', { name: 'Share what I finish' })
    fireEvent.click(share)
    await waitFor(() => expect(p.onToast).toHaveBeenCalledWith(expect.stringMatching(/content limit, so it cannot change this/), 'error'))
    expect(share).toHaveAttribute('aria-checked', 'false')
  })

  it('changes the watching profile\'s avatar and lean, and tells the app its copy is stale', async () => {
    const p = props()
    render(<MyProfileView {...p} activeProfile={parent} profileKnown />)
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Avatar for Parent' })).getAllByRole('radio')[1])
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith(1, { avatar_url: expect.stringMatching(/^nebula:/) }))
    const lean = within(screen.getByRole('radiogroup', { name: /lean towards/ }))
    expect(lean.getByRole('radio', { name: /Auto/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(lean.getByRole('radio', { name: /Teen/ }))
    await waitFor(() => expect(api.setProfileMaturity).toHaveBeenCalledWith(1, 1))
    await waitFor(() => expect(p.onProfilesChanged).toHaveBeenCalledTimes(2))
  })

  // The choice shows at once; a refusal puts the old one back and says why.
  it('puts the lean back when the save is refused', async () => {
    const p = props()
    api.setProfileMaturity.mockRejectedValue(new APIError(500, 'failed to update profile', null))
    render(<MyProfileView {...p} activeProfile={parent} profileKnown />)
    const lean = within(screen.getByRole('radiogroup', { name: /lean towards/ }))
    fireEvent.click(lean.getByRole('radio', { name: /Mature/ }))
    await waitFor(() => expect(p.onToast).toHaveBeenCalledWith('failed to update profile', 'error'))
    await waitFor(() => expect(lean.getByRole('radio', { name: /Auto/ })).toHaveAttribute('aria-checked', 'true'))
    expect(p.onProfilesChanged).not.toHaveBeenCalled()
  })

  it('moves through the lean with the arrow keys, as one tab stop', () => {
    render(<MyProfileView {...props()} activeProfile={parent} profileKnown />)
    const group = screen.getByRole('radiogroup', { name: /lean towards/ })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map(r => r.tabIndex)).toEqual([0, -1, -1, -1])
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(api.setProfileMaturity).toHaveBeenCalledWith(1, 0)
    expect(radios[1]).toHaveFocus()
  })

  it('shows the statistics that left Home: level, this week, the streak, the genre finished most, achievements', async () => {
    render(<MyProfileView {...props()} activeProfile={parent} profileKnown />)
    const bar = await screen.findByRole('progressbar', { name: 'Progress through level 3' })
    // 350 points in a level that runs 300 to 600: 50 of 300.
    expect(bar).toHaveAttribute('aria-valuenow', '17')
    expect(screen.getByText('350 points')).toBeInTheDocument()
    expect(screen.getByText('250 to level 4')).toBeInTheDocument()
    const stat = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent
    expect(stat('Finished')).toBe('212 titles')
    expect(screen.getByText(/counts as finished once it is watched to 90% of its length/)).toBeInTheDocument()
    expect(stat('This week')).toBe('3 finished6.7 hours')
    expect(stat('Streak')).toBe('5 dayslongest 19')
    expect(stat('Finished most')).toBe('Drama')
    expect(stat('Achievements')).toBe('1 of 2')
    const earned = screen.getByText('First Watch').closest('li')!, toGo = screen.getByText('Night Owl').closest('li')!
    expect(earned).toHaveTextContent('Earned · 50 points')
    expect(toGo).toHaveTextContent('Not yet · 100 points')
  })

  // Nothing personal until the session's profile is known.
  it('shows no avatar picker, lean or statistics while the profile is unknown', () => {
    render(<MyProfileView {...props()} activeProfile={null} profileKnown={false} />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(api.getGamificationStats).not.toHaveBeenCalled()
    expect(api.getMyProfile).not.toHaveBeenCalled()
    expect(screen.getByText(/member profile can only be edited from a profile without a content limit/)).toBeInTheDocument()
  })
})

describe('the statistics\' arithmetic', () => {
  it('measures progress through the current level, not across all points', () => {
    expect(levelProgressPct({ xp: 350, prev_level_total: 300, next_level_total: 600 })).toBeCloseTo(16.67, 1)
    expect(levelProgressPct({ xp: 0 })).toBe(0)
    expect(levelProgressPct({ xp: 900, prev_level_total: 300, next_level_total: 600 })).toBe(100)
  })
  it('gives hours one decimal under ten and none above', () => {
    expect(weekHours(undefined)).toBeNull()
    expect(weekHours(0)).toBe('0')
    expect(weekHours(90)).toBe('1.5')
    expect(weekHours(600)).toBe('10')
  })
})
