package api

// A database restore that outlives its request, and the record of how it went.
//
// The restore used to run on the request's context: a reload, a closed tab, a
// lost connection or a laptop lid cancelled it, pg_restore was killed, and its
// single transaction rolled back onto the schema the wipe had already emptied.
// Nothing recorded that it had happened. Now only the upload belongs to the
// request. Once the file is on disk the rest (the check, the wipe, pg_restore)
// runs on the server-lifecycle context with the overall timeout, holding the
// backup/restore lock until it ends, and records each step here. The request
// is answered when the restore ends if the client is still there; if not, the
// record is the answer.
//
// Who can read the record. A restore takes the database the admin guard reads
// away from under it: from the wipe until pg_restore commits there are no
// tables, so RequireAuth's token-version check and the admin guard's session
// lookup fail, and a restore that fails after the wipe leaves it that way. A
// restore that succeeds brings back no sessions (dumps exclude refresh_tokens'
// rows), so the admin's own session is gone and their access token is refused
// by the admin guard (session_ended). An admin-guarded read alone would be
// unreachable for the person who started the restore in exactly the states
// they need it. So there are two reads of the one record:
//
//   - GET /api/admin/restore/status, behind the admin guard, for any admin
//     while the database can answer for them.
//   - GET /api/restore/status, outside the session checks, answered only to
//     the restore's ticket: a secret of at least 192 bits the client chose,
//     sent with the upload (restoreTicketHeader), and kept here only as its
//     SHA-256. The upload itself passed the full admin guard, so the ticket
//     is held by the admin who started the restore and names that restore
//     only; a newer restore replaces it, and any other value gets the same
//     404 as no restore at all.
//
// Memory only: a restart forgets it (docs/backup-restore.md says so). A
// restart during a restore also ends it: the lifecycle context is cancelled at
// shutdown, and systemd stops every process in the unit, pg_restore included.

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// restoreTimeout bounds the whole restore after its upload (check, wipe and
// pg_restore), as the request's own 60-minute context used to.
const restoreTimeout = 60 * time.Minute

// restoreTicketHeader carries a restore's ticket on the upload and on the
// ticket read.
const restoreTicketHeader = "X-Aurora-Restore-Ticket"

// A ticket is 32 to 128 characters of the base64url alphabet: at least 192
// bits when chosen at random, which the web app does (32 random bytes).
const (
	minRestoreTicketLen = 32
	maxRestoreTicketLen = 128
)

// validRestoreTicket reports whether s has a ticket's shape.
func validRestoreTicket(s string) bool {
	if len(s) < minRestoreTicketLen || len(s) > maxRestoreTicketLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// restoreStep is where a restore is, or where it stopped.
type restoreStep string

const (
	// restoreStepChecking: pg_restore reads the whole archive to /dev/null.
	// The database has not been touched.
	restoreStepChecking restoreStep = "checking"
	// restoreStepClearing: the wipe of the public schema.
	restoreStepClearing restoreStep = "clearing"
	// restoreStepRestoring: pg_restore --single-transaction.
	restoreStepRestoring restoreStep = "restoring"
)

// What a restore has done to the database, as far as the server can tell.
const (
	restoreDBUnchanged = "unchanged" // the wipe has not run, or failed as a whole
	restoreDBUnknown   = "unknown"   // a step was stopped part way; it may or may not have landed
	restoreDBEmpty     = "empty"     // wiped; pg_restore has not committed (running) or rolled back (failed)
	restoreDBRestored  = "restored"  // pg_restore committed
)

// What a restore is.
const (
	restoreStateNone      = "none" // no restore since this process started
	restoreStateRunning   = "running"
	restoreStateSucceeded = "succeeded"
	restoreStateFailed    = "failed"
)

// RestoreStatus is the body of both status reads.
type RestoreStatus struct {
	State string `json:"state"`
	// Step is where a running restore is, or where a failed one stopped.
	// Omitted for none and succeeded.
	Step     string     `json:"step,omitempty"`
	Database string     `json:"database,omitempty"`
	File     string     `json:"file,omitempty"`
	Started  *time.Time `json:"started_at,omitempty"`
	Finished *time.Time `json:"finished_at,omitempty"`
	// RestartRequired: a restore has succeeded since this process started,
	// so it is serving a database its migrations have not seen and its pool
	// may hold plans for tables that were dropped. A later restore that is
	// refused before its wipe does not clear it.
	RestartRequired bool `json:"restart_required"`
	// Message is the server's account of a finished restore: the same text
	// its request was (or would have been) answered with.
	Message string `json:"message,omitempty"`
}

// restoreRun is one restore, from the end of its upload.
type restoreRun struct {
	status     RestoreStatus
	ticketHash [sha256.Size]byte
	hasTicket  bool
}

// restoreTracker holds the latest restore that got past its upload. The
// backup/restore lock (AdminHandler.backupRestoreMu) decides who may run;
// this only records, under its own mutex, so a read never waits on a restore.
type restoreTracker struct {
	mu              sync.Mutex
	run             *restoreRun
	restartRequired bool
}

// begin records a new restore as running its first step, replacing the
// previous record (and so its ticket). The caller holds backupRestoreMu.
func (t *restoreTracker) begin(file, ticket string, now time.Time) *restoreRun {
	run := &restoreRun{status: RestoreStatus{
		State:    restoreStateRunning,
		Step:     string(restoreStepChecking),
		Database: restoreDBUnchanged,
		File:     file,
		Started:  &now,
	}}
	if ticket != "" {
		run.ticketHash = sha256.Sum256([]byte(ticket))
		run.hasTicket = true
	}
	t.mu.Lock()
	t.run = run
	t.mu.Unlock()
	return run
}

// step moves a running restore to its next step.
func (t *restoreTracker) step(run *restoreRun, step restoreStep, database string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	run.status.Step = string(step)
	run.status.Database = database
}

// finish records how a restore ended.
func (t *restoreTracker) finish(run *restoreRun, res restoreResult, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	run.status.Finished = &now
	run.status.Database = res.database
	run.status.Message = res.message
	if res.ok {
		run.status.State = restoreStateSucceeded
		run.status.Step = ""
		t.restartRequired = true
	} else {
		run.status.State = restoreStateFailed
		// A failure names the step it stopped at; one that cannot (a
		// panic) keeps the step the record was at.
		if res.step != "" {
			run.status.Step = string(res.step)
		}
	}
}

// status is the record as the admin read gives it.
func (t *restoreTracker) status() RestoreStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.statusLocked()
}

func (t *restoreTracker) statusLocked() RestoreStatus {
	if t.run == nil {
		return RestoreStatus{State: restoreStateNone, RestartRequired: t.restartRequired}
	}
	s := t.run.status
	// Copy the times: the record's own pointers are never written again, but
	// the caller should not share them.
	if s.Started != nil {
		v := *s.Started
		s.Started = &v
	}
	if s.Finished != nil {
		v := *s.Finished
		s.Finished = &v
	}
	s.RestartRequired = t.restartRequired
	return s
}

// statusForTicket is the record when ticket is the latest restore's.
func (t *restoreTracker) statusForTicket(ticket string) (RestoreStatus, bool) {
	if !validRestoreTicket(ticket) {
		return RestoreStatus{}, false
	}
	sum := sha256.Sum256([]byte(ticket))
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.run == nil || !t.run.hasTicket || subtle.ConstantTimeCompare(sum[:], t.run.ticketHash[:]) != 1 {
		return RestoreStatus{}, false
	}
	return t.statusLocked(), true
}

// restoreResult is how a restore ended: the record's outcome and the answer
// its request gets if the client is still there.
type restoreResult struct {
	ok         bool
	httpStatus int // for a failure; a success answers 200
	message    string
	step       restoreStep // where a failure stopped
	database   string
}

// restoreCommand runs one external program of a restore and returns the tail
// of its stderr (bounded, trimmed). execRestoreCommand in production; tests
// put a fake on AdminHandler.restoreExec to stand in for psql and pg_restore.
type restoreCommand func(ctx context.Context, step restoreStep, name string, args, env []string) (stderr string, err error)

func execRestoreCommand(ctx context.Context, _ restoreStep, name string, args, env []string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	// Inherit the process environment, plus PGPASSWORD when there is one
	// (pgConnEnv), so the password never lands on argv.
	cmd.Env = append(os.Environ(), env...)
	var stderr strings.Builder
	cmd.Stderr = &limitedStringWriter{w: &stderr, max: 16 * 1024}
	err := cmd.Run()
	return strings.TrimSpace(stderr.String()), err
}

func (h *AdminHandler) restoreCommand() restoreCommand {
	if h.restoreExec != nil {
		return h.restoreExec
	}
	return execRestoreCommand
}

// restoreContext is the context the restore runs under once its upload is
// done: the server's lifecycle, so a client that goes does not stop it and a
// shutdown still does. Background only where nothing wired one (tests).
func (h *AdminHandler) restoreContext() context.Context {
	if h.rootCtx != nil {
		return h.rootCtx
	}
	return context.Background()
}

// SetRootContext wires the server-lifecycle context restores run under.
func (h *AdminHandler) SetRootContext(ctx context.Context) {
	h.rootCtx = ctx
}

// restoreFileLabel is the uploaded file's name as the record shows it: its
// last path element, without control or format characters, at most 200
// characters. It is only ever shown; nothing opens it.
func restoreFileLabel(name string) string {
	name = filepath.Base(name)
	if name == "." || name == string(filepath.Separator) {
		return ""
	}
	var b strings.Builder
	n := 0
	for _, r := range name {
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if n == 200 {
			b.WriteString("…")
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// RestoreStatus handles GET /api/admin/restore/status: the latest restore
// since this process started, for an admin the database can still vouch for.
func (h *AdminHandler) RestoreStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, h.restores.status())
}

// RestoreStatusByTicket handles GET /api/restore/status: the same record,
// answered only to the latest restore's ticket (restoreTicketHeader), with no
// session check, because while a restore runs, and after one that fails past
// its wipe, there is no database to check a session against. Anything else is
// the same 404, whether or not a restore exists.
func (h *AdminHandler) RestoreStatusByTicket(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	st, ok := h.restores.statusForTicket(r.Header.Get(restoreTicketHeader))
	if !ok {
		writeErrorReason(w, http.StatusNotFound, "restore_unknown", "no restore with this ticket")
		return
	}
	writeJSON(w, http.StatusOK, st)
}
