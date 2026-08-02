package db

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/aurora-media/aurora/internal/config"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Startup DB connect retry.
//
// aurora.service declares `After=postgresql.service`, but systemd's After=
// only orders unit STARTUP — it does not wait for Postgres to be accepting
// connections. On a reboot (or whenever Postgres restarts under us) Aurora
// can win the race, fail its first connect, and os.Exit(1). Production logs
// caught exactly this on 2026-07-28:
//
//	failed to connect to database ... dial tcp 127.0.0.1:5432: connect:
//	connection refused
//
// systemd's Restart=on-failure/RestartSec=5 does eventually recover, so the
// cost is a noisy minute of flapping rather than a dead server — but it is
// avoidable, and the restart churn muddies the logs around every reboot.
//
// A permanent error (bad password, missing database) is NOT retried: waiting
// out a full minute cannot fix a misconfiguration, and failing fast puts the
// real cause at the end of the log where an operator will see it.

const (
	// DefaultConnectRetryWindow bounds total time spent waiting for Postgres.
	// Long enough to cover a normal postgres start after a reboot, short
	// enough that a genuinely-down database surfaces promptly instead of
	// hanging the boot indefinitely.
	DefaultConnectRetryWindow = 60 * time.Second

	connectRetryInitialDelay = 1 * time.Second
	connectRetryMaxDelay     = 5 * time.Second
)

// NewPoolWithRetry is NewPool with a bounded retry on transient failures.
// window <= 0 uses DefaultConnectRetryWindow.
func NewPoolWithRetry(ctx context.Context, cfg config.DatabaseConfig, window time.Duration) (*pgxpool.Pool, error) {
	if window <= 0 {
		window = DefaultConnectRetryWindow
	}
	deadline := time.Now().Add(window)
	delay := connectRetryInitialDelay

	for attempt := 1; ; attempt++ {
		pool, err := NewPool(ctx, cfg)
		if err == nil {
			if attempt > 1 {
				slog.Info("database connected after retry", "attempts", attempt)
			}
			return pool, nil
		}

		if permanentConnectError(err) {
			// Config is wrong, not the timing. Surface it now.
			return nil, err
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("database connect cancelled: %w", ctx.Err())
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("database unreachable after %s: %w", window, err)
		}

		slog.Warn("database not ready, retrying",
			"attempt", attempt, "retry_in", delay, "error", err)

		// Respect cancellation while waiting — a SIGTERM during a slow boot
		// should not have to sit through the full backoff.
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("database connect cancelled: %w", ctx.Err())
		case <-time.After(delay):
		}

		if delay < connectRetryMaxDelay {
			delay *= 2
			if delay > connectRetryMaxDelay {
				delay = connectRetryMaxDelay
			}
		}
	}
}

// permanentConnectError reports whether retrying is pointless.
//
// Deliberately a small allowlist of "the operator must fix this" SQLSTATEs
// rather than a guess at which errors look network-shaped. Anything
// unrecognised is treated as transient, because the cost of retrying a
// permanent error is a bounded delay while the cost of giving up on a
// transient one is the restart flapping this function exists to remove.
func permanentConnectError(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	switch pgErr.Code {
	case "28P01", // invalid_password
		"28000", // invalid_authorization_specification
		"3D000", // invalid_catalog_name — database does not exist
		"42501": // insufficient_privilege
		return true
	}
	// 57P03 (cannot_connect_now) is explicitly NOT permanent: it is what
	// Postgres returns while starting up or shutting down, which is the exact
	// window this retry exists to ride out.
	return false
}
