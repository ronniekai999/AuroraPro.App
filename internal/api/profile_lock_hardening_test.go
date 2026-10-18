package api

// Tests for the profile-lock fixes a review found: concurrent PIN guesses
// outrunning the attempt limit, a PIN lockout also locking out the account
// password (the recovery path), stale sessions acting as the account default,
// OAuth linking from a restricted session, and the gates failing open.
// Opt-in via TEST_DATABASE_URL.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func lockTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// TestConcurrentPINGuessesCannotOutrunTheLimit: an attempt used to be counted
// only after its argon2 check, so a burst all passed the lockout read first
// (a review drove 40 through a limit of 5, and a right guess among them won).
// Now each attempt is counted before it is checked.
func TestConcurrentPINGuessesCannotOutrunTheLimit(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")

	const burst = 20
	codes := make([]int, burst)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < burst; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes[i], _, _ = f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"0000"}`)
		}(i)
	}
	close(start)
	wg.Wait()

	checked := 0
	for _, c := range codes {
		if c == http.StatusForbidden {
			checked++
		}
	}
	if checked > profilePINMaxFailures-1 {
		t.Errorf("%d of %d concurrent wrong PINs were checked and refused as wrong; at most %d may be before the lockout",
			checked, burst, profilePINMaxFailures-1)
	}
	var attempts int
	if err := lockTestPool(t).QueryRow(context.Background(),
		`SELECT pin_failed_attempts FROM user_profiles WHERE id = $1`, f.parent.ID).Scan(&attempts); err != nil {
		t.Fatalf("read attempts: %v", err)
	}
	if attempts != profilePINMaxFailures {
		t.Errorf("pin_failed_attempts = %d after a burst of %d, want exactly the limit %d", attempts, burst, profilePINMaxFailures)
	}
	// The right PIN during the lockout is not even checked.
	if code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"4321"}`); code != http.StatusTooManyRequests || reason != "profile_pin_locked" {
		t.Errorf("the right PIN during a lockout: %d %q, want 429 profile_pin_locked", code, reason)
	}
}

// TestThePasswordStillUnlocksDuringAPINLockout: the account password is the
// recovery path, and PIN guesses used to lock it out too, so anyone on the
// account could keep the owner out (one wrong guess per lockout re-locks) and
// stop them even changing the PIN.
func TestThePasswordStillUnlocksDuringAPINLockout(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	for i := 0; i < profilePINMaxFailures; i++ {
		f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"0000"}`)
	}
	if code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"0000"}`); code != http.StatusTooManyRequests {
		t.Fatalf("precondition: PIN entry should be locked out, got %d %q", code, reason)
	}

	// The owner, on the parent profile, changes the PIN with the password.
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.parent.ID,
		`{"pin":"9876","password":"`+lockTestPassword+`"}`); code != http.StatusOK {
		t.Fatalf("changing the PIN with the password during a lockout: %d %s", code, body)
	}
	// Setting it cleared the lockout, and the new PIN works.
	if code, _, body := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"9876"}`); code != http.StatusOK {
		t.Errorf("the new PIN after a password reset: %d %s", code, body)
	}
}

// TestThePasswordHasItsOwnBudget: password attempts are limited per account,
// separately from PIN attempts, so the password is no unlimited side door.
func TestThePasswordHasItsOwnBudget(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	for i := 0; i < profilePasswordAttempts; i++ {
		if code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"password":"guess"}`); code != http.StatusForbidden || reason != "profile_pin_invalid" {
			t.Fatalf("wrong password %d: %d %q, want 403 profile_pin_invalid", i+1, code, reason)
		}
	}
	if code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID,
		`{"password":"`+lockTestPassword+`"}`); code != http.StatusTooManyRequests || reason != "profile_pin_locked" {
		t.Errorf("a password attempt past the budget: %d %q, want 429 profile_pin_locked", code, reason)
	}
	// PIN entry is a separate budget and still open.
	if code, _, body := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"4321"}`); code != http.StatusOK {
		t.Errorf("the right PIN after the password budget ran out: %d %s", code, body)
	}
}

// TestAnUnboundTokenNeitherSkipsThePINNorClaimsABinding: a token without a
// session row cannot be bound. It used to answer 200 "activated locally",
// which clients now read as a confirmed switch; the PIN check runs first.
func TestAnUnboundTokenNeitherSkipsThePINNorClaimsABinding(t *testing.T) {
	f := newLockFixture(t)
	// An unbound token acts as the default (parent) profile, so lock the kid:
	// a profile the token is not already acting as.
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.kid.ID, `{"pin":"2468"}`); code != http.StatusOK {
		t.Fatalf("lock the kid profile: %d %s", code, body)
	}
	if code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, 0, f.kid.ID, ""); code != http.StatusForbidden || reason != "profile_pin_required" {
		t.Errorf("unbound token, locked profile, no PIN: %d %q, want 403 profile_pin_required", code, reason)
	}
	if code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, 0, f.kid.ID, `{"pin":"2468"}`); code != http.StatusConflict || reason != "session_unbound" {
		t.Errorf("unbound token, right PIN: %d %q, want 409 session_unbound (nothing to bind)", code, reason)
	}
}

// TestProfileManagementFailsClosedWhenTheActingProfileIsUnknown.
func TestProfileManagementFailsClosedWhenTheActingProfileIsUnknown(t *testing.T) {
	f := newLockFixture(t)
	f.h.resolveActing = func(context.Context, int64, int64) (*models.UserProfile, error) {
		return nil, errors.New("database down")
	}
	if code, _, body := f.call(t, f.h.CreateProfile, http.MethodPost, f.kidRT, 0, `{"name":"escape"}`); code != http.StatusInternalServerError {
		t.Errorf("create with the acting profile unknown: %d %s, want 500", code, body)
	}
	if code, _, body := f.call(t, f.h.UpdateProfile, http.MethodPut, f.kidRT, f.kid.ID, `{"max_age_rating":""}`); code != http.StatusInternalServerError {
		t.Errorf("lifting a ceiling with the acting profile unknown: %d %s, want 500", code, body)
	}
}

// TestAStaleSessionActsAsTheMostRestrictiveProfile: the hourly purge deleted
// revoked session rows while their access tokens were still valid, and the
// lookup then fell back to the account default, so a kid's stale token could
// lift its own ceiling. Revoked rows are now kept past the access-token
// lifetime, and a missing row resolves to the most restrictive profile.
func TestAStaleSessionActsAsTheMostRestrictiveProfile(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)

	// Revoke the kid's session as rotation would. The purge keeps it while
	// its access tokens can still be valid.
	if _, err := pool.Exec(ctx, `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE id = $1`, f.kidRT); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := f.q.PurgeExpiredTokens(ctx, 15*time.Minute); err != nil {
		t.Fatalf("purge: %v", err)
	}
	// Checked directly: the missing-row fallback below would also give the
	// kid here, and hide a purge that deleted the row.
	var kept int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM refresh_tokens WHERE id = $1`, f.kidRT).Scan(&kept); err != nil || kept != 1 {
		t.Errorf("the purge deleted a session revoked moments ago (rows left %d, err %v); its access tokens are still valid", kept, err)
	}
	if got := f.acting(t, f.kidRT); got != f.kid.ID {
		t.Errorf("a just-revoked kid session acts as %d after the purge, want the kid %d", got, f.kid.ID)
	}

	// Revoked long ago: purged, and the token then acts as the most
	// restrictive profile, never the default parent.
	if _, err := pool.Exec(ctx, `UPDATE refresh_tokens SET revoked_at = NOW() - interval '1 hour' WHERE id = $1`, f.kidRT); err != nil {
		t.Fatalf("age the revocation: %v", err)
	}
	if _, err := f.q.PurgeExpiredTokens(ctx, 15*time.Minute); err != nil {
		t.Fatalf("purge: %v", err)
	}
	var left int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM refresh_tokens WHERE id = $1`, f.kidRT).Scan(&left); err != nil || left != 0 {
		t.Fatalf("precondition: the old revoked row should be purged (left %d, err %v)", left, err)
	}
	if got := f.acting(t, f.kidRT); got != f.kid.ID {
		t.Errorf("a purged kid session acts as %d, want the most restrictive profile, the kid %d", got, f.kid.ID)
	}
	if code, reason, _ := f.call(t, f.h.UpdateProfile, http.MethodPut, f.kidRT, f.kid.ID, `{"max_age_rating":""}`); code != http.StatusForbidden || reason != "profile_restricted" {
		t.Errorf("a purged kid session lifting its ceiling: %d %q, want 403 profile_restricted", code, reason)
	}
}

// TestActivationRefusesARotatedSession: binding the revoked row reported
// success while rotation had already copied the old binding to its successor,
// so the session kept the previous profile.
func TestActivationRefusesARotatedSession(t *testing.T) {
	f := newLockFixture(t)
	if _, err := lockTestPool(t).Exec(context.Background(),
		`UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE id = $1`, f.parentRT); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if code, _, body := f.call(t, f.h.ActivateProfile, http.MethodPost, f.parentRT, f.kid.ID, ""); code != http.StatusConflict {
		t.Errorf("activating on a rotated session: %d %s, want 409", code, body)
	}
}

// TestDeletingAProfileEndsItsSessions: the binding's foreign key nulls the
// session, and an unbound session acts as the default, so a deleted kid
// profile's devices woke up on the parent's profile.
func TestDeletingAProfileEndsItsSessions(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	if code, _, body := f.call(t, f.h.DeleteProfile, http.MethodDelete, f.parentRT, f.kid.ID, ""); code != http.StatusOK && code != http.StatusNoContent {
		t.Fatalf("delete the kid profile: %d %s", code, body)
	}
	var left int
	if err := lockTestPool(t).QueryRow(context.Background(), `SELECT count(*) FROM refresh_tokens WHERE id = $1`, f.kidRT).Scan(&left); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if left != 0 {
		t.Errorf("the deleted profile's session survived (%d rows); its device would act as the default", left)
	}
}

// TestARestrictedSessionCannotLinkASignInIdentity: a fresh sign-in through a
// linked identity lands on the account default without that profile's PIN.
func TestARestrictedSessionCannotLinkASignInIdentity(t *testing.T) {
	f := newLockFixture(t)
	h := NewOAuthHandler(f.q, healthTestService(), nil)
	for name, handler := range map[string]http.HandlerFunc{"link": h.StartLink, "unlink": h.Unlink} {
		run := func(rt int64) *httptest.ResponseRecorder {
			r := httptest.NewRequest(http.MethodPost, "/api/auth/oauth/nowhere/link", nil)
			rctx := chi.NewRouteContext()
			rctx.URLParams.Add("provider", "nowhere")
			r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
			rr := httptest.NewRecorder()
			handler(rr, rcClaimsCtx(r, f.userID, rt))
			return rr
		}
		if rr := run(f.kidRT); rr.Code != http.StatusForbidden || errorReasonOf(rr) != "profile_restricted" {
			t.Errorf("%s from the kid session: %d %q, want 403 profile_restricted", name, rr.Code, errorReasonOf(rr))
		}
		// The parent passes the gate and reaches provider resolution.
		if rr := run(f.parentRT); rr.Code == http.StatusForbidden {
			t.Errorf("%s from the parent session was refused: %d %s", name, rr.Code, rr.Body.String())
		}
	}
}

func errorReasonOf(rr *httptest.ResponseRecorder) string {
	var env struct {
		Error struct {
			Reason string `json:"reason"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &env)
	return env.Error.Reason
}
