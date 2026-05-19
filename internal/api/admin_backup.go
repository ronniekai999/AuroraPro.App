package api

// Aurora database backup AND restore endpoints.
//
// Streams `pg_dump --format=plain --no-owner --no-acl <DATABASE_URL>` through
// gzip to the HTTP response. Admin-only (the route is mounted under the
// /api/admin chi.Route group which already applies auth.RequireAdmin).
//
// Output format: gzipped SQL dump, restorable on any Postgres of equal or
// later major version via:
//
//     gunzip < aurora-backup-XXX.sql.gz | psql $DATABASE_URL
//
// Notes:
//   - --no-owner / --no-acl strip role-binding statements so the dump
//     applies cleanly to a fresh database owned by any user. The new
//     server's Aurora bootstrap user becomes the implicit owner.
//   - We stream rather than buffer: the gzip writer is wired straight to
//     the http.ResponseWriter, so even a 10GB dump uses bounded memory.
//   - stderr is buffered (bounded) so on non-zero exit we can include
//     pg_dump's diagnostic message in the error log. Operator visibility.
//   - Excluded tables: refresh_tokens (session state — doesn't migrate),
//     scan_progress (transient scanner state — regenerates on next scan).

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// Backup handles GET /api/admin/backup — streams a gzipped pg_dump of the
// Aurora database. Long-running (10s to several minutes depending on
// catalog size); no request timeout middleware applies to this route.
func (h *AdminHandler) Backup(w http.ResponseWriter, r *http.Request) {
	if h.databaseURL == "" {
		writeError(w, http.StatusInternalServerError, "backup unavailable: database URL not configured")
		return
	}

	// 2026-05-16 audit H1 — extend server-level write deadline. main.go
	// sets WriteTimeout=120s globally; without this extension, multi-GB
	// dumps would have their TCP conn torn down mid-write and the client
	// sees "connection reset" even though pg_dump was still going.
	// Matches the streaming.go pattern at line 648.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Now().Add(35 * time.Minute))
		_ = rc.SetReadDeadline(time.Now().Add(35 * time.Minute))
	}

	// 2026-05-16 audit H3 — serialize concurrent backup/restore operations.
	// Two concurrent restores could corrupt each other (DROP SCHEMA from
	// one races a --single-transaction COMMIT from another). One backup
	// + one restore could similarly produce a stale dump. Hold a mutex
	// for the duration of either operation; second caller returns 409.
	if !h.backupRestoreMu.TryLock() {
		writeError(w, http.StatusConflict, "another backup or restore is already in progress; please wait for it to complete")
		return
	}
	defer h.backupRestoreMu.Unlock()

	// Filename: aurora-backup-2026-05-16T03-42-15Z.sql.gz — ISO-8601
	// with colons replaced (Windows-safe), sorts chronologically.
	stamp := time.Now().UTC().Format("2006-01-02T15-04-05Z")
	filename := fmt.Sprintf("aurora-backup-%s.sql.gz", stamp)

	// pg_dump invocation:
	//   --format=plain      → portable SQL (vs custom binary which requires pg_restore)
	//   --no-owner          → don't emit ALTER OWNER (lets restore-as-different-user work)
	//   --no-acl            → don't emit GRANT/REVOKE
	//   --quote-all-identifiers → safer round-trip on case-sensitive names
	//   --exclude-table     → skip ephemeral tables (saves space + avoids
	//                         migrating user sessions across servers)
	//
	// pg_dump reads the DATABASE_URL via the conninfo string argument.
	// We pass it as the last positional arg; pg_dump auto-detects URI form.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	// 2026-05-16 audit H2 — switched from --exclude-table to
	// --exclude-table-data. The former strips BOTH the DDL and the data,
	// leaving the restored DB without these tables at all. Since
	// schema_migrations IS dumped, RunMigrations would skip re-creating
	// them, and every future write to refresh_tokens / scan_progress
	// would fail with "relation does not exist". --exclude-table-data
	// keeps the CREATE TABLE statements but drops the row data — these
	// are session-state tables so the data shouldn't migrate anyway,
	// but the tables themselves must exist for the app to function.
	cmd := exec.CommandContext(ctx, "pg_dump",
		"--format=plain",
		"--no-owner",
		"--no-acl",
		"--quote-all-identifiers",
		"--exclude-table-data=refresh_tokens",
		"--exclude-table-data=scan_progress",
		h.databaseURL,
	)

	// Stderr is captured into a bounded buffer so non-zero exits log
	// the actual pg_dump error message (e.g., "version mismatch",
	// "permission denied", "could not connect"). Reasonable cap; even
	// verbose pg_dump rarely exceeds a few KB.
	var stderrBuf strings.Builder
	cmd.Stderr = &limitedStringWriter{w: &stderrBuf, max: 16 * 1024}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "backup: failed to open pg_dump stdout: "+err.Error())
		return
	}

	if err := cmd.Start(); err != nil {
		// pg_dump binary not on $PATH is the typical cause here.
		// 2026-05-16 audit H9 fix — failure paths must run BEFORE the
		// download headers are set; otherwise the browser saves the
		// JSON error body to a .sql.gz file (Content-Type lies).
		writeError(w, http.StatusInternalServerError, "backup: failed to start pg_dump (is it installed on $PATH?): "+err.Error())
		return
	}

	// pg_dump is now running — safe to commit to the download response.
	// Audit H9: this must happen AFTER cmd.Start() succeeds, not before.
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Cache-Control", "no-store, must-revalidate")

	// Stream pg_dump → gzip → http response. The gzip writer's internal
	// buffer is small (32KB default) so memory stays bounded. We use
	// gzip.BestSpeed because pg_dump output is highly compressible
	// (lots of repeated INSERT INTO ... structure) and the bottleneck
	// is the network, not CPU.
	gzWriter, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
	// streamWithFlush flushes BOTH the gzip writer's internal buffer
	// AND the http.Flusher so the client sees real-time progress
	// rather than waiting for gzip's ~64KB window to fill. Audit M7 fix.
	copyErr := streamWithFlush(gzWriter, stdout, w)
	if cerr := gzWriter.Close(); cerr != nil && copyErr == nil {
		copyErr = cerr
	}

	// Always wait for pg_dump to finish even if the copy errored — leaving
	// it as a zombie would leak a process slot.
	waitErr := cmd.Wait()

	if copyErr != nil || waitErr != nil {
		// At this point the response is already partially streamed; we
		// can't return a clean error status. Log diagnostics and let
		// the client see a truncated download. The frontend should
		// show a clear "backup failed — check server logs" message on
		// any download interruption.
		slog.Error("admin backup failed",
			"copy_err", copyErr,
			"wait_err", waitErr,
			"pg_dump_stderr", strings.TrimSpace(stderrBuf.String()),
		)
		return
	}
	slog.Info("admin backup succeeded", "filename", filename)
}

// limitedStringWriter is an io.Writer that drops writes once a cap is
// reached. Used to bound pg_dump's stderr capture so a runaway error
// stream can't OOM the server. Identical pattern to the FFmpeg stderr
// capture in streaming.go.
type limitedStringWriter struct {
	w   *strings.Builder
	max int
}

func (l *limitedStringWriter) Write(p []byte) (int, error) {
	remaining := l.max - l.w.Len()
	if remaining <= 0 {
		return len(p), nil // drop but report all bytes consumed
	}
	if len(p) > remaining {
		l.w.Write(p[:remaining])
	} else {
		l.w.Write(p)
	}
	return len(p), nil
}

// streamWithFlush copies src→dst in chunks, flushing both the gzip
// writer's internal buffer AND the underlying http.Flusher after each
// chunk so the client sees bytes immediately rather than waiting for
// the entire dump to complete. Important for the UX of a download that
// takes 30+ seconds.
//
// Audit M7 fix (2026-05-16): without gzWriter.Flush() between writes,
// gzip's ~64KB sliding-window buffer doesn't drain to the http response
// until enough input accumulates, so the user saw lumpy bursts instead
// of streaming progress. The dst here is the gzip.Writer wrapping w;
// we type-assert to gzipFlusher to call Flush(), and to http.Flusher
// for the network push.
//
// Both flushers are opportunistic — when either is absent, the copy
// still proceeds correctly; the user just sees larger chunks.
type gzipFlusher interface {
	Flush() error
}

func streamWithFlush(dst io.Writer, src io.Reader, w http.ResponseWriter) error {
	gzFlusher, _ := dst.(gzipFlusher)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			// Drain the gzip writer's internal buffer to the underlying
			// http.ResponseWriter, THEN flush the ResponseWriter to the
			// network. Order matters: flushing the network without
			// flushing gzip first would just push whatever previous
			// chunk's compressed output had spilled into w; the bytes
			// we just wrote would sit in gzip's buffer.
			if gzFlusher != nil {
				_ = gzFlusher.Flush()
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// ============================================================
// Restore — multipart upload of a backup .sql.gz, piped to psql
// ============================================================
//
// Companion to Backup. Admin-only. Streams the uploaded file directly
// through gunzip → psql stdin without ever buffering the whole archive
// in memory (multi-GB-safe on small servers).
//
// Pipeline:
//   1. Validate magic bytes (gzip = 0x1F 0x8B) before committing to the work.
//   2. Wipe the public schema: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
//      via a separate psql -c call (the existing pool's prepared-statement
//      caches are now stale, but psql doesn't care).
//   3. Stream upload → gzip.Reader → psql stdin with --single-transaction +
//      ON_ERROR_STOP=on. Any error rolls the whole restore back; the schema
//      stays wiped (operator can retry).
//
// CRITICAL: Aurora's own pgxpool connections are still pointed at this DB
// and may have cached metadata or prepared statements. After a successful
// restore the operator MUST restart Aurora. The response message + the UI
// modal both call this out. We do NOT attempt to restart automatically
// because (a) restarting from within the request you're serving is a
// guaranteed lost-response, (b) the user may want to verify before
// restarting, (c) systemd / process supervision handles this externally.

// maxRestoreSizeBytes caps the upload to prevent disk exhaustion on /tmp
// if Go's multipart parser spills to disk. 50GB is comfortably above any
// realistic Aurora catalog and small enough to fit on a typical server
// /tmp partition. Users with larger DBs should bypass the UI and run
// `psql` directly on the server.
const maxRestoreSizeBytes = 50 << 30

func (h *AdminHandler) Restore(w http.ResponseWriter, r *http.Request) {
	if h.databaseURL == "" {
		writeError(w, http.StatusInternalServerError, "restore unavailable: database URL not configured")
		return
	}

	// 2026-05-16 audit H1 — extend server-level deadlines. main.go's
	// 120s WriteTimeout would tear down the connection before psql
	// finishes ingesting any non-trivial dump, even though the DB
	// restore itself succeeded. The 65min extension matches the
	// handler's own 60min ctx timeout with a small buffer for the
	// final writeJSON response.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Now().Add(65 * time.Minute))
		_ = rc.SetReadDeadline(time.Now().Add(65 * time.Minute))
	}

	// 2026-05-16 audit H3 — serialize backup/restore operations. See
	// Backup for the rationale. Same mutex — both endpoints share it.
	if !h.backupRestoreMu.TryLock() {
		writeError(w, http.StatusConflict, "another backup or restore is already in progress; please wait for it to complete")
		return
	}
	defer h.backupRestoreMu.Unlock()

	// Use MultipartReader (streaming) rather than ParseMultipartForm
	// (buffers entire upload to memory/disk). For multi-GB restores
	// this is the difference between OOM and clean operation.
	reader, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid multipart request: "+err.Error())
		return
	}

	var part *multipart.Part
	for {
		p, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "failed to read multipart: "+err.Error())
			return
		}
		if p.FormName() == "backup" {
			part = p
			break
		}
		// Drain unrelated parts so the reader advances. Bounded by
		// the http server's request body size limit so this can't
		// be abused for unbounded reads.
		_, _ = io.Copy(io.Discard, p)
		_ = p.Close()
	}
	if part == nil {
		writeError(w, http.StatusBadRequest, "missing 'backup' file field in upload")
		return
	}
	defer part.Close()

	// Validate gzip magic before doing anything destructive. We
	// peek-read the first 2 bytes; the bytes flow back into the
	// pipeline via io.MultiReader so nothing is lost.
	magic := make([]byte, 2)
	mn, mErr := io.ReadFull(part, magic)
	if mErr != nil || mn < 2 {
		writeError(w, http.StatusBadRequest, "upload too short to be a gzip archive")
		return
	}
	if magic[0] != 0x1F || magic[1] != 0x8B {
		writeError(w, http.StatusBadRequest, "upload is not a gzip archive (bad magic bytes)")
		return
	}

	// Reconstruct full reader: the two magic bytes + the rest of the
	// part body. Caps at maxRestoreSizeBytes so a malicious uploader
	// can't stream forever.
	fullReader := io.LimitReader(io.MultiReader(bytes.NewReader(magic), part), maxRestoreSizeBytes)

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Minute)
	defer cancel()

	// Phase 1 — wipe the existing schema. Without this, the restore
	// would fail on "relation already exists" for every table.
	//
	// Audit (production restore 2026-05-18) — the previous wipe used
	// `DROP SCHEMA public CASCADE` which ALSO drops every extension
	// installed in `public` (pg_trgm, vector). The dump then tries to
	// recreate those extensions, but Aurora connects as the unprivileged
	// `aurora` role which cannot `CREATE EXTENSION vector` (non-trusted).
	// The whole restore rolled back with "permission denied to create
	// extension vector. Must be superuser."
	//
	// The new wipe loops through objects in the public schema and drops
	// only those NOT owned by an extension. Extensions stay intact,
	// the dump's `CREATE EXTENSION IF NOT EXISTS` becomes a no-op
	// (which doesn't require superuser when the extension is already
	// present), and the restore proceeds.
	wipeSQL := `
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
END
$do$;
`
	wipeCmd := exec.CommandContext(ctx, "psql",
		"--quiet",
		"--set", "ON_ERROR_STOP=on",
		"-c", wipeSQL,
		h.databaseURL,
	)
	var wipeStderr strings.Builder
	wipeCmd.Stderr = &limitedStringWriter{w: &wipeStderr, max: 16 * 1024}
	if err := wipeCmd.Run(); err != nil {
		// Audit M2 — include the actual psql stderr in the error
		// response. Previously the message only said "is psql
		// installed?" which is misleading when the real cause is
		// "connection refused" / "permission denied on schema public"
		// / "role does not exist". The stderr tail makes the actual
		// problem visible to the admin.
		stderrTail := strings.TrimSpace(wipeStderr.String())
		slog.Error("restore pre-wipe failed", "err", err, "stderr", stderrTail)
		msg := "pre-restore wipe failed: " + err.Error()
		if stderrTail != "" {
			msg += " — psql said: " + stderrTail
		}
		writeError(w, http.StatusInternalServerError, msg)
		return
	}

	// Phase 2 — pipe upload → gunzip → psql.
	// --single-transaction wraps the whole restore in BEGIN/COMMIT so
	//   a mid-restore error rolls everything back (schema stays wiped,
	//   operator can retry).
	// --set ON_ERROR_STOP=on aborts on the first error instead of
	//   continuing with subsequent statements that depend on what
	//   failed.
	psqlCmd := exec.CommandContext(ctx, "psql",
		"--single-transaction",
		"--set", "ON_ERROR_STOP=on",
		"--quiet",
		h.databaseURL,
	)
	stdin, err := psqlCmd.StdinPipe()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to open psql stdin: "+err.Error())
		return
	}
	var psqlStderr strings.Builder
	psqlCmd.Stderr = &limitedStringWriter{w: &psqlStderr, max: 16 * 1024}

	if err := psqlCmd.Start(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start psql (is it installed?): "+err.Error())
		return
	}

	gz, err := gzip.NewReader(fullReader)
	if err != nil {
		_ = stdin.Close()
		_ = psqlCmd.Wait()
		// Audit M3 — by this point we've already wiped the schema.
		// The error message must communicate that, so the admin knows
		// the database is empty and they need to retry with a valid
		// file (or restore from another source).
		writeError(w, http.StatusBadRequest, "failed to decompress upload: "+err.Error()+" — note: the database has been wiped, retry with a valid backup file")
		return
	}

	// Drive the pipeline. We filter the dump line-by-line on the way
	// through, dropping extension-management DDL that requires
	// superuser / extension-owner privileges (CREATE EXTENSION,
	// COMMENT ON EXTENSION, ALTER EXTENSION). Aurora's role isn't
	// the extension owner — postgres is — so leaving these lines in
	// would fail with "must be owner of extension X" and roll the
	// whole restore back. The extensions themselves are preserved
	// by the smarter wipe above, so the dump's view of them is
	// purely informational and safe to discard.
	//
	// 1 MB initial line buffer, 16 MB max. pg_dump --inserts produces
	// per-row INSERT statements which are typically <1 KB; data lines
	// in COPY blocks are limited by the table's row width. 16 MB is
	// the safety ceiling for some pathological row (e.g. a single
	// blob column).
	copyErr := func() error {
		scanner := bufio.NewScanner(gz)
		scanner.Buffer(make([]byte, 1<<20), 16<<20)
		// Audit M1 (deep-debug 2026-05-18) — the extension-DDL
		// filter must NOT fire inside `COPY ... FROM stdin;` blocks.
		// COPY data is one row per line; if a row's first column
		// contained the literal text "CREATE EXTENSION foo" (e.g.,
		// a movie title with that phrase, an operator error message,
		// a chat post), the filter would silently drop the row and
		// the restore would succeed minus that one row — silent
		// data loss in a recovery operation, which is the worst
		// possible failure mode. Track the COPY block state and
		// pass-through unchanged inside it.
		var inCopyBlock bool
		for scanner.Scan() {
			line := scanner.Bytes()
			// COPY block start: line begins with `COPY ` and ends
			// with `FROM stdin;`. pg_dump emits both with no
			// leading whitespace.
			if !inCopyBlock && bytes.HasPrefix(line, []byte("COPY ")) && bytes.HasSuffix(line, []byte(" FROM stdin;")) {
				inCopyBlock = true
			} else if inCopyBlock && bytes.Equal(line, []byte(`\.`)) {
				// `\.` on its own line terminates the COPY block.
				inCopyBlock = false
			} else if !inCopyBlock && isExtensionDDL(line) {
				continue
			}
			if _, err := stdin.Write(line); err != nil {
				return err
			}
			if _, err := stdin.Write([]byte{'\n'}); err != nil {
				return err
			}
		}
		if err := scanner.Err(); err != nil {
			// Audit M3 — bufio.ErrTooLong vs other errors. The
			// generic error gets prepended with hint context so
			// the operator knows the dump exceeded the 16 MB
			// per-line ceiling (likely a pathological blob row).
			if err == bufio.ErrTooLong {
				return fmt.Errorf("backup contains a line longer than 16 MB (typically a single-row blob column) — bypass this UI and restore directly: `gunzip < backup.sql.gz | psql $DATABASE_URL`. underlying: %w", err)
			}
			return err
		}
		return nil
	}()
	_ = gz.Close()
	_ = stdin.Close()
	waitErr := psqlCmd.Wait()

	if copyErr != nil || waitErr != nil {
		stderrTail := strings.TrimSpace(psqlStderr.String())
		slog.Error("restore failed",
			"copy_err", copyErr,
			"wait_err", waitErr,
			"psql_stderr_tail", stderrTail,
		)
		// The --single-transaction wrapped the whole thing, so on
		// failure the DB is back to the wiped (empty) state. Tell the
		// operator that explicitly so they know to retry.
		msg := "restore failed; database is in wiped state, retry with a valid backup."
		if stderrTail != "" {
			msg += " psql said: " + stderrTail
		}
		writeError(w, http.StatusInternalServerError, msg)
		return
	}

	slog.Info("restore succeeded — Aurora MUST be restarted to use new data")
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "ok",
		"message": "Restore complete. RESTART AURORA NOW — current connections will see stale state until you do.",
	})
}

// isExtensionDDL returns true for lines that pg_dump emits to manage
// extensions, and which the unprivileged `aurora` role cannot execute:
//
//   - CREATE EXTENSION [IF NOT EXISTS] vector WITH SCHEMA public;
//   - COMMENT ON EXTENSION vector IS '...';
//   - ALTER EXTENSION vector ... ;
//
// Aurora's role isn't the extension owner (postgres is), and many
// extensions aren't TRUSTED (vector, in particular). install.sh
// pre-creates the required extensions, so the dump's view of them
// is purely informational — safe to drop entirely.
//
// pg_dump always emits statements on their own line with no leading
// whitespace. We tolerate leading whitespace anyway for safety
// against hand-edited dumps. Match is case-sensitive against
// pg_dump's uppercase output; we don't try to handle hand-edited
// lowercase dumps because the cost of false-positives (silently
// dropping legitimate CREATE statements with different DDL) is
// worse than the cost of telling operators "use a pg_dump output
// not a hand-edited one."
func isExtensionDDL(line []byte) bool {
	t := bytes.TrimLeft(line, " \t")
	return bytes.HasPrefix(t, []byte("CREATE EXTENSION ")) ||
		bytes.HasPrefix(t, []byte("COMMENT ON EXTENSION ")) ||
		bytes.HasPrefix(t, []byte("ALTER EXTENSION ")) ||
		bytes.HasPrefix(t, []byte("DROP EXTENSION "))
}
