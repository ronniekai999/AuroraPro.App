package api

// The atomic pipeline's parts that need no database (admin_restore_pipeline.go):
// the table-of-contents check, the client programs' --restrict-key check
// (and the handler's refusal before it reads the upload), the reading of
// psql's commit lines, a check stopped by a shutdown, and the drain snapshot.
// The pipeline against PostgreSQL is in admin_backup_test.go.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/aurora-media/aurora/internal/streaming"
)

func TestTheTableOfContentsCheckReadsEachEntrysType(t *testing.T) {
	for line, want := range map[string]string{
		"215; 1259 16390 TABLE public users aurora":                    "TABLE",
		"4400; 0 16390 TABLE DATA public users aurora":                 "TABLE DATA",
		"301; 1259 16400 SEQUENCE OWNED BY public users_id_seq aurora": "SEQUENCE OWNED BY",
		"3; 3079 16485 EXTENSION - pg_trgm ":                           "EXTENSION",
		"4380; 2613 16999 BLOB - 16999 aurora":                         "BLOB",
		"4381; 0 0 BLOBS - BLOBS ":                                     "BLOBS",
		"12; 1262 16384 DATABASE - aurora aurora":                      "DATABASE",
		"13; 6100 16500 SUBSCRIPTION - sub aurora":                     "SUBSCRIPTION",
		"14; 1259 16600 SOMETHING NEW public x aurora":                 "SOMETHING",
		"; Archive created at 2026-11-13 10:00:00 UTC":                 "",
		"": "",
		"4449; 0 0 COMMENT - SCHEMA \"public\" aurora":            "COMMENT",
		"5000; 2606 17000 FK CONSTRAINT public x x_y_fkey aurora": "FK CONSTRAINT",
		"5001; 0 17001 MATERIALIZED VIEW DATA public mv aurora":   "MATERIALIZED VIEW DATA",
	} {
		if got := restoreTOCEntryType(line); got != want {
			t.Errorf("restoreTOCEntryType(%q) = %q, want %q", line, got, want)
		}
	}
	for _, refused := range []string{"BLOB", "BLOBS", "BLOB METADATA", "LARGE OBJECT", "DATABASE", "DATABASE PROPERTIES", "SUBSCRIPTION", "TABLESPACE", "SOMETHING"} {
		if restoreTOCAllowed[refused] {
			t.Errorf("%s is allowed; it cannot run inside the restore's transaction (or is unknown)", refused)
		}
	}
}

// fakeTools writes stand-in pg_restore and psql programs that answer --help
// with the given text.
func fakeTools(t *testing.T, pgRestoreHelp, psqlHelp string) restoreTools {
	t.Helper()
	dir := t.TempDir()
	write := func(name, help string) string {
		path := filepath.Join(dir, name)
		script := "#!/bin/sh\ncat <<'HELP'\n" + help + "\nHELP\n"
		if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		return path
	}
	return restoreTools{pgRestore: write("pg_restore", pgRestoreHelp), psql: write("psql", psqlHelp)}
}

// countingReader counts what the handler reads of an upload.
type countingReader struct {
	r io.Reader
	n atomic.Int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// TestClientProgramsWithoutRestrictKeyAreRefused: pg_restore's output is run
// through psql, which obeys backslash commands in it; only the \restrict pair
// (pg_restore --restrict-key, August 2025) keeps a crafted archive from making
// psql run shell commands. Older programs, and missing ones, are refused
// before the upload is read, and the two are said apart.
func TestClientProgramsWithoutRestrictKeyAreRefused(t *testing.T) {
	ctx := context.Background()
	newPgRestore := "  --restrict-key=RESTRICT_KEY  use provided string as psql \\restrict key"
	newPsql := "  \\unrestrict RESTRICT_KEY  exit restricted mode if key matches"
	if got := fakeTools(t, newPgRestore, newPsql).missingRestrictSupport(ctx); got != "" {
		t.Fatalf("both programs have it, yet %q is reported", got)
	}
	if got := fakeTools(t, "  --no-owner", newPsql).missingRestrictSupport(ctx); !strings.Contains(got, "pg_restore is too old") {
		t.Errorf("an old pg_restore: reported %q", got)
	}
	if got := fakeTools(t, newPgRestore, "  \\warn TEXT").missingRestrictSupport(ctx); !strings.Contains(got, "psql is too old") {
		t.Errorf("an old psql: reported %q", got)
	}
	missing := fakeTools(t, newPgRestore, newPsql)
	missing.pgRestore = filepath.Join(t.TempDir(), "no-such-pg_restore")
	if got := missing.missingRestrictSupport(ctx); !strings.Contains(got, "has no pg_restore") || strings.Contains(got, "too old") {
		t.Errorf("a missing pg_restore: reported %q, want it called missing", got)
	}
	missing = fakeTools(t, newPgRestore, newPsql)
	missing.psql = "aurora-no-such-psql"
	if got := missing.missingRestrictSupport(ctx); !strings.Contains(got, "has no psql") {
		t.Errorf("a psql not on $PATH: reported %q, want it called missing", got)
	}
	// The check run in the restore: refused before anything else runs.
	if status, msg := fakeTools(t, "  --no-owner", newPsql).check(ctx, "/nonexistent.dump"); status != http.StatusInternalServerError || !strings.Contains(msg, "--restrict-key") || !strings.Contains(msg, "NOT modified") {
		t.Fatalf("check with an old pg_restore: %d %q", status, msg)
	}

	// Through the handler: refused before the upload is read, nothing
	// recorded, the lock free.
	h := &AdminHandler{databaseURL: "postgres://aurora@127.0.0.1:1/none", restoreTools: fakeTools(t, "  --no-owner", newPsql)}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("backup", "aurora.dump")
	_, _ = fw.Write(append([]byte("PGDMP"), bytes.Repeat([]byte{0x01}, 512)...))
	_ = mw.Close()
	body := &countingReader{r: &buf}
	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set(restoreTicketHeader, testRestoreTicket)
	rec := httptest.NewRecorder()
	h.Restore(rec, req)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "--restrict-key") || !strings.Contains(rec.Body.String(), "NOT modified") {
		t.Fatalf("a restore with an old pg_restore: %d %s", rec.Code, rec.Body.String())
	}
	if n := body.n.Load(); n != 0 {
		t.Errorf("the handler read %d bytes of the upload before refusing it", n)
	}
	if st := h.restores.status(); st.State != restoreStateNone || !lockFree(h) {
		t.Errorf("after the refusal: record %+v, lock free %v; want nothing recorded and the lock free", st, lockFree(h))
	}
}

// TestACheckStoppedByAShutdownIsNotCalledABadFile: the full read of the
// archive is stopped by a shutdown; the record says so, not that the file is
// incomplete.
func TestACheckStoppedByAShutdownIsNotCalledABadFile(t *testing.T) {
	dir := t.TempDir()
	write := func(name, script string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		return path
	}
	started := filepath.Join(dir, "started")
	h := &AdminHandler{databaseURL: "postgres://aurora@127.0.0.1:1/none", restoreTools: restoreTools{
		pgRestore: write("pg_restore", `case "$*" in
*--help*) echo "  --restrict-key=RESTRICT_KEY" ;;
*-l*) echo "215; 1259 16390 TABLE public users aurora" ;;
*) touch '`+started+`'; exec sleep 30 ;;
esac
`),
		psql: write("psql", `echo '  \unrestrict RESTRICT_KEY'
`),
	}}
	root, stopServer := context.WithCancel(context.Background())
	defer stopServer()
	h.SetRootContext(root)
	_, done := startRestore(t, h, context.Background(), testRestoreTicket)
	eventually(t, "the archive read to start", func() bool { _, err := os.Stat(started); return err == nil })
	stopServer()
	waitFor(t, "the handler", done)
	st := h.restores.status()
	if st.State != restoreStateFailed || st.Step != string(restoreStepChecking) || st.Database != restoreDBUnchanged {
		t.Fatalf("record %+v, want failed while checking with the database unchanged", st)
	}
	if !strings.Contains(st.Message, "shutting down") || !strings.Contains(st.Message, "NOT modified") || strings.Contains(st.Message, "not a complete") {
		t.Errorf("message %q; want the stop, not a bad archive", st.Message)
	}
}

// TestTheRealCheckRefusesANonArchiveBeforeTheTransaction runs the real
// programs on an upload that passes the handler's cheap checks but is no
// archive: the check must refuse it before psql is run (the URL here points
// nowhere, so reaching the transaction would fail in step "restoring").
// pg_restore itself reads this one ("PGDMP" and 512 bytes of 0x01) as an
// archive with no entries, lists it and restores it without an error: only
// the check's refusal of an archive with no tables stops it, and restored it
// would have committed an empty database.
func TestTheRealCheckRefusesANonArchiveBeforeTheTransaction(t *testing.T) {
	if msg := (restoreTools{}).ready(context.Background()); msg != "" {
		t.Skip(msg)
	}
	h := &AdminHandler{databaseURL: "postgres://aurora@127.0.0.1:1/none"}
	rec, done := startRestore(t, h, context.Background(), testRestoreTicket)
	waitFor(t, "the handler", done)
	st := h.restores.status()
	if rec.Code != http.StatusBadRequest || st.State != restoreStateFailed || st.Step != string(restoreStepChecking) || st.Database != restoreDBUnchanged {
		t.Fatalf("answer %d, record %+v; want a 400 refused while checking with the database unchanged", rec.Code, st)
	}
	if !strings.Contains(st.Message, "NOT modified") || !strings.Contains(st.Message, "no tables") {
		t.Errorf("message %q; want the archive's lack of tables and that the database was not modified", st.Message)
	}
	if !lockFree(h) {
		t.Error("the lock is held after the refusal")
	}
}

// TestThePsqlProgressReaderFindsTheCommitLines: the commit block's lines are
// what decide restored, unchanged or unknown; they may arrive split across
// writes, and only exact lines with this restore's marker count.
func TestThePsqlProgressReaderFindsTheCommitLines(t *testing.T) {
	p := newRestoreProgress("m1")
	for _, chunk := range []string{"WARNING:  something\naurora-restore commit", "ting m1\n", "psql:<stdin>:9: ERROR:  deferred check failed\n"} {
		_, _ = p.Write([]byte(chunk))
	}
	if committing, committed, failed := p.state(); !committing || committed || !failed {
		t.Errorf("after a failed COMMIT: committing=%v committed=%v failed=%v", committing, committed, failed)
	}
	p = newRestoreProgress("m2")
	_, _ = p.Write([]byte("aurora-restore committing m1\nsays aurora-restore committed m2 inside\n"))
	if committing, committed, _ := p.state(); committing || committed {
		t.Errorf("another marker, or a marker inside a line, counted: committing=%v committed=%v", committing, committed)
	}
	_, _ = p.Write([]byte("aurora-restore committing m2\naurora-restore committed m2\n"))
	if committing, committed, failed := p.state(); !committing || !committed || failed {
		t.Errorf("after a COMMIT: committing=%v committed=%v failed=%v", committing, committed, failed)
	}
	big := strings.Repeat("x", 40*1024)
	_, _ = p.Write([]byte(big + "\nlast line\n"))
	if s := p.stderr(); len(s) > restoreStderrTail || !strings.HasSuffix(s, "last line") {
		t.Errorf("the kept stderr is %d bytes ending %q; want at most %d ending with the last line", len(s), s[len(s)-12:], restoreStderrTail)
	}
}

// TestTheRestoreArgumentsLeaveTheCommitToAurora: psql is never run with
// --single-transaction (or -1), which COMMITs at the end of its input whether
// or not pg_restore finished, and it stops at the first error. Pinned against
// PostgreSQL by TestPsqlReachingEndOfInputWithoutTheCommitRollsBack, which
// runs these arguments; this one runs without a database.
func TestTheRestoreArgumentsLeaveTheCommitToAurora(t *testing.T) {
	args := restorePsqlArgs("host=db dbname=aurora")
	joined := " " + strings.Join(args, " ") + " "
	for _, bad := range []string{" --single-transaction ", " -1 ", " -c "} {
		if strings.Contains(joined, bad) {
			t.Errorf("psql arguments %q carry %q", args, strings.TrimSpace(bad))
		}
	}
	for _, want := range []string{" -X ", " ON_ERROR_STOP=on ", " -f - ", " --no-password "} {
		if !strings.Contains(joined, want) {
			t.Errorf("psql arguments %q lack %q", args, strings.TrimSpace(want))
		}
	}
	pre := restorePreamble(restoreLockTimeout)
	if !strings.HasPrefix(strings.TrimSpace(pre), "BEGIN;") || strings.Contains(pre, "COMMIT") {
		t.Errorf("the preamble must open the transaction and never commit it:\n%s", pre)
	}
	if !strings.Contains(pre, restoreSetIfSupported("client_connection_check_interval", "1s")) {
		t.Error("the preamble does not set client_connection_check_interval where the server takes it: a killed psql's session keeps its locks until its statement ends")
	}
	// Plainly set, it failed every restore on a server that refuses it
	// (PostgreSQL 13, 14 off Linux, Windows).
	if strings.Contains(pre, "SET LOCAL client_connection_check_interval") {
		t.Error("the preamble sets client_connection_check_interval plainly; a server that refuses it would fail the restore")
	}
	// The sessions waiting on the restore are ended before the COMMIT, in
	// the same stream.
	block := restoreCommitBlock("m1", restoreEndWaitersSQL)
	if i, j := strings.Index(block, "pg_terminate_backend"), strings.Index(block, "COMMIT;"); i < 0 || j < 0 || i > j {
		t.Errorf("the commit block does not end the waiting sessions before its COMMIT:\n%s", block)
	}
}

// TestARestorePublishesTheDrainSnapshotWhenItStartsAndEnds: the deploy
// scripts' drain reads held_by_viewer from the stream-state snapshot. A
// restore counts there while it runs (a restart stops it), and the snapshot is
// written at once when it begins and ends, not at the next tick.
func TestARestorePublishesTheDrainSnapshotWhenItStartsAndEnds(t *testing.T) {
	tm, err := streaming.NewTranscodeManager(t.TempDir(), config.TranscodeConfig{SegmentFormat: "fmp4"})
	if err != nil {
		t.Fatalf("NewTranscodeManager: %v", err)
	}
	t.Cleanup(tm.Close)
	statePath := filepath.Join(t.TempDir(), "stream-state.json")
	if !tm.SetStreamStateFile(statePath) {
		t.Fatal("SetStreamStateFile did not enable publishing")
	}
	published := func() (restore, held int) {
		blob, err := os.ReadFile(statePath)
		if err != nil {
			return -1, -1
		}
		var st streaming.StreamState
		if json.Unmarshal(blob, &st) != nil {
			return -1, -1
		}
		return st.Restore, st.HeldByViewer
	}
	h := NewAdminHandler(nil, tm, nil, nil, nil, nil, nil, nil, nil, time.Now(), "test")
	f := newFakeRestore()
	h.databaseURL = "postgres://aurora:secret@db.invalid/aurora"
	h.restoreExec = f.run
	started, release := make(chan struct{}), make(chan struct{})
	f.steps[restoreStepRestoring] = hold(started, release)
	_ = os.Remove(statePath)
	_, done := startRestore(t, h, context.Background(), testRestoreTicket)
	waitFor(t, "the restore to start", started)
	if r, held := published(); r != 1 || held != 1 {
		t.Fatalf("published while the restore runs: restore=%d held_by_viewer=%d, want 1 and 1", r, held)
	}
	close(release)
	waitFor(t, "the handler", done)
	if r, held := published(); r != 0 || held != 0 {
		t.Fatalf("published after the restore: restore=%d held_by_viewer=%d, want 0 and 0", r, held)
	}
}
