package db

import (
	"context"
	"errors"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// CreateNotification inserts a notification, deduped by (user_id, request_id,
// type) via the unique index from migration 037. It returns created=false (and a
// nil error) when an identical notification already exists, so callers — notably
// the 5s request monitor — can skip re-pushing a duplicate over WebSocket. On a
// real insert, n.ID and n.CreatedAt are populated.
func (q *Queries) CreateNotification(ctx context.Context, n *models.Notification) (created bool, err error) {
	// Map empty/zero optional fields to SQL NULL so the schema's nullable columns
	// stay NULL rather than storing "" / 0.
	var mediaType, requestID interface{}
	if n.MediaType != "" {
		mediaType = n.MediaType
	}
	if n.RequestID != nil {
		requestID = *n.RequestID
	}
	err = q.pool.QueryRow(ctx, `
		INSERT INTO notifications (user_id, type, title, media_type, request_id)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (user_id, request_id, type) DO NOTHING
		RETURNING id, created_at`,
		n.UserID, n.Type, n.Title, mediaType, requestID,
	).Scan(&n.ID, &n.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// ON CONFLICT DO NOTHING fired — a notification for this (user, request,
		// type) already exists. Not an error; just nothing new to push.
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ListNotificationsForUser returns a user's most-recent notifications, newest
// first, capped at limit (defaulted/clamped to 50).
func (q *Queries) ListNotificationsForUser(ctx context.Context, userID int64, limit int) ([]*models.Notification, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := q.pool.Query(ctx, `
		SELECT id, user_id, type, title, COALESCE(media_type, ''), request_id, read_at, created_at
		FROM notifications
		WHERE user_id = $1
		ORDER BY created_at DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*models.Notification
	for rows.Next() {
		n := &models.Notification{}
		if err := rows.Scan(&n.ID, &n.UserID, &n.Type, &n.Title, &n.MediaType, &n.RequestID, &n.ReadAt, &n.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// CountUnreadNotifications returns the number of unread notifications for a user
// (backs the bell badge). Uses the partial idx_notifications_user_unread index.
func (q *Queries) CountUnreadNotifications(ctx context.Context, userID int64) (int, error) {
	var n int
	err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
		userID,
	).Scan(&n)
	return n, err
}

// MarkNotificationRead marks a single notification read, scoped to its owner so a
// user can't mark someone else's notification. No-ops cleanly if the id doesn't
// belong to the user or is already read.
func (q *Queries) MarkNotificationRead(ctx context.Context, id, userID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
		id, userID,
	)
	return err
}

// MarkAllNotificationsRead marks all of a user's unread notifications read.
func (q *Queries) MarkAllNotificationsRead(ctx context.Context, userID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
		userID,
	)
	return err
}
