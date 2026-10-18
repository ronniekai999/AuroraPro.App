package api

// Handler tests for profile PINs (the profile lock). Without a lock, a
// session acting as a restricted (kid) profile could switch itself to an
// unrestricted profile, or rewrite ceilings, and every server-side gate was
// advisory. Opt-in via TEST_DATABASE_URL, same harness as
// rating_ceiling_test.go.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const lockTestPassword = "correct horse battery staple"

// lockFixture is an account with a known password, its unrestricted default
// ("parent") profile, a PG kid profile, and one session bound to each.
type lockFixture struct {
	q               *db.Queries
	h               *ProfileHandler
	userID          int64
	parent, kid     *models.UserProfile
	parentRT, kidRT int64
}

func newLockFixture(t *testing.T) *lockFixture {
	t.Helper()
	q := requireRequestTestDB(t)
	ctx := context.Background()
	svc := healthTestService()
	userID := seedReqUser(t, q)

	hash, err := svc.HashPassword(lockTestPassword)
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	pool, err := pgxpool.New(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, userID, hash); err != nil {
		t.Fatalf("set password: %v", err)
	}

	parent, err := q.CreateDefaultProfileForUser(ctx, userID, "parent")
	if err != nil {
		t.Fatalf("seed parent profile: %v", err)
	}
	kid := &models.UserProfile{UserID: userID, Name: "kid", MaxAgeRating: "PG", Language: "en", SubtitleMode: "off"}
	if err := q.CreateProfile(ctx, kid); err != nil {
		t.Fatalf("seed kid profile: %v", err)
	}
	f := &lockFixture{q: q, userID: userID, parent: parent, kid: kid,
		parentRT: seedRCRefreshToken(t, q, userID), kidRT: seedRCRefreshToken(t, q, userID)}
	f.bind(t, f.parentRT, parent.ID)
	f.bind(t, f.kidRT, kid.ID)
	f.h = NewProfileHandler(q)
	f.h.SetAuthService(svc)
	return f
}

func (f *lockFixture) bind(t *testing.T, rt, profileID int64) {
	t.Helper()
	if ok, err := f.q.SetActiveProfileForToken(context.Background(), rt, f.userID, profileID); err != nil || !ok {
		t.Fatalf("bind session %d to profile %d: ok=%v err=%v", rt, profileID, ok, err)
	}
}

func (f *lockFixture) acting(t *testing.T, rt int64) int64 {
	t.Helper()
	p, err := f.q.ResolveActingProfile(context.Background(), f.userID, rt)
	if err != nil || p == nil {
		t.Fatalf("resolve acting profile: %v", err)
	}
	return p.ID
}

// call runs one handler as the session rt and returns the status, the error
// reason (if any), and the raw body.
func (f *lockFixture) call(t *testing.T, handler http.HandlerFunc, method string, rt, profileID int64, body string) (int, string, string) {
	t.Helper()
	r := httptest.NewRequest(method, "/api/profiles", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	if profileID != 0 {
		rctx.URLParams.Add("id", i64(profileID))
	}
	r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
	claims := &auth.JWTClaims{UserID: f.userID, Username: "u", Role: "user", RefreshTokenID: rt}
	r = r.WithContext(context.WithValue(r.Context(), auth.ClaimsContextKey, claims))
	rr := httptest.NewRecorder()
	handler(rr, r)
	var env struct {
		Error struct {
			Reason string `json:"reason"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &env)
	return rr.Code, env.Error.Reason, rr.Body.String()
}

func (f *lockFixture) setPIN(t *testing.T, pin string) {
	t.Helper()
	if code, _, body := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.parent.ID, `{"pin":"`+pin+`"}`); code != http.StatusOK {
		t.Fatalf("parent setting its own PIN: status %d (%s)", code, body)
	}
}

func TestActivateLockedProfile(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	activate := func(rt int64, body string) (int, string) {
		code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, rt, f.parent.ID, body)
		return code, reason
	}

	if code, reason := activate(f.kidRT, ""); code != http.StatusForbidden || reason != "profile_pin_required" {
		t.Errorf("kid switching to the locked parent with no PIN: %d %q, want 403 profile_pin_required", code, reason)
	}
	if code, reason := activate(f.kidRT, `{"pin":"0000"}`); code != http.StatusForbidden || reason != "profile_pin_invalid" {
		t.Errorf("kid with a wrong PIN: %d %q, want 403 profile_pin_invalid", code, reason)
	}
	if code, reason := activate(f.kidRT, `{"password":"guess"}`); code != http.StatusForbidden || reason != "profile_pin_invalid" {
		t.Errorf("kid with a wrong password: %d %q, want 403 profile_pin_invalid", code, reason)
	}
	if got := f.acting(t, f.kidRT); got != f.kid.ID {
		t.Fatalf("after refused switches the kid session acts as %d, want the kid profile %d", got, f.kid.ID)
	}

	if code, _ := activate(f.kidRT, `{"pin":"4321"}`); code != http.StatusOK {
		t.Errorf("the right PIN: status %d, want 200", code)
	}
	if got := f.acting(t, f.kidRT); got != f.parent.ID {
		t.Errorf("after the right PIN the session acts as %d, want the parent %d", got, f.parent.ID)
	}

	f.bind(t, f.kidRT, f.kid.ID)
	if code, _ := activate(f.kidRT, `{"password":"`+lockTestPassword+`"}`); code != http.StatusOK {
		t.Errorf("the account password in place of the PIN: status %d, want 200", code)
	}

	// The session already acting as the locked profile needs no PIN.
	if code, _ := activate(f.parentRT, ""); code != http.StatusOK {
		t.Errorf("re-activating the profile a session already acts as: status %d, want 200", code)
	}
	// Unlocked profiles switch freely, as before.
	if code, _, body := f.call(t, f.h.ActivateProfile, http.MethodPost, f.parentRT, f.kid.ID, ""); code != http.StatusOK {
		t.Errorf("switching to the unlocked kid profile: status %d (%s)", code, body)
	}
}

func TestActivateLockedProfileLocksOutAfterRepeatedFailures(t *testing.T) {
	f := newLockFixture(t)
	f.setPIN(t, "4321")
	for i := 1; i < profilePINMaxFailures; i++ {
		code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"0000"}`)
		if code != http.StatusForbidden || reason != "profile_pin_invalid" {
			t.Fatalf("wrong PIN %d: %d %q, want 403 profile_pin_invalid", i, code, reason)
		}
	}
	code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"0000"}`)
	if code != http.StatusTooManyRequests || reason != "profile_pin_locked" {
		t.Fatalf("wrong PIN %d: %d %q, want 429 profile_pin_locked", profilePINMaxFailures, code, reason)
	}
	// During the lockout even the right PIN, or the password, is refused
	// unchecked, so a guess cannot confirm itself.
	for _, body := range []string{`{"pin":"4321"}`, `{"password":"` + lockTestPassword + `"}`} {
		if code, reason, _ := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, body); code != http.StatusTooManyRequests || reason != "profile_pin_locked" {
			t.Errorf("during the lockout %s: %d %q, want 429 profile_pin_locked", body, code, reason)
		}
	}
	if got := f.acting(t, f.kidRT); got != f.kid.ID {
		t.Errorf("after the lockout the kid session acts as %d, want the kid profile %d", got, f.kid.ID)
	}

	// The lockout ends, and the right PIN then works and resets the count.
	pool, err := pgxpool.New(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `UPDATE user_profiles SET pin_locked_until = NOW() - interval '1 second' WHERE id = $1`, f.parent.ID); err != nil {
		t.Fatalf("expire lockout: %v", err)
	}
	if code, _, body := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, `{"pin":"4321"}`); code != http.StatusOK {
		t.Fatalf("the right PIN after the lockout: status %d (%s)", code, body)
	}
	st, err := f.q.GetProfilePINState(context.Background(), f.parent.ID)
	if err != nil || st == nil || st.LockedUntil != nil {
		t.Errorf("a success should clear the lockout: %+v %v", st, err)
	}
}

func TestRestrictedSessionCannotManageProfiles(t *testing.T) {
	f := newLockFixture(t)
	restricted := func(name string, handler http.HandlerFunc, method string, profileID int64, body string) {
		t.Helper()
		if code, reason, raw := f.call(t, handler, method, f.kidRT, profileID, body); code != http.StatusForbidden || reason != "profile_restricted" {
			t.Errorf("kid session %s: %d %q (%s), want 403 profile_restricted", name, code, reason, raw)
		}
	}
	restricted("creating a profile", f.h.CreateProfile, http.MethodPost, 0, `{"name":"sneaky"}`)
	restricted("deleting a profile", f.h.DeleteProfile, http.MethodDelete, f.kid.ID, "")
	restricted("re-defaulting a profile", f.h.SetDefault, http.MethodPost, f.kid.ID, "")
	restricted("editing the parent profile", f.h.UpdateProfile, http.MethodPut, f.parent.ID, `{"name":"x"}`)
	restricted("lifting its own ceiling", f.h.UpdateProfile, http.MethodPut, f.kid.ID, `{"max_age_rating":"NC-17"}`)
	restricted("clearing its own ceiling", f.h.UpdateProfile, http.MethodPut, f.kid.ID, `{"max_age_rating":""}`)
	restricted("setting a PIN", f.h.SetProfilePIN, http.MethodPut, f.parent.ID, `{"pin":"1111"}`)

	kid, err := f.q.GetProfile(context.Background(), f.kid.ID)
	if err != nil || kid == nil || kid.MaxAgeRating != "PG" || kid.Name != "kid" {
		t.Fatalf("the refused writes changed the kid profile: %+v %v", kid, err)
	}

	// Its own cosmetic settings stay editable, and round-tripping the
	// unchanged ceiling (as a full-form client does) is not a change.
	if code, _, raw := f.call(t, f.h.UpdateProfile, http.MethodPut, f.kidRT, f.kid.ID, `{"name":"kiddo","subtitle_mode":"always","max_age_rating":"pg"}`); code != http.StatusOK {
		t.Errorf("kid editing its own name and subtitles: status %d (%s)", code, raw)
	}

	// The unrestricted session manages profiles as before.
	if code, _, raw := f.call(t, f.h.UpdateProfile, http.MethodPut, f.parentRT, f.kid.ID, `{"max_age_rating":"TV-14"}`); code != http.StatusOK {
		t.Errorf("parent changing the kid's ceiling: status %d (%s)", code, raw)
	}
	if code, _, raw := f.call(t, f.h.CreateProfile, http.MethodPost, f.parentRT, 0, `{"name":"teen","max_age_rating":"TV-14"}`); code != http.StatusCreated {
		t.Errorf("parent creating a profile: status %d (%s)", code, raw)
	}
}

func TestSetProfilePINRequiresTheCurrentOne(t *testing.T) {
	f := newLockFixture(t)
	pin := func(body string) (int, string) {
		code, reason, _ := f.call(t, f.h.SetProfilePIN, http.MethodPut, f.parentRT, f.parent.ID, body)
		return code, reason
	}
	if code, _ := pin(`{"pin":"12a4"}`); code != http.StatusBadRequest {
		t.Errorf("a non-numeric PIN: status %d, want 400", code)
	}
	if code, _ := pin(`{}`); code != http.StatusBadRequest {
		t.Errorf("no pin field: status %d, want 400", code)
	}
	f.setPIN(t, "4321")
	if p, _ := f.q.GetProfile(context.Background(), f.parent.ID); p == nil || !p.HasPIN {
		t.Fatalf("after setting a PIN the profile reads has_pin=false: %+v", p)
	}

	if code, reason := pin(`{"pin":"5555"}`); code != http.StatusForbidden || reason != "profile_pin_required" {
		t.Errorf("changing the PIN without the current one: %d %q, want 403 profile_pin_required", code, reason)
	}
	if code, reason := pin(`{"pin":"5555","current_pin":"0000"}`); code != http.StatusForbidden || reason != "profile_pin_invalid" {
		t.Errorf("changing the PIN with a wrong current one: %d %q, want 403 profile_pin_invalid", code, reason)
	}
	if code, _ := pin(`{"pin":"5555","current_pin":"4321"}`); code != http.StatusOK {
		t.Errorf("changing the PIN with the current one: status %d, want 200", code)
	}
	if code, _ := pin(`{"pin":"","password":"` + lockTestPassword + `"}`); code != http.StatusOK {
		t.Errorf("removing the PIN with the account password: status %d, want 200", code)
	}
	if p, _ := f.q.GetProfile(context.Background(), f.parent.ID); p == nil || p.HasPIN {
		t.Errorf("after removing the PIN the profile reads has_pin=true: %+v", p)
	}
	if code, _, raw := f.call(t, f.h.ActivateProfile, http.MethodPost, f.kidRT, f.parent.ID, ""); code != http.StatusOK {
		t.Errorf("an unlocked parent profile switches freely again: status %d (%s)", code, raw)
	}
}

func TestGetActiveProfileReportsTheSessionBinding(t *testing.T) {
	f := newLockFixture(t)
	for rt, want := range map[int64]int64{f.kidRT: f.kid.ID, f.parentRT: f.parent.ID} {
		code, _, raw := f.call(t, f.h.GetActiveProfile, http.MethodGet, rt, 0, "")
		var p models.UserProfile
		if code != http.StatusOK || json.Unmarshal([]byte(raw), &p) != nil || p.ID != want {
			t.Errorf("session %d: status %d body %s, want profile %d", rt, code, raw, want)
		}
	}
}
