package api

// Aurora database backup AND restore endpoints.
//
// Streams `pg_dump --format=custom --compress=6 <DATABASE_URL>` directly
// to the HTTP response. Admin-only (the route is mounted under the
// /api/admin chi.Route group which already applies auth.RequireAdmin).
//
// Output format: PostgreSQL custom-format archive (binary, self-
// compressed). Restorable on any Postgres of equal or later major
// version via:
//
//     pg_restore --single-transaction --no-owner --no-privileges \
//                --no-comments --dbname=$DATABASE_URL backup.dump
//
// 2026-05-18 rearchitecture — we previously used `--format=plain | gzip`
// on the dump side and `gunzip | bufio.Scanner-filter | psql` on the
// restore side. The text pipeline had a recurring class of bugs:
//
//   - Privileged statements (CREATE/COMMENT/ALTER EXTENSION) had to be
//     filtered line-by-line because the unprivileged Aurora role can't
//     execute them. Each new statement type was a new whack-a-mole fix.
//   - The line scanner could mangle long-line data: a pgvector row
//     spanning >scanner-buffer would split across reads, and the
//     reassembly produced invalid syntax (e.g. "0..074918" — a double
//     dot from a row split mid-number).
//
// Custom format eliminates BOTH classes:
//   - pg_restore has --no-owner / --no-privileges / --no-comments
//     flags that handle every privileged statement, no string parsing.
//   - Binary format passes through to pg_restore as opaque bytes; we
//     never inspect the payload. No scanner = no mangling.
//
// Operator note for legacy `.sql.gz` backups: restore them via the
// shell instead — the UI accepts only the new `.dump` format.
//
//     gunzip < legacy-backup.sql.gz | psql $DATABASE_URL
//
// Notes:
//   - --no-owner / --no-acl strip role-binding statements so the dump
//     applies cleanly to a fresh database owned by any user.
//   - We stream rather than buffer for backup: pg_dump's stdout is wired
//     straight to the http.ResponseWriter, so even a 10GB dump uses
//     bounded memory.
//   - Restore needs a seekable file (pg_restore reads the table of
//     contents non-sequentially), so the upload spills to a temp file
//     bounded by maxRestoreSizeBytes. Cleanup runs on every exit path.
//   - stderr is buffered (bounded) so on non-zero exit we can include
//     pg_dump / pg_restore's diagnostic message in the error log.
//   - Excluded tables: refresh_tokens (session state — doesn't migrate),
//     scan_progress (transient scanner state — regenerates on next scan).

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// pgDumpCustomMagic is the leading byte signature of a PostgreSQL
// custom-format dump (`pg_dump --format=custom` / `--format=c`).
// Used by Restore to validate the upload before doing anything
// destructive. See PostgreSQL source: src/bin/pg_dump/pg_backup_archiver.h.
var pgDumpCustomMagic = []byte("PGDMP")

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
	//
	// Why 35min for backup but 65min for restore (see Restore below):
	// pg_dump streams a binary archive directly to the network — its
	// throughput is bounded by disk read + network write. pg_restore
	// has to replay every DDL statement, rebuild indexes, and update
	// every row in a single transaction — roughly an order of magnitude
	// slower per byte. The asymmetric deadlines reflect the asymmetric
	// work.
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

	// Filename: aurora-backup-2026-05-18T03-42-15Z.dump — ISO-8601
	// with colons replaced (Windows-safe), sorts chronologically.
	// `.dump` is the conventional extension for pg_dump custom format.
	stamp := time.Now().UTC().Format("2006-01-02T15-04-05Z")
	filename := fmt.Sprintf("aurora-backup-%s.dump", stamp)

	// pg_dump invocation:
	//   --format=custom     → binary archive; restored with pg_restore.
	//                         Carries its own compression (zlib) and a
	//                         table-of-contents so pg_restore can do
	//                         per-table parallel restore + selective
	//                         object skipping. CRUCIALLY: pg_restore can
	//                         skip ownership/privilege/comment statements
	//                         via flags, so we don't need to filter text.
	//   --compress=6        → zlib level 6 (default 9 is needlessly slow
	//                         for the marginal size gain). Matches the
	//                         old gzip.BestSpeed throughput intent.
	//   --no-owner          → don't emit ALTER OWNER (lets restore-as-
	//                         different-user work).
	//   --no-acl            → don't emit GRANT/REVOKE.
	//   --quote-all-identifiers → safer round-trip on case-sensitive names.
	//   --exclude-table-data → skip ephemeral table data (refresh tokens,
	//                         scan progress) but keep their DDL so the
	//                         restored DB has the right schema.
	//
	// pg_dump reads the DATABASE_URL via the conninfo string argument.
	// We pass it as the last positional arg; pg_dump auto-detects URI form.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pg_dump",
		"--format=custom",
		"--compress=6",
		"--no-owner",
		"--no-acl",
		// Defensive: skip publications + subscriptions even though
		// Aurora doesn't currently use logical replication. If any
		// future migration ever creates a PUBLICATION, the dump
		// would emit a CREATE PUBLICATION that the unprivileged
		// aurora role can't replay during restore. Strip at the
		// dump side so the dump is self-restorable.
		"--no-publications",
		"--no-subscriptions",
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
		// JSON error body to a .dump file (Content-Type lies).
		writeError(w, http.StatusInternalServerError, "backup: failed to start pg_dump (is it installed on $PATH?): "+err.Error())
		return
	}

	// pg_dump is now running — safe to commit to the download response.
	// Audit H9: this must happen AFTER cmd.Start() succeeds, not before.
	// application/octet-stream is the standard MIME for pg_dump custom
	// format (no registered IANA type for it).
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Cache-Control", "no-store, must-revalidate")

	// Stream pg_dump → http response. Custom format compresses itself,
	// so we don't wrap in a gzip layer — eliminates a whole class of
	// buffer-alignment bugs (the previous gzip.Writer + bufio.Scanner
	// pipeline could mangle pgvector rows that crossed buffer boundaries).
	// streamWithFlush pumps bytes through with periodic http.Flusher
	// calls so the client sees real-time progress instead of waiting
	// for OS-level write buffering to drain.
	copyErr := streamWithFlush(w, stdout)

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

// streamWithFlush copies src→dst in 32KB chunks, calling http.Flusher
// between writes so the client sees bytes as pg_dump emits them rather
// than waiting for OS-level buffering to drain. Important for the UX of
// a download that takes 30+ seconds.
//
// When dst is *not* an http.ResponseWriter (e.g. a test buffer), the
// type assertion fails silently and the copy proceeds without flushing
// — the caller just sees one big chunk at EOF. That's correct for
// non-streaming consumers.
//
// We no longer wrap dst in a gzip.Writer; pg_dump --format=custom emits
// pre-compressed bytes (zlib). Adding our own gzip layer was the source
// of the buffer-mangling bugs the 2026-05-18 rearchitecture eliminated.
func streamWithFlush(dst io.Writer, src io.Reader) error {
	flusher, _ := dst.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
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
// Restore — multipart upload of a backup .dump, fed to pg_restore
// ============================================================
//
// Companion to Backup. Admin-only.
//
// Pipeline:
//   1. Validate magic bytes (custom format starts with "PGDMP") before
//      doing anything destructive.
//   2. Stream the upload to a temp file. pg_restore needs a seekable
//      file (custom format has a table of contents it reads first, then
//      jumps around in). We cap the file size at maxRestoreSizeBytes.
//   3. Wipe the public schema: per-object DROPs that preserve installed
//      extensions (see wipeSQL below for the why).
//   4. Run pg_restore with:
//        --single-transaction  → BEGIN/COMMIT wrap; any failure rolls back
//        --no-owner            → skip ALTER OWNER statements
//        --no-privileges       → skip GRANT/REVOKE statements
//        --no-comments         → skip COMMENT ON statements (including the
//                                COMMENT ON EXTENSION lines that require
//                                extension-owner privilege)
//        --exit-on-error       → bail on first error rather than continuing
//                                with cascading downstream failures
//
// Why we no longer line-filter the dump (2026-05-18 rearchitecture):
//   The old plain-format + bufio.Scanner filter pipeline could mangle
//   rows that crossed scanner buffer boundaries — pgvector embeddings
//   for example, where a single row spans several KB. The corruption
//   manifested as invalid syntax errors mid-COPY ("0..074918" — a
//   double-dot from a row split mid-number). Custom format is binary
//   and goes straight to pg_restore without our code touching it.
//
// CRITICAL: Aurora's own pgxpool connections are still pointed at this DB
// and may have cached metadata or prepared statements. After a successful
// restore the operator MUST restart Aurora. The response message + the UI
// modal both call this out. We do NOT attempt to restart automatically
// because (a) restarting from within the request you're serving is a
// guaranteed lost-response, (b) the user may want to verify before
// restarting, (c) systemd / process supervision handles this externally.

// maxRestoreSizeBytes caps the upload to prevent disk exhaustion when we
// spill the upload to a temp file. 50GB is comfortably above any realistic
// Aurora catalog and small enough to fit on a typical server /tmp partition.
// Users with larger DBs should bypass the UI and run `pg_restore` directly
// on the server.
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

	// Bound the search for the "backup" form field so a malicious
	// upload can't tar-pit us with thousands of huge junk parts
	// before the real payload. Each junk part body is capped at
	// maxJunkPartBytes, and we give up entirely after maxJunkParts
	// non-matching parts.
	//
	// In practice the browser sends exactly one part named "backup".
	// Anything pathological (large number of junk parts, or one
	// junk part larger than maxJunkPartBytes) is rejected with a
	// clear error — defense against unbounded io.Copy(io.Discard, p)
	// the previous code had.
	const (
		maxJunkParts     = 16
		maxJunkPartBytes = 1 << 20 // 1 MiB
	)
	var part *multipart.Part
	junkSeen := 0
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
		junkSeen++
		if junkSeen > maxJunkParts {
			_ = p.Close()
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("multipart upload contains more than %d non-'backup' fields — aborting", maxJunkParts))
			return
		}
		// Drain the junk part with a tight cap so a single
		// adversarial part can't consume unbounded bandwidth.
		// io.CopyN returns io.EOF when the part was smaller than
		// the cap (fine); a successful copy of exactly maxJunkPartBytes
		// means there's more and we reject.
		n, derr := io.CopyN(io.Discard, p, maxJunkPartBytes)
		if derr == nil && n == maxJunkPartBytes {
			_ = p.Close()
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("non-'backup' multipart field exceeds %d-byte drain cap — aborting", maxJunkPartBytes))
			return
		}
		_ = p.Close()
	}
	if part == nil {
		writeError(w, http.StatusBadRequest, "missing 'backup' file field in upload")
		return
	}
	defer part.Close()

	// Validate magic bytes before doing anything destructive. Custom-
	// format dumps start with "PGDMP". We peek-read; the bytes flow
	// back into the pipeline via io.MultiReader so nothing is lost.
	//
	// Reject the legacy gzip magic (0x1F 0x8B) with a clear hint: those
	// were `.sql.gz` plain dumps from the old pipeline, and they're
	// restorable via the shell but not via this UI anymore.
	magic := make([]byte, len(pgDumpCustomMagic))
	// io.ReadFull guarantees either err == nil with full read, or
	// err != nil (ErrUnexpectedEOF on short read). No need for a
	// separate length check — if err is nil, the buffer is filled.
	if _, mErr := io.ReadFull(part, magic); mErr != nil {
		writeError(w, http.StatusBadRequest, "upload too short to be a pg_dump custom archive")
		return
	}
	if magic[0] == 0x1F && magic[1] == 0x8B {
		writeError(w, http.StatusBadRequest,
			"upload is a gzip archive (legacy .sql.gz format) — restore via shell instead: "+
				"`gunzip < file.sql.gz | psql $DATABASE_URL`. The UI now requires the new .dump format.")
		return
	}
	if !bytes.Equal(magic, pgDumpCustomMagic) {
		writeError(w, http.StatusBadRequest,
			"upload is not a pg_dump custom archive (expected leading bytes 'PGDMP'). "+
				"Run pg_dump with --format=custom to produce a compatible file.")
		return
	}

	// Reconstruct full reader: the magic bytes we already consumed +
	// the rest of the part body. We read up to maxRestoreSizeBytes+1
	// — the extra byte is a sentinel: if the copy returns that many
	// bytes the upload was truncated by the limit, and we reject
	// with an actionable error (otherwise pg_restore would just see
	// "unexpected end of file" and the operator would have no clue
	// the 50 GB cap was hit).
	fullReader := io.LimitReader(
		io.MultiReader(bytes.NewReader(magic), part),
		maxRestoreSizeBytes+1,
	)

	// Spill the upload to a temp file. pg_restore needs random access
	// (custom format has a table of contents at the front + jumps to
	// per-table offsets), so streaming over stdin doesn't work.
	//
	// PrivateTmp=yes on aurora.service means CreateTemp lands in a
	// per-service /tmp namespace. pg_restore is forked from aurora,
	// inherits that namespace, and reads the file fine. External
	// debuggers won't see the file — that's a feature, not a bug
	// (the dump contains password hashes).
	tmpFile, err := os.CreateTemp("", "aurora-restore-*.dump")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create temp file for upload: "+err.Error())
		return
	}
	tmpPath := tmpFile.Name()
	// Cleanup on every exit path: Close (idempotent — sentinel
	// errors after first call) and Remove. defers run LIFO, so Close
	// happens before Remove. The double-close from later f.Close()
	// after copy is harmless (returns ErrClosed which we ignore).
	defer tmpFile.Close()
	defer func() {
		_ = os.Remove(tmpPath)
	}()

	// Copy the upload to disk, bounded by maxRestoreSizeBytes+1.
	n, err := io.Copy(tmpFile, fullReader)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to spill upload to temp file: "+err.Error())
		return
	}
	if n > maxRestoreSizeBytes {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("upload exceeds the %d GB limit — bypass this UI and restore directly: "+
				"`pg_restore --single-transaction --no-owner --no-privileges --no-comments "+
				"--dbname=$DATABASE_URL backup.dump`", maxRestoreSizeBytes>>30))
		return
	}
	// Reject suspiciously tiny uploads BEFORE the destructive wipe.
	// A real Aurora dump (even an empty database with just schema)
	// runs to several KB; anything under 256 bytes can't possibly
	// hold the PGDMP header + TOC + a single table. Without this,
	// a 5-byte upload of just "PGDMP" wipes the DB then fails in
	// pg_restore with "unexpected end of file" — leaving the
	// operator's DB destroyed for a malformed upload.
	const minRestoreSizeBytes = 256
	if n < minRestoreSizeBytes {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("upload is too small (%d bytes) to be a valid pg_dump archive (expected >= %d). "+
				"Refusing to wipe the database for a malformed file.", n, minRestoreSizeBytes))
		return
	}
	if err := tmpFile.Close(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to close temp file: "+err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Minute)
	defer cancel()

	// Validate the upload is actually restorable BEFORE the destructive wipe.
	// The leading-magic + min-size checks above only prove the first bytes
	// look like a custom dump; `pg_restore --list` parses the archive header +
	// table-of-contents and fails fast on a truncated, corrupt, or version-
	// incompatible archive WITHOUT touching the database. Without this, a
	// plausible-but-unrestorable upload wiped the schema and then failed in
	// pg_restore, leaving the DB empty with no recovery point. deep-debug H8.
	listCmd := exec.CommandContext(ctx, "pg_restore", "--list", tmpPath)
	var listStderr strings.Builder
	listCmd.Stderr = &limitedStringWriter{w: &listStderr, max: 16 * 1024}
	if err := listCmd.Run(); err != nil {
		stderrTail := strings.TrimSpace(listStderr.String())
		slog.Warn("restore rejected: pg_restore --list could not read the archive (database NOT modified)",
			"err", err, "stderr", stderrTail)
		msg := "upload is not a readable pg_dump custom archive (pg_restore --list failed) — the database was NOT modified"
		if stderrTail != "" {
			msg += ": " + stderrTail
		}
		writeError(w, http.StatusBadRequest, msg)
		return
	}

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
	//   --dbname=DATABASE_URL → connect via libpq URI; pg_restore knows
	//                          this form.
	//
	// Note: --no-publications / --no-subscriptions are applied on the
	// pg_dump side (see Backup) so they never end up in the archive.
	// Applying them here too would be a no-op for archives produced by
	// our Backup, but useful defense-in-depth if an operator restores
	// a dump from a different source — pg_restore doesn't ship those
	// flags consistently across versions, so we rely on the dump-side
	// filter instead.
	restoreCmd := exec.CommandContext(ctx, "pg_restore",
		"--single-transaction",
		"--no-owner",
		"--no-privileges",
		"--no-comments",
		"--dbname="+h.databaseURL,
		tmpPath,
	)
	var restoreStderr strings.Builder
	restoreCmd.Stderr = &limitedStringWriter{w: &restoreStderr, max: 16 * 1024}

	runErr := restoreCmd.Run()
	if runErr != nil {
		stderrTail := strings.TrimSpace(restoreStderr.String())
		slog.Error("restore failed",
			"err", runErr,
			"pg_restore_stderr_tail", stderrTail,
		)
		// The --single-transaction wrapped the whole thing, so on
		// failure the DB is back to the wiped (empty) state. Tell the
		// operator that explicitly so they know to retry.
		msg := "restore failed; database is in wiped state, retry with a valid backup."
		if stderrTail != "" {
			msg += " pg_restore said: " + stderrTail
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
