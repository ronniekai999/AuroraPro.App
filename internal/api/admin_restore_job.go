package api

// The destructive half of a database restore runs as a job the server owns.
//
// It used to run on the upload's own request: the validation, the wipe and
// pg_restore were all exec.CommandContext(r.Context()-derived ctx). When the
// browser's connection went (a reload, a closed tab, a laptop lid, a proxy that
// gave up), Go cancelled the request's context, the running pg_restore was
// killed, its single transaction rolled back, and the database was left as the
// wipe had left it: empty, with nobody told.
//
// Now the handler (admin_backup.go) only receives the upload, spills it to a
// temp file and runs the cheap checks; RestoreJobs.Start then runs the
// validation, the wipe and pg_restore on a context derived from the server's
// lifecycle (the RootCtx the router is given, as the retype's purge uses),
// bounded to 60 minutes as the request was. The Admin page follows it through
// GET /api/admin/restore/status.
//
// The validation moved into the job too. It reads and decompresses the whole
// archive (`pg_restore -f /dev/null`), which takes about as long as the
// restore's own read of it, so keeping it on the request would have left the
// request long-running for a big file, and a proxy's timeout or a closed tab
// would still have lost its answer. It never touches the database, so a
// failure there is reported through the status as "unchanged".
//
// Shutdown: main calls Drain before it cancels the lifecycle context, so a
// restore delays a stop (bounded; see restoreShutdownGrace in cmd/aurora). What
// is NOT covered: a restore still running when that bound runs out, or when
// systemd's own stop timeout or SIGKILL arrives, is killed like any other
// child and leaves the database empty; and on a unit that still has systemd's
// default KillMode=control-group (one installed before scripts/aurora.service
// set KillMode=mixed), a stop sends SIGTERM straight to pg_restore, which
// cancels its own query and exits, whatever this process waits for.
//
// The status lives in memory. A server restart forgets both the running job
// (which the restart has killed, or which finished first) and the last
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
	"os"
	"os/exec"
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
	// RestoreValidating: pg_restore reads the whole archive to /dev/null. The
	// database is not touched.
	RestoreValidating RestorePhase = "validating"
	// RestoreWiping: psql drops every object in the public schema that no
	// extension owns, in one statement.
	RestoreWiping RestorePhase = "wiping"
	// RestoreRestoring: pg_restore --single-transaction replays the archive.
	RestoreRestoring RestorePhase = "restoring"
)

// What a finished restore left in the database.
const (
	// RestoreDBUnchanged: it stopped before the wipe began.
	RestoreDBUnchanged = "unchanged"
	// RestoreDBMayBeEmpty: it stopped once the wipe had begun. A wipe that
	// failed with an error rolled back (it is one statement), but one that
	// was killed may have committed; a pg_restore that failed rolled back to
	// the wiped, empty schema.
	RestoreDBMayBeEmpty = "may_be_empty"
	// RestoreDBRestored: pg_restore committed.
	RestoreDBRestored = "restored"
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
	// Stderr is the tail of what psql or pg_restore wrote, capped at 16 KiB
	// as the handler always capped it. Empty when there was none.
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

var (
	// errRestoresClosed: the server is shutting down and starts no restore.
	errRestoresClosed = errors.New("the server is shutting down; no restore was started")
	// errRestoreRunning: one is already running. The handler's backup and
	// restore lock already refuses this; it is checked again here so that
	// nothing can run two at once.
	errRestoreRunning = errors.New("a restore is already running")
)

// restoreEnd is what a run of the pipeline came to.
type restoreEnd struct {
	ok       bool
	phase    RestorePhase
	database string
	message  string
	stderr   string
}

// restoreRunner runs the pipeline for the archive at path, calling setPhase as
// each step begins. RestoreJobs uses runRestorePipeline; tests replace it.
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
	// closing is set by Drain: no restore starts after it.
	closing bool
	// done is closed when the running job has ended and released its lock;
	// nil when none is running.
	done chan struct{}

	// onChange runs (outside mu) when a job starts and when it ends. main
	// uses it to publish the deploy drain snapshot at once.
	onChange func()

	// run does the work. Nil means runRestorePipeline.
	run restoreRunner
	// phaseHookForTest runs in the job's goroutine as each phase begins,
	// before its step does anything. Nil in production.
	phaseHookForTest func(RestorePhase)
}

// NewRestoreJobs makes the registry. ctx is the server's lifecycle context: a
// restore is cancelled when it is (after Drain has waited for it, on a normal
// shutdown), never when the request that uploaded the file goes.
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
	if rj.closing {
		rj.mu.Unlock()
		return RestoreStatus{}, errRestoresClosed
	}
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
	done := make(chan struct{})
	rj.done = done
	runner := rj.run
	if runner == nil {
		runner = runRestorePipeline
	}
	hook := rj.phaseHookForTest
	onChange := rj.onChange
	st := rj.statusLocked()
	rj.mu.Unlock()

	slog.Info("restore started", "id", id, "file", file)
	go func() {
		defer close(done)
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
			slog.Warn("restore stopped before the wipe: the database was NOT modified", "id", id,
				"stopped", result.Stopped, "message", result.Message, "stderr_tail", result.Stderr)
		default:
			slog.Error("restore failed after the wipe began: the database may be empty", "id", id,
				"phase", result.Phase, "stopped", result.Stopped, "message", result.Message, "stderr_tail", result.Stderr)
		}
		rj.mu.Lock()
		rj.running = nil
		rj.last = result
		rj.done = nil
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

// Drain stops new restores from starting and waits up to timeout for a running
// one to end and release its lock. It reports whether none is running when it
// returns. Called once, at shutdown, before the lifecycle context is
// cancelled: cancelling it kills a restore, and one killed after the wipe
// leaves the database empty.
func (rj *RestoreJobs) Drain(timeout time.Duration) bool {
	rj.mu.Lock()
	rj.closing = true
	done := rj.done
	var run RestoreRun
	if rj.running != nil {
		run = *rj.running
	}
	rj.mu.Unlock()
	if done == nil {
		return true
	}
	slog.Warn("shutdown is waiting for a database restore to finish: stopping it part way can leave the database empty",
		"id", run.ID, "phase", run.Phase, "started_at", run.StartedAt, "wait_up_to", timeout)
	select {
	case <-done:
		slog.Info("the database restore ended; shutting down", "id", run.ID)
		return true
	case <-time.After(timeout):
		slog.Error("a database restore is still running after the shutdown's wait; stopping it, which can leave the database empty",
			"id", run.ID, "waited", timeout)
		return false
	}
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

// runRestorePipeline validates the archive at path, wipes the public schema
// and restores the archive into it. Each step's stderr tail is kept, capped.
func runRestorePipeline(ctx context.Context, databaseURL, path string, setPhase func(RestorePhase)) restoreEnd {
	// Validate the upload is FULLY restorable BEFORE the destructive wipe.
	// The leading-magic + min-size checks in the handler only prove the first
	// bytes look like a custom dump, and `pg_restore --list` would only parse
	// the header + table-of-contents — neither reads the compressed DATA
	// blocks, so a dump truncated mid-data (a realistic interrupted-upload
	// outcome) would pass and then fail AFTER the wipe, leaving the DB empty.
	// `pg_restore -f /dev/null` decompresses and reads the ENTIRE archive to a
	// throwaway script target WITHOUT connecting to the database, so a
	// truncated / corrupt / version-incompatible archive is rejected with the
	// DB still intact. Costs one extra full read of the archive — restores are
	// rare and correctness beats speed here. deep-debug H8.
	setPhase(RestoreValidating)
	validateCmd := exec.CommandContext(ctx, "pg_restore", "-f", os.DevNull, path)
	var validateStderr strings.Builder
	validateCmd.Stderr = &limitedStringWriter{w: &validateStderr, max: 16 * 1024}
	if err := validateCmd.Run(); err != nil {
		return restoreEnd{
			phase:    RestoreValidating,
			database: RestoreDBUnchanged,
			message:  "upload is not a complete, readable pg_dump custom archive (pg_restore validation failed: " + err.Error() + ") — the database was NOT modified",
			stderr:   strings.TrimSpace(validateStderr.String()),
		}
	}
	if ctx.Err() != nil {
		// Validated, but stopped before anything was touched.
		return restoreEnd{phase: RestoreValidating, database: RestoreDBUnchanged,
			message: "the restore was stopped before the database was touched — the database was NOT modified"}
	}

	// Phase 1 — wipe the existing schema. Without this, the restore would
	// fail on "relation already exists" for every table. See restoreWipeSQL.
	//
	// 2026-05-29 audit (MED): derive a password-free conninfo for both the
	// wipe (psql) and the restore (pg_restore) below; the password travels via
	// PGPASSWORD in cmd.Env so it never lands on argv. See pgConnEnv.
	setPhase(RestoreWiping)
	connURL, pgEnv := pgConnEnv(databaseURL)
	wipeCmd := exec.CommandContext(ctx, "psql",
		"--quiet",
		"--set", "ON_ERROR_STOP=on",
		"-c", restoreWipeSQL,
		connURL,
	)
	wipeCmd.Env = append(os.Environ(), pgEnv...)
	var wipeStderr strings.Builder
	wipeCmd.Stderr = &limitedStringWriter{w: &wipeStderr, max: 16 * 1024}
	if err := wipeCmd.Run(); err != nil {
		// Audit M2 — keep the actual psql stderr. "is psql installed?" alone
		// was misleading when the real cause is "connection refused" /
		// "permission denied on schema public" / "role does not exist".
		return restoreEnd{
			phase: RestoreWiping,
			// One statement, so an error rolled it back; but psql killed
			// part way may not have stopped the server from committing it.
			database: RestoreDBMayBeEmpty,
			message:  "pre-restore wipe failed: " + err.Error(),
			stderr:   strings.TrimSpace(wipeStderr.String()),
		}
	}

	// Phase 2 — pg_restore the upload.
	//
	//   --single-transaction → BEGIN/COMMIT wrap; any failure rolls
	//                          everything back. Schema stays wiped, so
	//                          the operator can retry with a different
	//                          file without re-wiping manually.
	//                          (--single-transaction implies bail-on-
	//                          first-error, so --exit-on-error is
	//                          redundant; we omit it for clarity.)
	//   --no-owner            → skip ALTER OWNER statements. Aurora's
	//                          DB role probably isn't the dump's owner.
	//   --no-privileges       → skip GRANT/REVOKE. Same rationale.
	//   --no-comments         → skip COMMENT ON statements, including
	//                          COMMENT ON EXTENSION (which requires
	//                          extension-owner privilege we don't have).
	//                          This is the flag that obsoletes the old
	//                          line-filter pipeline.
	//   --dbname=<conninfo>  → connect via libpq URI; pg_restore knows
	//                          this form. The URI here is password-free
	//                          (pgConnEnv strips it); the password is
	//                          supplied via PGPASSWORD in cmd.Env.
	//
	// Note: --no-publications / --no-subscriptions are applied on the
	// pg_dump side (see Backup) so they never end up in the archive.
	// Applying them here too would be a no-op for archives produced by
	// our Backup, but useful defense-in-depth if an operator restores
	// a dump from a different source — pg_restore doesn't ship those
	// flags consistently across versions, so we rely on the dump-side
	// filter instead.
	setPhase(RestoreRestoring)
	restoreCmd := exec.CommandContext(ctx, "pg_restore",
		"--single-transaction",
		"--no-owner",
		"--no-privileges",
		"--no-comments",
		"--dbname="+connURL,
		path,
	)
	restoreCmd.Env = append(os.Environ(), pgEnv...)
	var restoreStderr strings.Builder
	restoreCmd.Stderr = &limitedStringWriter{w: &restoreStderr, max: 16 * 1024}
	if err := restoreCmd.Run(); err != nil {
		// The --single-transaction wrapped the whole thing, so on failure
		// the DB is back to the wiped (empty) state. Say so, so the
		// operator knows to retry.
		return restoreEnd{
			phase:    RestoreRestoring,
			database: RestoreDBMayBeEmpty,
			message:  "restore failed (" + err.Error() + "); database is in wiped state, retry with a valid backup.",
			stderr:   strings.TrimSpace(restoreStderr.String()),
		}
	}
	return restoreEnd{
		ok:       true,
		phase:    RestoreRestoring,
		database: RestoreDBRestored,
		message:  "Restore complete. RESTART AURORA NOW — current connections will see stale state until you do.",
	}
}

// restoreWipeSQL drops every object in the public schema that no extension
// owns.
//
// Audit (production restore 2026-05-18) — the previous wipe used `DROP SCHEMA
// public CASCADE` which ALSO drops every extension installed in `public`
// (pg_trgm, vector). The dump then tries to recreate those extensions, but
// Aurora connects as the unprivileged `aurora` role which cannot `CREATE
// EXTENSION vector` (non-trusted). The whole restore rolled back with
// "permission denied to create extension vector. Must be superuser."
//
// The wipe loops through objects in the public schema and drops only those NOT
// owned by an extension. Extensions stay intact, the dump's `CREATE EXTENSION
// IF NOT EXISTS` becomes a no-op (which doesn't require superuser when the
// extension is already present), and the restore proceeds.
const restoreWipeSQL = `
DO $do$
DECLARE r record;
BEGIN
    -- Tables: CASCADE drops dependent indexes, constraints, and
    -- table-owned sequences. We filter out extension-owned tables
    -- (none today but defense-in-depth for future extensions).
    FOR r IN
        SELECT c.relname AS tablename
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
    LOOP
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
    END LOOP;
    -- Views.
    FOR r IN
        SELECT c.relname AS viewname
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
    LOOP
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.viewname);
    END LOOP;
    -- Stand-alone sequences (table-owned ones got dropped by table CASCADE).
    FOR r IN
        SELECT c.relname AS seqname
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'public' AND c.relkind = 'S'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
    LOOP
        EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.seqname);
    END LOOP;
    -- User-defined types (enums, composites). Excludes extension-owned
    -- types like 'vector' itself.
    FOR r IN
        SELECT t.typname
        FROM pg_type t
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE n.nspname = 'public' AND t.typtype IN ('e', 'c', 'd')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
    LOOP
        EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
    END LOOP;
    -- Routines (functions AND procedures). Aurora has at least
    -- update_updated_at() used as a trigger; the dump emits a
    -- CREATE FUNCTION for it. Without dropping it here, the restore
    -- fails with "function already exists with same argument types."
    -- Extension-owned routines (most of pg_trgm + vector live here)
    -- are filtered by deptype='e'.
    --
    -- DROP ROUTINE handles both functions and procedures (PG 11+,
    -- so universally available on Aurora's PG 14+ floor — bumped
    -- to 14 by pgvector, not by this loop). DROP FUNCTION alone
    -- would fail on a CREATE PROCEDURE that a future migration
    -- might add.
    --
    -- prokind values: 'f' = function, 'p' = procedure, 'a' = aggregate
    -- (handled by the separate loop below — DROP AGGREGATE syntax),
    -- 'w' = window function (only superuser-created, not relevant
    -- to Aurora's schema).
    --
    -- ::regprocedure casts to the full signature including arg types,
    -- which DROP ROUTINE needs to disambiguate overloads.
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    LOOP
        EXECUTE format('DROP ROUTINE IF EXISTS %s CASCADE', r.sig);
    END LOOP;
    -- Aggregates (prokind='a') — separate loop because DROP ROUTINE
    -- doesn't work on aggregates; they need DROP AGGREGATE.
    -- Aurora has no user-defined aggregates today, so this loop is
    -- a no-op against the current schema. It's here so a future
    -- migration that ever adds CREATE AGGREGATE will not silently
    -- break the next restore. The deptype='e' filter still preserves
    -- extension-owned aggregates (none on pg_trgm or vector either,
    -- but defensive).
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        AND p.prokind = 'a'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    LOOP
        EXECUTE format('DROP AGGREGATE IF EXISTS %s CASCADE', r.sig);
    END LOOP;
END
$do$;
`

// RestoreStatus handles GET /api/admin/restore/status: the running restore,
// if any, and the last one's outcome since the server started. Admin-only,
// behind the same guards as the restore itself (requireAdmin).
//
// Those guards read the session from the database (the token version, the
// session row, the acting profile), and the restore is what replaces the
// database: from the wipe until pg_restore commits, and for good after a
// restore that failed past the wipe, they cannot be checked, and this route
// answers 401 or 500 like every other admin route. The Admin page says so;
// the server log has the outcome either way.
func (h *AdminHandler) RestoreStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, h.restores().Status())
}
