// Watching statistics and achievements, on the profile page: level and
// points, this week, the streak, the genre finished most, and every
// achievement, earned or still to go.

import { useEffect, useState } from 'react'
import { getGamificationStats, type GamificationStats } from '@/lib/api'

/** How far through the CURRENT level the points are, as a percentage. Both
 *  ends of the level are used (the points it starts and ends at), so the bar
 *  shows progress through this level's slice and not the share of all points
 *  ever needed: at level 3 with 350 points, a level running 300 to 600, that
 *  is 50 of 300, about 17%, not 58%. */
export function levelProgressPct(xp: { xp: number; prev_level_total?: number; next_level_total?: number }): number {
  const prev = xp.prev_level_total ?? 0
  const next = xp.next_level_total ?? 0
  const slice = Math.max(1, next - prev)
  return Math.min(100, Math.max(0, ((xp.xp - prev) / slice) * 100))
}

/** Minutes finished this week as hours: one decimal under ten, whole above. */
export function weekHours(minutes: number | undefined): string | null {
  if (minutes == null) return null
  if (minutes === 0) return '0'
  return minutes >= 600 ? String(Math.round(minutes / 60)) : (minutes / 60).toFixed(1)
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-2">{label}</dt>
      <dd className="mt-0.5 text-[17px] font-semibold tabular-nums text-ink">
        {value}
        {note && <span className="ml-2 text-[13px] font-normal text-ink-2">{note}</span>}
      </dd>
    </div>
  )
}

export function GamificationCard() {
  const [stats, setStats] = useState<GamificationStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    getGamificationStats(ac.signal)
      .then(s => { if (!cancelled) setStats(s) })
      .catch(e => {
        if (!cancelled && e.name !== 'AbortError') setError('Your progress could not be loaded.')
      })
    return () => { cancelled = true; ac.abort() }
  }, [])

  if (error) return <p role="alert" className="text-[14px] text-danger-ink">{error}</p>
  if (!stats) return <p className="text-[14px] text-ink-2">Loading…</p>

  const { xp, unlocked, achievement_catalog } = stats
  const pct = levelProgressPct(xp)
  const unlockedKeys = new Set(unlocked.map(u => u.achievement_key))
  const hours = weekHours(stats.minutes_this_week)

  return (
    <div>
      <div className="rounded-control bg-surface-raised p-5">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <p>
            <span className="block text-xs text-ink-2">Level</span>
            <span className="block font-display text-[40px] font-bold leading-none tabular-nums text-ink">{xp.level}</span>
          </p>
          <div className="min-w-0 flex-1 basis-[14rem]">
            <p className="flex justify-between gap-4 text-[13px] tabular-nums text-ink-2">
              <span>{xp.xp.toLocaleString()} points</span>
              {xp.next_level_total ? <span>{(xp.xp_to_next_level || 0).toLocaleString()} to level {xp.level + 1}</span> : null}
            </p>
            <div
              role="progressbar"
              aria-label={`Progress through level ${xp.level}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--track)]"
            >
              <div className="h-full bg-action motion-safe:transition-[width] motion-safe:duration-700" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
        <dl className="mt-5 grid gap-x-6 gap-y-4 [grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr))]">
          <Stat label="Finished" value={`${xp.total_watches.toLocaleString()} ${xp.total_watches === 1 ? 'title' : 'titles'}`} />
          {(hours !== null || stats.titles_this_week != null) && (
            <Stat
              label="This week"
              value={`${stats.titles_this_week ?? 0} finished`}
              note={hours !== null ? `${hours} ${hours === '1.0' ? 'hour' : 'hours'}` : undefined}
            />
          )}
          <Stat
            label="Streak"
            value={`${xp.current_streak} ${xp.current_streak === 1 ? 'day' : 'days'}`}
            note={`longest ${xp.longest_streak}`}
          />
          {stats.top_genre ? <Stat label="Finished most" value={stats.top_genre} /> : null}
          <Stat label="Achievements" value={`${unlocked.length} of ${achievement_catalog.length}`} />
        </dl>
        {/* Said, because Continue Watching can hold several titles while
            this number reads 0, and that looks like a counter gone wrong. */}
        <p className="mt-4 text-[13px] leading-snug text-ink-2">
          A title counts as finished once it is watched to 90% of its length, so what is still in Continue Watching is not in these numbers.
        </p>
      </div>

      {achievement_catalog.length > 0 && (
        <>
          <h3 className="mb-3 mt-6 font-display text-[17px] font-semibold text-ink">Achievements</h3>
          <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr))]">
            {achievement_catalog.map(a => {
              const earned = unlockedKeys.has(a.key)
              return (
                <li key={a.key} className={`rounded-control border p-4 ${earned ? 'border-line-strong bg-surface-raised' : 'border-line'}`}>
                  <p className="flex items-start gap-3">
                    <span aria-hidden="true" className={`flex-none text-[24px] leading-none ${earned ? '' : 'opacity-50 grayscale'}`}>{a.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold text-ink">{a.title}</span>
                      <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">{a.description}</span>
                      <span className="mt-1.5 block text-xs tabular-nums text-ink-3">
                        {earned ? 'Earned' : 'Not yet'} · {a.xp_reward} points
                      </span>
                    </span>
                  </p>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
