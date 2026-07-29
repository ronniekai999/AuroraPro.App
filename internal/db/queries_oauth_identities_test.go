package db

// Integration tests for the multi-provider OAuth identities table
// (migration 031). They exercise AddOAuthIdentity / RemoveOAuthIdentity /
// ListOAuthIdentities / CountOAuthIdentities / CreateOAuthUserWithIdentity plus
// the two conflict sentinels and the "fill/clear the legacy mirror columns"
// behavior against a real Postgres.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise (see
// requireIntegrationDB in queries_jsonb_integration_test.go, reused here).
// Schema is assumed already migrated. Every fixture is created with a random
// suffix and cleaned up via t.Cleanup (CASCADE on the FK reaps identity rows
// when the user is deleted, so even a forgotten cleanup self-heals).

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// seedOAuthTestUser inserts a user with the given password_hash (pass "" for an
// OAuth-only user) and registers cleanup. Separate from seedTestUser so we can
// control password presence — the lockout/mirror behaviors depend on it.
func seedOAuthTestUser(t *testing.T, q *Queries, passwordHash string) int64 {
	t.Helper()
	suffix := randomSuffix(t)
	var id int64
	err := q.pool.QueryRow(context.Background(),
		`INSERT INTO users (username, email, password_hash)
		 VALUES ($1, $2, $3) RETURNING id`,
		"oauth_id_test_"+suffix,
		"oauth_id_test_"+suffix+"@example.com",
		passwordHash,
	).Scan(&id)
	if err != nil {
		t.Fatalf("seed oauth test user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

// legacyOAuthColumns reads the users.oauth_provider/oauth_subject mirror.
func legacyOAuthColumns(t *testing.T, q *Queries, userID int64) (provider, subject string) {
	t.Helper()
	var p, s *string
	err := q.pool.QueryRow(context.Background(),
		`SELECT oauth_provider, oauth_subject FROM users WHERE id = $1`, userID,
	).Scan(&p, &s)
	if err != nil {
		t.Fatalf("read legacy columns: %v", err)
	}
	if p != nil {
		provider = *p
	}
	if s != nil {
		subject = *s
	}
	return provider, subject
}

func TestAddOAuthIdentity_BasicAndMirror(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	// OAuth-only user (empty password): the mirror columns start empty so the
	// first AddOAuthIdentity should fill them.
	userID := seedOAuthTestUser(t, q, "")
	subj := "sub_" + randomSuffix(t)

	if err := q.AddOAuthIdentity(ctx, userID, "google", subj); err != nil {
		t.Fatalf("AddOAuthIdentity (first): %v", err)
	}
	// Resolution via the authoritative table.
	u, err := q.GetUserByOAuthIdentity(ctx, "google", subj)
	if err != nil {
		t.Fatalf("GetUserByOAuthIdentity: %v", err)
	}
	if u == nil || u.ID != userID {
		t.Fatalf("GetUserByOAuthIdentity = %+v, want user %d", u, userID)
	}
	// Legacy mirror filled (primary identity).
	if p, s := legacyOAuthColumns(t, q, userID); p != "google" || s != subj {
		t.Errorf("legacy mirror = (%q,%q), want (google,%q)", p, s, subj)
	}

	// Idempotent re-link of the SAME identity returns nil (no error).
	if err := q.AddOAuthIdentity(ctx, userID, "google", subj); err != nil {
		t.Errorf("AddOAuthIdentity (idempotent re-link) = %v, want nil", err)
	}

	// Linking a SECOND provider must NOT overwrite the mirror (it stays the
	// primary google identity) but MUST be resolvable.
	subj2 := "sub2_" + randomSuffix(t)
	if err := q.AddOAuthIdentity(ctx, userID, "discord", subj2); err != nil {
		t.Fatalf("AddOAuthIdentity (second provider): %v", err)
	}
	if p, s := legacyOAuthColumns(t, q, userID); p != "google" || s != subj {
		t.Errorf("legacy mirror after 2nd provider = (%q,%q), want unchanged (google,%q)", p, s, subj)
	}
	u2, err := q.GetUserByOAuthIdentity(ctx, "discord", subj2)
	if err != nil || u2 == nil || u2.ID != userID {
		t.Fatalf("GetUserByOAuthIdentity(discord) = %+v, err=%v, want user %d", u2, err, userID)
	}

	if n, err := q.CountOAuthIdentities(ctx, userID); err != nil || n != 2 {
		t.Errorf("CountOAuthIdentities = %d (err=%v), want 2", n, err)
	}
}

func TestAddOAuthIdentity_ConflictSentinels(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userA := seedOAuthTestUser(t, q, "")
	userB := seedOAuthTestUser(t, q, "hash")
	subj := "sub_" + randomSuffix(t)

	if err := q.AddOAuthIdentity(ctx, userA, "google", subj); err != nil {
		t.Fatalf("seed link on userA: %v", err)
	}

	// Cross-user conflict: userB tries to claim the same (google, subj) that
	// userA owns → ErrOAuthIdentityConflict.
	if err := q.AddOAuthIdentity(ctx, userB, "google", subj); !errors.Is(err, ErrOAuthIdentityConflict) {
		t.Errorf("cross-user link = %v, want ErrOAuthIdentityConflict", err)
	}

	// Same-user, same-provider, DIFFERENT subject → ErrOAuthProviderAlreadyLinked.
	if err := q.AddOAuthIdentity(ctx, userA, "google", "other_"+randomSuffix(t)); !errors.Is(err, ErrOAuthProviderAlreadyLinked) {
		t.Errorf("second google on same user = %v, want ErrOAuthProviderAlreadyLinked", err)
	}
}

func TestRemoveOAuthIdentity(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedOAuthTestUser(t, q, "")
	gSub := "g_" + randomSuffix(t)
	dSub := "d_" + randomSuffix(t)
	if err := q.AddOAuthIdentity(ctx, userID, "google", gSub); err != nil {
		t.Fatalf("link google: %v", err)
	}
	if err := q.AddOAuthIdentity(ctx, userID, "discord", dSub); err != nil {
		t.Fatalf("link discord: %v", err)
	}

	// Removing the PRIMARY provider (google, which filled the mirror) clears
	// the legacy mirror columns.
	removed, err := q.RemoveOAuthIdentity(ctx, userID, "google")
	if err != nil || !removed {
		t.Fatalf("RemoveOAuthIdentity(google) = (%v,%v), want (true,nil)", removed, err)
	}
	if p, s := legacyOAuthColumns(t, q, userID); p != "" || s != "" {
		t.Errorf("legacy mirror after removing primary = (%q,%q), want empty", p, s)
	}
	// google no longer resolves; discord still does.
	if u, _ := q.GetUserByOAuthIdentity(ctx, "google", gSub); u != nil {
		t.Errorf("google still resolves after removal: %+v", u)
	}
	if u, _ := q.GetUserByOAuthIdentity(ctx, "discord", dSub); u == nil || u.ID != userID {
		t.Errorf("discord should still resolve after removing google")
	}

	// Removing a provider the user doesn't have returns (false, nil).
	if removed, err := q.RemoveOAuthIdentity(ctx, userID, "twitch"); err != nil || removed {
		t.Errorf("RemoveOAuthIdentity(unlinked) = (%v,%v), want (false,nil)", removed, err)
	}
}

func TestListOAuthIdentities_Order(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedOAuthTestUser(t, q, "hash")
	// Link google then discord; ListOAuthIdentities orders by created_at ASC,
	// so google (first) comes first.
	if err := q.AddOAuthIdentity(ctx, userID, "google", "g_"+randomSuffix(t)); err != nil {
		t.Fatalf("link google: %v", err)
	}
	if err := q.AddOAuthIdentity(ctx, userID, "discord", "d_"+randomSuffix(t)); err != nil {
		t.Fatalf("link discord: %v", err)
	}
	ids, err := q.ListOAuthIdentities(ctx, userID)
	if err != nil {
		t.Fatalf("ListOAuthIdentities: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("ListOAuthIdentities len = %d, want 2", len(ids))
	}
	if ids[0].Provider != "google" || ids[1].Provider != "discord" {
		t.Errorf("order = [%s,%s], want [google,discord]", ids[0].Provider, ids[1].Provider)
	}
	if ids[0].CreatedAt.IsZero() {
		t.Errorf("expected non-zero created_at on listed identity")
	}
}

func TestCreateOAuthUserWithIdentity(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	suffix := randomSuffix(t)
	username := "owi_" + suffix
	email := "owi_" + suffix + "@example.com"
	subj := "owi_sub_" + suffix

	user, err := q.CreateOAuthUserWithIdentity(ctx, username, email, "", "google", subj, false)
	if err != nil {
		t.Fatalf("CreateOAuthUserWithIdentity: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, user.ID) })
	if user.ID == 0 {
		t.Fatal("CreateOAuthUserWithIdentity returned user with zero ID")
	}
	// Empty password (OAuth-only) + legacy mirror set.
	if user.PasswordHash != "" {
		t.Errorf("password_hash = %q, want empty for OAuth user", user.PasswordHash)
	}
	if p, s := legacyOAuthColumns(t, q, user.ID); p != "google" || s != subj {
		t.Errorf("legacy mirror = (%q,%q), want (google,%q)", p, s, subj)
	}
	// The identity row exists and resolves back to this user (the whole point
	// of the atomic create — no user without an identity).
	got, err := q.GetUserByOAuthIdentity(ctx, "google", subj)
	if err != nil || got == nil || got.ID != user.ID {
		t.Fatalf("GetUserByOAuthIdentity after create = %+v (err=%v), want user %d", got, err, user.ID)
	}

	// A username collision propagates a *pgconn.PgError with code 23505 so the
	// caller's email-vs-username disambiguation + retry loop still works.
	_, cerr := q.CreateOAuthUserWithIdentity(ctx, username, "different_"+suffix+"@example.com", "", "discord", "x_"+suffix, false)
	var pgErr *pgconn.PgError
	if !errors.As(cerr, &pgErr) || pgErr.Code != "23505" {
		t.Errorf("duplicate-username create error = %v, want *pgconn.PgError code 23505", cerr)
	}

	// referralPending=false writes NULL, i.e. "never eligible" — the same state
	// every password signup lands in by not naming the column at all.
	// Not returned by design (see the pending test); assert against the row.
	if st, serr := q.GetReferralStatus(ctx, user.ID); serr != nil || st != "" {
		t.Errorf("referral status = (%q, %v), want (\"\", nil) for referralPending=false", st, serr)
	}
}

// TestCreateOAuthUserWithIdentity_ReferralPending pins the referral stamp
// (migration 046): eligibility is written INSIDE the create transaction, so a
// new user can never exist in the eligible-but-unmarked state that would let
// the prompt be silently skipped. The follow-up resolve is exercised here too,
// because its "only if still pending" predicate is the entire idempotency
// mechanism behind POST /api/me/referral.
func TestCreateOAuthUserWithIdentity_ReferralPending(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	suffix := randomSuffix(t)

	user, err := q.CreateOAuthUserWithIdentity(ctx,
		"ref_"+suffix, "ref_"+suffix+"@example.com", "", "google", "ref_sub_"+suffix, true)
	if err != nil {
		t.Fatalf("CreateOAuthUserWithIdentity: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, user.ID) })

	// Read the stamp back rather than off the returned struct: the INSERT
	// deliberately does NOT return referral_status, because the caller marshals
	// this struct into localStorage and that would create a second, instantly
	// stale answer to a question only GET /api/me/referral-prompt may answer.
	if user.ReferralStatus != nil {
		t.Errorf("referral_status = %q on the returned user; it must not be returned",
			*user.ReferralStatus)
	}
	status, err := q.GetReferralStatus(ctx, user.ID)
	if err != nil || status != "pending" {
		t.Fatalf("GetReferralStatus = (%q, %v), want (\"pending\", nil)", status, err)
	}

	detail := "a podcast ad"
	resolved, err := q.ResolveReferral(ctx, user.ID, "answered", "other", &detail)
	if err != nil || !resolved {
		t.Fatalf("ResolveReferral = (%v, %v), want (true, nil)", resolved, err)
	}

	// Second submit — the double-tap a slow network produces. It must report
	// "didn't land" rather than erroring or overwriting the real answer.
	resolved, err = q.ResolveReferral(ctx, user.ID, "skipped", "", nil)
	if err != nil {
		t.Fatalf("second ResolveReferral errored: %v", err)
	}
	if resolved {
		t.Error("second ResolveReferral reported a write — the pending predicate didn't hold")
	}
	var gotStatus, gotSource, gotDetail *string
	if err := q.pool.QueryRow(ctx,
		`SELECT referral_status, referral_source, referral_detail FROM users WHERE id = $1`, user.ID,
	).Scan(&gotStatus, &gotSource, &gotDetail); err != nil {
		t.Fatalf("read back referral columns: %v", err)
	}
	if gotStatus == nil || *gotStatus != "answered" || gotSource == nil || *gotSource != "other" {
		t.Errorf("after double-submit: status=%s source=%s, want answered/other", derefOr(gotStatus), derefOr(gotSource))
	}
	if gotDetail == nil || *gotDetail != detail {
		t.Errorf("detail = %s, want %q", derefOr(gotDetail), detail)
	}

	// A user who was never eligible cannot be resolved into an answer.
	other := seedOAuthTestUser(t, q, "hash")
	resolved, err = q.ResolveReferral(ctx, other, "answered", "twitch", nil)
	if err != nil {
		t.Fatalf("ResolveReferral on ineligible user errored: %v", err)
	}
	if resolved {
		t.Error("resolved a user whose referral_status was NULL — eligibility isn't being enforced")
	}
}

// TestFinalizeInviteCodeRejectsUnknownClaim pins the invite gate against a
// forged claim id.
//
// The id reaches the server in aurora_oauth_invite_claim, a plain unsigned
// integer cookie that any client can set on its own request. resolveOAuthUser's
// tier-3 check only asks whether it is > 0, so the finalize is the ONLY thing
// standing between a made-up number and an account created without an invite.
// While this returned nil on a zero-row update, the rollback that exists for
// exactly this case never fired and the signup succeeded.
func TestFinalizeInviteCodeRejectsUnknownClaim(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	user := seedOAuthTestUser(t, q, "hash")

	// A claim id that was never issued: must be refused, so the OAuth callback
	// rolls the new user back rather than enrolling them.
	if err := q.FinalizeInviteCode(ctx, 999999999, user); err == nil {
		t.Error("finalizing a nonexistent claim succeeded — a forged cookie would bypass the invite gate")
	}

	// The legitimate path still works: claim → finalize.
	var inviteID int64
	code := "code_" + randomSuffix(t)
	if err := q.pool.QueryRow(ctx,
		`INSERT INTO invite_codes (code, created_by, expires_at)
		 VALUES ($1, $2, NOW() + INTERVAL '7 days') RETURNING id`, code, user,
	).Scan(&inviteID); err != nil {
		t.Fatalf("seed invite: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM invite_codes WHERE id = $1`, inviteID) })

	claimed, err := q.ClaimInviteCode(ctx, code)
	if err != nil || claimed != inviteID {
		t.Fatalf("ClaimInviteCode = (%d, %v), want (%d, nil)", claimed, err, inviteID)
	}
	if err := q.FinalizeInviteCode(ctx, claimed, user); err != nil {
		t.Fatalf("finalizing a real claim failed: %v", err)
	}
	var usedBy *int64
	if err := q.pool.QueryRow(ctx, `SELECT used_by FROM invite_codes WHERE id = $1`, inviteID).Scan(&usedBy); err != nil {
		t.Fatalf("read back invite: %v", err)
	}
	if usedBy == nil || *usedBy != user {
		t.Errorf("used_by = %v, want %d", usedBy, user)
	}
}

// TestReferralSummaryBuckets pins the aggregate the admin panel reads: the
// three status buckets must partition the eligible users, and the per-source
// breakdown must sum to the answered count — including for a key whose option
// was deleted, which must still be reported rather than silently dropped.
func TestReferralSummaryBuckets(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	suffix := randomSuffix(t)

	seed := func(name, status string, source *string) {
		var id int64
		if err := q.pool.QueryRow(ctx,
			`INSERT INTO users (username, email, password_hash, referral_status, referral_source)
			 VALUES ($1, $2, '', $3, $4) RETURNING id`,
			name+"_"+suffix, name+"_"+suffix+"@example.com", status, source,
		).Scan(&id); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
		t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id) })
	}
	twitch, gone := "twitch", "myspace"
	seed("rs_a", "answered", &twitch)
	seed("rs_b", "answered", &twitch)
	seed("rs_c", "answered", &gone)
	seed("rs_d", "skipped", nil)
	seed("rs_e", "pending", nil)

	sum, err := q.ReferralSummary(ctx, 0)
	if err != nil {
		t.Fatalf("ReferralSummary: %v", err)
	}
	if sum.Answered+sum.Skipped+sum.Pending != sum.Total {
		t.Errorf("buckets don't partition: %d+%d+%d != %d",
			sum.Answered, sum.Skipped, sum.Pending, sum.Total)
	}
	var bySource int64
	seen := map[string]int64{}
	for _, row := range sum.BySource {
		bySource += row.Count
		seen[row.Key] = row.Count
	}
	if bySource != sum.Answered {
		t.Errorf("sum(by_source) = %d, want answered = %d", bySource, sum.Answered)
	}
	if seen["twitch"] < 2 {
		t.Errorf("twitch count = %d, want at least the 2 seeded", seen["twitch"])
	}
	// The deleted-option key is still counted; the handler labels it later.
	if seen["myspace"] < 1 {
		t.Error("a source whose option was deleted was dropped from the breakdown")
	}

	// A window still partitions (everything just created falls inside it).
	windowed, err := q.ReferralSummary(ctx, 7)
	if err != nil {
		t.Fatalf("ReferralSummary(7): %v", err)
	}
	if windowed.Answered+windowed.Skipped+windowed.Pending != windowed.Total {
		t.Error("windowed buckets don't partition")
	}
	if windowed.WindowDays != 7 {
		t.Errorf("window_days = %d, want 7", windowed.WindowDays)
	}
}

// TestReferralDetailRequiresOtherSource pins the schema CHECK from migration
// 046: referral_detail may only accompany source 'other'. The API validator
// enforces the same rule, and this is the backstop that keeps the two from
// drifting.
func TestReferralDetailRequiresOtherSource(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	suffix := randomSuffix(t)
	user, err := q.CreateOAuthUserWithIdentity(ctx,
		"refchk_"+suffix, "refchk_"+suffix+"@example.com", "", "google", "refchk_sub_"+suffix, true)
	if err != nil {
		t.Fatalf("CreateOAuthUserWithIdentity: %v", err)
	}
	t.Cleanup(func() { _, _ = q.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, user.ID) })

	detail := "should be refused"
	if _, err := q.ResolveReferral(ctx, user.ID, "answered", "twitch", &detail); err == nil {
		t.Error("detail alongside a non-other source was accepted — the CHECK constraint is missing")
	}
}

// TestCreateOAuthUserWithIdentity_AtomicRollback verifies the transaction rolls
// back the user INSERT when the identity INSERT collides — no orphan user is
// left behind. We pre-link (provider, subject) to one user, then attempt a NEW
// user with that same identity: the user INSERT succeeds inside the tx but the
// identity INSERT violates idx_oauth_identities_provider_subject, so the whole
// tx aborts and the new username must NOT exist afterward.
func TestCreateOAuthUserWithIdentity_AtomicRollback(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	existing := seedOAuthTestUser(t, q, "hash")
	subj := "shared_" + randomSuffix(t)
	if err := q.AddOAuthIdentity(ctx, existing, "google", subj); err != nil {
		t.Fatalf("seed identity: %v", err)
	}

	newUsername := "rollback_" + randomSuffix(t)
	_, err := q.CreateOAuthUserWithIdentity(ctx, newUsername, newUsername+"@example.com", "", "google", subj, true)
	if err == nil {
		t.Fatal("expected error from duplicate identity, got nil")
	}
	// The user row must have been rolled back.
	u, lerr := q.GetUserByUsername(ctx, newUsername)
	if lerr != nil {
		t.Fatalf("GetUserByUsername: %v", lerr)
	}
	if u != nil {
		t.Errorf("orphan user %q exists after failed atomic create — rollback didn't fire", newUsername)
		_, _ = q.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, u.ID)
	}
}

// derefOr renders a nullable text column for a failure message. Formatting a
// *string with %v prints the pointer address, which is exactly the information
// a diagnostic message must not be.
func derefOr(s *string) string {
	if s == nil {
		return "<NULL>"
	}
	return *s
}
