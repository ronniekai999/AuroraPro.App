// Watch-party invites — pure helpers shared by the composer modal, the
// notification panel's RSVP rows, and the Calendar's party chips. Pure and
// dependency-free on purpose: the date math here decides what day a party
// lands on and what the quick-pick chips offer, and both have unit tests.

// One quick-pick option in the composer's "When" section.
export interface QuickChip {
  label: string
  // RFC 3339 with the user's local offset resolved to an instant.
  iso: string
}

const HOUR_MS = 60 * 60 * 1000

// atLocalHour returns a Date pinned to `hour`:00 local time on the same
// calendar day as `base` (+ dayOffset days).
function atLocalHour(base: Date, hour: number, dayOffset: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d
}

// buildQuickChips proposes concrete start times: tonight's 8 and 9 PM when
// they're still comfortably in the future (≥20 minutes out — a chip that
// fires "in 30 seconds" reads as a bug), then tomorrow 8 PM. Always at
// least two options.
export function buildQuickChips(now: Date): QuickChip[] {
  const chips: QuickChip[] = []
  const cutoff = now.getTime() + 20 * 60 * 1000
  for (const hour of [20, 21]) {
    const t = atLocalHour(now, hour, 0)
    if (t.getTime() >= cutoff) {
      chips.push({ label: `Tonight · ${formatClock(t)}`, iso: t.toISOString() })
    }
  }
  const tomorrow = atLocalHour(now, 20, 1)
  chips.push({ label: `Tomorrow · ${formatClock(tomorrow)}`, iso: tomorrow.toISOString() })
  if (chips.length < 2) {
    const tomorrowLate = atLocalHour(now, 21, 1)
    chips.push({ label: `Tomorrow · ${formatClock(tomorrowLate)}`, iso: tomorrowLate.toISOString() })
  }
  return chips
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// inviteCodeFromLink extracts the 6-char party code from a notification's
// /p/{CODE} deep link. Same-origin relative links only — mirrors the
// panel's safeNotifLink policy. The path prefix is matched case-sensitively
// (the server always writes "/p/"); only the code is normalized.
export function inviteCodeFromLink(link?: string): string | null {
  if (!link) return null
  const m = /^\/p\/([A-Za-z0-9]{6})\/?$/.exec(link.trim())
  return m ? m[1].toUpperCase() : null
}

// localDateKey converts an instant to the LOCAL 'YYYY-MM-DD' it falls on.
// The Calendar's episode grouping is UTC-keyed because air dates are
// calendar-ish data; a party start is a real instant, and grouping it by
// UTC date puts an 8 PM EDT party on tomorrow's cell — so parties key by
// the viewer's local date instead.
export function localDateKey(iso: string): string {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// formatPartyTime renders a start instant for chips and bell rows:
// "Tonight · 8:00 PM" / "Tomorrow · 8:00 PM" / "Fri, Aug 7 · 8:00 PM",
// falling back to a plain date once it's more than a week out.
export function formatPartyTime(iso: string, now: Date): string {
  const t = new Date(iso)
  const clock = formatClock(t)
  const dayKey = localDateKey(iso)
  if (dayKey === localDateKey(now.toISOString())) return `Tonight · ${clock}`
  if (dayKey === localDateKey(new Date(now.getTime() + 24 * HOUR_MS).toISOString())) {
    return `Tomorrow · ${clock}`
  }
  const weekday = t.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return `${weekday} · ${clock}`
}

// skipReasonCopy maps the send endpoint's stable skip reasons to the words
// the composer shows. Unknown reasons pass through verbatim.
export function skipReasonCopy(reason: string): string {
  switch (reason) {
    case 'not_found':
      return 'no member with that name'
    case 'self':
      return "that's you"
    case 'rating_restricted':
      return 'this title is above their rating ceiling'
    case 'already_invited':
      return 'already invited'
    default:
      return reason
  }
}

// countdownParts renders a "starts in" delta as h:mm:ss / m:ss, clamped at
// zero. Feed it server-aligned time (now + clockOffset) so every client's
// countdown converges.
export function countdownLabel(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
