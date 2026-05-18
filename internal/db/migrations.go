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
	return migrateDefaultProfiles(ctx, q)
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
