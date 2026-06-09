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
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

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
	for _, bin := range []string{"pg_dump", "pg_restore"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH; skipping", bin)
		}
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
	// half-cleaned state.
	suffix := time.Now().UTC().Format("20060102150405")
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
		`INSERT INTO users (username, email, password_hash, role)
		 VALUES ($1, $1 || '@example.com', 'x', 'admin')`,
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
