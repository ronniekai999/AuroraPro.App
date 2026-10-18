// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Profile } from './api'
import { readRememberedProfileId, rememberProfileId, useSessionProfileOnVisible } from './profileSession'

const profile = (id: number): Profile => ({ id, user_id: 1, name: `p${id}`, is_default: id === 1, created_at: '', updated_at: '' })
const profiles = [profile(1), profile(2)]

function setup(read: () => Promise<Profile>, switching = { isSwitching: () => false, switchGeneration: () => 0 },
  reloadProfiles?: () => Promise<Profile[]>) {
  let shown: number | null = 1
  const setActiveProfileId = vi.fn((update: (prev: number | null) => number | null) => { shown = update(shown) })
  const setProfiles = vi.fn()
  renderHook(() => useSessionProfileOnVisible({
    enabled: true, profiles, read, setActiveProfileId, switching, reloadProfiles, setProfiles,
  }))
  return { shown: () => shown, setActiveProfileId, setProfiles }
}

async function becomeVisible() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
}

describe('useSessionProfileOnVisible', () => {
  afterEach(() => { Reflect.deleteProperty(document, 'visibilityState') })

  it('shows the binding another tab moved the session to', async () => {
    const view = setup(async () => profile(2))
    await becomeVisible()
    expect(view.shown()).toBe(2)
  })

  it('re-lists the profiles when the binding names one the list lacks', async () => {
    const fresh = [...profiles, profile(9)]
    const view = setup(async () => profile(9), undefined, async () => fresh)
    await becomeVisible()
    expect(view.setProfiles).toHaveBeenCalledWith(fresh)
    expect(view.shown()).toBe(9)
  })

  it('keeps the profile on screen when the new list still lacks the binding', async () => {
    const view = setup(async () => profile(9), undefined, async () => profiles)
    await becomeVisible()
    expect(view.setProfiles).toHaveBeenCalledWith(profiles)
    expect(view.shown()).toBe(1)
  })

  it('drops a re-list once a switch has started since the read', async () => {
    let generation = 0
    let listed!: (ps: Profile[]) => void
    const view = setup(async () => profile(9), { isSwitching: () => false, switchGeneration: () => generation },
      () => new Promise<Profile[]>(r => { listed = r }))
    await becomeVisible()
    generation++
    await act(async () => { listed([...profiles, profile(9)]) })
    expect(view.setProfiles).not.toHaveBeenCalled()
    expect(view.shown()).toBe(1)
  })

  // A switch that starts and finishes while the read is in flight is newer
  // than the read's answer.
  it('drops an answer once a switch has started since the read', async () => {
    let generation = 0
    let answer!: (p: Profile) => void
    const view = setup(() => new Promise<Profile>(r => { answer = r }),
      { isSwitching: () => false, switchGeneration: () => generation })
    await becomeVisible()
    generation++ // a switch started, and has already finished
    await act(async () => { answer(profile(2)) })
    expect(view.setActiveProfileId).not.toHaveBeenCalled()
    expect(view.shown()).toBe(1)
  })

  it('does not read while a switch is under way', async () => {
    const read = vi.fn(async () => profile(2))
    setup(read, { isSwitching: () => true, switchGeneration: () => 0 })
    await becomeVisible()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('the remembered profile', () => {
  beforeEach(() => { localStorage.clear() })
  it('round-trips, and reads as none when unset or garbage', () => {
    expect(readRememberedProfileId()).toBeNull()
    rememberProfileId(7)
    expect(readRememberedProfileId()).toBe(7)
    localStorage.setItem('aurora_active_profile_id', 'x')
    expect(readRememberedProfileId()).toBeNull()
  })
})
