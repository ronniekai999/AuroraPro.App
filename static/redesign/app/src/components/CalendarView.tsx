// Phase 6 — Calendar view (upcoming TV episodes).
//
// Two view modes:
//   "list" — original vertical date-grouped list (good for "what's
//            coming up this week" scanning).
//   "grid" — traditional month calendar grid with episode chips
//            inside each day cell. Better for "is anything airing
//            on May 23?" lookups.
//
// User can toggle between them via a header pill; preference is
// stored in localStorage so it persists across sessions. Both views
// share the same fetch — when in "grid" mode the window expands to
// the displayed month (rather than the rolling 30-day window list
// mode uses).

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  getCalendar, posterURL, listMyPartyInvites, listActiveParties,
  type UpcomingEpisode,
} from '@/lib/api'
import { localDateKey } from '@/lib/partyInvites'
import { PageHeader } from '@/components/PageHeader'
import { Icon } from '@/components/Icon'

interface Props {
  onOpenMedia: (id: number) => void
  // Invites feature — scheduled watch parties render as chips beside
  // episode premieres. currentUserId identifies the caller's own hosted
  // parties in /api/parties/active; onJoinParty joins in-app (App's
  // bell-join path). Both optional so the view still works standalone.
  currentUserId?: number
  onJoinParty?: (code: string) => void
}

// One scheduled watch party on the calendar: an invite the caller
// accepted (going/maybe) or a party they're hosting.
interface PartyCalEntry {
  code: string
  title: string
  hostUsername?: string
  startIso: string
  role: 'host' | 'invitee'
  rsvp?: string
}

// Party start times are real instants, so they group by the viewer's
// LOCAL date — unlike episode air dates, which are calendar-ish data and
// keep their historical UTC keying. An 8 PM EDT party grouped by UTC
// would land on tomorrow's cell.
function usePartyGroups(entries: PartyCalEntry[]): Map<string, PartyCalEntry[]> {
  return useMemo(() => {
    const map = new Map<string, PartyCalEntry[]>()
    for (const e of entries) {
      const key = localDateKey(e.startIso)
      const arr = map.get(key) || []
      arr.push(e)
      map.set(key, arr)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.startIso.localeCompare(b.startIso))
    }
    return map
  }, [entries])
}

function partyClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

const LIST_WINDOW_DAYS = 30
const LS_VIEW_MODE_KEY = 'aurora_calendar_view'

type ViewMode = 'list' | 'grid'

function toISODate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// UTC-consistent today: midnight UTC of the current UTC date.
function todayUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

// First-of-month for a given UTC date.
function firstOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}
// Last-of-month for a given UTC date (the day before the next month's 1st).
function lastOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
}

// Audit M3 fix — UTC-consistent date math.
//
// QA 2026-05-25 — separator was inconsistent: ` · ` for days 0-6,
// `, ` for days 7+. Normalized to ` · ` everywhere so the calendar
// reads consistently. Also added year when the date is in a different
// calendar year from today (relevant for the rolling 30-day list view
// when it crosses Dec→Jan, and for the grid when the user navigates
// to a future/past month).
// Split into parts (Aurora Stage Phase 6) so the list header can render
// "Today" as the mockup's pill instead of as words. Composing the string and
// then trying to detect/strip the prefix would have been locale-broken the
// moment a translation lands; the caller now just chooses whether to draw
// `relative` as text or as a pill.
export function groupDateParts(iso: string): { relative: string; monthDay: string; isToday: boolean } {
  const datePart = iso.length >= 10 ? iso.slice(0, 10) : iso
  const d = new Date(`${datePart}T00:00:00Z`)
  const today = todayUTC()
  const diffDays = Math.round((d.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  const weekday = d.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })
  // Include year only when it differs from today's year — keeps the
  // common case ("May 28") compact while still disambiguating
  // year-boundary entries ("Jan 3, 2027").
  const dateOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' }
  if (d.getUTCFullYear() !== today.getUTCFullYear()) {
    dateOpts.year = 'numeric'
  }
  const monthDay = d.toLocaleDateString(undefined, dateOpts)
  const relative = diffDays === 0 ? 'Today' : diffDays === 1 ? 'Tomorrow' : weekday
  return { relative, monthDay, isToday: diffDays === 0 }
}

function formatGroupDate(iso: string): string {
  const { relative, monthDay } = groupDateParts(iso)
  return `${relative} · ${monthDay}`
}

export default function CalendarView({ onOpenMedia, currentUserId, onJoinParty }: Props) {
  // Preference-loaded view mode. Defaults to 'list' on first visit;
  // localStorage round-trip persists across sessions per browser.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const stored = localStorage.getItem(LS_VIEW_MODE_KEY)
      return stored === 'grid' ? 'grid' : 'list'
    } catch { return 'list' }
  })
  // Cursor month for grid view. Initially the current UTC month.
  // List view ignores this — its window is always today→today+30.
  const [cursorMonth, setCursorMonth] = useState<Date>(() => firstOfMonthUTC(todayUTC()))
  // Selected day for grid drill-down. null = no day selected; the
  // grid shows month-overview chips. Setting a date reveals an
  // expanded panel below the grid with that day's episodes.
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  const [episodes, setEpisodes] = useState<UpcomingEpisode[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Compute the fetch window from current mode + cursor.
  const { fromISO, toISO } = useMemo(() => {
    if (viewMode === 'list') {
      const today = todayUTC()
      const future = new Date(today.getTime() + LIST_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      return { fromISO: toISODate(today), toISO: toISODate(future) }
    }
    // grid: fetch the WHOLE displayed grid range (incl. lead/trail
    // days from adjacent months so chip rendering covers the full
    // visible grid). Audit L2 — `gridLeadDays` / `gridTrailDays`
    // respect the locale's first-day-of-week.
    const monthStart = firstOfMonthUTC(cursorMonth)
    const monthEnd = lastOfMonthUTC(cursorMonth)
    const leadDays = gridLeadDays(monthStart)
    const trailDays = gridTrailDays(monthEnd)
    const gridStart = new Date(monthStart.getTime() - leadDays * 86_400_000)
    const gridEnd = new Date(monthEnd.getTime() + trailDays * 86_400_000)
    return { fromISO: toISODate(gridStart), toISO: toISODate(gridEnd) }
  }, [viewMode, cursorMonth])

  // Fetch on window change.
  // Audit M3 fix (Phase 8) — keep showing stale episodes while the
  // new window's fetch is in flight. The previous code did an
  // unconditional `setEpisodes(null)` which flashed "Loading…" on
  // every view-mode toggle and every month nav, even when the new
  // window was a subset of (or fully cached by) the prior one.
  // Letting stale data linger feels instantaneous; the new data
  // swaps in cleanly when the request resolves.
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    setError(null)
    getCalendar(fromISO, toISO, ac.signal)
      .then((eps) => { if (!cancelled) setEpisodes(eps) })
      .catch((e) => {
        if (!cancelled && e.name !== 'AbortError') {
          setError(e instanceof Error ? e.message : 'Failed to load calendar')
        }
      })
    return () => { cancelled = true; ac.abort() }
  }, [fromISO, toISO])

  // Persist view-mode preference.
  useEffect(() => {
    try { localStorage.setItem(LS_VIEW_MODE_KEY, viewMode) } catch { /* private mode */ }
  }, [viewMode])

  // Scheduled watch parties: invites the caller answered going/maybe,
  // plus parties they host. Fetched once per mount — parties are sparse
  // and the view is short-lived; the bell keeps live state elsewhere.
  // Both requests are best-effort: the calendar's episode content never
  // waits on (or breaks from) the party layer.
  const [partyEntries, setPartyEntries] = useState<PartyCalEntry[]>([])
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    Promise.allSettled([listMyPartyInvites(ac.signal), listActiveParties(ac.signal)])
      .then(([invitesRes, activeRes]) => {
        if (cancelled) return
        const out: PartyCalEntry[] = []
        const seen = new Set<string>()
        if (invitesRes.status === 'fulfilled') {
          for (const i of invitesRes.value) {
            if (!i.scheduled_start_at) continue
            if (i.rsvp !== 'going' && i.rsvp !== 'maybe') continue
            if (seen.has(i.party_code)) continue
            seen.add(i.party_code)
            out.push({
              code: i.party_code,
              title: i.media_title,
              hostUsername: i.host_username,
              startIso: i.scheduled_start_at,
              role: 'invitee',
              rsvp: i.rsvp,
            })
          }
        }
        if (activeRes.status === 'fulfilled' && currentUserId) {
          for (const p of activeRes.value) {
            if (p.host_user_id !== currentUserId) continue
            if (!p.scheduled_start_at || p.started_at) continue
            if (seen.has(p.code)) continue
            seen.add(p.code)
            out.push({
              code: p.code,
              title: p.media_title || p.party_name,
              startIso: p.scheduled_start_at,
              role: 'host',
            })
          }
        }
        setPartyEntries(out)
      })
    return () => { cancelled = true; ac.abort() }
  }, [currentUserId])

  // Group episodes by UTC date key (YYYY-MM-DD) — used by both views.
  const groups = useMemoGroups(episodes)
  const partyGroups = usePartyGroups(partyEntries)

  if (error) return <p className="text-red-300 p-8">{error}</p>

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow={viewMode === 'list' ? 'Upcoming' : 'Month view'}
        title="Calendar"
        sub={episodes && (() => {
            // QA BUG-004 — make the window explicit + leading in both
            // views, in matching shape, so the count delta between
            // List ("next 30 days") and Grid ("May 2026") is
            // self-explanatory rather than surprising.
            //
            // The grid mode's FETCH window includes lead/trail days
            // padding from adjacent months (so chips render on the
            // full visible grid). For the subtitle COUNT we must
            // restrict to the cursorMonth's actual boundaries —
            // otherwise "May 2026 · 98 episodes" silently includes
            // late-April and early-June airdates and is wrong.
            let displayed = episodes
            if (viewMode === 'grid') {
              const monthStart = firstOfMonthUTC(cursorMonth).getTime()
              // lastOfMonthUTC returns the LAST day at 00:00 UTC; +1d
              // gives an exclusive upper bound covering the whole day.
              const monthEnd = lastOfMonthUTC(cursorMonth).getTime() + 86_400_000
              displayed = episodes.filter(e => {
                const t = new Date(e.air_date).getTime()
                return t >= monthStart && t < monthEnd
              })
            }
            const rangeLabel = viewMode === 'list'
              ? `Next ${LIST_WINDOW_DAYS} days`
              : cursorMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
            const epWord = `episode${displayed.length === 1 ? '' : 's'}`
            // Returned as a fragment, not a template literal. This subline is
            // mixed markup (a highlighted range label plus a separator dot)
            // and PageHeader's `sub` is typed ReactNode precisely so it can be
            // — the Phase 4 `[object Object]` bug was a JSX fragment forced
            // through a string-typed prop.
            return (
              <>
                <span className="text-white/85 font-medium">{rangeLabel}</span>
                <span className="text-white/30 mx-1.5">•</span>
                {displayed.length === 0
                  ? 'no upcoming episodes from shows in your library'
                  : `${displayed.length} ${epWord} from shows in your library`}
              </>
            )
          })()}
        action={
          // The mockup's .lm-seg: a hard-edged two-up segment, not two pills
          // in a rounded tray. Labels are "List" and "Month" — the old second
          // label was "Calendar", which named the page rather than the mode
          // it switches to.
          <div className="stage-seg inline-flex" role="group" aria-label="Calendar view mode">
            <button type="button" onClick={() => setViewMode('list')} aria-pressed={viewMode === 'list'}>
              List
            </button>
            <button type="button" onClick={() => setViewMode('grid')} aria-pressed={viewMode === 'grid'}>
              Month
            </button>
          </div>
        }
      />

      {episodes === null ? (
        <p className="text-white/50">Loading calendar…</p>
      ) : viewMode === 'list' ? (
        <ListView
          episodes={episodes}
          groups={groups}
          partyGroups={partyGroups}
          onOpenMedia={onOpenMedia}
          onJoinParty={onJoinParty}
        />
      ) : (
        <GridView
          cursorMonth={cursorMonth}
          setCursorMonth={setCursorMonth}
          groups={groups}
          partyGroups={partyGroups}
          selectedDay={selectedDay}
          setSelectedDay={setSelectedDay}
          onOpenMedia={onOpenMedia}
          onJoinParty={onJoinParty}
        />
      )}
    </div>
  )
}

// Shared group-by-date helper. Returns a Map<YYYY-MM-DD, episodes>.
// Memoized via useMemo on the episodes reference so re-renders don't
// rebuild the map unnecessarily.
function useMemoGroups(episodes: UpcomingEpisode[] | null): Map<string, UpcomingEpisode[]> {
  return useMemo(() => {
    const map = new Map<string, UpcomingEpisode[]>()
    if (!episodes) return map
    for (const ep of episodes) {
      const key = ep.air_date.slice(0, 10)
      const arr = map.get(key) || []
      arr.push(ep)
      map.set(key, arr)
    }
    return map
  }, [episodes])
}

// ─────────────────────── List View ───────────────────────

function ListView({
  episodes, groups, partyGroups, onOpenMedia, onJoinParty,
}: {
  episodes: UpcomingEpisode[]
  groups: Map<string, UpcomingEpisode[]>
  partyGroups: Map<string, PartyCalEntry[]>
  onOpenMedia: (id: number) => void
  onJoinParty?: (code: string) => void
}) {
  if (episodes.length === 0 && partyGroups.size === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-white/60 text-lg">Nothing scheduled.</p>
        <p className="text-white/50 text-sm mt-2 max-w-md mx-auto">
          Once you add TV shows to your library, upcoming episodes will appear here based on their TMDB air dates.
        </p>
      </div>
    )
  }
  // Union of episode days and party days — a party on a no-airings day
  // still needs its date section.
  const orderedKeys = [...new Set([...groups.keys(), ...partyGroups.keys()])].sort()
  return (
    // Tighter than the old space-y-8: the mockup's date groups are 18px
    // apart, which lets three or four days sit on screen at once. Eight
    // units (32px) meant a week of episodes took two scrolls to scan.
    <div className="space-y-[18px]">
      {orderedKeys.map((key) => {
        const eps = groups.get(key) ?? []
        const parties = partyGroups.get(key) ?? []
        const { relative, monthDay, isToday } = groupDateParts(key)
        return (
          <section key={key}>
            {/* .stage-caldate — the mockup's group header: a small purple
                date line with a TODAY pill, rather than a bare 18px heading.
                The pill is the reason the header can be small: it carries the
                emphasis that the type size used to.

                `relative` is rendered as the pill OR as text, never both —
                groupDateParts hands over the pieces precisely so this doesn't
                become "Today Today · May 28". */}
            <h2 className="stage-caldate flex flex-wrap mb-2.5">
              {isToday
                ? <><span className="today">Today</span>{monthDay}</>
                : <>{relative} · {monthDay}</>}
              <small className="text-white/55 font-medium">
                {eps.length > 0 && <>· {eps.length} episode{eps.length === 1 ? '' : 's'}</>}
                {parties.length > 0 && <>{eps.length > 0 ? ' ' : ''}· {parties.length} watch part{parties.length === 1 ? 'y' : 'ies'}</>}
              </small>
            </h2>
            <div className="space-y-1.5">
              {parties.map(p => (
                <PartyCalRow key={p.code} entry={p} onJoinParty={onJoinParty} />
              ))}
              {eps.map((ep) => (
                <EpisodeRow key={`${ep.media_item_id}-${ep.episode_id}`} ep={ep} onOpenMedia={onOpenMedia} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// A scheduled watch party in the list / day panel. The whole row joins
// (opens the lobby) when onJoinParty is wired.
function PartyCalRow({ entry, onJoinParty }: { entry: PartyCalEntry; onJoinParty?: (code: string) => void }) {
  const sub = [
    partyClock(entry.startIso),
    entry.role === 'host' ? 'you host' : entry.hostUsername ? `hosted by ${entry.hostUsername}` : '',
    entry.rsvp === 'maybe' ? "you said maybe" : '',
  ].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      onClick={onJoinParty ? () => onJoinParty(entry.code) : undefined}
      className="stage-calrow w-full text-left flex items-center !border-purple-500/35 bg-purple-600/[0.07]"
      title={`Open the watch-party lobby (code ${entry.code})`}
    >
      <span className="w-[44px] h-[44px] rounded-md flex-shrink-0 bg-purple-600/20 border border-purple-500/40 flex items-center justify-center" aria-hidden="true">
        <Icon name="play" size={16} className="text-purple-200" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2.5 flex-wrap">
          <span className="stage-eptag !bg-purple-500/20 !text-purple-100">Watch party</span>
          <span className="text-white text-sm font-semibold min-w-0 truncate">{entry.title}</span>
        </span>
        <span className="block text-white/50 text-xs mt-1">{sub}</span>
      </span>
      {onJoinParty && (
        <span className="flex-none px-3 py-1.5 rounded-lg bg-purple-600/25 border border-purple-500/50 text-purple-100 text-xs font-medium">
          Open lobby
        </span>
      )}
    </button>
  )
}

function EpisodeRow({ ep, onOpenMedia }: { ep: UpcomingEpisode; onOpenMedia: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpenMedia(ep.media_item_id)}
      className="stage-calrow w-full text-left flex"
    >
      {/* 44×66, down from 60×90. The mockup's row has no poster at all — it is
          a single 38px line — but dropping the art entirely loses the only
          visual anchor for "which show is this". Shrinking it keeps the row
          near the mockup's height while the poster still reads. */}
      <div className="w-[44px] h-[66px] rounded-md overflow-hidden flex-shrink-0 bg-[#12101c]">
        {ep.poster_path ? (
          <img
            src={posterURL(ep.poster_path, 'w185')}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="stage-eptag">S{ep.season_number}E{ep.episode_number}</span>
          <h3 className="text-white text-sm font-semibold min-w-0 truncate">{ep.show_title}</h3>
          {ep.episode_title && (
            // Em-dash lead-in, matching the mockup's "— The Undertow": the
            // episode title reads as a continuation of the show title rather
            // than as a second, competing heading.
            <span className="text-white/60 text-[11.5px] min-w-0 truncate">— {ep.episode_title}</span>
          )}
        </div>
        {ep.overview && (
          <p className="text-white/50 text-xs line-clamp-1 mt-1">{ep.overview}</p>
        )}
      </div>
    </button>
  )
}

// ─────────────────────── Grid View ───────────────────────

// Audit L2 fix (Phase 8) — locale-aware first-day-of-week. Sun-first
// is conventional in US/CA/JP/IL/MX; Mon-first is the ISO 8601
// default used across most of Europe + Asia. We probe
// `Intl.Locale#getWeekInfo` (Chrome 130+, Safari 17+) and fall back
// to a small hardcoded country list for older browsers.
//
// Returns 0-6 where 0=Sunday, 6=Saturday. Used to (a) rotate the
// weekday labels and (b) compute the grid's `leadDays`.
function firstDayOfWeek(): number {
  try {
    // The new getWeekInfo() returns `{ firstDay: 1..7 }` where 1=Mon
    // and 7=Sun (ISO convention). Convert to 0..6 (0=Sun, 6=Sat).
    type WeekInfoLocale = Intl.Locale & { getWeekInfo?: () => { firstDay: number } }
    const loc = new Intl.Locale(navigator.language) as WeekInfoLocale
    if (typeof loc.getWeekInfo === 'function') {
      const info = loc.getWeekInfo()
      if (info && typeof info.firstDay === 'number') {
        return info.firstDay === 7 ? 0 : info.firstDay
      }
    }
  } catch { /* fall through to country-list fallback */ }
  // Hardcoded fallback for browsers without getWeekInfo. List
  // covers the major Sun-first locales per CLDR; everywhere else
  // gets Mon-first (ISO default). Extended for L2 round 2 to
  // include Latin-America-major, South-Africa, Kenya, and the
  // Oceania pair so the fallback doesn't mis-render for those
  // users on Chrome <130 / Safari <17. The modern API path is
  // still the source of truth — this is just the safety net.
  const sundayFirst = [
    'US', 'CA', 'JP', 'IL', 'MX', 'PH', 'BR',
    'AR', 'AU', 'NZ', 'ZA', 'KE', 'CO', 'VE', 'CL', 'PE', 'HN', 'GT',
  ]
  try {
    const region = new Intl.Locale(navigator.language).region
    if (region && sundayFirst.includes(region)) return 0
  } catch { /* defensive */ }
  return 1 // Monday
}

const ALL_DAYS_SUN_FIRST = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Rotate the labels so the start-of-week label is first.
function weekdayLabels(startDay: number): string[] {
  return [...ALL_DAYS_SUN_FIRST.slice(startDay), ...ALL_DAYS_SUN_FIRST.slice(0, startDay)]
}

// Locale value is stable per session; compute once at module load.
// `navigator` is available in the browser; if this module is ever
// SSR-imported the access would throw — the try/catch in
// firstDayOfWeek already handles that.
const FIRST_DAY_OF_WEEK = firstDayOfWeek()
const WEEKDAY_LABELS_ROTATED = weekdayLabels(FIRST_DAY_OF_WEEK)

// gridLeadDays / gridTrailDays — how many days to pad before/after
// the month so the visible grid is a complete week-aligned
// rectangle. `F` is the locale's first-day-of-week (0=Sun, 1=Mon).
//   leadDays = (monthStartDay - F + 7) % 7
//   trailDays = (F + 6 - monthEndDay) % 7
// At F=0 these reduce to the original `getUTCDay()` / `6 -
// getUTCDay()` formulas; at F=1 they correctly shift to Mon-first.
function gridLeadDays(monthStart: Date): number {
  return (monthStart.getUTCDay() - FIRST_DAY_OF_WEEK + 7) % 7
}
function gridTrailDays(monthEnd: Date): number {
  return (FIRST_DAY_OF_WEEK + 6 - monthEnd.getUTCDay()) % 7
}

function GridView({
  cursorMonth, setCursorMonth, groups, partyGroups, selectedDay, setSelectedDay, onOpenMedia, onJoinParty,
}: {
  cursorMonth: Date
  // Audit H4 fix (Phase 8) — accept React's full Dispatch shape so
  // we can use functional updaters in goPrev/goNext. The previous
  // `(d: Date) => void` signature ruled out `setCursorMonth(prev =>
  // ...)`, which meant rapid arrow-clicks coalesced (both writes
  // computed `cursorMonth+1` from the same captured value and only
  // one month advanced per render). Functional form reads the
  // latest queued state, so consecutive synchronous clicks chain
  // correctly: click → +1, click → +2, click → +3.
  setCursorMonth: Dispatch<SetStateAction<Date>>
  groups: Map<string, UpcomingEpisode[]>
  partyGroups: Map<string, PartyCalEntry[]>
  selectedDay: string | null
  setSelectedDay: Dispatch<SetStateAction<string | null>>
  onOpenMedia: (id: number) => void
  onJoinParty?: (code: string) => void
}) {
  // Build the 7×N grid of UTC dates. Leads with the locale's
  // first-of-week on/before the 1st of cursorMonth; trails with
  // enough days to complete the last row. Total = always a multiple
  // of 7 (typically 35 or 42). Audit L2 — `gridLeadDays` /
  // `gridTrailDays` respect locale week-start (Sun-first in US/CA/JP,
  // Mon-first in Europe + ISO default).
  const grid = useMemo(() => {
    const monthStart = firstOfMonthUTC(cursorMonth)
    const monthEnd = lastOfMonthUTC(cursorMonth)
    const leadDays = gridLeadDays(monthStart)
    const trailDays = gridTrailDays(monthEnd)
    const totalDays = leadDays + monthEnd.getUTCDate() + trailDays
    const cells: Date[] = []
    const gridStart = new Date(monthStart.getTime() - leadDays * 86_400_000)
    for (let i = 0; i < totalDays; i++) {
      cells.push(new Date(gridStart.getTime() + i * 86_400_000))
    }
    return cells
  }, [cursorMonth])

  const today = todayUTC()
  const todayISO = toISODate(today)
  const currentMonthIdx = cursorMonth.getUTCMonth()
  const monthLabel = cursorMonth.toLocaleDateString(undefined, {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  })

  // Audit H4 fix — functional updaters read the latest queued
  // state, so consecutive rapid clicks chain correctly.
  const goPrev = () => {
    setCursorMonth(prev => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 1, 1)))
    setSelectedDay(null)
  }
  const goNext = () => {
    setCursorMonth(prev => new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1)))
    setSelectedDay(null)
  }
  const goToday = () => {
    setCursorMonth(firstOfMonthUTC(today))
    setSelectedDay(null)
  }

  const selectedEpisodes = selectedDay ? (groups.get(selectedDay) ?? []) : []
  const selectedParties = selectedDay ? (partyGroups.get(selectedDay) ?? []) : []

  return (
    <div className="space-y-6">
      {/* Month nav */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Real chevron icons, not the ‹ › single-guillemets these were.
              Those are punctuation characters — they render at text weight,
              sit off-centre in a 36px box, and a screen reader announces the
              literal glyph. The icons match every other nav control in the
              app and the aria-labels stay. */}
          <button
            type="button"
            onClick={goPrev}
            className="stage-iconbtn"
            aria-label="Previous month"
            title="Previous month"
          >
            <Icon name="chevronLeft" size={16} />
          </button>
          <h2 className="text-white font-display font-bold type-section min-w-[9.5ch] text-center whitespace-nowrap">{monthLabel}</h2>
          <button
            type="button"
            onClick={goNext}
            className="stage-iconbtn"
            aria-label="Next month"
            title="Next month"
          >
            <Icon name="chevronRight" size={16} />
          </button>
        </div>
        <button type="button" onClick={goToday} className="stage-btn stage-btn-sm stage-btn-ghost">
          Today
        </button>
      </div>

      {/* Weekday header — rotated so the first column matches the
          locale's first-day-of-week (Sun-first in US, Mon-first in
          ISO/Europe). Audit L2. */}
      <div className="stage-calmonth grid text-center">
        {WEEKDAY_LABELS_ROTATED.map((label) => (
          <div key={label} className="text-white/60 text-[9.5px] font-bold uppercase tracking-wider py-1">
            {label}
          </div>
        ))}
      </div>

      {/* Day grid. .stage-calmonth carries the 7-column template + 4px gap so
          the header row above and the cells below can never disagree about
          column widths — they did before, at gap-2 each, which is only
          coincidentally consistent. */}
      <div className="stage-calmonth grid !mt-2">
        {grid.map((cell) => {
          const cellISO = toISODate(cell)
          const cellEpisodes = groups.get(cellISO) ?? []
          const cellParties = partyGroups.get(cellISO) ?? []
          const inMonth = cell.getUTCMonth() === currentMonthIdx
          const isToday = cellISO === todayISO
          const isSelected = cellISO === selectedDay
          const hasEpisodes = cellEpisodes.length > 0
          return (
            <button
              key={cellISO}
              type="button"
              onClick={() => setSelectedDay(isSelected ? null : cellISO)}
              // Order matters: -today then -sel, so a selected today gets the
              // selection ring rather than the (identically-specific) today
              // ring. Both are single classes at 0,1,0, so this is source
              // order in index.css doing the work — -sel is declared after
              // -today there for exactly this reason. (Hover is a separate
              // axis: `.stage-calcell:hover` at 0,2,0 would have beaten BOTH
              // regardless of order, which is why that rule now excludes the
              // two state classes.)
              className={[
                'stage-calcell text-left',
                isToday && 'stage-calcell-today',
                isSelected && 'stage-calcell-sel',
                !inMonth && 'stage-calcell-dim',
              ].filter(Boolean).join(' ')}
              // aria-expanded + aria-controls, NOT aria-pressed. Activating a
              // cell reveals the day's episode panel below the grid, so this is
              // a disclosure, not a toggle button — and `pressed` on 42 cells
              // told a screen reader it was looking at 42 independent toggles.
              // aria-controls also gives a way to reach the panel, which
              // otherwise appears below all 42 cells with nothing announced.
              aria-expanded={isSelected}
              aria-controls={isSelected ? 'cal-day-panel' : undefined}
              aria-label={`${cell.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}${hasEpisodes ? `, ${cellEpisodes.length} episode${cellEpisodes.length === 1 ? '' : 's'}` : ''}${cellParties.length > 0 ? `, ${cellParties.length} watch part${cellParties.length === 1 ? 'y' : 'ies'}` : ''}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[12.5px] font-semibold">{cell.getUTCDate()}</span>
                {/* Count covers episodes + parties: below sm the chips are
                    hidden, so this badge is the ONLY visible signal a day
                    has anything — a party-only day must not render blank
                    on a phone (2026-08 review). */}
                {(hasEpisodes || cellParties.length > 0) && (
                  <span className="text-[9.5px] text-purple-200 font-bold">{cellEpisodes.length + cellParties.length}</span>
                )}
              </div>
              {/* Episode chips — up to 3, then "+N more".
                  Hidden below sm. Seven columns in a 339px content box (375px
                  viewport minus .stage-page's 18px gutters) is a 45px column,
                  which after the cell's border+padding and the chip's own
                  padding leaves a 21px text box — about three glyphs at 9px, so
                  every chip rendered as "S1E…" and carried no information at
                  all. The count badge above stays visible at every width and is
                  the honest signal there; tapping the day opens the panel with
                  the full titles. */}
              <div className="space-y-1 hidden sm:block">
                {/* Watch-party chips lead — a booked party is the day's
                    headline event, and there is at most one or two. */}
                {cellParties.slice(0, 2).map(p => (
                  <div
                    key={p.code}
                    className="stage-calchip stage-calchip-p block !border-purple-400/60"
                    title={`Watch party — ${p.title} · ${partyClock(p.startIso)}`}
                  >
                    ▶ {partyClock(p.startIso)} {p.title}
                  </div>
                ))}
                {cellEpisodes.slice(0, cellParties.length > 0 ? 2 : 3).map((ep, i) => (
                  <div
                    key={`${ep.media_item_id}-${ep.episode_id}`}
                    // .stage-calchip-p (purple) on the first chip only, so a
                    // day with several airings still reads as one day rather
                    // than a solid purple block — the mockup alternates the
                    // two fills for the same reason. When a party chip is
                    // already carrying the purple, episodes all stay neutral.
                    className={`stage-calchip block ${i === 0 && cellParties.length === 0 ? 'stage-calchip-p' : ''}`}
                    title={`S${ep.season_number}E${ep.episode_number} ${ep.show_title}${ep.episode_title ? ' — ' + ep.episode_title : ''}`}
                  >
                    S{ep.season_number}E{ep.episode_number} {ep.show_title}
                  </div>
                ))}
                {(() => {
                  const shown = Math.min(cellEpisodes.length, cellParties.length > 0 ? 2 : 3)
                  const hidden = cellEpisodes.length - shown + Math.max(0, cellParties.length - 2)
                  return hidden > 0 ? (
                    <div className="text-[9.5px] text-white/55 pl-1">
                      +{hidden} more
                    </div>
                  ) : null
                })()}
              </div>
            </button>
          )
        })}
      </div>

      {/* Selected-day expand panel. The id is the target of the selected
          cell's aria-controls; role="region" + aria-label so it is reachable as
          a landmark rather than only by tabbing past every remaining cell. */}
      {selectedDay && (selectedEpisodes.length > 0 || selectedParties.length > 0) && (
        <section
          id="cal-day-panel"
          role="region"
          aria-label={`Events on ${formatGroupDate(`${selectedDay}T00:00:00Z`)}`}
          className="pt-4 border-t border-white/[0.06]"
        >
          <h3 className="text-white/85 text-lg font-semibold mb-4">
            {formatGroupDate(`${selectedDay}T00:00:00Z`)}
          </h3>
          <div className="space-y-2">
            {selectedParties.map(p => (
              <PartyCalRow key={p.code} entry={p} onJoinParty={onJoinParty} />
            ))}
            {selectedEpisodes.map((ep) => (
              <EpisodeRow key={`${ep.media_item_id}-${ep.episode_id}`} ep={ep} onOpenMedia={onOpenMedia} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
