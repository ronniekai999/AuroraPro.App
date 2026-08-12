package db

// Tests for RunMigrations' fail-fast on an empty migration set
// (improvement #4): a directory that exists but contains no .up.sql
// files (wrong cwd, missing migrations/ beside the binary) must NOT
// silently boot an unmigrated schema — it must return an error.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run. RunMigrations
// creates the schema_migrations tracking table before it inspects the
// directory, so the empty-dir check is only reachable with a live pool;
// skipped when the env var is unset so the unit suite stays standalone.

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestRunMigrations_AppliesFullChain applies every checked-in migration to the
// configured database, in order, through the real RunMigrations path.
//
// Until this existed nothing exercised the chain as a whole: the two tests
// below cover RunMigrations' fail-fast behaviour on a bad directory, and each
// feature's own tests assume a schema that is already there. A migration that
// failed to apply — bad SQL, a constraint the existing data violates, a
// dependency on an extension the host lacks — would therefore have been
// discovered at deploy time rather than in review.
//
// It is also the step that establishes the schema in CI. `go test ./...` runs
// packages CONCURRENTLY against one database, so no package can be relied on to
// migrate before another reads; the workflow runs this test on its own first,
// and the rest of the suite then finds a schema waiting for it. RunMigrations
// records what it applied in schema_migrations, so running it against an
// already-migrated database is a no-op and the ordering is safe either way.
func TestRunMigrations_AppliesFullChain(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	// The chain is ~56 migrations including index builds; generous but bounded.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping test db: %v", err)
	}

	if err := RunMigrations(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("apply migration chain: %v", err)
	}

	// Applying twice must be a clean no-op — that property is what makes the
	// server safe to restart and this test safe to re-run.
	if err := RunMigrations(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("re-apply migration chain (should be a no-op): %v", err)
	}

	// Spot-check the ends of the chain rather than every table: migration 001's
	// users table and the newest migration's, so both a missing base and a
	// silently-skipped tail fail here.
	for _, table := range []string{"users", "media_items", "playback_qoe_sessions"} {
		var exists bool
		err := pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables
			                 WHERE table_schema = 'public' AND table_name = $1)`, table).Scan(&exists)
		if err != nil {
			t.Fatalf("check table %s: %v", table, err)
		}
		if !exists {
			t.Errorf("table %q missing after a full migration run", table)
		}
	}
}

func TestRunMigrationsEmptyDirFailsFast(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping test db: %v", err)
	}

	// Empty dir (exists, but no .up.sql files).
	emptyDir := t.TempDir()
	err = RunMigrations(ctx, pool, emptyDir)
	if err == nil {
		t.Fatal("expected an error for an empty migrations dir, got nil (would boot an unmigrated schema)")
	}
	if !strings.Contains(err.Error(), "no migrations found") {
		t.Fatalf("expected 'no migrations found' error, got: %v", err)
	}
}

func TestRunMigrationsMissingDirFailsFast(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect to test db: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping test db: %v", err)
	}

	// Non-existent dir → os.ReadDir error path (distinct from the
	// empty-set fail-fast, but also non-nil).
	err = RunMigrations(ctx, pool, t.TempDir()+"/does-not-exist")
	if err == nil {
		t.Fatal("expected an error for a missing migrations dir, got nil")
	}
}
