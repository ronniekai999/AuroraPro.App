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

/** `ownerKey`: who the list is for, or null when nobody is signed in. */
export function usePartyInvites(ownerKey: string | null): PartyInvitesState {
  const [stored, setStored] = useState<{ owner: string; list: MyPartyInvite[] } | null>(null)
  const ownerRef = useRef(ownerKey)
  // Requests are numbered: only the latest one's answer lands.
  const seq = useRef(0)
  // Whether anything has asked yet: a new owner is asked for only then.
  const wanted = useRef(false)

  // Whose list the latest request is for.
  const askedFor = useRef<string | null>(null)

  const ask = useCallback((owner: string) => {
    const mine = ++seq.current
    askedFor.current = owner
    listMyPartyInvites()
      .then(list => {
        // An answer for someone who is no longer the session, or an older
        // one than the latest asked for, is not shown to whoever is here now.
        if (mine !== seq.current || ownerRef.current !== owner) return
        setStored({ owner, list })
      })
      .catch(() => { /* non-fatal: rows that read the list degrade to plain lines */ })
  }, [])

  // The owner is known to refresh() before any passive effect runs: a page
  // that mounts on the commit that changes owner asks from its own effect,
  // which runs before this hook's, and would otherwise ask for the owner
  // who has just left.
  useLayoutEffect(() => { ownerRef.current = ownerKey }, [ownerKey])
  useEffect(() => {
    // The previous owner's list is dropped, not merely hidden.
    setStored(prev => (prev && prev.owner === ownerKey ? prev : null))
    // A request already out for the new owner (that page's) is the one; any
    // other answer still out is orphaned by a new number, and the new owner
    // is asked for if the list was wanted before.
    if (askedFor.current === ownerKey) return
    seq.current++
    askedFor.current = null
    if (ownerKey !== null && wanted.current) ask(ownerKey)
  }, [ownerKey, ask])

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
