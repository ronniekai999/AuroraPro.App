// @vitest-environment jsdom
//
// The record of the latest restore, read by ticket where this browser kept
// one and through the admin route otherwise (hooks/useRestoreRecord.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { RESTORE_POLL_MS, resetRestoreRecordForTest, useRestoreRecord } from './useRestoreRecord'
import type { RestoreStatus } from '@/lib/restoreStatus'

const TICKET = 'k'.repeat(43)
const keep = (seen: string | null) => localStorage.setItem('aurora.restore', JSON.stringify({ ticket: TICKET, file: 'b.dump', seen }))
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
const rec = (over: Partial<RestoreStatus>): RestoreStatus => ({ state: 'running', step: 'restoring', database: 'empty', file: 'b.dump', started_at: '2026-11-13T15:00:00Z', restart_required: false, ...over })
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(RESTORE_POLL_MS) })

let answers: Array<Response | Error>
const ticketReads = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u) === '/api/restore/status').length

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  resetRestoreRecordForTest()
  answers = []
  vi.stubGlobal('fetch', vi.fn(() => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.clone())
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('with a ticket kept', () => {
  it('reads again while the restore runs, and stops once it has ended', async () => {
    keep(null)
    answers = [json(200, rec({})), json(200, rec({ state: 'succeeded', step: undefined, database: 'restored', restart_required: true }))]
    const { result } = renderHook(() => useRestoreRecord({}))
    await settle()
    expect(result.current.status?.state).toBe('running')
    expect(JSON.parse(localStorage.getItem('aurora.restore')!).seen).toBe('running')
    await tick()
    expect(result.current.status?.state).toBe('succeeded')
    const reads = ticketReads()
    await tick()
    await tick()
    expect(ticketReads()).toBe(reads)
  })

  it('keeps asking while Aurora does not answer, and says it is waiting', async () => {
    keep(null)
    answers = [new TypeError('Failed to fetch'), new TypeError('Failed to fetch'), json(200, rec({}))]
    const { result } = renderHook(() => useRestoreRecord({}))
    await settle()
    expect(result.current.waiting?.file).toBe('b.dump')
    expect(result.current.unreachable).toBe(true)
    await tick()
    await tick()
    expect(result.current.status?.state).toBe('running')
    expect(result.current.waiting).toBeNull()
    expect(result.current.unreachable).toBe(false)
  })

  it('says a restore last seen running that the server no longer knows', async () => {
    keep('running')
    answers = [json(404, { error: { reason: 'restore_unknown' } })]
    const { result } = renderHook(() => useRestoreRecord({}))
    await settle()
    expect(result.current.lost?.file).toBe('b.dump')
    result.current.dismiss()
    await settle()
    expect(localStorage.getItem('aurora.restore')).toBeNull()
    expect(result.current.lost).toBeNull()
  })

  it('forgets, silently, one whose end it saw, and reads the admin route instead', async () => {
    keep('succeeded')
    answers = [json(404, { error: { reason: 'restore_unknown' } })]
    const adminRead = vi.fn(async () => rec({ state: 'none', step: undefined, database: undefined, file: undefined, started_at: undefined }))
    const { result } = renderHook(() => useRestoreRecord({ adminRead }))
    await settle()
    await settle()
    expect(localStorage.getItem('aurora.restore')).toBeNull()
    expect(result.current.lost).toBeNull()
    expect(adminRead).toHaveBeenCalledTimes(1)
  })

  it('puts an ended restore away for this tab when dismissed', async () => {
    keep('succeeded')
    const ended = rec({ state: 'succeeded', step: undefined, database: 'restored', restart_required: true })
    answers = [json(200, ended)]
    const adminRead = vi.fn(async () => ended)
    const { result } = renderHook(() => useRestoreRecord({ adminRead }))
    await settle()
    expect(result.current.status?.state).toBe('succeeded')
    act(() => result.current.dismiss())
    await settle()
    // The admin route still has it, and it is not shown again.
    expect(adminRead).toHaveBeenCalled()
    expect(result.current.status).toBeNull()
    expect(localStorage.getItem('aurora.restore')).toBeNull()
  })
})

describe('across tabs and lost tickets', () => {
  it('forgets on Dismiss only the ticket its record was read with, not one another tab kept since', async () => {
    keep('succeeded')
    answers = [json(200, rec({ state: 'succeeded', step: undefined, database: 'restored', restart_required: true }))]
    const { result } = renderHook(() => useRestoreRecord({}))
    await settle()
    expect(result.current.status?.state).toBe('succeeded')
    // Another tab starts a restore and keeps its ticket.
    localStorage.setItem('aurora.restore', JSON.stringify({ ticket: 'n'.repeat(43), file: 'new.dump', seen: null }))
    act(() => result.current.dismiss())
    await settle()
    expect(JSON.parse(localStorage.getItem('aurora.restore')!).ticket).toBe('n'.repeat(43))
  })

  it('reads the admin route after a lost ticket, and says a restore running now before the lost one', async () => {
    keep('running')
    answers = [json(404, { error: { reason: 'restore_unknown' } })]
    const adminRead = vi.fn(async () => rec({ file: 'now.dump' }))
    const { result } = renderHook(() => useRestoreRecord({ adminRead }))
    await settle()
    await settle()
    expect(result.current.lost?.file).toBe('b.dump')
    expect(result.current.status?.state).toBe('running')
    expect(adminRead).toHaveBeenCalledTimes(1)
    // It goes on asking the admin route while that restore runs.
    await tick()
    expect(adminRead).toHaveBeenCalledTimes(2)
    expect(ticketReads()).toBe(1)
  })

  it('does not keep asking a refused admin read after a lost ticket', async () => {
    keep('running')
    answers = [json(404, { error: { reason: 'restore_unknown' } })]
    const adminRead = vi.fn<(s: AbortSignal) => Promise<RestoreStatus>>().mockRejectedValue(new Error('401'))
    renderHook(() => useRestoreRecord({ adminRead }))
    await settle()
    await tick()
    await tick()
    expect(adminRead).toHaveBeenCalledTimes(1)
    expect(ticketReads()).toBe(1)
  })
})

describe('without a ticket', () => {
  it('reads nothing where there is no admin read', async () => {
    renderHook(() => useRestoreRecord({}))
    await settle()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads the admin route, and does not ask again after a refusal unless a restore was running', async () => {
    const adminRead = vi.fn<(s: AbortSignal) => Promise<RestoreStatus>>().mockRejectedValue(new Error('401'))
    const { result } = renderHook(() => useRestoreRecord({ adminRead }))
    await settle()
    await tick()
    await tick()
    expect(adminRead).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBeNull()

    adminRead.mockReset().mockResolvedValueOnce(rec({})).mockRejectedValue(new Error('500'))
    const again = renderHook(() => useRestoreRecord({ adminRead }))
    await settle()
    expect(again.result.current.status?.state).toBe('running')
    await tick()
    await tick()
    expect(adminRead).toHaveBeenCalledTimes(3)
    expect(again.result.current.unreachable).toBe(true)
  })

  it('reads again when told a restore in this tab ended', async () => {
    const adminRead = vi.fn(async () => rec({ state: 'none' }))
    const { rerender } = renderHook(({ n }) => useRestoreRecord({ adminRead, recheck: n }), { initialProps: { n: 0 } })
    await settle()
    rerender({ n: 1 })
    await settle()
    expect(adminRead).toHaveBeenCalledTimes(2)
  })
})
