// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'
import { STALE_BUNDLE_EVENT } from '@/lib/buildUpdate'

function Throws({ message }: { message: string }): never {
  throw new TypeError(message)
}

describe('ErrorBoundary', () => {
  afterEach(() => { vi.restoreAllMocks() })

  // A lazy view whose chunk the last deploy deleted. "Try again" cannot work:
  // the browser keeps the failed import.
  it('offers a reload for a chunk that will not load, and checks for an update', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const heard = vi.fn()
    window.addEventListener(STALE_BUNDLE_EVENT, heard)
    render(<ErrorBoundary><Throws message="Failed to fetch dynamically imported module: /v2/assets/AdminView-x.js" /></ErrorBoundary>)
    window.removeEventListener(STALE_BUNDLE_EVENT, heard)
    expect(screen.getByRole('heading')).toHaveTextContent("Part of Aurora couldn't load")
    // Not a claim of a deploy: going offline fails the same import.
    expect(screen.getByRole('alert')).toHaveTextContent('or the connection dropped')
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('keeps the general message and retry for any other error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Throws message="Cannot read properties of undefined" /></ErrorBoundary>)
    expect(screen.getByRole('heading')).toHaveTextContent('Aurora hit an unexpected error')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
