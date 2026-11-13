package api

// Roundtrip test for the Backup → Restore pipeline. Pins the
// rearchitecture from 2026-05-18 (pg_dump custom format + pg_restore)
// against the regressions it eliminates:
//
//   - Vector-row corruption from line-based filtering (the "0..074918"
//     double-dot bug). A 768-dim embedding survives the roundtrip
//     byte-for-byte.
//   - Extension-privilege failures. The dump contains CREATE/COMMENT/
//     ALTER EXTENSION statements that the unprivileged Aurora role
//     can't execute; pg_restore's --no-comments flag skips them.
//
// Opt-in: set TEST_BACKUP_DATABASE_URL=postgres://... to run. The test
// is DESTRUCTIVE (it wipes and re-restores the schema) so it uses a
// dedicated env var, not the TEST_DATABASE_URL used by non-destructive
// integration tests. Point this at a throw-away database.
//
// Required system state on the test runner:
//   - pg_dump + pg_restore on $PATH (same major version as the DB)
//   - the target DB is pre-migrated (run aurora once or apply
//     migrations/*.up.sql manually) so pg_trgm + vector extensions
//     are installed
//
// When either env var or binaries are missing the test t.Skip()s so
// the standard unit-test suite stays standalone.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// requireBackupTestDB returns a pool against TEST_BACKUP_DATABASE_URL,
// or skips the test if the env var is unset or pg_dump/pg_restore
// aren't installed. Tests share this helper rather than open-coding the
// skip pattern.
func requireBackupTestDB(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	dbURL := os.Getenv("TEST_BACKUP_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_BACKUP_DATABASE_URL not set; skipping destructive backup roundtrip test")
	}
	for _, bin := range []string{"pg_dump", "pg_restore", "psql"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH; skipping", bin)
		}
	}
	// The restore needs pg_restore --restrict-key (admin_restore_pipeline.go).
	if msg := (restoreTools{}).ready(context.Background()); msg != "" {
		t.Skip(msg)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping test db: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, dbURL
}

// seedRow holds the fixture row we round-trip. Captures all the
// failure modes we care about: a pgvector embedding (the corruption
// site), a string (basic data), and a foreign-key chain that proves
// the dependent rows come back too.
type seedRow struct {
	userID    int64
	libraryID int64
	mediaID   int64
	title     string
	embedding string // pgvector text format: "[0.1,0.2,...]"
}

// seedTestData inserts a user → library → media_item chain with a
// representative 768-dim embedding. Returns the IDs so the assertion
// step can locate the rows.
func seedTestData(t *testing.T, pool *pgxpool.Pool) seedRow {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Build a representative 768-dim vector (Phase E2 embeddinggemma size). Real
	// embeddings have negative, positive, and zero values with varying
	// magnitudes — emulate that so the test exercises the same code paths a real
	// embedding output would.
	var sb bytes.Buffer
	sb.WriteByte('[')
	for i := 0; i < 768; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		// Mix of negatives, positives, small-magnitude values.
		v := float64(i%17-8) * 0.0123456
		fmt.Fprintf(&sb, "%.6f", v)
	}
	sb.WriteByte(']')
	embedding := sb.String()

	title := "Aurora Roundtrip Test Movie " + time.Now().UTC().Format("20060102T150405")

	var row seedRow
	row.title = title
	row.embedding = embedding

	// Unique username/email per run so the test is idempotent against
	// half-cleaned state. To the nanosecond: several tests seed within the
	// same second.
	suffix := time.Now().UTC().Format("20060102150405.000000000")
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash, role)
		 VALUES ($1, $2, 'x', 'admin')
		 RETURNING id`,
		"roundtrip_"+suffix, "roundtrip_"+suffix+"@example.com",
	).Scan(&row.userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	if err := pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, owner_id)
		 VALUES ('Roundtrip', 'movie', ARRAY['/tmp/roundtrip'], $1)
		 RETURNING id`,
		row.userID,
	).Scan(&row.libraryID); err != nil {
		t.Fatalf("insert library: %v", err)
	}

	if err := pool.QueryRow(ctx,
		`INSERT INTO media_items (library_id, type, title, sort_title, embedding)
		 VALUES ($1, 'movie', $2, $2, $3::vector)
		 RETURNING id`,
		row.libraryID, title, embedding,
	).Scan(&row.mediaID); err != nil {
		t.Fatalf("insert media_item with embedding: %v — this is the regression we're guarding against", err)
	}

	return row
}

// callBackup invokes the Backup handler through httptest and returns
// the raw response body. Mimics what the browser receives.
func callBackup(t *testing.T, dbURL string) []byte {
	t.Helper()
	h := &AdminHandler{databaseURL: dbURL}

	req := httptest.NewRequest(http.MethodGet, "/api/admin/backup", nil)
	rec := httptest.NewRecorder()
	h.Backup(rec, req)

	res := rec.Result()
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("Backup returned %d: %s", res.StatusCode, string(body))
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read backup body: %v", err)
	}
	if len(body) < 5 || !bytes.Equal(body[:5], []byte("PGDMP")) {
		head := body
		if len(head) > 32 {
			head = head[:32]
		}
		t.Fatalf("Backup output is not a pg_dump custom archive; first 32 bytes: %q", head)
	}
	// Defense-in-depth: if pg_dump fails mid-stream, Backup logs and
	// returns mid-response without sending an HTTP error (headers
	// were already written). The client sees a truncated dump that
	// still starts with PGDMP. Catch this here so a regression in
	// the backup pipeline can't masquerade as a "valid" archive that
	// fails opaquely later in restore.
	//
	// A real Aurora dump with our test fixture (1 user + 1 library
	// + 1 media_item + the schema migrations + extension data) is
	// always > 1 KB. Below that, something went wrong before
	// pg_dump finished emitting the TOC.
	if len(body) < 1024 {
		t.Fatalf("Backup output suspiciously short (%d bytes) — pg_dump likely failed mid-stream "+
			"and the response was truncated. Check the server log for the pg_dump stderr.", len(body))
	}
	return body
}

// callRestore invokes the Restore handler with the given dump bytes
// as a multipart upload (matching the production API contract).
func callRestore(t *testing.T, dbURL string, dump []byte) {
	t.Helper()
	h := &AdminHandler{databaseURL: dbURL}

	// Build a multipart body identical to what the browser POSTs.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("backup", "test.dump")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := fw.Write(dump); err != nil {
		t.Fatalf("write dump to form: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.Restore(rec, req)

	res := rec.Result()
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("Restore returned %d: %s", res.StatusCode, string(body))
	}
}

// TestBackupRestoreRoundtrip — the canonical regression test for the
// 2026-05-18 rearchitecture. Inserts a row with a 768-dim vector,
// backs up, deletes the row, restores, verifies the row is back with
// the original embedding intact.
func TestBackupRestoreRoundtrip(t *testing.T) {
	pool, dbURL := requireBackupTestDB(t)

	seed := seedTestData(t, pool)

	// Step 1 — backup the current DB to memory.
	dump := callBackup(t, dbURL)
	t.Logf("captured %d-byte dump (starts with %q)", len(dump), dump[:5])

	// Step 2 — perturb the DB so the restore has something to fix.
	// Deleting the media_item is enough; the restore should put it back.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := pool.Exec(ctx, `DELETE FROM media_items WHERE id = $1`, seed.mediaID); err != nil {
		t.Fatalf("perturb media_items: %v", err)
	}

	// Step 3 — restore. The Restore handler wipes the schema first,
	// then pg_restore replays the dump. The seeded row must come back.
	callRestore(t, dbURL, dump)

	// Aurora's pgxpool may have cached connection state through the
	// wipe + restore. Force a fresh pool for the verification queries
	// so we observe the post-restore state, not a cached pre-wipe one.
	pool.Close()
	freshCtx, freshCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer freshCancel()
	freshPool, err := pgxpool.New(freshCtx, dbURL)
	if err != nil {
		t.Fatalf("reconnect after restore: %v", err)
	}
	defer freshPool.Close()

	// Step 4 — verify the seeded data round-tripped intact.
	var (
		gotTitle     string
		gotEmbedding string
	)
	if err := freshPool.QueryRow(ctx,
		`SELECT title, embedding::text FROM media_items WHERE id = $1`,
		seed.mediaID,
	).Scan(&gotTitle, &gotEmbedding); err != nil {
		t.Fatalf("read restored media_item: %v", err)
	}
	if gotTitle != seed.title {
		t.Errorf("title mismatch:\n  want: %q\n  got:  %q", seed.title, gotTitle)
	}
	assertVectorEqual(t, seed.embedding, gotEmbedding)

	// User + library should also still be there (proves the dependent
	// rows from the FK chain round-tripped).
	var userCount, libCount int
	if err := freshPool.QueryRow(ctx,
		`SELECT count(*) FROM users WHERE id = $1`, seed.userID,
	).Scan(&userCount); err != nil {
		t.Fatalf("read restored user: %v", err)
	}
	if userCount != 1 {
		t.Errorf("expected restored user, got count=%d", userCount)
	}
	if err := freshPool.QueryRow(ctx,
		`SELECT count(*) FROM libraries WHERE id = $1`, seed.libraryID,
	).Scan(&libCount); err != nil {
		t.Fatalf("read restored library: %v", err)
	}
	if libCount != 1 {
		t.Errorf("expected restored library, got count=%d", libCount)
	}
}

// assertVectorEqual compares two pgvector text representations
// ("[x,y,z,...]") element-by-element with a small float tolerance.
//
// Why not bytes.Equal? pgvector's text serialization is stable today
// but isn't a formal contract — a future upgrade could legitimately
// change "0.012345" to "0.0123450" or use exponent form. The roundtrip
// guarantee that actually matters is "numerically the same vector,"
// not "byte-identical string." Tolerance check makes the test robust
// to that. The vector-corruption bug we're guarding against ("0..074918")
// is detected by parse failure, not byte comparison.
func assertVectorEqual(t *testing.T, want, got string) {
	t.Helper()
	wantVec, err := parsePgVector(want)
	if err != nil {
		t.Fatalf("parse want embedding: %v", err)
	}
	gotVec, err := parsePgVector(got)
	if err != nil {
		// Parse failure on the restored side is the actual signature
		// of the corruption regression — surface it explicitly.
		t.Fatalf("restored embedding doesn't parse as pgvector — corruption regression? err=%v, raw=%q", err, got)
	}
	if len(wantVec) != len(gotVec) {
		t.Fatalf("embedding dim mismatch: want=%d got=%d", len(wantVec), len(gotVec))
	}
	const tolerance = 1e-6
	for i := range wantVec {
		diff := math.Abs(float64(wantVec[i] - gotVec[i]))
		if diff > tolerance {
			t.Errorf("embedding[%d] diverges: want=%v got=%v (delta=%v)",
				i, wantVec[i], gotVec[i], diff)
			if i > 5 {
				// Only first few divergences are useful; bail.
				break
			}
		}
	}
}

// parsePgVector parses pgvector's "[x,y,z,...]" text form into a
// []float32. Strict parse: returns an error if any element fails to
// parse as a float. This is the canonical regression detector — the
// "0..074918" corruption from the old line-filter pipeline would
// fail strconv.ParseFloat here.
func parsePgVector(s string) ([]float32, error) {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '[' || s[len(s)-1] != ']' {
		return nil, fmt.Errorf("not a pgvector text form (expected [x,y,...]): %q", s)
	}
	inner := s[1 : len(s)-1]
	if inner == "" {
		return nil, nil
	}
	parts := strings.Split(inner, ",")
	out := make([]float32, len(parts))
	for i, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 32)
		if err != nil {
			return nil, fmt.Errorf("element %d (%q): %w", i, p, err)
		}
		out[i] = float32(v)
	}
	return out, nil
}

// TestBackupRestoreRoundtripMultiRow — guards against silent partial
// data loss that a single-row test would miss. Inserts 50 media_items,
// each with a unique embedding. After the roundtrip, all 50 must be
// present with their embeddings parseable and matching by ID.
//
// Why this matters: if any future regression in the pipeline silently
// drops some rows from a COPY block (the original line-filter bug had
// exactly this failure mode for rows whose first column happened to
// match an extension-DDL prefix), a single-row test passes but multi-
// row catches it.
func TestBackupRestoreRoundtripMultiRow(t *testing.T) {
	pool, dbURL := requireBackupTestDB(t)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Seed: user + library + 50 media_items with distinct embeddings.
	suffix := time.Now().UTC().Format("20060102150405") + "_multi"
	var userID, libID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (username, email, password_hash, role)
		 VALUES ($1, $2, 'x', 'admin') RETURNING id`,
		"multi_"+suffix, "multi_"+suffix+"@example.com",
	).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`INSERT INTO libraries (name, type, paths, owner_id)
		 VALUES ('MultiRow', 'movie', ARRAY['/tmp/multi'], $1) RETURNING id`,
		userID,
	).Scan(&libID); err != nil {
		t.Fatalf("insert library: %v", err)
	}

	const nRows = 50
	type rowFixture struct {
		id    int64
		title string
		embed string
	}
	fixtures := make([]rowFixture, 0, nRows)
	for i := 0; i < nRows; i++ {
		// Distinct embedding per row so order-swap regressions also fail.
		var sb bytes.Buffer
		sb.WriteByte('[')
		for j := 0; j < 768; j++ {
			if j > 0 {
				sb.WriteByte(',')
			}
			v := float64((i+1)*(j+1)%97-48) * 0.0011111
			fmt.Fprintf(&sb, "%.6f", v)
		}
		sb.WriteByte(']')
		title := fmt.Sprintf("MultiRow Test %03d (%s)", i, suffix)
		var id int64
		if err := pool.QueryRow(ctx,
			`INSERT INTO media_items (library_id, type, title, sort_title, embedding)
			 VALUES ($1, 'movie', $2, $2, $3::vector) RETURNING id`,
			libID, title, sb.String(),
		).Scan(&id); err != nil {
			t.Fatalf("insert media_item %d: %v", i, err)
		}
		fixtures = append(fixtures, rowFixture{id: id, title: title, embed: sb.String()})
	}

	// Backup → wipe → restore.
	dump := callBackup(t, dbURL)
	if _, err := pool.Exec(ctx,
		`DELETE FROM media_items WHERE library_id = $1`, libID,
	); err != nil {
		t.Fatalf("perturb media_items: %v", err)
	}
	callRestore(t, dbURL, dump)

	pool.Close()
	freshPool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("reconnect after restore: %v", err)
	}
	defer freshPool.Close()

	// Every fixture must come back, with its embedding parseable.
	var restoredCount int
	if err := freshPool.QueryRow(ctx,
		`SELECT count(*) FROM media_items WHERE library_id = $1`, libID,
	).Scan(&restoredCount); err != nil {
		t.Fatalf("count restored rows: %v", err)
	}
	if restoredCount != nRows {
		t.Fatalf("multi-row restore: expected %d rows, got %d — silent data loss?", nRows, restoredCount)
	}

	// Spot-check every row's embedding for parse-ability + content.
	for _, f := range fixtures {
		var gotTitle, gotEmbedding string
		if err := freshPool.QueryRow(ctx,
			`SELECT title, embedding::text FROM media_items WHERE id = $1`,
			f.id,
		).Scan(&gotTitle, &gotEmbedding); err != nil {
			t.Errorf("read row id=%d: %v", f.id, err)
			continue
		}
		if gotTitle != f.title {
			t.Errorf("row id=%d title mismatch: want=%q got=%q", f.id, f.title, gotTitle)
		}
		assertVectorEqual(t, f.embed, gotEmbedding)
	}
}

// TestRestoreRejectsLegacyGzipUpload — operator-friendly error message
// when someone uploads an old .sql.gz backup to the new restore
// endpoint. Should fail fast (before wiping the DB) with a hint at the
// shell-based workaround.
func TestRestoreRejectsLegacyGzipUpload(t *testing.T) {
	_, dbURL := requireBackupTestDB(t)

	// gzip magic bytes (0x1F 0x8B) + arbitrary payload.
	gz := []byte{0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00}

	h := &AdminHandler{databaseURL: dbURL}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("backup", "legacy.sql.gz")
	_, _ = fw.Write(gz)
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.Restore(rec, req)

	res := rec.Result()
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for gzip upload, got %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if !bytes.Contains(body, []byte("legacy")) || !bytes.Contains(body, []byte("psql")) {
		t.Errorf("expected error body to mention 'legacy' + 'psql' workaround, got: %s", body)
	}
}

// TestRestoreRejectsTinyValidPrefix — a 5-byte exact "PGDMP" upload
// (or any upload <256 bytes) passes magic-byte validation but is too
// small to be a real archive. The handler must reject it BEFORE
// running the destructive wipe; otherwise a malformed upload would
// leave the DB empty.
//
// Robust against test-ordering pitfalls: we insert a sentinel row
// in `users` BEFORE the call. If the wipe ran, the sentinel is gone
// regardless of what prior tests did to the schema. If the schema
// is broken at the start (e.g., a prior test died), the sentinel
// insert itself fails, and t.Fatal points the operator at the
// real cause rather than blaming the handler.
func TestRestoreRejectsTinyValidPrefix(t *testing.T) {
	pool, dbURL := requireBackupTestDB(t)

	// Seed the sentinel. If this insert fails, the DB is in a state
	// the test can't reason about (most likely: a prior test crashed
	// mid-restore).
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	suffix := time.Now().UTC().Format("20060102150405.000000")
	sentinelUsername := "tiny_sentinel_" + suffix
	if _, err := pool.Exec(ctx,
		// $1 is cast once: used bare as the username and inside the
		// concatenation, Postgres deduced two types for it (42P08) and the
		// test never reached the handler.
		`INSERT INTO users (username, email, password_hash, role)
		 VALUES ($1::text, $1::text || '@example.com', 'x', 'admin')`,
		sentinelUsername,
	); err != nil {
		t.Fatalf("insert sentinel — DB schema is in an inconsistent state, not this handler's fault: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM users WHERE username = $1`, sentinelUsername)
	})

	// Just the magic bytes — passes the format check, fails the size check.
	tiny := []byte("PGDMP")

	h := &AdminHandler{databaseURL: dbURL}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("backup", "tiny.dump")
	_, _ = fw.Write(tiny)
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.Restore(rec, req)

	res := rec.Result()
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for tiny upload, got %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if !bytes.Contains(body, []byte("too small")) {
		t.Errorf("expected error body to mention 'too small', got: %s", body)
	}
	// The wipe must NOT have run. The sentinel survives iff the size
	// check ran BEFORE the destructive wipe — exactly the ordering
	// we're guarding against regressing.
	var sentinelCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM users WHERE username = $1`, sentinelUsername,
	).Scan(&sentinelCount); err != nil {
		t.Fatalf("probe sentinel: %v", err)
	}
	if sentinelCount != 1 {
		t.Fatal("sentinel row missing after tiny-upload rejection — the destructive wipe ran before the size check. This is the ordering bug BH2 was supposed to fix.")
	}
}

// TestPgConnEnv pins the 2026-05-29 (MED) fix that keeps the DB password
// out of pg_dump/psql/pg_restore argv. pgConnEnv must (a) strip the
// password from the conninfo it returns for argv, and (b) hand that
// password back via a PGPASSWORD env entry — while leaving every other
// connection parameter (host, port, user, dbname, sslmode, etc.) intact.
func TestPgConnEnv(t *testing.T) {
	tests := []struct {
		name        string
		in          string
		wantURL     string // exact redacted conninfo expected on argv
		wantEnv     []string
		wantNoPwArg bool // redacted URL must not contain the secret
	}{
		{
			name:        "full uri with password",
			in:          "postgres://aurora:s3cr3t@db.example.com:5432/aurora?sslmode=require",
			wantURL:     "postgres://aurora@db.example.com:5432/aurora?sslmode=require",
			wantEnv:     []string{"PGPASSWORD=s3cr3t"},
			wantNoPwArg: true,
		},
		{
			name:        "postgresql scheme alias",
			in:          "postgresql://u:p@h/d",
			wantURL:     "postgresql://u@h/d",
			wantEnv:     []string{"PGPASSWORD=p"},
			wantNoPwArg: true,
		},
		{
			// Password with URL-special characters must round-trip
			// through PGPASSWORD verbatim (decoded), and the redacted
			// URL must not leak it.
			name:        "password with special chars is percent-decoded in env",
			in:          "postgres://user:p%40ss%2Fword%3A@host:5432/db",
			wantURL:     "postgres://user@host:5432/db",
			wantEnv:     []string{"PGPASSWORD=p@ss/word:"},
			wantNoPwArg: true,
		},
		{
			// No password embedded → nothing to hide, URL unchanged,
			// no env override.
			name:    "user only, no password",
			in:      "postgres://aurora@db.example.com/aurora",
			wantURL: "postgres://aurora@db.example.com/aurora",
			wantEnv: nil,
		},
		{
			// No userinfo at all (user comes from PGUSER/env).
			name:    "no userinfo",
			in:      "postgres://db.example.com/aurora",
			wantURL: "postgres://db.example.com/aurora",
			wantEnv: nil,
		},
		{
			// Not a URL (libpq key=value conninfo) — returned unchanged
			// rather than mangled. Aurora doesn't use this form, but the
			// fallback must be safe.
			name:    "non-url conninfo passthrough",
			in:      "host=db.example.com user=aurora password=s3cr3t dbname=aurora",
			wantURL: "host=db.example.com user=aurora password=s3cr3t dbname=aurora",
			wantEnv: nil,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotURL, gotEnv := pgConnEnv(tc.in)
			if gotURL != tc.wantURL {
				t.Errorf("redacted URL:\n  want %q\n  got  %q", tc.wantURL, gotURL)
			}
			if len(gotEnv) != len(tc.wantEnv) {
				t.Fatalf("env len: want %v, got %v", tc.wantEnv, gotEnv)
			}
			for i := range tc.wantEnv {
				if gotEnv[i] != tc.wantEnv[i] {
					t.Errorf("env[%d]: want %q, got %q", i, tc.wantEnv[i], gotEnv[i])
				}
			}
			if tc.wantNoPwArg {
				// The whole point: the secret must never appear on argv.
				if strings.Contains(gotURL, "s3cr3t") ||
					strings.Contains(gotURL, "p@ss") ||
					strings.Contains(gotURL, "p%40ss") ||
					strings.Contains(gotURL, ":p@") {
					t.Errorf("redacted URL still contains the password: %q", gotURL)
				}
			}
		})
	}
}

// TestRestoreRejectsRandomGarbage — non-pg_dump uploads should fail
// fast with a clear "expected PGDMP" message rather than crashing
// pg_restore mid-stream.
func TestRestoreRejectsRandomGarbage(t *testing.T) {
	_, dbURL := requireBackupTestDB(t)

	garbage := bytes.Repeat([]byte("not a backup"), 20)

	h := &AdminHandler{databaseURL: dbURL}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("backup", "garbage.bin")
	_, _ = fw.Write(garbage)
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.Restore(rec, req)

	res := rec.Result()
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for garbage upload, got %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if !bytes.Contains(body, []byte("PGDMP")) {
		t.Errorf("expected error body to mention 'PGDMP' magic, got: %s", body)
	}
}

// restoreFixture is a seeded database, a backup of it, and then a change the
// backup does not have: the seeded media item deleted and a library added that
// only the live database holds. A restore that committed brings the first back
// and drops the second; one that rolled back leaves both as they were.
type restoreFixture struct {
	dbURL     string
	pool      *pgxpool.Pool
	seed      seedRow
	dump      []byte
	liveOnly  string // a library name only the live database has
	tables    int    // public tables before the restore
	h         *AdminHandler
	realPgRst string
}

func newRestoreFixture(t *testing.T) *restoreFixture {
	t.Helper()
	pool, dbURL := requireBackupTestDB(t)
	f := &restoreFixture{dbURL: dbURL, pool: pool, seed: seedTestData(t, pool)}
	f.dump = callBackup(t, dbURL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := pool.Exec(ctx, `DELETE FROM media_items WHERE id = $1`, f.seed.mediaID); err != nil {
		t.Fatalf("delete the seeded item: %v", err)
	}
	f.liveOnly = "live-only " + time.Now().UTC().Format("150405.000000000")
	if _, err := pool.Exec(ctx, `INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1, 'movie', ARRAY['/tmp/live-only'], $2)`,
		f.liveOnly, f.seed.userID); err != nil {
		t.Fatalf("insert the live-only library: %v", err)
	}
	f.tables = f.publicTables(t)
	real, err := exec.LookPath("pg_restore")
	if err != nil {
		t.Skip("pg_restore not on PATH")
	}
	f.realPgRst = real
	f.h = &AdminHandler{databaseURL: dbURL}
	return f
}

// start runs the real Restore handler with the fixture's dump on its own
// goroutine: done is closed when the handler returns (at the restore's end,
// or when ctx, the request's, ends).
func (f *restoreFixture) start(t *testing.T, ctx context.Context) (rec *httptest.ResponseRecorder, done chan struct{}) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("backup", "roundtrip.dump")
	if err != nil {
		t.Fatalf("form file: %v", err)
	}
	_, _ = fw.Write(f.dump)
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", &buf).WithContext(ctx)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec = httptest.NewRecorder()
	done = make(chan struct{})
	go func() {
		defer close(done)
		f.h.Restore(rec, req)
	}()
	return rec, done
}

// ended waits until the record says the restore has ended, and answers it.
func (f *restoreFixture) ended(t *testing.T) RestoreStatus {
	t.Helper()
	deadline := time.Now().Add(2 * time.Minute)
	for {
		st := f.h.restores.status()
		if st.State == restoreStateSucceeded || st.State == restoreStateFailed {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("the restore did not end; record %+v", st)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f *restoreFixture) query(t *testing.T, ctx context.Context, sql string, args ...any) int {
	t.Helper()
	pool, err := pgxpool.New(ctx, f.dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	var n int
	if err := pool.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func (f *restoreFixture) publicTables(t *testing.T) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return f.query(t, ctx, `SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public'`)
}

// assertOldData fails unless the database is as it was before the restore:
// every table there, the seeded item still gone, the live-only row still in.
func (f *restoreFixture) assertOldData(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if got := f.publicTables(t); got != f.tables {
		t.Errorf("public tables after the failed restore: %d, want %d as before", got, f.tables)
	}
	if n := f.query(t, ctx, `SELECT count(*)::int FROM media_items WHERE id = $1`, f.seed.mediaID); n != 0 {
		t.Errorf("the seeded item, deleted after the backup, is back (%d): the restore committed", n)
	}
	if n := f.query(t, ctx, `SELECT count(*)::int FROM libraries WHERE name = $1`, f.liveOnly); n != 1 {
		t.Errorf("the live-only library: %d rows, want 1: the old data is not intact", n)
	}
	if n := f.query(t, ctx, `SELECT count(*)::int FROM users WHERE id = $1`, f.seed.userID); n != 1 {
		t.Errorf("the seeded user: %d rows, want 1", n)
	}
}

// assertRestored fails unless the backup's data is what the database holds.
func (f *restoreFixture) assertRestored(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if n := f.query(t, ctx, `SELECT count(*)::int FROM media_items WHERE id = $1`, f.seed.mediaID); n != 1 {
		t.Errorf("the seeded item after the restore: %d rows, want 1", n)
	}
	if n := f.query(t, ctx, `SELECT count(*)::int FROM libraries WHERE name = $1`, f.liveOnly); n != 0 {
		t.Errorf("the live-only library after the restore: %d rows, want 0", n)
	}
}

// failedUnchanged fails unless the record says the restore failed in its
// transaction with the database unchanged.
func failedUnchanged(t *testing.T, st RestoreStatus) {
	t.Helper()
	if st.State != restoreStateFailed || st.Step != string(restoreStepRestoring) || st.Database != restoreDBUnchanged ||
		!strings.Contains(st.Message, "NOT modified") {
		t.Fatalf("record %+v, want failed in restoring with the database unchanged", st)
	}
}

// wrapPgRestore writes a stand-in for pg_restore that runs the real one for
// everything but the restore's stream (`-f -`), and for that runs body, a
// bash fragment with $REAL, "$@" and $KEY (the --restrict-key) set.
func (f *restoreFixture) wrapPgRestore(t *testing.T, body string) {
	t.Helper()
	script := "#!/bin/bash\nREAL='" + f.realPgRst + "'\nstreaming=\nKEY=\n" +
		"for a in \"$@\"; do case \"$a\" in -) streaming=1 ;; --restrict-key=*) KEY=\"${a#--restrict-key=}\" ;; esac; done\n" +
		"if [ -z \"$streaming\" ]; then exec \"$REAL\" \"$@\"; fi\n" + body + "\n"
	path := filepath.Join(t.TempDir(), "pg_restore")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write the pg_restore stand-in: %v", err)
	}
	f.h.restoreTools.pgRestore = path
}

// wrapPsql writes a stand-in for psql that runs body, a bash fragment with
// $REAL set to the real psql and "$@" its arguments.
func (f *restoreFixture) wrapPsql(t *testing.T, body string) {
	t.Helper()
	real, err := exec.LookPath("psql")
	if err != nil {
		t.Skip("psql not on PATH")
	}
	path := filepath.Join(t.TempDir(), "psql")
	if err := os.WriteFile(path, []byte("#!/bin/bash\nREAL='"+real+"'\n"+body+"\n"), 0o755); err != nil {
		t.Fatalf("write the psql stand-in: %v", err)
	}
	f.h.restoreTools.psql = path
}

// pauseAtFirstCopy makes the stream stop for secs seconds at its first COPY:
// the wipe has run, so the transaction holds its locks, and nothing has
// committed.
func (f *restoreFixture) pauseAtFirstCopy(t *testing.T, secs int) {
	f.wrapPgRestore(t, `"$REAL" "$@" | awk -v secs=`+strconv.Itoa(secs)+` '{print} !d && /^COPY / {fflush(); system("sleep " secs); d=1}'
exit ${PIPESTATUS[0]}`)
}

// waitForTheLock waits until the restore's psql holds an ACCESS EXCLUSIVE lock
// on the table whose oid is given: its transaction has dropped it.
func (f *restoreFixture) waitForTheLock(t *testing.T, oid uint32) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		n := f.query(t, ctx, `SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
			WHERE a.application_name = $1 AND l.relation = $2 AND l.mode = 'AccessExclusiveLock' AND l.granted`,
			restoreAppName, oid)
		cancel()
		if n > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("the restore's transaction never held the lock; record %+v", f.h.restores.status())
}

func (f *restoreFixture) mediaItemsOID(t *testing.T) uint32 {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return uint32(f.query(t, ctx, `SELECT 'public.media_items'::regclass::oid::int`))
}

// restoreHoldsLocks reports whether the restore's database session still
// holds a lock.
func (f *restoreFixture) restoreHoldsLocks(t *testing.T) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return f.query(t, ctx, `SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
		WHERE a.application_name = $1`, restoreAppName) > 0
}

// TestARestoreWhoseClientLeavesStillLandsInTheDatabase is the regression
// test for the restore that died with its request, against a real database
// and the real psql and pg_restore: the client goes while the restore's
// transaction holds its locks (a reload, a closed tab), which used to kill
// pg_restore and leave the database empty. The restore must still land the
// backup, and the ticket must read how it went.
func TestARestoreWhoseClientLeavesStillLandsInTheDatabase(t *testing.T) {
	f := newRestoreFixture(t)
	f.pauseAtFirstCopy(t, 3)
	oid := f.mediaItemsOID(t)
	reqCtx, leave := context.WithCancel(context.Background())
	defer leave()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("backup", "left-behind.dump")
	_, _ = fw.Write(f.dump)
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/admin/restore", &buf).WithContext(reqCtx)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	ticket := strings.Repeat("t", 43)
	req.Header.Set(restoreTicketHeader, ticket)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); f.h.Restore(rec, req) }()

	// The transaction holds its locks: the client goes.
	f.waitForTheLock(t, oid)
	leave()
	<-done
	if rec.Code != 499 {
		t.Fatalf("the handler answered %d after its client left, want 499", rec.Code)
	}
	st := f.ended(t)
	if st.State != restoreStateSucceeded || st.Database != restoreDBRestored || st.File != "left-behind.dump" {
		t.Fatalf("the restore whose client left: %+v, want succeeded", st)
	}
	if tst, ok := f.h.restores.statusForTicket(ticket); !ok || tst.State != restoreStateSucceeded {
		t.Fatalf("the ticket read: %+v, %v", tst, ok)
	}
	f.assertRestored(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, f.dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	var gotTitle, gotEmbedding string
	if err := pool.QueryRow(ctx, `SELECT title, embedding::text FROM media_items WHERE id = $1`, f.seed.mediaID).Scan(&gotTitle, &gotEmbedding); err != nil {
		t.Fatalf("read restored media_item: %v", err)
	}
	if gotTitle != f.seed.title {
		t.Errorf("title %q, want %q", gotTitle, f.seed.title)
	}
	assertVectorEqual(t, f.seed.embedding, gotEmbedding)
}

// TestAReadDuringTheRestoreWaitsAndThenSeesTheNewData: while the transaction
// runs it holds an ACCESS EXCLUSIVE lock on every table it dropped, so another
// connection's read of one waits rather than failing ("relation does not
// exist" was the separate wipe's answer) until the restore ends. A read still
// waiting at the COMMIT is ended with every other waiting session (its request
// may write next, with what it read before; see
// TestAWriteWaitingOnTheRestoreIsEndedRatherThanLandingInTheRestoredData),
// and a read after the restore sees the backup's rows.
func TestAReadDuringTheRestoreWaitsAndThenSeesTheNewData(t *testing.T) {
	f := newRestoreFixture(t)
	f.pauseAtFirstCopy(t, 4)
	oid := f.mediaItemsOID(t)
	_, done := f.start(t, context.Background())
	f.waitForTheLock(t, oid)

	type answer struct {
		n   int
		err error
	}
	read := make(chan answer, 1)
	readCtx, cancelRead := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancelRead()
	reader, err := pgxpool.New(readCtx, f.dbURL)
	if err != nil {
		t.Fatalf("connect the reader: %v", err)
	}
	defer reader.Close()
	go func() {
		var n int
		err := reader.QueryRow(readCtx, `SELECT count(*)::int FROM media_items WHERE id = $1 /* restore-reader-probe */`, f.seed.mediaID).Scan(&n)
		read <- answer{n, err}
	}()
	// The read is waiting on the restore's lock, not failing.
	deadline := time.Now().Add(10 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		n := f.query(t, ctx, `SELECT count(*)::int FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%restore-reader-probe%' AND pid <> pg_backend_pid()`)
		cancel()
		if n > 0 {
			break
		}
		select {
		case a := <-read:
			t.Fatalf("the read answered during the restore (%d, %v); it should wait for the transaction", a.n, a.err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("the read never waited on the restore's lock")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// While it runs, the record says the database is unchanged: nothing is
	// committed.
	if st := f.h.restores.status(); st.State != restoreStateRunning || st.Step != string(restoreStepRestoring) || st.Database != restoreDBUnchanged {
		t.Errorf("the record mid-transaction: %+v", st)
	}
	a := <-read
	var pgErr *pgconn.PgError
	if a.err == nil || !errors.As(a.err, &pgErr) || pgErr.Code != "57P01" {
		t.Fatalf("the read still waiting at the COMMIT answered %d, %v; want it ended (57P01)", a.n, a.err)
	}
	<-done
	if st := f.ended(t); st.State != restoreStateSucceeded {
		t.Fatalf("record %+v", st)
	}
	// A read now sees the backup's rows.
	f.assertRestored(t)
}

// TestARestoreIsNeverCommittedUnlessPgRestoreSucceeded pins the guard. The
// stand-in pg_restore writes a stream that looks whole (it stops at the end
// of a COPY block and ends with its \unrestrict) and then exits 1. psql could
// run a COMMIT after it; only our refusal to write one keeps the partial load
// (the old tables wiped, one table loaded) from committing.
func TestARestoreIsNeverCommittedUnlessPgRestoreSucceeded(t *testing.T) {
	f := newRestoreFixture(t)
	f.wrapPgRestore(t, `"$REAL" "$@" | awk '{print} /^\\\.$/ {exit}'
printf '\n\\unrestrict %s\n' "$KEY"
exit 1`)
	rec, done := f.start(t, context.Background())
	<-done
	st := f.ended(t)
	failedUnchanged(t, st)
	if !strings.Contains(st.Message, "pg_restore failed") || rec.Code != http.StatusInternalServerError {
		t.Errorf("answer %d, message %q; want a 500 naming pg_restore's failure", rec.Code, st.Message)
	}
	f.assertOldData(t)
}

// TestARestoreWhosePgRestoreIsKilledMidStreamLeavesTheOldData: pg_restore
// killed part way through a COPY. The separate wipe left the database empty
// here.
func TestARestoreWhosePgRestoreIsKilledMidStreamLeavesTheOldData(t *testing.T) {
	f := newRestoreFixture(t)
	f.wrapPgRestore(t, `"$REAL" "$@" | awk '{print} /^COPY / {c=1} c && ++n > 2 {exit}'
kill -KILL $$`)
	_, done := f.start(t, context.Background())
	<-done
	failedUnchanged(t, f.ended(t))
	f.assertOldData(t)
}

// TestALockTimeoutAbortsTheRestoreAndKeepsTheOldData: an open transaction
// elsewhere holds a lock the wipe needs. Past the lock timeout the restore
// fails, and since its transaction never committed, safely: the old data
// stays and the admins stay signed in. The cause named is psql's (the lock
// timeout), not pg_restore's death that followed it, and psql's output comes
// before pg_restore's (the stand-in writes a screenful of its own first),
// since the Admin page shows only the start of the message.
func TestALockTimeoutAbortsTheRestoreAndKeepsTheOldData(t *testing.T) {
	f := newRestoreFixture(t)
	f.h.restoreTools.lockTimeout = time.Second
	f.wrapPgRestore(t, `for i in $(seq 1 20); do echo "pg_restore: warning: stand-in noise $i" >&2; done
exec "$REAL" "$@"`)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	holder, err := pgxpool.New(ctx, f.dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer holder.Close()
	tx, err := holder.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx, `LOCK TABLE users IN ACCESS SHARE MODE`); err != nil {
		t.Fatalf("lock users: %v", err)
	}
	_, done := f.start(t, context.Background())
	<-done
	_ = tx.Rollback(ctx)
	st := f.ended(t)
	failedUnchanged(t, st)
	cause, output, _ := strings.Cut(st.Message, " — ")
	if !strings.Contains(cause, "lock timeout") || strings.Contains(st.Message, "pg_restore failed") {
		t.Errorf("message %q; want psql's lock timeout as the cause, not pg_restore", st.Message)
	}
	// psql's error comes first, within the 200 characters the page shows,
	// and in the programs' output ahead of pg_restore's.
	if i := strings.Index(st.Message, "lock timeout"); i < 0 || i > 200 {
		t.Errorf("the lock timeout is at %d in %q; want it within the first 200 characters", i, st.Message)
	}
	if i, j := strings.Index(output, "lock timeout"), strings.Index(output, "stand-in noise"); i < 0 || j < 0 || i > j {
		t.Errorf("the programs' output %q; want psql's lock timeout before pg_restore's lines", output)
	}
	f.assertOldData(t)
}

// TestABackupWithLargeObjectsIsRefusedBeforeAnythingIsTouched: pg_restore
// writes BEGIN and COMMIT around large objects, and that COMMIT would end the
// restore's transaction part way. The table of contents is checked first.
func TestABackupWithLargeObjectsIsRefusedBeforeAnythingIsTouched(t *testing.T) {
	pool, _ := requireBackupTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var lo int64
	if err := pool.QueryRow(ctx, `SELECT lo_from_bytea(0, 'aurora')::bigint`).Scan(&lo); err != nil {
		t.Fatalf("create a large object: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `SELECT lo_unlink($1)`, lo) })
	f := newRestoreFixture(t)
	rec, done := f.start(t, context.Background())
	<-done
	st := f.ended(t)
	if st.State != restoreStateFailed || st.Step != string(restoreStepChecking) || st.Database != restoreDBUnchanged || rec.Code != http.StatusBadRequest {
		t.Fatalf("answer %d, record %+v; want a 400 refused while checking, database unchanged", rec.Code, st)
	}
	if !strings.Contains(st.Message, "BLOB") && !strings.Contains(st.Message, "LARGE OBJECT") {
		t.Errorf("message %q does not name the large objects", st.Message)
	}
	f.assertOldData(t)
}

// TestATruncatedArchiveIsRefusedWithTheDatabaseUntouched: the full read of the
// archive (deep-debug H8) runs before the transaction takes any lock. A dump
// cut mid-data passes the handler's cheap checks; the check refuses it.
func TestATruncatedArchiveIsRefusedWithTheDatabaseUntouched(t *testing.T) {
	f := newRestoreFixture(t)
	f.dump = f.dump[:len(f.dump)*2/3]
	rec, done := f.start(t, context.Background())
	<-done
	st := f.ended(t)
	if st.State != restoreStateFailed || st.Step != string(restoreStepChecking) || st.Database != restoreDBUnchanged || rec.Code != http.StatusBadRequest {
		t.Fatalf("answer %d, record %+v; want refused while checking", rec.Code, st)
	}
	f.assertOldData(t)
}

// TestARestoreStoppedByShutdownLeavesTheOldData: a stop cancels the lifecycle
// context in the middle of the transaction. psql is interrupted, nothing
// commits, and the old data stays: the restore is lost and has to be run
// again. (The separate wipe left the database empty here.)
func TestARestoreStoppedByShutdownLeavesTheOldData(t *testing.T) {
	f := newRestoreFixture(t)
	root, stopServer := context.WithCancel(context.Background())
	defer stopServer()
	f.h.SetRootContext(root)
	f.pauseAtFirstCopy(t, 30)
	oid := f.mediaItemsOID(t)
	_, done := f.start(t, context.Background())
	f.waitForTheLock(t, oid)
	stopServer()
	<-done
	st := f.ended(t)
	failedUnchanged(t, st)
	if !strings.Contains(st.Message, "shutting down") {
		t.Errorf("message %q does not say the server stopped it", st.Message)
	}
	f.assertOldData(t)
}

// TestPsqlReachingEndOfInputWithoutTheCommitRollsBack pins what the guard
// rests on, without our interrupt: when pg_restore dies part way (under
// systemd's default stop every process in the unit gets SIGTERM at once,
// pg_restore included) or this process crashes, psql reads the end of its
// input with the transaction open and no COMMIT. Run with exactly the
// restore's arguments (restorePsqlArgs: no --single-transaction), it commits
// nothing; it exits, its connection ends, and PostgreSQL rolls the wipe and
// the partial load back. Both cuts: between statements and inside a COPY.
func TestPsqlReachingEndOfInputWithoutTheCommitRollsBack(t *testing.T) {
	for _, tc := range []struct {
		name string
		cut  func(line string, copyLines *int) bool
	}{
		{"after a whole COPY block", func(line string, n *int) bool {
			if line == `\.` {
				*n = -1
				return true
			}
			return *n >= 0
		}},
		{"inside a COPY", func(line string, n *int) bool {
			if strings.HasPrefix(line, "COPY ") {
				*n = 1
				return true
			}
			if *n > 0 {
				*n++
			}
			return *n < 3
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRestoreFixture(t)
			tmp := filepath.Join(t.TempDir(), "backup.dump")
			if err := os.WriteFile(tmp, f.dump, 0o600); err != nil {
				t.Fatalf("write the dump: %v", err)
			}
			out, err := exec.Command(f.realPgRst, "--no-owner", "--no-privileges", "--no-comments", "--restrict-key=k1", "-f", "-", tmp).Output()
			if err != nil {
				t.Fatalf("pg_restore -f -: %v", err)
			}
			var kept []string
			n := 0
			for _, line := range strings.Split(string(out), "\n") {
				if !tc.cut(line, &n) {
					break
				}
				kept = append(kept, line)
			}
			if len(kept) == 0 || len(kept) > len(strings.Split(string(out), "\n"))-10 {
				t.Fatalf("the cut kept %d lines; it should end the stream part way", len(kept))
			}
			connURL, pgEnv := pgConnEnv(f.dbURL)
			psql := exec.Command("psql", restorePsqlArgs(connURL)...)
			psql.Env = append(os.Environ(), pgEnv...)
			psql.Stdin = strings.NewReader(restorePreamble(restoreLockTimeout) + strings.Join(kept, "\n") + "\n")
			res, err := psql.CombinedOutput()
			t.Logf("psql: %v %s", err, res)
			f.assertOldData(t)
		})
	}
}

// TestADroppedConnectionMidRestoreLeavesTheOldData: the restore's database
// session is terminated in the middle of its transaction (a crash of psql, a
// lost connection, an administrator's pg_terminate_backend). PostgreSQL rolls
// the transaction back; the old data stays.
func TestADroppedConnectionMidRestoreLeavesTheOldData(t *testing.T) {
	f := newRestoreFixture(t)
	f.pauseAtFirstCopy(t, 5)
	oid := f.mediaItemsOID(t)
	_, done := f.start(t, context.Background())
	f.waitForTheLock(t, oid)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if n := f.query(t, ctx, `SELECT count(*)::int FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1) t`, restoreAppName); n != 1 {
		t.Fatalf("terminated %d restore sessions, want 1", n)
	}
	<-done
	failedUnchanged(t, f.ended(t))
	f.assertOldData(t)
}

// TestAKilledPsqlFreesTheLocksWithinSeconds: on a stop systemd sends SIGTERM
// to every process in the unit, psql included, and psql dies without asking
// the server to cancel. Its session used to hold every lock until the
// statement in flight ended, and the long ones (the vector index build, the
// foreign-key checks) come last: the next start waited in its migrations.
// client_connection_check_interval makes the server notice the lost client
// within seconds. The stand-in pg_restore ends its stream with a 30-second
// statement, as a long index build would.
func TestAKilledPsqlFreesTheLocksWithinSeconds(t *testing.T) {
	f := newRestoreFixture(t)
	f.wrapPgRestore(t, `"$REAL" "$@" | awk '/^\\unrestrict / {print "SELECT pg_sleep(30);"} {print}'
exit ${PIPESTATUS[0]}`)
	pidFile := filepath.Join(t.TempDir(), "psql.pid")
	f.wrapPsql(t, `echo $$ > '`+pidFile+`'
exec "$REAL" "$@"`)
	_, done := f.start(t, context.Background())

	// The restore's session is in its last, long statement.
	deadline := time.Now().Add(30 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		n := f.query(t, ctx, `SELECT count(*)::int FROM pg_stat_activity WHERE application_name = $1 AND query LIKE '%pg_sleep%' AND state = 'active'`, restoreAppName)
		cancel()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the restore never reached its last statement; record %+v", f.h.restores.status())
		}
		time.Sleep(20 * time.Millisecond)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("read psql's pid: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("psql's pid %q: %v", raw, err)
	}
	// systemd's stop.
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		t.Fatalf("SIGTERM psql: %v", err)
	}
	killed := time.Now()
	for f.restoreHoldsLocks(t) {
		if time.Since(killed) > 10*time.Second {
			t.Fatal("the killed psql's session still holds the restore's locks after 10 s: the server has not noticed the lost client")
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Logf("locks freed %v after psql was killed", time.Since(killed).Round(time.Millisecond))
	<-done
	failedUnchanged(t, f.ended(t))
	f.assertOldData(t)
}

// TestTheCommitGuardHoldsWhenTheRestoreIsStopped pins the guard's other half:
// a stream that finishes whole after the restore was stopped gets no COMMIT.
// The stand-ins ignore the stop's interrupt (psql in a session of its own), so
// only the guard's check of the restore's context stands between the whole
// stream and a COMMIT.
func TestTheCommitGuardHoldsWhenTheRestoreIsStopped(t *testing.T) {
	f := newRestoreFixture(t)
	root, stopServer := context.WithCancel(context.Background())
	defer stopServer()
	f.h.SetRootContext(root)
	f.wrapPgRestore(t, `trap '' INT
"$REAL" "$@" | awk '{print} !d && /^COPY / {fflush(); system("sleep 3"); d=1}'
exit ${PIPESTATUS[0]}`)
	f.wrapPsql(t, `trap '' INT
setsid -w "$REAL" "$@"`)
	oid := f.mediaItemsOID(t)
	_, done := f.start(t, context.Background())
	f.waitForTheLock(t, oid)
	stopServer()
	<-done
	st := f.ended(t)
	failedUnchanged(t, st)
	if !strings.Contains(st.Message, "shutting down") {
		t.Errorf("message %q does not say the server stopped it", st.Message)
	}
	f.assertOldData(t)
}

// waitForTheFirstCopy waits until the restore's session waits for the data
// of its first COPY (pauseAtFirstCopy): the wipe is done, so a write started
// now waits on a dropped table and cannot deadlock with the wipe (a write
// that meets the wipe half way can, and one of the two is aborted).
func (f *restoreFixture) waitForTheFirstCopy(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		n := f.query(t, ctx, `SELECT count(*)::int FROM pg_stat_activity WHERE application_name = $1 AND query LIKE 'COPY %' AND wait_event = 'ClientRead'`, restoreAppName)
		cancel()
		if n > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the restore never reached its first COPY; record %+v", f.h.restores.status())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitingOnTheRestore waits until a session other than the restore's waits on
// a lock with tag in its query.
func (f *restoreFixture) waitingOnTheRestore(t *testing.T, tag string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		n := f.query(t, ctx, `SELECT count(*)::int FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%' || $1 || '%' AND pid <> pg_backend_pid()`, tag)
		cancel()
		if n > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no session waits on the restore with %q in its query", tag)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// startWaitingWrite inserts a library named name from its own connection
// (with appName as its application_name, when given), and answers its error
// once the insert has returned.
func (f *restoreFixture) startWaitingWrite(t *testing.T, name string, appName ...string) <-chan error {
	t.Helper()
	url := f.dbURL
	if len(appName) > 0 {
		url += "&application_name=" + appName[0]
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect the writer: %v", err)
	}
	t.Cleanup(pool.Close)
	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		_, err := pool.Exec(ctx, `INSERT INTO libraries (name, type, paths, owner_id) VALUES ($1, 'movie', ARRAY['/tmp/waiter'], $2)`, name, f.seed.userID)
		done <- err
	}()
	return done
}

// TestAWriteWaitingOnTheRestoreIsEndedRatherThanLandingInTheRestoredData: a
// write that meets the transaction's locks waits, and after the COMMIT it
// used to go on against the restored data with the ids it had (the old
// database's). Just before its COMMIT the restore ends the sessions waiting
// on it: the write fails, and nothing of it is in the restored data.
func TestAWriteWaitingOnTheRestoreIsEndedRatherThanLandingInTheRestoredData(t *testing.T) {
	f := newRestoreFixture(t)
	f.pauseAtFirstCopy(t, 3)
	oid := f.mediaItemsOID(t)
	_, done := f.start(t, context.Background())
	f.waitForTheLock(t, oid)
	f.waitForTheFirstCopy(t)
	name := "waiter " + time.Now().UTC().Format("150405.000000000")
	wrote := f.startWaitingWrite(t, name)
	f.waitingOnTheRestore(t, "INSERT INTO libraries")
	<-done
	if st := f.ended(t); st.State != restoreStateSucceeded {
		t.Fatalf("record %+v", st)
	}
	err := <-wrote
	var pgErr *pgconn.PgError
	if err == nil {
		t.Fatal("the write that waited on the restore succeeded; it should have been ended")
	}
	if errors.As(err, &pgErr) && pgErr.Code != "57P01" {
		t.Errorf("the waiting write failed with %s (%v), want 57P01 (terminated)", pgErr.Code, err)
	}
	f.assertRestored(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if n := f.query(t, ctx, `SELECT count(*)::int FROM libraries WHERE name = $1`, name); n != 0 {
		t.Errorf("the write that waited landed in the restored data (%d rows)", n)
	}
}

// TestTheRestoreCommitsWhenItCannotEndTheSessionsWaitingOnIt: ending the
// sessions that wait on the restore is best effort. One it may not end (as a
// superuser's, which the server's role may not signal; here a stand-in that
// fails for one session) is skipped and the others are still ended; and the
// scan failing as a whole cannot abort the transaction either: the restore
// commits.
func TestTheRestoreCommitsWhenItCannotEndTheSessionsWaitingOnIt(t *testing.T) {
	t.Run("one session refused", func(t *testing.T) {
		f := newRestoreFixture(t)
		// The refused session comes first, so a refusal that stopped the loop
		// would leave the other one too.
		f.h.restoreTools.endWaiters = restoreEndWaitersBlock(
			restoreWaiterFilter+" ORDER BY application_name = 'aurora-test-refused' DESC",
			"(SELECT CASE WHEN a.application_name = 'aurora-test-refused' THEN a.pid / (a.pid - a.pid) ELSE 1 END FROM pg_stat_activity a WHERE a.pid = waiting) = 1 AND pg_terminate_backend(waiting)")
		f.pauseAtFirstCopy(t, 3)
		oid := f.mediaItemsOID(t)
		_, done := f.start(t, context.Background())
		f.waitForTheLock(t, oid)
		f.waitForTheFirstCopy(t)
		stamp := time.Now().UTC().Format("150405.000000000")
		refused := f.startWaitingWrite(t, "refused "+stamp, "aurora-test-refused")
		ended := f.startWaitingWrite(t, "ended "+stamp)
		deadline := time.Now().Add(10 * time.Second)
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			n := f.query(t, ctx, `SELECT count(*)::int FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO libraries%'`)
			cancel()
			if n >= 2 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%d of the two writes wait on the restore", n)
			}
			time.Sleep(20 * time.Millisecond)
		}
		<-done
		if st := f.ended(t); st.State != restoreStateSucceeded || st.Database != restoreDBRestored {
			t.Fatalf("record %+v; want the restore committed", st)
		}
		f.assertRestored(t)
		if err := <-ended; err == nil {
			t.Error("the session after the refused one was not ended")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if n := f.query(t, ctx, `SELECT count(*)::int FROM libraries WHERE name = $1`, "ended "+stamp); n != 0 {
			t.Errorf("the ended session's write landed (%d rows)", n)
		}
		// Not ended, the refused write goes on against the restored data:
		// the gap the session routes' gate exists for.
		if err := <-refused; err != nil {
			t.Logf("the refused session's write: %v", err)
		}
	})
	t.Run("the scan itself fails", func(t *testing.T) {
		f := newRestoreFixture(t)
		f.h.restoreTools.endWaiters = restoreEndWaitersBlock(restoreWaiterFilter+" AND (pid / (pid - pid)) > 0", "pg_terminate_backend(waiting)")
		f.pauseAtFirstCopy(t, 1)
		_, done := f.start(t, context.Background())
		<-done
		if st := f.ended(t); st.State != restoreStateSucceeded || st.Database != restoreDBRestored {
			t.Fatalf("record %+v; want the restore committed", st)
		}
		f.assertRestored(t)
	})
}

// TestASignInRacingTheRestoreLeavesNoSessionInTheRestoredDatabase: the
// security case. A sign-in that read its user before the wipe and inserted
// its session after the COMMIT got a working session in the restored data
// under the old database's user id. The session routes are closed for the
// whole transaction: one already running is waited for before it begins, one
// that comes during it is refused at once, and they open when it ends.
func TestASignInRacingTheRestoreLeavesNoSessionInTheRestoredDatabase(t *testing.T) {
	f := newRestoreFixture(t)
	f.pauseAtFirstCopy(t, 3)
	oid := f.mediaItemsOID(t)
	ctx := context.Background()
	svc := healthTestService()
	q := db.NewQueries(f.pool)
	const password = "a-racing-password"
	hash, err := svc.HashPassword(password)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	username := "racer_" + time.Now().UTC().Format("150405000000000")
	if _, err := q.CreateUser(ctx, username, username+"@example.com", hash, models.RoleUser); err != nil {
		t.Fatalf("create the user (live data only, not in the backup): %v", err)
	}
	authH := NewAuthHandler(svc, q, nil)
	signIn := func(hold <-chan struct{}, entered chan<- struct{}) *httptest.ResponseRecorder {
		h := f.h.sessionGate.guardJSON()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if entered != nil {
				close(entered)
			}
			if hold != nil {
				<-hold
			}
			authH.Login(w, r)
		}))
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"`+username+`","password":"`+password+`"}`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}

	// A sign-in already running when the restore reaches its transaction.
	hold, entered := make(chan struct{}), make(chan struct{})
	first := make(chan *httptest.ResponseRecorder, 1)
	go func() { first <- signIn(hold, entered) }()
	<-entered
	_, done := f.start(t, ctx)
	eventually(t, "the session routes to close", func() bool {
		return signIn(nil, nil).Code == http.StatusServiceUnavailable
	})
	time.Sleep(300 * time.Millisecond)
	if f.restoreHoldsLocks(t) {
		t.Fatal("the restore's transaction began with a sign-in still running")
	}
	close(hold)
	if rr := <-first; rr.Code != http.StatusOK {
		t.Fatalf("the sign-in that was running: %d %s", rr.Code, rr.Body)
	}

	// One during the transaction is refused at once, not left waiting.
	f.waitForTheLock(t, oid)
	f.waitForTheFirstCopy(t)
	answered := make(chan *httptest.ResponseRecorder, 1)
	go func() { answered <- signIn(nil, nil) }()
	select {
	case rr := <-answered:
		if rr.Code != http.StatusServiceUnavailable || errorReasonOf(rr) != restoreRunningReason {
			t.Errorf("a sign-in during the transaction: %d %s, want 503 %s", rr.Code, rr.Body, restoreRunningReason)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a sign-in during the transaction waited instead of being refused")
	}

	<-done
	if st := f.ended(t); st.State != restoreStateSucceeded {
		t.Fatalf("record %+v", st)
	}
	f.assertRestored(t)
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if n := f.query(t, readCtx, `SELECT count(*)::int FROM refresh_tokens`); n != 0 {
		t.Errorf("the restored database holds %d session(s); a backup holds none, and no sign-in may land after the COMMIT", n)
	}
	// The routes are open again (the user is not in the backup: refused as
	// any unknown user is).
	if rr := signIn(nil, nil); rr.Code == http.StatusServiceUnavailable {
		t.Errorf("a sign-in after the restore: %d, want the routes open again", rr.Code)
	}
}

// TestASettingTheServerRefusesCannotAbortTheRestore: client_connection_check_interval
// does not exist before PostgreSQL 14 and is refused off Linux on 14 and on
// Windows after, so the restore sets it through restoreSetIfSupported, which
// leaves a refused setting as it was and the transaction usable.
func TestASettingTheServerRefusesCannotAbortTheRestore(t *testing.T) {
	pool, _ := requireBackupTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, refused := range [][2]string{{"aurora_no_such_setting", "1s"}, {"client_connection_check_interval", "-5"}} {
		if _, err := tx.Exec(ctx, restoreSetIfSupported(refused[0], refused[1])); err != nil {
			t.Fatalf("setting %s = %s aborted the statement: %v", refused[0], refused[1], err)
		}
	}
	if _, err := tx.Exec(ctx, restoreSetIfSupported("client_connection_check_interval", "1s")); err != nil {
		t.Fatalf("the supported setting: %v", err)
	}
	var got string
	if err := tx.QueryRow(ctx, `SHOW client_connection_check_interval`).Scan(&got); err != nil {
		t.Fatalf("the transaction is not usable after a refused setting: %v", err)
	}
	if got != "1s" {
		t.Errorf("client_connection_check_interval = %q in the transaction, want 1s", got)
	}
}
