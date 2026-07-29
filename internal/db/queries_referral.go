package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/aurora-media/aurora/internal/models"
)

// Referral prompt (migration 046).
//
// The whole feature turns on one column: users.referral_status. NULL means the
// user was never eligible to be asked (password signup, invite redeemed, or the
// provider's invite-bypass toggle was off); 'pending' means eligible and
// unresolved; 'answered'/'skipped' are terminal. Eligibility is stamped at
// creation inside CreateOAuthUserWithIdentity's transaction, so there is no
// window in which an eligible user exists unmarked.

// GetReferralStatus returns the user's referral_status, or "" when the column
// is NULL (never eligible). A missing user is also "" — the caller is always
// operating on its own authenticated ID, so a miss means the account was
// deleted mid-session and "no prompt" is the right answer either way.
func (q *Queries) GetReferralStatus(ctx context.Context, userID int64) (string, error) {
	var status *string
	if err := q.pool.QueryRow(ctx,
		`SELECT referral_status FROM users WHERE id = $1`, userID,
	).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", fmt.Errorf("get referral status: %w", err)
	}
	if status == nil {
		return "", nil
	}
	return *status, nil
}

// ResolveReferral records the user's answer (or their skip) and returns whether
// it actually landed. The `AND referral_status = 'pending'` predicate is the
// entire idempotency mechanism: a double-submit's second statement matches zero
// rows and reports false, which the handler turns into a 200 no-op rather than
// an error. That also makes it race-free without a transaction — two concurrent
// submits cannot both win, because the second sees a row that is no longer
// pending.
//
// status must be "answered" or "skipped" (the handler validates). source is ""
// for a skip; detail is nil unless source == "other", which the schema's CHECK
// constraint independently enforces.
func (q *Queries) ResolveReferral(ctx context.Context, userID int64, status, source string, detail *string) (bool, error) {
	var src *string
	if source != "" {
		src = &source
	}
	tag, err := q.pool.Exec(ctx,
		`UPDATE users
		    SET referral_status = $2,
		        referral_source = $3,
		        referral_detail = $4,
		        referral_answered_at = NOW()
		  WHERE id = $1 AND referral_status = 'pending'`,
		userID, status, src, detail)
	if err != nil {
		return false, fmt.Errorf("resolve referral: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// ReferralSummary aggregates the prompt's results for the admin panel.
//
// windowDays > 0 restricts to users created in that window; 0 means all time.
// The window filters on created_at (signup date) rather than
// referral_answered_at so all four buckets describe the same cohort — "of the
// people who signed up in this period, what did they say" — instead of mixing
// answers from one period with pendings from another.
//
// Two statements under one snapshot: the totals (a single scan of the eligible
// rows via COUNT FILTER) and the per-source breakdown (GROUP BY over the
// partial index). Aggregation stays in Postgres; Go only labels the keys.
//
// The interval is bound as `NOW() - INTERVAL '1 second' * $n` — Postgres cannot
// parameterize an interval literal, and this is the repo's established idiom
// for a caller-supplied window (queries_recommender.go, queries_surfaced.go).
func (q *Queries) ReferralSummary(ctx context.Context, windowDays int) (*models.ReferralSummary, error) {
	windowSeconds := int64(windowDays) * 86400
	out := &models.ReferralSummary{WindowDays: windowDays, BySource: []models.ReferralSourceCount{}}

	// One snapshot for both statements. Without it the two queries see
	// independent commits, so a user resolving between them yields
	// sum(by_source) = answered + 1 — a panel that visibly fails to add up.
	// REPEATABLE READ (not the default READ COMMITTED) is what makes the
	// second statement see the same rows as the first; read-only, so it can't
	// hit a serialization conflict.
	tx, err := q.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("referral summary: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := tx.QueryRow(ctx,
		`SELECT COUNT(*),
		        COUNT(*) FILTER (WHERE referral_status = 'answered'),
		        COUNT(*) FILTER (WHERE referral_status = 'skipped'),
		        COUNT(*) FILTER (WHERE referral_status = 'pending')
		   FROM users
		  WHERE referral_status IS NOT NULL
		    AND ($1 = 0 OR created_at >= NOW() - INTERVAL '1 second' * $1)`,
		windowSeconds,
	).Scan(&out.Total, &out.Answered, &out.Skipped, &out.Pending); err != nil {
		return nil, fmt.Errorf("referral summary totals: %w", err)
	}

	rows, err := tx.Query(ctx,
		`SELECT referral_source, COUNT(*)
		   FROM users
		  WHERE referral_source IS NOT NULL
		    AND ($1 = 0 OR created_at >= NOW() - INTERVAL '1 second' * $1)
		  GROUP BY referral_source
		  ORDER BY COUNT(*) DESC, referral_source ASC`,
		windowSeconds)
	if err != nil {
		return nil, fmt.Errorf("referral summary by source: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var row models.ReferralSourceCount
		if err := rows.Scan(&row.Key, &row.Count); err != nil {
			return nil, fmt.Errorf("scan referral source: %w", err)
		}
		out.BySource = append(out.BySource, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate referral sources: %w", err)
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("referral summary: commit: %w", err)
	}
	return out, nil
}
