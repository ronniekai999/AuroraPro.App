// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { pushEscapeLayer } from './escapeLayers'

const press = (key = 'Escape') => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  document.body.dispatchEvent(e)
  return e
}

describe('escape layers', () => {
  it('gives each Escape to the newest layer only, and keeps it from the app', () => {
    const app = vi.fn(), first = vi.fn(), second = vi.fn()
    window.addEventListener('keydown', app)
    const dropFirst = pushEscapeLayer(first)
    const dropSecond = pushEscapeLayer(second)
    press()
    expect([first.mock.calls.length, second.mock.calls.length, app.mock.calls.length]).toEqual([0, 1, 0])
    dropSecond()
    press()
    expect([first.mock.calls.length, second.mock.calls.length, app.mock.calls.length]).toEqual([1, 1, 0])
    dropFirst()
    press()
    expect(app).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', app)
  })

  it('lets every other key through', () => {
    const app = vi.fn(), layer = vi.fn()
    window.addEventListener('keydown', app)
    const drop = pushEscapeLayer(layer)
    press('a')
    expect(layer).not.toHaveBeenCalled()
    expect(app).toHaveBeenCalledTimes(1)
    drop()
    window.removeEventListener('keydown', app)
  })

  it('unregisters a layer from the middle without disturbing the one above it', () => {
    const lower = vi.fn(), upper = vi.fn()
    const dropLower = pushEscapeLayer(lower)
    const dropUpper = pushEscapeLayer(upper)
    dropLower()
    press()
    expect([lower.mock.calls.length, upper.mock.calls.length]).toEqual([0, 1])
    dropUpper()
  })
})
