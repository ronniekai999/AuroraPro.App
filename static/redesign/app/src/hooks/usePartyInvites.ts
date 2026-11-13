// The caller's open watch-party invitations, kept with the session they were
// asked for.
//
// The list used to be bare state in App: nothing said whose it was, and
// nothing cleared it. It only decorated the bell's rows then, and those are
// cleared on sign-out. Once the Together page and Tonight's live strip read
// it directly, the next person to sign in on the same tab (no reload) was
// shown the previous person's invitations, titles and hosts, until their own
// request landed, and an answer to the previous person's request that
// arrived late replaced theirs.
//
// So the list is stored with its owner (the user and the acting profile, as
// one key: the server judges an invitation's title against the acting
// profile's limit), given out only while that owner is the current one, and
// an answer for an owner that is no longer current is dropped. A change of
// owner drops the stored list and, if the list was wanted before, asks again.
//
// One window that left open: a profile switch binds the new profile on the
// server before the app shows it. For that moment the app still names the
// old profile, the owner key is still the old one, and the server answers
// for the new one, so an answer could be stored under the old profile and
// drawn under its name: a profile with a limit shown the note on an
// invitation the server hides from it. So, as the live catalog refresh does
// (`switch`, from lib/useProfileSwitch through App):
//   - no request starts while a switch or its PIN prompt is out;
//   - an answer is dropped when one is out, or has started since it was
//     asked for;
//   - what was held back or dropped is asked for again when a switch ends,
//     including one that ends on the profile already shown (a refused
//     activation, a cancelled prompt), where no change of owner would ask.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listMyPartyInvites, type MyPartyInvite } from '@/lib/api'

export interface PartyInvitesState {
  /** The current owner's invitations; null before an answer for them, and
   *  while nobody is signed in. */
  invites: MyPartyInvite[] | null
  /** Ask (again) for the current owner. Nothing when nobody is signed in. */
  refresh: () => void
  /** Change the current owner's list in place (an optimistic RSVP). */
  patch: (change: (list: MyPartyInvite[]) => MyPartyInvite[]) => void
}

/** What the hook needs to know of profile switches. */
export interface SwitchWatch {
  /** A switch, or the PIN prompt of one, is out. */
  isSwitching: () => boolean
  /** How many switches have started. */
  generation: () => number
  /** How many have ended, however they ended. */
  ended: number
}

/** `ownerKey`: who the list is for, or null when nobody is signed in.
 *  `switches`: the session's profile switches, when it can make any. */
export function usePartyInvites(ownerKey: string | null, switches?: SwitchWatch): PartyInvitesState {
  const [stored, setStored] = useState<{ owner: string; list: MyPartyInvite[] } | null>(null)
  const ownerRef = useRef(ownerKey)
  const isSwitching = switches?.isSwitching
  const generation = switches?.generation
  // A request was held back, or its answer dropped, because of a switch: it
  // is owed once the switch has ended.
  const owed = useRef(false)
  // Requests are numbered: only the latest one's answer lands.
  const seq = useRef(0)
  // Whether anything has asked yet: a new owner is asked for only then.
  const wanted = useRef(false)

  // Whose list the latest request is for.
  const askedFor = useRef<string | null>(null)

  const ask = useCallback(function ask(owner: string) {
    // The server may already act as another profile than the one `owner`
    // names: its answer would be that profile's.
    if (isSwitching?.()) { owed.current = true; return }
    const mine = ++seq.current
    const startedAt = generation?.() ?? 0
    askedFor.current = owner
    owed.current = false
    listMyPartyInvites()
      .then(list => {
        // An answer for someone who is no longer the session, or an older
        // one than the latest asked for, is not shown to whoever is here now.
        if (mine !== seq.current || ownerRef.current !== owner) return
        // Nor one a switch may have changed the meaning of: out now, or
        // started since this was asked.
        const out = !!isSwitching?.()
        if (out || (generation?.() ?? 0) !== startedAt) {
          askedFor.current = null
          owed.current = true
          // That switch has already ended, on this same owner: ask again
          // now. One still out is waited for (the effect on `ended`).
          if (!out) ask(owner)
          return
        }
        setStored({ owner, list })
      })
      .catch(() => { /* non-fatal: rows that read the list degrade to plain lines */ })
  }, [isSwitching, generation])

  // The owner is known to refresh() before any passive effect runs: a page
  // that mounts on the commit that changes owner asks from its own effect,
  // which runs before this hook's, and would otherwise ask for the owner
  // who has just left.
  useLayoutEffect(() => { ownerRef.current = ownerKey }, [ownerKey])
  useEffect(() => {
    // The previous owner's list is dropped, not merely hidden.
    setStored(prev => (prev && prev.owner === ownerKey ? prev : null))
    // Whatever was owed was owed to the previous owner.
    owed.current = false
    // A request already out for the new owner (that page's) is the one; any
    // other answer still out is orphaned by a new number, and the new owner
    // is asked for if the list was wanted before.
    if (askedFor.current === ownerKey) return
    seq.current++
    askedFor.current = null
    if (ownerKey !== null && wanted.current) ask(ownerKey)
  }, [ownerKey, ask])

  // A switch has ended. If it changed the owner, the effect above has asked
  // (and nothing is owed); if it did not, this is what asks.
  const ended = switches?.ended ?? 0
  useEffect(() => {
    if (!owed.current) return
    const owner = ownerRef.current
    if (owner === null || !wanted.current) return
    ask(owner)
  }, [ended, ask])

  const refresh = useCallback(() => {
    const owner = ownerRef.current
    if (owner === null) return
    wanted.current = true
    ask(owner)
  }, [ask])

  const patch = useCallback((change: (list: MyPartyInvite[]) => MyPartyInvite[]) => {
    setStored(prev => (prev && prev.owner === ownerRef.current ? { owner: prev.owner, list: change(prev.list) } : prev))
  }, [])

  return { invites: stored && stored.owner === ownerKey ? stored.list : null, refresh, patch }
}
