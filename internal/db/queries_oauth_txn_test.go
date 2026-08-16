package db

// Integration tests for the OAuth transaction store (migration 057) and the
// invite-claim predicates it works with.
//
// These cover the database half of the two OAuth authorization defects: a
// forgeable link-uid cookie that allowed account takeover, and a forgeable
// invite-claim cookie that walked uninvited signups past the invite gate. The
// handler-side halves are in internal/api/oauth_txn_test.go and
// internal/api/oauth_link_test.go.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run (reuses
// requireIntegrationDB / randomSuffix / seedTestUser from the other
// integration tests).

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"
)

// txnHash mirrors the API layer's hashOAuthTxnToken so these tests exercise the
// same key shape the handlers store.
func txnHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// seedInviteCode inserts an unclaimed, unexpired invite owned by createdBy.
func seedInviteCode(t *testing.T, q *Queries, createdBy int64) int64 {
	t.Helper()
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO invite_codes (code, created_by, expires_at)
		 VALUES ($1, $2, NOW() + INTERVAL '7 days') RETURNING id`,
		"txn_test_"+randomSuffix(t), createdBy,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed invite code: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM invite_codes WHERE id = $1`, id)
	})
	return id
}

// inviteState reads back the two columns the claim lifecycle turns on.
func inviteState(t *testing.T, q *Queries, id int64) (usedBy *int64, usedAt *time.Time) {
	t.Helper()
	if err := q.pool.QueryRow(context.Background(),
		`SELECT used_by, used_at FROM invite_codes WHERE id = $1`, id,
	).Scan(&usedBy, &usedAt); err != nil {
		t.Fatalf("read invite state: %v", err)
	}
	return usedBy, usedAt
}

// TestOAuthTransaction_CreateConsumeRoundTrip is the happy path: a link
// transaction written at Start comes back intact at callback.
func TestOAuthTransaction_CreateConsumeRoundTrip(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)

	hash := txnHash("token-" + randomSuffix(t))
	id, err := q.CreateOAuthTransaction(ctx, hash, OAuthTxnModeLink, "google", "state-abc",
		&userID, nil, 10*time.Minute)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM oauth_transactions WHERE id = $1`, id) })

	txn, err := q.ConsumeOAuthTransaction(ctx, hash)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if txn.Mode != OAuthTxnModeLink {
		t.Errorf("mode = %q, want link", txn.Mode)
	}
	if txn.Provider != "google" {
		t.Errorf("provider = %q, want google", txn.Provider)
	}
	if txn.State != "state-abc" {
		t.Errorf("state = %q, want state-abc", txn.State)
	}
	if txn.UserID == nil || *txn.UserID != userID {
		t.Errorf("user id = %v, want %d", txn.UserID, userID)
	}
	if txn.InviteID != nil {
		t.Errorf("invite id = %v, want nil for a link transaction", txn.InviteID)
	}
}

// TestOAuthTransaction_ConsumeIsSingleUse is the replay guard. The atomic
// UPDATE ... WHERE consumed_at IS NULL is what stops a captured token being
// used twice; a second consume must look exactly like an unknown token.
func TestOAuthTransaction_ConsumeIsSingleUse(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)

	hash := txnHash("token-" + randomSuffix(t))
	id, err := q.CreateOAuthTransaction(ctx, hash, OAuthTxnModeLink, "google", "s",
		&userID, nil, 10*time.Minute)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM oauth_transactions WHERE id = $1`, id) })

	if _, err := q.ConsumeOAuthTransaction(ctx, hash); err != nil {
		t.Fatalf("first consume should succeed: %v", err)
	}
	if _, err := q.ConsumeOAuthTransaction(ctx, hash); !errors.Is(err, ErrOAuthTxnNotFound) {
		t.Errorf("second consume err = %v, want ErrOAuthTxnNotFound", err)
	}
}

// TestOAuthTransaction_ExpiredIsNotConsumable pins that expiry is enforced in
// SQL against the database clock, not by the caller.
func TestOAuthTransaction_ExpiredIsNotConsumable(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)

	hash := txnHash("token-" + randomSuffix(t))
	id, err := q.CreateOAuthTransaction(ctx, hash, OAuthTxnModeLink, "google", "s",
		&userID, nil, -1*time.Minute) // already past
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM oauth_transactions WHERE id = $1`, id) })

	if _, err := q.ConsumeOAuthTransaction(ctx, hash); !errors.Is(err, ErrOAuthTxnNotFound) {
		t.Errorf("expired consume err = %v, want ErrOAuthTxnNotFound", err)
	}
}

// TestOAuthTransaction_UnknownTokenIsNotFound is the path a forged cookie lands
// on. It must be indistinguishable from expired/consumed so a caller cannot
// probe for live transactions.
func TestOAuthTransaction_UnknownTokenIsNotFound(t *testing.T) {
	q := requireIntegrationDB(t)
	if _, err := q.ConsumeOAuthTransaction(context.Background(), txnHash("never-issued")); !errors.Is(err, ErrOAuthTxnNotFound) {
		t.Errorf("unknown token err = %v, want ErrOAuthTxnNotFound", err)
	}
	// An empty hash must not degenerate into a wildcard match.
	if _, err := q.ConsumeOAuthTransaction(context.Background(), nil); !errors.Is(err, ErrOAuthTxnNotFound) {
		t.Errorf("empty hash err = %v, want ErrOAuthTxnNotFound", err)
	}
}

// TestOAuthTransaction_LinkModeRequiresUser pins the constraint that keeps a
// link transaction from consuming cleanly with nothing to attach to.
func TestOAuthTransaction_LinkModeRequiresUser(t *testing.T) {
	q := requireIntegrationDB(t)
	_, err := q.CreateOAuthTransaction(context.Background(), txnHash("x-"+randomSuffix(t)),
		OAuthTxnModeLink, "google", "s", nil, nil, 10*time.Minute)
	if err == nil {
		t.Error("a link transaction with no user id must be rejected")
	}
}

// TestOAuthTransaction_RejectsUnknownMode keeps an unrecognised mode from being
// written at all, rather than surfacing as a confusing branch at callback time.
func TestOAuthTransaction_RejectsUnknownMode(t *testing.T) {
	q := requireIntegrationDB(t)
	_, err := q.CreateOAuthTransaction(context.Background(), txnHash("y-"+randomSuffix(t)),
		OAuthTxnMode("elevate"), "google", "s", nil, nil, 10*time.Minute)
	if err == nil {
		t.Error("an unknown transaction mode must be rejected")
	}
}

// TestDeleteExpiredOAuthTransactions pins that the sweep removes expired rows
// and leaves live ones alone.
func TestDeleteExpiredOAuthTransactions(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)

	liveHash := txnHash("live-" + randomSuffix(t))
	deadHash := txnHash("dead-" + randomSuffix(t))
	liveID, err := q.CreateOAuthTransaction(ctx, liveHash, OAuthTxnModeLink, "google", "s",
		&userID, nil, 10*time.Minute)
	if err != nil {
		t.Fatalf("create live: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM oauth_transactions WHERE id = $1`, liveID) })
	if _, err := q.CreateOAuthTransaction(ctx, deadHash, OAuthTxnModeLink, "google", "s",
		&userID, nil, -1*time.Minute); err != nil {
		t.Fatalf("create dead: %v", err)
	}

	if _, err := q.DeleteExpiredOAuthTransactions(ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if _, err := q.ConsumeOAuthTransaction(ctx, liveHash); err != nil {
		t.Errorf("the live transaction must survive the sweep: %v", err)
	}
	var n int
	if err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM oauth_transactions WHERE token_hash = $1`, deadHash).Scan(&n); err != nil {
		t.Fatalf("count dead: %v", err)
	}
	if n != 0 {
		t.Errorf("expired row count = %d, want 0", n)
	}
}

// TestFinalizeInviteCode_RejectsUnclaimedRow is the invite-gate bypass
// regression test (audit H-01).
//
// The claim id used to ride in a client-writable cookie, and finalize matched
// on id alone. So naming any existing invite row — ids are sequential, so
// guessing one is trivial — finalized "successfully" and the uninvited signup
// was enrolled. Requiring used_at IS NOT NULL means only a row that actually
// went through ClaimInviteCode can be finalized.
func TestFinalizeInviteCode_RejectsUnclaimedRow(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	attacker := seedTestUser(t, q)
	inviteID := seedInviteCode(t, q, owner) // never claimed

	if err := q.FinalizeInviteCode(ctx, inviteID, attacker); err == nil {
		t.Error("finalizing an invite that was never claimed must fail")
	}
	usedBy, _ := inviteState(t, q, inviteID)
	if usedBy != nil {
		t.Errorf("invite must be untouched, used_by = %v", *usedBy)
	}
}

// TestFinalizeInviteCode_RejectsAlreadySpentInvite pins the second half: an
// invite legitimately redeemed by one user cannot be re-finalized onto another,
// which previously both let the second signup through and silently reassigned
// the first user's invite.
func TestFinalizeInviteCode_RejectsAlreadySpentInvite(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	firstUser := seedTestUser(t, q)
	secondUser := seedTestUser(t, q)

	inviteID := seedInviteCode(t, q, owner)
	if _, err := q.pool.Exec(ctx, `UPDATE invite_codes SET used_at = NOW() WHERE id = $1`, inviteID); err != nil {
		t.Fatalf("mark claimed: %v", err)
	}
	if err := q.FinalizeInviteCode(ctx, inviteID, firstUser); err != nil {
		t.Fatalf("the legitimate finalize should succeed: %v", err)
	}
	if err := q.FinalizeInviteCode(ctx, inviteID, secondUser); err == nil {
		t.Error("re-finalizing a spent invite must fail")
	}
	usedBy, _ := inviteState(t, q, inviteID)
	if usedBy == nil || *usedBy != firstUser {
		t.Errorf("used_by = %v, want the first user (%d) to keep the invite", usedBy, firstUser)
	}
}

// TestFinalizeInviteCode_AcceptsPendingClaim guards against over-tightening:
// the ordinary claim-then-finalize sequence must still work.
func TestFinalizeInviteCode_AcceptsPendingClaim(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	newUser := seedTestUser(t, q)

	inviteID := seedInviteCode(t, q, owner)
	if _, err := q.pool.Exec(ctx, `UPDATE invite_codes SET used_at = NOW() WHERE id = $1`, inviteID); err != nil {
		t.Fatalf("mark claimed: %v", err)
	}
	if err := q.FinalizeInviteCode(ctx, inviteID, newUser); err != nil {
		t.Fatalf("finalizing a pending claim must succeed: %v", err)
	}
	usedBy, _ := inviteState(t, q, inviteID)
	if usedBy == nil || *usedBy != newUser {
		t.Errorf("used_by = %v, want %d", usedBy, newUser)
	}
}

// TestUnclaimInviteCode_WontReopenSpentInvite is the invite-reopening
// regression test (audit H-01, second half).
//
// The rollback matched on id alone, so naming a redeemed invite's id cleared
// used_by/used_at and put that invite back into circulation. On an invite-only
// server, handing a spent invite back is handing out an account.
func TestUnclaimInviteCode_WontReopenSpentInvite(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	redeemer := seedTestUser(t, q)

	inviteID := seedInviteCode(t, q, owner)
	if _, err := q.pool.Exec(ctx,
		`UPDATE invite_codes SET used_at = NOW(), used_by = $1 WHERE id = $2`, redeemer, inviteID); err != nil {
		t.Fatalf("mark redeemed: %v", err)
	}

	if err := q.UnclaimInviteCode(ctx, inviteID); err != nil {
		t.Fatalf("unclaim should be a no-op, not an error: %v", err)
	}
	usedBy, usedAt := inviteState(t, q, inviteID)
	if usedBy == nil || *usedBy != redeemer {
		t.Errorf("used_by = %v, want the invite to stay spent by %d", usedBy, redeemer)
	}
	if usedAt == nil {
		t.Error("used_at must survive: a spent invite is not this flow's to release")
	}
}

// TestUnclaimInviteCode_ReleasesPendingClaim guards the legitimate rollback:
// a claim reserved at Start whose signup failed must go back into circulation.
func TestUnclaimInviteCode_ReleasesPendingClaim(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)

	inviteID := seedInviteCode(t, q, owner)
	if _, err := q.pool.Exec(ctx, `UPDATE invite_codes SET used_at = NOW() WHERE id = $1`, inviteID); err != nil {
		t.Fatalf("mark claimed: %v", err)
	}

	if err := q.UnclaimInviteCode(ctx, inviteID); err != nil {
		t.Fatalf("unclaim: %v", err)
	}
	usedBy, usedAt := inviteState(t, q, inviteID)
	if usedBy != nil || usedAt != nil {
		t.Errorf("pending claim must be released, got used_by=%v used_at=%v", usedBy, usedAt)
	}
}

// TestReleaseInviteCodeForUser_UndoesOwnFinalize is the regression test for the
// register-rollback path.
//
// rollbackUser compensates past its OWN successful FinalizeInviteCode, so by
// then used_by is set and UnclaimInviteCode deliberately refuses to touch the
// row. Using the plain unclaim there made the rollback a no-op, and the
// DeleteUser that follows then NULLed used_by via the FK while leaving used_at
// stamped — a state ClaimInviteCode (which requires used_at IS NULL) can never
// claim again. The invite was destroyed rather than returned.
func TestReleaseInviteCodeForUser_UndoesOwnFinalize(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	newUser := seedTestUser(t, q)

	inviteID := seedInviteCode(t, q, owner)
	if _, err := q.pool.Exec(ctx, `UPDATE invite_codes SET used_at = NOW() WHERE id = $1`, inviteID); err != nil {
		t.Fatalf("mark claimed: %v", err)
	}
	if err := q.FinalizeInviteCode(ctx, inviteID, newUser); err != nil {
		t.Fatalf("finalize: %v", err)
	}

	if err := q.ReleaseInviteCodeForUser(ctx, inviteID, newUser); err != nil {
		t.Fatalf("release: %v", err)
	}
	usedBy, usedAt := inviteState(t, q, inviteID)
	if usedBy != nil || usedAt != nil {
		t.Fatalf("invite must be fully released, got used_by=%v used_at=%v", usedBy, usedAt)
	}
	// The point of releasing it is that it becomes usable again.
	var code string
	if err := q.pool.QueryRow(ctx, `SELECT code FROM invite_codes WHERE id = $1`, inviteID).Scan(&code); err != nil {
		t.Fatalf("read code: %v", err)
	}
	if _, err := q.ClaimInviteCode(ctx, code); err != nil {
		t.Errorf("released invite should be claimable again: %v", err)
	}
}

// TestReleaseInviteCodeForUser_WontStealAnotherUsersInvite pins that the
// rollback stays scoped: it can undo this user's finalize, never somebody
// else's redemption. Losing that predicate would reintroduce the
// invite-reopening hole through the rollback door.
func TestReleaseInviteCodeForUser_WontStealAnotherUsersInvite(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	owner := seedTestUser(t, q)
	redeemer := seedTestUser(t, q)
	attacker := seedTestUser(t, q)

	inviteID := seedInviteCode(t, q, owner)
	if _, err := q.pool.Exec(ctx,
		`UPDATE invite_codes SET used_at = NOW(), used_by = $1 WHERE id = $2`, redeemer, inviteID); err != nil {
		t.Fatalf("mark redeemed: %v", err)
	}

	if err := q.ReleaseInviteCodeForUser(ctx, inviteID, attacker); err != nil {
		t.Fatalf("release should be a no-op, not an error: %v", err)
	}
	usedBy, usedAt := inviteState(t, q, inviteID)
	if usedBy == nil || *usedBy != redeemer || usedAt == nil {
		t.Errorf("another user's redemption must be untouched, got used_by=%v used_at=%v", usedBy, usedAt)
	}
}
