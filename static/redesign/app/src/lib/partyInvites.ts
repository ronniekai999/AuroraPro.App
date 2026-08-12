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

// ── People picker search ────────────────────────────────────────────────
//
// The composer used to render the entire member list the moment it opened.
// On anything past a handful of accounts that is a wall of names to scroll
// past, and it puts every member of the household in front of every host who
// only ever wanted to invite one person. Nothing is listed now until the host
// has typed enough for the query to mean something specific.

// How many characters before we're willing to show anyone. Three is the point
// where a query stops matching most of the server: shorter than that and the
// "results" are just the list again with extra steps.
export const MIN_MEMBER_QUERY_CHARS = 3

// Results are a short list to scan, not a second directory. Anything past this
// means the query wasn't specific enough — keep typing.
export const MAX_MEMBER_RESULTS = 8

// The shape matchMembers needs. Structural, so both MemberSummary (api.ts)
// and test fixtures satisfy it without importing each other.
export interface MemberMatchable {
  username: string
  display_name?: string
  is_following?: boolean
}

// normalizeMemberQuery trims, lowercases, and drops a leading "@" — people
// type handles the way they read them ("@ronnie"), and the stored username
// is bare.
export function normalizeMemberQuery(query: string): string {
  return query.trim().replace(/^@+/, '').toLowerCase()
}

// memberQueryReady reports whether a query is long enough to search on.
// Drives the picker's "keep typing" hint as well as the search itself, so
// the threshold can never drift between the two.
export function memberQueryReady(query: string): boolean {
  return normalizeMemberQuery(query).length >= MIN_MEMBER_QUERY_CHARS
}

// matchMembers ranks members against a typed query. Returns [] for a query
// below the threshold — "too short" and "no matches" are deliberately the
// same empty result here; the caller distinguishes them with
// memberQueryReady so the two states can say different things on screen.
//
// Ranking, best first:
//   1. the query starts the username or the display name (what you get when
//      you type the first letters of someone's name, which is the whole
//      interaction this picker is built around),
//   2. it appears anywhere in either,
// and inside each tier, people you follow come before people you don't, then
// alphabetically by the name actually rendered on the row.
export function matchMembers<T extends MemberMatchable>(
  members: readonly T[],
  query: string,
  limit: number = MAX_MEMBER_RESULTS,
): T[] {
  const q = normalizeMemberQuery(query)
  if (q.length < MIN_MEMBER_QUERY_CHARS) return []

  const scored: Array<{ m: T; tier: number; name: string }> = []
  for (const m of members) {
    const username = m.username.toLowerCase()
    const display = (m.display_name ?? '').toLowerCase()
    const prefix = username.startsWith(q) || display.startsWith(q)
    const anywhere = username.includes(q) || display.includes(q)
    if (!prefix && !anywhere) continue
    scored.push({ m, tier: prefix ? 0 : 1, name: (m.display_name || m.username).toLowerCase() })
  }

  scored.sort((a, b) =>
    a.tier - b.tier ||
    Number(!!b.m.is_following) - Number(!!a.m.is_following) ||
    a.name.localeCompare(b.name))

  return scored.slice(0, Math.max(0, limit)).map(s => s.m)
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
