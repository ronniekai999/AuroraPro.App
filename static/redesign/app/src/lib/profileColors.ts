// Which colour each of an account's profiles is drawn in, when it has no
// chosen avatar. The requirement is that no two profiles on ONE account share
// a colour (telling a child's profile from a parent's is the point), and a
// profile's id alone cannot give that: ids are one serial across every
// account on the server, so an account's profiles 1 and 10 would both land
// on the same one of nine colours.
//
// So the colour is chosen within the account's list. Whoever holds that list
// publishes it here (the profile picker, which is mounted whenever someone is
// signed in), and every avatar reads its colour from it, so the picker, the
// PIN prompt, the identity menu and the tab bar agree without each being
// handed the list.

import { useSyncExternalStore } from 'react'
import { PERSON_COLORS } from './personColor'

/** A palette slot for each profile id. Stable, not positional: walking the
 *  ids in order, each takes `id % 9` unless an earlier profile already holds
 *  it, and then the next free slot. So a profile that collided with nobody
 *  keeps its colour whatever is added or removed around it. With more than
 *  nine profiles the tenth onwards must repeat a colour. */
export function assignProfileSlots(ids: readonly number[]): Map<number, number> {
  const n = PERSON_COLORS.length
  const slots = new Map<number, number>()
  let taken = new Set<number>()
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    if (taken.size === n) taken = new Set()
    let slot = ((Math.trunc(id) % n) + n) % n
    while (taken.has(slot)) slot = (slot + 1) % n
    taken.add(slot)
    slots.set(id, slot)
  }
  return slots
}

let slots = new Map<number, number>()
let published = ''
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const snapshot = () => slots

/** Publish the signed-in account's profile ids. A no-op for the same set. */
export function setAccountProfileIds(ids: readonly number[]): void {
  const key = [...new Set(ids)].sort((a, b) => a - b).join(',')
  if (key === published) return
  published = key
  slots = assignProfileSlots(ids)
  listeners.forEach(fn => fn())
}

/** The colour key to draw a profile's avatar with: its slot in the account's
 *  set, or the id itself for a profile the published set does not hold (the
 *  set is not known yet, or the avatar is of some other account's profile). */
export function useProfileColorKey(profileId: number | undefined): number | undefined {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot)
  if (profileId === undefined) return undefined
  return current.get(profileId) ?? profileId
}
