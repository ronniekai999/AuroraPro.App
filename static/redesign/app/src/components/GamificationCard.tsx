// Phase 6 — Gamification UI: XP card + achievements grid.
//
// Renders on the Settings/Profile area. Two pieces:
//   ProfileXPCard — current level, XP progress bar, streak flame.
//   AchievementsGrid — unlocked vs locked, sorted by xp_reward asc.

import { useEffect, useState } from 'react'
import { getGamificationStats, type GamificationStats } from '@/lib/api'

export function GamificationCard() {
  const [stats, setStats] = useState<GamificationStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    getGamificationStats(ac.signal)
      .then((s) => { if (!cancelled) setStats(s) })
      .catch((e) => {
        if (!cancelled && e.name !== 'AbortError') {
          setError(e instanceof Error ? e.message : 'Failed to load stats')
        }
      })
    return () => { cancelled = true; ac.abort() }
  }, [])

  if (error) return <p className="text-red-300 text-sm">{error}</p>
  if (!stats) return <p className="text-white/40 text-sm">Loading…</p>

  const { xp, unlocked, achievement_catalog } = stats
  // Audit H1 fix — per-level progress now uses BOTH endpoints
  // (prev_level_total + next_level_total) so the bar reflects
  // progress through THIS level's slice, not absolute XP%. For an
  // L3 user at 350 XP with prev=300 next=600, we render 50/300 =
  // 16.7%, not the misleading 58% of the old formula.
  const prevTotal = xp.prev_level_total ?? 0
  const nextTotal = xp.next_level_total ?? 0
  const slice = Math.max(1, nextTotal - prevTotal)
  const pct = Math.min(100, Math.max(0, ((xp.xp - prevTotal) / slice) * 100))
  const unlockedKeys = new Set(unlocked.map((u) => u.achievement_key))

  return (
    <div className="space-y-6">
      {/* XP Card */}
      <div className="rounded-2xl p-6 border border-purple-500/20 bg-gradient-to-br from-purple-900/30 via-[#0a0a0f] to-[#050505] relative overflow-hidden">
        <div className="absolute -top-20 -right-20 w-[300px] h-[300px] rounded-full bg-purple-500/15 blur-3xl pointer-events-none" />
        <div className="relative">
          <div className="flex items-center justify-between mb-6">
            <div>
              <p className="text-purple-200/80 text-xs uppercase tracking-wider mb-1">
                Level
              </p>
              <p className="text-white text-5xl font-bold font-display">
                {xp.level}
              </p>
            </div>
            {xp.current_streak > 0 && (
              <div className="text-right">
                <p className="text-orange-300/80 text-xs uppercase tracking-wider mb-1">
                  Streak
                </p>
                <p className="text-white text-3xl font-bold font-display">
                  🔥 {xp.current_streak}
                </p>
                <p className="text-white/40 text-xs mt-1">
                  Longest: {xp.longest_streak}
                </p>
              </div>
            )}
          </div>

          {/* XP progress bar */}
          <div>
            <div className="flex items-center justify-between text-xs text-white/60 mb-1.5">
              <span>{xp.xp.toLocaleString()} XP</span>
              {xp.next_level_total && (
                <span>
                  {(xp.xp_to_next_level || 0).toLocaleString()} XP to L{xp.level + 1}
                </span>
              )}
            </div>
            <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-purple-500 to-fuchsia-500 transition-[width] duration-700"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/[0.04]">
            <div>
              {/* QA BUG-003 — "Total watches" only increments on
                  ≥90% completion (see internal/db/queries_gamification.go
                  BumpWatchCount). Mid-watch Continue Watching items
                  don't bump it. Relabel as "Completed" so users
                  don't read 0 here while seeing 4 in-progress
                  watches on the Library page as a sync bug.
                  2026-05-25 — added tooltip so the 90% threshold
                  is discoverable. Previous QA round confused this
                  zero with a counter bug ("CW has 5 items, Completed
                  reads 0"); CW items are by definition in-progress,
                  so they're correctly excluded — but only the code
                  comment said so, the user-facing label did not. */}
              <p
                className="text-white/40 text-xs cursor-help"
                title="Counts items you've watched to ≥90% of their runtime. In-progress items in Continue Watching are excluded by design."
              >
                Completed
              </p>
              <p className="text-white/90 text-lg font-semibold">{xp.total_watches}</p>
            </div>
            <div className="text-right">
              <p className="text-white/40 text-xs">Achievements</p>
              <p className="text-white/90 text-lg font-semibold">
                {unlocked.length} / {achievement_catalog.length}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Achievements */}
      <div>
        <h3 className="text-white text-lg font-semibold mb-4">Achievements</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {achievement_catalog.map((a) => {
            const isUnlocked = unlockedKeys.has(a.key)
            return (
              <div
                key={a.key}
                className={`p-4 rounded-xl border text-center transition-ui ${
                  isUnlocked
                    ? 'bg-purple-500/10 border-purple-500/30 text-white'
                    : 'bg-white/[0.02] border-white/[0.06] text-white/40 grayscale'
                }`}
                title={a.description}
              >
                <div className="text-3xl mb-2">{a.icon}</div>
                <p className="text-sm font-medium">{a.title}</p>
                <p className="text-xs opacity-70 mt-1">{a.description}</p>
                <p className="text-[10px] uppercase tracking-wider mt-2 text-purple-300/70">
                  +{a.xp_reward} XP
                </p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
