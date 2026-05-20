package api

import (
	"context"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// Phase 6 — Gamification engine + HTTP handler.
//
// XP grants happen as a side-effect of "watch completed" events
// (the progress handler calls GamificationEngine.AwardForWatch).
// Level is computed from XP via the leveling table below; streak
// counts distinct UTC watch days. Achievements unlock when their
// rule fires — checked after every XP grant.
//
// Definitions (display name, icon, threshold) live here in code
// rather than the DB so adding/editing achievements doesn't require
// a migration. Frontend pulls definitions via GET /api/me/achievements.

// XP per completion. Episodes and movies grant the same amount —
// it's the act of finishing that matters. Tunable; keep round.
const xpPerWatch = 50

// Leveling table — XP threshold to ENTER each level. Generous early,
// steeper later. Level N requires sum of thresholds[1..N].
// Levels beyond the table extrapolate quadratically.
var levelThresholds = []int{
	0,    // L1 — every user starts here
	100,  // L2
	300,  // L3
	600,  // L4
	1000, // L5
	1500, // L6
	2200, // L7
	3000, // L8
	4000, // L9
	5200, // L10
}

// AchievementDef is a static definition. Rules are checked
// imperatively in checkAchievements below — keeping them in code
// (vs. a generic "rule_json" column) lets us write complex rules
// like "watched 5 movies in 24h" without a DSL.
type AchievementDef struct {
	Key         string `json:"key"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Icon        string `json:"icon"` // emoji or icon name
	XPReward    int    `json:"xp_reward"`
	Hidden      bool   `json:"hidden,omitempty"` // surprise reveals
}

var achievementDefs = []AchievementDef{
	{Key: "first_watch", Title: "First Steps", Description: "Finish your first watch.", Icon: "🎬", XPReward: 25},
	{Key: "movie_marathon_5", Title: "Movie Marathon", Description: "Finish 5 movies.", Icon: "🍿", XPReward: 100},
	{Key: "movie_marathon_25", Title: "Marathon Master", Description: "Finish 25 movies.", Icon: "🏆", XPReward: 300},
	{Key: "streak_3", Title: "On a Roll", Description: "Watch 3 days in a row.", Icon: "🔥", XPReward: 75},
	{Key: "streak_7", Title: "Week Warrior", Description: "Watch 7 days in a row.", Icon: "⚡", XPReward: 200},
	{Key: "streak_30", Title: "Unstoppable", Description: "Watch 30 days in a row.", Icon: "🌟", XPReward: 750},
	{Key: "level_5", Title: "Rising Star", Description: "Reach level 5.", Icon: "✨", XPReward: 100},
	{Key: "level_10", Title: "Aurora Legend", Description: "Reach level 10.", Icon: "👑", XPReward: 500},
	{Key: "night_owl", Title: "Night Owl", Description: "Finish a watch between midnight and 4am.", Icon: "🦉", XPReward: 50, Hidden: true},
}

// GamificationEngine is the side-effect surface called by other
// handlers (progress) when a watch completes.
type GamificationEngine struct {
	queries *db.Queries
}

func NewGamificationEngine(queries *db.Queries) *GamificationEngine {
	return &GamificationEngine{queries: queries}
}

// AwardForWatch grants XP for a completed watch, updates streak,
// recomputes level, and checks for newly-unlocked achievements.
// Best-effort — errors are logged but don't propagate (a failure
// here shouldn't break the underlying watch-progress update).
//
// Returns the FULL definitions of newly-unlocked achievements (not
// just keys) so the caller can render a toast with icon + title
// without a second roundtrip. Audit M5 fix — was previously []string
// which forced the frontend to display raw keys like "first_watch"
// instead of "🎬 First Steps".
func (g *GamificationEngine) AwardForWatch(ctx context.Context, userID int64, when time.Time) []AchievementDef {
	// 2026-05-19 audit (API-H4) — atomic SQL increment replaces the
	// previous read-modify-write pattern. Two concurrent MarkWatched
	// calls (multi-device replay) used to last-write-wins one of the
	// XP grants and silently corrupt streaks. The new query does the
	// streak math in a CASE expression under a single row lock.
	prevX, err := g.queries.GetUserXP(ctx, userID)
	if err != nil {
		slog.Warn("gamification: get user_xp failed", "user", userID, "error", err)
		return nil
	}
	prevLevel := prevX.Level

	today := db.TouchDate()
	x, err := g.queries.IncrementUserXPForWatch(ctx, userID, xpPerWatch, today)
	if err != nil {
		slog.Warn("gamification: increment user_xp failed", "user", userID, "error", err)
		return nil
	}
	// 2026-05-19 re-audit follow-up (API-H4) — race-safe level sync.
	// EnsureLevelAtLeast does a targeted GREATEST update; full-row
	// UpsertUserXP would clobber concurrent in-flight increments
	// (their atomic IncrementUserXPForWatch lands, then our stale
	// snapshot's UpsertUserXP overwrites their xp). Levels are
	// monotone with XP so GREATEST is the right combinator.
	x.Level = computeLevel(x.XP)
	if err := g.queries.EnsureLevelAtLeast(ctx, userID, x.Level); err != nil {
		slog.Warn("gamification: persist level after increment failed", "user", userID, "error", err)
		// Continue — the XP delta already landed atomically; level
		// will sync on the next watch.
	}

	// Achievement checks. Use a helper closure for "try to unlock";
	// it accumulates full defs (for toast rendering) + grants the
	// bonus XP for each.
	unlocked := []AchievementDef{}
	tryUnlock := func(key string) {
		ok, err := g.queries.UnlockAchievement(ctx, userID, key)
		if err != nil {
			slog.Warn("gamification: unlock failed", "user", userID, "key", key, "error", err)
			return
		}
		if !ok {
			return // user already had it
		}
		def := findAchievement(key)
		if def != nil {
			unlocked = append(unlocked, *def)
			// Grant the achievement's bonus XP. Audit H3 fix:
			// LEVEL achievements are evaluated AFTER all non-level
			// unlocks settle (phase 2 below), so bonus XP from
			// non-level achievements can push the user past a level
			// boundary and still trigger level_5/level_10.
			//
			// 2026-05-19 re-audit follow-up (API-H4) — atomic
			// AddBonusXP + EnsureLevelAtLeast replaces the prior
			// read-modify-write UpsertUserXP. The bonus delta lands
			// atomically; level is pulled up monotonically via
			// GREATEST. Local x.XP and x.Level are kept in sync for
			// the phase-2 milestone checks below.
			if def.XPReward > 0 {
				newXP, addErr := g.queries.AddBonusXP(ctx, userID, def.XPReward)
				if addErr != nil {
					slog.Warn("gamification: bonus xp grant failed", "user", userID, "key", key, "error", addErr)
				} else {
					x.XP = newXP
					x.Level = computeLevel(x.XP)
					if lerr := g.queries.EnsureLevelAtLeast(ctx, userID, x.Level); lerr != nil {
						slog.Warn("gamification: level sync after bonus failed", "user", userID, "key", key, "error", lerr)
					}
				}
			}
		}
	}

	// Audit H3 fix — split achievement checks into TWO phases so
	// level-milestone unlocks can react to bonus XP from non-level
	// achievements (e.g. movie_marathon_25's +300 XP pushing the
	// user across an L4→L5 boundary on the same watch).
	//
	// Phase 1: non-level achievements. Each unlock may grant bonus
	// XP via tryUnlock → findAchievement → x.XP += XPReward.
	if x.TotalWatches == 1 {
		tryUnlock("first_watch")
	}
	if x.TotalWatches >= 5 {
		tryUnlock("movie_marathon_5")
	}
	if x.TotalWatches >= 25 {
		tryUnlock("movie_marathon_25")
	}
	if x.CurrentStreak >= 3 {
		tryUnlock("streak_3")
	}
	if x.CurrentStreak >= 7 {
		tryUnlock("streak_7")
	}
	if x.CurrentStreak >= 30 {
		tryUnlock("streak_30")
	}
	if when.Hour() < 4 {
		tryUnlock("night_owl")
	}

	// Phase 2: re-derive level from the now-bonused XP, then check
	// level milestones. The level itself may have advanced multiple
	// notches via the bonus XP — we still anchor against prevLevel
	// (snapshotted at the top of AwardForWatch) so each milestone
	// fires exactly once regardless of the trajectory.
	//
	// 2026-05-19 re-audit follow-up (API-H4) — race-safe sync via
	// EnsureLevelAtLeast. UpsertUserXP would write the whole row
	// including streak fields that may have been advanced by a
	// concurrent in-flight increment.
	x.Level = computeLevel(x.XP)
	if x.Level != prevLevel {
		if lerr := g.queries.EnsureLevelAtLeast(ctx, userID, x.Level); lerr != nil {
			slog.Warn("gamification: phase-2 level sync failed", "user", userID, "error", lerr)
		}
	}
	if x.Level >= 5 && prevLevel < 5 {
		tryUnlock("level_5")
	}
	if x.Level >= 10 && prevLevel < 10 {
		tryUnlock("level_10")
	}

	return unlocked
}

// computeLevel maps XP → level using the static table, with a
// quadratic extrapolation beyond L10 so the curve never plateaus.
func computeLevel(xp int) int {
	for i := len(levelThresholds) - 1; i >= 0; i-- {
		if xp >= levelThresholds[i] {
			return i + 1
		}
	}
	return 1
}

// xpToNextLevel returns (xp_needed_into_next, total_xp_at_next,
// total_xp_at_start_of_current_level). The third return is what
// the H1 audit fix needed — the client can now render an accurate
// progress bar via `(xp - prev) / (next - prev)`.
func xpToNextLevel(xp, level int) (int, int, int) {
	// Previous-level threshold: 0 for L1, else the table value at
	// (level-1)-1 = level-1 index. (Table is 0-indexed, level 1 is
	// at index 0.)
	var prev int
	if level <= 1 {
		prev = 0
	} else if level-1 < len(levelThresholds) {
		prev = levelThresholds[level-1]
	} else {
		// User is in the quadratic-extrapolation zone past the
		// static table. prev = last static threshold + (level-1 - lastTableLevel) * 1500.
		lastTableLevel := len(levelThresholds)
		prev = levelThresholds[len(levelThresholds)-1] +
			(level-1-lastTableLevel)*1500
	}
	if level >= len(levelThresholds) {
		// Quadratic extrapolation: each level beyond L10 adds 1500 XP.
		next := levelThresholds[len(levelThresholds)-1] +
			(level-len(levelThresholds)+1)*1500
		return next - xp, next, prev
	}
	next := levelThresholds[level]
	return next - xp, next, prev
}

func findAchievement(key string) *AchievementDef {
	for i := range achievementDefs {
		if achievementDefs[i].Key == key {
			return &achievementDefs[i]
		}
	}
	return nil
}

// ─────────────────────────── HTTP Handler ───────────────────────────

type GamificationHandler struct {
	queries *db.Queries
}

func NewGamificationHandler(queries *db.Queries) *GamificationHandler {
	return &GamificationHandler{queries: queries}
}

// Stats returns the caller's XP, level, streak, plus unlocked
// achievement keys + the full definition catalog (so the frontend
// can render locked + unlocked side-by-side without two requests).
func (h *GamificationHandler) Stats(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	x, err := h.queries.GetUserXP(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load XP")
		return
	}
	toNext, nextTotal, prevTotal := xpToNextLevel(x.XP, x.Level)
	x.XPToNextLevel = toNext
	x.NextLevelTotal = nextTotal
	x.PrevLevelTotal = prevTotal

	unlocked, err := h.queries.ListUserAchievements(r.Context(), claims.UserID)
	if err != nil {
		slog.Warn("gamification stats: list achievements failed", "error", err)
		// Non-fatal — return XP without unlocks rather than 500.
		unlocked = nil
	}

	// Defs sorted by XPReward asc so the easiest-to-unlock surface
	// first in the UI. Hidden achievements get filtered out unless
	// already unlocked (preserves the "surprise reveal" UX).
	defs := make([]AchievementDef, 0, len(achievementDefs))
	unlockedSet := map[string]bool{}
	for _, u := range unlocked {
		unlockedSet[u.AchievementKey] = true
	}
	for _, d := range achievementDefs {
		if d.Hidden && !unlockedSet[d.Key] {
			continue
		}
		defs = append(defs, d)
	}
	sort.SliceStable(defs, func(i, j int) bool {
		return defs[i].XPReward < defs[j].XPReward
	})

	if unlocked == nil {
		unlocked = []*models.UserAchievement{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"xp":                  x,
		"unlocked":            unlocked,
		"achievement_catalog": defs,
	})
}
