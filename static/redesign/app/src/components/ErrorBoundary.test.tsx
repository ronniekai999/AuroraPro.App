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

  // It is drawn with inline values (the stylesheet may be what failed), and
  // they are the app's: its page colour, a white primary action, a quiet
  // second one. It used to be a violet button on a blue-black of its own.
  it('is drawn in the app\'s own colours, with nothing violet', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Throws message="Cannot read properties of undefined" /></ErrorBoundary>)
    expect(screen.getByRole('alert')).toHaveStyle({ background: 'rgb(14, 15, 17)', color: 'rgb(244, 244, 245)' })
    expect(screen.getByRole('button', { name: 'Reload page' })).toHaveStyle({ background: 'rgb(255, 255, 255)', color: 'rgb(14, 15, 17)' })
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveStyle({ background: 'rgb(32, 34, 38)', color: 'rgb(244, 244, 245)' })
    expect(screen.getByRole('alert').outerHTML).not.toMatch(/7c3aed|124, 58, 237/i)
  })

  it('keeps the general message and retry for any other error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Throws message="Cannot read properties of undefined" /></ErrorBoundary>)
    expect(screen.getByRole('heading')).toHaveTextContent('Aurora hit an unexpected error')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
