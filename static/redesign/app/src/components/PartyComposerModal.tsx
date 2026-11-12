// Aurora V2 — PartyComposerModal (watch-party invites)
//
// The "Plan a Watch Party" modal from the watch-party invite contract:
// one modal, one decision at the top — When. "Right now" starts the party
// the moment you send; "Schedule" books it for a quick-chip time or a
// custom date/time. Below that, both modes share the same people picker
// (type-to-search — see below), an optional note, and a CTA whose label
// tracks the mode + selection.
//
// The people picker is search-first: it lists nobody until the host has
// typed MIN_MEMBER_QUERY_CHARS, then shows the ranked matches. The standing
// list it replaced was a wall of every account on the server, which is the
// wrong shape for "invite Sam" and gets worse with every member added.
// Because results come and go as the query changes, the people already
// picked live in their own chip row that does NOT depend on the query —
// otherwise clearing the box would hide who you'd invited.
//
// The modal is presentation + selection state only. The actual
// create → invite → join sequence lives in App.tsx's launchPartyComposer
// (passed as onLaunch) so this component needs no access to the party hook
// — it reports what the user chose and shows busy/error feedback.

import { useEffect, useMemo, useRef, useState } from 'react'
import { listMembers, type MemberSummary } from '@/lib/api'
import {
  MEMBER_DIRECTORY_LIMIT,
  MIN_MEMBER_QUERY_CHARS,
  buildQuickChips,
  formatPartyTime,
  matchMembersWithTotal,
  memberQueryReady,
} from '@/lib/partyInvites'
import { PartyShareCardModal } from './PartyShareCardModal'
import { ProfileAvatar } from './ProfileAvatar'

export interface PartyComposerLaunch {
  // null ⇒ "right now"; otherwise an RFC 3339 instant in the future.
  scheduledStartAt: string | null
  usernames: string[]
  note: string
}

export interface PartyComposerModalProps {
  mediaTitle: string
  // 'movie' | 'show' — copy only ("party starts with the next-up episode").
  mediaType?: string
  currentUsername?: string
  onClose: () => void
  // Performs create (+ invites + join). Resolve { ok: true } to close;
  // { ok: false, error } keeps the modal open with the error inline.
  //
  // `code` comes back on success so a SCHEDULED booking can hand straight
  // off to the share card — the moment the host has just decided when
  // everyone is watching is the moment they want the poster.
  onLaunch: (launch: PartyComposerLaunch) => Promise<{ ok: boolean; error?: string; code?: string }>
}

export function PartyComposerModal({
  mediaTitle,
  mediaType,
  currentUsername,
  onClose,
  onLaunch,
}: PartyComposerModalProps) {
  const [mode, setMode] = useState<'now' | 'schedule'>('now')

  // Quick chips are computed once per open — they're anchored to "tonight"
  // and a modal doesn't stay open across midnight in practice.
  const chips = useMemo(() => buildQuickChips(new Date()), [])
  const [selectedIso, setSelectedIso] = useState<string | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [customValue, setCustomValue] = useState('') // datetime-local string

  // People picker. The full roster is still fetched once on open — it's one
  // small call, it's what makes the first keystroke search instantly, and the
  // selected chips need each member's display name and avatar after the query
  // that found them is gone. It is never RENDERED as a list; matchMembers
  // decides what the host actually sees. Anyone on the server is invitable
  // (invite-only household; the server enforces rating ceilings per invitee).
  const [members, setMembers] = useState<MemberSummary[] | null>(null)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  // Declared up here with the rest of the picker state because pick() below
  // returns focus to it after a selection.
  const searchRef = useRef<HTMLInputElement | null>(null)

  // Bumped by the error state's Try again button. Without it a failed roster
  // fetch is a dead end — the effect's only other trigger is currentUsername,
  // which never changes while the modal is mounted, so the host's only
  // recovery is to close the composer and start over.
  const [rosterAttempt, setRosterAttempt] = useState(0)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Set once a SCHEDULED party is booked: the composer hands off to the
  // share card instead of just closing. "Right now" parties skip this —
  // the host is about to be in the room, not posting about it.
  const [booked, setBooked] = useState<{ code: string; iso: string; invited: number } | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    // Clear any previous failure before re-fetching. The results tree is an
    // exclusive ternary with membersError first, so a stale error from an
    // earlier attempt would render a dead picker: the roster loads, matches
    // exist, and the user sees only the old warning with no rows.
    setMembersError(null)
    listMembers(ac.signal)
      .then(list => {
        // Only self-filtering here. Ordering is matchMembers' job now (it
        // ranks by how well each row matches what was typed, with followed
        // people winning ties), so pre-sorting the roster would be a second,
        // silently-ignored opinion about order.
        const mine = (currentUsername ?? '').toLowerCase()
        setMembers(list.filter(m => m.username.toLowerCase() !== mine))
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        setMembersError(err instanceof Error ? err.message : 'Failed to load members')
        setMembers([])
      })
    return () => ac.abort()
  }, [currentUsername, rosterAttempt])

  // Ranked matches for the current query. Note this is NOT gated on
  // `searching`: matchMembers still surfaces someone whose whole name the
  // query has already spelled out ("jd"), because there is no third letter
  // to ask them for. `searching` only decides which EMPTY state to show.
  const searching = memberQueryReady(search)
  // One pass per keystroke, not two: `total` is the count BEFORE the render
  // cap (announcing the rendered count once the cap bites is a false
  // statement, and the scrolling box hides the difference), and taking both
  // from one call means they cannot disagree.
  const { matches, total: totalMatches } = useMemo(
    () => (members ? matchMembersWithTotal(members, search) : { matches: [], total: 0 }),
    [members, search])
  const hiddenMatches = Math.max(0, totalMatches - matches.length)
  // The roster endpoint is capped server-side. At the cap we cannot tell
  // "this member does not exist" from "this member is past the cap", so the
  // no-match copy stops asserting the former.
  //
  // -1 because the server's LIMIT counts the VIEWER (ListMembers has no
  // `WHERE u.id != $1`) and we filter ourselves out above. Comparing against
  // the raw limit made this dead code for every host whose username sorts
  // inside the first 500 — i.e. almost all of them.
  const rosterTruncated = members !== null && members.length >= MEMBER_DIRECTORY_LIMIT - 1
  // A server with nobody else on it is its own answer — "no members match"
  // would blame the query for an empty roster.
  const rosterEmpty = members !== null && members.length === 0

  // The chip row: everyone picked so far, in the order they were picked, and
  // independent of the query. Selection is stored as usernames (that's the
  // launch payload), so the roster is what turns them back into a face and a
  // name. A member who vanished from the roster mid-modal still gets a chip
  // rendered from the username alone rather than silently dropping out of a
  // send the host thinks they set up.
  const selectedMembers = useMemo(() => {
    const byName = new Map((members ?? []).map(m => [m.username, m]))
    return [...selected].map(username =>
      byName.get(username) ?? { user_id: -1, username, is_following: false } as MemberSummary)
  }, [members, selected])

  // Announced when someone is added or removed. Sighted users see the chip
  // row change; a screen-reader user gets nothing otherwise — the result row
  // whose aria-pressed would have flipped is unmounted in the same commit
  // (the query clears), and neither the chip row nor the "N invited" counter
  // is a live region. Without this, a blind host activates Sammy, the list
  // vanishes, nothing is announced, and the natural recovery is to press
  // Enter again on a row that no longer exists.
  const [pickAnnouncement, setPickAnnouncement] = useState('')

  const toggle = (username: string, shownName?: string) => {
    // Same split as pick(): the SELECTION is a functional update (must never
    // lose a write), the ANNOUNCEMENT is derived from a closure read (worst
    // case in a batched update: the wrong verb is spoken). The updater stays
    // pure — setState inside another setState's updater is a side effect
    // React is free to run twice.
    const wasSelected = selected.has(username)
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
    // Qualified with the handle for the same reason the chip label is: two
    // guests can share a display name, and a live region does NOT re-announce
    // byte-identical consecutive text — so adding the second "JD" would be
    // met with the silence this announcement exists to prevent.
    const name = shownName && shownName !== username ? `${shownName} (${username})` : username
    setPickAnnouncement(wasSelected
      ? `${name} removed from the invite list`
      : `${name} added to the invite list`)
  }

  // Picking from the results clears the query and hands focus back to the
  // box, so inviting four people is type-tap-type-tap rather than
  // type-tap-select-all-delete-type. Deselecting from the results leaves the
  // query alone — the row you just unticked should stay where it is instead
  // of vanishing out from under the tap.
  const pick = (username: string, shownName: string) => {
    // The SELECTION goes through toggle()'s functional update — that is the
    // batching-safe form, and it is the half that must never lose a write:
    // a dropped update here means someone the host removed still receives an
    // invite. Reading `selected` from the closure to build the next set
    // instead (tried, reverted) loses one of two updates that land in the
    // same React batch.
    //
    // The closure read below decides only whether to CLEAR THE QUERY, which
    // is cosmetic. If it were ever stale the query would simply not clear —
    // visible, harmless, and self-correcting on the next keystroke. Splitting
    // it this way keeps the authoritative write authoritative and confines
    // the closure to the part that cannot corrupt anything.
    const wasSelected = selected.has(username)
    toggle(username, shownName)
    if (!wasSelected) {
      setSearch('')
      searchRef.current?.focus()
    }
  }

  // Custom datetime-local values are interpreted in the viewer's timezone
  // (that's what the input means); convert to an instant for the API.
  const customIso = useMemo(() => {
    if (!customValue) return null
    const d = new Date(customValue)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }, [customValue])

  const effectiveIso = customOpen ? customIso : selectedIso
  const scheduleInPast = mode === 'schedule' && !!effectiveIso &&
    new Date(effectiveIso).getTime() < Date.now() + 30 * 1000
  const scheduleMissing = mode === 'schedule' && !effectiveIso

  const ctaLabel = busy
    ? (mode === 'now' ? 'Starting…' : 'Scheduling…')
    : mode === 'now'
      ? (selected.size ? 'Start party & send invites' : 'Start party')
      : (selected.size ? 'Schedule & send invites' : 'Schedule party')

  const submit = async () => {
    if (busy || scheduleMissing || scheduleInPast) return
    setBusy(true)
    setError(null)
    const result = await onLaunch({
      scheduledStartAt: mode === 'schedule' ? effectiveIso : null,
      usernames: [...selected],
      note: note.trim(),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Failed to start the party')
      return
    }
    if (mode === 'schedule' && effectiveIso && result.code) {
      setBooked({ code: result.code, iso: effectiveIso, invited: selected.size })
      return
    }
    onClose()
  }

  // Focus the search box once members load — the picker is the main input,
  // and with nothing listed until you type, the box IS the picker. Skipped
  // when there's nobody to find, so a one-account server doesn't open the
  // keyboard onto a search that can't match anything.
  useEffect(() => {
    if (members && members.length > 0) searchRef.current?.focus()
  }, [members])

  // Booked: the success state IS the share card. Same component the
  // lobby opens, so the two entry points can never drift.
  if (booked) {
    const invited = booked.invited > 0
      ? ` · ${booked.invited} ${booked.invited === 1 ? 'person' : 'people'} invited`
      : ''
    return (
      <PartyShareCardModal
        code={booked.code}
        title="Party booked"
        subtitle={`${formatPartyTime(booked.iso, new Date())}${invited}`}
        onClose={onClose}
      />
    )
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(6,7,8,0.72)] p-4 animate-fade-in"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Plan a watch party"
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-sheet bg-surface-raised-2 p-6 shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="mb-1 font-display text-[22px] font-semibold text-ink">Plan a watch party</h2>
        <p className="mb-4 text-[13px] leading-snug text-ink-2">
          {mediaTitle}
          {mediaType === 'show' ? ', starting with the next episode up' : ''}
          . Invitations arrive in members&rsquo; notifications.
        </p>

        {/* ─── When ──────────────────────────────────────────────── */}
        <p className="mb-2 text-xs font-semibold text-ink-2">When</p>
        <div className="grid grid-cols-2 gap-1 rounded-control bg-surface-raised p-1">
          {(['now', 'schedule'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`h-11 rounded-art text-[15px] font-semibold transition-colors ${
                mode === m ? 'bg-action text-action-on' : 'text-ink-2 hover:text-ink'
              }`}
            >
              {m === 'now' ? 'Right now' : 'Schedule'}
            </button>
          ))}
        </div>

        {mode === 'now' ? (
          <p className="mt-2.5 text-[13px] leading-relaxed text-ink-2">
            The party starts as soon as you press the button. Anyone you invite
            gets a notification they can join from.
          </p>
        ) : (
          <div className="mt-2.5">
            <div className="flex gap-2 flex-wrap">
              {chips.map(c => (
                <button
                  key={c.iso}
                  type="button"
                  onClick={() => { setCustomOpen(false); setSelectedIso(c.iso) }}
                  aria-pressed={!customOpen && selectedIso === c.iso}
                  className={`min-h-11 rounded-full border-2 bg-surface-raised px-4 text-[13px] font-semibold transition-colors ${
                    !customOpen && selectedIso === c.iso ? 'border-ink text-ink' : 'border-transparent text-ink-2 hover:text-ink'
                  }`}
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setCustomOpen(o => !o)}
                aria-pressed={customOpen}
                className={`min-h-11 rounded-full border-2 bg-surface-raised px-4 text-[13px] font-semibold transition-colors ${
                  customOpen ? 'border-ink text-ink' : 'border-transparent text-ink-2 hover:text-ink'
                }`}
              >
                Pick a date and time…
              </button>
            </div>
            {customOpen && (
              <input
                type="datetime-local"
                value={customValue}
                onChange={e => setCustomValue(e.target.value)}
                aria-label="Party date and time"
                className="mt-2.5 h-11 w-full py-0 [color-scheme:dark]"
              />
            )}
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              {effectiveIso && !scheduleInPast
                ? `Everyone is invited now and reminded 10 minutes before. The party starts by itself: ${formatPartyTime(effectiveIso, new Date())}.`
                : 'Times are in your time zone. Invitations go out at once; the party starts by itself at the time you pick.'}
            </p>
            {scheduleInPast && (
              <p className="mt-1.5 text-[13px] text-warn">That time has already passed. Pick one that is still ahead.</p>
            )}
          </div>
        )}

        {/* ─── Who ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mt-5 mb-2">
          <p className="text-xs font-semibold text-ink-2">
            Who
            <span className="ml-2 font-normal">optional: you can share the code later too</span>
          </p>
          {selected.size > 0 && (
            <span className="text-[13px] font-semibold tabular-nums text-ink">{selected.size} invited</span>
          )}
        </div>

        {/* Picked people. Survives the query being cleared — this row, not the
            search results, is the record of who is actually being invited. */}
        {selectedMembers.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 mb-2" aria-label="Selected guests">
            {selectedMembers.map(m => {
              const shownName = m.display_name || m.username
              return (
                <li key={m.username}>
                  <button
                    type="button"
                    onClick={() => {
                      toggle(m.username, shownName)
                      // The chip unmounts on click. Without this, focus falls
                      // to <body> — and this dialog has no focus trap, so the
                      // next Tab starts at the top of the page BEHIND it.
                      searchRef.current?.focus()
                    }}
                    // Qualified with the handle: two guests can share a
                    // display name, and "Remove JD" twice is unusable. The
                    // "@" is deliberately absent — screen readers read it as
                    // "at" regardless, and keeping it off the chips leaves
                    // "@handle" unique to the result rows.
                    aria-label={`Remove ${shownName} (${m.username}) from the invite list`}
                    className="flex min-h-11 items-center gap-1.5 rounded-full bg-surface-raised pl-1.5 pr-3 text-[13px] font-semibold text-ink transition-colors hover:bg-action-soft"
                  >
                    <ProfileAvatar avatarUrl={m.avatar_url} name={shownName} memberKey={m.user_id} size={28} />
                    <span className="max-w-[9rem] truncate">{shownName}</span>
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="w-3 h-3 flex-none">
                      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Type a name, ${MIN_MEMBER_QUERY_CHARS} letters or more`}
          aria-label="Search members by name"
          autoComplete="off"
          className="h-11 w-full py-0"
        />

        {/* Results. Nothing is listed until the query is long enough, so the
            bordered box only exists when there is something in it — an empty
            frame under the input reads as "broken", not as "keep typing". */}
        {membersError ? (
          <p className="mt-2 text-[13px] text-warn">
            Couldn't load members: {membersError}{' '}
            <button
              type="button"
              onClick={() => { setMembers(null); setRosterAttempt(n => n + 1) }}
              className="rounded-chip text-ink underline underline-offset-2"
            >
              Try again
            </button>
          </p>
        ) : members === null && search.trim() !== '' ? (
          // Any typing at all, not just a query past the threshold. Gating
          // this on `searching` told a host with a slow roster fetch to "type
          // at least 3 letters" — advice that is actively wrong for the
          // short-name members the threshold rule exists to keep reachable,
          // since their whole name IS the query.
          <p className="mt-2 text-[13px] text-ink-2">Loading members…</p>
        ) : rosterEmpty ? (
          <p className="mt-2 text-[13px] text-ink-2">Nobody else here yet.</p>
        ) : matches.length === 0 ? (
          searching
            ? (
              <p className="mt-2 text-[13px] text-ink-2">
                No members match “{search.trim()}”.
                {rosterTruncated && ' Only the first ' + members!.length + ' members were loaded, so someone further down the list may be missing — you can still invite them with the party code.'}
              </p>
            )
            : (
              <p className="mt-2 text-[13px] text-ink-2">
                Type at least {MIN_MEMBER_QUERY_CHARS} letters of someone&rsquo;s name to find them.
              </p>
            )
        ) : (
          <ul className="mt-2 max-h-56 overflow-y-auto rounded-control bg-surface-raised">
            {matches.map(m => {
              const shownName = m.display_name || m.username
              const on = selected.has(m.username)
              return (
                <li key={m.user_id}>
                  <button
                    type="button"
                    onClick={() => pick(m.username, shownName)}
                    aria-pressed={on}
                    className="flex min-h-[52px] w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-action-soft"
                  >
                    <ProfileAvatar avatarUrl={m.avatar_url} name={shownName} memberKey={m.user_id} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-ink">{shownName}</span>
                      <span className="block truncate text-xs text-ink-2">
                        @{m.username}{m.is_following ? ' · you follow them' : ''}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      // The box's edge is its sign when empty, so it is a
                      // colour that can be seen on the row.
                      className={`flex h-5 w-5 flex-none items-center justify-center rounded-chip border-2 transition-colors ${
                        on ? 'border-ink bg-action text-action-on' : 'border-ink-3'
                      }`}
                    >
                      {on && (
                        <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3">
                          <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {/* The cap is not silent. The results box already scrolls, so a list
            that was cut at 8 and a list that merely overflows look identical
            — and the announcement below would otherwise state the rendered
            count as if it were the match count. */}
        {hiddenMatches > 0 && (
          <p className="mt-1.5 text-[13px] text-ink-2">
            Showing {matches.length} of {totalMatches}
            {/* "Keep typing" is only true above the threshold. Below it,
                matches are whole-name equality, so another character can
                only take the count to zero — advice that walks the host into
                a dead end. */}
            {searching ? '. Keep typing to narrow it down.' : '.'}
          </p>
        )}

        {/* Announced, not shown: sighted users can see the list appear, but a
            screen-reader user typing into the box gets no other signal that
            the results underneath it changed.

            This mirrors the branch tree above rather than deriving from the
            match count alone: announcing "no matching members" while the
            roster is still loading — or, worse, when the fetch FAILED and
            the visible error sits outside any live region — tells the user
            that Sam isn't on this server when we simply don't know yet. */}
        <p className="sr-only" role="status" aria-live="polite" aria-label="Member search results">
          {membersError
            ? 'Could not load members'
            : members === null && search.trim() !== ''
              ? 'Loading members'
              : rosterEmpty
                ? 'Nobody else here yet'
                : matches.length > 0
                  ? `${totalMatches} matching ${totalMatches === 1 ? 'member' : 'members'}` +
                    (hiddenMatches > 0 ? `, showing ${matches.length}` : '')
                  : searching
                    // The visible copy stops asserting non-existence at the
                    // roster cap; this must not keep asserting it to the one
                    // audience that can't see the softer wording.
                    ? (rosterTruncated
                      ? 'No matching members in the first part of the directory that was loaded — you can still invite them with the party code'
                      : 'No matching members')
                    : ''}
        </p>
        {/* Separate region from the results status above: adding someone and
            the result list changing are two different events, and sharing one
            region means the second overwrites the first before it is read.
            This is the ONLY confirmation a screen-reader user gets that a
            pick landed — the row whose aria-pressed would have flipped is
            unmounted in the same commit, since picking clears the query. */}
        <p className="sr-only" role="status" aria-live="polite" aria-label="Guest list updates">{pickAnnouncement}</p>

        {/* ─── Note ──────────────────────────────────────────────── */}
        <p className="mb-2 mt-4 text-xs font-semibold text-ink-2">
          Note <span className="font-normal">optional</span>
        </p>
        <input
          type="text"
          value={note}
          maxLength={280}
          onChange={e => setNote(e.target.value)}
          placeholder="Costumes optional. Popcorn mandatory."
          aria-label="Invite note"
          className="h-11 w-full py-0"
        />

        {error && <p role="alert" className="mt-3 text-[14px] text-danger-ink">{error}</p>}

        <div className="mt-5 flex gap-2 justify-end items-center">
          <button type="button" onClick={onClose} className="stage-btn stage-btn-quiet">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || scheduleMissing || scheduleInPast}
            onClick={() => void submit()}
            className="stage-btn stage-btn-primary"
          >
            {ctaLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
