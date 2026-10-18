package db

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func NewPool(ctx context.Context, cfg config.DatabaseConfig) (*pgxpool.Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("parse database config: %w", err)
	}

	poolCfg.MaxConns = cfg.MaxConns
	poolCfg.MinConns = cfg.MinConns
	poolCfg.MaxConnLifetime = cfg.MaxConnLifetime

	// Bump pgvector HNSW search-list size on every connection. Default 40
	// is below our vectorRecallSize=50 — without this, every 50-row
	// semantic page would come back short from the index, and
	// SemanticSearch would pay for its exact retry on every search.
	//
	// Sequence matters: pgvector's GUC isn't registered until its shared
	// library is loaded into the backend, which happens lazily on first
	// vector reference. We force that by casting `'[0]'::vector(1)` BEFORE
	// the SET. With the library now loaded, the SET runs as a USERSET on
	// the session — no special privileges required, no DB / role ALTER
	// dance, no migration ordering trap.
	//
	// We tried two persistence routes via migration 018 first:
	//   - ALTER DATABASE ... SET → permission denied (custom GUC)
	//   - ALTER ROLE current_user IN DATABASE current_database() SET →
	//     still permission denied because pgvector wasn't loaded in the
	//     migration runner's backend either.
	// Per-connection session SET is the only path that doesn't need
	// superuser. Migration 018 is now a no-op kept as a record.
	poolCfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		// Force pgvector library load so the GUC is registered.
		// If pgvector isn't installed (CI / vanilla PG), this errors
		// and we skip the SET silently — non-vector workloads still work.
		if _, err := conn.Exec(ctx, "SELECT '[0]'::vector(1)"); err != nil {
			return nil
		}
		if _, err := conn.Exec(ctx, "SET hnsw.ef_search = 100"); err != nil {
			slog.Warn("hnsw.ef_search SET failed (semantic search may pay for exact retries)",
				"error", err)
		}
		return nil
	}

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("create connection pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	slog.Info("database connected", "max_conns", cfg.MaxConns)
	return pool, nil
}

// VerifyVectorTuning is a post-boot smoke check: it confirms pgvector is
// loaded AND `hnsw.ef_search` is at the expected value. Run from main.go
// right after migrations, before any application traffic.
//
// The tuning itself is done by `pool.AfterConnect` (see NewPool comment),
// which forces pgvector load via a `'[0]'::vector(1)` cast and then runs a
// session-level `SET hnsw.ef_search = 100`. This function checks that the
// session-level SET actually took effect — without it, every semantic search
// would fall back to its slower exact retry, with no other signal.
//
// Non-fatal: we LOG mismatches at WARN rather than fail-start, because:
//   - pgvector may not be installed at all (e.g. CI against vanilla PG)
//   - The operator may have intentionally tuned ef_search differently
//
// The `'[0]'::vector(1)` cast on the first query path is redundant in the
// normal case (AfterConnect already did it), but kept as a clean fast path
// for installs WITHOUT pgvector: instead of confusing operators with a
// failing `SHOW`, they see "pgvector not available; skipping" at INFO.
//
// expectedMin lets the caller assert "at least this much"; pass 0 to skip
// the value check and just confirm pgvector is reachable.
func VerifyVectorTuning(ctx context.Context, pool *pgxpool.Pool, expectedMin int) {
	// Touch a vector to force pgvector's _PG_init() so the GUC is visible.
	// The cast itself is a no-op; we discard the row.
	if _, err := pool.Exec(ctx, "SELECT '[0]'::vector(1)"); err != nil {
		slog.Info("pgvector not available; skipping vector-tuning check", "error", err)
		return
	}

	var ef string
	if err := pool.QueryRow(ctx, "SHOW hnsw.ef_search").Scan(&ef); err != nil {
		slog.Warn("hnsw.ef_search check failed", "error", err)
		return
	}

	var efN int
	if _, err := fmt.Sscanf(ef, "%d", &efN); err != nil {
		slog.Warn("hnsw.ef_search returned unexpected value", "value", ef)
		return
	}

	if expectedMin > 0 && efN < expectedMin {
		// This is the alarm. Migration 018 should have set this to >= 100;
		// if we see the default 40 here, the migration didn't take effect
		// (database renamed and current_database() returned something
		// else?), and semantic pages larger than the window come back short
		// from the index, so each one pays for an exact retry.
		slog.Warn("hnsw.ef_search below expected minimum — semantic search may pay for exact retries",
			"actual", efN, "expected_min", expectedMin,
			"action", "check pool.AfterConnect logs for 'hnsw.ef_search SET failed'")
		return
	}
	slog.Info("hnsw.ef_search verified", "value", efN)
}

// RunMigrations reads .up.sql files from the given directory and executes them.
// Uses a simple schema_migrations table to track what's been applied.
func RunMigrations(ctx context.Context, pool *pgxpool.Pool, migrationsDir string) error {
	// Ensure tracking table exists
	_, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version VARCHAR(255) PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`)
	if err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	// Find all .up.sql files
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("read migrations dir %s: %w", migrationsDir, err)
	}

	var upFiles []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".up.sql") {
			upFiles = append(upFiles, e.Name())
		}
	}
	sort.Strings(upFiles)

	// Fail-fast on an empty migration set. os.ReadDir happily returns a
	// directory that exists but contains no .up.sql files (wrong cwd, a
	// deploy that shipped the binary without the migrations/ dir beside
	// it, an empty volume mount). Without this, RunMigrations would apply
	// zero migrations and return nil — booting an UNMIGRATED schema that
	// then fails opaquely on the first query against a missing table.
	if len(upFiles) == 0 {
		return fmt.Errorf("no migrations found in %s — check deployment layout (migrations/ must ship beside the binary)", migrationsDir)
	}

	applied := 0
	for _, name := range upFiles {
		// Check if already applied
		var exists bool
		err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1)`, name).Scan(&exists)
		if err != nil {
			return fmt.Errorf("check migration %s: %w", name, err)
		}
		if exists {
			slog.Debug("migration already applied", "file", name)
			continue
		}

		content, err := os.ReadFile(filepath.Join(migrationsDir, name))
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}

		// Execute migration + record in a single transaction to prevent
		// partial application (applied but not recorded)
		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin tx for migration %s: %w", name, err)
		}

		if _, err := tx.Exec(ctx, string(content)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("execute migration %s: %w", name, err)
		}

		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record migration %s: %w", name, err)
		}

		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit migration %s: %w", name, err)
		}

		applied++
		slog.Info("migration applied", "file", name)
	}

	slog.Info("migrations complete", "applied", applied, "total", len(upFiles))
	return nil
}
