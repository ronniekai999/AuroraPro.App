package db

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

func TestRecommendationWatchEventsLifecycle(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	mediaID := seedTestMediaItem(t, q, libID)

	write := func(position int64, completed bool) {
		t.Helper()
		if _, err := q.UpsertWatchProgress(ctx, &models.WatchProgress{
			UserID: userID, ProfileID: profileID, MediaItemID: mediaID,
			PositionMs: position, DurationMs: 100, Completed: completed,
		}); err != nil {
			t.Fatalf("progress %d: %v", position, err)
		}
	}
	write(10, false) // started
	write(15, false) // refreshes mutable activity without another ledger event
	write(25, false) // engaged
	write(95, false) // auto-completed
	write(5, false)  // new playback after completion -> started
	write(95, false) // completed again -> rewatch

	rows, err := q.pool.Query(ctx, `SELECT event_type FROM recommendation_watch_events WHERE profile_id=$1 AND media_item_id=$2 ORDER BY id`, profileID, mediaID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var event string
		if err := rows.Scan(&event); err != nil {
			t.Fatal(err)
		}
		got = append(got, event)
	}
	want := []string{"started", "engaged", "completed", "started", "rewatch_completed"}
	if len(got) != len(want) {
		t.Fatalf("events=%v want=%v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("events=%v want=%v", got, want)
		}
	}
}

func TestRecommendationWatchEventsConcurrentDefaultProfile(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libID := seedTestLibrary(t, q, userID)
	mediaID := seedTestMediaItem(t, q, libID)

	var newlyCompleted atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, suppliedProfileID := range []int64{0, profileID} {
		wg.Add(1)
		go func(pid int64) {
			defer wg.Done()
			<-start
			fresh, err := q.UpsertWatchProgress(ctx, &models.WatchProgress{
				UserID: userID, ProfileID: pid, MediaItemID: mediaID,
				PositionMs: 95, DurationMs: 100,
			})
			if err != nil {
				t.Errorf("concurrent progress (profile %d): %v", pid, err)
				return
			}
			if fresh {
				newlyCompleted.Add(1)
			}
		}(suppliedProfileID)
	}
	close(start)
	wg.Wait()

	var events int
	if err := q.pool.QueryRow(ctx, `SELECT COUNT(*) FROM recommendation_watch_events WHERE profile_id=$1 AND media_item_id=$2`, profileID, mediaID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if newlyCompleted.Load() != 1 || events != 1 {
		t.Fatalf("concurrent completion: newly_completed=%d events=%d, want 1/1", newlyCompleted.Load(), events)
	}
}
