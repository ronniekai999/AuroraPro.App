package db

// UpdatePartyHost integration coverage (host succession, 2026-08).
//
// The watchparty manager's unit suite runs with queries == nil, so
// deleting the UpdatePartyHost call there would pass every test — this
// is the only place the persistence half of a handoff is pinned: the row
// follows the crown while the party is active, and the is_active gate
// makes an update racing a party's end a no-op instead of a corruption.
//
// Reuses the jsonb integration file's seed helpers (user → library →
// media item) to satisfy watch_parties' FK chain; skips without a DB via
// requireIntegrationDB like every other integration test here.

import (
	"context"
	"testing"
	"time"

	"github.com/aurora-media/aurora/internal/models"
)

func seedTestParty(t *testing.T, q *Queries, hostID, mediaItemID int64) *models.WatchParty {
	t.Helper()
	party := &models.WatchParty{
		PartyCode:       "HS" + randomSuffix(t)[:4],
		HostUserID:      hostID,
		MediaItemID:     mediaItemID,
		MaxParticipants: 5,
		IsActive:        true,
		CreatedAt:       time.Now(),
	}
	if err := q.InsertWatchParty(context.Background(), party); err != nil {
		t.Fatalf("seed party: %v", err)
	}
	t.Cleanup(func() {
		_, _ = q.pool.Exec(context.Background(), `DELETE FROM watch_parties WHERE id = $1`, party.ID)
	})
	return party
}

func TestUpdatePartyHost_FollowsTheCrown(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	hostID := seedTestUser(t, q)
	successorID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, hostID)
	mediaID := seedTestMediaItem(t, q, libID)
	party := seedTestParty(t, q, hostID, mediaID)

	if err := q.UpdatePartyHost(ctx, party.ID, successorID); err != nil {
		t.Fatalf("UpdatePartyHost: %v", err)
	}
	var gotHost int64
	if err := q.pool.QueryRow(ctx,
		`SELECT host_user_id FROM watch_parties WHERE id = $1`, party.ID,
	).Scan(&gotHost); err != nil {
		t.Fatalf("read back host: %v", err)
	}
	if gotHost != successorID {
		t.Errorf("host_user_id = %d, want %d", gotHost, successorID)
	}
}

func TestUpdatePartyHost_NoOpOnEndedParty(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	hostID := seedTestUser(t, q)
	successorID := seedTestUser(t, q)
	libID := seedTestLibrary(t, q, hostID)
	mediaID := seedTestMediaItem(t, q, libID)
	party := seedTestParty(t, q, hostID, mediaID)

	if err := q.EndWatchParty(ctx, party.ID); err != nil {
		t.Fatalf("end party: %v", err)
	}
	// The is_active gate: a handoff racing the party's end must not flip
	// the host on a row that is already history.
	if err := q.UpdatePartyHost(ctx, party.ID, successorID); err != nil {
		t.Fatalf("UpdatePartyHost on ended party errored (want silent no-op): %v", err)
	}
	var gotHost int64
	if err := q.pool.QueryRow(ctx,
		`SELECT host_user_id FROM watch_parties WHERE id = $1`, party.ID,
	).Scan(&gotHost); err != nil {
		t.Fatalf("read back host: %v", err)
	}
	if gotHost != hostID {
		t.Errorf("ended party's host_user_id = %d, want unchanged %d", gotHost, hostID)
	}
}
