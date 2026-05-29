package db

// Integration tests for the request-quota / approval-queue queries added for
// carve-out C (REQUEST GATING):
//
//	CountActiveRequestsByUser — backs the per-user active-in-flight quota.
//	CountUserRequestsSince     — backs the per-user rolling-24h quota.
//	GetPendingApprovalRequests — backs the admin approval queue.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run (skipped otherwise),
// mirroring queries_jsonb_integration_test.go. Each test seeds a temporary
// user and inserts requests via the production InsertRequest path, then cleans
// up every row it created (and CASCADE from the user as defense in depth).

import (
	"context"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// seedTestRequest inserts a request for the given user+status via the
// production InsertRequest path and registers a cleanup. requestedAt lets a
// test place the row inside or outside the rolling-24h window.
func seedTestRequest(t *testing.T, q *Queries, userID int64, status string, requestedAt time.Time) int64 {
	t.Helper()
	req := &models.Request{
		UserID:       userID,
		MediaType:    "movie",
		TMDBID:       int(time.Now().UnixNano() % 1_000_000_000), // unique-ish to dodge the active-unique index
		Title:        "Quota Test " + randomSuffix(t),
		Status:       status,
		Quality1080p: true,
		RequestedAt:  requestedAt,
		UpdatedAt:    requestedAt,
	}
	if err := q.InsertRequest(context.Background(), req); err != nil {
		t.Fatalf("seed request: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM requests WHERE id = $1`, req.ID)
	})
	return req.ID
}

// TestCountActiveRequestsByUser verifies only the in-flight statuses
// (pending, processing, pending_approval) count toward the active quota, and
// that available/failed and other users' requests are excluded.
func TestCountActiveRequestsByUser(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	otherID := seedTestUser(t, q)
	now := time.Now()

	// Three active rows for our user.
	seedTestRequest(t, q, userID, models.RequestPending, now)
	seedTestRequest(t, q, userID, models.RequestProcessing, now)
	seedTestRequest(t, q, userID, models.RequestPendingApproval, now)
	// Two that must NOT count (terminal states).
	seedTestRequest(t, q, userID, models.RequestAvailable, now)
	seedTestRequest(t, q, userID, models.RequestFailed, now)
	// Another user's active row must not bleed in.
	seedTestRequest(t, q, otherID, models.RequestPending, now)

	got, err := q.CountActiveRequestsByUser(context.Background(), userID)
	if err != nil {
		t.Fatalf("CountActiveRequestsByUser: %v", err)
	}
	if got != 3 {
		t.Errorf("active count = %d, want 3 (pending+processing+pending_approval only)", got)
	}
}

// TestCountUserRequestsSince verifies the rolling-window count includes every
// status at/after the cutoff and excludes rows older than it (and other users).
func TestCountUserRequestsSince(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	otherID := seedTestUser(t, q)
	now := time.Now()
	cutoff := now.Add(-24 * time.Hour)

	// Inside the window — all statuses count (the daily quota is by
	// submission time, not lifecycle state).
	seedTestRequest(t, q, userID, models.RequestPending, now)
	seedTestRequest(t, q, userID, models.RequestFailed, now.Add(-1*time.Hour))
	seedTestRequest(t, q, userID, models.RequestAvailable, now.Add(-23*time.Hour))
	// Exactly at the boundary counts (>= cutoff).
	seedTestRequest(t, q, userID, models.RequestPending, cutoff)
	// Outside the window — must not count.
	seedTestRequest(t, q, userID, models.RequestPending, now.Add(-25*time.Hour))
	// Another user inside the window — must not count.
	seedTestRequest(t, q, otherID, models.RequestPending, now)

	got, err := q.CountUserRequestsSince(context.Background(), userID, cutoff)
	if err != nil {
		t.Fatalf("CountUserRequestsSince: %v", err)
	}
	if got != 4 {
		t.Errorf("daily count = %d, want 4 (rows at/after cutoff for this user)", got)
	}
}

// TestGetPendingApprovalRequests verifies only pending_approval rows are
// returned, oldest-first, and the row round-trips its fields.
func TestGetPendingApprovalRequests(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	now := time.Now()

	// Two held rows with distinct requested_at to assert ordering.
	olderID := seedTestRequest(t, q, userID, models.RequestPendingApproval, now.Add(-2*time.Hour))
	newerID := seedTestRequest(t, q, userID, models.RequestPendingApproval, now.Add(-1*time.Hour))
	// Non-held rows must be excluded.
	seedTestRequest(t, q, userID, models.RequestPending, now)
	seedTestRequest(t, q, userID, models.RequestProcessing, now)

	got, err := q.GetPendingApprovalRequests(context.Background())
	if err != nil {
		t.Fatalf("GetPendingApprovalRequests: %v", err)
	}

	// Filter to the two rows this test created (the shared test DB may hold
	// unrelated pending_approval rows from other runs).
	var mine []models.Request
	for _, r := range got {
		if r.ID == olderID || r.ID == newerID {
			mine = append(mine, r)
		}
		if r.Status != models.RequestPendingApproval {
			t.Errorf("row %d has status %q, want pending_approval", r.ID, r.Status)
		}
	}
	if len(mine) != 2 {
		t.Fatalf("found %d of this test's held rows, want 2", len(mine))
	}
	// ORDER BY requested_at ASC → older row first among ours.
	if mine[0].ID != olderID || mine[1].ID != newerID {
		t.Errorf("ordering wrong: got [%d, %d], want oldest-first [%d, %d]",
			mine[0].ID, mine[1].ID, olderID, newerID)
	}
}
