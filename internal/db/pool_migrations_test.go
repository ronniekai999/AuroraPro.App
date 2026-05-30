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
