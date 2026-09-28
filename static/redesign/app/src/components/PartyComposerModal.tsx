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
        title="Party booked 🎉"
        subtitle={`${formatPartyTime(booked.iso, new Date())}${invited}`}
        onClose={onClose}
      />
    )
  }

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Plan a watch party"
        className="w-full max-w-md bg-[color:var(--surface-1)] border border-white/[0.06] rounded-2xl p-6 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-white text-lg font-semibold mb-1">Plan a Watch Party</h2>
        <p className="text-white/50 text-xs mb-4">
          {mediaTitle}
          {mediaType === 'show' ? ' — starts with the next-up episode' : ''}
          . Invites land in members' notifications.
        </p>

        {/* ─── When ──────────────────────────────────────────────── */}
        <p className="text-white/40 text-[10px] uppercase tracking-wider mb-2">When</p>
        <div className="grid grid-cols-2 gap-1.5 p-1.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          {(['now', 'schedule'] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                mode === m
                  ? 'bg-purple-600/25 border border-purple-500/50 text-white'
                  : 'text-white/55 hover:text-white/80'
              }`}
            >
              {m === 'now' ? 'Right now' : 'Schedule'}
            </button>
          ))}
        </div>

        {mode === 'now' ? (
          <p className="text-white/40 text-xs mt-2.5 leading-relaxed">
            The party starts as soon as you hit the button. Anyone you invite
            gets a notification with a one-tap join.
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
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    !customOpen && selectedIso === c.iso
                      ? 'bg-purple-600/25 border-purple-500/55 text-white'
                      : 'bg-white/[0.04] border-white/[0.09] text-white/75 hover:border-white/[0.2]'
                  }`}
                >
                  {c.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setCustomOpen(o => !o)}
                aria-pressed={customOpen}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  customOpen
                    ? 'bg-purple-600/25 border-purple-500/55 text-white'
                    : 'bg-white/[0.04] border-white/[0.09] text-white/75 hover:border-white/[0.2]'
                }`}
              >
                Pick date &amp; time…
              </button>
            </div>
            {customOpen && (
              <input
                type="datetime-local"
                value={customValue}
                onChange={e => setCustomValue(e.target.value)}
                aria-label="Party date and time"
                className="mt-2.5 w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-sm focus:bg-white/[0.06] focus:outline-none [color-scheme:dark]"
              />
            )}
            <p className="text-white/35 text-[11px] mt-2 leading-relaxed">
              {effectiveIso && !scheduleInPast
                ? `Everyone's invited now, reminded 10 minutes before showtime, and the party starts itself — ${formatPartyTime(effectiveIso, new Date())}.`
                : 'Times are in your timezone. Invites go out immediately; the party starts itself at showtime.'}
            </p>
            {scheduleInPast && (
              <p className="text-amber-300/90 text-xs mt-1.5">That time has already passed — pick a future time.</p>
            )}
          </div>
        )}

        {/* ─── Who ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mt-5 mb-2">
          <p className="text-white/40 text-[10px] uppercase tracking-wider">
            Who
            <span className="ml-2 normal-case tracking-normal text-white/30">optional — you can share the code later too</span>
          </p>
          {selected.size > 0 && (
            <span className="text-purple-300 text-xs font-medium">{selected.size} invited</span>
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
                    className="flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full bg-purple-600/20 border border-purple-500/40 text-white/90 text-xs hover:bg-purple-600/30 transition-colors"
                  >
                    <ProfileAvatar avatarUrl={m.avatar_url} name={shownName} size={18} />
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
          placeholder={`Type a name — ${MIN_MEMBER_QUERY_CHARS} letters minimum`}
          aria-label="Search members by name"
          autoComplete="off"
          className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-sm placeholder:text-white/30 focus:bg-white/[0.06] focus:outline-none"
        />

        {/* Results. Nothing is listed until the query is long enough, so the
            bordered box only exists when there is something in it — an empty
            frame under the input reads as "broken", not as "keep typing". */}
        {membersError ? (
          <p className="text-amber-300/80 text-xs mt-2">
            Couldn't load members: {membersError}{' '}
            <button
              type="button"
              onClick={() => { setMembers(null); setRosterAttempt(n => n + 1) }}
              className="underline underline-offset-2 hover:text-amber-200"
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
          <p className="text-white/40 text-xs mt-2">Loading members…</p>
        ) : rosterEmpty ? (
          <p className="text-white/40 text-xs mt-2">Nobody else here yet.</p>
        ) : matches.length === 0 ? (
          searching
            ? (
              <p className="text-white/40 text-xs mt-2">
                No members match “{search.trim()}”.
                {rosterTruncated && ' Only the first ' + members!.length + ' members were loaded, so someone further down the list may be missing — you can still invite them with the party code.'}
              </p>
            )
            : (
              <p className="text-white/35 text-[11px] mt-2">
                Type at least {MIN_MEMBER_QUERY_CHARS} letters of someone's name to find them.
              </p>
            )
        ) : (
          <ul className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-white/[0.06] divide-y divide-white/[0.05]">
            {matches.map(m => {
              const shownName = m.display_name || m.username
              const on = selected.has(m.username)
              return (
                <li key={m.user_id}>
                  <button
                    type="button"
                    onClick={() => pick(m.username, shownName)}
                    aria-pressed={on}
                    className="w-full flex items-center gap-3 p-2.5 text-left hover:bg-white/[0.04] transition-colors"
                  >
                    <ProfileAvatar avatarUrl={m.avatar_url} name={shownName} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-white/90 text-sm truncate">{shownName}</span>
                      <span className="block text-white/40 text-[11px] truncate">
                        @{m.username}{m.is_following ? ' · you follow them' : ''}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`w-5 h-5 rounded-md border flex items-center justify-center flex-none transition-colors ${
                        on ? 'bg-purple-600 border-purple-500' : 'border-white/25'
                      }`}
                    >
                      {on && (
                        <svg viewBox="0 0 24 24" fill="none" className="w-3 h-3">
                          <path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
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
          <p className="text-white/35 text-[11px] mt-1.5">
            Showing {matches.length} of {totalMatches}
            {/* "Keep typing" is only true above the threshold. Below it,
                matches are whole-name equality, so another character can
                only take the count to zero — advice that walks the host into
                a dead end. */}
            {searching ? ' — keep typing to narrow it down.' : '.'}
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
        <p className="text-white/40 text-[10px] uppercase tracking-wider mt-4 mb-2">
          Note <span className="normal-case tracking-normal text-white/30">optional</span>
        </p>
        <input
          type="text"
          value={note}
          maxLength={280}
          onChange={e => setNote(e.target.value)}
          placeholder="Costumes optional. Popcorn mandatory. 🍿"
          aria-label="Invite note"
          className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-sm placeholder:text-white/30 focus:bg-white/[0.06] focus:outline-none"
        />

        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}

        <div className="mt-5 flex gap-2 justify-end items-center">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-white/70 hover:text-white text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || scheduleMissing || scheduleInPast}
            onClick={() => void submit()}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {ctaLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
