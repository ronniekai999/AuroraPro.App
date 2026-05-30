package db

// Integration tests pinning the idempotency contract of UpsertWatchProgress:
// the function must report newlyCompleted=true ONLY on the call that first
// transitions a row into completed=true, and false on every subsequent call.
//
// This backs the "MarkWatched XP/achievement farming" security fix: the API
// handlers gate the one-time gamification XP/achievement grant on this bool, so
// completing a title awards exactly once and replaying the endpoint awards
// nothing. If this contract regresses, the farming hole reopens silently.
//
// Opt-in: set TEST_DATABASE_URL=postgres://... to run (same harness as the JSONB
// integration tests — see queries_jsonb_integration_test.go for the helpers
// reused here). Skipped when unset so the unit suite stays standalone.

import (
	"context"
	"testing"

	"github.com/aurora-media/aurora/internal/models"
)

// seedDefaultProfile creates the user's default profile so the NOT NULL
// watch_progress.profile_id column (migration 029) resolves. Cleanup is handled
// by the seedTestUser CASCADE, but we delete explicitly for symmetry.
func seedDefaultProfile(t *testing.T, q *Queries, userID int64) int64 {
	t.Helper()
	p, err := q.CreateDefaultProfileForUser(context.Background(), userID, "idem_test")
	if err != nil {
		t.Fatalf("seed default profile: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM user_profiles WHERE id = $1`, p.ID)
	})
	return p.ID
}

// TestUpsertWatchProgress_NewlyCompletedIdempotent covers the movie (episode_id
// IS NULL) path: a first completing upsert reports newlyCompleted=true; replays
// — and even a fresh-but-already-completed re-mark — report false.
func TestUpsertWatchProgress_NewlyCompletedIdempotent(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libraryID := seedTestLibrary(t, q, userID)
	mediaID := seedTestMediaItem(t, q, libraryID)

	mark := func() bool {
		t.Helper()
		newly, err := q.UpsertWatchProgress(context.Background(), &models.WatchProgress{
			UserID:      userID,
			ProfileID:   profileID,
			MediaItemID: mediaID,
			Completed:   true,
		})
		if err != nil {
			t.Fatalf("UpsertWatchProgress: %v", err)
		}
		return newly
	}

	if got := mark(); !got {
		t.Fatalf("first completing upsert: newlyCompleted = false, want true")
	}
	if got := mark(); got {
		t.Errorf("replay upsert: newlyCompleted = true, want false (farming guard)")
	}
	if got := mark(); got {
		t.Errorf("second replay upsert: newlyCompleted = true, want false")
	}
}

// TestUpsertWatchProgress_IncompleteThenComplete covers the heartbeat path: an
// in-progress upsert (below threshold) must report false, and the later upsert
// that crosses into completed must report true exactly once. This is the
// "UpdateProgress reaching >= 90% grants XP" contract.
func TestUpsertWatchProgress_IncompleteThenComplete(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libraryID := seedTestLibrary(t, q, userID)
	mediaID := seedTestMediaItem(t, q, libraryID)

	upsert := func(posMs, durMs int64) bool {
		t.Helper()
		newly, err := q.UpsertWatchProgress(context.Background(), &models.WatchProgress{
			UserID:      userID,
			ProfileID:   profileID,
			MediaItemID: mediaID,
			PositionMs:  posMs,
			DurationMs:  durMs,
		})
		if err != nil {
			t.Fatalf("UpsertWatchProgress: %v", err)
		}
		return newly
	}

	// 50% — below the 0.90 default threshold, not completed.
	if got := upsert(5000, 10000); got {
		t.Errorf("mid-playback upsert: newlyCompleted = true, want false")
	}
	// 95% — crosses the threshold, first completion.
	if got := upsert(9500, 10000); !got {
		t.Fatalf("threshold-crossing upsert: newlyCompleted = false, want true")
	}
	// Another heartbeat at/after completion — already completed, no re-award.
	if got := upsert(9800, 10000); got {
		t.Errorf("post-completion heartbeat: newlyCompleted = true, want false")
	}
}

// TestUpsertWatchProgress_RewindDoesNotRefarm pins the monotonic-completion guard
// behind the XP-farming fix. Once a row is completed, scrubbing BACK below the
// threshold must NOT un-complete it, so re-crossing awards nothing. With a
// non-monotonic `completed = EXCLUDED.completed`, the rewind would flip the row
// back to incomplete and the re-cross would report newlyCompleted=true again — the
// exact farming vector (alternating position_ms {duration_ms, 0} to harvest +50 XP
// per cycle via the UpdateProgress->AwardForWatch wiring). The genuine "watch
// again" path is DELETE /api/progress/{id}, which removes the row so a fresh INSERT
// awards once.
func TestUpsertWatchProgress_RewindDoesNotRefarm(t *testing.T) {
	q := requireIntegrationDB(t)
	userID := seedTestUser(t, q)
	profileID := seedDefaultProfile(t, q, userID)
	libraryID := seedTestLibrary(t, q, userID)
	mediaID := seedTestMediaItem(t, q, libraryID)

	upsert := func(posMs, durMs int64) bool {
		t.Helper()
		newly, err := q.UpsertWatchProgress(context.Background(), &models.WatchProgress{
			UserID:      userID,
			ProfileID:   profileID,
			MediaItemID: mediaID,
			PositionMs:  posMs,
			DurationMs:  durMs,
		})
		if err != nil {
			t.Fatalf("UpsertWatchProgress: %v", err)
		}
		return newly
	}

	// Finish the title — the first (and only) award.
	if got := upsert(9500, 10000); !got {
		t.Fatalf("first completion: newlyCompleted = false, want true")
	}
	// Scrub back to 10% — must NOT re-award and must NOT un-complete the row.
	if got := upsert(1000, 10000); got {
		t.Errorf("rewind below threshold: newlyCompleted = true, want false")
	}
	if wp, err := q.GetWatchProgress(context.Background(), userID, mediaID, nil); err != nil {
		t.Fatalf("GetWatchProgress after rewind: %v", err)
	} else if wp == nil || !wp.Completed {
		t.Errorf("row un-completed by a sub-threshold rewind; want completed=true (monotonic)")
	}
	// Re-cross the threshold — still no second award (the farming guard).
	if got := upsert(9600, 10000); got {
		t.Errorf("re-cross after rewind: newlyCompleted = true, want false (no re-farm)")
	}
}
