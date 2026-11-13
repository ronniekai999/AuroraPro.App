package api

// The session gate a restore shuts for its transaction (admin_restore_gate.go),
// the restore's wait for the requests already past it, what it runs once it
// has committed, and the router's wiring. The race against PostgreSQL is
// TestASignInRacingTheRestoreLeavesNoSessionInTheRestoredDatabase
// (admin_backup_test.go).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/config"
)

// gatedRequest runs a request through the gate on its own goroutine, holding
// it past the gate until release is closed. entered is closed once it is
// past; done carries its status.
func gatedRequest(g *restoreSessionGate, release <-chan struct{}) (entered chan struct{}, done chan int) {
	entered, done = make(chan struct{}), make(chan int, 1)
	h := g.guardJSON()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	go func() {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/auth/login", nil))
		done <- rr.Code
	}()
	return entered, done
}

// throughGate answers the status and reason of one request through the gate.
func throughGate(g *restoreSessionGate) (int, string) {
	rr := httptest.NewRecorder()
	g.guardJSON()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})).ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/auth/login", nil))
	return rr.Code, errorReasonOf(rr)
}

func TestTheSessionGateRefusesWhileShutAndWaitsForThoseInFlight(t *testing.T) {
	var g restoreSessionGate
	if code, _ := throughGate(&g); code != http.StatusNoContent {
		t.Fatalf("the zero gate answered %d; it should be open", code)
	}
	release := make(chan struct{})
	entered, done := gatedRequest(&g, release)
	waitFor(t, "the request to pass the gate", entered)

	// Shutting with one past the gate waits for it, and refuses new ones
	// meanwhile.
	drained := make(chan bool, 1)
	go func() { drained <- g.shutAndDrain(context.Background(), 5*time.Second) }()
	eventually(t, "the gate to shut", func() bool { code, _ := throughGate(&g); return code == http.StatusServiceUnavailable })
	if code, reason := throughGate(&g); code != http.StatusServiceUnavailable || reason != restoreRunningReason {
		t.Fatalf("a request while shut: %d %q, want 503 %q", code, reason, restoreRunningReason)
	}
	select {
	case <-drained:
		t.Fatal("the gate drained with a request still past it")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if code := <-done; code != http.StatusOK {
		t.Errorf("the request past the gate answered %d", code)
	}
	if ok := <-drained; !ok {
		t.Fatal("the gate did not drain once the request left")
	}
	g.open()
	if code, _ := throughGate(&g); code != http.StatusNoContent {
		t.Fatalf("after open: %d", code)
	}

	// One that does not leave in time: shutAndDrain says so, and the gate
	// stays shut until open.
	release = make(chan struct{})
	entered, done = gatedRequest(&g, release)
	waitFor(t, "the second request to pass the gate", entered)
	if g.shutAndDrain(context.Background(), 50*time.Millisecond) {
		t.Fatal("shutAndDrain reported drained with a request still past the gate")
	}
	if code, _ := throughGate(&g); code != http.StatusServiceUnavailable {
		t.Errorf("after a timed-out drain the gate let a request through (%d)", code)
	}
	g.open()
	close(release)
	<-done
}

// TestARestoreWaitsForSignInsInFlightBeforeItsTransaction: a sign-in already
// past the gate when the restore reaches its transaction finishes first; one
// that comes during the transaction is refused, and the gate opens when the
// restore ends.
func TestARestoreWaitsForSignInsInFlightBeforeItsTransaction(t *testing.T) {
	f := newFakeRestore()
	h := newRestoreHandler(f)
	txStarted, txRelease := make(chan struct{}), make(chan struct{})
	f.steps[restoreStepRestoring] = hold(txStarted, txRelease)

	signInRelease := make(chan struct{})
	entered, signInDone := gatedRequest(&h.sessionGate, signInRelease)
	waitFor(t, "the sign-in to pass the gate", entered)

	_, done := startRestore(t, h, context.Background(), testRestoreTicket)
	eventually(t, "the gate to shut", func() bool { code, _ := throughGate(&h.sessionGate); return code == http.StatusServiceUnavailable })
	select {
	case <-txStarted:
		t.Fatal("the transaction began with a sign-in still running")
	case <-time.After(200 * time.Millisecond):
	}
	close(signInRelease)
	if code := <-signInDone; code != http.StatusOK {
		t.Errorf("the sign-in in flight answered %d", code)
	}
	waitFor(t, "the transaction to begin", txStarted)
	if code, reason := throughGate(&h.sessionGate); code != http.StatusServiceUnavailable || reason != restoreRunningReason {
		t.Errorf("a sign-in during the transaction: %d %q, want 503 %q", code, reason, restoreRunningReason)
	}
	close(txRelease)
	waitFor(t, "the handler", done)
	if st := h.restores.status(); st.State != restoreStateSucceeded {
		t.Fatalf("record %+v", st)
	}
	if code, _ := throughGate(&h.sessionGate); code != http.StatusNoContent {
		t.Errorf("after the restore the gate answered %d; it should be open", code)
	}
}

// TestARestoreDoesNotStartWhenSignInsDoNotFinish: a request past the gate
// that outlasts the wait keeps the transaction from starting, with the
// database unchanged, and the gate open again.
func TestARestoreDoesNotStartWhenSignInsDoNotFinish(t *testing.T) {
	f := newFakeRestore()
	h := newRestoreHandler(f)
	h.sessionDrain = 100 * time.Millisecond
	release := make(chan struct{})
	defer close(release)
	entered, _ := gatedRequest(&h.sessionGate, release)
	waitFor(t, "the sign-in to pass the gate", entered)

	rec, done := startRestore(t, h, context.Background(), testRestoreTicket)
	waitFor(t, "the handler", done)
	st := h.restores.status()
	if st.State != restoreStateFailed || st.Database != restoreDBUnchanged || !strings.Contains(st.Message, "did not start") || !strings.Contains(st.Message, "NOT modified") {
		t.Fatalf("record %+v; want failed, unchanged, saying it did not start", st)
	}
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("answer %d, want 500", rec.Code)
	}
	ran, _, _ := f.snapshot()
	for _, step := range ran {
		if step == restoreStepRestoring {
			t.Fatalf("the transaction ran (%v) with a sign-in still past the gate", ran)
		}
	}
	if code, _ := throughGate(&h.sessionGate); code != http.StatusNoContent {
		t.Errorf("after the refused restore the gate answered %d; it should be open", code)
	}
}

// TestOnlyACommittedRestoreRunsItsHooks: what names the old database's rows
// (pending device pairings) goes when a restore commits, and only then.
func TestOnlyACommittedRestoreRunsItsHooks(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fail    bool
		wantRan bool
	}{{"committed", false, true}, {"rolled back", true, false}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeRestore()
			if tc.fail {
				f.steps[restoreStepRestoring] = func(context.Context) (string, error) { return "ERROR: boom", errors.New("exit status 3") }
			}
			h := newRestoreHandler(f)
			ran := false
			gateWasShut := false
			h.OnRestored(func() {
				ran = true
				code, _ := throughGate(&h.sessionGate)
				gateWasShut = code == http.StatusServiceUnavailable
			})
			_, done := startRestore(t, h, context.Background(), testRestoreTicket)
			waitFor(t, "the handler", done)
			if ran != tc.wantRan {
				t.Fatalf("hook ran = %v, want %v (record %+v)", ran, tc.wantRan, h.restores.status())
			}
			if ran && !gateWasShut {
				t.Error("the hook ran with the session routes already open")
			}
		})
	}
}

// TestDevicePairingsAreForgottenAfterARestore: an approved grant names a user
// id and token version of the old database; collected after a restore it
// would sign the device in as whoever has that id now.
func TestDevicePairingsAreForgottenAfterARestore(t *testing.T) {
	h := &DeviceAuthHandler{grants: newDeviceGrants()}
	secret, grant, err := h.grants.start("Living room TV")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if !h.grants.authorize(grant.UserCode, 7, 3, 0, nil) {
		t.Fatal("authorize refused")
	}
	h.ForgetGrants()
	if _, status := h.grants.take(secret); status == "authorized" {
		t.Fatalf("a grant approved before the restore was collected after it (%s)", status)
	}
}

// TestAPanicWhileCheckingLeavesTheDatabaseUnchanged: an internal error while
// the file is checked has touched nothing; one in the transaction step cannot
// say.
func TestAPanicWhileCheckingLeavesTheDatabaseUnchanged(t *testing.T) {
	for _, tc := range []struct {
		step restoreStep
		want string
	}{{restoreStepChecking, restoreDBUnchanged}, {restoreStepRestoring, restoreDBUnknown}} {
		t.Run(string(tc.step), func(t *testing.T) {
			f := newFakeRestore()
			f.steps[tc.step] = func(context.Context) (string, error) { panic("boom") }
			h := newRestoreHandler(f)
			_, done := startRestore(t, h, context.Background(), testRestoreTicket)
			waitFor(t, "the handler", done)
			if st := h.restores.status(); st.State != restoreStateFailed || st.Database != tc.want {
				t.Fatalf("a panic while %s: %+v, want database %s", tc.step, st, tc.want)
			}
		})
	}
}

// TestTheSessionRoutesAreClosedWhileARestoreRuns drives every route the gate
// closes through the real router, with an admin's session, while the
// router's own gate is shut; and the pairing a restore forgets through it.
func TestTheSessionRoutesAreClosedWhileARestoreRuns(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, f.userID); err != nil {
		t.Fatalf("make the user an admin: %v", err)
	}
	u, err := f.q.GetUserByID(ctx, f.userID)
	if err != nil {
		t.Fatalf("read the user: %v", err)
	}
	svc := healthTestService()
	var admin *AdminHandler
	limiter := func() *auth.RateLimiter {
		l := auth.NewRateLimiter(1000, time.Minute)
		t.Cleanup(l.Stop)
		return l
	}
	router := NewRouter(RouterDeps{Cfg: &config.Config{}, AuthSvc: svc, Queries: f.q, StartTime: time.Now(),
		LoginLimiter: limiter(), RefreshLimiter: limiter(), ChangePasswordLimiter: limiter(),
		adminHandlerMade: func(h *AdminHandler) { admin = h }})
	if admin == nil {
		t.Fatal("the router made no admin handler")
	}
	tok, _, err := svc.GenerateAccessToken(f.userID, u.Username, "admin", u.TokenVersion, f.parentRT)
	if err != nil {
		t.Fatalf("mint a token: %v", err)
	}
	do := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr
	}
	gated := []struct{ method, path string }{
		{http.MethodPost, "/api/auth/login"},
		{http.MethodPost, "/api/auth/register"},
		{http.MethodPost, "/api/auth/refresh"},
		{http.MethodPost, "/api/auth/device/poll"},
		{http.MethodPost, "/api/auth/device/authorize"},
		{http.MethodPost, "/api/auth/change-password"},
		{http.MethodDelete, "/api/auth/oauth/google/link"},
		{http.MethodPut, "/api/profiles/" + strconv.FormatInt(f.parent.ID, 10) + "/pin"},
		{http.MethodPut, "/api/users/" + strconv.FormatInt(f.userID, 10) + "/role"},
	}
	if !admin.SessionGate().shutAndDrain(ctx, time.Second) {
		t.Fatal("the router's gate did not shut")
	}
	for _, rt := range gated {
		rr := do(rt.method, rt.path, "{}")
		if rr.Code != http.StatusServiceUnavailable || errorReasonOf(rr) != restoreRunningReason {
			t.Errorf("%s %s while a restore runs: %d %s, want 503 %s", rt.method, rt.path, rr.Code, rr.Body, restoreRunningReason)
		}
	}
	rr := do(http.MethodGet, "/api/auth/oauth/google/callback?state=x&code=y", "")
	if rr.Code != http.StatusServiceUnavailable || !strings.Contains(rr.Body.String(), "A database restore is running") {
		t.Errorf("the OAuth callback while a restore runs: %d, want the 503 page", rr.Code)
	}
	// Not closed: reading who is signed in.
	if rr := do(http.MethodGet, "/api/auth/me", ""); rr.Code != http.StatusOK {
		t.Errorf("GET /api/auth/me while a restore runs: %d, want 200", rr.Code)
	}
	admin.SessionGate().open()
	for _, rt := range gated {
		if rr := do(rt.method, rt.path, "{}"); rr.Code == http.StatusServiceUnavailable && errorReasonOf(rr) == restoreRunningReason {
			t.Errorf("%s %s after the restore: still refused", rt.method, rt.path)
		}
	}

	// A pairing approved before a restore that commits is forgotten.
	start := httptest.NewRecorder()
	router.ServeHTTP(start, httptest.NewRequest(http.MethodPost, "/api/auth/device/start", strings.NewReader(`{"device_name":"TV"}`)))
	var started struct {
		DeviceCode string `json:"device_code"`
		UserCode   string `json:"user_code"`
	}
	if start.Code != http.StatusCreated || json.Unmarshal(start.Body.Bytes(), &started) != nil || started.DeviceCode == "" {
		t.Fatalf("device start: %d %s", start.Code, start.Body)
	}
	if rr := do(http.MethodPost, "/api/auth/device/authorize", `{"user_code":"`+started.UserCode+`","expected_user_id":`+strconv.FormatInt(f.userID, 10)+`}`); rr.Code != http.StatusOK {
		t.Fatalf("device authorize: %d %s", rr.Code, rr.Body)
	}
	for _, fn := range admin.onRestored {
		fn()
	}
	poll := httptest.NewRecorder()
	router.ServeHTTP(poll, httptest.NewRequest(http.MethodPost, "/api/auth/device/poll", bytes.NewReader([]byte(`{"device_code":"`+started.DeviceCode+`"}`))))
	var polled struct {
		Status string `json:"status"`
	}
	if poll.Code != http.StatusOK || json.Unmarshal(poll.Body.Bytes(), &polled) != nil || polled.Status == "authorized" || polled.Status == "authorization_pending" {
		t.Errorf("the device's poll after a restore: %d %s, want its code gone", poll.Code, poll.Body)
	}
}
