import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateProfile, APIError, getActiveProfile, profileErrorReason, setProfilePin, type Profile } from './api'
import { isRestrictedProfile, isSoleUnrestrictedProfile, loadStartupProfiles, openDoorProfiles, readSessionProfile, resolveStartupProfile, showsAdminUI } from './profileSession'

const profile = (id: number, extra: Partial<Profile> = {}): Profile => ({
  id, user_id: 1, name: `p${id}`, is_default: false, created_at: '', updated_at: '', ...extra,
})

describe('profile lock API calls', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const sent = () => fetchMock.mock.calls.map(([url, o]) => [url, o.method ?? 'GET', o.body ? JSON.parse(o.body) : undefined])

  it('activates with no body when no unlock is given, and with the PIN or password when one is', async () => {
    await activateProfile(3)
    await activateProfile(3, { pin: '1234' })
    await activateProfile(3, { password: 'hunter2' })
    expect(sent()).toEqual([
      ['/api/profiles/3/activate', 'POST', undefined],
      ['/api/profiles/3/activate', 'POST', { pin: '1234' }],
      ['/api/profiles/3/activate', 'POST', { password: 'hunter2' }],
    ])
  })

  it('reads the session binding and sets, changes and removes PINs', async () => {
    await getActiveProfile()
    await setProfilePin(4, '1234')
    await setProfilePin(4, '5678', { pin: '1234' })
    await setProfilePin(4, '', { password: 'hunter2' })
    expect(sent()).toEqual([
      ['/api/profiles/active', 'GET', undefined],
      ['/api/profiles/4/pin', 'PUT', { pin: '1234' }],
      ['/api/profiles/4/pin', 'PUT', { pin: '5678', current_pin: '1234' }],
      ['/api/profiles/4/pin', 'PUT', { pin: '', password: 'hunter2' }],
    ])
  })

  it('refreshes and retries once when the session cannot be bound (409)', async () => {
    const conflict = () => new Response(
      JSON.stringify({ error: { code: 409, message: 'refresh and retry', reason: 'session_unbound' } }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )
    fetchMock
      .mockImplementationOnce(async () => conflict())
      .mockImplementationOnce(async () => new Response(JSON.stringify({ expires_in: 900 }), { headers: { 'Content-Type': 'application/json' } }))
    await activateProfile(5)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/profiles/5/activate', '/api/auth/refresh', '/api/profiles/5/activate'])
  })

  it('surfaces the server reason on a refused activation', async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ error: { code: 403, message: 'this profile is locked; enter its PIN', reason: 'profile_pin_required' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ))
    const err = await activateProfile(3).catch(e => e)
    expect(err).toBeInstanceOf(APIError)
    expect(profileErrorReason(err)).toBe('profile_pin_required')
  })
})

describe('profileErrorReason', () => {
  const withReason = (reason: unknown) => new APIError(403, 'x', { error: { code: 403, message: 'x', reason } })
  it('reads each known reason', () => {
    for (const r of ['profile_pin_required', 'profile_pin_invalid', 'profile_pin_locked', 'profile_restricted']) {
      expect(profileErrorReason(withReason(r))).toBe(r)
    }
  })
  it('is null for anything else', () => {
    expect(profileErrorReason(withReason('something_else'))).toBeNull()
    expect(profileErrorReason(new APIError(403, 'x', { error: 'flat message' }))).toBeNull()
    expect(profileErrorReason(new APIError(500, 'x', 'text body'))).toBeNull()
    expect(profileErrorReason(new Error('plain'))).toBeNull()
    expect(profileErrorReason(undefined)).toBeNull()
  })
})

describe('isRestrictedProfile', () => {
  it('is true only for a profile with a ceiling', () => {
    expect(isRestrictedProfile(profile(1, { max_age_rating: 'PG' }))).toBe(true)
    expect(isRestrictedProfile(profile(1, { max_age_rating: '' }))).toBe(false)
    expect(isRestrictedProfile(profile(1))).toBe(false)
    expect(isRestrictedProfile(null)).toBe(false)
  })
})

describe('showsAdminUI', () => {
  const parent = profile(1, { is_default: true })
  const kid = profile(2, { max_age_rating: 'PG' })

  it('shows the admin UI to an admin session bound to an unrestricted profile', () => {
    expect(showsAdminUI('admin', [parent, kid], true, 1)).toBe(true)
  })

  it('hides it while the session acts as a restricted profile', () => {
    expect(showsAdminUI('admin', [parent, kid], true, 2)).toBe(false)
  })

  it('hides it while the binding is unknown or the bound profile is not in the list', () => {
    expect(showsAdminUI('admin', [parent, kid], true, null)).toBe(false)
    expect(showsAdminUI('admin', [parent], true, 2)).toBe(false)
    // The profile list failed to load: nothing is known.
    expect(showsAdminUI('admin', [], false, null)).toBe(false)
  })

  it('shows it to an admin account with no profile at all', () => {
    expect(showsAdminUI('admin', [], true, null)).toBe(true)
  })

  it('never shows it to a non-admin', () => {
    expect(showsAdminUI('user', [parent], true, 1)).toBe(false)
    expect(showsAdminUI(undefined, [], true, null)).toBe(false)
    expect(showsAdminUI('Admin', [parent], true, 1)).toBe(false)
  })
})

describe('resolveStartupProfile', () => {
  const parent = profile(1, { is_default: true, has_pin: true })
  const kid = profile(2, { max_age_rating: 'PG' })
  const teen = profile(3, { max_age_rating: 'TV-14', has_pin: true })
  const profiles = [parent, kid, teen]

  it('shows the server binding when nothing else is remembered', async () => {
    const activate = vi.fn(async () => {})
    expect(await resolveStartupProfile({ profiles, acting: kid, remembered: null, activate })).toBe(2)
    expect(await resolveStartupProfile({ profiles, acting: kid, remembered: 2, activate })).toBe(2)
    expect(activate).not.toHaveBeenCalled()
  })

  it('re-selects a remembered unlocked profile only once the server accepts it', async () => {
    const activate = vi.fn(async () => {})
    expect(await resolveStartupProfile({ profiles, acting: parent, remembered: 2, activate })).toBe(2)
    expect(activate).toHaveBeenCalledWith(2)

    const refuse = vi.fn(async () => { throw new Error('409') })
    expect(await resolveStartupProfile({ profiles, acting: parent, remembered: 2, activate: refuse })).toBe(1)
  })

  it('reads the binding again when a re-selection fails', async () => {
    const lost = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    // The bind happened; only its answer was lost.
    expect(await resolveStartupProfile({
      profiles, acting: parent, remembered: 2, activate: lost, reread: async () => kid,
    })).toBe(2)
    expect(await resolveStartupProfile({
      profiles, acting: parent, remembered: 2, activate: lost, reread: async () => parent,
    })).toBe(1)
    // Unreadable: the binding is unknown, so the host asks.
    expect(await resolveStartupProfile({
      profiles, acting: parent, remembered: 2, activate: lost, reread: async () => { throw new Error('down') },
    })).toBeNull()
  })

  it('never re-selects a remembered locked profile without its PIN', async () => {
    const activate = vi.fn(async () => {})
    expect(await resolveStartupProfile({ profiles, acting: kid, remembered: 1, activate })).toBe(2)
    expect(await resolveStartupProfile({ profiles, acting: kid, remembered: 3, activate })).toBe(2)
    expect(activate).not.toHaveBeenCalled()
  })

  // Showing the default for an unknown binding showed a kid's device the
  // parent's name while the server enforced the kid's ceiling.
  it('shows no profile when the binding is unknown, so the host asks', async () => {
    const refuse = vi.fn(async () => { throw new Error('down') })
    expect(await resolveStartupProfile({ profiles, acting: null, remembered: null, activate: refuse })).toBeNull()
    expect(await resolveStartupProfile({ profiles, acting: null, remembered: 2, activate: refuse })).toBeNull()
    // A remembered profile the server accepts is a binding, not a guess.
    expect(await resolveStartupProfile({ profiles, acting: null, remembered: 2, activate: vi.fn(async () => {}) })).toBe(2)
    // A binding to a profile this list doesn't hold reads as unknown.
    expect(await resolveStartupProfile({ profiles, acting: profile(99), remembered: null, activate: refuse })).toBeNull()
    // With one profile there is nothing to guess.
    expect(await resolveStartupProfile({ profiles: [parent], acting: null, remembered: null, activate: refuse })).toBe(1)
  })

  it('has nothing to show without profiles', async () => {
    expect(await resolveStartupProfile({ profiles: [], acting: null, remembered: 2, activate: vi.fn() })).toBeNull()
  })
})

describe('readSessionProfile', () => {
  it('retries a failed read once, and gives up after two', async () => {
    const ok = profile(2)
    const flaky = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce(ok)
    expect(await readSessionProfile(flaky, 0)).toBe(ok)
    expect(flaky).toHaveBeenCalledTimes(2)

    const down = vi.fn().mockRejectedValue(new Error('down'))
    expect(await readSessionProfile(down, 0)).toBeNull()
    expect(down).toHaveBeenCalledTimes(2)

    const fine = vi.fn().mockResolvedValue(ok)
    expect(await readSessionProfile(fine, 0)).toBe(ok)
    expect(fine).toHaveBeenCalledTimes(1)
  })
})

describe('loadStartupProfiles', () => {
  const parent = profile(1, { is_default: true, has_pin: true })
  const kid = profile(2, { max_age_rating: 'PG' })
  const teen = profile(3)

  it('shows nothing when the profile list cannot be read', async () => {
    // The binding is read alongside the list, so it may be; nothing is bound.
    const read = vi.fn(async () => kid), activate = vi.fn()
    const result = await loadStartupProfiles({ list: async () => { throw new Error('down') }, read, activate, remembered: 2, retryMs: 0 })
    expect(result).toBeNull()
    expect(activate).not.toHaveBeenCalled()
  })

  it('reads the list and the binding at once', async () => {
    // The list answers only once the binding has been asked for, so a
    // sequential load would never finish.
    let asked!: () => void
    const bindingAsked = new Promise<void>(r => { asked = r })
    const read = vi.fn(async () => { asked(); return kid })
    const list = async () => { await bindingAsked; return [parent, kid, teen] }
    expect(await loadStartupProfiles({ list, read, activate: vi.fn(), remembered: null, retryMs: 0 }))
      .toEqual({ profiles: [parent, kid, teen], activeId: 2, askForProfile: false })
  })

  it('shows the binding, or a remembered unlocked profile the server accepts', async () => {
    const activate = vi.fn(async () => {})
    expect(await loadStartupProfiles({ list: async () => [parent, kid, teen], read: async () => kid, activate, remembered: null, retryMs: 0 }))
      .toEqual({ profiles: [parent, kid, teen], activeId: 2, askForProfile: false })
    expect(activate).not.toHaveBeenCalled()
    const switched = await loadStartupProfiles({ list: async () => [parent, kid, teen], read: async () => parent, activate, remembered: 3, retryMs: 0 })
    expect(switched?.activeId).toBe(3)
    expect(activate).toHaveBeenCalledWith(3)
  })

  it('asks when the binding cannot be read and there are several profiles', async () => {
    const down = async (): Promise<Profile> => { throw new Error('down') }
    expect(await loadStartupProfiles({ list: async () => [parent, kid], read: down, activate: vi.fn(), remembered: null, retryMs: 0 }))
      .toEqual({ profiles: [parent, kid], activeId: null, askForProfile: true })
    expect((await loadStartupProfiles({ list: async () => [parent], read: down, activate: vi.fn(), remembered: null, retryMs: 0 }))?.askForProfile)
      .toBe(false)
  })

  it('activates nothing once aborted', async () => {
    const ac = new AbortController()
    const activate = vi.fn(async () => {})
    const result = await loadStartupProfiles({
      list: async () => [parent, kid, teen], read: async () => { ac.abort(); return parent },
      activate, remembered: 3, signal: ac.signal, retryMs: 0,
    })
    expect(result).toBeNull()
    expect(activate).not.toHaveBeenCalled()
  })
})

describe('openDoorProfiles', () => {
  const names = (ps: Profile[]) => openDoorProfiles(ps).map(p => p.name)
  it('lists the unlocked profiles a restricted one could loosen its limit in', () => {
    const parent = profile(1, { name: 'parent' })
    const locked = profile(2, { name: 'locked' , has_pin: true })
    const tv14 = profile(3, { name: 'teen', max_age_rating: 'TV-14' })
    const tvy = profile(4, { name: 'little', max_age_rating: 'TV-Y' })
    const tvy2 = profile(5, { name: 'twin', max_age_rating: 'tv-y ' })
    expect(names([parent, locked])).toEqual([]) // no restricted profile
    expect(names([parent, locked, tvy])).toEqual(['parent'])
    // TV-Y can switch into the unlocked TV-14 sibling: a looser limit.
    expect(names([locked, tv14, tvy])).toEqual(['teen', 'little'])
    // Profiles sharing one limit are no door to each other.
    expect(names([locked, tvy, tvy2])).toEqual([])
  })
})

describe('isSoleUnrestrictedProfile', () => {
  it('is true only for the one profile without a limit', () => {
    const parent = profile(1)
    const kid = profile(2, { max_age_rating: 'PG' })
    const spare = profile(3, { max_age_rating: ' ' })
    expect(isSoleUnrestrictedProfile([parent, kid], 1)).toBe(true)
    expect(isSoleUnrestrictedProfile([parent, kid], 2)).toBe(false)
    // A profile with a limit is never the one without, even with no other.
    expect(isSoleUnrestrictedProfile([kid, profile(4, { max_age_rating: 'TV-14' })], 2)).toBe(false)
    // A blank limit is no limit, so the parent is no longer the only one.
    expect(isSoleUnrestrictedProfile([parent, kid, spare], 1)).toBe(false)
    expect(isSoleUnrestrictedProfile([parent], 1)).toBe(true)
    expect(isSoleUnrestrictedProfile([parent, kid], null)).toBe(false)
    expect(isSoleUnrestrictedProfile([parent, kid], 9)).toBe(false)
  })
})
