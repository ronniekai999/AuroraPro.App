package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ProfilePINState is what a PIN check needs: the stored hash ("" when the
// profile is unlocked) and the lockout, if one is running. LockedUntil is in
// the past, or nil, when attempts are allowed.
type ProfilePINState struct {
	Hash        string
	LockedUntil *time.Time
}

// GetProfilePINState reads a profile's PIN state. A missing profile returns
// (nil, nil); callers have already resolved the profile.
func (q *Queries) GetProfilePINState(ctx context.Context, profileID int64) (*ProfilePINState, error) {
	st := &ProfilePINState{}
	err := q.pool.QueryRow(ctx,
		`SELECT COALESCE(pin_hash, ''), pin_locked_until FROM user_profiles WHERE id = $1`,
		profileID).Scan(&st.Hash, &st.LockedUntil)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("profile pin state: %w", err)
	}
	return st, nil
}

// SetProfilePIN stores a new PIN hash, or clears the PIN when hash is "".
// Either way the attempt counter and lockout reset: they belong to the PIN
// that was being guessed.
func (q *Queries) SetProfilePIN(ctx context.Context, profileID int64, hash string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE user_profiles
		 SET pin_hash = $2, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = NOW()
		 WHERE id = $1`,
		profileID, nilIfEmpty(hash))
	if err != nil {
		return fmt.Errorf("set profile pin: %w", err)
	}
	return nil
}

// RecordProfilePINFailure counts one failed attempt and, once maxFailures
// consecutive failures have accumulated, starts (or restarts) a lockout of the
// given length. It returns the lockout end when one is now running. One
// statement, so concurrent wrong guesses cannot race past the limit. The
// counter does not reset when a lockout expires, so after one lockout every
// further failure locks again at once, until a success resets it.
func (q *Queries) RecordProfilePINFailure(ctx context.Context, profileID int64, maxFailures int, lockout time.Duration) (*time.Time, error) {
	var lockedUntil *time.Time
	err := q.pool.QueryRow(ctx,
		`UPDATE user_profiles
		 SET pin_failed_attempts = pin_failed_attempts + 1,
		     pin_locked_until = CASE
		       WHEN pin_failed_attempts + 1 >= $2 THEN NOW() + make_interval(secs => $3)
		       ELSE pin_locked_until END
		 WHERE id = $1
		 RETURNING CASE WHEN pin_locked_until > NOW() THEN pin_locked_until END`,
		profileID, maxFailures, lockout.Seconds()).Scan(&lockedUntil)
	if err != nil {
		return nil, fmt.Errorf("record profile pin failure: %w", err)
	}
	return lockedUntil, nil
}

// ResetProfilePINFailures clears the attempt counter after a correct PIN or
// password.
func (q *Queries) ResetProfilePINFailures(ctx context.Context, profileID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE user_profiles SET pin_failed_attempts = 0, pin_locked_until = NULL
		 WHERE id = $1 AND (pin_failed_attempts <> 0 OR pin_locked_until IS NOT NULL)`,
		profileID)
	if err != nil {
		return fmt.Errorf("reset profile pin failures: %w", err)
	}
	return nil
}
