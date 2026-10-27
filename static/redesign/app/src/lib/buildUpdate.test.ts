// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  CHECK_EVERY_MS, MIN_CHECK_INTERVAL_MS, STALE_BUNDLE_EVENT,
  fetchDeployedBuildId, isStaleBundleError, parseBuildIdFromHtml, readBuildId, useNewBuildAvailable,
} from './buildUpdate'

const page = (id: string) => `<!doctype html><html><head><meta name="aurora-build" content="${id}"></head><body></body></html>`

function htmlResponse(body: string, init: { status?: number; type?: string } = {}) {
  return new Response(body, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'text/html; charset=utf-8' } })
}

async function becomeVisible() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
}

async function fire(name: string) {
  await act(async () => { window.dispatchEvent(new Event(name)) })
}

describe('build ids', () => {
  it('reads the id the document was loaded with', () => {
    const doc = new DOMParser().parseFromString(page('abc123'), 'text/html')
    expect(readBuildId(doc)).toBe('abc123')
  })

  it('has no id without the meta, or with an empty one (the dev server)', () => {
    expect(parseBuildIdFromHtml('<html><head></head></html>')).toBeNull()
    expect(parseBuildIdFromHtml(page('  '))).toBeNull()
  })
})

describe('fetchDeployedBuildId', () => {
  it('asks /v2/ past every cache and reads its id', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(page('deployed')))
    expect(await fetchDeployedBuildId(fetchImpl as unknown as typeof fetch, '/v2/')).toBe('deployed')
    expect(fetchImpl).toHaveBeenCalledWith('/v2/', expect.objectContaining({ cache: 'no-store' }))
  })

  // A deploy mid-restart (proxy error page), offline, or something that is not
  // the SPA must never read as "a different build".
  it.each([
    ['an error status', async () => htmlResponse(page('x'), { status: 502 })],
    ['a non-HTML answer', async () => htmlResponse('{"a":1}', { type: 'application/json' })],
    ['a network failure', async () => { throw new TypeError('Failed to fetch') }],
  ])('says nothing on %s', async (_, impl) => {
    expect(await fetchDeployedBuildId(vi.fn(impl) as unknown as typeof fetch, '/v2/')).toBeNull()
  })
})

describe('isStaleBundleError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://a/v2/assets/AdminView-x.js',
    'error loading dynamically imported module: https://a/v2/assets/AdminView-x.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /v2/assets/AdminView-x.css',
  ])('recognises %s', message => {
    expect(isStaleBundleError(new TypeError(message))).toBe(true)
  })

  it('leaves ordinary errors alone', () => {
    expect(isStaleBundleError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isStaleBundleError(null)).toBe(false)
  })
})

describe('useNewBuildAvailable', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState')
    vi.useRealTimers()
  })

  function setup(deployed: () => Promise<string | null>, own: string | null = 'old') {
    let clock = 1_000_000
    const fetchDeployed = vi.fn(deployed)
    const view = renderHook(() => useNewBuildAvailable({ ownBuildId: own, fetchDeployed, now: () => clock }))
    return { view, fetchDeployed, advance: (ms: number) => { clock += ms } }
  }

  it('shows when the deployed build differs from this page', async () => {
    const { view } = setup(async () => 'new')
    await becomeVisible()
    expect(view.result.current.available).toBe(true)
  })

  it('stays quiet while the deployed build is this one, or cannot be read', async () => {
    let answer: string | null = 'old'
    const { view, advance } = setup(async () => answer)
    await becomeVisible()
    expect(view.result.current.available).toBe(false)
    answer = null
    advance(MIN_CHECK_INTERVAL_MS)
    await becomeVisible()
    expect(view.result.current.available).toBe(false)
  })

  it('never checks on a page that carries no build id', async () => {
    const { fetchDeployed } = setup(async () => 'new', null)
    await becomeVisible()
    await fire(STALE_BUNDLE_EVENT)
    expect(fetchDeployed).not.toHaveBeenCalled()
  })

  it('limits routine checks, but a failed chunk checks at once', async () => {
    const { fetchDeployed } = setup(async () => 'old')
    await becomeVisible()
    await fire('focus')
    expect(fetchDeployed).toHaveBeenCalledTimes(1)
    await fire(STALE_BUNDLE_EVENT)
    await fire('vite:preloadError')
    expect(fetchDeployed).toHaveBeenCalledTimes(3)
  })

  it('checks on a timer while the tab is visible', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    let clock = 1_000_000
    const fetchDeployed = vi.fn(async () => 'new')
    const view = renderHook(() => useNewBuildAvailable({ ownBuildId: 'old', fetchDeployed, now: () => clock }))
    expect(fetchDeployed).not.toHaveBeenCalled()
    clock += CHECK_EVERY_MS
    await act(async () => { await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS) })
    expect(fetchDeployed).toHaveBeenCalledTimes(1)
    expect(view.result.current.available).toBe(true)
  })

  it("uses the caller's latest function after a rerender", async () => {
    const first = vi.fn(async () => 'old')
    const second = vi.fn(async () => 'new')
    const view = renderHook(
      ({ fetchDeployed }) => useNewBuildAvailable({ ownBuildId: 'old', fetchDeployed, now: () => 1_000_000 }),
      { initialProps: { fetchDeployed: first } })
    view.rerender({ fetchDeployed: second })
    await fire(STALE_BUNDLE_EVENT)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(view.result.current.available).toBe(true)
  })

  // An update that was rolled back: the server is serving this tab's build again.
  it('withdraws the notice when this build is served again', async () => {
    let answer = 'new'
    const { view, advance } = setup(async () => answer)
    await becomeVisible()
    expect(view.result.current.available).toBe(true)
    answer = 'old'
    advance(MIN_CHECK_INTERVAL_MS)
    await becomeVisible()
    expect(view.result.current.available).toBe(false)
  })

  it('a dismissal holds for that build, and a later one shows again', async () => {
    let answer = 'new'
    const { view, advance } = setup(async () => answer)
    await becomeVisible()
    act(() => view.result.current.dismiss())
    expect(view.result.current.available).toBe(false)
    advance(MIN_CHECK_INTERVAL_MS)
    await becomeVisible()
    expect(view.result.current.available).toBe(false)
    answer = 'newer'
    advance(MIN_CHECK_INTERVAL_MS)
    await becomeVisible()
    expect(view.result.current.available).toBe(true)
  })
})
