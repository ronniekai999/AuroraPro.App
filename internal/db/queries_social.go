package db

import (
	"context"
	"fmt"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// ============================================================
// Member profiles (social phase 1 — migration 049)
// ============================================================

// memberProfileSelect is the shared column list for member-profile lookups.
// The avatar subquery mirrors the account's DEFAULT sub-profile avatar
// (partial unique index idx_user_profiles_default guarantees at most one),
// falling back to users.avatar_url (OAuth signup may have set it) then ''.
// Never add email/role/auth columns here — this struct is shown to OTHER
// members.
const memberProfileSelect = `
	SELECT u.id, u.username, u.display_name, u.bio,
	       u.social_x, u.social_instagram, u.social_facebook, u.social_snapchat,
	       u.share_watch_history, u.created_at,
	       COALESCE(
	         (SELECT p.avatar_url FROM user_profiles p
	           WHERE p.user_id = u.id AND p.is_default = TRUE
	           LIMIT 1),
	         u.avatar_url, '') AS avatar_url
	FROM users u`

func (q *Queries) scanMemberProfile(row pgx.Row) (*models.MemberProfile, error) {
	p := &models.MemberProfile{}
	err := row.Scan(&p.UserID, &p.Username, &p.DisplayName, &p.Bio,
		&p.SocialX, &p.SocialInstagram, &p.SocialFacebook, &p.SocialSnapchat,
		&p.ShareWatchHistory, &p.MemberSince, &p.AvatarURL)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return p, nil
}

// GetMemberProfileByUsername resolves a member profile card by username,
// case-insensitively (same LOWER() convention as GetUserByUsername, paired
// with migration 017's LOWER(username) unique index). Returns nil when no
// such user exists.
func (q *Queries) GetMemberProfileByUsername(ctx context.Context, username string) (*models.MemberProfile, error) {
	p, err := q.scanMemberProfile(q.pool.QueryRow(ctx,
		memberProfileSelect+` WHERE LOWER(u.username) = LOWER($1)`, username))
	if err != nil {
		return nil, fmt.Errorf("get member profile by username: %w", err)
	}
	return p, nil
}

// GetMemberProfileByID is the self-service variant (GET /api/me/profile).
func (q *Queries) GetMemberProfileByID(ctx context.Context, userID int64) (*models.MemberProfile, error) {
	p, err := q.scanMemberProfile(q.pool.QueryRow(ctx,
		memberProfileSelect+` WHERE u.id = $1`, userID))
	if err != nil {
		return nil, fmt.Errorf("get member profile by id: %w", err)
	}
	return p, nil
}

// UpdateMemberProfile writes the full set of member-profile fields for one
// user. The handler owns patch semantics (read current row, overlay non-nil
// request fields, call this with final values) — keeping the SQL a plain
// full-row write like UpdateProfile does for sub-profiles.
func (q *Queries) UpdateMemberProfile(ctx context.Context, userID int64, displayName, bio, socialX, socialInstagram, socialFacebook, socialSnapchat string, shareWatchHistory bool) error {
	tag, err := q.pool.Exec(ctx,
		`UPDATE users
		 SET display_name = $2, bio = $3,
		     social_x = $4, social_instagram = $5, social_facebook = $6, social_snapchat = $7,
		     share_watch_history = $8,
		     updated_at = NOW()
		 WHERE id = $1`,
		userID, displayName, bio, socialX, socialInstagram, socialFacebook, socialSnapchat, shareWatchHistory)
	if err != nil {
		return fmt.Errorf("update member profile: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("update member profile: user %d not found", userID)
	}
	return nil
}

// GetMemberRecentWatches returns the newest completed titles for a member's
// profile strip, deduplicated to one row per show/movie (same DISTINCT ON
// rollup rationale as GetContinueWatching — a binge shows the show once).
//
// Scope decisions, made deliberately:
//   - DEFAULT sub-profile only (up.is_default): a household account's kids
//     profile must not attribute its watching to the account owner.
//   - completed_at IS NOT NULL: migration 033 did not backfill, so the strip
//     reflects activity from then forward; ordering by it (not updated_at)
//     keeps a later partial rewatch from reshuffling history.
//
// Callers gate on users.share_watch_history — this query does not re-check,
// so the owner's own settings preview can reuse it.
func (q *Queries) GetMemberRecentWatches(ctx context.Context, userID int64, limit int) ([]models.MemberRecentWatch, error) {
	if limit <= 0 || limit > 50 {
		limit = 18
	}
	rows, err := q.pool.Query(ctx, `
		SELECT id, title, type, poster_path, backdrop_path, year, rating, watched_at
		FROM (
		  SELECT DISTINCT ON (wp.media_item_id)
		         mi.id, mi.title, mi.type,
		         COALESCE(mi.poster_path, '') AS poster_path,
		         COALESCE(mi.backdrop_path, '') AS backdrop_path,
		         COALESCE(mi.year, 0) AS year,
		         COALESCE(mi.rating, 0) AS rating,
		         wp.completed_at AS watched_at
		  FROM watch_progress wp
		  JOIN media_items mi ON mi.id = wp.media_item_id
		  JOIN user_profiles up ON up.id = wp.profile_id
		  WHERE wp.user_id = $1
		    AND up.is_default = TRUE
		    AND wp.completed = TRUE
		    AND wp.completed_at IS NOT NULL
		  ORDER BY wp.media_item_id, wp.completed_at DESC
		) dedup
		ORDER BY watched_at DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("get member recent watches: %w", err)
	}
	defer rows.Close()

	var out []models.MemberRecentWatch
	for rows.Next() {
		var w models.MemberRecentWatch
		if err := rows.Scan(&w.ID, &w.Title, &w.Type, &w.PosterPath, &w.BackdropPath,
			&w.Year, &w.Rating, &w.WatchedAt); err != nil {
			return nil, fmt.Errorf("scan member recent watch: %w", err)
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
