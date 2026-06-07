package db

// Integration tests for last_login_at (migration 036): UpdateLastLogin stamps
// the column to the DB clock, and GetAllUsers reads it back — nil for a user who
// has never signed in. Together these back the admin Users table's "Last Login"
// column (UpdateLastLogin is called on the login/OAuth/register paths;
// GetAllUsers is what ListUsers serves to the admin UI).
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run; skipped otherwise (see
// requireIntegrationDB in queries_jsonb_integration_test.go). Schema is assumed
// already migrated. Fixtures self-clean via seedTestUser's t.Cleanup.

import (
	"context"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// userFromAll returns the user with the given id as surfaced by GetAllUsers, or
// fails the test. Exercising the read through GetAllUsers (rather than a direct
// SELECT) is the point: it's the exact query the admin Users list is built from,
// so it also guards the last_login_at scan target.
func userFromAll(t *testing.T, q *Queries, id int64) *models.User {
	t.Helper()
	users, err := q.GetAllUsers(context.Background())
	if err != nil {
		t.Fatalf("GetAllUsers: %v", err)
	}
	for _, u := range users {
		if u.ID == id {
			return u
		}
	}
	t.Fatalf("seeded user %d not found among %d users from GetAllUsers", id, len(users))
	return nil // unreachable; t.Fatalf stops the test
}

func TestUpdateLastLogin(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)

	// A freshly seeded user has never signed in: last_login_at is NULL, which
	// GetAllUsers must surface as a nil pointer (rendered "Never" in the UI).
	if u := userFromAll(t, q, userID); u.LastLoginAt != nil {
		t.Fatalf("new user LastLoginAt = %v, want nil (never signed in)", *u.LastLoginAt)
	}

	// First sign-in populates the column.
	if err := q.UpdateLastLogin(ctx, userID); err != nil {
		t.Fatalf("UpdateLastLogin (first): %v", err)
	}
	u := userFromAll(t, q, userID)
	if u.LastLoginAt == nil {
		t.Fatal("LastLoginAt is nil after UpdateLastLogin, want a timestamp")
	}
	first := *u.LastLoginAt
	// Sanity: the stamp is roughly "now", not a zero/epoch value. The window is
	// deliberately generous to tolerate clock skew between the test runner and
	// the DB server — the assertion that matters is "not garbage", not precision.
	if d := time.Since(first); d < -24*time.Hour || d > 24*time.Hour {
		t.Errorf("LastLoginAt = %v, not within 24h of now (looks unset/wrong)", first)
	}

	// A second sign-in re-stamps to a later (or equal) time — NOW() is evaluated
	// per statement — proving the column tracks the latest login, not the first.
	if err := q.UpdateLastLogin(ctx, userID); err != nil {
		t.Fatalf("UpdateLastLogin (second): %v", err)
	}
	second := *userFromAll(t, q, userID).LastLoginAt
	if second.Before(first) {
		t.Errorf("second LastLoginAt %v is before first %v, want it to advance", second, first)
	}
}

// UpdateLastLogin against a non-existent user id is a no-op (zero rows affected),
// not an error: callers invoke it best-effort right after a successful auth and
// must never see a spurious failure from this write.
func TestUpdateLastLogin_UnknownUserIsNoError(t *testing.T) {
	q := requireIntegrationDB(t)
	// id 0 never exists (serial ids start at 1), so this matches no row.
	if err := q.UpdateLastLogin(context.Background(), 0); err != nil {
		t.Fatalf("UpdateLastLogin(unknown id) = %v, want nil", err)
	}
}
