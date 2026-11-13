package api

// The restore as a job: it outlives the request that uploaded the file, holds
// the backup/restore lock for its whole life, reports its phase and outcome,
// and holds a shutdown back. These run without a database (the pipeline is
// replaced), except the pipeline test that needs only pg_restore; the
// end-to-end restore against PostgreSQL is in admin_backup_test.go.

import (
	"bytes"
	"context"
	"encoding/json"
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

// archiveLike passes the handler's cheap checks (the PGDMP magic, at least 256
// bytes) without being a real archive.
func archiveLike() []byte {
	return append([]byte("PGDMP"), bytes.Repeat([]byte{0}, 400)...)
}

// restoreRequest builds the multipart POST the Admin page sends.
func restoreRequest(t *testing.T, ctx context.Context, name string, body []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("backup", name)
	if err != nil {
		t.Fatalf("form file: %v", err)
	}
	if _, err := fw.Write(body); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", &buf).WithContext(ctx)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

// fakeRestore is a pipeline that walks the phases and waits where told.
type fakeRestore struct {
	mu sync.Mutex
	// ctx is the context the job ran the pipeline with.
	ctx context.Context
	// path is the archive it was handed.
	path string
	// hold, when non-nil, is waited on once the restoring phase begins
	// (or until the job's context ends, as a killed pg_restore would).
	hold chan struct{}
	// started is closed when the pipeline is running.
	started chan struct{}
	end     restoreEnd
}

func newFakeRestore() *fakeRestore {
	return &fakeRestore{
		hold:    make(chan struct{}),
		started: make(chan struct{}),
		end:     restoreEnd{ok: true, phase: RestoreRestoring, database: RestoreDBRestored, message: "Restore complete."},
	}
}

func (f *fakeRestore) run(ctx context.Context, _ string, path string, setPhase func(RestorePhase)) restoreEnd {
	f.mu.Lock()
	f.ctx = ctx
	f.path = path
	f.mu.Unlock()
	close(f.started)
	setPhase(RestoreValidating)
	setPhase(RestoreWiping)
	setPhase(RestoreRestoring)
	if f.hold != nil {
		select {
		case <-f.hold:
		case <-ctx.Done():
			return restoreEnd{phase: RestoreRestoring, database: RestoreDBMayBeEmpty, message: "restore failed (signal: killed); database is in wiped state, retry with a valid backup."}
		}
	}
	return f.end
}

func (f *fakeRestore) jobCtx() context.Context {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ctx
}

// newJobHandler builds an AdminHandler whose restores run fake on base.
func newJobHandler(t *testing.T, base context.Context, f *fakeRestore) *AdminHandler {
	t.Helper()
	rj := NewRestoreJobs(base)
	rj.run = f.run
	h := &AdminHandler{databaseURL: "postgres://aurora@127.0.0.1:1/none"}
	h.SetRestoreJobs(rj)
	return h
}

// startRestore POSTs an upload and answers the status the 202 carried.
func startRestore(t *testing.T, h *AdminHandler, ctx context.Context) RestoreStatus {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Restore(rec, restoreRequest(t, ctx, "aurora-backup.dump", archiveLike()))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("Restore answered %d, want 202: %s", rec.Code, rec.Body.String())
	}
	var st RestoreStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode the 202's status: %v: %s", err, rec.Body.String())
	}
	if st.Running == nil || st.Running.ID == "" {
		t.Fatalf("the 202 names no running restore: %s", rec.Body.String())
	}
	return st
}

// waitRestoreEnd polls until the job has ended and answers its outcome.
func waitRestoreEnd(t *testing.T, rj *RestoreJobs, id string) RestoreResult {
	t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		st := rj.Status()
		if st.Running == nil && st.Last != nil && st.Last.ID == id {
			return *st.Last
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("restore %s did not end; status %+v", id, rj.Status())
	return RestoreResult{}
}

// waitUnlocked polls until the backup/restore lock is free and takes it back
// off again.
func waitUnlocked(t *testing.T, h *AdminHandler) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if h.backupRestoreMu.TryLock() {
			h.backupRestoreMu.Unlock()
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the backup/restore lock was not released after the restore ended")
}

// TestARestoreOutlivesItsRequest is the property the job exists for. The
// restore used to run on r.Context(): a reload, a closed tab or a dropped
// connection cancelled it part way, and pg_restore killed after the wipe left
// the database empty.
func TestARestoreOutlivesItsRequest(t *testing.T) {
	f := newFakeRestore()
	h := newJobHandler(t, context.Background(), f)
	reqCtx, cancelRequest := context.WithCancel(context.Background())
	st := startRestore(t, h, reqCtx)
	<-f.started

	// The browser goes while pg_restore runs.
	cancelRequest()
	time.Sleep(20 * time.Millisecond)
	if err := f.jobCtx().Err(); err != nil {
		t.Fatalf("the restore's context ended with its request's (%v): the restore would be killed part way", err)
	}
	close(f.hold)
	got := waitRestoreEnd(t, h.restores(), st.Running.ID)
	if !got.Succeeded || got.Database != RestoreDBRestored || got.Stopped != "" {
		t.Fatalf("outcome %+v, want succeeded, restored", got)
	}
}

// TestARestoreHoldsTheBackupLockForItsWholeLife: the 409 between a backup and
// a restore, and between two restores, used to come from a lock the handler
// held while it ran; the job must hold it until it ends, however it ends.
func TestARestoreHoldsTheBackupLockForItsWholeLife(t *testing.T) {
	for _, tc := range []struct {
		name string
		end  restoreEnd
	}{
		{"one that succeeds", restoreEnd{ok: true, phase: RestoreRestoring, database: RestoreDBRestored, message: "ok"}},
		{"one that fails", restoreEnd{phase: RestoreRestoring, database: RestoreDBMayBeEmpty, message: "restore failed"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeRestore()
			f.end = tc.end
			h := newJobHandler(t, context.Background(), f)
			st := startRestore(t, h, context.Background())
			<-f.started
			f.mu.Lock()
			upload := f.path
			f.mu.Unlock()
			if _, err := os.Stat(upload); err != nil {
				t.Fatalf("the job's archive is gone while it runs: %v", err)
			}

			// A second restore and a backup are refused while it runs.
			rec := httptest.NewRecorder()
			h.Restore(rec, restoreRequest(t, context.Background(), "second.dump", archiveLike()))
			if rec.Code != http.StatusConflict {
				t.Errorf("a second restore while one runs: %d, want 409", rec.Code)
			}
			rec = httptest.NewRecorder()
			h.Backup(rec, httptest.NewRequest(http.MethodGet, "/api/admin/backup", nil))
			if rec.Code != http.StatusConflict {
				t.Errorf("a backup while a restore runs: %d, want 409", rec.Code)
			}
			if h.backupRestoreMu.TryLock() {
				h.backupRestoreMu.Unlock()
				t.Fatal("the backup/restore lock is free while the restore runs")
			}

			close(f.hold)
			got := waitRestoreEnd(t, h.restores(), st.Running.ID)
			if got.Succeeded != tc.end.ok {
				t.Fatalf("outcome %+v", got)
			}
			waitUnlocked(t, h)
			if _, err := os.Stat(upload); !os.IsNotExist(err) {
				t.Errorf("the uploaded archive is still on disk after the job ended (%v)", err)
			}
		})
	}
}

// TestARefusedUploadReleasesTheLock: the cheap checks still answer on the
// request, start nothing, and leave the lock free.
func TestARefusedUploadReleasesTheLock(t *testing.T) {
	f := newFakeRestore()
	h := newJobHandler(t, context.Background(), f)
	rec := httptest.NewRecorder()
	h.Restore(rec, restoreRequest(t, context.Background(), "tiny.dump", []byte("PGDMP")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a 5-byte upload: %d, want 400", rec.Code)
	}
	select {
	case <-f.started:
		t.Fatal("a refused upload started a restore")
	default:
	}
	if st := h.restores().Status(); st.Running != nil || st.Last != nil {
		t.Fatalf("a refused upload left a status: %+v", st)
	}
	waitUnlocked(t, h)
}

// TestTheRestoreStatusFollowsTheJob: the phase as each step begins, then the
// outcome; the 202 and the status route answer the same shape.
func TestTheRestoreStatusFollowsTheJob(t *testing.T) {
	f := newFakeRestore()
	f.hold = nil
	h := newJobHandler(t, context.Background(), f)
	rj := h.restores()
	gates := map[RestorePhase]chan struct{}{
		RestoreValidating: make(chan struct{}),
		RestoreWiping:     make(chan struct{}),
		RestoreRestoring:  make(chan struct{}),
	}
	reached := make(chan RestorePhase, 3)
	rj.phaseHookForTest = func(p RestorePhase) {
		reached <- p
		<-gates[p]
	}
	st := startRestore(t, h, context.Background())
	if st.Running.Phase != RestoreValidating || st.Running.File != "aurora-backup.dump" || st.Running.StartedAt.IsZero() {
		t.Fatalf("the 202's running restore: %+v", st.Running)
	}

	readStatus := func() RestoreStatus {
		rec := httptest.NewRecorder()
		h.RestoreStatus(rec, httptest.NewRequest(http.MethodGet, "/api/admin/restore/status", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status: %d", rec.Code)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("status Cache-Control %q, want no-store", cc)
		}
		var got RestoreStatus
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode status: %v", err)
		}
		return got
	}
	for _, p := range []RestorePhase{RestoreValidating, RestoreWiping, RestoreRestoring} {
		if got := <-reached; got != p {
			t.Fatalf("reached %q, want %q", got, p)
		}
		got := readStatus()
		if got.Running == nil || got.Running.ID != st.Running.ID || got.Running.Phase != p {
			t.Fatalf("during %s the status says %+v", p, got.Running)
		}
		close(gates[p])
	}
	end := waitRestoreEnd(t, rj, st.Running.ID)
	got := readStatus()
	if got.Running != nil || got.Last == nil || got.Last.ID != st.Running.ID {
		t.Fatalf("after the end the status says %+v", got)
	}
	if !end.Succeeded || end.File != "aurora-backup.dump" || end.EndedAt.Before(end.StartedAt) {
		t.Fatalf("outcome %+v", end)
	}
}

// TestShutdownWaitsForARunningRestore: main calls Drain before it cancels the
// lifecycle context, and Drain holds until the restore has ended and let the
// lock go; meanwhile no new restore starts.
func TestShutdownWaitsForARunningRestore(t *testing.T) {
	f := newFakeRestore()
	h := newJobHandler(t, context.Background(), f)
	st := startRestore(t, h, context.Background())
	<-f.started

	drained := make(chan bool, 1)
	go func() { drained <- h.restores().Drain(time.Minute) }()
	select {
	case <-drained:
		t.Fatal("Drain returned while the restore was still running")
	case <-time.After(50 * time.Millisecond):
	}
	if !h.restores().Running() {
		t.Fatal("the restore stopped running while shutdown waited")
	}
	close(f.hold)
	select {
	case ok := <-drained:
		if !ok {
			t.Fatal("Drain reported the restore still running")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Drain did not return once the restore ended")
	}
	// Drain returns once the job has let its lock go.
	if !h.backupRestoreMu.TryLock() {
		t.Fatal("the lock is still held when Drain returns")
	}
	h.backupRestoreMu.Unlock()
	if last := h.restores().Status().Last; last == nil || last.ID != st.Running.ID || !last.Succeeded {
		t.Fatalf("outcome after the wait: %+v", last)
	}

	// After Drain no restore starts: 503, nothing run, the lock free.
	f2 := newFakeRestore()
	h.restores().run = f2.run
	rec := httptest.NewRecorder()
	h.Restore(rec, restoreRequest(t, context.Background(), "late.dump", archiveLike()))
	if rec.Code != http.StatusServiceUnavailable || errorReasonOf(rec) != "shutting_down" {
		t.Fatalf("a restore after shutdown began: %d %q, want 503 shutting_down", rec.Code, errorReasonOf(rec))
	}
	select {
	case <-f2.started:
		t.Fatal("a restore started after shutdown began")
	default:
	}
	waitUnlocked(t, h)
}

// TestARestoreStillRunningAfterTheWaitIsStoppedByShutdown: the wait is
// bounded; past it main cancels the lifecycle context, which kills the
// restore, and its outcome says why and that the database may be empty.
func TestARestoreStillRunningAfterTheWaitIsStoppedByShutdown(t *testing.T) {
	f := newFakeRestore()
	base, cancelServer := context.WithCancel(context.Background())
	defer cancelServer()
	h := newJobHandler(t, base, f)
	st := startRestore(t, h, context.Background())
	<-f.started

	if h.restores().Drain(30 * time.Millisecond) {
		t.Fatal("Drain reported nothing running while the restore was held")
	}
	cancelServer()
	got := waitRestoreEnd(t, h.restores(), st.Running.ID)
	if got.Succeeded || got.Stopped != "shutdown" || got.Database != RestoreDBMayBeEmpty {
		t.Fatalf("outcome %+v, want failed, stopped by shutdown, may be empty", got)
	}
	if !strings.Contains(got.Message, "shutting down") {
		t.Errorf("message %q does not say the server stopped it", got.Message)
	}
	waitUnlocked(t, h)
}

// TestThePipelineValidatesBeforeTheWipe runs the real pipeline on an upload
// that passes the handler's cheap checks but is no archive: pg_restore's
// validation must refuse it in the job, before psql is ever run (the URL here
// points nowhere, so a wipe would fail with phase "wiping"), and the status
// must say the database was not changed.
func TestThePipelineValidatesBeforeTheWipe(t *testing.T) {
	if _, err := exec.LookPath("pg_restore"); err != nil {
		t.Skip("pg_restore not on PATH")
	}
	h := &AdminHandler{databaseURL: "postgres://aurora@127.0.0.1:1/none"}
	h.SetRestoreJobs(NewRestoreJobs(context.Background()))
	st := startRestore(t, h, context.Background())
	got := waitRestoreEnd(t, h.restores(), st.Running.ID)
	if got.Succeeded || got.Phase != RestoreValidating || got.Database != RestoreDBUnchanged {
		t.Fatalf("outcome %+v, want failed in validating with the database unchanged", got)
	}
	if !strings.Contains(got.Message, "NOT modified") || got.Stderr == "" {
		t.Errorf("outcome says %q with stderr %q; want the not-modified sentence and pg_restore's words", got.Message, got.Stderr)
	}
	waitUnlocked(t, h)
}

func TestTheRestoreFileNameIsPlainText(t *testing.T) {
	for in, want := range map[string]string{
		"aurora-backup.dump":            "aurora-backup.dump",
		"/home/me/aurora.dump":          "aurora.dump",
		`C:\Users\me\aurora.dump`:       "aurora.dump",
		"a\u202ecod.exe\u202c.dump":     "acod.exe.dump",
		"line\nbreak.dump":              "linebreak.dump",
		"":                              "the uploaded file",
		"   ":                           "the uploaded file",
		strings.Repeat("é", 150) + ".d": strings.Repeat("é", 100),
	} {
		if got := restoreFileName(in); got != want {
			t.Errorf("restoreFileName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestRestoreJobsUseTheLifecycleContextGiven: a job's context derives from
// the lifecycle context the registry was built with (main passes its root
// context), bounded to 60 minutes. The router's hand-over of main's registry
// is pinned in TestTheRouterServesMainsRestoreJobs.
func TestRestoreJobsUseTheLifecycleContextGiven(t *testing.T) {
	type key struct{}
	base := context.WithValue(context.Background(), key{}, "lifecycle")
	f := newFakeRestore()
	f.hold = nil
	h := newJobHandler(t, base, f)
	st := startRestore(t, h, context.Background())
	waitRestoreEnd(t, h.restores(), st.Running.ID)
	if v := f.jobCtx().Value(key{}); v != "lifecycle" {
		t.Fatalf("the job's context does not derive from the lifecycle context it was given (value %v)", v)
	}
	if dl, ok := f.jobCtx().Deadline(); !ok || time.Until(dl) > restoreJobTimeout {
		t.Fatalf("the job's context has no 60-minute bound (deadline %v, %v)", dl, ok)
	}
}

// TestTheRouterServesMainsRestoreJobs: the status route answers from the
// registry main hands the router (the one its shutdown waits for), to an
// unrestricted admin session; a restricted session is refused there like on
// every admin route (TestAdminRoutesRefuseARestrictedSession lists it).
func TestTheRouterServesMainsRestoreJobs(t *testing.T) {
	f := newLockFixture(t)
	ctx := context.Background()
	if _, err := lockTestPool(t).Exec(ctx, `UPDATE users SET role = 'admin' WHERE id = $1`, f.userID); err != nil {
		t.Fatalf("make the user an admin: %v", err)
	}
	u, err := f.q.GetUserByID(ctx, f.userID)
	if err != nil {
		t.Fatalf("read the user: %v", err)
	}
	rj := NewRestoreJobs(ctx)
	rj.last = &RestoreResult{ID: "from-main", Succeeded: true, Phase: RestoreRestoring, Database: RestoreDBRestored}
	svc := healthTestService()
	router := NewRouter(RouterDeps{Cfg: &config.Config{}, AuthSvc: svc, Queries: f.q, StartTime: time.Now(), RestoreJobs: rj})
	read := func(rt int64) *httptest.ResponseRecorder {
		tok, _, err := svc.GenerateAccessToken(f.userID, u.Username, "admin", u.TokenVersion, rt)
		if err != nil {
			t.Fatalf("mint a token: %v", err)
		}
		req := httptest.NewRequest(http.MethodGet, "/api/admin/restore/status", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr
	}
	rr := read(f.parentRT)
	var st RestoreStatus
	if rr.Code != http.StatusOK || json.Unmarshal(rr.Body.Bytes(), &st) != nil || st.Last == nil || st.Last.ID != "from-main" {
		t.Fatalf("the parent's status read: %d %s; want 200 with main's registry's last restore", rr.Code, rr.Body.String())
	}
	if rr := read(f.kidRT); rr.Code != http.StatusForbidden || errorReasonOf(rr) != "profile_restricted" {
		t.Fatalf("the kid's status read: %d %s; want 403 profile_restricted", rr.Code, rr.Body.String())
	}
}
