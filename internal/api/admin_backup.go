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
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/url"
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

// pgConnEnv derives the libpq connection info for pg_dump/psql/pg_restore
// from a postgres:// URL while keeping the password OUT of the command-
// line arguments.
//
// 2026-05-29 audit (MED) — previously we passed the full conninfo
// (postgres://user:PASSWORD@host/db) as an argv element to pg_dump / psql
// / pg_restore. argv is world-readable via `ps` / /proc/<pid>/cmdline, so
// the DB password leaked to any local user for the lifetime of the child
// process. libpq reads the password from the PGPASSWORD environment
// variable instead, which is not exposed in `ps` and (on Linux) is
// root-only via /proc/<pid>/environ.
//
// The fix is intentionally minimal and behavior-preserving: we strip ONLY
// the password from the userinfo of the URL and hand it back via
// PGPASSWORD. Every other connection parameter (host, port, user, dbname,
// sslmode and any other query params) stays in the redacted URL exactly as
// before, so the connection target is unchanged — we are not re-deriving
// each component into a separate PG* variable (which would risk dropping
// sslmode / application_name / etc. on some libpq versions). url.User /
// url.String round-trip preserves percent-encoding of the username.
//
// Returns:
//   - redactedURL: the same conninfo with the password removed from the
//     userinfo. Safe to place on argv.
//   - env: the extra environment entries to append to cmd.Env (a single
//     "PGPASSWORD=..." entry, or nil when the URL carries no password —
//     e.g. .pgpass / peer auth, in which case there is nothing to hide).
//
// If the input does not parse as a URL (e.g. a libpq key=value conninfo
// string, which Aurora does not use), it is returned unchanged with a nil
// env. That preserves the previous behavior for that form rather than
// silently breaking the connection; the URL form that Aurora actually uses
// is fully covered.
func pgConnEnv(databaseURL string) (redactedURL string, env []string) {
	u, err := url.Parse(databaseURL)
	if err != nil || u.User == nil {
		return databaseURL, nil
	}
	password, hasPassword := u.User.Password()
	if !hasPassword {
		// No password embedded in the URL — nothing leaks via argv, so
		// leave it untouched.
		return databaseURL, nil
	}
	// Rebuild the userinfo with the username only; url.String() will
	// re-encode it (and the rest of the URL) correctly.
	redacted := *u
	redacted.User = url.User(u.User.Username())
	return redacted.String(), []string{"PGPASSWORD=" + password}
}

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
	// extendWriteDeadline logs when a wrapper regression makes the
	// extension a no-op (the invisible-truncation class the 2026-07
	// streaming review found); the read-deadline half stays hand-rolled
	// (no shared helper for it yet).
	extendWriteDeadline(w, r, 35*time.Minute, "admin backup")
	if rc := http.NewResponseController(w); rc != nil {
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
	//
	// 2026-05-29 audit (MED): keep the password out of argv. pgConnEnv
	// returns the conninfo with the password stripped (safe for `ps`) plus
	// a PGPASSWORD env entry that libpq reads instead. See pgConnEnv.
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	dumpURL, pgEnv := pgConnEnv(h.databaseURL)
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
		dumpURL,
	)
	// Inherit the process environment and append PGPASSWORD so libpq picks
	// up the credential without it ever appearing on the command line.
	cmd.Env = append(os.Environ(), pgEnv...)

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
// Pipeline (steps 1-2 on the request; 3-4 in a job on the server's
// lifecycle that outlives it, admin_restore_job.go and
// admin_restore_pipeline.go, which answers its progress at
// GET /api/admin/restore/status):
//   1. Validate magic bytes (custom format starts with "PGDMP") before
//      doing anything destructive.
//   2. Stream the upload to a temp file. pg_restore needs a seekable
//      file (custom format has a table of contents it reads first, then
//      jumps around in). We cap the file size at maxRestoreSizeBytes.
//      The request answers 202 here, with the job's status.
//   3. Validate, touching nothing: the client programs' --restrict-key,
//      the archive's table of contents (only entry types that run in a
//      transaction), and a full read (`pg_restore -f /dev/null`).
//   4. In ONE transaction: the per-object wipe that preserves installed
//      extensions (see restoreWipeSQL), then the SQL `pg_restore -f -`
//      makes of the archive with:
//        --no-owner            → skip ALTER OWNER statements
//        --no-privileges       → skip GRANT/REVOKE statements
//        --no-comments         → skip COMMENT ON statements (including the
//                                COMMENT ON EXTENSION lines that require
//                                extension-owner privilege)
//      run by one psql session with ON_ERROR_STOP, and a COMMIT written
//      only once pg_restore has exited 0. Any failure rolls back to the
//      old data.
//
// Why we no longer line-filter the dump (2026-05-18 rearchitecture):
//   The old plain-format + bufio.Scanner filter pipeline could mangle
//   rows that crossed scanner buffer boundaries — pgvector embeddings
//   for example, where a single row spans several KB. The corruption
//   manifested as invalid syntax errors mid-COPY ("0..074918" — a
//   double-dot from a row split mid-number). Custom format is binary
//   and goes straight to pg_restore without our code touching it; the
//   SQL pg_restore makes of it is copied to psql byte for byte (io.Copy),
//   never read line by line.
//
// CRITICAL: Aurora's own pgxpool connections are still pointed at this DB
// and may have cached metadata or prepared statements. After a successful
// restore the operator MUST restart Aurora. The status's message + the UI
// both call this out. We do NOT attempt to restart automatically because
// (a) the restart would forget the restore's in-memory status before the
// admin has read it, (b) the user may want to verify before restarting,
// (c) systemd / process supervision handles this externally.

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
	// 15s ReadTimeout and 120s WriteTimeout would tear down the connection
	// part way through the upload of a large archive (the write deadline
	// counts from the request's headers, so a long upload leaves no time
	// to write the answer). The restore itself no longer runs on this
	// request (see admin_restore_job.go); these cover the upload, up to
	// maxRestoreSizeBytes on a slow link.
	// See the backup handler: write half via the logging helper, read half
	// hand-rolled.
	extendWriteDeadline(w, r, 65*time.Minute, "admin restore")
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetReadDeadline(time.Now().Add(65 * time.Minute))
	}

	// Client programs that cannot run a restore safely (missing, or older
	// than pg_restore --restrict-key) are refused before the upload is read:
	// the job's validation would refuse them anyway, after the whole file.
	if msg := h.restores().tools.missingRestrictSupport(r.Context()); msg != "" {
		writeError(w, http.StatusInternalServerError, msg+" — no restore was started and the database was NOT modified")
		return
	}

	// 2026-05-16 audit H3 — serialize backup/restore operations. See
	// Backup for the rationale. Same mutex — both endpoints share it. It
	// is held from here for the restore job's whole life: once the job has
	// started (handedOff), the job unlocks it when it ends, however it ends.
	if !h.backupRestoreMu.TryLock() {
		writeError(w, http.StatusConflict, "another backup or restore is already in progress; please wait for it to complete")
		return
	}
	handedOff := false
	defer func() {
		if !handedOff {
			h.backupRestoreMu.Unlock()
		}
	}()

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
	// Cleanup on every exit path until the job takes the file: Close
	// (idempotent — sentinel errors after first call) and Remove. defers
	// run LIFO, so Close happens before Remove. The double-close from later
	// f.Close() after copy is harmless (returns ErrClosed which we ignore).
	// Once the job has started it removes the file when it ends.
	defer tmpFile.Close()
	defer func() {
		if !handedOff {
			_ = os.Remove(tmpPath)
		}
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

	// The destructive part runs as a job on the server's lifecycle, not on
	// this request: see admin_restore_job.go. From here the job owns the
	// backup/restore lock and the temp file, and lets both go when it ends.
	st, err := h.restores().Start(h.databaseURL, tmpPath, restoreFileName(part.FileName()), func() {
		_ = os.Remove(tmpPath)
		h.backupRestoreMu.Unlock()
	})
	switch {
	case errors.Is(err, errRestoreRunning):
		writeError(w, http.StatusConflict, "another backup or restore is already in progress; please wait for it to complete")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "failed to start the restore: "+err.Error())
		return
	}
	handedOff = true
	writeJSON(w, http.StatusAccepted, st)
}
