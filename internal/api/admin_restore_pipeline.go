package api

// The restore pipeline: a validation that touches nothing, then ONE
// transaction that clears the old data and loads the backup.
//
// pg_restore converts the custom archive to SQL on stdout (`-f -`, with the
// flags the restore always used: no owner, no privileges, no comments), and a
// single psql session runs, from one stream:
//
//	BEGIN; SET LOCAL ...;             (restorePreamble)
//	<the wipe: restoreWipeSQL>
//	<pg_restore's output>
//	\warn ... committing; COMMIT; \warn ... committed   (restoreCommitBlock)
//
// The commit block is written by this process, and only once pg_restore has
// exited 0, its whole output has reached psql, and the job is not being
// stopped. psql is never run with --single-transaction, which would COMMIT
// at the end of its input: a pg_restore that dies mid-stream simply ends the
// input. Without a COMMIT the transaction cannot commit: when psql exits, or
// is interrupted (SIGINT makes it cancel the statement in flight and exit),
// its connection ends and the server rolls the transaction back. So every
// failure before the COMMIT, the wipe included, leaves the old data, and the
// admins who were signed in stay signed in. Pinned against PostgreSQL by
// TestARestoreIsNeverCommittedUnlessPgRestoreSucceeded.
//
// What the stream may contain. pg_dump's SQL for one database is DDL and COPY,
// all of which runs inside a transaction, except for entries this pipeline
// refuses from the archive's table of contents before anything is touched
// (restoreTOCAllowed): large objects (pg_restore writes BEGIN and COMMIT
// around them, and that COMMIT would end this transaction early), a CREATE
// DATABASE and the database's own settings (only with -C, never passed), and
// subscriptions, tablespaces, foreign servers, procedural languages and
// security labels, which Aurora's dumps never hold. pg_dump never writes
// VACUUM, CREATE INDEX CONCURRENTLY or a transaction statement of its own. A
// crafted archive can still hold any SQL in an allowed entry, a COMMIT
// included; only an admin can upload one, and an admin can restore an empty
// database anyway.
//
// psql meta-commands. psql obeys backslash commands wherever they appear
// outside quotes, and an archive's object definitions are copied into the
// stream verbatim, so a crafted archive could make psql run `\!` shell
// commands as the server's user. pg_restore's --restrict-key (PostgreSQL 17.6,
// 16.10, 15.14, 14.19 and 13.22, August 2025; CVE-2025-8714) wraps its output
// in `\restrict KEY` ... `\unrestrict KEY`, and psql refuses every other
// meta-command in between. The key is random per restore, so the archive
// cannot know it. A server whose pg_restore or psql predates that option is
// refused in the validation, with the database untouched.
//
// Locks. The wipe takes an ACCESS EXCLUSIVE lock on every table it drops and
// the transaction holds them until it ends, so the server's own queries on
// those tables (the admin guard's session read included) wait rather than
// fail, and see the restored data, or the old data after a rollback, once it
// ends. The wipe waits at most restoreLockTimeout for each lock (a long query
// or an open transaction elsewhere): past it, or on a deadlock, the restore
// fails and rolls back, with the old data. The old tables' files stay on disk
// until the COMMIT, so the database needs room for both copies meanwhile.

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// restoreLockTimeout bounds the wipe's wait for each table's lock.
	restoreLockTimeout = 30 * time.Second
	// restoreInterruptGrace is how long psql and pg_restore get to exit after
	// a SIGINT before they are killed. psql cancels its statement in flight
	// and exits; the server then rolls the transaction back.
	restoreInterruptGrace = 15 * time.Second
	// restoreCommitGrace is how long a COMMIT psql has already reached is
	// left to finish when the job is stopped: interrupting it could leave
	// unknown whether it took effect.
	restoreCommitGrace = 60 * time.Second
	// restoreAppName is psql's application_name, so a running restore can be
	// found in pg_stat_activity.
	restoreAppName = "aurora-restore"
	// restorePipeDelay bounds Wait's wait for a child's output pipes once it
	// has exited (a child it left behind can hold them open).
	restorePipeDelay = 5 * time.Second
)

// restoreTools names the client programs and the wipe's lock timeout. The
// zero value is production's.
type restoreTools struct {
	pgRestore   string
	psql        string
	lockTimeout time.Duration
}

func (t restoreTools) pgRestoreBin() string {
	if t.pgRestore != "" {
		return t.pgRestore
	}
	return "pg_restore"
}

func (t restoreTools) psqlBin() string {
	if t.psql != "" {
		return t.psql
	}
	return "psql"
}

// runPipeline validates the archive at path and then replaces the database
// with it in one transaction.
func (t restoreTools) runPipeline(ctx context.Context, databaseURL, path string, setPhase func(RestorePhase)) restoreEnd {
	setPhase(RestoreValidating)
	refused := func(message, stderr string) restoreEnd {
		if ctx.Err() != nil {
			// A stop or the time limit, not the file: say that.
			message = "the restore was stopped while it checked the file"
			stderr = ""
		}
		return restoreEnd{phase: RestoreValidating, database: RestoreDBUnchanged,
			message: message + " — the database was NOT modified", stderr: stderr}
	}
	if missing := t.missingRestrictSupport(ctx); missing != "" {
		return refused("this server's "+missing+" is too old to restore a backup safely: it predates --restrict-key "+
			"(PostgreSQL 17.6, 16.10, 15.14, 14.19 and 13.22, August 2025); update the PostgreSQL client packages", "")
	}
	if msg, stderr := t.checkTOC(ctx, path); msg != "" {
		return refused(msg, stderr)
	}

	// Read the whole archive BEFORE taking any lock. The leading-magic and
	// min-size checks in the handler only prove the first bytes look like a
	// custom dump, and the table of contents above is read from the front;
	// neither reads the compressed DATA blocks. `pg_restore -f /dev/null`
	// decompresses the ENTIRE archive to a throwaway script target without
	// connecting to the database, so a truncated, corrupt or
	// version-incompatible archive is refused before the wipe locks every
	// table. (A failure later would roll back too, but only after the rest of
	// the server had waited on those locks.) deep-debug H8.
	validateCmd := exec.CommandContext(ctx, t.pgRestoreBin(), "-f", os.DevNull, path)
	var validateStderr strings.Builder
	validateCmd.Stderr = &limitedStringWriter{w: &validateStderr, max: 16 * 1024}
	if err := validateCmd.Run(); err != nil {
		return refused("upload is not a complete, readable pg_dump custom archive (pg_restore validation failed: "+err.Error()+")",
			strings.TrimSpace(validateStderr.String()))
	}
	if ctx.Err() != nil {
		return refused("", "")
	}

	setPhase(RestoreReplacing)
	return t.replace(ctx, databaseURL, path)
}

// missingRestrictSupport names the client program that lacks the
// \restrict / \unrestrict pair, or answers "" when both have it.
func (t restoreTools) missingRestrictSupport(ctx context.Context) string {
	out, err := exec.CommandContext(ctx, t.pgRestoreBin(), "--help").Output()
	if err != nil || !bytes.Contains(out, []byte("--restrict-key")) {
		return "pg_restore"
	}
	out, err = exec.CommandContext(ctx, t.psqlBin(), "--help=commands").Output()
	if err != nil || !bytes.Contains(out, []byte(`\unrestrict`)) {
		return "psql"
	}
	return ""
}

// restoreTOCAllowed is every table-of-contents entry type the pipeline runs
// inside its transaction: what pg_dump writes for one database's schema
// objects and data, all of it transactional DDL, COPY or a session SET.
// Anything else is refused before the database is touched.
var restoreTOCAllowed = map[string]bool{
	"SCHEMA": true, "EXTENSION": true, "COMMENT": true, "ACL": true, "DEFAULT ACL": true,
	"TABLE": true, "TABLE DATA": true, "TABLE ATTACH": true,
	"SEQUENCE": true, "SEQUENCE SET": true, "SEQUENCE OWNED BY": true, "DEFAULT": true,
	"INDEX": true, "INDEX ATTACH": true, "CONSTRAINT": true, "CHECK CONSTRAINT": true, "FK CONSTRAINT": true,
	"TRIGGER": true, "EVENT TRIGGER": true, "RULE": true, "POLICY": true, "ROW SECURITY": true,
	"FUNCTION": true, "PROCEDURE": true, "AGGREGATE": true,
	"TYPE": true, "SHELL TYPE": true, "DOMAIN": true,
	"VIEW": true, "MATERIALIZED VIEW": true, "MATERIALIZED VIEW DATA": true,
	"COLLATION": true, "CONVERSION": true, "CAST": true, "TRANSFORM": true,
	"OPERATOR": true, "OPERATOR CLASS": true, "OPERATOR FAMILY": true, "ACCESS METHOD": true,
	"TEXT SEARCH CONFIGURATION": true, "TEXT SEARCH DICTIONARY": true,
	"TEXT SEARCH PARSER": true, "TEXT SEARCH TEMPLATE": true,
	"STATISTICS": true, "STATISTICS DATA": true,
	"ENCODING": true, "STDSTRINGS": true, "SEARCHPATH": true,
}

// restoreTOCRefusedNames are types a refusal should name whole (several are
// more than one word).
var restoreTOCRefusedNames = []string{
	"DATABASE PROPERTIES", "DATABASE", "BLOB METADATA", "BLOBS", "BLOB", "LARGE OBJECT",
	"SUBSCRIPTION TABLE", "SUBSCRIPTION", "PUBLICATION TABLES IN SCHEMA", "PUBLICATION TABLE",
	"PUBLICATION", "TABLESPACE", "SECURITY LABEL", "PROCEDURAL LANGUAGE",
	"FOREIGN DATA WRAPPER", "FOREIGN SERVER", "SERVER", "USER MAPPING", "FOREIGN TABLE",
}

// restoreTOCTypes is every known type, longest first, for prefix matching.
var restoreTOCTypes = func() []string {
	var all []string
	for t := range restoreTOCAllowed {
		all = append(all, t)
	}
	all = append(all, restoreTOCRefusedNames...)
	sort.Slice(all, func(i, j int) bool { return len(all[i]) > len(all[j]) })
	return all
}()

// restoreTOCEntryType reads the type from one line of `pg_restore -l`
// ("215; 1259 16390 TABLE public users aurora"), or answers "" for a comment
// or blank line.
func restoreTOCEntryType(line string) string {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, ";") {
		return ""
	}
	// Drop "<dump id>; <catalog oid> <object oid> ".
	fields := strings.SplitN(line, " ", 4)
	if len(fields) < 4 || !strings.HasSuffix(fields[0], ";") {
		return line
	}
	rest := fields[3]
	for _, t := range restoreTOCTypes {
		if rest == t || strings.HasPrefix(rest, t+" ") {
			return t
		}
	}
	if i := strings.IndexByte(rest, ' '); i > 0 {
		return rest[:i]
	}
	return rest
}

// checkTOC lists the archive's table of contents and refuses one with an entry
// the transaction cannot run. It answers the refusal's message, or "".
func (t restoreTools) checkTOC(ctx context.Context, path string) (string, string) {
	cmd := exec.CommandContext(ctx, t.pgRestoreBin(), "-l", path)
	var stderr strings.Builder
	cmd.Stderr = &limitedStringWriter{w: &stderr, max: 16 * 1024}
	out, err := cmd.Output()
	if err != nil {
		return "upload is not a readable pg_dump custom archive (its table of contents could not be listed: " + err.Error() + ")",
			strings.TrimSpace(stderr.String())
	}
	seen := map[string]int{}
	var order []string
	for _, line := range strings.Split(string(out), "\n") {
		typ := restoreTOCEntryType(line)
		if typ == "" || restoreTOCAllowed[typ] {
			continue
		}
		if seen[typ] == 0 {
			order = append(order, typ)
		}
		seen[typ]++
	}
	if len(order) == 0 {
		return "", ""
	}
	parts := make([]string, len(order))
	for i, typ := range order {
		parts[i] = fmt.Sprintf("%s (%d)", typ, seen[typ])
	}
	return "the backup holds entries a restore here cannot run inside its single transaction: " + strings.Join(parts, ", ") +
		" (large objects among them are the usual case; restore such a backup from the command line)", ""
}

// restorePreamble opens the transaction and runs the wipe.
func restorePreamble(lockTimeout time.Duration) string {
	return fmt.Sprintf("BEGIN;\n"+
		"SET LOCAL lock_timeout = '%dms';\n"+
		"SET LOCAL statement_timeout = 0;\n"+
		"SET LOCAL idle_in_transaction_session_timeout = 0;\n"+
		"SET LOCAL client_min_messages = warning;\n"+
		"%s\n", lockTimeout.Milliseconds(), restoreWipeSQL)
}

// restoreCommitBlock is the only COMMIT the transaction ever gets, with the
// two lines psql prints around it (to stderr, unbuffered) so this process
// knows whether psql reached it and whether it took effect.
func restoreCommitBlock(marker string) string {
	return "\n\\warn aurora-restore committing " + marker + "\n" +
		"COMMIT;\n" +
		"\\warn aurora-restore committed " + marker + "\n"
}

// restoreProgress reads psql's stderr: it keeps the last 16 KiB for the
// outcome's message and watches for the commit block's lines.
type restoreProgress struct {
	mu                            sync.Mutex
	committingLine, committedLine string
	committing, committed         bool
	// failedAfterCommitting: the server reported an ERROR after psql reached
	// the COMMIT, which is the COMMIT failing: rolled back.
	failedAfterCommitting bool
	partial               []byte
	tail                  []byte
}

const restoreStderrTail = 16 * 1024

func newRestoreProgress(marker string) *restoreProgress {
	return &restoreProgress{
		committingLine: "aurora-restore committing " + marker,
		committedLine:  "aurora-restore committed " + marker,
	}
}

func (p *restoreProgress) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.tail = append(p.tail, b...)
	if over := len(p.tail) - restoreStderrTail; over > 0 {
		p.tail = append([]byte(nil), p.tail[over:]...)
	}
	p.partial = append(p.partial, b...)
	for {
		i := bytes.IndexByte(p.partial, '\n')
		if i < 0 {
			break
		}
		line := strings.TrimRight(string(p.partial[:i]), "\r")
		p.partial = p.partial[i+1:]
		switch {
		case line == p.committingLine:
			p.committing = true
		case line == p.committedLine:
			p.committed = true
		case p.committing && !p.committed && strings.Contains(line, "ERROR:"):
			p.failedAfterCommitting = true
		}
	}
	if len(p.partial) > restoreStderrTail {
		p.partial = p.partial[len(p.partial)-restoreStderrTail:]
	}
	return len(b), nil
}

func (p *restoreProgress) state() (committing, committed, failedAfterCommitting bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.committing, p.committed, p.failedAfterCommitting
}

func (p *restoreProgress) stderr() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return strings.TrimSpace(string(p.tail))
}

// restoreProcs are the pipeline's running children, for stopOnCancel. Each is
// started in a process group of its own (restoreChild), and signalled as a
// group, so nothing it started is left holding the stream.
type restoreProcs struct {
	mu   sync.Mutex
	pids []int
}

func (r *restoreProcs) add(p *os.Process) {
	r.mu.Lock()
	r.pids = append(r.pids, p.Pid)
	r.mu.Unlock()
}

func (r *restoreProcs) signal(sig syscall.Signal) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, pid := range r.pids {
		_ = syscall.Kill(-pid, sig) // a group that has gone answers ESRCH
	}
}

// restoreChild prepares a pipeline child: its own process group, and a bound
// on Wait's wait for its pipes.
func restoreChild(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = restorePipeDelay
	return cmd
}

// stopOnCancel stops the pipeline when ctx ends (a server stop, the
// 60-minute bound) until stop is closed. Before psql reaches the COMMIT it
// interrupts psql (which cancels the statement in flight and exits, so the
// transaction rolls back) and pg_restore, and kills both if they are still
// there after restoreInterruptGrace. A COMMIT psql has reached is left to
// finish for up to restoreCommitGrace: interrupting it could leave unknown
// whether it took effect.
func stopOnCancel(ctx context.Context, stop <-chan struct{}, prog *restoreProgress, procs *restoreProcs) {
	select {
	case <-stop:
		return
	case <-ctx.Done():
	}
	grace := restoreInterruptGrace
	if committing, _, _ := prog.state(); committing {
		grace = restoreCommitGrace
	} else {
		procs.signal(syscall.SIGINT)
	}
	select {
	case <-stop:
	case <-time.After(grace):
		procs.signal(syscall.SIGKILL)
	}
}

// replace clears the old data and loads the backup in one transaction: see the
// file comment.
func (t restoreTools) replace(ctx context.Context, databaseURL, path string) restoreEnd {
	failed := func(message, stderr string) restoreEnd {
		return restoreEnd{phase: RestoreReplacing, database: RestoreDBUnchanged,
			message: "the restore failed and its transaction was rolled back — the database was NOT modified: " + message,
			stderr:  stderr}
	}
	key, err := newRestoreID()
	if err != nil {
		return failed(err.Error(), "")
	}
	marker, err := newRestoreID()
	if err != nil {
		return failed(err.Error(), "")
	}
	lockTimeout := t.lockTimeout
	if lockTimeout <= 0 {
		lockTimeout = restoreLockTimeout
	}
	connURL, pgEnv := pgConnEnv(databaseURL)

	// psql reads the whole stream from stdin. -X: no psqlrc; -w: never ask
	// for a password (stdin is the script); ON_ERROR_STOP: the first error
	// ends it, before any COMMIT. No --single-transaction: see the file
	// comment. Its stdout (the SELECT setval results in the dump) goes to
	// the null device.
	psqlCmd := restoreChild(exec.Command(t.psqlBin(), "-X", "--quiet", "--no-password", "--set", "ON_ERROR_STOP=on", "-f", "-", connURL))
	psqlCmd.Env = append(os.Environ(), append(pgEnv, "PGAPPNAME="+restoreAppName)...)
	prog := newRestoreProgress(marker)
	psqlCmd.Stderr = prog
	stdin, err := psqlCmd.StdinPipe()
	if err != nil {
		return failed("could not open psql's input: "+err.Error(), "")
	}
	if err := psqlCmd.Start(); err != nil {
		return failed("could not start psql (is it installed on $PATH?): "+err.Error(), "")
	}
	procs := &restoreProcs{}
	procs.add(psqlCmd.Process)
	stop := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		stopOnCancel(ctx, stop, prog, procs)
	}()

	pgr := restoreChild(exec.Command(t.pgRestoreBin(), "--no-owner", "--no-privileges", "--no-comments", "--restrict-key="+key, "-f", "-", path))
	var pgrStderr strings.Builder
	pgr.Stderr = &limitedStringWriter{w: &pgrStderr, max: 16 * 1024}

	// What stopped the stream short of the commit block, if anything.
	var streamErr error
	if _, err := io.WriteString(stdin, restorePreamble(lockTimeout)); err != nil {
		streamErr = fmt.Errorf("psql stopped reading before the wipe: %w", err)
	} else if out, err := pgr.StdoutPipe(); err != nil {
		streamErr = fmt.Errorf("could not open pg_restore's output: %w", err)
	} else if err := pgr.Start(); err != nil {
		streamErr = fmt.Errorf("could not start pg_restore: %w", err)
	} else {
		procs.add(pgr.Process)
		_, copyErr := io.Copy(stdin, out)
		if copyErr != nil {
			// psql has gone (an error in the SQL, an interrupt): pg_restore
			// would block on a pipe nobody reads.
			_ = syscall.Kill(-pgr.Process.Pid, syscall.SIGKILL)
		}
		waitErr := pgr.Wait()
		switch {
		case waitErr != nil:
			streamErr = fmt.Errorf("pg_restore failed while converting the backup: %w", waitErr)
		case copyErr != nil:
			streamErr = fmt.Errorf("psql stopped reading the backup: %w", copyErr)
		}
	}

	// THE GUARD. The commit block, and with it the only COMMIT this
	// transaction can get, is written only when pg_restore exited 0, its
	// whole output reached psql, and the job is not being stopped.
	commitSent := false
	if streamErr == nil && ctx.Err() == nil {
		if _, err := io.WriteString(stdin, restoreCommitBlock(marker)); err != nil {
			streamErr = fmt.Errorf("psql stopped reading before the commit: %w", err)
		} else {
			commitSent = true
		}
	}
	if !commitSent {
		// No COMMIT, ever: interrupt psql so a statement in flight is
		// cancelled at once; its connection's end rolls the transaction back.
		_ = syscall.Kill(-psqlCmd.Process.Pid, syscall.SIGINT)
	}
	_ = stdin.Close()
	psqlErr := psqlCmd.Wait()
	close(stop)
	<-stopped

	stderr := strings.TrimSpace(strings.Join(nonEmpty(strings.TrimSpace(pgrStderr.String()), prog.stderr()), "\n"))
	committing, committed, failedAfterCommitting := prog.state()
	switch {
	case committed:
		return restoreEnd{ok: true, phase: RestoreReplacing, database: RestoreDBRestored,
			message: "Restore complete. RESTART AURORA NOW — current connections will see stale state until you do."}
	case committing && !failedAfterCommitting:
		return restoreEnd{phase: RestoreReplacing, database: RestoreDBUnknown,
			message: "psql was cut off after it sent the COMMIT and before it could report how the COMMIT ended, so the database holds either the old data or the backup (never a mix): check which before going on",
			stderr:  stderr}
	case streamErr != nil:
		return failed(streamErr.Error(), stderr)
	case psqlErr != nil:
		return failed("psql: "+psqlErr.Error(), stderr)
	default:
		// psql exited 0 after the commit block without printing that it
		// committed: not expected; the marker is what proves a commit.
		return restoreEnd{phase: RestoreReplacing, database: RestoreDBUnknown,
			message: "psql ended without reporting whether the COMMIT took effect, so the database holds either the old data or the backup (never a mix): check which before going on",
			stderr:  stderr}
	}
}

func nonEmpty(ss ...string) []string {
	var out []string
	for _, s := range ss {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
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
