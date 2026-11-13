// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { consumeDeviceIntent, consumeDevicePairing, forgetDeviceIntent, rememberDeviceIntent, rememberDevicePairing } from './devicePairing'

beforeEach(() => sessionStorage.clear())
it('returns only a public code once after OAuth, with a ten minute expiry', () => {
  rememberDevicePairing('/v2/device', '?code=abcd-1234', 1000)
  expect(consumeDevicePairing(2000)).toBe('ABCD-1234')
  expect(consumeDevicePairing(2000)).toBeNull()
  rememberDevicePairing('/v2/device', '?code=abcd-1234', 1000)
  expect(consumeDevicePairing(601000)).toBeNull()
})
it('ignores arbitrary routes and malformed codes', () => {
  rememberDevicePairing('/v2/home', '?code=ABCD-1234')
  expect(consumeDevicePairing()).toBeNull()
  rememberDevicePairing('/v2/device', '?code=https://attacker.example')
  expect(consumeDevicePairing()).toBeNull()
  sessionStorage.setItem('aurora_tv_approval_v1', '{bad')
  expect(consumeDevicePairing()).toBeNull()
})

// "Connect a TV with a code", followed before signing in.
it('remembers that a viewer came to connect a TV: once, for ten minutes, and nothing else', () => {
  expect(consumeDeviceIntent()).toBe(false)
  rememberDeviceIntent(1000)
  expect(consumeDeviceIntent(2000)).toBe(true)
  expect(consumeDeviceIntent(2000)).toBe(false)
  rememberDeviceIntent(1000)
  expect(consumeDeviceIntent(601000)).toBe(false)
  // Read after its time, it is gone all the same.
  expect(sessionStorage.length).toBe(0)
  rememberDeviceIntent(1000)
  // Only a time is kept, and it is not the code's entry.
  expect(sessionStorage.length).toBe(1)
  expect(sessionStorage.getItem('aurora_tv_intent_v1')).toBe('601000')
  expect(consumeDevicePairing(2000)).toBeNull()
  forgetDeviceIntent()
  expect(consumeDeviceIntent(2000)).toBe(false)
})
it('takes nothing for an intent that is not a time it wrote', () => {
  for (const junk of ['', 'true', '/admin', 'https://attacker.example', '9e99', '-1', ' 99999999999999 ']) {
    sessionStorage.setItem('aurora_tv_intent_v1', junk)
    expect(consumeDeviceIntent(1000), junk).toBe(false)
    expect(sessionStorage.getItem('aurora_tv_intent_v1')).toBeNull()
  }
})
