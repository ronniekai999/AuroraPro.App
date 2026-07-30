package db

import (
	"context"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// UpsertPushSubscription registers (or refreshes) a device's push endpoint.
// ON CONFLICT (endpoint) DO UPDATE reassigns the row's user_id — an endpoint
// identifies a browser profile on a device, so when a different account
// enables push on a shared machine, the channel must follow the signed-in
// account rather than keep delivering to whoever enabled it first. The same
// path is the boot-time re-POST, which refreshes last_seen_at (the liveness
// signal the 180-day prune keys off).
func (q *Queries) UpsertPushSubscription(ctx context.Context, s *models.PushSubscription) error {
	_, err := q.pool.Exec(ctx, `
		INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''))
		ON CONFLICT (endpoint) DO UPDATE SET
			user_id      = EXCLUDED.user_id,
			p256dh       = EXCLUDED.p256dh,
			auth         = EXCLUDED.auth,
			user_agent   = EXCLUDED.user_agent,
			last_seen_at = NOW()`,
		s.UserID, s.Endpoint, s.P256dh, s.Auth, s.UserAgent)
	return err
}

// ListPushSubscriptionsForUser returns every push channel a user has enabled
// (typically 1-3: phone, desktop, tablet).
func (q *Queries) ListPushSubscriptionsForUser(ctx context.Context, userID int64) ([]*models.PushSubscription, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT id, user_id, endpoint, p256dh, auth, COALESCE(user_agent, ''), created_at, last_seen_at, last_success_at
		FROM push_subscriptions
		WHERE user_id = $1
		ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*models.PushSubscription
	for rows.Next() {
		s := &models.PushSubscription{}
		if err := rows.Scan(&s.ID, &s.UserID, &s.Endpoint, &s.P256dh, &s.Auth, &s.UserAgent, &s.CreatedAt, &s.LastSeenAt, &s.LastSuccessAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// DeletePushSubscriptionForUser removes a subscription, scoped to its owner
// so one user cannot unsubscribe another's device by guessing endpoints.
func (q *Queries) DeletePushSubscriptionForUser(ctx context.Context, endpoint string, userID int64) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`,
		endpoint, userID)
	return err
}

// DeletePushSubscriptionByEndpoint removes a subscription regardless of
// owner. Reserved for the sender's 404/410 cleanup, where the push service
// itself has declared the endpoint dead — there is no user in that loop.
func (q *Queries) DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error {
	_, err := q.pool.Exec(ctx,
		`DELETE FROM push_subscriptions WHERE endpoint = $1`, endpoint)
	return err
}

// StampPushSuccess records a successful delivery on the subscription.
func (q *Queries) StampPushSuccess(ctx context.Context, endpoint string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE push_subscriptions SET last_success_at = NOW() WHERE endpoint = $1`,
		endpoint)
	return err
}

// PruneStalePushSubscriptions deletes rows not seen since the cutoff. The
// boot re-POST refreshes last_seen_at on every authenticated app start, so a
// row this stale belongs to a device that hasn't opened Aurora in months (or
// deleted the installed app, which kills the subscription without telling
// anyone). Called opportunistically from the subscribe handler.
func (q *Queries) PruneStalePushSubscriptions(ctx context.Context, cutoff time.Time) (int64, error) {
	tag, err := q.pool.Exec(ctx,
		`DELETE FROM push_subscriptions WHERE last_seen_at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// GetAdminUserIDs returns the ids of all admin accounts — the audience for
// admin_new_request / scan_complete notifications.
func (q *Queries) GetAdminUserIDs(ctx context.Context) ([]int64, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id FROM users WHERE role = 'admin' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
