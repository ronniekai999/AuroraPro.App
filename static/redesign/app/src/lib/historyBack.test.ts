import { describe, expect, it } from 'vitest'
import { hasInAppEntryBehind } from './historyBack'

describe('whether Back stays inside the app', () => {
  it('does not on the entry the tab loaded the app on', () => {
    expect(hasInAppEntryBehind('default', { idx: 0 })).toBe(false)
    expect(hasInAppEntryBehind('default', null)).toBe(false)
    // Whatever index the state claims: nothing was pushed to get here.
    expect(hasInAppEntryBehind('default', { idx: 3 })).toBe(false)
  })

  it('does not on the first entry after the app replaced it, though it has a key of its own by then', () => {
    expect(hasInAppEntryBehind('k3j2h1', { usr: null, key: 'k3j2h1', idx: 0 })).toBe(false)
  })

  it('does on an entry the app pushed', () => {
    expect(hasInAppEntryBehind('k3j2h1', { usr: null, key: 'k3j2h1', idx: 1 })).toBe(true)
    expect(hasInAppEntryBehind('k3j2h1', { idx: 12 })).toBe(true)
  })

  it('goes by the key alone where the history state carries no index', () => {
    expect(hasInAppEntryBehind('k3j2h1', null)).toBe(true)
    expect(hasInAppEntryBehind('k3j2h1', undefined)).toBe(true)
    expect(hasInAppEntryBehind('k3j2h1', {})).toBe(true)
    expect(hasInAppEntryBehind('k3j2h1', 'not an object')).toBe(true)
  })
})
