package auth

import (
	"context"
	"testing"
)

type stubTokenVersionQuerier struct {
	version int
	err     error
}

func (s stubTokenVersionQuerier) GetUserTokenVersion(ctx context.Context, userID int64) (int, error) {
	return s.version, s.err
}

// TestTokenVersionStore_DeletedUserFailsClosed is the regression test for audit
// H2. When a user is deleted, the DB layer returns the -1 sentinel from
// GetUserTokenVersion. A live access token carries claimVersion 0 (the default
// that is only ever bumped on a password change), so Check must REJECT it.
// The old behavior returned 0 for a deleted user, making the check pass
// (0 == 0) and leaving the deleted account's token fully valid until expiry.
func TestTokenVersionStore_DeletedUserFailsClosed(t *testing.T) {
	store := NewTokenVersionStore(stubTokenVersionQuerier{version: -1})
	if store.Check(context.Background(), 42, 0) {
		t.Error("Check returned true for a deleted user's version-0 token; want false (fail closed)")
	}
}

// TestTokenVersionStore_FailsClosedOnDBError confirms a DB error also rejects.
func TestTokenVersionStore_FailsClosedOnDBError(t *testing.T) {
	store := NewTokenVersionStore(stubTokenVersionQuerier{version: 0, err: context.DeadlineExceeded})
	if store.Check(context.Background(), 42, 0) {
		t.Error("Check returned true despite a DB error; want false (fail closed)")
	}
}

// TestTokenVersionStore_MatchingVersionPasses is the positive control: a live
// user whose persisted version matches the token claim validates, and a stale
// (lower) claim does not.
func TestTokenVersionStore_MatchingVersionPasses(t *testing.T) {
	store := NewTokenVersionStore(stubTokenVersionQuerier{version: 3})
	if !store.Check(context.Background(), 42, 3) {
		t.Error("Check returned false for a matching version; want true")
	}
	// Same user, cached version 3 — a token minted before the last bump
	// (claim 2) must be rejected.
	if store.Check(context.Background(), 42, 2) {
		t.Error("Check returned true for a stale (lower) claim version; want false")
	}
}
