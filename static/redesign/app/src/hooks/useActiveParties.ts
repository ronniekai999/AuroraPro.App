// The account's active watch parties (GET /api/parties/active), polled once
// for the whole app: the presence pill in the nav, the live strip on Tonight
// and the Together hub all read this one list.
//
// The server answers for the session's acting profile (the live-party listing
// judges each party's title against that profile's limit), so a list fetched
// for one profile must never be shown under another. Every answer is stored
// with the owner it was asked for, and is returned only while that owner is
// still the current one: on the commit that switches profile the hook
// returns nothing, without waiting for an effect to clear it.

import { useCallback, useEffect, useRef, useState } from 'react'
import { listActiveParties, type ActiveParty } from '@/lib/api'

export const ACTIVE_PARTIES_POLL_MS = 15_000

const NONE: ActiveParty[] = []

export interface UseActivePartiesOptions {
  /** Poll at all. False while signed out, before the session's profile is
   *  known, and for a session that is not offered Together. */
  enabled: boolean
  /** Who the list is for: the user and acting profile, as one string. A
   *  change drops the stored list at once and asks again. */
  ownerKey: string
}

export interface ActivePartiesState {
  /** Empty until the first answer for the current owner. */
  parties: ActiveParty[]
  /** True once an answer for the current owner has landed. */
  loaded: boolean
  /** Ask again now (after joining, leaving or starting a party). */
  reload: () => void
}

export function useActiveParties({ enabled, ownerKey }: UseActivePartiesOptions): ActivePartiesState {
  const [stored, setStored] = useState<{ owner: string; parties: ActiveParty[] } | null>(null)
  const [nonce, setNonce] = useState(0)
  // Only the latest request may land: a slow answer for an earlier tick must
  // not overwrite a newer one.
  const seq = useRef(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const ac = new AbortController()
    const load = () => {
      const mine = ++seq.current
      listActiveParties(ac.signal)
        .then(list => {
          if (cancelled || mine !== seq.current) return
          setStored({ owner: ownerKey, parties: list })
        })
        .catch(() => { /* non-fatal: keep what we have; the next tick asks again */ })
    }
    load()
    // A hidden tab does not poll; it asks once when it is shown again.
    const tick = () => { if (!document.hidden) load() }
    const id = window.setInterval(tick, ACTIVE_PARTIES_POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      cancelled = true
      ac.abort()
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [enabled, ownerKey, nonce])

  const reload = useCallback(() => setNonce(n => n + 1), [])
  const current = enabled && stored !== null && stored.owner === ownerKey
  return { parties: current ? stored.parties : NONE, loaded: current, reload }
}

/** A scheduled party that has not started: listed as active by design (that
 *  is how Upcoming finds it) but not "live now". */
export function isScheduledLobby(p: ActiveParty): boolean {
  return !!p.scheduled_start_at && !p.started_at
}

export interface PartyPresence {
  /** Parties running now that someone else hosts, most watched first. */
  live: ActiveParty[]
  /** Booked, not yet started. */
  scheduled: ActiveParty[]
  /** "3 watching Night Train", or null when nothing is live. */
  label: string | null
  /** The same without the title, for narrow bars: "3 watching". */
  short: string | null
}

/** What the nav's presence pill and Tonight's live strip say. A party the
 *  viewer hosts is left out: you are not offered your own party to join. */
export function partyPresence(parties: ActiveParty[], currentUserId: number | undefined): PartyPresence {
  const others = parties.filter(p => p.host_user_id !== currentUserId)
  const live = others.filter(p => !isScheduledLobby(p)).sort((a, b) => b.participant_count - a.participant_count)
  const scheduled = others.filter(isScheduledLobby)
  if (live.length === 0) return { live, scheduled, label: null, short: null }
  const top = live[0]
  const short = `${top.participant_count} watching`
  const what = top.media_title?.trim() || top.party_name?.trim()
  return { live, scheduled, label: what ? `${short} ${what}` : short, short }
}
