// Together: the hub for watching with other people. Placeholder contents;
// the props are the seam with App, which owns the data.
//
// App polls the active parties once for the whole app (hooks/useActiveParties)
// and hands the same list to this view, to the nav's presence pill and to
// Tonight, so the three can never disagree. Everything here is
// for the session's acting profile: App passes empty lists on the render that
// switches profile, and until the first answer for the new profile lands.

import { useEffect } from 'react'
import type { ActiveParty, MyPartyInvite } from '@/lib/api'
import { formatPartyTime } from '@/lib/partyInvites'
import { isScheduledLobby } from '@/hooks/useActiveParties'
import { PageHeader } from '@/components/PageHeader'

export interface TogetherViewProps {
  currentUserId: number
  /** Live and scheduled parties (GET /api/parties/active). */
  activeParties: ActiveParty[]
  /** False until the first answer for the acting profile has landed. */
  partiesLoaded: boolean
  /** Nothing has loaded and the last request failed (it is retried). */
  partiesFailed: boolean
  /** The viewer's open invitations; null until first loaded. */
  invites: MyPartyInvite[] | null
  /** The code of the party the viewer is in, or null. */
  inPartyCode: string | null
  /** Open the party the viewer is in (its side panel). */
  onOpenPartyPanel: () => void
  /** Join a party by code; resolves with the outcome, never rejects. */
  onJoinParty: (code: string) => Promise<{ ok: boolean; error?: string }>
  /** Open the "enter a code" prompt. */
  onJoinByCode: () => void
  onRsvp: (inviteId: number, rsvp: 'going' | 'maybe' | 'declined') => void
  /** Ask for the invitations again (the view calls it on mount). */
  onRefreshInvites: () => void
  /** Open the member directory, and one member's page. */
  onOpenMembers: () => void
  onOpenMember: (username: string) => void
  /** Browse for something to start a party on. */
  onBrowse: () => void
}

export default function TogetherView({
  currentUserId, activeParties, partiesLoaded, partiesFailed, invites, inPartyCode,
  onOpenPartyPanel, onJoinParty, onJoinByCode, onRsvp, onRefreshInvites, onOpenMembers, onBrowse,
}: TogetherViewProps) {
  // The invitations are App's (the notification panel reads the same list),
  // and App only loads them when that panel opens or a party notification
  // arrives. This page shows them, so it asks for them when it opens.
  useEffect(() => { onRefreshInvites() }, [onRefreshInvites])
  const others = activeParties.filter(p => p.host_user_id !== currentUserId)
  const pending = (invites ?? []).filter(i => i.rsvp === 'pending')
  return (
    <div className="animate-fade-in">
      <PageHeader title="Together" sub="Watch with the people on this server" />
      <div className="flex flex-wrap gap-3">
        {inPartyCode && (
          <button type="button" className="stage-btn stage-btn-primary" onClick={onOpenPartyPanel}>Open your party</button>
        )}
        <button type="button" className="stage-btn stage-btn-ghost" onClick={onJoinByCode}>Join with a code</button>
        <button type="button" className="stage-btn stage-btn-ghost" onClick={onBrowse}>Pick something to watch together</button>
        <button type="button" className="stage-btn stage-btn-quiet" onClick={onOpenMembers}>Members</button>
      </div>

      <h2 className="mt-10 font-display text-[22px] font-semibold text-ink">Happening now</h2>
      {partiesFailed ? (
        <p className="mt-3 text-sm text-ink-2" role="status">Couldn&rsquo;t load watch parties. Trying again…</p>
      ) : !partiesLoaded ? (
        <p className="mt-3 text-sm text-ink-2">Looking for parties…</p>
      ) : others.length === 0 ? (
        <p className="mt-3 text-sm text-ink-2">Nobody is watching together right now.</p>
      ) : (
        <ul className="mt-3 grid gap-3">
          {others.map(p => (
            <li key={p.code} className="flex min-h-[76px] items-center gap-4 rounded-control bg-surface-raised px-4 py-3.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-ink">{p.party_name?.trim() || p.media_title || 'Watch party'}</div>
                <div className="truncate text-[13px] text-ink-2">
                  {isScheduledLobby(p)
                    ? `Starts ${formatPartyTime(p.scheduled_start_at!, new Date())}`
                    : `Live now · ${p.participant_count} watching${p.media_title ? ` ${p.media_title}` : ''}`}
                </div>
              </div>
              <button type="button" className="stage-btn stage-btn-sm stage-btn-primary" onClick={() => { void onJoinParty(p.code) }}>
                {isScheduledLobby(p) ? 'Open lobby' : 'Join'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <>
          <h2 className="mt-10 font-display text-[22px] font-semibold text-ink">Invitations</h2>
          <ul className="mt-3 grid gap-3">
            {pending.map(i => (
              <li key={i.invite_id} className="flex min-h-[76px] flex-wrap items-center gap-4 rounded-control bg-surface-raised px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-ink">{i.host_username} invited you to watch {i.media_title}</div>
                  {i.scheduled_start_at && <div className="text-[13px] text-ink-2">{formatPartyTime(i.scheduled_start_at, new Date())}</div>}
                </div>
                <div className="flex gap-2">
                  <button type="button" className="stage-btn stage-btn-sm stage-btn-ghost" onClick={() => onRsvp(i.invite_id, 'going')}>I&rsquo;m in</button>
                  <button type="button" className="stage-btn stage-btn-sm stage-btn-ghost" onClick={() => onRsvp(i.invite_id, 'maybe')}>Maybe</button>
                  <button type="button" className="stage-btn stage-btn-sm stage-btn-quiet" onClick={() => onRsvp(i.invite_id, 'declined')}>Can&rsquo;t</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
