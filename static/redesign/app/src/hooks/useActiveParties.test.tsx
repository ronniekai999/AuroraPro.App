// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ActiveParty } from '@/lib/api'

const listActiveParties = vi.fn<(signal?: AbortSignal) => Promise<ActiveParty[]>>()
vi.mock('@/lib/api', () => ({ listActiveParties: (s?: AbortSignal) => listActiveParties(s) }))

const { ACTIVE_PARTIES_POLL_MS, isScheduledLobby, partyPresence, useActiveParties } = await import('./useActiveParties')

const party = (over: Partial<ActiveParty> = {}): ActiveParty => ({
  code: 'ABC123', host_user_id: 7, party_name: '', media_title: 'Night Train', media_poster: '',
  participant_count: 3, max_participants: 0, is_playing: true, started_at: '2026-11-11T20:00:00Z', ...over,
})

/** A request the test resolves by hand. */
function deferred() {
  let resolve!: (v: ActiveParty[]) => void
  const promise = new Promise<ActiveParty[]>(r => { resolve = r })
  return { promise, resolve }
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  vi.useFakeTimers()
  listActiveParties.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useActiveParties', () => {
  it('asks nothing while disabled and returns an empty list', () => {
    const { result } = renderHook(() => useActiveParties({ enabled: false, ownerKey: '1:1' }))
    expect(listActiveParties).not.toHaveBeenCalled()
    expect(result.current.parties).toEqual([])
    expect(result.current.loaded).toBe(false)
  })

  it('loads at once, then every poll interval', async () => {
    listActiveParties.mockResolvedValue([party()])
    const { result } = renderHook(() => useActiveParties({ enabled: true, ownerKey: '1:1' }))
    await flush()
    expect(result.current.parties.map(p => p.code)).toEqual(['ABC123'])
    expect(result.current.loaded).toBe(true)
    expect(listActiveParties).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(ACTIVE_PARTIES_POLL_MS) })
    expect(listActiveParties).toHaveBeenCalledTimes(2)
  })

  it('shows nothing on the very render that changes owner, before any effect runs', async () => {
    // The profile switch: the previous profile's parties are in state, and the
    // commit that names the new profile must not show them.
    listActiveParties.mockResolvedValueOnce([party({ media_title: 'Parent Only' })])
    const next = deferred()
    listActiveParties.mockReturnValueOnce(next.promise)
    const seen: string[][] = []
    const { result, rerender } = renderHook(
      ({ owner }) => {
        const s = useActiveParties({ enabled: true, ownerKey: owner })
        seen.push(s.parties.map(p => `${owner}:${p.media_title}`))
        return s
      },
      { initialProps: { owner: '1:parent' } },
    )
    await flush()
    expect(result.current.parties).toHaveLength(1)
    rerender({ owner: '1:kid' })
    // No commit ever paired the kid with the parent's party.
    expect(seen.flat().filter(s => s.startsWith('1:kid:'))).toEqual([])
    expect(result.current.parties).toEqual([])
    expect(result.current.loaded).toBe(false)
    await act(async () => { next.resolve([party({ media_title: 'Kid Show' })]) })
    expect(result.current.parties.map(p => p.media_title)).toEqual(['Kid Show'])
  })

  it('drops an answer that arrives for a previous owner', async () => {
    const first = deferred()
    const second = deferred()
    listActiveParties.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(({ owner }) => useActiveParties({ enabled: true, ownerKey: owner }), {
      initialProps: { owner: '1:parent' },
    })
    rerender({ owner: '1:kid' })
    await act(async () => { second.resolve([party({ media_title: 'Kid Show' })]) })
    await act(async () => { first.resolve([party({ media_title: 'Parent Only' })]) })
    expect(result.current.parties.map(p => p.media_title)).toEqual(['Kid Show'])
  })

  it('does not poll while the tab is hidden, and asks when it is shown again', async () => {
    listActiveParties.mockResolvedValue([])
    renderHook(() => useActiveParties({ enabled: true, ownerKey: '1:1' }))
    await flush()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await act(async () => { vi.advanceTimersByTime(ACTIVE_PARTIES_POLL_MS * 3) })
    expect(listActiveParties).toHaveBeenCalledTimes(1)
    hidden.mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(listActiveParties).toHaveBeenCalledTimes(2)
    hidden.mockRestore()
  })

  it('keeps the last list when a poll fails', async () => {
    listActiveParties.mockResolvedValueOnce([party()]).mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useActiveParties({ enabled: true, ownerKey: '1:1' }))
    await flush()
    await act(async () => { vi.advanceTimersByTime(ACTIVE_PARTIES_POLL_MS) })
    await flush()
    expect(result.current.parties).toHaveLength(1)
  })

  it('reload asks again without waiting for the interval', async () => {
    listActiveParties.mockResolvedValue([])
    const { result } = renderHook(() => useActiveParties({ enabled: true, ownerKey: '1:1' }))
    await flush()
    act(() => result.current.reload())
    await flush()
    expect(listActiveParties).toHaveBeenCalledTimes(2)
  })

  it('stops when disabled or unmounted', async () => {
    listActiveParties.mockResolvedValue([party()])
    const { result, rerender, unmount } = renderHook(({ on }) => useActiveParties({ enabled: on, ownerKey: '1:1' }), {
      initialProps: { on: true },
    })
    await flush()
    rerender({ on: false })
    expect(result.current.parties).toEqual([])
    await act(async () => { vi.advanceTimersByTime(ACTIVE_PARTIES_POLL_MS * 2) })
    expect(listActiveParties).toHaveBeenCalledTimes(1)
    unmount()
  })
})

describe('partyPresence', () => {
  it('says nothing when no party is live', () => {
    expect(partyPresence([], 1).label).toBeNull()
    const lobby = party({ scheduled_start_at: '2026-11-12T20:00:00Z', started_at: null })
    expect(isScheduledLobby(lobby)).toBe(true)
    const p = partyPresence([lobby], 1)
    expect(p.label).toBeNull()
    expect(p.scheduled).toHaveLength(1)
    expect(p.live).toHaveLength(0)
  })

  it('names the most watched live party and how many are watching', () => {
    const p = partyPresence([party({ code: 'A', participant_count: 2, media_title: 'Kestrel' }), party({ code: 'B', participant_count: 3 })], 1)
    expect(p.label).toBe('3 watching Night Train')
    expect(p.short).toBe('3 watching')
    expect(p.live.map(x => x.code)).toEqual(['B', 'A'])
  })

  it('falls back to the party name, then to the count alone', () => {
    expect(partyPresence([party({ media_title: '', party_name: 'Friday crew' })], 1).label).toBe('3 watching Friday crew')
    expect(partyPresence([party({ media_title: '', party_name: ' ' })], 1).label).toBe('3 watching')
  })

  it('leaves out a party the viewer hosts', () => {
    expect(partyPresence([party({ host_user_id: 1 })], 1).label).toBeNull()
  })
})
