// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { APIError, type Profile } from './api'
import { useProfileSwitch } from './useProfileSwitch'

const api = vi.hoisted(() => ({ activateProfile: vi.fn() }))
vi.mock('./api', async importOriginal => ({ ...(await importOriginal<typeof import('./api')>()), ...api }))

const profile = (id: number, extra: Partial<Profile> = {}): Profile => ({
  id, user_id: 1, name: `p${id}`, is_default: id === 1, created_at: '', updated_at: '', ...extra,
})
const parent = profile(1, { has_pin: true })
const kid = profile(2, { max_age_rating: 'PG' })
const other = profile(3)

const refusal = (reason: string) =>
  new APIError(403, 'refused', { error: { code: 403, message: 'refused', reason } })

function setup(activeProfileId = 2, readBinding?: () => Promise<Profile>, onBound?: (p: Profile) => void) {
  const setActiveProfileId = vi.fn()
  const onError = vi.fn()
  const hook = renderHook(() => useProfileSwitch({
    profiles: [parent, kid, other], activeProfileId, setActiveProfileId, onError, readBinding, onBound,
  }))
  return { hook, setActiveProfileId, onError }
}

describe('useProfileSwitch', () => {
  beforeEach(() => { api.activateProfile.mockReset() })

  it('switches an unlocked profile only after the server binds it', async () => {
    let bind!: () => void
    api.activateProfile.mockImplementation(() => new Promise<void>(r => { bind = r }))
    const { hook, setActiveProfileId } = setup()
    let switched: Promise<boolean>
    act(() => { switched = hook.result.current.switchProfile(3) })
    expect(api.activateProfile).toHaveBeenCalledWith(3)
    expect(setActiveProfileId).not.toHaveBeenCalled()
    await act(async () => { bind() })
    await expect(switched!).resolves.toBe(true)
    expect(setActiveProfileId).toHaveBeenCalledWith(3)
  })

  it('keeps the current profile when the server refuses', async () => {
    api.activateProfile.mockRejectedValue(new APIError(409, 'session no longer active', null))
    const { hook, setActiveProfileId, onError } = setup()
    let switched = true
    await act(async () => { switched = await hook.result.current.switchProfile(3) })
    expect(switched).toBe(false)
    expect(setActiveProfileId).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(other)
  })

  // The list's copy can predate an edit from another device.
  it('shows the server’s record of the profile it bound', async () => {
    api.activateProfile.mockResolvedValue(undefined)
    const fresh = profile(3, { max_age_rating: 'PG', name: 'renamed' })
    const readBinding = vi.fn().mockResolvedValue(fresh)
    const onBound = vi.fn()
    const { hook, setActiveProfileId } = setup(2, readBinding, onBound)
    let switched = false
    await act(async () => { switched = await hook.result.current.switchProfile(3) })
    expect(switched).toBe(true)
    expect(onBound).toHaveBeenCalledWith(fresh)
    expect(setActiveProfileId).toHaveBeenCalledWith(3)
  })

  it('shows the binding the server reports, even another tab’s, and the list’s copy when it cannot read', async () => {
    api.activateProfile.mockResolvedValue(undefined)
    const moved = setup(2, vi.fn().mockResolvedValue(parent), vi.fn())
    await act(async () => { await moved.hook.result.current.switchProfile(3) })
    expect(moved.setActiveProfileId).toHaveBeenCalledWith(1)
    const unread = setup(2, vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), vi.fn())
    await act(async () => { await unread.hook.result.current.switchProfile(3) })
    expect(unread.setActiveProfileId).toHaveBeenCalledWith(3)
  })

  it('stores the server’s record after a PIN unlock too', async () => {
    api.activateProfile.mockResolvedValue(undefined)
    const fresh = profile(1, { is_default: true, has_pin: true, name: 'renamed' })
    const onBound = vi.fn()
    const { hook, setActiveProfileId } = setup(2, vi.fn().mockResolvedValue(fresh), onBound)
    let switched: Promise<boolean>
    act(() => { switched = hook.result.current.switchProfile(1) })
    await act(async () => { await hook.result.current.unlock({ pin: '1234' }) })
    expect(onBound).toHaveBeenCalledWith(fresh)
    expect(setActiveProfileId).toHaveBeenCalledWith(1)
    expect(await switched!).toBe(true)
  })

  it('shows the binding after a failure whose bind may have happened', async () => {
    api.activateProfile.mockRejectedValue(new TypeError('Failed to fetch'))
    const readBinding = vi.fn().mockResolvedValue(other)
    const { hook, setActiveProfileId, onError } = setup(2, readBinding)
    let switched = true
    await act(async () => { switched = await hook.result.current.switchProfile(3) })
    expect(switched).toBe(false)
    expect(onError).toHaveBeenCalledWith(other)
    expect(readBinding).toHaveBeenCalledTimes(1)
    expect(setActiveProfileId).toHaveBeenCalledWith(3)
  })

  it('keeps the profile on screen when the binding read agrees or fails', async () => {
    api.activateProfile.mockRejectedValue(new TypeError('Failed to fetch'))
    const agrees = setup(2, vi.fn().mockResolvedValue(kid))
    await act(async () => { await agrees.hook.result.current.switchProfile(3) })
    expect(agrees.setActiveProfileId).not.toHaveBeenCalled()
    const fails = setup(2, vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await act(async () => { await fails.hook.result.current.switchProfile(3) })
    expect(fails.setActiveProfileId).not.toHaveBeenCalled()
  })

  it('stays in flight while it reads the binding back', async () => {
    api.activateProfile.mockRejectedValue(new TypeError('Failed to fetch'))
    let answer!: (p: Profile) => void
    const readBinding = vi.fn(() => new Promise<Profile>(r => { answer = r }))
    const { hook } = setup(2, readBinding)
    let first: Promise<boolean>
    await act(async () => { first = hook.result.current.switchProfile(3) })
    expect(hook.result.current.isSwitching()).toBe(true)
    let second = true
    await act(async () => { second = await hook.result.current.switchProfile(1) })
    expect(second).toBe(false)
    await act(async () => { answer(kid); await first })
    expect(hook.result.current.isSwitching()).toBe(false)
  })

  it('finishes a PIN unlock whose answer was lost if the session is on the profile', async () => {
    api.activateProfile.mockRejectedValue(new TypeError('Failed to fetch'))
    const readBinding = vi.fn().mockResolvedValue(parent)
    const { hook, setActiveProfileId } = setup(2, readBinding)
    let switched: Promise<boolean>
    act(() => { switched = hook.result.current.switchProfile(1) })
    expect(hook.result.current.pinTarget).toBe(parent)
    await act(async () => { await hook.result.current.unlock({ pin: '1234' }) })
    expect(setActiveProfileId).toHaveBeenCalledWith(1)
    expect(await switched!).toBe(true)
    expect(hook.result.current.pinTarget).toBeNull()
  })

  it('keeps the PIN prompt up when an unlock fails and the session is elsewhere', async () => {
    api.activateProfile.mockRejectedValue(new TypeError('Failed to fetch'))
    const readBinding = vi.fn().mockResolvedValue(kid)
    const { hook, setActiveProfileId } = setup(2, readBinding)
    act(() => { void hook.result.current.switchProfile(1) })
    await act(async () => {
      await expect(hook.result.current.unlock({ pin: '1234' })).rejects.toThrow('Failed to fetch')
    })
    expect(setActiveProfileId).not.toHaveBeenCalled()
    expect(hook.result.current.pinTarget).toBe(parent)
  })

  it('does not re-read the binding after a refused unlock', async () => {
    api.activateProfile.mockRejectedValue(refusal('profile_pin_invalid'))
    const readBinding = vi.fn().mockResolvedValue(parent)
    const { hook, setActiveProfileId } = setup(2, readBinding)
    act(() => { void hook.result.current.switchProfile(1) })
    await act(async () => {
      await expect(hook.result.current.unlock({ pin: '0000' })).rejects.toBeInstanceOf(APIError)
    })
    expect(readBinding).not.toHaveBeenCalled()
    expect(setActiveProfileId).not.toHaveBeenCalled()
  })

  it('asks for a locked profile’s PIN and switches once it is accepted', async () => {
    api.activateProfile.mockResolvedValue(undefined)
    const { hook, setActiveProfileId } = setup()
    let switched: Promise<boolean>
    act(() => { switched = hook.result.current.switchProfile(1) })
    expect(hook.result.current.pinTarget).toEqual(parent)
    expect(api.activateProfile).not.toHaveBeenCalled()

    api.activateProfile.mockRejectedValueOnce(refusal('profile_pin_invalid'))
    await act(async () => {
      await expect(hook.result.current.unlock({ pin: '0000' })).rejects.toBeInstanceOf(APIError)
    })
    expect(setActiveProfileId).not.toHaveBeenCalled()
    expect(hook.result.current.pinTarget).toEqual(parent) // still asking

    await act(async () => { await hook.result.current.unlock({ pin: '1234' }) })
    expect(api.activateProfile).toHaveBeenLastCalledWith(1, { pin: '1234' })
    expect(setActiveProfileId).toHaveBeenCalledWith(1)
    expect(hook.result.current.pinTarget).toBeNull()
    await expect(switched!).resolves.toBe(true)
  })

  it('reports a cancelled PIN prompt as no switch', async () => {
    const { hook, setActiveProfileId } = setup()
    let switched: Promise<boolean>
    act(() => { switched = hook.result.current.switchProfile(1) })
    act(() => { hook.result.current.cancelPin() })
    await expect(switched!).resolves.toBe(false)
    expect(hook.result.current.pinTarget).toBeNull()
    expect(setActiveProfileId).not.toHaveBeenCalled()
  })

  it('asks for a PIN the profile list did not know about', async () => {
    api.activateProfile.mockRejectedValueOnce(refusal('profile_pin_required'))
    const { hook, onError } = setup()
    await act(async () => { void hook.result.current.switchProfile(3) })
    expect(hook.result.current.pinTarget).toEqual(other)
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores a second switch while one is in flight', async () => {
    let bind!: () => void
    api.activateProfile.mockImplementation(() => new Promise<void>(r => { bind = r }))
    const { hook, setActiveProfileId } = setup()
    let first: Promise<boolean>
    act(() => { first = hook.result.current.switchProfile(3) })
    expect(hook.result.current.isSwitching()).toBe(true)
    await expect(hook.result.current.switchProfile(1)).resolves.toBe(false)
    expect(api.activateProfile).toHaveBeenCalledTimes(1)
    await act(async () => { bind() })
    await expect(first!).resolves.toBe(true)
    expect(setActiveProfileId).toHaveBeenCalledWith(3)
    expect(hook.result.current.isSwitching()).toBe(false)
  })

  it('counts each switch it starts, so a background read can tell it is stale', async () => {
    api.activateProfile.mockResolvedValue(undefined)
    const { hook } = setup()
    expect(hook.result.current.switchGeneration()).toBe(0)
    await act(async () => { await hook.result.current.switchProfile(3) })
    expect(hook.result.current.switchGeneration()).toBe(1)
    act(() => { void hook.result.current.switchProfile(1) }) // asks for a PIN
    expect(hook.result.current.switchGeneration()).toBe(2)
  })

  it('treats the current profile as already switched', async () => {
    const { hook } = setup(2)
    await expect(hook.result.current.switchProfile(2)).resolves.toBe(true)
    expect(api.activateProfile).not.toHaveBeenCalled()
  })
})
