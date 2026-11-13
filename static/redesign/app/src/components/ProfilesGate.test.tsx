// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Profile } from '@/lib/api'
import { ProfilesGate } from './ProfilesGate'
import { ProfileAvatar } from './ProfileAvatar'
import { PERSON_COLORS } from '@/lib/personColor'
import { setAccountProfileIds } from '@/lib/profileColors'

const profile = (id: number, extra: Partial<Profile> = {}): Profile => ({
  id, user_id: 1, name: `Profile ${id}`, is_default: id === 1, created_at: '', updated_at: '', ...extra,
})
const profiles = [profile(1), profile(2, { has_pin: true }), profile(3)]

// A pending switch: the test decides when, and how, it settles.
function deferred() {
  let resolve!: (v: boolean) => void
  const promise = new Promise<boolean>(r => { resolve = r })
  return { promise, resolve }
}

describe('ProfilesGate', () => {
  // The colour set is module state that outlives a render: emptied, so a
  // test about what the picker publishes cannot pass on what an earlier test
  // left there.
  beforeEach(() => { localStorage.clear(); setAccountProfileIds([]) })

  const renderGate = (onSelect: (id: number) => boolean | Promise<boolean>) =>
    render(<ProfilesGate profiles={profiles} activeProfileId={1} onSelect={onSelect} ready />)

  it('moves the selection with the arrows without switching profiles', () => {
    const onSelect = vi.fn(() => true)
    renderGate(onSelect)
    const group = screen.getByRole('radiogroup', { name: 'Profiles' })
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: /Profile 3/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /Profile 1/ })).toHaveAttribute('aria-checked', 'false')
    // Arrowing past the locked profile asked for nothing.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('stays up until the switch has happened, and after one that did not', async () => {
    const pending = deferred()
    const onSelect = vi.fn(() => pending.promise)
    renderGate(onSelect)
    fireEvent.click(screen.getByRole('radio', { name: /Profile 2/ }))
    expect(onSelect).toHaveBeenCalledWith(2)
    expect(screen.getByRole('dialog', { name: "Who's watching?" })).toBeInTheDocument()
    // A cancelled PIN prompt: the gate stays, and the check goes back to the
    // profile that is actually active.
    await act(async () => { pending.resolve(false) })
    expect(screen.getByRole('dialog', { name: "Who's watching?" })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Profile 1/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /Profile 2/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('closes once the switch succeeds', async () => {
    const onSelect = vi.fn(async () => true)
    renderGate(onSelect)
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: /Profile 3/ })) })
    expect(onSelect).toHaveBeenCalledWith(3)
    expect(screen.queryByRole('dialog', { name: "Who's watching?" })).not.toBeInTheDocument()
  })

  it('labels a locked profile', () => {
    renderGate(() => true)
    // In words, wherever the fact falls in the line (the limit leads it).
    expect(screen.getByRole('radio', { name: /Profile 2/ })).toHaveTextContent(/locked with a PIN/i)
    expect(screen.getByRole('radio', { name: /Profile 2/ }).querySelector('[data-profile-lock]')).not.toBeNull()
    expect(screen.getByRole('radio', { name: /Profile 3/ })).not.toHaveTextContent(/locked/i)
    expect(screen.getByRole('radio', { name: /Profile 3/ }).querySelector('[data-profile-lock]')).toBeNull()
  })

  // A child's profile must not look like a parent's: the limit is on the
  // avatar and in words, and a profile without one says so.
  it('says each profile\u2019s rating limit, in words and on the avatar', () => {
    const kid: Profile = { ...profiles[2], name: 'Kid', max_age_rating: 'PG' }
    render(<ProfilesGate profiles={[profiles[0], profiles[1], kid]} activeProfileId={1} onSelect={() => true} ready forced />)
    const kidTile = screen.getByRole('radio', { name: /Kid/ })
    expect(kidTile).toHaveTextContent('Up to PG')
    expect(kidTile.querySelector('[data-profile-limit]')?.textContent).toBe('PG')
    const parent = screen.getByRole('radio', { name: /Profile 1/ })
    expect(parent.querySelector('[data-profile-limit]')).toBeNull()
    expect(parent).not.toHaveTextContent('Up to')
  })

  // Ids are a server-wide serial: 1 and 10 land on the same colour by
  // themselves. Within one account they must not.
  it('gives two profiles different colours even when their ids alone would share one', () => {
    render(<ProfilesGate profiles={[profile(1), profile(10)]} activeProfileId={1} onSelect={() => true} ready forced />)
    const discs = [...document.querySelectorAll<HTMLElement>('[data-profile-avatar="initial"]')]
    expect(discs).toHaveLength(2)
    expect(discs[0].style.background).not.toBe(discs[1].style.background)
  })

  // The identity menu, the tab bar and the PIN prompt are not handed the
  // account's list: they take their colours from what the picker publishes,
  // whether or not the picker itself is showing.
  it('colours an avatar drawn elsewhere from the same set, even while the picker is closed', () => {
    localStorage.setItem('aurora_prefs', JSON.stringify({ profile_gate_seen: true }))
    const { container } = render(
      <>
        <ProfilesGate profiles={[profile(1), profile(10)]} activeProfileId={1} onSelect={() => true} ready />
        <ProfileAvatar name="Profile 1" colorKey={1} />
        <ProfileAvatar name="Profile 10" colorKey={10} />
      </>,
    )
    expect(screen.queryByRole('dialog', { name: "Who's watching?" })).toBeNull()
    const [one, ten] = [...container.querySelectorAll<HTMLElement>('[data-profile-avatar="initial"]')]
    // 1 and 10 are both 1 modulo nine; 10 is moved to the next free colour.
    expect(one.style.background).not.toBe(ten.style.background)
    const swatch = (hex: string) => { const el = document.createElement('i'); el.style.background = hex; return el.style.background }
    expect(one.style.background).toBe(swatch(PERSON_COLORS[1]))
    expect(ten.style.background).toBe(swatch(PERSON_COLORS[2]))
  })

  it('says "no limit" for every profile that has none, a default or locked one included', () => {
    const kid: Profile = { ...profile(3), name: 'Kid', max_age_rating: 'PG', has_pin: true }
    render(<ProfilesGate profiles={[profiles[0], profiles[1], kid]} activeProfileId={1} onSelect={() => true} ready forced />)
    // The whole line, so a fact stated twice fails too. The limit leads it
    // (lib/navScope.profileSummary).
    const line = (name: RegExp) => screen.getByRole('radio', { name }).querySelector('[data-profile-summary]')?.textContent
    expect(line(/Profile 1/)).toBe('No limit · default')
    expect(line(/Profile 2/)).toBe('No limit · locked with a PIN')
    expect(line(/Kid/)).toBe('Up to PG · locked with a PIN')
    expect(screen.getByRole('radio', { name: /Kid/ })).toHaveTextContent('Up to PG · locked with a PIN')
    expect(screen.getByRole('radio', { name: /Kid/ })).not.toHaveTextContent(/no limit/i)
  })

  it('gives profiles without a chosen avatar different colours', () => {
    renderGate(() => true)
    const discs = [...document.querySelectorAll<HTMLElement>('[data-profile-avatar="initial"]')]
    expect(discs.length).toBe(profiles.length)
    expect(new Set(discs.map(d => d.style.background)).size).toBe(profiles.length)
  })

  // Opened by hand, the gate can be left for the profile already active.
  // Opened because the session's binding could not be read, there is none,
  // so it stays until a pick binds one.
  it('can be left only when a profile is active', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(
      <ProfilesGate profiles={profiles} activeProfileId={1} onSelect={() => true} ready forced onDismiss={onDismiss} />)
    expect(screen.getByRole('button', { name: /Keep watching as Profile 1/ })).toBeInTheDocument()

    rerender(<ProfilesGate profiles={profiles} activeProfileId={null} onSelect={() => true} ready forced onDismiss={onDismiss}
      onAddProfile={() => {}} />)
    expect(screen.queryByRole('button', { name: /Keep watching/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add profile/ })).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog', { name: "Who's watching?" }), { key: 'Escape' })
    expect(onDismiss).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: "Who's watching?" })).toBeInTheDocument()
  })
})
