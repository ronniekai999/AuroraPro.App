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
// is bare. Trimmed again after the strip so "@ sam" doesn't normalize to a
// query with a leading space.
export function normalizeMemberQuery(query: string): string {
  return query.trim().replace(/^@+/, '').trim().toLowerCase()
}

// memberQueryReady reports whether a query is long enough to run the normal
// substring search. Drives the picker's "keep typing" hint as well as the
// search itself, so the threshold can never drift between the two.
//
// NOTE this is not the same question as "will matchMembers return anything" —
// see the short-name rule below. The picker renders results whenever there
// are any, and only falls back to the hint when there are none.
export function memberQueryReady(query: string): boolean {
  return normalizeMemberQuery(query).length >= MIN_MEMBER_QUERY_CHARS
}

// rankMembers is the whole ranked match set, uncapped. Exported behaviour
// goes through matchMembers (capped) and countMemberMatches (total) so the
// two can never disagree about what matched.
//
// Ranking, best first:
//   1. the query starts the username or the display name (what you get when
//      you type the first letters of someone's name, which is the whole
//      interaction this picker is built around),
//   2. it appears anywhere in either,
// and inside each tier, people you follow come before people you don't, then
// alphabetically by the name actually rendered on the row.
//
// THE SHORT-NAME RULE. Below MIN_MEMBER_QUERY_CHARS we normally match
// nobody — that gate is the point of the search-first picker. But a floor
// applied blindly makes some members permanently unreachable: the OAuth
// signup path derives a username from the email local-part with no length
// floor (jd@gmail.com becomes "jd"), display names have no minimum at all,
// and plenty of CJK names are exactly two characters. Those people are
// invitable through the API and visible in /members, so a picker that can
// never surface them is a client-side lockout, not a tidier list.
//
// So below the threshold we match only names the query has ALREADY spelled
// out in full. Typing "sa" still shows nobody (no one is named "sa"), while
// typing "jd" finds @jd, because there is no third letter to ask for.
function rankMembers<T extends MemberMatchable>(members: readonly T[], q: string): T[] {
  if (!q) return []
  const short = q.length < MIN_MEMBER_QUERY_CHARS

  const scored: Array<{ m: T; tier: number; name: string }> = []
  for (const m of members) {
    const username = m.username.toLowerCase()
    const display = (m.display_name ?? '').toLowerCase()
    let tier: number
    if (short) {
      // Complete-name matches only — anything else would be the wall of
      // names the threshold exists to prevent.
      if (username !== q && display !== q) continue
      tier = 0
    } else {
      const prefix = username.startsWith(q) || display.startsWith(q)
      if (!prefix && !(username.includes(q) || display.includes(q))) continue
      tier = prefix ? 0 : 1
    }
    scored.push({ m, tier, name: (m.display_name || m.username).toLowerCase() })
  }

  scored.sort((a, b) =>
    a.tier - b.tier ||
    Number(!!b.m.is_following) - Number(!!a.m.is_following) ||
    a.name.localeCompare(b.name))

  return scored.map(s => s.m)
}

// MEMBER_DIRECTORY_LIMIT mirrors the server's `LIMIT 500` on /api/members
// (internal/db/queries_social.go). At the cap the client is searching a
// truncated roster, so "no members match" stops being a fact about the
// server and becomes a fact about what we happened to fetch — which the
// picker has to say out loud rather than assert someone doesn't exist.
export const MEMBER_DIRECTORY_LIMIT = 500

// matchMembersWithTotal returns the rows to render AND how many matched
// before the cap, from a single pass. The picker needs both on every
// keystroke, and computing them separately means two full scans plus two
// sorts — and two chances to disagree about what matched.
export function matchMembersWithTotal<T extends MemberMatchable>(
  members: readonly T[],
  query: string,
  limit: number = MAX_MEMBER_RESULTS,
): { matches: T[]; total: number } {
  const ranked = rankMembers(members, normalizeMemberQuery(query))
  return { matches: ranked.slice(0, Math.max(0, limit)), total: ranked.length }
}

// matchMembers returns just the rows the picker should render: ranked, and
// capped so the results stay a short list to scan rather than a second
// directory.
export function matchMembers<T extends MemberMatchable>(
  members: readonly T[],
  query: string,
  limit: number = MAX_MEMBER_RESULTS,
): T[] {
  return matchMembersWithTotal(members, query, limit).matches
}

// countMemberMatches is how many members matched BEFORE the cap. With 12
// matches and a cap of 8, saying "8 matching members" isn't an omission,
// it's false.
export function countMemberMatches<T extends MemberMatchable>(
  members: readonly T[],
  query: string,
): number {
  return matchMembersWithTotal(members, query).total
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
