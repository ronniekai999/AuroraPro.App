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
