package db

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// The retry loop's whole value depends on this classification. Retrying a bad
// password for a minute just delays a clear error; giving up on "connection
// refused" restores the boot-time restart flapping the retry exists to remove.
func TestPermanentConnectError(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		permanent bool
	}{
		{
			name:      "invalid password — operator must fix, fail fast",
			err:       &pgconn.PgError{Code: "28P01", Message: "password authentication failed"},
			permanent: true,
		},
		{
			name:      "database does not exist — fail fast",
			err:       &pgconn.PgError{Code: "3D000", Message: "database \"aurora\" does not exist"},
			permanent: true,
		},
		{
			name:      "insufficient privilege — fail fast",
			err:       &pgconn.PgError{Code: "42501"},
			permanent: true,
		},
		{
			// This is the code Postgres returns while starting up or shutting
			// down — precisely the window the retry rides out. Production saw
			// its sibling on 2026-07-28.
			name:      "cannot_connect_now — RETRY, postgres is still starting",
			err:       &pgconn.PgError{Code: "57P03", Message: "the database system is starting up"},
			permanent: false,
		},
		{
			name:      "dial tcp connection refused — retry",
			err:       errors.New("ping database: dial tcp 127.0.0.1:5432: connect: connection refused"),
			permanent: false,
		},
		{
			name:      "unknown SQLSTATE — retry (transient by default)",
			err:       &pgconn.PgError{Code: "08006", Message: "connection failure"},
			permanent: false,
		},
		{
			name:      "nil-ish plain error — retry",
			err:       errors.New("something odd"),
			permanent: false,
		},
		{
			name:      "wrapped permanent error is still permanent",
			err:       fmt.Errorf("ping database: %w", &pgconn.PgError{Code: "28P01"}),
			permanent: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := permanentConnectError(tc.err); got != tc.permanent {
				t.Fatalf("permanentConnectError = %v, want %v", got, tc.permanent)
			}
		})
	}
}
