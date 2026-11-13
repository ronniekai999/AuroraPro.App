// @vitest-environment jsdom
//
// A restore's ticket and the words for the server's record of it
// (lib/restoreStatus.ts).

import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetRestore, lostRestoreWords, newRestoreTicket, noteRestoreSeen, putBackRestore,
  rememberRestore, rememberedRestore, restoreWords, type RestoreStatus,
} from './restoreStatus'

afterEach(() => localStorage.clear())

describe('the ticket', () => {
  it('is 32 random bytes in the alphabet the server takes', () => {
    const a = newRestoreTicket()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newRestoreTicket()).not.toBe(a)
  })

  it('is kept until forgotten, and only its own forget drops it', () => {
    rememberRestore('a'.repeat(43), 'one.dump')
    expect(rememberedRestore()).toEqual({ ticket: 'a'.repeat(43), file: 'one.dump', seen: null, at: expect.any(Number) })
    noteRestoreSeen('a'.repeat(43), 'running')
    noteRestoreSeen('b'.repeat(43), 'failed')
    expect(rememberedRestore()?.seen).toBe('running')
    forgetRestore('b'.repeat(43))
    expect(rememberedRestore()?.ticket).toBe('a'.repeat(43))
    forgetRestore('a'.repeat(43))
    expect(rememberedRestore()).toBeNull()
  })

  it('puts back the one kept before a restore that never started', () => {
    rememberRestore('a'.repeat(43), 'running.dump')
    const previous = rememberedRestore()
    rememberRestore('b'.repeat(43), 'refused.dump')
    putBackRestore('b'.repeat(43), previous)
    expect(rememberedRestore()).toEqual(previous)
    // Not when another tab has kept a newer one since.
    rememberRestore('c'.repeat(43), 'newer.dump')
    putBackRestore('b'.repeat(43), previous)
    expect(rememberedRestore()?.ticket).toBe('c'.repeat(43))
  })

  it('reads nothing kept from a malformed value', () => {
    localStorage.setItem('aurora.restore', '{not json')
    expect(rememberedRestore()).toBeNull()
    localStorage.setItem('aurora.restore', JSON.stringify({ ticket: 1 }))
    expect(rememberedRestore()).toBeNull()
  })
})

describe('the words for a record', () => {
  const base: RestoreStatus = { state: 'none', restart_required: false, file: 'b.dump', started_at: '2026-11-13T15:00:00Z' }
  const words = (over: Partial<RestoreStatus>) => restoreWords({ ...base, ...over })

  it('says nothing without a restore', () => {
    expect(words({})).toBeNull()
  })

  it('says a running restore is safe to leave, and when it has the database', () => {
    expect(words({ state: 'running', step: 'checking', database: 'unchanged' })).toMatchObject({ title: 'A restore is running', urgent: false })
    const replacing = words({ state: 'running', step: 'restoring', database: 'empty' })!
    expect(replacing.urgent).toBe(true)
    expect(replacing.says).toContain('Do not restart Aurora meanwhile')
  })

  it('says each way a restore ends, in the page’s words only', () => {
    expect(words({ state: 'succeeded', database: 'restored', restart_required: true })!.title).toBe('Restart Aurora now')
    const unchanged = words({ state: 'failed', step: 'checking', database: 'unchanged', message: 'bad archive' })!
    expect(unchanged).toEqual({ title: 'The restore from b.dump did not go through', says: 'The database was not changed.', urgent: false })
    expect(words({ state: 'failed', step: 'restoring', database: 'empty' })!.says).toContain('the database is now empty')
    expect(words({ state: 'failed', step: 'restoring', database: 'unknown' })!.title).toBe('The restore from b.dump was stopped part way')
  })

  it('still says to restart after an earlier restore when a later one is refused', () => {
    expect(words({ state: 'failed', step: 'checking', database: 'unchanged', restart_required: true })!.says)
      .toBe('The database was not changed. Aurora still has to be restarted after an earlier restore.')
  })

  it('says a ticket the server no longer knows by whether it was seen running', () => {
    expect(lostRestoreWords('b.dump', true).says).toMatch(/^Aurora has restarted since that restore began/)
    expect(lostRestoreWords('b.dump', false).says).toMatch(/^If its upload did not finish, it never started/)
  })
})
