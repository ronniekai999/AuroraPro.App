package api

// A database restore that outlives its request, and the record of how it went.
//
// The restore used to run on the request's context: a reload, a closed tab, a
// lost connection or a laptop lid cancelled it, pg_restore was killed, and its
// single transaction rolled back onto the schema the wipe had already emptied.
// Nothing recorded that it had happened. Now only the upload belongs to the
// request. Once the file is on disk the rest (the check, then the wipe and the
// load in one transaction, admin_restore_pipeline.go) runs on the
// server-lifecycle context with the overall timeout, holding the
// backup/restore lock until it ends, and records each step here. The request
// is answered when the restore ends if the client is still there; if not, the
// record is the answer.
//
// Who can read the record. While the restore's transaction runs it holds
// exclusive locks on every table it dropped, so RequireAuth's token-version
// check (once its 60 s cache lapses; it has no deadline of its own) and the
// admin guard's session lookup wait on them until the restore ends. A restore
// that succeeds brings back no sessions (dumps exclude refresh_tokens' rows),
// so the admin's own session is gone and their access token is refused by the
// admin guard (session_ended). An admin-guarded read alone would be
// unreachable for the person who started the restore in exactly the states
// they need it. So there are two reads of the one record:
//
//   - GET /api/admin/restore/status, behind the admin guard, for any admin
//     while the database can answer for them.
//   - GET /api/restore/status, outside the session checks, answered only to
//     the restore's ticket, without the server's own text (statusForTicket): a secret of at least 192 bits the client chose,
//     sent with the upload (restoreTicketHeader), and kept here only as its
//     SHA-256. The upload itself passed the full admin guard, so the ticket
//     is held by the admin who started the restore and names that restore
//     only; a newer restore replaces it, and any other value gets the same
//     404 as no restore at all.
//
// Memory only: a restart forgets it (docs/backup-restore.md says so). A
// restart during a restore also ends it: the lifecycle context is cancelled at
// shutdown, and systemd stops every process in the unit, psql and pg_restore
// included. The transaction then rolls back, so the old data stays and the
// restore has to be run again. The deploy scripts' viewer drain counts a
// running restore (wireRestoreDrain), so an update waits up to its five
// minutes for one before restarting.

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
	// restoreStepChecking: the client programs, the archive's table of
	// contents and a full read of the archive are checked. The database has
	// not been touched.
	restoreStepChecking restoreStep = "checking"
	// restoreStepRestoring: one transaction wipes the public schema and
	// loads the archive. Nothing is committed until it has all loaded.
	// (There used to be a "clearing" step: the wipe committed on its own.)
	restoreStepRestoring restoreStep = "restoring"
)

// What a restore has done to the database, as far as the server can tell.
// There is no "empty" any more: the wipe commits only with the load.
const (
	restoreDBUnchanged = "unchanged" // nothing committed: running, or failed and rolled back
	restoreDBUnknown   = "unknown"   // cut off as it committed, or an internal error: the old data or the backup
	restoreDBRestored  = "restored"  // the transaction committed
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
	// may hold plans for tables that were dropped. A later restore that does
	// not succeed does not clear it.
	RestartRequired bool `json:"restart_required"`
	// Message is the server's account of a finished restore: the same text
	// its request was (or would have been) answered with. The admin read
	// only; the ticket read leaves it out (statusForTicket).
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
	// onChange runs (outside mu) when a restore begins and when it ends: the
	// deploy drain's snapshot is published at once (wireRestoreDrain).
	onChange func()
}

// running reports whether a restore is running now. The deploy drain counts
// it (wireRestoreDrain).
func (t *restoreTracker) running() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.run != nil && t.run.status.State == restoreStateRunning
}

// changed runs onChange, if one is set.
func (t *restoreTracker) changed() {
	t.mu.Lock()
	fn := t.onChange
	t.mu.Unlock()
	if fn != nil {
		fn()
	}
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
	t.changed()
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
	defer t.changed()
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

// statusForTicket is the record when ticket is the latest restore's, without
// its message: that is psql's or pg_restore's own output, which can quote a
// row of the failing table (a password or PIN hash, a provider key), and the
// ticket read has no session behind it. The ticket outlives the restore in
// the browser that started it, so whoever uses that browser later can replay
// it. The admin read keeps the message; so does the server log.
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
	st := t.statusLocked()
	st.Message = ""
	return st, true
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

// restorePrograms runs a restore's external programs: the real ones
// (restoreTools, admin_restore_pipeline.go), or, in tests, stand-ins.
type restorePrograms interface {
	// ready says why the client programs cannot run a restore (one is
	// missing, or older than pg_restore --restrict-key), or "".
	ready(ctx context.Context) string
	// check refuses an archive before anything is touched: the answer's
	// status and message, or 0 when it may be restored.
	check(ctx context.Context, archive string) (status int, message string)
	// replace runs the transaction: the wipe and the load.
	replace(ctx context.Context, connURL string, env []string, archive string) replaceOutcome
}

func (h *AdminHandler) restorePrograms() restorePrograms {
	if h.restoreExec != nil {
		return commandPrograms{run: h.restoreExec}
	}
	return h.restoreTools
}

// commandPrograms puts a restoreCommand (a test's stand-in for psql and
// pg_restore) behind restorePrograms: the check is one command at
// restoreStepChecking, and the whole transaction one command at
// restoreStepRestoring, which commits when it succeeds.
type commandPrograms struct{ run restoreCommand }

func (c commandPrograms) ready(context.Context) string { return "" }

func (c commandPrograms) check(ctx context.Context, archive string) (int, string) {
	stderr, err := c.run(ctx, restoreStepChecking, "pg_restore", []string{"-f", os.DevNull, archive}, nil)
	if err == nil {
		return 0, ""
	}
	return http.StatusBadRequest, restoreUnreadableMessage(stderr)
}

func (c commandPrograms) replace(ctx context.Context, connURL string, env []string, archive string) replaceOutcome {
	stderr, err := c.run(ctx, restoreStepRestoring, "psql", append(restorePsqlArgs(connURL), archive), env)
	if err != nil {
		return replaceOutcome{cause: err.Error(), stderr: stderr}
	}
	return replaceOutcome{committed: true}
}

// restoreUnreadableMessage is the answer for an archive pg_restore cannot
// read in full.
func restoreUnreadableMessage(stderr string) string {
	msg := "upload is not a complete, readable pg_dump custom archive (pg_restore validation failed) — the database was NOT modified"
	if stderr != "" {
		msg += ": " + stderr
	}
	return msg
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
// session check, because while a restore's transaction runs the session
// checks wait on its locks, and one that succeeds brings back no sessions.
// Anything else is the same 404, whether or not a restore exists.
func (h *AdminHandler) RestoreStatusByTicket(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	st, ok := h.restores.statusForTicket(r.Header.Get(restoreTicketHeader))
	if !ok {
		writeErrorReason(w, http.StatusNotFound, "restore_unknown", "no restore with this ticket")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// restoreDrain is what the deploy drain needs of the stream-state snapshot
// (streaming.TranscodeManager): to count a running restore, and to publish
// at once when one begins or ends.
type restoreDrain interface {
	SetDrainRestoreRunning(fn func() bool)
	PublishDrainState()
}

// wireRestoreDrain makes the deploy scripts' viewer drain wait for a running
// restore: a restart stops it, and it then has to be run again. Called by
// NewAdminHandler with the transcode manager, which writes the snapshot.
func (h *AdminHandler) wireRestoreDrain(d restoreDrain) {
	d.SetDrainRestoreRunning(h.restores.running)
	h.restores.mu.Lock()
	h.restores.onChange = d.PublishDrainState
	h.restores.mu.Unlock()
}
