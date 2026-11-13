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

import { useEffect, useId, useMemo, useState } from 'react'
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
  const ids = useId()
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
    // On the rail, which is one surface step down.
    <div className="mx-4 mt-3 rounded-control bg-surface-raised-2 p-4">
      <p className="text-xs font-semibold text-ink-2">Scheduled party</p>
      <div className="mt-1.5 text-center">
        <p className="font-display text-[32px] font-bold leading-tight tabular-nums text-ink" aria-live="off">
          {overdue ? 'Starting…' : countdownLabel(msLeft)}
        </p>
        <p className="mt-1 text-[13px] text-ink-2">
          {overdue
            ? 'The server is starting the party.'
            : `Starts by itself · ${formatPartyTime(scheduledStartAt, new Date(nowMs))}`}
        </p>
      </div>

      {/* The replies. A group shows only when someone is in it, so a party
          nobody was formally invited to shows nothing extra. */}
      {(groups.going.length > 0 || groups.maybe.length > 0 || groups.pending.length > 0) && (
        <div className="mt-3 space-y-1.5">
          {([['Going', groups.going, 'text-ok'],
             ['Maybe', groups.maybe, 'text-warn'],
             ['No reply yet', groups.pending, 'text-ink-2']] as const).map(([label, names, cls]) =>
            names.length > 0 && (
              <p key={label} className="text-[13px] leading-relaxed">
                <span className={`font-semibold ${cls}`}>{label} ({names.length})</span>
                <span className="text-ink-2">: {names.join(', ')}</span>
              </p>
            ))}
        </div>
      )}

      {isHost ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {onStartNow && (
            <button type="button" onClick={onStartNow} className="stage-btn stage-btn-primary px-4">Start now</button>
          )}
          {onReschedule && (
            <button type="button" aria-expanded={rescheduleOpen} onClick={() => setRescheduleOpen(o => !o)} className="stage-btn stage-btn-ghost px-4">
              {rescheduleOpen ? 'Keep current time' : 'Change time'}
            </button>
          )}
          <button type="button" onClick={() => setShareOpen(true)} className="stage-btn stage-btn-ghost px-4">Share card</button>
        </div>
      ) : (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
          Hang out in the chat. Playback starts for everyone at once.
        </p>
      )}

      {isHost && onReschedule && rescheduleOpen && (
        <div className="mt-3">
          <input
            type="datetime-local"
            value={rescheduleValue}
            onChange={e => setRescheduleValue(e.target.value)}
            aria-label="New party time"
            aria-invalid={reschedulePast}
            aria-describedby={reschedulePast ? `${ids}-past` : undefined}
            className="h-11 w-full py-0 [color-scheme:dark]"
          />
          {reschedulePast && <p id={`${ids}-past`} className="mt-1.5 text-[13px] text-warn">Pick a time that is still ahead.</p>}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={!rescheduleIso || reschedulePast}
              onClick={() => {
                if (!rescheduleIso) return
                onReschedule(rescheduleIso)
                setRescheduleOpen(false)
                setRescheduleValue('')
              }}
              className="stage-btn stage-btn-primary px-4"
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
