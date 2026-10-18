package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ProfilePINState is a profile's PIN state: the stored hash ("" when the
// profile is unlocked), the lockout end if one was ever set, and whether it
// is running now. Locked is computed by the database, so the database's clock
// alone decides lockouts.
type ProfilePINState struct {
	Hash        string
	LockedUntil *time.Time
	Locked      bool
}

// GetProfilePINState reads a profile's PIN state. A missing profile returns
// (nil, nil); callers have already resolved the profile.
func (q *Queries) GetProfilePINState(ctx context.Context, profileID int64) (*ProfilePINState, error) {
	st := &ProfilePINState{}
	err := q.pool.QueryRow(ctx,
		`SELECT COALESCE(pin_hash, ''), pin_locked_until, COALESCE(pin_locked_until > NOW(), FALSE)
		 FROM user_profiles WHERE id = $1`,
		profileID).Scan(&st.Hash, &st.LockedUntil, &st.Locked)
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
//
// Setting or changing a PIN also ends the account's other sessions that act
// as the profile without having presented it: those bound to it, and the
// unbound ones when it is the default. A session already acting as a profile
// skips its PIN, and before the lock any session could switch freely, so a
// kid's device bound to the parent's profile, or one that unlocked it with
// a leaked PIN, otherwise kept it. The rows are DELETED, not revoked, revoked
// ones included: a revoked row keeps resolving to its binding for as long as
// its access token is valid, so a revoked session kept the profile's powers
// for that long, enough to lift a ceiling or pair a device for good. With the
// row gone, its token acts as the account's most restrictive profile, as a
// deleted profile's do. The caller's own session (keepTokenID) is kept; the
// others sign in again. The user row is locked first, as rotation locks it,
// so a rotation cannot carry a binding past the deletion, and activation
// takes it FOR SHARE. Clearing a PIN ends nothing. It returns how many
// sessions it ended.
func (q *Queries) SetProfilePIN(ctx context.Context, userID, profileID int64, hash string, keepTokenID int64) (int64, error) {
	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("set profile pin: %w", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, userID); err != nil {
		return 0, fmt.Errorf("set profile pin: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE user_profiles
		 SET pin_hash = $2, pin_failed_attempts = 0, pin_locked_until = NULL, updated_at = NOW()
		 WHERE id = $1 AND user_id = $3`,
		profileID, nilIfEmpty(hash), userID); err != nil {
		return 0, fmt.Errorf("set profile pin: %w", err)
	}
	var revoked int64
	if hash != "" {
		tag, err := tx.Exec(ctx,
			`DELETE FROM refresh_tokens
			 WHERE user_id = $1 AND id <> $3
			   AND (active_profile_id = $2
			        OR (active_profile_id IS NULL AND EXISTS (
			              SELECT 1 FROM user_profiles WHERE id = $2 AND is_default)))`,
			userID, profileID, keepTokenID)
		if err != nil {
			return 0, fmt.Errorf("set profile pin: revoke sessions: %w", err)
		}
		revoked = tag.RowsAffected()
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("set profile pin: %w", err)
	}
	return revoked, nil
}

// PINAttempt is the outcome of ReserveProfilePINAttempt.
type PINAttempt struct {
	// Reserved: an attempt was counted and may be checked against Hash.
	Reserved bool
	Hash     string
	// LocksOut: this attempt reached the limit and started a lockout, which a
	// correct PIN still lifts (ResetProfilePINFailures).
	LocksOut bool
	// NoPIN: the profile has no PIN, so there is nothing to check.
	NoPIN bool
	// LockedUntil is set when a lockout is running and nothing was reserved.
	LockedUntil *time.Time
}

// ReserveProfilePINAttempt counts one PIN attempt BEFORE it is checked, in one
// statement, and refuses while a lockout runs. Counting after the check let a
// burst of concurrent guesses all pass the lockout read before any failure was
// written; a review drove 40 through a limit of 5. Here each attempt takes its
// slot under the row lock, so at most maxFailures attempts are ever checked
// per lockout. The attempt that reaches the limit starts a lockout of the
// given length. The counter is not reset when a lockout expires, so after one
// lockout every further attempt locks again, until a success resets it.
func (q *Queries) ReserveProfilePINAttempt(ctx context.Context, profileID int64, maxFailures int, lockout time.Duration) (PINAttempt, error) {
	var a PINAttempt
	err := q.pool.QueryRow(ctx,
		`UPDATE user_profiles
		 SET pin_failed_attempts = pin_failed_attempts + 1,
		     pin_locked_until = CASE
		       WHEN pin_failed_attempts + 1 >= $2 THEN NOW() + make_interval(secs => $3)
		       ELSE pin_locked_until END
		 WHERE id = $1 AND pin_hash IS NOT NULL
		   AND (pin_locked_until IS NULL OR pin_locked_until <= NOW())
		 RETURNING pin_hash, pin_failed_attempts >= $2`,
		profileID, maxFailures, lockout.Seconds()).Scan(&a.Hash, &a.LocksOut)
	if err == nil {
		a.Reserved = true
		return a, nil
	}
	if err != pgx.ErrNoRows {
		return a, fmt.Errorf("reserve profile pin attempt: %w", err)
	}
	// Nothing reserved: either there is no PIN or a lockout is running.
	st, err := q.GetProfilePINState(ctx, profileID)
	if err != nil {
		return a, err
	}
	if st == nil || st.Hash == "" {
		a.NoPIN = true
		return a, nil
	}
	if !st.Locked {
		// The lockout ended between the two statements; report it as running
		// rather than retrying. The client tries again.
		t := time.Now()
		st.LockedUntil = &t
	}
	a.LockedUntil = st.LockedUntil
	return a, nil
}

// ResetProfilePINFailures clears the attempt counter and any lockout after a
// correct PIN or password.
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
