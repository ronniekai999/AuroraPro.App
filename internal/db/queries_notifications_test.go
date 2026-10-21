package db

// Integration tests for the per-user notifications queries (migration 037).
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run (skipped otherwise),
// mirroring queries_requests_quota_test.go. Each test seeds temporary user(s)
// and cleans up every notification row it created (CASCADE from the user backs
// it up). The load-bearing case is the dedup guard: the 5s request monitor must
// not be able to create duplicate notifications for the same (user, request,
// type) — CreateNotification returns created=false on conflict so the caller
// skips re-pushing over WebSocket.

import (
	"context"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

// TestCreateNotificationDedup verifies the ON CONFLICT (user_id, request_id,
// type) guard: a second identical create returns created=false (no duplicate),
// while a different type for the same request inserts a new row.
func TestCreateNotificationDedup(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM notifications WHERE user_id = $1`, userID)
	})

	rid := int64(424242)
	mk := func(typ string) *models.Notification {
		return &models.Notification{UserID: userID, Type: typ, Title: "Hook", MediaType: "movie", RequestID: &rid}
	}

	n1 := mk(models.NotificationRequestAvailable)
	created, err := q.CreateNotification(context.Background(), n1)
	if err != nil || !created {
		t.Fatalf("first create: created=%v err=%v", created, err)
	}
	if n1.ID == 0 || n1.CreatedAt.IsZero() {
		t.Errorf("first create must populate id/created_at: %+v", n1)
	}

	created2, err := q.CreateNotification(context.Background(), mk(models.NotificationRequestAvailable))
	if err != nil {
		t.Fatalf("second create err: %v", err)
	}
	if created2 {
		t.Errorf("duplicate (same user+request+type) must dedupe to created=false")
	}

	created3, err := q.CreateNotification(context.Background(), mk(models.NotificationRequestFailed))
	if err != nil || !created3 {
		t.Errorf("different type for same request should insert: created=%v err=%v", created3, err)
	}
}

// TestListAndUnreadNotifications verifies newest-first ordering, per-user scoping,
// field round-trip, and the unread count.
func TestListAndUnreadNotifications(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	other := seedTestUser(t, q)
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM notifications WHERE user_id = ANY($1)`, []int64{userID, other})
	})

	r1, r2 := int64(1), int64(2)
	if _, err := q.CreateNotification(context.Background(), &models.Notification{UserID: userID, Type: models.NotificationRequestAvailable, Title: "First", MediaType: "movie", RequestID: &r1}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.CreateNotification(context.Background(), &models.Notification{UserID: userID, Type: models.NotificationRequestAvailable, Title: "Second", MediaType: "tv", RequestID: &r2}); err != nil {
		t.Fatal(err)
	}
	// Another user's notification must not leak into this user's feed.
	if _, err := q.CreateNotification(context.Background(), &models.Notification{UserID: other, Type: models.NotificationRequestAvailable, Title: "NotMine", RequestID: &r1}); err != nil {
		t.Fatal(err)
	}

	items, err := q.ListNotificationsForUser(context.Background(), userID, 50, true)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 items for user, got %d", len(items))
	}
	if items[0].Title != "Second" || items[1].Title != "First" {
		t.Errorf("want newest-first (Second, First); got (%q, %q)", items[0].Title, items[1].Title)
	}
	if items[0].RequestID == nil || *items[0].RequestID != r2 {
		t.Errorf("request_id should round-trip; got %v", items[0].RequestID)
	}
	if items[0].ReadAt != nil {
		t.Errorf("fresh notification should be unread (read_at nil)")
	}

	if unread, err := q.CountUnreadNotifications(context.Background(), userID, true); err != nil || unread != 2 {
		t.Errorf("unread=%d err=%v, want 2", unread, err)
	}
}

// TestMarkNotificationRead verifies ownership scoping (a user can't mark another
// user's notification) and that marking read decrements the unread count.
func TestMarkNotificationRead(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	other := seedTestUser(t, q)
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM notifications WHERE user_id = ANY($1)`, []int64{userID, other})
	})

	r1 := int64(7)
	n := &models.Notification{UserID: userID, Type: models.NotificationRequestAvailable, Title: "X", RequestID: &r1}
	if _, err := q.CreateNotification(context.Background(), n); err != nil {
		t.Fatal(err)
	}

	// A different user must not be able to mark this notification read.
	if err := q.MarkNotificationRead(context.Background(), n.ID, other, true); err != nil {
		t.Fatalf("cross-user mark errored: %v", err)
	}
	if u, _ := q.CountUnreadNotifications(context.Background(), userID, true); u != 1 {
		t.Errorf("cross-user mark must not affect owner's unread; got %d, want 1", u)
	}

	// The owner can.
	if err := q.MarkNotificationRead(context.Background(), n.ID, userID, true); err != nil {
		t.Fatal(err)
	}
	if u, _ := q.CountUnreadNotifications(context.Background(), userID, true); u != 0 {
		t.Errorf("after owner read, unread=%d, want 0", u)
	}
}

// TestMarkAllNotificationsRead verifies the bulk clear.
func TestMarkAllNotificationsRead(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM notifications WHERE user_id = $1`, userID)
	})

	for i := int64(1); i <= 3; i++ {
		ri := i
		if _, err := q.CreateNotification(context.Background(), &models.Notification{UserID: userID, Type: models.NotificationRequestAvailable, Title: "n", RequestID: &ri}); err != nil {
			t.Fatal(err)
		}
	}
	if u, _ := q.CountUnreadNotifications(context.Background(), userID, true); u != 3 {
		t.Fatalf("setup unread=%d, want 3", u)
	}
	if err := q.MarkAllNotificationsRead(context.Background(), userID, true); err != nil {
		t.Fatal(err)
	}
	if u, _ := q.CountUnreadNotifications(context.Background(), userID, true); u != 0 {
		t.Errorf("after mark-all, unread=%d, want 0", u)
	}
}

// TestAdminAlertsAreShownOnlyWithAdminAlerts: without adminAlerts (a session
// acting as a restricted profile on an admin account) the list, the unread
// count and both read-marking queries leave out the admin-only types. The
// filter is in SQL, so LIMIT counts only the rows shown: the member rows
// here are OLDER than a full page of admin alerts, and a filter applied after
// LIMIT would return none of them.
func TestAdminAlertsAreShownOnlyWithAdminAlerts(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM notifications WHERE user_id = $1`, userID)
	})

	seed := func(typ string, rid *int64, age time.Duration) int64 {
		t.Helper()
		n := &models.Notification{UserID: userID, Type: typ, Title: typ, RequestID: rid}
		if created, err := q.CreateNotification(ctx, n); err != nil || !created {
			t.Fatalf("seed %s: created=%v err=%v", typ, created, err)
		}
		// Pin the order: created_at is NOW() for every row of a fast test.
		if _, err := q.pool.Exec(ctx, `UPDATE notifications SET created_at = NOW() - $2::interval WHERE id = $1`, n.ID, age.String()); err != nil {
			t.Fatalf("age %s: %v", typ, err)
		}
		return n.ID
	}
	var member []int64
	for i := int64(1); i <= 3; i++ {
		rid := 9000 + i
		member = append(member, seed(models.NotificationRequestAvailable, &rid, time.Duration(10+i)*time.Hour))
	}
	var alerts []int64
	for i := int64(1); i <= 3; i++ {
		rid := 9100 + i
		alerts = append(alerts, seed(models.NotificationAdminNewRequest, &rid, time.Duration(i)*time.Hour))
		alerts = append(alerts, seed(models.NotificationScanComplete, nil, time.Duration(i)*time.Hour+time.Minute))
	}

	ids := func(adminAlerts bool, limit int) []int64 {
		t.Helper()
		items, err := q.ListNotificationsForUser(ctx, userID, limit, adminAlerts)
		if err != nil {
			t.Fatalf("list: %v", err)
		}
		var out []int64
		for _, n := range items {
			out = append(out, n.ID)
		}
		return out
	}
	unread := func(adminAlerts bool) int {
		t.Helper()
		n, err := q.CountUnreadNotifications(ctx, userID, adminAlerts)
		if err != nil {
			t.Fatalf("count: %v", err)
		}
		return n
	}

	if got := ids(true, 50); len(got) != len(member)+len(alerts) {
		t.Errorf("with admin alerts: %d rows, want %d", len(got), len(member)+len(alerts))
	}
	if got := unread(true); got != len(member)+len(alerts) {
		t.Errorf("with admin alerts: unread %d, want %d", got, len(member)+len(alerts))
	}
	got := ids(false, 3)
	if len(got) != 3 || got[0] != member[0] || got[1] != member[1] || got[2] != member[2] {
		t.Errorf("without admin alerts, a page of 3: %v, want the member rows %v", got, member)
	}
	if got := unread(false); got != len(member) {
		t.Errorf("without admin alerts: unread %d, want %d", got, len(member))
	}

	// Marking read without admin alerts leaves them unread: one by its id,
	// then all.
	if err := q.MarkNotificationRead(ctx, alerts[0], userID, false); err != nil {
		t.Fatalf("mark an admin alert read: %v", err)
	}
	if err := q.MarkAllNotificationsRead(ctx, userID, false); err != nil {
		t.Fatalf("mark all read: %v", err)
	}
	if got := unread(false); got != 0 {
		t.Errorf("after mark-all without admin alerts: unread %d of the rows shown, want 0", got)
	}
	if got := unread(true); got != len(alerts) {
		t.Errorf("after mark-all without admin alerts: %d unread in all, want the %d admin alerts", got, len(alerts))
	}
	// With them, they can be marked read.
	if err := q.MarkNotificationRead(ctx, alerts[0], userID, true); err != nil {
		t.Fatalf("mark an admin alert read: %v", err)
	}
	if got := unread(true); got != len(alerts)-1 {
		t.Errorf("after marking one admin alert read: %d unread, want %d", got, len(alerts)-1)
	}
	if err := q.MarkAllNotificationsRead(ctx, userID, true); err != nil {
		t.Fatalf("mark all read: %v", err)
	}
	if got := unread(true); got != 0 {
		t.Errorf("after mark-all with admin alerts: %d unread, want 0", got)
	}
}
