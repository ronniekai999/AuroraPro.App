package db

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
)

// RunDataMigrations performs Go-based data migrations that can't be done in pure SQL.
// Called after schema migrations in main.go.
func RunDataMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	q := NewQueries(pool)
	if err := migrateDefaultProfiles(ctx, q); err != nil {
		return err
	}
	// Not fatal: reads already normalize, so a failed rewrite changes what the
	// API reports, not what any gate enforces.
	if err := canonicalizeProfileRatings(ctx, q); err != nil {
		slog.Warn("canonicalize profile rating ceilings failed", "error", err)
	}
	return nil
}

// allAgesCeiling is the ceiling a stored value the ladder doesn't know is
// rewritten to: the tier AllowedRatingsForMax already enforces for it.
const allAgesCeiling = "G"

// canonicalizeProfileRatings rewrites every stored max_age_rating to the
// ladder's spelling of what it already means: case and whitespace variants to
// the canonical key ("pg " → "PG"), blank to NULL (unrestricted), and a value
// the ladder doesn't know to allAgesCeiling. Before write validation those
// were all storable, and the readers disagreed about them: the gates normalize,
// but the API returned the raw string and the SPA's age slider shows an
// unknown value as Adult. In Go rather than SQL so the ladder stays in one
// place. Idempotent, and cheap enough to run on every boot, which also catches
// a value written since by hand.
func canonicalizeProfileRatings(ctx context.Context, q *Queries) error {
	rows, err := q.pool.Query(ctx,
		`SELECT id, max_age_rating FROM user_profiles WHERE max_age_rating IS NOT NULL`)
	if err != nil {
		return err
	}
	type change struct {
		id       int64
		old, new string
	}
	var changes []change
	for rows.Next() {
		var c change
		if err := rows.Scan(&c.id, &c.old); err != nil {
			rows.Close()
			return err
		}
		canonical, ok := CanonicalMaxRating(c.old)
		if !ok {
			canonical = allAgesCeiling
			slog.Warn("profile rating ceiling is not on the ladder; restricting it to all ages",
				"profile_id", c.id, "max_age_rating", c.old, "now", canonical)
		}
		if canonical != c.old {
			c.new = canonical
			changes = append(changes, c)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, c := range changes {
		// Matching the old value leaves alone a row someone changed meanwhile.
		if _, err := q.pool.Exec(ctx,
			`UPDATE user_profiles SET max_age_rating = $3, updated_at = NOW()
			 WHERE id = $1 AND max_age_rating = $2`,
			c.id, c.old, nilIfEmpty(c.new)); err != nil {
			return err
		}
	}
	if len(changes) > 0 {
		slog.Info("canonicalized profile rating ceilings", "count", len(changes))
	}
	return nil
}

// migrateDefaultProfiles creates a default profile for every user who doesn't have one,
// then backfills watch_progress.profile_id for any rows that are NULL.
func migrateDefaultProfiles(ctx context.Context, q *Queries) error {
	// Check if user_profiles table exists (migration 006 may not have run yet)
	var tableExists bool
	err := q.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT FROM information_schema.tables
			WHERE table_name = 'user_profiles'
		)`).Scan(&tableExists)
	if err != nil || !tableExists {
		return err
	}

	// Create default profiles for users who don't have any
	tag, err := q.pool.Exec(ctx, `
		INSERT INTO user_profiles (user_id, name, is_default, language, subtitle_mode)
		SELECT u.id, u.username, TRUE, 'en', 'off'
		FROM users u
		WHERE NOT EXISTS (
			SELECT 1 FROM user_profiles up WHERE up.user_id = u.id
		)`)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		slog.Info("created default profiles for existing users", "count", tag.RowsAffected())
	}

	// Backfill watch_progress.profile_id where NULL
	tag, err = q.pool.Exec(ctx, `
		UPDATE watch_progress wp
		SET profile_id = (
			SELECT up.id FROM user_profiles up
			WHERE up.user_id = wp.user_id AND up.is_default = TRUE
			LIMIT 1
		)
		WHERE wp.profile_id IS NULL`)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		slog.Info("backfilled watch progress profile_id", "count", tag.RowsAffected())
	}

	return nil
}
