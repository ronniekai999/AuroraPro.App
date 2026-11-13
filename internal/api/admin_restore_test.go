package api

// A restore that outlives its request (admin_restore.go). These drive the
// real Restore handler with psql and pg_restore replaced (restoreExec), so a
// step can be held open while the request is cancelled, a second restore is
// tried, or the record is read. No database and no binaries are needed; the
// destructive roundtrip against a real database is admin_backup_test.go's.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
)

// A ticket of the shape the web app sends (32 random bytes, base64url).
const testRestoreTicket = "q8Xc0bJ7Tq2f-Pn4Zr_Ws9Lk1Hy3Vd6Am5Ue8Gi0Ot"

// fakeRestore stands in for the three programs of a restore. Each step runs
// its behaviour from steps (a missing one succeeds at once) and records the
// context it was given and the archive path it was handed.
type fakeRestore struct {
	mu      sync.Mutex
	steps   map[restoreStep]func(ctx context.Context) (string, error)
	ran     []restoreStep
	ctxErrs map[restoreStep]error // each step's ctx.Err() as it returned
	archive string
}

func newFakeRestore() *fakeRestore {
	return &fakeRestore{steps: map[restoreStep]func(context.Context) (string, error){}, ctxErrs: map[restoreStep]error{}}
}

func (f *fakeRestore) run(ctx context.Context, step restoreStep, name string, args, env []string) (string, error) {
	f.mu.Lock()
	f.ran = append(f.ran, step)
	if len(args) > 0 {
		f.archive = args[len(args)-1]
	}
	do := f.steps[step]
	f.mu.Unlock()
	var stderr string
	var err error
	if do != nil {
		stderr, err = do(ctx)
	}
	f.mu.Lock()
	f.ctxErrs[step] = ctx.Err()
	f.mu.Unlock()
	return stderr, err
}

func (f *fakeRestore) snapshot() ([]restoreStep, map[restoreStep]error, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	errs := map[restoreStep]error{}
	for k, v := range f.ctxErrs {
		errs[k] = v
	}
	return append([]restoreStep(nil), f.ran...), errs, f.archive
}

// hold makes a step wait until release is closed (or its context ends, as a
// killed program would), closing started when it begins.
func hold(started, release chan struct{}) func(context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		close(started)
		select {
		case <-release:
			return "", nil
		case <-ctx.Done():
			return "", errors.New("signal: killed")
		}
	}
}

func newRestoreHandler(f *fakeRestore) *AdminHandler {
	return &AdminHandler{databaseURL: "postgres://aurora:secret@db.invalid/aurora", restoreExec: f.run}
}

// restoreRequest is a multipart upload as the web app sends it.
func restoreRequest(t *testing.T, ctx context.Context, ticket string) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("backup", "aurora-backup.dump")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write(append([]byte("PGDMP"), bytes.Repeat([]byte{0x01}, 512)...))
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", &buf).WithContext(ctx)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if ticket != "" {
		req.Header.Set(restoreTicketHeader, ticket)
	}
	return req
}

// startRestore runs the handler on its own goroutine and returns the
// recorder and a channel closed when the handler returns.
func startRestore(t *testing.T, h *AdminHandler, ctx context.Context, ticket string) (*httptest.ResponseRecorder, chan struct{}) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := restoreRequest(t, ctx, ticket)
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.Restore(rec, req)
	}()
	return rec, done
}

func waitFor(t *testing.T, what string, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// adminStatus reads the record through the admin route's handler.
func adminStatus(t *testing.T, h *AdminHandler) RestoreStatus {
	t.Helper()
	rr := httptest.NewRecorder()
	h.RestoreStatus(rr, httptest.NewRequest(http.MethodGet, "/api/admin/restore/status", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("admin status: %d %s", rr.Code, rr.Body)
	}
	if cc := rr.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("admin status Cache-Control = %q, want no-store", cc)
	}
	var st RestoreStatus
	if err := json.Unmarshal(rr.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	return st
}

// ticketStatus reads the record through the ticket route's handler.
func ticketStatus(h *AdminHandler, ticket string) (*httptest.ResponseRecorder, RestoreStatus) {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/restore/status", nil)
	if ticket != "" {
		req.Header.Set(restoreTicketHeader, ticket)
	}
	h.RestoreStatusByTicket(rr, req)
	var st RestoreStatus
	if rr.Code == http.StatusOK {
		_ = json.Unmarshal(rr.Body.Bytes(), &st)
	}
	return rr, st
}

// lockFree reports whether nothing holds the backup/restore lock, leaving it
// free.
func lockFree(h *AdminHandler) bool {
	if !h.backupRestoreMu.TryLock() {
		return false
	}
	h.backupRestoreMu.Unlock()
	return true
}

// TestARestoreRunsOnAfterItsRequestEnds: the request's context used to drive
// every command, so a reload or a closed tab killed pg_restore part way and
// left the database wiped. Whichever step the client leaves at, each step
// still runs, on a context the request's end does not touch, to a recorded
// success, and the lock and the uploaded file are let go after.
func TestARestoreRunsOnAfterItsRequestEnds(t *testing.T) {
	for _, leaveAt := range []restoreStep{restoreStepChecking, restoreStepClearing, restoreStepRestoring} {
		t.Run("the client leaves while "+string(leaveAt), func(t *testing.T) {
			f := newFakeRestore()
			started := map[restoreStep]chan struct{}{}
			release := map[restoreStep]chan struct{}{}
			for _, s := range []restoreStep{restoreStepChecking, restoreStepClearing, restoreStepRestoring} {
				started[s], release[s] = make(chan struct{}), make(chan struct{})
				f.steps[s] = hold(started[s], release[s])
			}
			h := newRestoreHandler(f)
			reqCtx, leave := context.WithCancel(context.Background())
			defer leave()
			rec, handlerDone := startRestore(t, h, reqCtx, testRestoreTicket)

			for _, s := range []restoreStep{restoreStepChecking, restoreStepClearing, restoreStepRestoring} {
				waitFor(t, string(s)+" to start", started[s])
				if s == leaveAt {
					leave()
					// The handler gives up on the client, not the restore.
					waitFor(t, "the handler to return once its client left", handlerDone)
					if st := adminStatus(t, h); st.State != restoreStateRunning || st.Step != string(s) {
						t.Fatalf("after the client left: %+v, want running at %s", st, s)
					}
					if lockFree(h) {
						t.Fatal("the lock was let go while the restore still runs")
					}
				}
				close(release[s])
			}

			eventually(t, "the restore to be recorded as succeeded", func() bool { return adminStatus(t, h).State == restoreStateSucceeded })
			eventually(t, "the lock to be let go", func() bool { return lockFree(h) })
			st := adminStatus(t, h)
			if st.Database != restoreDBRestored || !st.RestartRequired || st.Finished == nil || st.Step != "" {
				t.Errorf("the record after it ended: %+v", st)
			}
			ran, ctxErrs, archive := f.snapshot()
			if len(ran) != 3 {
				t.Fatalf("steps run: %v, want all three", ran)
			}
			for s, err := range ctxErrs {
				if err != nil {
					t.Errorf("%s ran on a context that ended (%v): it is still tied to the request", s, err)
				}
			}
			if _, err := os.Stat(archive); !os.IsNotExist(err) {
				t.Errorf("the uploaded archive %s is still there (stat: %v)", archive, err)
			}
			// Nothing was written to a client that had gone.
			if rec.Body.Len() != 0 {
				t.Errorf("the handler wrote %q after its client left", rec.Body.String())
			}
			// The ticket still reads it: the admin who started it, signed out
			// by the restore, can learn how it ended.
			if rr, tst := ticketStatus(h, testRestoreTicket); rr.Code != http.StatusOK || tst.State != restoreStateSucceeded {
				t.Errorf("the ticket read: %d %+v", rr.Code, tst)
			}
		})
	}
}

// TestARestoreStillAnswersAClientThatWaited: a client that stays gets the
// answers it always did, with the record saying the same.
func TestARestoreStillAnswersAClientThatWaited(t *testing.T) {
	cases := []struct {
		name      string
		failAt    restoreStep
		stderr    string
		wantCode  int
		wantText  string
		wantState string
		wantStep  string
		wantDB    string
	}{
		{"it succeeds", "", "", http.StatusOK, restoreSucceededMessage, restoreStateSucceeded, "", restoreDBRestored},
		{"the archive cannot be read in full", restoreStepChecking, "unexpected end of file", http.StatusBadRequest,
			"the database was NOT modified: unexpected end of file", restoreStateFailed, "checking", restoreDBUnchanged},
		{"the wipe fails", restoreStepClearing, "permission denied for schema public", http.StatusInternalServerError,
			"pre-restore wipe failed: exit status 1 — psql said: permission denied for schema public", restoreStateFailed, "clearing", restoreDBUnchanged},
		{"pg_restore fails after the wipe", restoreStepRestoring, "relation already exists", http.StatusInternalServerError,
			"restore failed; database is in wiped state, retry with a valid backup. pg_restore said: relation already exists", restoreStateFailed, "restoring", restoreDBEmpty},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeRestore()
			if c.failAt != "" {
				stderr := c.stderr
				f.steps[c.failAt] = func(context.Context) (string, error) { return stderr, errors.New("exit status 1") }
			}
			h := newRestoreHandler(f)
			rec, done := startRestore(t, h, context.Background(), "")
			waitFor(t, "the answer", done)
			if rec.Code != c.wantCode || !strings.Contains(rec.Body.String(), c.wantText) {
				t.Errorf("answer: %d %s, want %d containing %q", rec.Code, rec.Body, c.wantCode, c.wantText)
			}
			st := adminStatus(t, h)
			if st.State != c.wantState || st.Step != c.wantStep || st.Database != c.wantDB || !strings.Contains(st.Message, c.wantText) {
				t.Errorf("record: %+v, want %s at %q, database %s, message containing %q", st, c.wantState, c.wantStep, c.wantDB, c.wantText)
			}
			if st.File != "aurora-backup.dump" || st.Started == nil || st.Finished == nil {
				t.Errorf("record's file and times: %+v", st)
			}
			if st.RestartRequired != (c.failAt == "") {
				t.Errorf("restart_required = %v after %s", st.RestartRequired, c.name)
			}
			// The answer went only after the lock was let go: a client told the
			// restore ended can start the next one at once.
			if !lockFree(h) {
				t.Error("the lock is still held after the answer")
			}
			ran, _, _ := f.snapshot()
			if c.failAt == restoreStepChecking && len(ran) != 1 {
				t.Errorf("an archive that failed its check went on to %v", ran)
			}
		})
	}
}

// TestTheRestoreStatusReportsEachState: none before any restore, each step
// while running with what it has done to the database so far, and a restore
// the server's shutdown or the timeout cut short as unknown.
func TestTheRestoreStatusReportsEachState(t *testing.T) {
	t.Run("none", func(t *testing.T) {
		st := adminStatus(t, newRestoreHandler(newFakeRestore()))
		if st.State != restoreStateNone || st.RestartRequired || st.File != "" || st.Started != nil {
			t.Errorf("before any restore: %+v", st)
		}
	})

	t.Run("running, step by step", func(t *testing.T) {
		f := newFakeRestore()
		want := map[restoreStep]string{
			restoreStepChecking:  restoreDBUnchanged,
			restoreStepClearing:  restoreDBUnknown,
			restoreStepRestoring: restoreDBEmpty,
		}
		started := map[restoreStep]chan struct{}{}
		release := map[restoreStep]chan struct{}{}
		for s := range want {
			started[s], release[s] = make(chan struct{}), make(chan struct{})
			f.steps[s] = hold(started[s], release[s])
		}
		h := newRestoreHandler(f)
		_, done := startRestore(t, h, context.Background(), "")
		for _, s := range []restoreStep{restoreStepChecking, restoreStepClearing, restoreStepRestoring} {
			waitFor(t, string(s), started[s])
			st := adminStatus(t, h)
			if st.State != restoreStateRunning || st.Step != string(s) || st.Database != want[s] || st.Finished != nil || st.Message != "" {
				t.Errorf("while %s: %+v, want running with database %s", s, st, want[s])
			}
			close(release[s])
		}
		waitFor(t, "the answer", done)
	})

	t.Run("cut short by shutdown while restoring", func(t *testing.T) {
		f := newFakeRestore()
		started, release := make(chan struct{}), make(chan struct{})
		f.steps[restoreStepRestoring] = hold(started, release)
		h := newRestoreHandler(f)
		root, shutdown := context.WithCancel(context.Background())
		h.SetRootContext(root)
		rec, done := startRestore(t, h, context.Background(), "")
		waitFor(t, "pg_restore to start", started)
		shutdown()
		waitFor(t, "the answer", done)
		st := adminStatus(t, h)
		if st.State != restoreStateFailed || st.Step != string(restoreStepRestoring) || st.Database != restoreDBUnknown ||
			!strings.Contains(st.Message, "shutting down") || st.RestartRequired {
			t.Errorf("a restore stopped by shutdown: %+v", st)
		}
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("answer: %d", rec.Code)
		}
	})

	t.Run("cut short while the old data was being cleared", func(t *testing.T) {
		f := newFakeRestore()
		started, release := make(chan struct{}), make(chan struct{})
		f.steps[restoreStepClearing] = hold(started, release)
		h := newRestoreHandler(f)
		root, shutdown := context.WithCancel(context.Background())
		h.SetRootContext(root)
		_, done := startRestore(t, h, context.Background(), "")
		waitFor(t, "the wipe to start", started)
		shutdown()
		waitFor(t, "the answer", done)
		if st := adminStatus(t, h); st.State != restoreStateFailed || st.Step != string(restoreStepClearing) || st.Database != restoreDBUnknown {
			t.Errorf("a wipe stopped part way: %+v", st)
		}
		if ran, _, _ := f.snapshot(); len(ran) != 2 {
			t.Errorf("steps run after the wipe was stopped: %v", ran)
		}
	})

	t.Run("a refused restore after a success still says to restart", func(t *testing.T) {
		f := newFakeRestore()
		h := newRestoreHandler(f)
		_, done := startRestore(t, h, context.Background(), "")
		waitFor(t, "the first restore", done)
		f.mu.Lock()
		f.steps[restoreStepChecking] = func(context.Context) (string, error) { return "bad archive", errors.New("exit status 1") }
		f.mu.Unlock()
		_, done = startRestore(t, h, context.Background(), "")
		waitFor(t, "the second restore", done)
		st := adminStatus(t, h)
		if st.State != restoreStateFailed || st.Database != restoreDBUnchanged || !st.RestartRequired {
			t.Errorf("after a success and a refusal: %+v, want the refusal with restart_required", st)
		}
	})

	t.Run("a panic is recorded, not fatal", func(t *testing.T) {
		f := newFakeRestore()
		f.steps[restoreStepRestoring] = func(context.Context) (string, error) { panic("boom") }
		h := newRestoreHandler(f)
		rec, done := startRestore(t, h, context.Background(), "")
		waitFor(t, "the answer", done)
		st := adminStatus(t, h)
		if rec.Code != http.StatusInternalServerError || st.State != restoreStateFailed ||
			st.Step != string(restoreStepRestoring) || st.Database != restoreDBUnknown {
			t.Errorf("a panic mid-restore: %d, %+v", rec.Code, st)
		}
		if !lockFree(h) {
			t.Error("a panic left the lock held")
		}
	})
}

// TestASecondRestoreIsRefusedWhileOneRuns: the lock outlives the request now,
// so the 409 must too, for a restore and a backup alike, while the record
// stays readable; once the first ends, the next goes ahead.
func TestASecondRestoreIsRefusedWhileOneRuns(t *testing.T) {
	f := newFakeRestore()
	started, release := make(chan struct{}), make(chan struct{})
	f.steps[restoreStepRestoring] = hold(started, release)
	h := newRestoreHandler(f)
	reqCtx, leave := context.WithCancel(context.Background())
	_, firstDone := startRestore(t, h, reqCtx, testRestoreTicket)
	waitFor(t, "the first restore's pg_restore", started)
	leave()
	waitFor(t, "the first request to end", firstDone)

	second := httptest.NewRecorder()
	h.Restore(second, restoreRequest(t, context.Background(), ""))
	if second.Code != http.StatusConflict {
		t.Errorf("a second restore while the first runs: %d %s, want 409", second.Code, second.Body)
	}
	backup := httptest.NewRecorder()
	h.Backup(backup, httptest.NewRequest(http.MethodGet, "/api/admin/backup", nil))
	if backup.Code != http.StatusConflict {
		t.Errorf("a backup while a restore runs: %d, want 409", backup.Code)
	}
	// The refusal neither replaced the record nor its ticket.
	if rr, st := ticketStatus(h, testRestoreTicket); rr.Code != http.StatusOK || st.State != restoreStateRunning {
		t.Errorf("the first restore's record after the refusals: %d %+v", rr.Code, st)
	}

	close(release)
	eventually(t, "the first restore to end", func() bool { return lockFree(h) })
	f.mu.Lock()
	delete(f.steps, restoreStepRestoring)
	f.mu.Unlock()
	third := httptest.NewRecorder()
	h.Restore(third, restoreRequest(t, context.Background(), ""))
	if third.Code != http.StatusOK {
		t.Errorf("a restore after the first ended: %d %s", third.Code, third.Body)
	}
}

// TestTheTicketReadsOnlyItsOwnRestore: the ticket route has no session
// check, so it must answer the latest restore's ticket and nothing else, the
// same 404 every other way.
func TestTheTicketReadsOnlyItsOwnRestore(t *testing.T) {
	h := newRestoreHandler(newFakeRestore())
	other := strings.Repeat("A", 43)
	for _, tk := range []string{"", testRestoreTicket, other} {
		if rr, _ := ticketStatus(h, tk); rr.Code != http.StatusNotFound || errorReasonOf(rr) != "restore_unknown" {
			t.Errorf("before any restore, ticket %q: %d %q, want 404 restore_unknown", tk, rr.Code, errorReasonOf(rr))
		}
	}

	_, done := startRestore(t, h, context.Background(), testRestoreTicket)
	waitFor(t, "the restore", done)
	if rr, st := ticketStatus(h, testRestoreTicket); rr.Code != http.StatusOK || st.State != restoreStateSucceeded || st.File != "aurora-backup.dump" {
		t.Errorf("its own ticket: %d %+v", rr.Code, st)
	} else if cc := rr.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("ticket read Cache-Control = %q", cc)
	} else if strings.Contains(rr.Body.String(), "message") {
		// psql's and pg_restore's own output can quote a row of the failing
		// table; the ticket read has no session behind it.
		t.Errorf("the ticket read carries the server's text: %s", rr.Body)
	}
	if adminStatus(t, h).Message == "" {
		t.Error("the admin read lost the server's text")
	}
	// A body is the same for every refusal, so it says nothing about the
	// restore that exists.
	var refusals []string
	for _, tk := range []string{"", other, testRestoreTicket[:31], testRestoreTicket + "!", strings.ToUpper(testRestoreTicket)} {
		rr, _ := ticketStatus(h, tk)
		if rr.Code != http.StatusNotFound {
			t.Errorf("ticket %q read the restore: %d", tk, rr.Code)
		}
		refusals = append(refusals, rr.Body.String())
	}
	for _, b := range refusals[1:] {
		if b != refusals[0] {
			t.Errorf("refusals differ: %q vs %q", b, refusals[0])
		}
	}

	// A newer restore, with no ticket, replaces the record and the ticket.
	_, done = startRestore(t, h, context.Background(), "")
	waitFor(t, "the newer restore", done)
	if rr, _ := ticketStatus(h, testRestoreTicket); rr.Code != http.StatusNotFound {
		t.Errorf("an older restore's ticket after a newer restore: %d, want 404", rr.Code)
	}
}

// TestAMalformedTicketIsRefusedBeforeAnything: a ticket its sender could
// not read the status with (too short to be a secret, or outside the
// alphabet) is refused before the lock, the upload or any command.
func TestAMalformedTicketIsRefusedBeforeAnything(t *testing.T) {
	for _, bad := range []string{"short", strings.Repeat("a", 31), strings.Repeat("a", 129), strings.Repeat("a", 40) + "/=", strings.Repeat("é", 20)} {
		f := newFakeRestore()
		h := newRestoreHandler(f)
		rr := httptest.NewRecorder()
		h.Restore(rr, restoreRequest(t, context.Background(), bad))
		ran, _, _ := f.snapshot()
		if rr.Code != http.StatusBadRequest || len(ran) != 0 || !lockFree(h) || adminStatus(t, h).State != restoreStateNone {
			t.Errorf("ticket %q: %d %s, ran %v", bad, rr.Code, rr.Body, ran)
		}
	}
	for _, good := range []string{strings.Repeat("a", 32), strings.Repeat("Z", 128), testRestoreTicket} {
		if !validRestoreTicket(good) {
			t.Errorf("%q refused", good)
		}
	}
}

// TestARefusedUploadRecordsNothing: refusals of the upload itself (no file,
// wrong format, too small) are answered on the request as before; they never
// started a restore, so they neither replace the record nor hold the lock.
func TestARefusedUploadRecordsNothing(t *testing.T) {
	f := newFakeRestore()
	h := newRestoreHandler(f)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("backup", "tiny.dump")
	_, _ = fw.Write([]byte("PGDMP"))
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	h.Restore(rr, req)
	ran, _, _ := f.snapshot()
	if rr.Code != http.StatusBadRequest || len(ran) != 0 || !lockFree(h) || adminStatus(t, h).State != restoreStateNone {
		t.Errorf("a 5-byte upload: %d %s, ran %v", rr.Code, rr.Body, ran)
	}
}

// TestTheRestoreStatusRoutesAreMounted: the ticket read sits outside the
// session checks (a request with no credentials gets the ticket's 404, not a
// 401), and the admin read behind them. The admin read's refusal of a user
// and a restricted session is in TestAdminRoutesRefuseARestrictedSession.
func TestTheRestoreStatusRoutesAreMounted(t *testing.T) {
	router := NewRouter(RouterDeps{Cfg: &config.Config{}, AuthSvc: healthTestService(), StartTime: time.Now()})

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/restore/status", nil))
	if rr.Code != http.StatusNotFound || errorReasonOf(rr) != "restore_unknown" {
		t.Errorf("GET /api/restore/status with no ticket: %d %s, want the ticket route's 404", rr.Code, rr.Body)
	}

	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/admin/restore/status", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("GET /api/admin/restore/status with no credentials: %d, want 401", rr.Code)
	}
}

func TestRestoreFileLabel(t *testing.T) {
	cases := map[string]string{
		"aurora-backup-2026-05-18T03-42-15Z.dump": "aurora-backup-2026-05-18T03-42-15Z.dump",
		"../../etc/passwd":                        "passwd",
		"a\x00b\nc‮d.dump":                        "abcd.dump",
		"":                                        "",
		".":                                       "",
		strings.Repeat("x", 250):                  strings.Repeat("x", 200) + "…",
	}
	for in, want := range cases {
		if got := restoreFileLabel(in); got != want {
			t.Errorf("restoreFileLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

// exitError runs a shell that ends as script says, for a real
// *exec.ExitError.
func exitError(t *testing.T, script string) error {
	t.Helper()
	err := exec.Command("sh", "-c", script).Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("sh -c %q: %v, want an exit error", script, err)
	}
	return err
}

// TestAFailedWipeSaysWhatItLeft: the wipe is one statement, so a statement
// that failed changed nothing, but psql also fails when its connection goes
// mid-statement, and the server can still commit a statement whose client
// has gone. Only what psql's exit and libpq's words rule out is "unchanged".
func TestAFailedWipeSaysWhatItLeft(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		stderr string
		want   string
	}{
		{"the statement failed", exitError(t, "exit 1"), "ERROR:  permission denied for schema public", restoreDBUnchanged},
		{"a script error under ON_ERROR_STOP", exitError(t, "exit 3"), "ERROR:  syntax error", restoreDBUnchanged},
		{"never connected (libpq 14+)", exitError(t, "exit 2"), `psql: error: connection to server at "db" (10.0.0.2), port 5432 failed: Connection refused`, restoreDBUnchanged},
		{"never connected (older libpq)", exitError(t, "exit 2"), "psql: could not connect to server: No such file or directory", restoreDBUnchanged},
		{"lost mid-statement", exitError(t, "exit 2"), "server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally", restoreDBUnknown},
		{"lost, as libpq says it", exitError(t, "exit 2"), "connection to server was lost", restoreDBUnknown},
		{"killed", exitError(t, "kill -9 $$"), "", restoreDBUnknown},
		{"psql is not installed", errors.New(`exec: "psql": executable file not found in $PATH`), "", restoreDBUnchanged},
	}
	for _, c := range cases {
		if got := wipeLeftDatabase(c.err, c.stderr); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}

	// Through the handler: a connection lost mid-wipe is recorded as in doubt.
	f := newFakeRestore()
	lost := exitError(t, "exit 2")
	f.steps[restoreStepClearing] = func(context.Context) (string, error) { return "server closed the connection unexpectedly", lost }
	h := newRestoreHandler(f)
	rec, done := startRestore(t, h, context.Background(), "")
	waitFor(t, "the answer", done)
	st := adminStatus(t, h)
	if st.State != restoreStateFailed || st.Step != string(restoreStepClearing) || st.Database != restoreDBUnknown ||
		!strings.Contains(rec.Body.String(), "may be as it was or empty") {
		t.Errorf("a wipe whose connection was lost: %d %s, record %+v", rec.Code, rec.Body, st)
	}
}
