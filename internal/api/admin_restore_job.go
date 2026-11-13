package api

// A database restore runs as a job the server owns, and its destructive half
// is one transaction.
//
// It used to run on the upload's own request: the validation, the wipe and
// pg_restore were all exec.CommandContext(r.Context()-derived ctx), and the
// wipe committed on its own before pg_restore began. When the browser's
// connection went (a reload, a closed tab, a laptop lid, a proxy that gave
// up), Go cancelled the request's context, the running pg_restore was killed,
// its transaction rolled back, and the database was left as the wipe had left
// it: empty, with nobody told. A bad or incompatible archive did the same.
//
// Now the handler (admin_backup.go) only receives the upload, spills it to a
// temp file and runs the cheap checks; RestoreJobs.Start then runs the
// pipeline (admin_restore_pipeline.go) on a context derived from the server's
// lifecycle (the RootCtx the router is given, as the retype's purge uses),
// bounded to 60 minutes as the request was. The pipeline validates the
// archive, then clears the old data and loads the backup inside ONE
// transaction that is committed only once the whole backup has loaded: any
// failure before that (a bad archive, a deadlock or lock timeout, the server
// stopping, the 60-minute bound) rolls back to the old data. The Admin page
// follows it through GET /api/admin/restore/status.
//
// The validation runs in the job too. It reads and decompresses the whole
// archive (`pg_restore -f /dev/null`), which takes about as long as the
// restore's own read of it, so keeping it on the request would have left the
// request long-running for a big file. It never touches the database.
//
// Shutdown does not wait for a restore. A stop cancels the lifecycle context
// once the HTTP server has drained, and systemd's default KillMode
// (control-group) sends SIGTERM to psql and pg_restore at the same moment as
// to this process; either way psql ends without the COMMIT, and PostgreSQL
// rolls the transaction back. The restore is lost and the old data stays; the
// admin runs it again. The deploy scripts' drain waits up to its 5 minutes for
// a running restore before restarting (it counts in the stream-state
// snapshot; cmd/aurora wires that).
//
// The status lives in memory. A server restart forgets both the running job
// (which the restart has stopped, or which finished first) and the last
// outcome; the page then finds no record of the restore it followed and says
// so.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// RestorePhase names the step a restore job is on, or the one it ended in.
type RestorePhase string

const (
	// RestoreValidating: the client programs, the archive's table of
	// contents and a full read of the archive are checked. The database is
	// not touched.
	RestoreValidating RestorePhase = "validating"
	// RestoreReplacing: one transaction drops every object in the public
	// schema that no extension owns and loads the backup. Until it ends, it
	// holds exclusive locks on everything it dropped, so the rest of the
	// server's queries on those tables wait for it.
	RestoreReplacing RestorePhase = "replacing"
)

// What a finished restore left in the database.
const (
	// RestoreDBUnchanged: it failed or was stopped before its transaction
	// committed, so the database holds what it held before.
	RestoreDBUnchanged = "unchanged"
	// RestoreDBRestored: the transaction committed.
	RestoreDBRestored = "restored"
	// RestoreDBUnknown: psql had sent the COMMIT and then lost its connection
	// or was killed before it could say how the COMMIT ended. The database
	// holds either the old data or the backup, never a mix and never an empty
	// schema. Rare: the job does not interrupt a COMMIT psql has reached (see
	// stopOnCancel), so this takes a lost connection, a COMMIT longer than
	// restoreCommitGrace, the job's own stop racing psql's reaching the
	// COMMIT, or a signal from outside (systemd's stop sends SIGTERM to psql
	// directly) landing during the COMMIT.
	RestoreDBUnknown = "unknown"
)

// Why a restore's context ended it, when it did.
const (
	restoreStoppedShutdown = "shutdown"
	restoreStoppedTimeout  = "timeout"
)

// restoreJobTimeout bounds one restore, as the request's own 60-minute
// timeout did before the restore became a job.
const restoreJobTimeout = 60 * time.Minute

// RestoreRun is a restore that is running.
type RestoreRun struct {
	ID        string       `json:"id"`
	File      string       `json:"file"`
	Phase     RestorePhase `json:"phase"`
	StartedAt time.Time    `json:"started_at"`
}

// RestoreResult is how the last restore ended.
type RestoreResult struct {
	ID        string    `json:"id"`
	File      string    `json:"file"`
	StartedAt time.Time `json:"started_at"`
	EndedAt   time.Time `json:"ended_at"`
	Succeeded bool      `json:"succeeded"`
	// Phase is the one it ended in.
	Phase RestorePhase `json:"phase"`
	// Database is one of the RestoreDB values.
	Database string `json:"database"`
	// Message is the server's own sentence.
	Message string `json:"message"`
	// Stderr is what pg_restore and psql wrote, each capped at 16 KiB (psql's
	// the last 16 KiB, where its error is). Empty when there was none.
	Stderr string `json:"stderr,omitempty"`
	// Stopped says why the job's context ended it: "shutdown" (the server
	// was stopping) or "timeout" (60 minutes). Empty otherwise.
	Stopped string `json:"stopped,omitempty"`
}

// RestoreStatus is what GET /api/admin/restore/status answers, and what the
// restore's POST answers when its job has started.
type RestoreStatus struct {
	Running *RestoreRun    `json:"running"`
	Last    *RestoreResult `json:"last"`
}

// errRestoreRunning: one is already running. The handler's backup and restore
// lock already refuses this; it is checked again here so that nothing can run
// two at once.
var errRestoreRunning = errors.New("a restore is already running")

// restoreEnd is what a run of the pipeline came to.
type restoreEnd struct {
	ok       bool
	phase    RestorePhase
	database string
	message  string
	stderr   string
}

// restoreRunner runs the pipeline for the archive at path, calling setPhase as
// each step begins. RestoreJobs uses restoreTools.runPipeline; tests replace
// it.
type restoreRunner func(ctx context.Context, databaseURL, path string, setPhase func(RestorePhase)) restoreEnd

// RestoreJobs runs database restores on the server's lifecycle, one at a time,
// and keeps the running one's phase and the last one's outcome in memory.
type RestoreJobs struct {
	// base is the server-lifecycle context jobs derive from. Nil means
	// context.Background (tests that build a handler directly).
	base context.Context

	mu      sync.Mutex
	running *RestoreRun
	last    *RestoreResult

	// onChange runs (outside mu) when a job starts and when it ends. main
	// uses it to publish the deploy drain snapshot at once.
	onChange func()

	// run does the work. Nil means tools.runPipeline.
	run restoreRunner
	// tools names the client programs and the wipe's lock timeout; the zero
	// value is production's. Tests point it at wrappers.
	tools restoreTools
	// phaseHookForTest runs in the job's goroutine as each phase begins,
	// before its step does anything. Nil in production.
	phaseHookForTest func(RestorePhase)
}

// NewRestoreJobs makes the registry. ctx is the server's lifecycle context: a
// restore is stopped (and rolls back) when it is cancelled, never when the
// request that uploaded the file goes.
func NewRestoreJobs(ctx context.Context) *RestoreJobs {
	return &RestoreJobs{base: ctx}
}

// SetOnChange registers a function run when a restore starts and when one
// ends. Call before the server serves.
func (rj *RestoreJobs) SetOnChange(fn func()) {
	rj.mu.Lock()
	rj.onChange = fn
	rj.mu.Unlock()
}

// Status answers the running restore, if any, and the last one's outcome.
// Copies: the caller may not change the registry's.
func (rj *RestoreJobs) Status() RestoreStatus {
	rj.mu.Lock()
	defer rj.mu.Unlock()
	return rj.statusLocked()
}

func (rj *RestoreJobs) statusLocked() RestoreStatus {
	var st RestoreStatus
	if rj.running != nil {
		run := *rj.running
		st.Running = &run
	}
	if rj.last != nil {
		last := *rj.last
		st.Last = &last
	}
	return st
}

// Running reports whether a restore is running. The deploy drain counts it
// (cmd/aurora wires it into the stream-state snapshot).
func (rj *RestoreJobs) Running() bool {
	rj.mu.Lock()
	defer rj.mu.Unlock()
	return rj.running != nil
}

// Start runs a restore of the archive at path as a job and answers the status
// with it running. release runs once, when the job has ended however it ended,
// after its outcome is recorded: the handler passes the backup/restore lock's
// unlock and the temp file's removal, so both are held for the job's whole
// life. On an error nothing is started and release is not called.
func (rj *RestoreJobs) Start(databaseURL, path, file string, release func()) (RestoreStatus, error) {
	id, err := newRestoreID()
	if err != nil {
		return RestoreStatus{}, err
	}
	rj.mu.Lock()
	if rj.running != nil {
		rj.mu.Unlock()
		return RestoreStatus{}, errRestoreRunning
	}
	base := rj.base
	if base == nil {
		base = context.Background()
	}
	// The server's lifecycle, never the request's: see the file comment.
	ctx, cancel := context.WithTimeout(base, restoreJobTimeout)
	run := &RestoreRun{ID: id, File: file, Phase: RestoreValidating, StartedAt: time.Now().UTC()}
	rj.running = run
	runner := rj.run
	if runner == nil {
		runner = rj.tools.runPipeline
	}
	hook := rj.phaseHookForTest
	onChange := rj.onChange
	st := rj.statusLocked()
	rj.mu.Unlock()

	slog.Info("restore started", "id", id, "file", file)
	go func() {
		defer cancel()
		setPhase := func(p RestorePhase) {
			rj.mu.Lock()
			run.Phase = p
			rj.mu.Unlock()
			if hook != nil {
				hook(p)
			}
		}
		end := runner(ctx, databaseURL, path, setPhase)
		result := &RestoreResult{
			ID:        id,
			File:      file,
			StartedAt: run.StartedAt,
			EndedAt:   time.Now().UTC(),
			Succeeded: end.ok,
			Phase:     end.phase,
			Database:  end.database,
			Message:   end.message,
			Stderr:    end.stderr,
		}
		if !end.ok {
			switch {
			case errors.Is(ctx.Err(), context.DeadlineExceeded):
				result.Stopped = restoreStoppedTimeout
				result.Message = fmt.Sprintf("the restore ran past its %d-minute limit and was stopped; %s", int(restoreJobTimeout/time.Minute), end.message)
			case ctx.Err() != nil:
				result.Stopped = restoreStoppedShutdown
				result.Message = "the server stopped the restore because it was shutting down; " + end.message
			}
		}
		switch {
		case result.Succeeded:
			slog.Info("restore succeeded — Aurora MUST be restarted to use new data", "id", id)
		case result.Database == RestoreDBUnchanged:
			slog.Warn("restore failed; its transaction did not commit: the database was NOT modified", "id", id,
				"phase", result.Phase, "stopped", result.Stopped, "message", result.Message, "stderr_tail", result.Stderr)
		default:
			slog.Error("restore lost its connection as it committed: the database holds either the old data or the backup", "id", id,
				"phase", result.Phase, "stopped", result.Stopped, "message", result.Message, "stderr_tail", result.Stderr)
		}
		rj.mu.Lock()
		rj.running = nil
		rj.last = result
		rj.mu.Unlock()
		release()
		if onChange != nil {
			onChange()
		}
	}()
	if onChange != nil {
		onChange()
	}
	return st, nil
}

func newRestoreID() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("restore id: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// maxRestoreFileNameBytes caps the upload's file name kept in the status.
const maxRestoreFileNameBytes = 200

// restoreFileName is the upload's name as the status reports it: the base
// name, control and format characters dropped (bidirectional overrides among
// them), cut to maxRestoreFileNameBytes on a rune boundary. It is the
// browser's own name for the file, shown back to admins; the Admin page draws
// it as text.
func restoreFileName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, `\`, "/"))
	if name == "." || name == "/" {
		name = ""
	}
	name = strings.Map(func(r rune) rune {
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	for len(name) > maxRestoreFileNameBytes {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	if name == "" {
		return "the uploaded file"
	}
	return name
}

// RestoreStatus handles GET /api/admin/restore/status: the running restore,
// if any, and the last one's outcome since the server started. Admin-only,
// behind the same guards as the restore itself (requireAdmin).
//
// Those guards read the session from the database (the token version, the
// session row, the acting profile), and while the restore's transaction runs
// it holds exclusive locks on those tables: the guards' queries wait for it,
// so this route answers once the restore has committed or rolled back (or,
// past the admin group's 60-second timeout, 504). The Admin page says so. A
// committed restore replaces the sessions with the backup's (none), so the
// admin signs in again to read it.
func (h *AdminHandler) RestoreStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, h.restores().Status())
}
