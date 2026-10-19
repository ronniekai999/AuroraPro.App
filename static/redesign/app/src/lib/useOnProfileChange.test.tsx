// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useOnProfileChange } from './useOnProfileChange'

describe('useOnProfileChange', () => {
  it('fires on every change after the first render, unknown included', () => {
    const onChange = vi.fn()
    const hook = renderHook(({ id }) => useOnProfileChange(id, onChange), {
      initialProps: { id: null as number | null },
    })
    expect(onChange).not.toHaveBeenCalled()
    // Startup: the binding becomes known. Lists fetched before it was known
    // were filtered for whatever the server bound then.
    hook.rerender({ id: 2 })
    expect(onChange).toHaveBeenCalledTimes(1)
    hook.rerender({ id: 2 })
    expect(onChange).toHaveBeenCalledTimes(1)
    hook.rerender({ id: 1 })
    expect(onChange).toHaveBeenCalledTimes(2)
    hook.rerender({ id: null })
    expect(onChange).toHaveBeenCalledTimes(3)
    hook.rerender({ id: 2 })
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('does not fire on mount, or when only the callback changes', () => {
    const first = vi.fn()
    const hook = renderHook(({ cb }) => useOnProfileChange(1, cb), { initialProps: { cb: first } })
    const second = vi.fn()
    hook.rerender({ cb: second })
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })
})
