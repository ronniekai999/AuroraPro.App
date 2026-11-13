import { describe, expect, it } from 'vitest'
import { assignProfileSlots } from './profileColors'
import { PERSON_COLORS } from './personColor'

describe('assignProfileSlots', () => {
  // Profile ids are one serial across every account, so one account's
  // profiles are not consecutive: 1 and 10 are both 1 modulo nine.
  it('gives two profiles of one account different colours when their ids alone would collide', () => {
    const slots = assignProfileSlots([1, 10])
    expect(slots.get(1)).not.toBe(slots.get(10))
    expect(slots.get(1)).toBe(1)
  })

  it('never repeats a colour while there are colours left', () => {
    const ids = [3, 12, 21, 30, 39, 48, 57, 66, 75]
    expect(new Set(assignProfileSlots(ids).values()).size).toBe(PERSON_COLORS.length)
  })

  // Stable, not positional: taking an unrelated profile away must not move
  // anyone's colour.
  it('keeps a profile\u2019s colour when an unrelated profile is removed or added', () => {
    const before = assignProfileSlots([4, 7, 15, 22])
    const after = assignProfileSlots([4, 15, 22])
    for (const id of [4, 15, 22]) expect(after.get(id), `profile ${id}`).toBe(before.get(id))
    const grown = assignProfileSlots([4, 7, 15, 22, 100])
    for (const id of [4, 7, 15, 22]) expect(grown.get(id), `profile ${id}`).toBe(before.get(id))
  })

  // The documented limit of that stability: a profile that was pushed off
  // its own slot goes back to it when the profile that pushed it is deleted.
  it('can recolour a profile that had been displaced, when the one that displaced it goes', () => {
    const before = assignProfileSlots([1, 10, 11])
    expect([before.get(1), before.get(10), before.get(11)]).toEqual([1, 2, 3])
    const after = assignProfileSlots([1, 11])
    expect([after.get(1), after.get(11)]).toEqual([1, 2])
  })

  it('does not depend on the order the ids are given in', () => {
    expect([...assignProfileSlots([10, 1, 19])]).toEqual([...assignProfileSlots([1, 10, 19])])
  })

  it('has to repeat from the tenth profile on, and still gives each one a colour', () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1)
    const slots = assignProfileSlots(ids)
    expect(slots.size).toBe(12)
    expect(new Set([...slots.values()].slice(0, 9)).size).toBe(9)
    for (const slot of slots.values()) expect(slot).toBeGreaterThanOrEqual(0)
  })
})
