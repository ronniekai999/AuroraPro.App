package db

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// Phase 6 — Gamification queries.
//
// Single-row-per-user pattern with lazy creation. The first XP
// grant for a new user UPSERTs the row; reads return zero-value
// when no row exists rather than erroring.

func (q *Queries) GetUserXP(ctx context.Context, userID int64) (*models.UserXP, error) {
	x := &models.UserXP{UserID: userID}
	err := q.pool.QueryRow(ctx, `
		SELECT xp, level, current_streak, longest_streak,
		       last_watch_date, total_watches
		  FROM user_xp WHERE user_id = $1
	`, userID).Scan(&x.XP, &x.Level, &x.CurrentStreak, &x.LongestStreak,
		&x.LastWatchDate, &x.TotalWatches)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Fresh user with no XP yet — return zero-value row.
			x.Level = 1
			return x, nil
		}
		return nil, fmt.Errorf("get user_xp: %w", err)
	}
	return x, nil
}

// UpsertUserXP writes the full state row. Caller computed level +
// streak from current values via the gamification engine.
//
// 2026-05-19 — most callers should prefer IncrementUserXPForWatch
// (atomic increment) over this last-write-wins setter. UpsertUserXP
// is still used for the achievement-bonus XP grant path, which runs
// AFTER the atomic IncrementUserXPForWatch and therefore can't lose
// the base watch grant to a concurrent call.
func (q *Queries) UpsertUserXP(ctx context.Context, x *models.UserXP) error {
	_, err := q.pool.Exec(ctx, `
		INSERT INTO user_xp (user_id, xp, level, current_streak, longest_streak,
		                     last_watch_date, total_watches, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
		ON CONFLICT (user_id) DO UPDATE SET
		  xp              = EXCLUDED.xp,
		  level           = EXCLUDED.level,
		  current_streak  = EXCLUDED.current_streak,
		  longest_streak  = EXCLUDED.longest_streak,
		  last_watch_date = EXCLUDED.last_watch_date,
		  total_watches   = EXCLUDED.total_watches,
		  updated_at      = NOW()
	`, x.UserID, x.XP, x.Level, x.CurrentStreak, x.LongestStreak,
		x.LastWatchDate, x.TotalWatches)
	return err
}

// IncrementUserXPForWatch atomically applies the per-watch XP grant
// AND streak update in a single SQL statement, returning the new row.
// Callers compute the level from the returned XP value.
//
// 2026-05-19 audit (API-H4) — replaces the read-modify-write pattern
// AwardForWatch used to use (GetUserXP, mutate in Go, UpsertUserXP).
// Two concurrent MarkWatched calls on the same user (multi-device
// replay, browser double-click) would last-write-wins one of the
// increments, silently losing XP and miscounting total_watches and
// streaks. This SQL increments under a single row lock — no race.
//
// Streak rules (done in the SQL CASE to stay atomic):
//   - First watch ever (last_watch_date IS NULL)              → streak = 1
//   - Same UTC day as last watch                              → streak unchanged
//   - Exactly one day after last watch                        → streak + 1
//   - Two or more days after                                  → streak resets to 1
//
// today and xpDelta are passed in so the Go-side TouchDate() value
// is authoritative across timezone boundaries (avoid relying on
// Postgres's CURRENT_DATE which uses the server's TZ).
func (q *Queries) IncrementUserXPForWatch(
	ctx context.Context, userID int64, xpDelta int, today time.Time,
) (*models.UserXP, error) {
	x := &models.UserXP{UserID: userID}
	err := q.pool.QueryRow(ctx, `
		INSERT INTO user_xp (user_id, xp, level, current_streak, longest_streak,
		                     last_watch_date, total_watches, updated_at)
		VALUES ($1, $2, 1, 1, 1, $3, 1, NOW())
		ON CONFLICT (user_id) DO UPDATE SET
		  xp             = user_xp.xp + $2,
		  total_watches  = user_xp.total_watches + 1,
		  current_streak = CASE
		                     WHEN user_xp.last_watch_date IS NULL THEN 1
		                     WHEN user_xp.last_watch_date = $3 THEN user_xp.current_streak
		                     WHEN user_xp.last_watch_date = ($3::date - INTERVAL '1 day')::date
		                       THEN user_xp.current_streak + 1
		                     ELSE 1
		                   END,
		  longest_streak = GREATEST(user_xp.longest_streak,
		                     CASE
		                       WHEN user_xp.last_watch_date IS NULL THEN 1
		                       WHEN user_xp.last_watch_date = $3 THEN user_xp.current_streak
		                       WHEN user_xp.last_watch_date = ($3::date - INTERVAL '1 day')::date
		                         THEN user_xp.current_streak + 1
		                       ELSE 1
		                     END),
		  last_watch_date = $3,
		  updated_at     = NOW()
		RETURNING xp, level, current_streak, longest_streak, last_watch_date, total_watches
	`, userID, xpDelta, today).Scan(
		&x.XP, &x.Level, &x.CurrentStreak, &x.LongestStreak,
		&x.LastWatchDate, &x.TotalWatches)
	if err != nil {
		return nil, fmt.Errorf("increment user_xp: %w", err)
	}
	return x, nil
}

func (q *Queries) ListUserAchievements(ctx context.Context, userID int64) ([]*models.UserAchievement, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT id, user_id, achievement_key, unlocked_at
		  FROM user_achievements WHERE user_id = $1
		 ORDER BY unlocked_at DESC
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list achievements: %w", err)
	}
	defer rows.Close()
	out := []*models.UserAchievement{}
	for rows.Next() {
		a := &models.UserAchievement{}
		if err := rows.Scan(&a.ID, &a.UserID, &a.AchievementKey, &a.UnlockedAt); err != nil {
			return nil, fmt.Errorf("scan achievement: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// UnlockAchievement inserts an unlock, returning (true, _) if it
// was newly inserted and (false, _) if the user already had it.
// Idempotent via the UNIQUE constraint.
func (q *Queries) UnlockAchievement(ctx context.Context, userID int64, key string) (bool, error) {
	tag, err := q.pool.Exec(ctx, `
		INSERT INTO user_achievements (user_id, achievement_key)
		VALUES ($1, $2)
		ON CONFLICT (user_id, achievement_key) DO NOTHING
	`, userID, key)
	if err != nil {
		return false, fmt.Errorf("unlock achievement: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// TouchDate returns today's UTC date (DATE column compatibility).
func TouchDate() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}
