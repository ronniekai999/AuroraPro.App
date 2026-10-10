// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { consumeDevicePairing, rememberDevicePairing } from './devicePairing'

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
