// Tonight's "Happening now" strip: a party that is running and an invitation
// that has not been answered, above the first rail. Both used to sit after
// the last rail, under a statistics band, which is the wrong place for the
// one thing on the page with a clock on it.
//
// It draws nothing when there is nothing to show, and it is given nothing
// (parties undefined) for a session that is not offered Together, so a
// restricted profile never sees a party or an invitation here.
import { posterURL, type ActiveParty, type MyPartyInvite } from '@/lib/api'
import { plannedStartLabel } from '@/lib/partyInvites'
import { partyPresence } from '@/hooks/useActiveParties'

export interface TonightLiveProps {
  /** The account's active parties from App's one poll. */
  parties: ActiveParty[]
  /** The caller's open invitations, or null before they have loaded. */
  invites: MyPartyInvite[] | null
  currentUserId?: number
  /** The party this session is in, if any: its row opens it instead of joining. */
  inPartyCode?: string | null
  /** Join (or reopen) a party by code. */
  onJoin: (code: string) => void
  onRsvp: (inviteId: number, rsvp: 'going' | 'maybe') => void
  /** For the invitation's time ("Tonight · 8:00 PM"). */
  now?: Date
}

/** The rows the strip shows: parties someone else is running now, then
 *  invitations not yet answered, each party once. */
export function tonightLiveRows(parties: ActiveParty[], invites: MyPartyInvite[] | null, currentUserId?: number) {
  const live = partyPresence(parties, currentUserId).live
  const liveCodes = new Set(live.map(p => p.code))
  const pending = (invites ?? []).filter(i => i.rsvp === 'pending' && !liveCodes.has(i.party_code))
  return { live, pending }
}

export function TonightLive({ parties, invites, currentUserId, inPartyCode, onJoin, onRsvp, now }: TonightLiveProps) {
  const { live, pending } = tonightLiveRows(parties, invites, currentUserId)
  if (live.length === 0 && pending.length === 0) return null
  const at = now ?? new Date()
  return (
    <section aria-label="Happening now" data-tonight-live className="tonight-live">
      {live.map(p => {
        const what = p.media_title?.trim() || p.party_name?.trim() || 'a watch party'
        const mine = inPartyCode === p.code
        return (
          <div key={`party-${p.code}`} className="tonight-live-row" data-live-party={p.code}>
            <span className="tonight-live-count" aria-hidden="true">
              <span>{p.participant_count}</span>
            </span>
            <div className="tonight-live-text">
              <span className="tonight-live-title">{p.participant_count} watching {what}</span>
              <span className="tonight-live-sub">
                Live now{p.party_name?.trim() && p.party_name.trim() !== what ? ` · ${p.party_name.trim()}` : ''}
              </span>
            </div>
            <button
              type="button"
              // Drawn at 36px; a touch screen gets the 44px target.
              className="stage-btn stage-btn-sm stage-btn-primary tonight-live-act stage-hit44"
              onClick={() => onJoin(p.code)}
              aria-label={`${mine ? 'Open' : 'Join'} the party watching ${what}`}
            >
              {mine ? 'Open' : 'Join'}
            </button>
          </div>
        )
      })}
      {pending.map(i => {
        const started = !!i.started_at
        const when = started
          ? 'Live now'
          : i.scheduled_start_at ? plannedStartLabel(i.scheduled_start_at, at) : 'In the lobby'
        return (
          <div key={`invite-${i.invite_id}`} className="tonight-live-row" data-live-invite={i.invite_id}>
            {/* A party's poster is stored as the bare image path (App strips
                the proxy's prefix when it creates the party, and the server
                shares it that way), so it goes back through the image proxy
                here. Used as it is, it was a request for a page that is not a
                picture, and the box stayed empty. */}
            {i.media_poster
              ? <img src={posterURL(i.media_poster, 'w154')} alt="" className="tonight-live-poster" loading="lazy" decoding="async" />
              : <span className="tonight-live-poster" aria-hidden="true" />}
            <div className="tonight-live-text">
              <span className="tonight-live-title">{i.host_username} invited you to watch {i.media_title}</span>
              <span className="tonight-live-sub">{when}{i.party_name?.trim() ? ` · ${i.party_name.trim()}` : ''}</span>
            </div>
            <div className="tonight-live-acts">
              {([['going', "I'm in"], ['maybe', 'Maybe']] as const).map(([rsvp, label]) => (
                <button key={rsvp} type="button" className="stage-btn stage-btn-sm stage-btn-ghost tonight-live-rsvp stage-hit44" onClick={() => onRsvp(i.invite_id, rsvp)}>
                  {label}
                </button>
              ))}
              <button
                type="button"
                className="stage-btn stage-btn-sm stage-btn-quiet tonight-live-open stage-hit44"
                onClick={() => onJoin(i.party_code)}
                aria-label={`${started ? 'Join' : 'Open the lobby for'} ${i.media_title}`}
              >
                {started ? 'Join' : 'Open lobby'}
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
