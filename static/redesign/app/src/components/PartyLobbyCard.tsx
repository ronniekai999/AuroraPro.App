// Aurora V2 — PartyLobbyCard (watch-party invites)
//
// The "wait" state from the watch-party invite contract: rendered by
// PartyPanel's rail while a party is scheduled but not started. Shows the
// live countdown, the RSVP roster (from GET /api/parties/{code}/invites,
// polled while the lobby is visible — RSVPs land in Postgres, not on the
// party socket), and the host's controls (start early / change time).
//
// The countdown ticks on the local clock. The server's schedule timer is
// the authority — when it fires, the party-starting room event flips the
// panel out of lobby mode regardless of what this label reads, so a few
// hundred ms of client skew can't strand the UI.

import { useEffect, useMemo, useState } from 'react'
import { getPartyInviteRoster, type PartyInviteRosterEntry } from '@/lib/api'
import { countdownLabel, formatPartyTime } from '@/lib/partyInvites'
import { PartyShareCardModal } from './PartyShareCardModal'

const ROSTER_POLL_MS = 30_000

export interface PartyLobbyCardProps {
  code: string
  scheduledStartAt: string // ISO — caller renders this card only when set
  isHost: boolean
  // Host: start playback now (useParty.requestPlay). The server cancels
  // the countdown on the first play, so no separate "cancel" call needed.
  onStartNow?: () => void
  // Host: re-book the party (App wraps schedulePartyStart + toasts).
  onReschedule?: (iso: string) => void
}

export function PartyLobbyCard({ code, scheduledStartAt, isHost, onStartNow, onReschedule }: PartyLobbyCardProps) {
  const targetMs = useMemo(() => new Date(scheduledStartAt).getTime(), [scheduledStartAt])
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const [roster, setRoster] = useState<PartyInviteRosterEntry[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () => {
      getPartyInviteRoster(code)
        .then(r => { if (!cancelled) setRoster(r) })
        .catch(() => { /* non-fatal — the lobby works without a roster */ })
    }
    load()
    const t = setInterval(load, ROSTER_POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [code])

  const groups = useMemo(() => {
    const g = { going: [] as string[], maybe: [] as string[], pending: [] as string[] }
    for (const e of roster ?? []) {
      const name = e.display_name || e.username
      if (e.rsvp === 'going') g.going.push(name)
      else if (e.rsvp === 'maybe') g.maybe.push(name)
      else if (e.rsvp === 'pending') g.pending.push(name)
      // declined stays private to the decliner — no "Kyle said no" wall.
    }
    return g
  }, [roster])

  // Share card — host-only, and available any time before showtime.
  // Re-opening after a reschedule regenerates against the new time: the
  // server's cache key carries the schedule, so a moved party can never
  // hand out a poster advertising the old one.
  const [shareOpen, setShareOpen] = useState(false)

  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [rescheduleValue, setRescheduleValue] = useState('')
  const rescheduleIso = useMemo(() => {
    if (!rescheduleValue) return null
    const d = new Date(rescheduleValue)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }, [rescheduleValue])
  const reschedulePast = !!rescheduleIso && new Date(rescheduleIso).getTime() < Date.now() + 30_000

  const msLeft = targetMs - nowMs
  const overdue = msLeft <= 0

  return (
    <div className="mx-4 mt-3 rounded-xl bg-purple-600/[0.08] border border-purple-500/30 p-4">
      <p className="text-purple-300/90 text-[10px] uppercase tracking-wider font-semibold">Scheduled party</p>
      <div className="mt-1.5 text-center">
        <p className="text-white font-bold text-3xl tabular-nums" aria-live="off">
          {overdue ? 'Starting…' : countdownLabel(msLeft)}
        </p>
        <p className="text-white/50 text-xs mt-1">
          {overdue
            ? 'The server is starting the party.'
            : `Starts itself — ${formatPartyTime(scheduledStartAt, new Date(nowMs))}`}
        </p>
      </div>

      {/* RSVP roster. Sections render only when non-empty so a codes-only
          party (nobody formally invited) shows nothing extra. */}
      {(groups.going.length > 0 || groups.maybe.length > 0 || groups.pending.length > 0) && (
        <div className="mt-3 space-y-1.5">
          {([['Going', groups.going, 'text-emerald-300'],
             ['Maybe', groups.maybe, 'text-amber-300'],
             ['No reply yet', groups.pending, 'text-white/50']] as const).map(([label, names, cls]) =>
            names.length > 0 && (
              <p key={label} className="text-xs leading-relaxed">
                <span className={`font-semibold ${cls}`}>{label} ({names.length})</span>
                <span className="text-white/60"> — {names.join(', ')}</span>
              </p>
            ))}
        </div>
      )}

      {isHost ? (
        <div className="mt-3 flex gap-2 flex-wrap">
          {onStartNow && (
            <button
              type="button"
              onClick={onStartNow}
              className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition-colors"
            >
              Start now
            </button>
          )}
          {onReschedule && (
            <button
              type="button"
              onClick={() => setRescheduleOpen(o => !o)}
              className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.1] text-white/75 text-xs font-medium transition-colors"
            >
              {rescheduleOpen ? 'Keep current time' : 'Change time'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-purple-500/20 to-cyan-400/[0.18] border border-purple-300/45 text-white text-xs font-semibold transition-colors hover:from-purple-500/30 hover:to-cyan-400/25"
          >
            Share card
          </button>
        </div>
      ) : (
        <p className="mt-3 text-white/50 text-[11px] leading-relaxed">
          Hang out in chat — playback starts for everyone at once.
        </p>
      )}

      {isHost && onReschedule && rescheduleOpen && (
        <div className="mt-2.5">
          <input
            type="datetime-local"
            value={rescheduleValue}
            onChange={e => setRescheduleValue(e.target.value)}
            aria-label="New party time"
            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-xs focus:bg-white/[0.06] focus:outline-none [color-scheme:dark]"
          />
          {reschedulePast && (
            <p className="text-amber-300/90 text-[11px] mt-1">Pick a future time.</p>
          )}
          <div className="flex justify-end mt-2">
            <button
              type="button"
              disabled={!rescheduleIso || reschedulePast}
              onClick={() => {
                if (!rescheduleIso) return
                onReschedule(rescheduleIso)
                setRescheduleOpen(false)
                setRescheduleValue('')
              }}
              className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Update time
            </button>
          </div>
        </div>
      )}

      {shareOpen && (
        <PartyShareCardModal
          code={code}
          subtitle={formatPartyTime(scheduledStartAt, new Date(nowMs))}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  )
}
