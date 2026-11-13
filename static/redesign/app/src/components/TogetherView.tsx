// Together: the hub for watching with other people. What is on now and
// coming up, the invitations waiting for an answer, and the ways into a
// party that used to live in a dialog: a code, the party you were just in,
// your rooms.
//
// App polls the active parties once for the whole app (hooks/useActiveParties)
// and hands the same list to this view, to the nav's presence pill and to
// Tonight, so the three can never disagree. Everything here is
// for the session's acting profile: App passes empty lists on the render that
// switches profile, and until the first answer for the new profile lands,
// and remounts the view for each account and profile.

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import {
  createRoom, getFollowingRecent, listMembers, listRooms, posterURL,
  type ActiveParty, type FollowedWatch, type MemberSummary, type MyPartyInvite, type Room,
} from '@/lib/api'
import { clearLastParty, isLastPartyKey, readLastParty, type LastPartyEntry } from '@/lib/lastParty'
import { plannedStartLabel, plannedStartLine } from '@/lib/partyInvites'
import { isScheduledLobby, partyPresence } from '@/hooks/useActiveParties'
import { PageHeader } from '@/components/PageHeader'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import { failureWords } from '@/lib/failureWords'
import type { JoinResult } from '@/hooks/useParty'

export interface TogetherViewProps {
  currentUserId: number
  /** The profile the session acts as (null for an account with none). The
   *  party "you were just in" is remembered per profile. */
  profileId?: number | null
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
  onJoinParty: (code: string) => Promise<JoinResult>
  onRsvp: (inviteId: number, rsvp: 'going' | 'maybe' | 'declined') => void
  /** Ask for the invitations again (the view calls it on mount). */
  onRefreshInvites: () => void
  /** Open the member directory, and one member's page. */
  onOpenMembers: () => void
  onOpenMember: (username: string) => void
  /** Browse for something to start a party on. */
  onBrowse: () => void
  /** Open a title's page. */
  onOpenTitle?: (mediaId: number) => void
}

const partyName = (p: Pick<ActiveParty, 'party_name' | 'media_title'>) => p.party_name?.trim() || p.media_title?.trim() || 'Watch party'

/** "today", "yesterday", "3 days ago", "2 weeks ago", then a month. */
export function watchedAgo(iso: string, now: Date): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const days = Math.floor((now.getTime() - t) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 30) return `${Math.floor(days / 7)} ${days < 14 ? 'week' : 'weeks'} ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

const sectionTitle = 'font-display text-[22px] font-semibold leading-tight text-ink'
const asideTitle = 'text-xs font-semibold uppercase tracking-[0.08em] text-ink-2'
const row = 'flex min-h-[76px] flex-wrap items-center gap-x-4 gap-y-3 rounded-control bg-surface-raised px-4 py-3.5'
// Two lines at most, not one cut short: on a phone one line of
// "jonah invited you to watch…" ends before the title.
const rowTitle = 'line-clamp-2 text-[17px] font-semibold leading-snug text-ink'
const rowLine = 'mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink-2'
const refusal = 'text-[13px] leading-snug text-danger-ink'

/** A party's or an invitation's poster. What the server keeps for one is not
 *  an address but the image's path ("/abc.jpg", or "abc.jpg"), as it does for
 *  a title: posterURL makes the address the image proxy serves. */
function Poster({ path }: { path?: string }) {
  const src = posterURL(path, 'w154')
  return src
    ? <img src={src} alt="" loading="lazy" decoding="async" className="h-16 w-[43px] flex-none rounded-chip bg-surface-raised-2 object-cover" />
    : <span aria-hidden="true" data-no-poster="" className="h-16 w-[43px] flex-none rounded-chip bg-surface-raised-2" />
}

/** Where a join was started: a party's row in the lists, the code field, the
 *  party this browser was just in, or one of the viewer's rooms. A refusal
 *  is shown there, not somewhere the person is not looking. */
type JoinOrigin = 'list' | 'code' | 'recent' | `room:${number}`
type Join = (code: string, name: string, origin: JoinOrigin) => Promise<JoinResult>
interface JoinRefusal { code: string; name: string; message: string; origin: JoinOrigin }

/** Give `el` the focus when it has been lost: the control that had it is
 *  gone. Focus the person has since put somewhere else is left alone. */
function focusIfLost(el: HTMLElement | null | undefined) {
  const at = document.activeElement
  if (el && (!at || at === document.body || !at.isConnected)) el.focus()
}

export default function TogetherView({
  currentUserId, profileId = null, activeParties, partiesLoaded, partiesFailed, invites, inPartyCode,
  onOpenPartyPanel, onJoinParty, onRsvp, onRefreshInvites, onOpenMembers, onOpenMember, onBrowse, onOpenTitle,
}: TogetherViewProps) {
  const ids = useId()
  const codeFieldId = `${ids}-code`
  const rootRef = useRef<HTMLDivElement | null>(null)
  const topHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const openPartyRef = useRef<HTMLButtonElement | null>(null)

  // Other people's parties: the ones running, and the ones booked for later.
  const { live, scheduled } = partyPresence(activeParties, currentUserId)
  const hosting = activeParties.filter(p => p.host_user_id === currentUserId)
  const hostingLive = hosting.some(p => !isScheduledLobby(p))
  // Each party is on the page once. An invitation to a party that is running
  // is that party's row, with Join; one that waits for a reply is under
  // Invitations and not also under Coming up; and a party the viewer now
  // hosts (a guest who had not replied can inherit it) is only under "You
  // are hosting", not also asking them to reply to themselves.
  const liveCodes = new Set(live.map(p => p.code))
  const hostingCodes = new Set(hosting.map(p => p.code))
  const pending = (invites ?? []).filter(i => i.rsvp === 'pending' && !liveCodes.has(i.party_code) && !hostingCodes.has(i.party_code))
  const pendingCodes = new Set(pending.map(i => i.party_code))
  const comingUp = scheduled.filter(p => !pendingCodes.has(p.code))
  const inviteFor = (code: string) => (invites ?? []).find(i => i.party_code === code)
  const now = new Date()

  // The invitations are App's (the notification panel reads the same list),
  // and App only loads them when that panel opens or a party notification
  // arrives. This page shows them, so it asks for them when it opens, and
  // again when the parties themselves change (one starts, one ends): an
  // invitation to a party that has ended must not keep its reply buttons.
  // Not on every poll of the parties, only when the list is a different one.
  useEffect(() => { onRefreshInvites() }, [onRefreshInvites])
  const partyKey = activeParties.map(p => `${p.code}:${p.started_at ? 1 : 0}`).sort().join(',')
  const seenPartyKey = useRef<string | null>(null)
  useEffect(() => {
    if (!partiesLoaded) return
    if (seenPartyKey.current !== null && seenPartyKey.current !== partyKey) onRefreshInvites()
    seenPartyKey.current = partyKey
  }, [partiesLoaded, partyKey, onRefreshInvites])

  // What has just been done, for someone who cannot see the row move: a
  // reply taken, a party joined, a room made. Said in the page's one status
  // region, and cleared so that the same words can be said again.
  const [said, setSaid] = useState('')
  const saidTimer = useRef(0)
  const say = useCallback((text: string) => {
    setSaid(text)
    window.clearTimeout(saidTimer.current)
    saidTimer.current = window.setTimeout(() => setSaid(''), 6000)
  }, [])
  useEffect(() => () => window.clearTimeout(saidTimer.current), [])

  // A join that fails before the room is entered (a code that is no longer
  // good, a party that has ended, the room offline, a session that has ended)
  // used to say nothing: the button was pressed and nothing happened. Those
  // are the failures this result carries; a room that is full, or a title
  // over this profile's limit, is refused later, over the room's own
  // connection, and the party panel reports it. A refusal is shown where the
  // join was started. For a party's row that is above the lists, not in the
  // row: the next poll takes an ended party's row away, and the message must
  // outlive it. It names the party by what the row said, and goes when
  // another join is tried.
  const [joining, setJoining] = useState<string | null>(null)
  const [joinError, setJoinError] = useState<JoinRefusal | null>(null)
  const join: Join = async (code, name, origin) => {
    // The buttons stay focusable while a join is out (a disabled button
    // drops the focus it was pressed with), so a second press is refused
    // here.
    if (joining !== null) return { ok: false }
    setJoinError(null)
    setJoining(code)
    const r = await onJoinParty(code).catch((): JoinResult => ({ ok: false }))
    setJoining(null)
    if (r.ok) say(`Joined ${name}.`)
    else setJoinError({ code, name, message: r.error || 'Could not join the party. Try again.', origin })
    return r
  }
  const refusalFor = (origin: JoinOrigin) => (joinError?.origin === origin ? joinError.message : null)

  // A reply moves its invitation: to Coming up (in, or maybe) or off the
  // page (can't). The buttons that were pressed go with the row, so focus
  // follows the party to its new row, or goes to the next invitation, or to
  // the top heading when there is neither.
  const [answered, setAnswered] = useState<{ inviteId: number; code: string } | null>(null)
  const reply = (i: MyPartyInvite, rsvp: 'going' | 'maybe' | 'declined') => {
    onRsvp(i.invite_id, rsvp)
    setAnswered({ inviteId: i.invite_id, code: i.party_code })
    say(rsvp === 'going' ? `You’re in for ${i.media_title}.` : rsvp === 'maybe' ? `You said maybe for ${i.media_title}.` : `You said you can’t make ${i.media_title}.`)
  }
  const stillAsked = answered !== null && pending.some(i => i.invite_id === answered.inviteId)
  useEffect(() => {
    if (!answered || stillAsked) return
    const root = rootRef.current
    focusIfLost(
      root?.querySelector<HTMLElement>(`[data-party="${answered.code}"] button`)
      ?? root?.querySelector<HTMLElement>('[data-invite] button')
      ?? topHeadingRef.current,
    )
    setAnswered(null)
  }, [answered, stillAsked])

  // "You were just in" goes once its party is the one the viewer is in. The
  // header's "Open your party" takes the focus its Rejoin button had.
  const [rejoined, setRejoined] = useState(false)
  useEffect(() => {
    if (!rejoined || !inPartyCode) return
    focusIfLost(openPartyRef.current)
    setRejoined(false)
  }, [rejoined, inPartyCode])

  // One line says what the list is doing, in one polite status region that
  // stays mounted: loading, could not load, nobody is watching, or how many
  // are. A region added to the page together with its text is not announced.
  const partyStatus = partiesFailed ? 'Couldn’t load watch parties. Trying again…'
    : !partiesLoaded ? 'Looking for parties…'
      : live.length > 0 ? null
        // The viewer's own running party is listed below: "nobody" would be
        // wrong about the people in it.
        : hostingLive ? 'Nobody else is watching together right now.'
          : 'Nobody is watching together right now.'

  /** A party someone else hosts: its poster, its name, one line about it,
   *  and the way in. */
  const partyRow = (p: ActiveParty, line: string, label: string, primary: boolean) => {
    const mine = inPartyCode === p.code
    return (
      <li key={p.code} className={row} data-party={p.code}>
        <Poster path={p.media_poster} />
        <div className="min-w-0 flex-1 basis-[12rem]">
          <div className={rowTitle}>{partyName(p)}</div>
          <div className={rowLine}>{line}</div>
        </div>
        <button
          type="button"
          className={`stage-btn ${primary ? 'stage-btn-primary' : 'stage-btn-ghost'}`}
          aria-disabled={!mine && joining !== null}
          onClick={() => { if (mine) onOpenPartyPanel(); else void join(p.code, p.party_name?.trim() || p.media_title || 'the party', 'list') }}
        >
          {mine ? 'Open' : joining === p.code ? 'Joining…' : label}{' '}<span className="sr-only">{partyName(p)}</span>
        </button>
      </li>
    )
  }

  return (
    <div className="animate-fade-in" ref={rootRef}>
      <PageHeader
        title="Together"
        sub="Watch with the people on this server"
        action={(
          <div className="flex flex-wrap gap-3">
            {inPartyCode && (
              <button type="button" ref={openPartyRef} className="stage-btn stage-btn-primary" onClick={onOpenPartyPanel}>Open your party</button>
            )}
            {/* The label may take two lines: on the narrowest phones one
                line of it is wider than the page. */}
            <button
              type="button"
              className={`stage-btn stage-btn-wrap ${inPartyCode ? 'stage-btn-ghost' : 'stage-btn-primary'}`}
              onClick={onBrowse}
            >
              Pick something to watch together
            </button>
            {/* On a narrow screen the code field is a long way down the
                page, under the lists. This takes you to it. */}
            <button type="button" className="stage-btn stage-btn-ghost lg:hidden" onClick={() => document.getElementById(codeFieldId)?.focus()}>
              Enter a code
            </button>
          </div>
        )}
      />

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-12">
        <div className="min-w-0">
          <h2 ref={topHeadingRef} tabIndex={-1} className={`${sectionTitle} flex items-center gap-2.5`}>
            {/* Live presence, one of the three places the brand gradient is
                for: shown while something is live, since that is what it
                says. */}
            {(live.length > 0 || hostingLive) && <span aria-hidden="true" data-live-dot="" className="h-2 w-2 flex-none rounded-full [background:var(--aurora)]" />}
            Happening now
          </h2>
          <p className={partyStatus ? 'mt-3 text-sm text-ink-2' : 'sr-only'} role="status" data-party-status>
            {partyStatus ?? `${live.length} watch ${live.length === 1 ? 'party' : 'parties'} running now.`}
            <span className="sr-only" data-said="">{said ? ` ${said}` : ''}</span>
          </p>
          {joinError?.origin === 'list' && (
            <p className={`mt-3 ${refusal}`} role="alert" data-join-error={joinError.code}>
              Couldn&rsquo;t join {joinError.name}: {joinError.message}
            </p>
          )}
          {live.length > 0 && (
            <ul className="mt-3 grid gap-3">
              {live.map(p => {
                const invite = inviteFor(p.code)
                const watching = p.participant_count > 0
                  ? ` · ${p.participant_count} watching${p.media_title ? ` ${p.media_title}` : ''}`
                  // Nobody counted yet (its host is on the way back): the
                  // title, not "0 watching".
                  : p.media_title && p.party_name?.trim() ? ` · ${p.media_title}` : ''
                // Not for an invitation that was declined.
                const asked = invite && invite.rsvp !== 'declined' ? ` · ${invite.host_username} invited you` : ''
                return partyRow(p, `Live now${watching}${asked}`, 'Join', true)
              })}
            </ul>
          )}

          {pending.length > 0 && (
            <section aria-labelledby={`${ids}-invites`} className="mt-10">
              <h2 id={`${ids}-invites`} className={sectionTitle}>Invitations</h2>
              <ul className="mt-3 grid gap-3">
                {pending.map(i => (
                  <li key={i.invite_id} className={row} data-invite={i.invite_id}>
                    <Poster path={i.media_poster} />
                    <div className="min-w-0 flex-1 basis-[14rem]">
                      <div className="text-xs font-semibold text-ink-2">Reply needed</div>
                      <div className={rowTitle}>{i.host_username} invited you to watch {i.media_title}</div>
                      <div className={rowLine}>
                        {/* The invitation's own word on whether the party
                            has started: the party list may not have it yet. */}
                        {i.started_at ? 'Live now' : i.scheduled_start_at ? plannedStartLabel(i.scheduled_start_at, now) : 'In the lobby'}
                        {i.note?.trim() ? ` · “${i.note.trim()}”` : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2" role="group" aria-label={`Reply to ${i.host_username}’s invitation`}>
                      <button type="button" className="stage-btn stage-btn-primary" onClick={() => reply(i, 'going')}>I&rsquo;m in</button>
                      <button type="button" className="stage-btn stage-btn-ghost" onClick={() => reply(i, 'maybe')}>Maybe</button>
                      <button type="button" className="stage-btn stage-btn-ghost" onClick={() => reply(i, 'declined')}>Can&rsquo;t</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {comingUp.length > 0 && (
            <section aria-labelledby={`${ids}-coming`} className="mt-10">
              <h2 id={`${ids}-coming`} className={sectionTitle}>Coming up</h2>
              <ul className="mt-3 grid gap-3">
                {comingUp.map(p => {
                  const answer = inviteFor(p.code)?.rsvp
                  return partyRow(
                    p,
                    `${plannedStartLine(p.scheduled_start_at!, now)}${answer === 'going' ? ' · you’re in' : answer === 'maybe' ? ' · you said maybe' : ''}`,
                    'Open lobby',
                    false,
                  )
                })}
              </ul>
            </section>
          )}

          {hosting.length > 0 && (
            <section aria-labelledby={`${ids}-hosting`} className="mt-10">
              <h2 id={`${ids}-hosting`} className={sectionTitle}>You are hosting</h2>
              <ul className="mt-3 grid gap-3">
                {hosting.map(p => {
                  const booked = isScheduledLobby(p)
                  const mine = inPartyCode === p.code
                  return (
                    <li key={p.code} className={row} data-hosting={p.code}>
                      <Poster path={p.media_poster} />
                      <div className="min-w-0 flex-1 basis-[12rem]">
                        <div className={rowTitle}>{partyName(p)}</div>
                        <div className={rowLine}>
                          {booked
                            ? plannedStartLine(p.scheduled_start_at!, now)
                            : p.participant_count > 0 ? `Live now · ${p.participant_count} watching` : 'Live now'}
                          {' · code '}<span className="font-mono tabular-nums text-ink">{p.code}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="stage-btn stage-btn-ghost"
                        aria-disabled={!mine && joining !== null}
                        onClick={() => { if (mine) onOpenPartyPanel(); else void join(p.code, partyName(p), 'list') }}
                      >
                        {mine ? 'Open' : joining === p.code ? 'Opening…' : booked ? 'Open lobby' : 'Rejoin'}{' '}<span className="sr-only">{partyName(p)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          <FollowedFeed now={now} onOpenTitle={onOpenTitle} onOpenMembers={onOpenMembers} />
        </div>

        {/* grid-cols-1, not a bare grid: its one column may be narrower than
            a form's field wants to be, or a field and its button push a
            phone's page sideways. */}
        <aside className="mt-10 grid grid-cols-1 gap-8 lg:mt-0" aria-label="Ways into a party, and people">
          <JoinWithCode fieldId={codeFieldId} joining={joining} refused={refusalFor('code')} onJoin={join} />
          <RecentlyIn
            currentUserId={currentUserId}
            profileId={profileId}
            inPartyCode={inPartyCode}
            joining={joining}
            refused={refusalFor('recent')}
            onJoin={join}
            onRejoined={() => setRejoined(true)}
            // The party is gone and this section with it: the refusal moves
            // to where a row's would be.
            onGone={() => setJoinError(e => (e ? { ...e, origin: 'list' } : e))}
          />
          <Rooms joining={joining} refusedRoom={joinError?.origin.startsWith('room:') ? joinError : null} partyKey={partyKey} onJoin={join} onSay={say} />
          <People currentUserId={currentUserId} onOpenMembers={onOpenMembers} onOpenMember={onOpenMember} />
        </aside>
      </div>
    </div>
  )
}

// The six-character code a friend sends. A refusal is said under the field
// it is about.
function JoinWithCode({ fieldId, joining, refused, onJoin }: { fieldId: string; joining: string | null; refused: string | null; onJoin: Join }) {
  const id = fieldId
  const [code, setCode] = useState('')
  const fieldRef = useRef<HTMLInputElement | null>(null)
  const submitRef = useRef<HTMLButtonElement | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (code.length !== 6 || joining !== null) return
    void onJoin(code, `the party with code ${code}`, 'code').then(r => {
      if (r.ok) { setCode(''); return }
      // The code stays to be corrected, with the caret in it. But a join
      // can take seconds to be refused: someone who has moved on to another
      // control keeps their place.
      const at = document.activeElement
      if (!at || at === document.body || at === submitRef.current || at === fieldRef.current) fieldRef.current?.focus()
    })
  }
  return (
    <section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={asideTitle}>Join with a code</h2>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <label htmlFor={id} className="sr-only">Party code, six letters or digits</label>
        <input
          id={id}
          ref={fieldRef}
          value={code}
          maxLength={6}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="ABC123"
          aria-invalid={refused !== null}
          aria-describedby={refused !== null ? `${id}-refused` : undefined}
          // The server's codes are six of A to Z and 0 to 9.
          onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          className="h-12 min-w-0 flex-1 py-0 font-mono text-[17px] font-semibold tracking-[0.2em]"
        />
        {/* Named apart from the Join of a party in the list. Off through
            aria-disabled, never `disabled`: the press that joins also empties
            the field, and a disabled button would drop the focus. */}
        <button type="submit" ref={submitRef} aria-label="Join with this code" aria-disabled={code.length !== 6 || joining !== null} className="stage-btn stage-btn-ghost">
          {joining === code && code ? 'Joining…' : 'Join'}
        </button>
      </form>
      {refused !== null && <p id={`${id}-refused`} role="alert" className={`mt-2 ${refusal}`}>Couldn&rsquo;t join with that code: {refused}</p>}
      <p className="mt-2 text-[13px] leading-snug text-ink-2">
        Watching on a TV or a laptop? On your phone, the same code opens{' '}
        <a href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/join`} className="rounded-chip text-ink underline underline-offset-2">the companion</a>
        : the party’s chat, reactions and voice, without the video.
      </p>
    </section>
  )
}

// The party this browser was last in (kept for an hour, per user and
// profile): one press back after leaving by mistake or reloading the tab.
function RecentlyIn({ currentUserId, profileId, inPartyCode, joining, refused, onJoin, onRejoined, onGone }: {
  currentUserId: number
  profileId: number | null
  inPartyCode: string | null
  joining: string | null
  refused: string | null
  onJoin: Join
  onRejoined: () => void
  onGone: () => void
}) {
  const id = useId()
  const [last, setLast] = useState<LastPartyEntry | null>(() => readLastParty(currentUserId, profileId))
  // The record is written when a party is joined and when it is left, here
  // or in another tab: read it again when either happens, or leaving a party
  // from this page would not offer the way back into it.
  useEffect(() => {
    const read = () => setLast(readLastParty(currentUserId, profileId))
    read()
    const onStorage = (e: StorageEvent) => { if (isLastPartyKey(e.key)) read() }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [currentUserId, profileId, inPartyCode])
  if (!last || last.code === inPartyCode) return null
  const name = last.partyName || last.mediaTitle || 'Watch party'
  const rejoin = async () => {
    const r = await onJoin(last.code, name, 'recent')
    if (r.ok) { onRejoined(); return }
    // A party that is gone is not offered again: no party holds its code
    // now, the code names a room with no live party, or it is not a code.
    if (r.reason === 'http_404' || r.reason === 'offline_room' || r.reason === 'invalid_code') {
      clearLastParty(currentUserId, profileId)
      setLast(null)
      onGone()
    }
  }
  return (
    <section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={asideTitle}>You were just in</h2>
      <div className="mt-3 flex items-center gap-3 rounded-control bg-surface-raised px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-ink">{name}</div>
          <div className="font-mono text-xs tabular-nums text-ink-2">{last.code}</div>
        </div>
        <button type="button" aria-disabled={joining !== null} onClick={() => void rejoin()} className="stage-btn stage-btn-ghost">
          {joining === last.code ? 'Joining…' : 'Rejoin'}{' '}<span className="sr-only">{name}</span>
        </button>
      </div>
      {refused !== null && <p role="alert" className={`mt-2 ${refusal}`}>Couldn&rsquo;t rejoin: {refused}</p>}
      {last.wasHost && (
        <p className="mt-2 text-[13px] leading-snug text-ink-2">
          You were its host. Leaving handed it to whoever had been there longest, so you come back as a guest; if nobody stayed, it has ended.
        </p>
      )}
    </section>
  )
}

// Rooms: a code that stays the same from one party to the next.
function Rooms({ joining, refusedRoom, partyKey, onJoin, onSay }: {
  joining: string | null
  /** A refused join that was started from one of these rooms. */
  refusedRoom: JoinRefusal | null
  /** Changes when the parties running on the server do. */
  partyKey: string
  onJoin: Join
  onSay: (text: string) => void
}) {
  const id = useId()
  const listRef = useRef<HTMLUListElement | null>(null)
  // null while loading; the rest of the page does not wait for it.
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The room just made, whose row takes the focus the form had.
  const [made, setMade] = useState<number | null>(null)
  // The control inside a room's row that holds the focus, and its room. A
  // reload that finds the room's party has ended takes its Join button away,
  // and the row takes the focus then: when THAT control has gone from the
  // page while it held the focus, and at no other time. It is forgotten
  // when the person moves on (the row's blur handler). Kept as "the room
  // that last had the focus", it took the focus back, and on a phone the
  // page with it, at every later change of the party list, from anyone
  // whose focus was on nothing.
  const heldInRoom = useRef<{ room: number; el: HTMLElement } | null>(null)
  // A read of the rooms has answered. Until one has, a read that fails is
  // said, also beside a room made here meanwhile: that room alone is not the
  // person's rooms.
  const answered = useRef(false)

  // Read when the page opens, and again when the parties running change: a
  // room says whether a party is on in it ("live now" / "nothing on"), and
  // that was only as true as the moment the page opened. A reload that fails
  // keeps the rooms already shown.
  useEffect(() => {
    const ac = new AbortController()
    listRooms(ac.signal)
      .then(list => { answered.current = true; setRooms(list); setFailed(false) })
      .catch((err: unknown) => {
        if (ac.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return
        // A reload that fails keeps the rooms a read brought. With none
        // read yet there are none to keep but the ones made here, and those
        // stay.
        if (!answered.current) { setFailed(true); setRooms(prev => prev ?? []) }
      })
    return () => ac.abort()
  }, [partyKey])

  useEffect(() => {
    const held = heldInRoom.current
    if (!held || held.el.isConnected) return
    heldInRoom.current = null
    focusIfLost(listRef.current?.querySelector<HTMLElement>(`[data-room="${held.room}"]`))
  }, [rooms])

  useEffect(() => {
    if (made === null) return
    const made_row = listRef.current?.querySelector<HTMLElement>(`[data-room="${made}"]`)
    if (!made_row) return
    made_row.focus()
    setMade(null)
  }, [made, rooms])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const next = name.trim()
    if (!next || busy) return
    setBusy(true)
    setError(null)
    try {
      const room = await createRoom({ name: next })
      setRooms(prev => (prev ? [room, ...prev.filter(r => r.id !== room.id)] : [room]))
      setName('')
      setCreating(false)
      setMade(room.id)
      onSay(`Room made: ${room.name}.`)
    } catch (err) {
      // The form sends a name that is not empty, so the route's 400 is its
      // length, which it counts in bytes: an accent or an emoji is more than
      // one, and the field's own limit counts characters.
      setError(failureWords(err, 'make the room', { status: { 400: 'That name is too long for a room. Shorten it: accents and emoji count for more than one letter.' } }) ?? 'The room could not be made.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className={asideTitle}>Your rooms</h2>
        <button type="button" aria-expanded={creating} onClick={() => { setCreating(c => !c); setError(null) }} className="stage-btn stage-btn-quiet -mr-3">
          {creating ? 'Cancel' : 'New room'}
        </button>
      </div>
      {creating && (
        <form onSubmit={create} className="mt-2">
          <label htmlFor={`${id}-name`} className="sr-only">Room name</label>
          <div className="flex gap-2">
            <input
              id={`${id}-name`}
              value={name}
              maxLength={200}
              placeholder="Friday crew"
              // Read-only, not disabled, while the room is made: a disabled
              // field drops the focus.
              readOnly={busy}
              aria-invalid={error !== null}
              aria-describedby={error !== null ? `${id}-error` : undefined}
              onChange={e => setName(e.target.value)}
              className="h-11 min-w-0 flex-1 py-0"
            />
            <button type="submit" aria-disabled={!name.trim() || busy} className="stage-btn stage-btn-ghost">{busy ? 'Making…' : 'Make room'}</button>
          </div>
          <p className="mt-2 text-[13px] leading-snug text-ink-2">
            A room keeps one code from party to party. Start a party from a title’s page and your friends come back with the same code every time.
          </p>
          <p id={`${id}-error`} role="alert" className={error ? `mt-2 ${refusal}` : 'sr-only'}>{error ?? ''}</p>
        </form>
      )}
      {rooms === null && <p className="mt-2 text-[13px] text-ink-2">Loading…</p>}
      {failed && <p className="mt-2 text-[13px] text-danger-ink">Your rooms could not be loaded.</p>}
      {rooms !== null && rooms.length === 0 && !failed && !creating && (
        <p className="mt-2 text-[13px] leading-snug text-ink-2">No rooms yet. A room gives your group one code that never changes.</p>
      )}
      {rooms !== null && rooms.length > 0 && (
        <ul ref={listRef} className="mt-2 grid gap-2">
          {rooms.map(r => {
            const refused = refusedRoom?.origin === `room:${r.id}` ? refusedRoom.message : null
            return (
              // Focusable from code only: a room just made takes the focus
              // its form had, and a room with nothing on has no button.
              <li
                key={r.id}
                data-room={r.id}
                tabIndex={-1}
                // A control in the row, not the row itself: the row is never
                // taken away under the person, its Join button is.
                onFocus={e => { if (e.target !== e.currentTarget) heldInRoom.current = { room: r.id, el: e.target as HTMLElement } }}
                // The person moved on. A control taken away must not count:
                // Chromium fires a blur for a removal too, while the control
                // is still in the page. React does not hand that one to this
                // handler today (measured in Chromium), but nothing here
                // leans on that: the two are told apart a moment later, when
                // a control that was removed is no longer connected and its
                // record stays for the effect above. Nor does a window that
                // lost the focus count: the control gets a blur then too,
                // and is still the page's focused element when the person
                // comes back.
                onBlur={e => {
                  const el = e.target as HTMLElement
                  queueMicrotask(() => {
                    if (heldInRoom.current?.el === el && el.isConnected && document.activeElement !== el) heldInRoom.current = null
                  })
                }}
                className="rounded-control bg-surface-raised px-4 py-2.5"
              >
                <div className="flex min-h-[40px] items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold text-ink">{r.name}</div>
                    <div className="text-xs text-ink-2">
                      <span className="font-mono tabular-nums">{r.code}</span>
                      {r.active_party_code ? ' · live now' : ' · nothing on'}
                    </div>
                  </div>
                  {r.active_party_code && (
                    <button
                      type="button"
                      aria-disabled={joining !== null}
                      onClick={() => { void onJoin(r.active_party_code!, r.name, `room:${r.id}`) }}
                      className="stage-btn stage-btn-ghost"
                    >
                      {joining === r.active_party_code ? 'Joining…' : 'Join'}{' '}<span className="sr-only">{r.name}</span>
                    </button>
                  )}
                </div>
                {refused !== null && <p role="alert" className={`mt-1.5 ${refusal}`}>Couldn&rsquo;t join: {refused}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// A few of the people on this server, the ones followed first, and the way
// to all of them. Its own request; when it fails the button is still there.
function People({ currentUserId, onOpenMembers, onOpenMember }: {
  currentUserId: number
  onOpenMembers: () => void
  onOpenMember: (username: string) => void
}) {
  const id = useId()
  const [members, setMembers] = useState<MemberSummary[] | null>(null)
  useEffect(() => {
    const ac = new AbortController()
    listMembers(ac.signal)
      .then(setMembers)
      .catch(() => { if (!ac.signal.aborted) setMembers([]) })
    return () => ac.abort()
  }, [])
  const others = (members ?? []).filter(m => m.user_id !== currentUserId)
  const shown = [...others.filter(m => m.is_following), ...others.filter(m => !m.is_following)].slice(0, PEOPLE_SHOWN)
  return (
    <section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={asideTitle}>People on this server</h2>
      {shown.length > 0 && (
        <ul className="mt-2 grid gap-1">
          {shown.map(m => {
            const name = m.display_name || m.username
            return (
              <li key={m.user_id} data-member={m.username}>
                <button
                  type="button"
                  onClick={() => onOpenMember(m.username)}
                  className="-mx-2 flex min-h-12 w-[calc(100%+1rem)] items-center gap-3 rounded-control px-2 text-left hover:bg-surface-raised"
                >
                  <ProfileAvatar avatarUrl={m.avatar_url} name={name} memberKey={m.user_id} size={36} />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{name}</span>
                  {/* The space is for the button's name: "Bo Following",
                      not "BoFollowing". */}
                  {m.is_following && <>{' '}<span className="flex-none text-xs text-ink-2">Following</span></>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 text-[13px] leading-snug text-ink-2">Follow someone to see what they finish, and invite them when you plan a party.</p>
      <button type="button" className="stage-btn stage-btn-ghost mt-3" onClick={onOpenMembers}>
        {others.length > shown.length ? `All ${others.length} members` : 'Members'}
      </button>
    </section>
  )
}
const PEOPLE_SHOWN = 5

// What the people this profile follows finished lately. Its own request:
// nothing else on the page waits for it, and a failure shows nothing.
function FollowedFeed({ now, onOpenTitle, onOpenMembers }: {
  now: Date
  onOpenTitle?: (mediaId: number) => void
  onOpenMembers: () => void
}) {
  const id = useId()
  // null while loading, and when the request failed: "nothing yet" would be
  // a claim about the people followed that a failed request cannot make.
  const [feed, setFeed] = useState<FollowedWatch[] | null>(null)
  useEffect(() => {
    const ac = new AbortController()
    getFollowingRecent(undefined, ac.signal)
      .then(rows => setFeed(rows ?? []))
      .catch(() => { /* stays null */ })
    return () => ac.abort()
  }, [])
  if (feed === null) return null
  return (
    <section aria-labelledby={`${id}-title`} className="mt-10">
      <h2 id={`${id}-title`} className={sectionTitle}>What people you follow finished</h2>
      {feed.length === 0 ? (
        <>
          <p className="mt-3 max-w-[56ch] text-sm leading-snug text-ink-2">
            Nothing yet. Follow someone who shares what they finish and it shows here.
          </p>
          <button type="button" onClick={onOpenMembers} className="stage-btn stage-btn-ghost mt-3">Find people</button>
        </>
      ) : (
        // A list on a narrow screen (a grid of posters there pushed the rest
        // of the page three screens down), posters side by side from sm.
        <ul className="mt-3 grid gap-2 sm:gap-x-4 sm:gap-y-5 sm:[grid-template-columns:repeat(auto-fill,minmax(132px,1fr))]">
          {feed.slice(0, 12).map(w => {
            const ago = watchedAgo(w.watched_at, now)
            const poster = posterURL(w.poster_path)
            const art = 'h-16 w-[43px] flex-none rounded-chip bg-surface-raised-2 object-cover sm:aspect-[2/3] sm:h-auto sm:w-full sm:rounded-art sm:bg-surface-raised'
            const body = (
              <>
                {poster
                  ? <img src={poster} alt="" loading="lazy" decoding="async" className={art} />
                  : <span aria-hidden="true" className={`block ${art}`} />}
                <span className="block min-w-0 sm:mt-2">
                  <span className="block truncate text-sm font-semibold text-ink">{w.title}</span>
                  <span className="block truncate text-xs text-ink-2">{w.watched_by}{ago ? ` · ${ago}` : ''}</span>
                </span>
              </>
            )
            const frame = 'flex w-full items-center gap-3 rounded-control bg-surface-raised p-2.5 text-left sm:block sm:rounded-art sm:bg-transparent sm:p-0'
            return (
              <li key={`${w.id}:${w.watched_by_username}:${w.watched_at}`} className="min-w-0">
                {onOpenTitle
                  ? <button type="button" onClick={() => onOpenTitle(w.id)} className={frame}>{body}</button>
                  : <div className={frame}>{body}</div>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
