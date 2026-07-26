// The ref-counted body scroll lock (Aurora Stage Phase 7b).
//
// Three surfaces lock body overflow independently — the theater, the profile
// gate and TopNav's mobile sheet — and each used to save/restore the previous
// value itself. That composes only under LIFO release, and out-of-order release
// converted an under-lock into a PERMANENT `overflow: hidden`: the page becomes
// unscrollable until a reload, with no holder left to clear it. These tests pin
// the property the counter exists to provide, which is that release ORDER does
// not matter.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const style: Record<string, string> = { overflow: '' }
vi.stubGlobal('document', { body: { style } })

const { __resetScrollLockForTests, lockBodyScroll, scrollLockDepth } =
  await import('./scrollLock')

beforeEach(() => {
  style.overflow = ''
  __resetScrollLockForTests()
})

describe('lockBodyScroll', () => {
  it('locks and restores a single holder', () => {
    const release = lockBodyScroll()
    expect(style.overflow).toBe('hidden')
    release()
    expect(style.overflow).toBe('')
  })

  it('restores whatever was there before, not a hard-coded empty string', () => {
    style.overflow = 'scroll'
    const release = lockBodyScroll()
    expect(style.overflow).toBe('hidden')
    release()
    expect(style.overflow).toBe('scroll')
  })

  it('stays locked until the LAST holder releases (LIFO order)', () => {
    const a = lockBodyScroll()
    const b = lockBodyScroll()
    b()
    expect(style.overflow).toBe('hidden')
    a()
    expect(style.overflow).toBe('')
  })

  it('stays locked until the last holder releases (FIFO order — the old bug)', () => {
    // This is the case the per-surface save/restore got wrong in BOTH directions:
    // A releasing first restored '' while B still needed the lock (the page
    // scrolled behind a stationary player), and B releasing afterwards restored
    // the 'hidden' it had captured from A — permanently.
    const a = lockBodyScroll()
    const b = lockBodyScroll()
    a()
    expect(style.overflow).toBe('hidden')
    b()
    expect(style.overflow).toBe('')
  })

  it('is idempotent per handle, so a double cleanup cannot unbalance the count', () => {
    // React StrictMode double-invokes effect cleanups in development; if the
    // second call decremented again, one holder could release another's lock.
    const a = lockBodyScroll()
    const b = lockBodyScroll()
    a()
    a()
    a()
    expect(scrollLockDepth()).toBe(1)
    expect(style.overflow).toBe('hidden')
    b()
    expect(style.overflow).toBe('')
  })

  it('re-captures the pre-lock value on a later lock cycle', () => {
    const first = lockBodyScroll()
    first()
    style.overflow = 'clip'
    const second = lockBodyScroll()
    expect(style.overflow).toBe('hidden')
    second()
    expect(style.overflow).toBe('clip')
  })

  it('survives three interleaved holders releasing in an arbitrary order', () => {
    const a = lockBodyScroll()
    const b = lockBodyScroll()
    const c = lockBodyScroll()
    b(); c()
    expect(style.overflow).toBe('hidden')
    a()
    expect(style.overflow).toBe('')
    expect(scrollLockDepth()).toBe(0)
  })
})
