// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Profile } from '@/lib/api'
import { ProfilesGate } from './ProfilesGate'

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
  beforeEach(() => { localStorage.clear() })

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
    expect(screen.getByRole('radio', { name: /Profile 2/ })).toHaveTextContent('Locked')
    expect(screen.getByRole('radio', { name: /Profile 3/ })).not.toHaveTextContent('Locked')
  })
})
