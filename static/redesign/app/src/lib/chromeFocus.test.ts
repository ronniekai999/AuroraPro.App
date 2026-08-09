// @vitest-environment jsdom
//
// Regression coverage for the 2026-08-09 fullscreen auto-hide bug: clicking
// the fullscreen button (or any chrome control) left MOUSE focus stranded
// inside `[data-player-chrome]`, and the hide timer's focus guard — which
// existed to protect KEYBOARD users (WCAG 2.4.3) — read that as "keyboard
// user parked in the chrome" and refused to schedule the auto-hide forever.
// The guard is now modality-gated; these tests pin both halves of that gate.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bindInputModalityTracking,
  focusInChrome,
  __resetInputModalityForTests,
} from './chromeFocus'

describe('focusInChrome', () => {
  let chrome: HTMLDivElement
  let button: HTMLButtonElement
  let outside: HTMLButtonElement
  let unbind: (() => void) | null = null

  beforeEach(() => {
    __resetInputModalityForTests()
    document.body.innerHTML = ''
    chrome = document.createElement('div')
    chrome.setAttribute('data-player-chrome', '')
    button = document.createElement('button')
    chrome.appendChild(button)
    outside = document.createElement('button')
    document.body.append(chrome, outside)
  })

  afterEach(() => {
    unbind?.()
    unbind = null
    document.body.innerHTML = ''
  })

  const key = () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  const pointer = () =>
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))

  it('ignores focus that arrived via the mouse — the fullscreen-button case', () => {
    unbind = bindInputModalityTracking(window)
    pointer()
    button.focus() // browsers focus a clicked button; the click itself set modality
    expect(focusInChrome()).toBe(false)
  })

  it('still protects keyboard-originated focus inside the chrome (WCAG 2.4.3)', () => {
    unbind = bindInputModalityTracking(window)
    key()
    button.focus()
    expect(focusInChrome()).toBe(true)
  })

  it('returns false for keyboard focus OUTSIDE the chrome', () => {
    unbind = bindInputModalityTracking(window)
    key()
    outside.focus()
    expect(focusInChrome()).toBe(false)
  })

  it('returns false when nothing is focused, whatever the modality', () => {
    unbind = bindInputModalityTracking(window)
    key()
    expect(document.activeElement).toBe(document.body)
    expect(focusInChrome()).toBe(false)
  })

  it('follows the LATEST modality: keyboard focus stops pinning after a pointerdown', () => {
    unbind = bindInputModalityTracking(window)
    key()
    button.focus()
    expect(focusInChrome()).toBe(true)
    // A keyboard user who picks the mouse back up is on the pointer path now;
    // auto-hide must be allowed to re-arm (the inert focus-fixup they then
    // get is the accepted mixed-modality tradeoff, not the bug).
    pointer()
    expect(focusInChrome()).toBe(false)
  })

  it('sees modality changes through stopPropagation (capture-phase binding)', () => {
    unbind = bindInputModalityTracking(window)
    // The scrub bar stopPropagation()s the arrow keys it consumes; a
    // bubble-phase modality listener would miss exactly the keyboard events
    // most likely to precede chrome focus and read them as pointer input.
    window.addEventListener('keydown', (e) => e.stopPropagation(), false)
    key()
    button.focus()
    expect(focusInChrome()).toBe(true)
  })

  it('defaults to pointer modality so programmatic focus never pins the chrome', () => {
    // No events dispatched at all — e.g. the theater's opening focus move.
    // Reading that as keyboard would suppress the very first auto-hide.
    button.focus()
    expect(focusInChrome()).toBe(false)
  })

  it('stops tracking after unbind (player unmount)', () => {
    unbind = bindInputModalityTracking(window)
    unbind()
    unbind = null
    key()
    button.focus()
    expect(focusInChrome()).toBe(false)
  })
})
