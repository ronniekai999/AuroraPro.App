// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ESCAPE_LAYERS_ATTR, inForeignDialog, pushEscapeLayer } from './escapeLayers'

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

  // The same function registered twice is two layers, and an unregister
  // called twice (an effect cleanup after an explicit close) removes one.
  it('counts each registration on its own', () => {
    const close = vi.fn()
    const dropFirst = pushEscapeLayer(close)
    const dropSecond = pushEscapeLayer(close)
    dropSecond()
    dropSecond()
    press()
    expect(close).toHaveBeenCalledTimes(1)
    dropFirst()
    const app = vi.fn()
    window.addEventListener('keydown', app)
    press()
    window.removeEventListener('keydown', app)
    expect(close).toHaveBeenCalledTimes(1)
    expect(app).toHaveBeenCalledTimes(1)
  })

  // A prompt the app opens above everything from elsewhere (the profile
  // picker or a PIN prompt, when another tab switches the profile) closes
  // itself on Escape. Taking the key would close a layer under it instead.
  it('leaves an Escape pressed inside a dialog that is none of its surfaces to that dialog', () => {
    const layer = vi.fn(), prompt = vi.fn()
    const drop = pushEscapeLayer(layer)
    const foreign = document.createElement('div')
    foreign.setAttribute('role', 'dialog')
    foreign.innerHTML = '<button>ok</button>'
    foreign.addEventListener('keydown', prompt)
    const ours = document.createElement('div')
    ours.setAttribute('role', 'dialog')
    ours.setAttribute(ESCAPE_LAYERS_ATTR, '')
    // A sheet inside one of the surfaces is a dialog too, and is ours.
    ours.innerHTML = '<div role="dialog"><button>item</button></div>'
    document.body.append(foreign, ours)
    const esc = (el: Element) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    esc(foreign.querySelector('button')!)
    expect([layer.mock.calls.length, prompt.mock.calls.length]).toEqual([0, 1])
    esc(ours.querySelector('button')!)
    expect(layer).toHaveBeenCalledTimes(1)

    expect(inForeignDialog(foreign.querySelector('button'))).toBe(true)
    expect(inForeignDialog(ours.querySelector('button'))).toBe(false)
    expect(inForeignDialog(document.body)).toBe(false)
    expect(inForeignDialog(null)).toBe(false)
    drop(); foreign.remove(); ours.remove()
  })
})
