// @vitest-environment jsdom
//
// The invitation list belongs to the session it was asked for. It used to be
// bare state: the next person to sign in on the tab was shown the previous
// person's invitations until their own request landed, and a late answer to
// the previous person's request replaced theirs.

import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { usePartyInvites } from './usePartyInvites'

const invite = (id: number, title: string) => ({
  invite_id: id, party_code: `P${id}`, media_title: title, host_username: 'host', rsvp: 'pending' as const, created_at: '2026-10-01T00:00:00Z',
})

/** Each request for the list is held until `answer(n, titles)` is called. */
function stub() {
  const waiting: ((titles: string[]) => void)[] = []
  vi.stubGlobal('fetch', async () => {
    const titles = await new Promise<string[]>(done => { waiting.push(done) })
    return new Response(JSON.stringify({ invites: titles.map((t, i) => invite(i + 1, t)) }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return {
    get asked() { return waiting.length },
    answer: async (n: number, titles: string[]) => { await act(async () => { waiting[n](titles); await Promise.resolve(); await Promise.resolve() }) },
  }
}
const titles = (list: { media_title: string }[] | null) => list?.map(i => i.media_title) ?? null

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('usePartyInvites', () => {
  it('has nothing until an answer for the current owner lands', async () => {
    const server = stub()
    const { result } = renderHook(() => usePartyInvites('1:1'))
    expect(result.current.invites).toBeNull()
    expect(server.asked).toBe(0)
    act(() => result.current.refresh())
    expect(result.current.invites).toBeNull()
    await server.answer(0, ['For A'])
    expect(titles(result.current.invites)).toEqual(['For A'])
  })

  it('shows one owner\'s list to no other, on any render, and drops a late answer for the previous owner', async () => {
    const server = stub()
    const seen: (string[] | null)[] = []
    const { result, rerender } = renderHook(({ owner }: { owner: string | null }) => {
      const s = usePartyInvites(owner)
      seen.push(owner === '2:5' ? titles(s.invites) : null)
      return s
    }, { initialProps: { owner: '1:1' as string | null } })
    act(() => result.current.refresh())
    await server.answer(0, ['For A'])
    // A asks again; the answer is still out when A signs out.
    act(() => result.current.refresh())
    rerender({ owner: null })
    expect(result.current.invites).toBeNull()
    // B signs in on the same tab. The list is asked for again, for B.
    rerender({ owner: '2:5' })
    expect(result.current.invites).toBeNull()
    expect(server.asked).toBe(3)
    // A's answer arrives now.
    await server.answer(1, ['For A, late'])
    expect(result.current.invites).toBeNull()
    await server.answer(2, ['For B'])
    expect(titles(result.current.invites)).toEqual(['For B'])
    // No render under B ever held anything of A's.
    expect(seen.filter(s => s !== null && s.some(t => t.startsWith('For A')))).toEqual([])
  })

  it('treats the acting profile as part of the owner: a switch drops the list and asks again', async () => {
    const server = stub()
    const { result, rerender } = renderHook(({ owner }) => usePartyInvites(owner), { initialProps: { owner: '1:1' } })
    act(() => result.current.refresh())
    await server.answer(0, ['Under profile 1'])
    rerender({ owner: '1:2' })
    expect(result.current.invites).toBeNull()
    expect(server.asked).toBe(2)
    await server.answer(1, ['Under profile 2'])
    expect(titles(result.current.invites)).toEqual(['Under profile 2'])
  })

  // The Together page is keyed by the session, so it mounts on the commit
  // that changes owner and asks from its own effect, which runs before the
  // hook's. That request is for the new owner, and it is the only one.
  it('asks once, for the new owner, when a page that reads the list mounts on the commit that changes owner', async () => {
    const server = stub()
    function Page({ refresh }: { refresh: () => void }) {
      useEffect(() => { refresh() }, [refresh])
      return null
    }
    function App({ owner }: { owner: string }) {
      const s = usePartyInvites(owner)
      return <><output>{JSON.stringify(titles(s.invites))}</output><Page key={owner} refresh={s.refresh} /></>
    }
    const shown = () => JSON.parse(document.querySelector('output')!.textContent!) as string[] | null
    const { rerender } = render(<App owner="1:1" />)
    expect(server.asked).toBe(1)
    await server.answer(0, ['Under profile 1'])
    rerender(<App owner="1:2" />)
    expect(shown()).toBeNull()
    expect(server.asked).toBe(2)
    await server.answer(1, ['Under profile 2'])
    expect(shown()).toEqual(['Under profile 2'])
  })

  it('does not ask for a new owner when nothing has asked yet', () => {
    const server = stub()
    const { rerender } = renderHook(({ owner }) => usePartyInvites(owner), { initialProps: { owner: '1:1' } })
    rerender({ owner: '1:2' })
    expect(server.asked).toBe(0)
  })

  it('asks nothing, and has nothing, while nobody is signed in', () => {
    const server = stub()
    const { result } = renderHook(() => usePartyInvites(null))
    act(() => result.current.refresh())
    expect(server.asked).toBe(0)
    expect(result.current.invites).toBeNull()
  })

  it('lets only the latest request land', async () => {
    const server = stub()
    const { result } = renderHook(() => usePartyInvites('1:1'))
    act(() => result.current.refresh())
    act(() => result.current.refresh())
    await server.answer(1, ['Newer'])
    await server.answer(0, ['Older'])
    expect(titles(result.current.invites)).toEqual(['Newer'])
  })

  it('patches the current owner\'s list in place, and nobody else\'s', async () => {
    const server = stub()
    const { result, rerender } = renderHook(({ owner }) => usePartyInvites(owner), { initialProps: { owner: '1:1' } })
    act(() => result.current.refresh())
    await server.answer(0, ['Kestrel'])
    act(() => result.current.patch(list => list.map(i => ({ ...i, rsvp: 'going' as const }))))
    expect(result.current.invites?.[0].rsvp).toBe('going')
    rerender({ owner: '1:2' })
    act(() => result.current.patch(() => [invite(9, 'Injected')]))
    expect(result.current.invites).toBeNull()
  })
})

// A profile switch binds the new profile on the server before the app shows
// it. For that moment the owner is still the old profile and the server
// answers for the new one, so an answer stored then would be the new
// profile's list under the old profile's name.
describe('usePartyInvites across a profile switch', () => {
  /** A switch as the app sees it: out or not, how many have started, how
   *  many have ended. */
  function switches() {
    const state = { out: false, started: 0, ended: 0 }
    return {
      state,
      start() { state.out = true; state.started++ },
      end() { state.out = false; state.ended++ },
    }
  }
  const stable = { isSwitching: vi.fn<() => boolean>(), generation: vi.fn<() => number>() }
  function mount(sw: ReturnType<typeof switches>, owner = '1:2') {
    stable.isSwitching.mockImplementation(() => sw.state.out)
    stable.generation.mockImplementation(() => sw.state.started)
    return renderHook(({ owner, ended }: { owner: string; ended: number }) =>
      usePartyInvites(owner, { isSwitching: stable.isSwitching, generation: stable.generation, ended }),
    { initialProps: { owner, ended: sw.state.ended } })
  }

  it('starts no request while a switch is out, and makes it when the switch ends on the same profile', async () => {
    const server = stub(), sw = switches()
    const { result, rerender } = mount(sw)
    sw.start()
    act(() => result.current.refresh())
    act(() => result.current.refresh())
    expect(server.asked).toBe(0)
    // Refused, or its PIN prompt cancelled: the owner does not change.
    sw.end()
    rerender({ owner: '1:2', ended: sw.state.ended })
    expect(server.asked).toBe(1)
    await server.answer(0, ['For the Kid'])
    expect(titles(result.current.invites)).toEqual(['For the Kid'])
    // Asked once: a later render with nothing owed asks nothing.
    rerender({ owner: '1:2', ended: sw.state.ended })
    expect(server.asked).toBe(1)
  })

  it('makes the request for the new profile when the switch ends on it, once', async () => {
    const server = stub(), sw = switches()
    const { result, rerender } = mount(sw)
    sw.start()
    act(() => result.current.refresh())
    expect(server.asked).toBe(0)
    sw.end()
    rerender({ owner: '1:1', ended: sw.state.ended })
    expect(server.asked).toBe(1)
    await server.answer(0, ['For the Parent'])
    expect(titles(result.current.invites)).toEqual(['For the Parent'])
  })

  it('drops an answer that lands while a switch is out, and asks again when it ends', async () => {
    const server = stub(), sw = switches()
    const seen: (string[] | null)[] = []
    const { result, rerender } = renderHook(({ owner, ended }: { owner: string; ended: number }) => {
      const s = usePartyInvites(owner, { isSwitching: stable.isSwitching, generation: stable.generation, ended })
      if (owner === '1:2') seen.push(titles(s.invites))
      return s
    }, { initialProps: { owner: '1:2', ended: 0 } })
    stable.isSwitching.mockImplementation(() => sw.state.out)
    stable.generation.mockImplementation(() => sw.state.started)
    // Asked as the Kid, before any switch.
    act(() => result.current.refresh())
    expect(server.asked).toBe(1)
    // The switch binds the Parent on the server; the app still shows the Kid.
    sw.start()
    // The server answers the Kid's request for the Parent.
    await server.answer(0, ["The Parent's, over the Kid's limit"])
    expect(result.current.invites).toBeNull()
    expect(server.asked).toBe(1)
    // The switch is refused: still the Kid. The list is asked for again.
    sw.end()
    rerender({ owner: '1:2', ended: sw.state.ended })
    expect(server.asked).toBe(2)
    await server.answer(1, ['For the Kid'])
    expect(titles(result.current.invites)).toEqual(['For the Kid'])
    // No render under the Kid ever held the Parent's.
    expect(seen.filter(s => s?.some(t => t.startsWith("The Parent's")))).toEqual([])
  })

  it('drops an answer asked before a switch that has since ended on the same profile, and asks again at once', async () => {
    const server = stub(), sw = switches()
    const { result, rerender } = mount(sw)
    act(() => result.current.refresh())
    // A switch starts and ends (the binding was read back as this profile)
    // while the request is out: the server may have answered in between
    // for the profile it was bound to for that moment.
    sw.start()
    sw.end()
    rerender({ owner: '1:2', ended: sw.state.ended })
    // Nothing was owed yet (the request was simply out), so nothing more was asked.
    expect(server.asked).toBe(1)
    await server.answer(0, ['Answered in between'])
    expect(result.current.invites).toBeNull()
    // Asked again, without waiting for anything else to happen.
    expect(server.asked).toBe(2)
    await server.answer(1, ['For the Kid'])
    expect(titles(result.current.invites)).toEqual(['For the Kid'])
    expect(server.asked).toBe(2)
  })

  it('asks nothing again that nobody wanted', async () => {
    const server = stub(), sw = switches()
    const { rerender } = mount(sw)
    sw.start()
    sw.end()
    rerender({ owner: '1:2', ended: sw.state.ended })
    rerender({ owner: '1:1', ended: sw.state.ended })
    expect(server.asked).toBe(0)
  })

  it('keeps what it had on screen while a switch is out', async () => {
    const server = stub(), sw = switches()
    const { result } = mount(sw)
    act(() => result.current.refresh())
    await server.answer(0, ['For the Kid'])
    sw.start()
    act(() => result.current.refresh())
    expect(titles(result.current.invites)).toEqual(['For the Kid'])
  })
})
