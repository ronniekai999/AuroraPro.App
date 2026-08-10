// Aurora V2 — PartyComposerModal (watch-party invites)
//
// The "Plan a Watch Party" modal from docs/proposals/watch-party-invites:
// one modal, one decision at the top — When. "Right now" starts the party
// the moment you send; "Schedule" books it for a quick-chip time or a
// custom date/time. Below that, both modes share the same people picker
// (members list, followed people first), an optional note, and a CTA whose
// label tracks the mode + selection.
//
// The modal is presentation + selection state only. The actual
// create → invite → join sequence lives in App.tsx's launchPartyComposer
// (passed as onLaunch) so this component needs no access to the party hook
// — it reports what the user chose and shows busy/error feedback.

import { useEffect, useMemo, useRef, useState } from 'react'
import { listMembers, type MemberSummary } from '@/lib/api'
import { buildQuickChips, formatPartyTime } from '@/lib/partyInvites'
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

  // People picker. Followed members sort first — the follow graph is the
  // "my people" signal, but anyone on the server is invitable (invite-only
  // household; the server enforces rating ceilings per invitee).
  const [members, setMembers] = useState<MemberSummary[] | null>(null)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Set once a SCHEDULED party is booked: the composer hands off to the
  // share card instead of just closing. "Right now" parties skip this —
  // the host is about to be in the room, not posting about it.
  const [booked, setBooked] = useState<{ code: string; iso: string; invited: number } | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    listMembers(ac.signal)
      .then(list => {
        const mine = (currentUsername ?? '').toLowerCase()
        const others = list.filter(m => m.username.toLowerCase() !== mine)
        others.sort((a, b) =>
          Number(b.is_following) - Number(a.is_following) ||
          a.username.localeCompare(b.username))
        setMembers(others)
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        setMembersError(err instanceof Error ? err.message : 'Failed to load members')
        setMembers([])
      })
    return () => ac.abort()
  }, [currentUsername])

  const filtered = useMemo(() => {
    if (!members) return null
    const q = search.trim().toLowerCase()
    if (!q) return members
    return members.filter(m =>
      m.username.toLowerCase().includes(q) ||
      (m.display_name ?? '').toLowerCase().includes(q))
  }, [members, search])

  const toggle = (username: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(username)) next.delete(username)
      else next.add(username)
      return next
    })
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

  // Focus the search box once members load — the picker is the main input.
  const searchRef = useRef<HTMLInputElement | null>(null)
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
      className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Plan a watch party"
        className="w-full max-w-md bg-[#0a0a0f] border border-white/[0.06] rounded-2xl p-6 max-h-[90vh] overflow-y-auto"
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
        <input
          ref={searchRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search members…"
          aria-label="Search members"
          className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.06] rounded-lg text-white text-sm placeholder:text-white/30 focus:bg-white/[0.06] focus:outline-none"
        />
        <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-white/[0.06] divide-y divide-white/[0.05]">
          {members === null && <p className="text-white/40 text-xs p-3">Loading members…</p>}
          {membersError && <p className="text-amber-300/80 text-xs p-3">Couldn't load members: {membersError}</p>}
          {filtered && filtered.length === 0 && !membersError && (
            <p className="text-white/40 text-xs p-3">
              {search ? 'No members match.' : 'Nobody else here yet.'}
            </p>
          )}
          {filtered?.map(m => {
            const shownName = m.display_name || m.username
            const on = selected.has(m.username)
            return (
              <button
                key={m.user_id}
                type="button"
                onClick={() => toggle(m.username)}
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
            )
          })}
        </div>

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
