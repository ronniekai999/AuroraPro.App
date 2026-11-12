// @vitest-environment jsdom
//
// The Settings page: which section the URL's pane opens, what the list of
// sections offers to whom, and the controls of the two sections that keep
// their choices in this browser (Playback, App).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { Profile } from '@/lib/api'
import SettingsView from './SettingsView'

const api = vi.hoisted(() => ({ listProfiles: vi.fn(), listOAuthLinks: vi.fn(), getPushConfig: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/api')>()), ...api }))

const profile = (extra: Partial<Profile> = {}): Profile => ({
  id: 1, user_id: 1, name: 'Parent', is_default: true, created_at: '', updated_at: '', ...extra,
})
const prefs = () => JSON.parse(localStorage.getItem('aurora_prefs') ?? '{}') as Record<string, unknown>
const sections = () => within(screen.getByRole('navigation', { name: 'Settings sections' }))
const current = () => sections().getAllByRole('button').filter(b => b.getAttribute('aria-current') === 'page').map(b => b.textContent)

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-effects')
  for (const fn of Object.values(api)) fn.mockReset()
  api.listProfiles.mockReturnValue(new Promise(() => {}))
  api.listOAuthLinks.mockReturnValue(new Promise(() => {}))
  api.getPushConfig.mockReturnValue(new Promise(() => {}))
})

describe('which section is open', () => {
  it('opens the first section for /settings, and the one the URL names otherwise', () => {
    const view = render(<SettingsView pane={null} onPaneChange={vi.fn()} activeProfile={profile()} profileKnown />)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(current()).toEqual(['Playback'])
    expect(screen.getByRole('heading', { level: 2, name: 'Playback' })).toBeInTheDocument()

    view.rerender(<SettingsView pane="profiles" onPaneChange={vi.fn()} activeProfile={profile()} profileKnown />)
    expect(current()).toEqual(['Profiles and parental controls'])
    expect(screen.getByRole('heading', { level: 2, name: 'Profiles and parental controls' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Playback' })).toBeNull()

    view.rerender(<SettingsView pane="account" onPaneChange={vi.fn()} activeProfile={profile()} profileKnown />)
    expect(current()).toEqual(['Account and sign-in'])
    expect(screen.getByRole('heading', { level: 2, name: 'Sign-in methods' })).toBeInTheDocument()

    view.rerender(<SettingsView pane="app" onPaneChange={vi.fn()} activeProfile={profile()} profileKnown />)
    expect(current()).toEqual(['App and notifications'])
    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument()
  })

  it('asks the app for another section instead of switching by itself', () => {
    const onPaneChange = vi.fn()
    render(<SettingsView pane="playback" onPaneChange={onPaneChange} activeProfile={profile()} profileKnown />)
    fireEvent.click(sections().getByRole('button', { name: 'Profiles and parental controls' }))
    expect(onPaneChange).toHaveBeenCalledWith('profiles')
    // The URL has not changed, so neither has the page.
    expect(current()).toEqual(['Playback'])
  })

  it('keeps the choice itself when nothing owns the URL', () => {
    render(<SettingsView activeProfile={profile()} profileKnown />)
    fireEvent.click(sections().getByRole('button', { name: 'App and notifications' }))
    expect(current()).toEqual(['App and notifications'])
  })
})

describe('the list of sections', () => {
  it('lists the four sections and Your profile, and no Devices', () => {
    const onOpenProfilePage = vi.fn()
    render(<SettingsView pane="playback" onPaneChange={vi.fn()} activeProfile={profile()} profileKnown onOpenProfilePage={onOpenProfilePage} />)
    expect(sections().getAllByRole('button').map(b => b.textContent)).toEqual([
      'Playback', 'App and notifications', 'Account and sign-in', 'Your profile', 'Profiles and parental controls',
    ])
    fireEvent.click(sections().getByRole('button', { name: 'Your profile' }))
    expect(onOpenProfilePage).toHaveBeenCalledTimes(1)
  })

  // A session with a content limit is not shown the profile page, so it is
  // not offered the way to it; nor is one whose profile is not known yet.
  it('does not offer Your profile to a session with a content limit, or one whose profile is unknown', () => {
    const view = render(<SettingsView pane="playback" onPaneChange={vi.fn()} activeProfile={profile({ max_age_rating: 'PG' })} profileKnown onOpenProfilePage={vi.fn()} />)
    expect(sections().queryByRole('button', { name: 'Your profile' })).toBeNull()
    view.rerender(<SettingsView pane="playback" onPaneChange={vi.fn()} activeProfile={profile()} profileKnown={false} onOpenProfilePage={vi.fn()} />)
    expect(sections().queryByRole('button', { name: 'Your profile' })).toBeNull()
  })
})

describe('Playback', () => {
  const open = () => render(<SettingsView pane="playback" onPaneChange={vi.fn()} activeProfile={profile()} profileKnown />)

  // The player keeps its volume in the same stored object while this page is
  // mounted under it. A switch here writes its own key over a fresh read and
  // nothing else.
  it('turns autoplay off and on by writing that one key, leaving what else is stored alone', () => {
    localStorage.setItem('aurora_prefs', JSON.stringify({ player_volume: 0.4 }))
    open()
    const autoplay = screen.getByRole('switch', { name: 'Play the next episode automatically' })
    expect(autoplay).toHaveAttribute('aria-checked', 'true')
    // Another writer changes the object after this page read it.
    localStorage.setItem('aurora_prefs', JSON.stringify({ player_volume: 0.9, subtitleLang: 'fr' }))
    fireEvent.click(autoplay)
    expect(autoplay).toHaveAttribute('aria-checked', 'false')
    expect(prefs()).toEqual({ player_volume: 0.9, subtitleLang: 'fr', autoplay: false })
    fireEvent.click(autoplay)
    expect(prefs()).toEqual({ player_volume: 0.9, subtitleLang: 'fr', autoplay: true })
  })

  it('reads a stored "off" as off', () => {
    localStorage.setItem('aurora_prefs', JSON.stringify({ autoplay: false }))
    open()
    expect(screen.getByRole('switch', { name: 'Play the next episode automatically' })).toHaveAttribute('aria-checked', 'false')
  })

  it('stores the audio language, the resolution and the bitrate limit the player reads', () => {
    open()
    fireEvent.change(screen.getByRole('combobox', { name: 'Audio language' }), { target: { value: 'ja' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Preferred resolution' }), { target: { value: '4k' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Streaming bitrate limit' }), { target: { value: '8000000' } })
    expect(prefs()).toEqual({ preferred_audio_language: 'ja', preferred_quality: '4k', max_stream_bps: 8_000_000 })
  })

  // A stored value outside the list must still be the one shown, or the
  // control would read "No limit" while every request carried the limit.
  it('shows a stored bitrate limit that is not one of its own', () => {
    localStorage.setItem('aurora_prefs', JSON.stringify({ max_stream_bps: 3_500_000 }))
    open()
    const limit = screen.getByRole('combobox', { name: 'Streaming bitrate limit' })
    expect(limit).toHaveValue('3500000')
    expect(within(limit).getByRole('option', { name: 'Custom (3.5 Mbps)' })).toBeInTheDocument()
  })

  // Controls that changed nothing: no part of the app read what they stored.
  it('has no control that nothing reads', () => {
    open()
    for (const gone of [/HDR/i, /hardware decoding/i, /subtitle/i]) {
      expect(screen.queryByRole('switch', { name: gone })).toBeNull()
      expect(screen.queryByRole('combobox', { name: gone })).toBeNull()
    }
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getAllByRole('combobox')).toHaveLength(3)
  })
})

describe('App and notifications', () => {
  it('turns Reduce effects on for the whole app at once, and remembers it', () => {
    render(<SettingsView pane="app" onPaneChange={vi.fn()} activeProfile={profile()} profileKnown />)
    const reduce = screen.getByRole('switch', { name: 'Reduce effects' })
    expect(reduce).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(reduce)
    expect(document.documentElement.getAttribute('data-effects')).toBe('reduced')
    expect(prefs().reduce_effects).toBe(true)
    fireEvent.click(reduce)
    expect(document.documentElement.hasAttribute('data-effects')).toBe(false)
    expect(prefs().reduce_effects).toBe(false)
  })

  it('shows the stored choice when it opens', () => {
    localStorage.setItem('aurora_prefs', JSON.stringify({ reduce_effects: true }))
    render(<SettingsView pane="app" onPaneChange={vi.fn()} activeProfile={profile()} profileKnown />)
    expect(screen.getByRole('switch', { name: 'Reduce effects' })).toHaveAttribute('aria-checked', 'true')
  })

  // The in-app "Enable notifications" switch stored a value nothing read.
  it('offers push for this device and no switch that nothing reads, and keeps the credits', () => {
    render(<SettingsView pane="app" onPaneChange={vi.fn()} activeProfile={profile()} profileKnown />)
    expect(screen.queryByRole('switch', { name: /enable notifications/i })).toBeNull()
    expect(screen.getByText('Push to this device')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'TMDB' })).toHaveAttribute('href', 'https://www.themoviedb.org')
    expect(screen.getByRole('link', { name: 'TheTVDB' })).toHaveAttribute('href', 'https://thetvdb.com')
    expect(screen.getByRole('heading', { name: 'Use Aurora like an app' })).toBeInTheDocument()
  })
})
