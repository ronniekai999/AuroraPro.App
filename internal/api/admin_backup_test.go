package api

// Roundtrip test for the Backup → Restore pipeline. Pins the
// rearchitecture from 2026-05-18 (pg_dump custom format + pg_restore)
// against the regressions it eliminates:
//
//   - Vector-row corruption from line-based filtering (the "0..074918"
//     double-dot bug). A 384-dim embedding survives the roundtrip
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
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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
// representative 384-dim embedding. Returns the IDs so the assertion
// step can locate the rows.
func seedTestData(t *testing.T, pool *pgxpool.Pool) seedRow {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Build a representative 384-dim vector. Real embeddings have
	// negative, positive, and zero values with varying magnitudes —
	// emulate that so the test exercises the same code paths a real
	// nomic-embed-text output would.
	var sb bytes.Buffer
	sb.WriteByte('[')
	for i := 0; i < 384; i++ {
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
// 2026-05-18 rearchitecture. Inserts a row with a 384-dim vector,
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
	// The pgvector text representation should round-trip exactly. If
	// the line-filter corruption ever returns, this comparison fails
	// loudly with the offending substring visible in the diff.
	if gotEmbedding != seed.embedding {
		// Find the first divergent byte for a focused error message.
		divergeAt := -1
		minLen := len(gotEmbedding)
		if len(seed.embedding) < minLen {
			minLen = len(seed.embedding)
		}
		for i := 0; i < minLen; i++ {
			if gotEmbedding[i] != seed.embedding[i] {
				divergeAt = i
				break
			}
		}
		ctxStart := divergeAt - 20
		if ctxStart < 0 {
			ctxStart = 0
		}
		ctxEnd := divergeAt + 20
		if ctxEnd > minLen {
			ctxEnd = minLen
		}
		t.Errorf("embedding mismatch at byte %d (len want=%d got=%d):\n  want: ...%s...\n  got:  ...%s...",
			divergeAt, len(seed.embedding), len(gotEmbedding),
			seed.embedding[ctxStart:ctxEnd], gotEmbedding[ctxStart:ctxEnd])
	}

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
