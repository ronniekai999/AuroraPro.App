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
import { getCalendar, posterURL, type UpcomingEpisode } from '@/lib/api'

interface Props {
  onOpenMedia: (id: number) => void
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
function formatGroupDate(iso: string): string {
  const datePart = iso.length >= 10 ? iso.slice(0, 10) : iso
  const d = new Date(`${datePart}T00:00:00Z`)
  const today = todayUTC()
  const diffDays = Math.round((d.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  const weekday = d.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })
  const monthDay = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (diffDays === 0) return `Today · ${monthDay}`
  if (diffDays === 1) return `Tomorrow · ${monthDay}`
  if (diffDays > 1 && diffDays < 7) return `${weekday} · ${monthDay}`
  return `${weekday}, ${monthDay}`
}

export function CalendarView({ onOpenMedia }: Props) {
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

  if (error) return <p className="text-red-300 p-8">{error}</p>

  // Group episodes by UTC date key (YYYY-MM-DD) — used by both views.
  const groups = useMemoGroups(episodes)

  return (
    <div className="animate-fade-in">
      <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 mb-3">
            <span className="text-purple-200 text-xs font-medium uppercase tracking-wider">
              {viewMode === 'list' ? 'Upcoming' : 'Month View'}
            </span>
          </div>
          <h1 className="text-white text-4xl font-bold font-display">Calendar</h1>
          {episodes && (
            <p className="text-white/60 text-sm mt-2">
              {viewMode === 'list'
                ? (episodes.length === 0
                  ? 'No upcoming episodes from shows in your library.'
                  : `${episodes.length} episode${episodes.length === 1 ? '' : 's'} airing in the next ${LIST_WINDOW_DAYS} days.`)
                : `${episodes.length} episode${episodes.length === 1 ? '' : 's'} airing in ${cursorMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })}.`}
            </p>
          )}
        </div>

        {/* View-mode toggle */}
        <div className="inline-flex rounded-full bg-white/[0.04] border border-white/[0.06] p-1">
          <button
            onClick={() => setViewMode('list')}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              viewMode === 'list'
                ? 'bg-purple-500/30 text-purple-100'
                : 'text-white/60 hover:text-white/85'
            }`}
            aria-pressed={viewMode === 'list'}
          >
            List
          </button>
          <button
            onClick={() => setViewMode('grid')}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              viewMode === 'grid'
                ? 'bg-purple-500/30 text-purple-100'
                : 'text-white/60 hover:text-white/85'
            }`}
            aria-pressed={viewMode === 'grid'}
          >
            Calendar
          </button>
        </div>
      </div>

      {episodes === null ? (
        <p className="text-white/40">Loading calendar…</p>
      ) : viewMode === 'list' ? (
        <ListView
          episodes={episodes}
          groups={groups}
          onOpenMedia={onOpenMedia}
        />
      ) : (
        <GridView
          cursorMonth={cursorMonth}
          setCursorMonth={setCursorMonth}
          groups={groups}
          selectedDay={selectedDay}
          setSelectedDay={setSelectedDay}
          onOpenMedia={onOpenMedia}
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
  episodes, groups, onOpenMedia,
}: {
  episodes: UpcomingEpisode[]
  groups: Map<string, UpcomingEpisode[]>
  onOpenMedia: (id: number) => void
}) {
  if (episodes.length === 0) {
    return (
      <div className="text-center py-20">
        <p className="text-white/60 text-lg">Nothing scheduled.</p>
        <p className="text-white/40 text-sm mt-2 max-w-md mx-auto">
          Once you add TV shows to your library, upcoming episodes will appear here based on their TMDB air dates.
        </p>
      </div>
    )
  }
  const orderedKeys = [...groups.keys()].sort()
  return (
    <div className="space-y-8">
      {orderedKeys.map((key) => (
        <section key={key}>
          <h2 className="text-white/85 text-lg font-semibold mb-4">
            {formatGroupDate(groups.get(key)![0].air_date)}
          </h2>
          <div className="space-y-2">
            {groups.get(key)!.map((ep) => (
              <EpisodeRow key={`${ep.media_item_id}-${ep.episode_id}`} ep={ep} onOpenMedia={onOpenMedia} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function EpisodeRow({ ep, onOpenMedia }: { ep: UpcomingEpisode; onOpenMedia: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpenMedia(ep.media_item_id)}
      className="w-full text-left flex items-center gap-4 p-3 rounded-xl bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.05] hover:border-purple-500/30 transition-all"
    >
      <div className="w-[60px] h-[90px] rounded-lg overflow-hidden flex-shrink-0 bg-white/5">
        {ep.poster_path ? (
          <img
            src={posterURL(ep.poster_path, 'w185')}
            alt={ep.show_title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-purple-300 text-sm font-semibold">
            S{ep.season_number}E{ep.episode_number}
          </span>
          <h3 className="text-white text-sm font-medium truncate">{ep.show_title}</h3>
        </div>
        {ep.episode_title && (
          <p className="text-white/70 text-sm truncate">{ep.episode_title}</p>
        )}
        {ep.overview && (
          <p className="text-white/40 text-xs line-clamp-1 mt-1">{ep.overview}</p>
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
  cursorMonth, setCursorMonth, groups, selectedDay, setSelectedDay, onOpenMedia,
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
  selectedDay: string | null
  setSelectedDay: Dispatch<SetStateAction<string | null>>
  onOpenMedia: (id: number) => void
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

  return (
    <div className="space-y-6">
      {/* Month nav */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={goPrev}
            className="w-9 h-9 inline-flex items-center justify-center rounded-full hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            aria-label="Previous month"
            title="Previous month"
          >
            ‹
          </button>
          <h2 className="text-white text-xl font-semibold font-display">{monthLabel}</h2>
          <button
            onClick={goNext}
            className="w-9 h-9 inline-flex items-center justify-center rounded-full hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            aria-label="Next month"
            title="Next month"
          >
            ›
          </button>
        </div>
        <button
          onClick={goToday}
          className="px-4 py-1.5 rounded-full text-sm font-medium bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-white/85 transition-colors"
        >
          Today
        </button>
      </div>

      {/* Weekday header — rotated so the first column matches the
          locale's first-day-of-week (Sun-first in US, Mon-first in
          ISO/Europe). Audit L2. */}
      <div className="grid grid-cols-7 gap-2 text-center">
        {WEEKDAY_LABELS_ROTATED.map((label) => (
          <div key={label} className="text-white/40 text-xs uppercase tracking-wider py-2">
            {label}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-2">
        {grid.map((cell) => {
          const cellISO = toISODate(cell)
          const cellEpisodes = groups.get(cellISO) ?? []
          const inMonth = cell.getUTCMonth() === currentMonthIdx
          const isToday = cellISO === todayISO
          const isSelected = cellISO === selectedDay
          const hasEpisodes = cellEpisodes.length > 0
          return (
            <button
              key={cellISO}
              type="button"
              onClick={() => setSelectedDay(isSelected ? null : cellISO)}
              className={`relative min-h-[110px] p-2 rounded-lg text-left transition-all border ${
                isSelected
                  ? 'border-purple-500/70 bg-purple-500/15'
                  : isToday
                    ? 'border-purple-500/40 bg-purple-500/5 hover:bg-purple-500/10'
                    : 'border-white/[0.04] bg-white/[0.015] hover:bg-white/[0.04] hover:border-white/[0.08]'
              } ${!inMonth ? 'opacity-40' : ''}`}
              aria-label={`${cell.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })}${hasEpisodes ? `, ${cellEpisodes.length} episode${cellEpisodes.length === 1 ? '' : 's'}` : ''}`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className={`text-sm font-semibold ${
                  isToday ? 'text-purple-200' : inMonth ? 'text-white/90' : 'text-white/40'
                }`}>
                  {cell.getUTCDate()}
                </span>
                {hasEpisodes && (
                  <span className="text-[10px] text-purple-300/80 font-medium">
                    {cellEpisodes.length}
                  </span>
                )}
              </div>
              {/* Episode chips — up to 3, then "+N more". */}
              <div className="space-y-1">
                {cellEpisodes.slice(0, 3).map((ep) => (
                  <div
                    key={`${ep.media_item_id}-${ep.episode_id}`}
                    className="flex items-center gap-1 text-[10px] leading-tight text-white/80 truncate"
                    title={`S${ep.season_number}E${ep.episode_number} ${ep.show_title}${ep.episode_title ? ' — ' + ep.episode_title : ''}`}
                  >
                    {ep.poster_path && (
                      <img
                        src={posterURL(ep.poster_path, 'w92')}
                        alt=""
                        className="w-3 h-4 rounded-sm object-cover flex-shrink-0"
                        loading="lazy"
                      />
                    )}
                    <span className="truncate">
                      <span className="text-purple-300">S{ep.season_number}E{ep.episode_number}</span>{' '}
                      <span className="text-white/70">{ep.show_title}</span>
                    </span>
                  </div>
                ))}
                {cellEpisodes.length > 3 && (
                  <div className="text-[10px] text-white/50">
                    +{cellEpisodes.length - 3} more
                  </div>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Selected-day expand panel */}
      {selectedDay && selectedEpisodes.length > 0 && (
        <section className="pt-4 border-t border-white/[0.06]">
          <h3 className="text-white/85 text-lg font-semibold mb-4">
            {formatGroupDate(`${selectedDay}T00:00:00Z`)}
          </h3>
          <div className="space-y-2">
            {selectedEpisodes.map((ep) => (
              <EpisodeRow key={`${ep.media_item_id}-${ep.episode_id}`} ep={ep} onOpenMedia={onOpenMedia} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
