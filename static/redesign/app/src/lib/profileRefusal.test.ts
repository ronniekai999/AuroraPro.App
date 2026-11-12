import { describe, expect, it } from 'vitest'
import { APIError } from './api'
import { refusalMessage, refusalReason, waitPhrase } from './profileRefusal'

const refusal = (reason: string, status = 409, retryAfterSec?: number) =>
  new APIError(status, 'server words for the log', { error: { code: status, message: 'server words for the log', reason } }, retryAfterSec)

describe('refusalReason', () => {
  it('reads the reason the profile routes send, and nothing else', () => {
    expect(refusalReason(refusal('profile_changed'))).toBe('profile_changed')
    expect(refusalReason(refusal('session_ended', 401))).toBe('session_ended')
    // A reason this build does not know, a flat error, no body, not an APIError.
    expect(refusalReason(refusal('something_new'))).toBeNull()
    expect(refusalReason(new APIError(400, 'bad', { error: 'bad' }))).toBeNull()
    expect(refusalReason(new APIError(500, 'HTTP 500', null))).toBeNull()
    expect(refusalReason(new Error('network down'))).toBeNull()
  })
})

describe('refusalMessage', () => {
  // The server's message is written for logs. Every reason the profile and
  // account routes send has words of its own here.
  it.each([
    ['profile_restricted', /content limit, so it cannot change this\. Switch to a profile without a limit first\./],
    ['last_unrestricted_profile', /One profile has to stay without a limit, so that someone can manage the others\./],
    ['profile_changed', /changed on another device a moment ago\. The list has been reloaded/],
    ['profile_pin_required', /This profile is locked\. Enter its PIN, or the account password/],
    ['profile_pin_invalid', /That PIN or password is not right\./],
    ['session_unbound', /cannot hold a profile yet\. Reload the page/],
    ['session_ended', /This device has been signed out\. Sign in again/],
  ])('has plain words for %s', (reason, words) => {
    const said = refusalMessage(refusal(reason), 'fallback')
    expect(said).toMatch(words)
    expect(said).not.toContain('server words')
  })

  it('says how long a lockout lasts, from Retry-After, and 15 minutes without one', () => {
    expect(refusalMessage(refusal('profile_pin_locked', 429, 540), 'x')).toBe('Too many wrong attempts. Try again in about 9 minutes.')
    expect(refusalMessage(refusal('profile_pin_locked', 429, 40), 'x')).toBe('Too many wrong attempts. Try again in about a minute.')
    expect(refusalMessage(refusal('profile_pin_locked', 429), 'x')).toBe('Too many wrong attempts. Try again in 15 minutes.')
    expect(refusalMessage(refusal('rate_limited', 429, 900), 'x')).toBe('Too many PIN changes in a short time. Try again in about 15 minutes.')
  })

  it('keeps the server\'s message for a refusal with no reason it knows, and the fallback for none at all', () => {
    expect(refusalMessage(new APIError(400, 'maximum number of profiles reached', null), 'fallback')).toBe('maximum number of profiles reached')
    expect(refusalMessage(new TypeError(''), 'fallback')).toBe('fallback')
    expect(refusalMessage(null, 'fallback')).toBe('fallback')
  })
})

describe('waitPhrase', () => {
  it('rounds up to whole minutes and never promises to the second', () => {
    expect(waitPhrase(61, 'soon')).toBe('in about 2 minutes')
    expect(waitPhrase(60, 'soon')).toBe('in about a minute')
    expect(waitPhrase(0, 'soon')).toBe('soon')
    expect(waitPhrase(undefined, 'soon')).toBe('soon')
  })
})
