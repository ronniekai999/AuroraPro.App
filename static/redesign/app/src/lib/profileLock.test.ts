import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateProfile, APIError, getActiveProfile, profileErrorReason, setProfilePin, type Profile } from './api'
import { isRestrictedProfile, resolveStartupProfile } from './profileSession'

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

  it('never re-selects a remembered locked profile without its PIN', async () => {
    const activate = vi.fn(async () => {})
    expect(await resolveStartupProfile({ profiles, acting: kid, remembered: 1, activate })).toBe(2)
    expect(await resolveStartupProfile({ profiles, acting: kid, remembered: 3, activate })).toBe(2)
    expect(activate).not.toHaveBeenCalled()
  })

  it('falls back to the default only when the binding is unknown', async () => {
    const refuse = vi.fn(async () => { throw new Error('down') })
    expect(await resolveStartupProfile({ profiles, acting: null, remembered: null, activate: refuse })).toBe(1)
    expect(await resolveStartupProfile({ profiles, acting: null, remembered: 2, activate: refuse })).toBe(1)
    expect(await resolveStartupProfile({ profiles, acting: null, remembered: 2, activate: vi.fn(async () => {}) })).toBe(2)
    // A binding to a profile this list doesn't hold reads as unknown.
    expect(await resolveStartupProfile({ profiles, acting: profile(99), remembered: null, activate: refuse })).toBe(1)
  })

  it('has nothing to show without profiles', async () => {
    expect(await resolveStartupProfile({ profiles: [], acting: null, remembered: 2, activate: vi.fn() })).toBeNull()
  })
})
