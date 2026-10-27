// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppRoot } from './AppRoot'

// The desktop app, standing in for a tab opened before a deploy: its first
// visit to a lazy view asks for a chunk the deploy deleted.
vi.mock('./App.tsx', async () => {
  const { createElement, lazy, Suspense } = await import('react')
  const Gone = lazy(() => Promise.reject(new TypeError(
    'Failed to fetch dynamically imported module: https://aurora.example/v2/assets/AdminView-old.js')))
  return { default: () => createElement(Suspense, { fallback: null }, createElement(Gone)) }
})
vi.mock('./companion/CompanionApp', () => ({ CompanionApp: () => null }))

describe('AppRoot', () => {
  beforeEach(() => {
    const meta = document.createElement('meta')
    meta.name = 'aurora-build'
    meta.content = 'old-build'
    document.head.appendChild(meta)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<!doctype html><html><head><meta name="aurora-build" content="new-build"></head></html>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } })))
  })
  afterEach(() => {
    document.head.querySelector('meta[name="aurora-build"]')?.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // The boundary's fallback replaces the app and asks for an update check;
  // the notice has to be outside the boundary to still be there to answer.
  it('says a newer build is deployed when a deleted chunk takes the app down', async () => {
    render(<AppRoot basename="" />)
    expect(await screen.findByRole('heading', { name: "Part of Aurora couldn't load" })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalled()
  })
})
