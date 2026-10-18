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
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
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
	// The refusals changed nothing.
	profiles, err := f.q.GetProfilesByUser(context.Background(), f.userID)
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 2 {
		t.Errorf("the account has %d profiles after the refused create, want 2", len(profiles))
	}
	if kid, err := f.q.GetProfile(context.Background(), f.kid.ID); err != nil || kid == nil || kid.MaxAgeRating != "PG" {
		t.Errorf("the kid's ceiling after the refused edit: %+v (err %v), want PG", kid, err)
	}
}

// TestAStoredUnknownCeilingCannotBeCleared: a stored ceiling the ladder does
// not know restricts to the all-ages tier. A restricted session may re-send
// its own unchanged ceiling, and an unknown one must not read as "no
// ceiling" when compared, or the kid could clear it by sending none.
func TestAStoredUnknownCeilingCannotBeCleared(t *testing.T) {
	f := newLockFixture(t)
	if _, err := lockTestPool(t).Exec(context.Background(), `UPDATE user_profiles SET max_age_rating = 'PG13' WHERE id = $1`, f.kid.ID); err != nil {
		t.Fatalf("store an unknown ceiling: %v", err)
	}
	if code, reason, _ := f.call(t, f.h.UpdateProfile, http.MethodPut, f.kidRT, f.kid.ID, `{"max_age_rating":""}`); code != http.StatusForbidden || reason != "profile_restricted" {
		t.Errorf("the kid clearing its unknown ceiling: %d %q, want 403 profile_restricted", code, reason)
	}
	if kid, err := f.q.GetProfile(context.Background(), f.kid.ID); err != nil || kid == nil || kid.MaxAgeRating == "" {
		t.Errorf("the kid's ceiling after the refused clear: %+v (err %v)", kid, err)
	}
}

// TestActivationFailsClosedWhenTheActingProfileIsUnknown: activation skips
// the PIN for the profile the session already acts as, so a lookup error
// that fell back to "no acting profile check" would skip it for any.
func TestActivationFailsClosedWhenTheActingProfileIsUnknown(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	f.h.resolveActing = func(context.Context, int64, int64) (*models.UserProfile, error) {
		return nil, errors.New("database down")
	}
	if code, _, body := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, ""); code != http.StatusInternalServerError {
		t.Errorf("activating the locked parent with the acting profile unknown: %d %s, want 500", code, body)
	}
	if got := f.acting(t, f.kidRT); got != f.kid.ID {
		t.Errorf("the kid's session now acts as profile %d, want the kid (%d)", got, f.kid.ID)
	}
}

// failingActingResolver fails every lookup.
type failingActingResolver struct{}

func (failingActingResolver) ResolveActingProfile(context.Context, int64, int64) (*models.UserProfile, error) {
	return nil, errors.New("database down")
}

func (failingActingResolver) SessionLive(context.Context, int64, int64) (bool, error) {
	return true, nil
}

func TestDenyRestrictedSessionFailsClosed(t *testing.T) {
	rr := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/x", nil)
	if !denyRestrictedSession(rr, r, failingActingResolver{}, &auth.JWTClaims{UserID: 1, RefreshTokenID: 2}, "do this") {
		t.Fatal("a lookup error let the action through")
	}
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("status %d, want 500", rr.Code)
	}
}

// TestTheSessionCheckFailsClosed: a failed lookup of the session row refuses
// rather than treating the session as live.
func TestTheSessionCheckFailsClosed(t *testing.T) {
	rr := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/x", nil)
	failing := func(context.Context, int64, int64) (bool, error) { return true, errors.New("database down") }
	if requireLiveSession(rr, r, failing, &auth.JWTClaims{UserID: 1, RefreshTokenID: 2}) {
		t.Fatal("a session lookup error let the request through")
	}
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("status %d, want 500", rr.Code)
	}
}

// TestAStaleSessionActsAsTheTightestCeiling: with several restricted
// profiles, a token whose session row is gone acts as the one with the
// fewest allowed ratings, not whichever the query lists first.
func TestAStaleSessionActsAsTheTightestCeiling(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	// The kid is PG. Add a G profile, which allows fewer ratings, and a
	// PG-13 one after it.
	var tightest int64
	for _, rating := range []string{"G", "PG-13"} {
		p := &models.UserProfile{UserID: f.userID, Name: "kid " + rating, MaxAgeRating: rating, Language: "en", SubtitleMode: "off"}
		if err := f.q.CreateProfile(ctx, p); err != nil {
			t.Fatalf("seed a %s profile: %v", rating, err)
		}
		if rating == "G" {
			tightest = p.ID
		}
	}
	if _, err := lockTestPool(t).Exec(ctx, `DELETE FROM refresh_tokens WHERE id = $1`, f.kidRT); err != nil {
		t.Fatalf("drop the session row: %v", err)
	}
	if got := f.acting(t, f.kidRT); got != tightest {
		t.Errorf("a token with no session row acts as profile %d, want the G profile (%d)", got, tightest)
	}
}

// TestProfileListsReportTheirLock: clients decide whether to ask for a PIN
// from has_pin before they activate.
func TestProfileListsReportTheirLock(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	profiles, err := f.q.GetProfilesByUser(context.Background(), f.userID)
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	for _, p := range profiles {
		if want := p.ID == f.parent.ID; p.HasPIN != want {
			t.Errorf("profile %q has_pin=%v, want %v", p.Name, p.HasPIN, want)
		}
	}
}

// TestRotationStampsWhenTheOldSessionWasRevoked: the purge keeps a revoked
// row until revoked_at is older than the access-token lifetime, so a
// rotation that left revoked_at unset would have the purge delete every
// refreshed row at once, and their access tokens would act as the most
// restrictive profile.
func TestRotationStampsWhenTheOldSessionWasRevoked(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	old := &models.RefreshToken{UserID: f.userID, Token: "rotate-me-" + reqTestSuffix(t), ExpiresAt: time.Now().Add(time.Hour)}
	if err := f.q.CreateRefreshToken(ctx, old); err != nil {
		t.Fatalf("seed a session: %v", err)
	}
	next := &models.RefreshToken{UserID: f.userID, Token: "rotated-" + reqTestSuffix(t), ExpiresAt: time.Now().Add(time.Hour)}
	if _, err := f.q.RotateRefreshToken(ctx, old.Token, next); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	var revoked bool
	var revokedAt *time.Time
	if err := lockTestPool(t).QueryRow(ctx, `SELECT revoked, revoked_at FROM refresh_tokens WHERE id = $1`, old.ID).Scan(&revoked, &revokedAt); err != nil {
		t.Fatalf("read the old session: %v", err)
	}
	if !revoked || revokedAt == nil {
		t.Errorf("after rotation the old session has revoked=%v revoked_at=%v; want both set", revoked, revokedAt)
	}
}

// TestASpentPasswordBudgetDoesNotKeepTheOwnerOut: the password budget was
// per account, so a kid's session spending it every 15 minutes blocked the
// owner's password everywhere, PIN removal included. It is per acting
// profile now.
func TestASpentPasswordBudgetDoesNotKeepTheOwnerOut(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	for i := 0; i <= profilePasswordAttempts; i++ {
		f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"password":"guess"}`)
	}
	if code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID,
		`{"password":"`+lockTestPassword+`"}`); code != http.StatusTooManyRequests || reason != "profile_pin_locked" {
		t.Fatalf("precondition: the kid's session should have spent its budget, got %d %q", code, reason)
	}
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.parent.ID,
		`{"pin":"","password":"`+lockTestPassword+`"}`); code != http.StatusOK {
		t.Errorf("the owner removing the PIN with the password from the parent's session: %d %s", code, body)
	}
}

// TestMakingALockedProfileTheDefaultNeedsItsPIN: a session with no binding
// acts as the default, so re-defaulting onto a locked profile handed it to
// every such session without its PIN.
func TestMakingALockedProfileTheDefaultNeedsItsPIN(t *testing.T) {
	f := newLockFixture(t)
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.kid.ID, `{"pin":"2468"}`); code != http.StatusOK {
		t.Fatalf("lock the kid profile: %d %s", code, body)
	}
	if code, reason, _ := f.call(t, f.h.SetDefault, http.MethodPost, f.parentRT, f.kid.ID, ""); code != http.StatusForbidden || reason != "profile_pin_required" {
		t.Errorf("re-defaulting onto the locked kid with no PIN: %d %q, want 403 profile_pin_required", code, reason)
	}
	if p, err := f.q.GetDefaultProfile(context.Background(), f.userID); err != nil || p == nil || p.ID != f.parent.ID {
		t.Fatalf("the refused re-default moved the default: %+v (err %v)", p, err)
	}
	if code, _, body := f.call(t, f.h.SetDefault, http.MethodPost, f.parentRT, f.kid.ID, `{"pin":"2468"}`); code != http.StatusOK {
		t.Errorf("re-defaulting onto the locked kid with its PIN: %d %s", code, body)
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
	// Profile management refuses a session whose row is gone outright.
	if code, reason, _ := f.call(t, f.h.UpdateProfile, http.MethodPut, f.kidRT, f.kid.ID, `{"max_age_rating":""}`); code != http.StatusUnauthorized || reason != "session_ended" {
		t.Errorf("a purged kid session lifting its ceiling: %d %q, want 401 session_ended", code, reason)
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

// TestAProfilesDeleteTakesEverySessionBoundToIt: DeleteProfile deleted the
// profile's sessions and then the profile, so a session bound to it in
// between (a token refresh, or a switch) kept its row, and the profile's
// delete nulled its binding onto the account default. The binding's foreign
// key now cascades, so the profile's own delete takes every bound row.
func TestAProfilesDeleteTakesEverySessionBoundToIt(t *testing.T) {
	f := newLockFixture(t)
	late := seedRCRefreshToken(t, f.q, f.userID)
	f.bind(t, late, f.kid.ID)
	pool := lockTestPool(t)
	ctx := context.Background()
	// The profile's delete alone, as if the session rows had been bound after
	// DeleteProfile's own clean-up ran.
	if _, err := pool.Exec(ctx, `DELETE FROM user_profiles WHERE id = $1`, f.kid.ID); err != nil {
		t.Fatalf("delete the kid profile: %v", err)
	}
	var kidRows, parentRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE id = ANY($1)), count(*) FILTER (WHERE id = $2)
		FROM refresh_tokens`, []int64{f.kidRT, late}, f.parentRT).Scan(&kidRows, &parentRows); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if kidRows != 0 {
		t.Errorf("%d of the deleted profile's sessions survived; each would act as the account default", kidRows)
	}
	if parentRows != 1 {
		t.Errorf("the parent's session is gone (%d rows); only the deleted profile's should be", parentRows)
	}
}

// TestReDefaultingDoesNotMoveUnboundSessions: a session with no binding acts
// as the default, so re-defaulting moved it onto the new default, a locked
// one included, without its PIN. SetDefault skips the PIN for a caller
// already acting as the target, so the parent could move the kid's unbound
// session onto the parent's locked profile.
func TestReDefaultingDoesNotMoveUnboundSessions(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	ctx := context.Background()
	pool := lockTestPool(t)
	// The kid is the default, and a fresh (unbound) session acts as it.
	for _, step := range []struct {
		sql string
		id  int64
	}{
		{`UPDATE user_profiles SET is_default = FALSE WHERE id = $1`, f.parent.ID},
		{`UPDATE user_profiles SET is_default = TRUE WHERE id = $1`, f.kid.ID},
	} {
		if _, err := pool.Exec(ctx, step.sql, step.id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	unbound := seedRCRefreshToken(t, f.q, f.userID)
	// A rotated row: revoked, but its access tokens still resolve through it.
	rotated := seedRCRefreshToken(t, f.q, f.userID)
	if _, err := pool.Exec(ctx, `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE id = $1`, rotated); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	for _, rt := range []int64{unbound, rotated} {
		if got := f.acting(t, rt); got != f.kid.ID {
			t.Fatalf("precondition: unbound session %d acts as %d, want the kid (%d)", rt, got, f.kid.ID)
		}
	}
	if code, _, body := f.call(t, f.h.SetDefault, http.MethodPost, f.parentRT, f.parent.ID, ""); code != http.StatusOK {
		t.Fatalf("the parent re-defaulting to itself: %d %s", code, body)
	}
	if got := f.acting(t, unbound); got != f.kid.ID {
		t.Errorf("after re-defaulting, the kid's unbound session acts as %d, want still the kid (%d)", got, f.kid.ID)
	}
	if got := f.acting(t, rotated); got != f.kid.ID {
		t.Errorf("after re-defaulting, a rotated unbound session acts as %d, want still the kid (%d)", got, f.kid.ID)
	}
}

// TestAnAccountKeepsAProfileWithoutALimit: only a session acting as a profile
// without a limit can manage profiles, so an account whose every profile had
// one could never lift a limit or add a profile again. Onboarding's age step
// did that to a single-profile account in one move. A limit on, or the delete
// of, the account's last such profile is refused.
func TestAnAccountKeepsAProfileWithoutALimit(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	ceiling := func(id int64) string {
		t.Helper()
		p, err := f.q.GetProfile(ctx, id)
		if err != nil || p == nil {
			t.Fatalf("read profile %d: %v", id, err)
		}
		return p.MaxAgeRating
	}

	// The parent is the only profile without a limit.
	if code, reason, _ := f.call(t, f.h.UpdateProfile, http.MethodPut, f.parentRT, f.parent.ID,
		`{"max_age_rating":"PG"}`); code != http.StatusConflict || reason != "last_unrestricted_profile" {
		t.Errorf("a limit on the last profile without one: %d %q, want 409 last_unrestricted_profile", code, reason)
	}
	if got := ceiling(f.parent.ID); got != "" {
		t.Fatalf("the refused write still set the parent's limit to %q", got)
	}

	// With a second unrestricted profile the parent can take a limit, and the
	// spare is then the last one.
	spare := &models.UserProfile{UserID: f.userID, Name: "spare", Language: "en", SubtitleMode: "off"}
	if err := f.q.CreateProfile(ctx, spare); err != nil {
		t.Fatalf("seed spare profile: %v", err)
	}
	spareRT := seedRCRefreshToken(t, f.q, f.userID)
	f.bind(t, spareRT, spare.ID)
	if code, _, body := f.call(t, f.h.UpdateProfile, http.MethodPut, f.parentRT, f.parent.ID,
		`{"max_age_rating":"TV-14"}`); code != http.StatusOK {
		t.Fatalf("a limit on the parent while the spare has none: %d %s", code, body)
	}
	if code, reason, _ := f.call(t, f.h.UpdateProfile, http.MethodPut, spareRT, spare.ID,
		`{"max_age_rating":"PG"}`); code != http.StatusConflict || reason != "last_unrestricted_profile" {
		t.Errorf("a limit on the spare, now the last without one: %d %q, want 409", code, reason)
	}
	if code, reason, _ := f.call(t, f.h.DeleteProfile, http.MethodDelete, spareRT, spare.ID, ""); code != http.StatusConflict || reason != "last_unrestricted_profile" {
		t.Errorf("deleting the last profile without a limit: %d %q, want 409", code, reason)
	}
	if p, err := f.q.GetProfile(ctx, spare.ID); err != nil || p == nil || p.MaxAgeRating != "" {
		t.Fatalf("the spare after the refusals: %+v, %v; want it kept without a limit", p, err)
	}
	// Clearing a limit is never refused.
	if code, _, body := f.call(t, f.h.UpdateProfile, http.MethodPut, spareRT, f.parent.ID,
		`{"max_age_rating":""}`); code != http.StatusOK {
		t.Errorf("clearing the parent's limit: %d %s", code, body)
	}

	// An account already left with no such profile (data from before the
	// rule) still lets a restricted session save its own settings, which
	// round-trip its unchanged limit.
	if _, err := lockTestPool(t).Exec(ctx,
		`UPDATE user_profiles SET max_age_rating = 'PG' WHERE user_id = $1`, f.userID); err != nil {
		t.Fatalf("restrict every profile: %v", err)
	}
	if code, _, body := f.call(t, f.h.UpdateProfile, http.MethodPut, f.kidRT, f.kid.ID,
		`{"name":"kiddo","max_age_rating":"PG"}`); code != http.StatusOK {
		t.Errorf("a restricted session's own edit, re-sending its limit: %d %s", code, body)
	}
}

// TestTheLastUnrestrictedCheckWaitsForTheAccountLock: two writes, each giving
// a limit to one of the account's last two profiles without one, must not
// both pass. The check locks the account's user row first; here another
// transaction holds a share lock on it while it limits one of them, and the
// write on the other must wait, then see that limit and refuse.
func TestTheLastUnrestrictedCheckWaitsForTheAccountLock(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	spare := &models.UserProfile{UserID: f.userID, Name: "spare", Language: "en", SubtitleMode: "off"}
	if err := f.q.CreateProfile(ctx, spare); err != nil {
		t.Fatalf("seed spare profile: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR SHARE`, f.userID); err != nil {
		t.Fatalf("lock the user row: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE user_profiles SET max_age_rating = 'PG' WHERE id = $1`, spare.ID); err != nil {
		t.Fatalf("limit the spare: %v", err)
	}

	pg := "PG"
	done := make(chan error, 1)
	go func() { done <- f.q.UpdateProfile(ctx, f.parent.ID, &models.UpdateProfileRequest{MaxAgeRating: &pg}) }()
	var result error
	finished := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		select {
		case result = <-done:
			finished = true
		default:
		}
		if finished {
			break
		}
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE OF u%')`).Scan(&waiting); err != nil {
			t.Fatalf("read pg_stat_activity: %v", err)
		}
		if waiting {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if !finished {
		result = <-done
	}
	if !errors.Is(result, db.ErrLastUnrestrictedProfile) {
		t.Errorf("the parent's limit while the spare's was being set: %v; want ErrLastUnrestrictedProfile", result)
	}
	if p, err := f.q.GetProfile(ctx, f.parent.ID); err != nil || p == nil || p.MaxAgeRating != "" {
		t.Errorf("the parent after the race: %+v, %v; want no limit", p, err)
	}
}

// TestAnExpiredLockoutReLocksOnTheNextMiss: the attempt counter is not reset
// when a lockout ends, so after one lockout each further miss locks again.
// The documented guessing rate depends on it.
func TestAnExpiredLockoutReLocksOnTheNextMiss(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	for i := 0; i < profilePINMaxFailures; i++ {
		f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"0000"}`)
	}
	if _, err := lockTestPool(t).Exec(context.Background(),
		`UPDATE user_profiles SET pin_locked_until = NOW() - interval '1 second' WHERE id = $1`, f.parent.ID); err != nil {
		t.Fatalf("end the lockout: %v", err)
	}
	f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"0000"}`)
	if code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"4321"}`); code != http.StatusTooManyRequests || reason != "profile_pin_locked" {
		t.Errorf("the right PIN after one miss past an expired lockout: %d %q, want 429 profile_pin_locked", code, reason)
	}
}

// TestSettingAPINSignsOutTheSessionsActingAsTheProfile: a session already
// acting as a profile skips its PIN, and before the lock any session could
// switch freely, so a kid's device left on the parent's profile kept it
// after the parent locked it, and so did one that had used a leaked PIN once
// the PIN changed. Setting or changing a PIN ends the account's other
// sessions bound to the profile, and the unbound ones (which act as the
// default) when it is the default. Their rows are deleted, revoked ones
// included: a revoked row still resolves to its binding for its access
// token's lifetime, and in that window lifted the kid's ceiling. Clearing a
// PIN ends nothing.
func TestSettingAPINSignsOutTheSessionsActingAsTheProfile(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	ended := func(rt int64) bool {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM refresh_tokens WHERE id = $1`, rt).Scan(&n); err != nil {
			t.Fatalf("read session %d: %v", rt, err)
		}
		return n == 0
	}
	kidOnParent := seedRCRefreshToken(t, f.q, f.userID)
	f.bind(t, kidOnParent, f.parent.ID)
	unbound := seedRCRefreshToken(t, f.q, f.userID)
	// A rotated predecessor still bound to the parent: revoked, retained.
	rotated := seedRCRefreshToken(t, f.q, f.userID)
	f.bind(t, rotated, f.parent.ID)
	if _, err := pool.Exec(ctx, `UPDATE refresh_tokens SET revoked = TRUE, revoked_at = NOW() WHERE id = $1`, rotated); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	f.setPIN(t, "4321")
	if !ended(kidOnParent) || !ended(unbound) || !ended(rotated) {
		t.Errorf("after the parent locked its profile: the device on it ended %v, the unbound one %v, the rotated one %v; want all three gone",
			ended(kidOnParent), ended(unbound), ended(rotated))
	}
	if ended(f.parentRT) || ended(f.kidRT) {
		t.Errorf("the PIN also ended the caller (%v) or the kid's own session (%v)", ended(f.parentRT), ended(f.kidRT))
	}
	// The ended session's still-valid access token acts as the most
	// restrictive profile, and cannot manage profiles at all.
	if got := f.acting(t, kidOnParent); got != f.kid.ID {
		t.Errorf("the ended session's token acts as %d, want the most restrictive profile, the kid (%d)", got, f.kid.ID)
	}
	if code, reason, _ := f.call(t, f.h.UpdateProfile, http.MethodPut, kidOnParent, f.kid.ID, `{"max_age_rating":""}`); code != http.StatusUnauthorized || reason != "session_ended" {
		t.Errorf("the ended session lifting the kid's ceiling: %d %q, want 401 session_ended", code, reason)
	}

	// A device that got in with the PIN is signed out when the PIN changes.
	leaked := seedRCRefreshToken(t, f.q, f.userID)
	if code, _, body := f.call(t, f.h.ActivateProfile, http.MethodPost, leaked, f.parent.ID, `{"pin":"4321"}`); code != http.StatusOK {
		t.Fatalf("unlock with the PIN: %d %s", code, body)
	}
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.parent.ID,
		`{"pin":"9876","current_pin":"4321"}`); code != http.StatusOK {
		t.Fatalf("change the PIN: %d %s", code, body)
	}
	if !ended(leaked) {
		t.Error("a session that unlocked with the old PIN survived the PIN change")
	}

	// Locking a profile that is not the default leaves unbound sessions be.
	unbound2 := seedRCRefreshToken(t, f.q, f.userID)
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.kid.ID, `{"pin":"2468"}`); code != http.StatusOK {
		t.Fatalf("lock the kid: %d %s", code, body)
	}
	if !ended(f.kidRT) || ended(unbound2) || ended(f.parentRT) {
		t.Errorf("after locking the kid: kid's session ended %v, an unbound one %v, the caller %v; want only the kid's",
			ended(f.kidRT), ended(unbound2), ended(f.parentRT))
	}

	// Clearing a PIN ends nothing.
	onKid := seedRCRefreshToken(t, f.q, f.userID)
	f.bind(t, onKid, f.kid.ID)
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.kid.ID,
		`{"pin":"","current_pin":"2468"}`); code != http.StatusOK {
		t.Fatalf("clear the kid's PIN: %d %s", code, body)
	}
	if ended(onKid) {
		t.Error("clearing a PIN signed a session out")
	}
}

// TestAPINWriteWaitsForTheAccountLock: rotation copies a session's binding
// to its successor under the user-row lock, so a PIN write that did not take
// it could end the old row while a new one bound to the profile appeared.
// Here another transaction holds the lock while it binds a new session to
// the kid; the PIN write on the kid must wait, then end that session too.
// (The kid is not the default, so the session's committed, unbound state
// does not match the write, and nothing but the user lock makes it wait.)
func TestAPINWriteWaitsForTheAccountLock(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	successor := seedRCRefreshToken(t, f.q, f.userID)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR SHARE`, f.userID); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE refresh_tokens SET active_profile_id = $2 WHERE id = $1`, successor, f.kid.ID); err != nil {
		t.Fatalf("bind: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := f.q.SetProfilePIN(ctx, f.userID, f.kid.ID, "$argon2id$placeholder", f.parentRT)
		done <- err
	}()
	waitForALockWait(t, pool, done, "SELECT 1 FROM users WHERE id = $1 FOR UPDATE%")
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("set PIN: %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM refresh_tokens WHERE id = $1`, successor).Scan(&n); err != nil || n != 0 {
		t.Errorf("a session bound to the profile while the PIN was being set survived it (rows %d, %v)", n, err)
	}
}

// TestActivationRechecksThePINUnderTheAccountLock: activation judges the
// PIN, then binds. A PIN set between the two ended nothing (the session was
// not yet on the profile) and the bind then put the session on the newly
// locked profile. The bind takes the user row FOR SHARE and rechecks; here a
// PIN is set under that lock while the bind waits for it.
func TestActivationRechecksThePINUnderTheAccountLock(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, f.userID); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE user_profiles SET pin_hash = 'set-meanwhile' WHERE id = $1`, f.parent.ID); err != nil {
		t.Fatalf("set the PIN: %v", err)
	}
	none := ""
	done := make(chan error, 1)
	go func() {
		_, err := f.q.SetActiveProfileForTokenIfPIN(ctx, f.kidRT, f.userID, f.parent.ID, &none)
		done <- err
	}()
	waitForALockWait(t, pool, done, "SELECT 1 FROM users WHERE id = $1 FOR SHARE%")
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if err := <-done; !errors.Is(err, db.ErrProfilePINChanged) {
		t.Errorf("binding to a profile locked meanwhile: %v, want ErrProfilePINChanged", err)
	}
	if got := f.acting(t, f.kidRT); got != f.kid.ID {
		t.Errorf("the kid's session acts as %d after the refused bind, want still the kid (%d)", got, f.kid.ID)
	}
	// A PIN that matched before a change is refused the same way.
	old := "old-hash"
	if _, err := f.q.SetActiveProfileForTokenIfPIN(ctx, f.kidRT, f.userID, f.parent.ID, &old); !errors.Is(err, db.ErrProfilePINChanged) {
		t.Errorf("binding with a PIN checked against the old hash: %v, want ErrProfilePINChanged", err)
	}
}

// waitForALockWait returns once a backend running a statement like the given
// pattern waits on a lock, or done fires (the caller then sees the wrong
// answer), or five seconds pass.
func waitForALockWait(t *testing.T, pool *pgxpool.Pool, done chan error, like string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if len(done) > 0 {
			return
		}
		var waiting bool
		if err := pool.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE $1)`, like).Scan(&waiting); err != nil {
			t.Fatalf("read pg_stat_activity: %v", err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestAPINWriteClearsTheLockout: the attempt count and any lockout belong to
// the PIN being guessed, so a new PIN starts clean.
func TestAPINWriteClearsTheLockout(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	for i := 0; i < profilePINMaxFailures; i++ {
		f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"0000"}`)
	}
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.parent.ID,
		`{"pin":"9876","password":"`+lockTestPassword+`"}`); code != http.StatusOK {
		t.Fatalf("change the PIN: %d %s", code, body)
	}
	var attempts int
	var locked bool
	if err := lockTestPool(t).QueryRow(context.Background(),
		`SELECT pin_failed_attempts, pin_locked_until IS NOT NULL FROM user_profiles WHERE id = $1`, f.parent.ID).Scan(&attempts, &locked); err != nil {
		t.Fatalf("read: %v", err)
	}
	if attempts != 0 || locked {
		t.Errorf("after a new PIN: %d failed attempts, lockout set %v; want 0 and none", attempts, locked)
	}
}

// TestTheMostRestrictiveUnlockedProfileSkipsLockedOnes: pairing binds a
// device to it when the approver's profile is locked.
func TestTheMostRestrictiveUnlockedProfileSkipsLockedOnes(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	got := func() *models.UserProfile {
		t.Helper()
		p, err := f.q.MostRestrictiveUnlockedProfile(ctx, f.userID)
		if err != nil {
			t.Fatalf("pick: %v", err)
		}
		return p
	}
	if p := got(); p == nil || p.ID != f.kid.ID {
		t.Errorf("with the kid unlocked: got %+v, want the kid", p)
	}
	pool := lockTestPool(t)
	if _, err := pool.Exec(ctx, `UPDATE user_profiles SET pin_hash = 'x' WHERE id = $1`, f.kid.ID); err != nil {
		t.Fatalf("lock the kid: %v", err)
	}
	if p := got(); p == nil || p.ID != f.parent.ID {
		t.Errorf("with only the parent unlocked: got %+v, want the parent", p)
	}
	if _, err := pool.Exec(ctx, `UPDATE user_profiles SET pin_hash = 'x' WHERE id = $1`, f.parent.ID); err != nil {
		t.Fatalf("lock the parent: %v", err)
	}
	if p := got(); p != nil {
		t.Errorf("with every profile locked: got %+v, want none", p)
	}
}

// TestPINWritesHaveABudget: each write runs argon2id (64 MiB), so a session
// could otherwise run them without limit.
func TestPINWritesHaveABudget(t *testing.T) {
	f := newLockFixture(t)
	for i := 0; i < profilePINWrites; i++ {
		if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.kid.ID, `{"pin":""}`); code != http.StatusOK {
			t.Fatalf("PIN write %d: %d %s", i+1, code, body)
		}
	}
	if code, reason, _ := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.kid.ID, `{"pin":""}`); code != http.StatusTooManyRequests || reason != "rate_limited" {
		t.Errorf("a PIN write past the budget: %d %q, want 429 rate_limited", code, reason)
	}
}

// TestEveryRevocationStampsRevokedAt: a revoked row is kept until its
// revoked_at is older than the access-token lifetime, because its access
// tokens still resolve through it. A row revoked without the stamp is purged
// at once, and its tokens then act as the most restrictive profile.
func TestEveryRevocationStampsRevokedAt(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	token := func(tok string) int64 {
		t.Helper()
		rt := &models.RefreshToken{UserID: f.userID, Token: tok + reqTestSuffix(t), ExpiresAt: time.Now().Add(time.Hour)}
		if err := f.q.CreateRefreshToken(ctx, rt); err != nil {
			t.Fatalf("seed session: %v", err)
		}
		return rt.ID
	}
	stamped := func(t *testing.T, ids ...int64) {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM refresh_tokens WHERE id = ANY($1) AND revoked AND revoked_at IS NOT NULL`,
			ids).Scan(&n); err != nil {
			t.Fatalf("read sessions: %v", err)
		}
		if n != len(ids) {
			t.Errorf("%d of %d revoked sessions carry revoked_at", n, len(ids))
		}
	}
	t.Run("one session", func(t *testing.T) {
		plain := "revoke-one-" + reqTestSuffix(t)
		rt := &models.RefreshToken{UserID: f.userID, Token: plain, ExpiresAt: time.Now().Add(time.Hour)}
		if err := f.q.CreateRefreshToken(ctx, rt); err != nil {
			t.Fatalf("seed session: %v", err)
		}
		if err := f.q.RevokeRefreshToken(ctx, plain); err != nil {
			t.Fatalf("revoke: %v", err)
		}
		stamped(t, rt.ID)
	})
	t.Run("every session", func(t *testing.T) {
		a, b := token("revoke-all-a-"), token("revoke-all-b-")
		if err := f.q.RevokeAllUserTokens(ctx, f.userID); err != nil {
			t.Fatalf("revoke all: %v", err)
		}
		stamped(t, a, b)
	})
	t.Run("sign out everywhere", func(t *testing.T) {
		a, b := token("revoke-sessions-a-"), token("revoke-sessions-b-")
		if _, err := f.q.RevokeAllUserSessions(ctx, f.userID); err != nil {
			t.Fatalf("revoke sessions: %v", err)
		}
		stamped(t, a, b)
	})
}

// TestActivatingAProfileLockedMeanwhileIsRefused drives the handler through
// the same race: it reads the profile as unlocked, a PIN lands while its
// bind waits for the account lock, and the bind must refuse.
func TestActivatingAProfileLockedMeanwhileIsRefused(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	pool := lockTestPool(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, f.userID); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE user_profiles SET pin_hash = 'set-meanwhile' WHERE id = $1`, f.parent.ID); err != nil {
		t.Fatalf("set the PIN: %v", err)
	}
	type result struct {
		code   int
		reason string
	}
	got := make(chan result, 1)
	done := make(chan error, 1)
	go func() {
		code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, "")
		got <- result{code, reason}
		done <- nil
	}()
	waitForALockWait(t, pool, done, "SELECT 1 FROM users WHERE id = $1 FOR SHARE%")
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if r := <-got; r.code != http.StatusForbidden || r.reason != "profile_pin_required" {
		t.Errorf("activating a profile locked meanwhile: %d %q, want 403 profile_pin_required", r.code, r.reason)
	}
	if acting := f.acting(t, f.kidRT); acting != f.kid.ID {
		t.Errorf("the kid's session acts as %d, want still the kid (%d)", acting, f.kid.ID)
	}
}

// TestAPairingApprovedBeforeAPINExpires: a pairing grant names the profile
// its approver could pass on and lives ten minutes. A kid's session on the
// unlocked parent approved one, the parent then set a PIN (ending the kid's
// session), and the kid's poll still created a session on the newly locked
// profile. The session insert rechecks under the user lock.
func TestAPairingApprovedBeforeAPINExpires(t *testing.T) {
	f := newLockFixture(t)
	h, _ := deviceTestHandler()
	h.sessions = f.q
	kidOnParent := seedRCRefreshToken(t, f.q, f.userID)
	f.bind(t, kidOnParent, f.parent.ID)
	secret, grant, err := h.grants.start("Kid's tablet")
	if err != nil {
		t.Fatal(err)
	}
	u, err := f.q.GetUserByID(context.Background(), f.userID)
	if err != nil || u == nil {
		t.Fatalf("read user: %v", err)
	}
	if !h.grants.authorize(grant.UserCode, f.userID, u.TokenVersion, f.parent.ID) {
		t.Fatal("authorize the grant")
	}
	f.setPIN(t, "4321")
	w := deviceRequest(h.Poll, "POST", "/api/auth/device/poll", fmt.Sprintf(`{"device_code":%q}`, secret), false)
	var n int
	if err := lockTestPool(t).QueryRow(context.Background(),
		`SELECT count(*) FROM refresh_tokens WHERE user_id = $1 AND active_profile_id = $2 AND id <> $3`,
		f.userID, f.parent.ID, f.parentRT).Scan(&n); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	if n != 0 || !strings.Contains(w.Body.String(), "expired_token") {
		t.Errorf("polling a grant for a profile locked since: %d %s, %d new sessions on it; want expired_token and none", w.Code, w.Body, n)
	}
}

// TestAnEndedSessionCannotManageProfilesOrPair: a session a PIN write ended
// keeps its access token for up to one token lifetime, acting as the most
// restrictive profile, which once no restricted profile is left is the
// unrestricted default. It is refused management and pairing outright.
func TestAnEndedSessionCannotManageProfilesOrPair(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	ended := seedRCRefreshToken(t, f.q, f.userID)
	if _, err := lockTestPool(t).Exec(ctx, `DELETE FROM refresh_tokens WHERE id = $1`, ended); err != nil {
		t.Fatalf("end the session: %v", err)
	}
	// With the kid's ceiling gone, the most restrictive profile is the
	// unrestricted default.
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE user_profiles SET max_age_rating = NULL WHERE id = $1`, f.kid.ID); err != nil {
		t.Fatalf("clear the kid's ceiling: %v", err)
	}
	if code, reason, _ := f.call(t, f.h.CreateProfile, http.MethodPost, ended, 0, `{"name":"free"}`); code != http.StatusUnauthorized || reason != "session_ended" {
		t.Errorf("an ended session creating a profile: %d %q, want 401 session_ended", code, reason)
	}
	if code, reason, _ := f.call(t, f.h.UpdateProfile, http.MethodPut, ended, f.kid.ID, `{"max_age_rating":"PG"}`); code != http.StatusUnauthorized || reason != "session_ended" {
		t.Errorf("an ended session changing a ceiling: %d %q, want 401 session_ended", code, reason)
	}
	rr := httptest.NewRecorder()
	r := rcClaimsCtx(httptest.NewRequest(http.MethodGet, "/x", nil), f.userID, ended)
	if !denyRestrictedSession(rr, r, f.q, &auth.JWTClaims{UserID: f.userID, RefreshTokenID: ended}, "do this") || rr.Code != http.StatusUnauthorized {
		t.Errorf("an ended session passing the account-level check: %d", rr.Code)
	}
	h, _ := deviceTestHandler()
	h.sessions = f.q
	_, grant, err := h.grants.start("TV")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := f.q.GetUserByID(ctx, f.userID)
	ar := httptest.NewRequest(http.MethodPost, "https://aurora.example/api/auth/device/authorize",
		strings.NewReader(fmt.Sprintf(`{"user_code":%q,"expected_user_id":%d}`, grant.UserCode, f.userID)))
	ar.Header.Set("Content-Type", "application/json")
	ar = ar.WithContext(context.WithValue(ar.Context(), auth.ClaimsContextKey,
		&auth.JWTClaims{UserID: f.userID, Username: u.Username, Role: "user", TokenVersion: u.TokenVersion, RefreshTokenID: ended}))
	aw := httptest.NewRecorder()
	h.Authorize(aw, ar)
	if aw.Code != http.StatusUnauthorized {
		t.Errorf("an ended session approving a pairing: %d %s, want 401", aw.Code, aw.Body)
	}
	// A live session is unaffected.
	if code, _, body := f.call(t, f.h.CreateProfile, http.MethodPost, f.parentRT, 0, `{"name":"spare"}`); code != http.StatusCreated {
		t.Errorf("a live session creating a profile: %d %s", code, body)
	}
}

// TestOneSessionCannotSpendTheOwnersPINBudget: the PIN-write budget is per
// account and acting profile, so a session on another profile spending it
// leaves the owner's.
func TestOneSessionCannotSpendTheOwnersPINBudget(t *testing.T) {
	f := newLockFixture(t)
	guest := &models.UserProfile{UserID: f.userID, Name: "guest", Language: "en", SubtitleMode: "off"}
	if err := f.q.CreateProfile(context.Background(), guest); err != nil {
		t.Fatalf("seed guest: %v", err)
	}
	guestRT := seedRCRefreshToken(t, f.q, f.userID)
	f.bind(t, guestRT, guest.ID)
	for i := 0; i < profilePINWrites+1; i++ {
		f.call(t, f.h.SetProfilePIN, http.MethodPut, guestRT, f.kid.ID, `{"pin":""}`)
	}
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.parent.ID, `{"pin":"4321"}`); code != http.StatusOK {
		t.Errorf("the owner's PIN write after a guest spent its budget: %d %s", code, body)
	}
}

// TestABindingToAProfileThatIsGoneActsAsTheMostRestrictive: a session bound
// to a profile its account no longer has (a delete racing the lookup) fell
// back to the account default.
func TestABindingToAProfileThatIsGoneActsAsTheMostRestrictive(t *testing.T) {
	f := newLockFixture(t)
	other := seedReqUser(t, f.q)
	foreign, err := f.q.CreateDefaultProfileForUser(context.Background(), other, "foreign")
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	stray := seedRCRefreshToken(t, f.q, f.userID)
	if _, err := lockTestPool(t).Exec(context.Background(), `UPDATE refresh_tokens SET active_profile_id = $2 WHERE id = $1`, stray, foreign.ID); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if got := f.acting(t, stray); got != f.kid.ID {
		t.Errorf("a session bound to another account's profile acts as %d, want the most restrictive, the kid (%d)", got, f.kid.ID)
	}
}
