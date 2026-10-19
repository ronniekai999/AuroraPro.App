package db

// Integration tests for the party_invites queries (migration 051).
//
// Opt-in via TEST_DATABASE_URL like every other integration test here.
// Reuses the jsonb file's seed helpers (user → library → media item) plus
// queries_party_host_test.go's seedTestParty for the watch_parties FK chain.
// Load-bearing cases:
//   * CreatePartyInvite's ON CONFLICT is the notification dedup layer — a
//     re-invite must report created=false AND must not clobber the
//     invitee's existing RSVP or note.
//   * SetInviteRSVP must return the PREVIOUS rsvp (the pending→going
//     transition is what gates the host "X is in" ping) and must be
//     ownership-scoped in SQL.
//   * ListUpcomingInvitesForUser must drop invites whose party ended.
//   * ListScheduledUnstartedParties must return exactly the rehydration
//     set: active + scheduled + unstarted.

import (
	"context"
	"testing"
	"time"
)

func TestCreatePartyInvite_DedupPreservesRSVP(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	host := seedTestUser(t, q)
	invitee := seedTestUser(t, q)
	lib := seedTestLibrary(t, q, host)
	media := seedTestMediaItem(t, q, lib)
	party := seedTestParty(t, q, host, media)

	created, err := q.CreatePartyInvite(ctx, party.ID, host, invitee, "bring snacks")
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	if !created {
		t.Fatal("first create reported created=false; want true")
	}

	// Invitee answers, then the host re-invites the same person.
	if _, _, found, err := q.SetInviteRSVP(ctx, mustInviteID(t, q, party.ID, invitee), invitee, "going"); err != nil || !found {
		t.Fatalf("rsvp: found=%v err=%v", found, err)
	}
	created, err = q.CreatePartyInvite(ctx, party.ID, host, invitee, "second note")
	if err != nil {
		t.Fatalf("re-invite: %v", err)
	}
	if created {
		t.Fatal("re-invite reported created=true; want false (dedup)")
	}

	// The original answer and note must survive the re-invite.
	var rsvp, note string
	if err := q.pool.QueryRow(ctx,
		`SELECT rsvp, note FROM party_invites WHERE party_id = $1 AND invitee_user_id = $2`,
		party.ID, invitee,
	).Scan(&rsvp, &note); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if rsvp != "going" {
		t.Errorf("rsvp after re-invite = %q; want going (re-invite must not reset the answer)", rsvp)
	}
	if note != "bring snacks" {
		t.Errorf("note after re-invite = %q; want the original", note)
	}
}

// mustInviteID resolves the invite row id for (party, invitee).
func mustInviteID(t *testing.T, q *Queries, partyID, inviteeID int64) int64 {
	t.Helper()
	var id int64
	if err := q.pool.QueryRow(context.Background(),
		`SELECT id FROM party_invites WHERE party_id = $1 AND invitee_user_id = $2`,
		partyID, inviteeID,
	).Scan(&id); err != nil {
		t.Fatalf("resolve invite id: %v", err)
	}
	return id
}

func TestSetInviteRSVP_PreviousValueAndOwnership(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	host := seedTestUser(t, q)
	invitee := seedTestUser(t, q)
	stranger := seedTestUser(t, q)
	lib := seedTestLibrary(t, q, host)
	media := seedTestMediaItem(t, q, lib)
	party := seedTestParty(t, q, host, media)

	if _, err := q.CreatePartyInvite(ctx, party.ID, host, invitee, ""); err != nil {
		t.Fatalf("create: %v", err)
	}
	inviteID := mustInviteID(t, q, party.ID, invitee)

	// A stranger can't answer someone else's invite: found=false, no change.
	if _, _, found, err := q.SetInviteRSVP(ctx, inviteID, stranger, "going"); err != nil {
		t.Fatalf("stranger rsvp: %v", err)
	} else if found {
		t.Fatal("stranger rsvp reported found=true; want false (ownership scoped in SQL)")
	}

	prev, p, found, err := q.SetInviteRSVP(ctx, inviteID, invitee, "going")
	if err != nil || !found {
		t.Fatalf("rsvp going: found=%v err=%v", found, err)
	}
	if prev != "pending" {
		t.Errorf("prev after first answer = %q; want pending", prev)
	}
	if p.ID != party.ID || p.HostUserID != host || !p.IsActive {
		t.Errorf("party context = %+v; want id=%d host=%d active", p, party.ID, host)
	}

	// Flip to maybe: previous must now read going (this is what stops a
	// second host ping — only pending→going notifies).
	prev, _, found, err = q.SetInviteRSVP(ctx, inviteID, invitee, "maybe")
	if err != nil || !found {
		t.Fatalf("rsvp maybe: found=%v err=%v", found, err)
	}
	if prev != "going" {
		t.Errorf("prev after flip = %q; want going", prev)
	}

	var respondedAt *time.Time
	if err := q.pool.QueryRow(ctx,
		`SELECT responded_at FROM party_invites WHERE id = $1`, inviteID,
	).Scan(&respondedAt); err != nil {
		t.Fatalf("read responded_at: %v", err)
	}
	if respondedAt == nil {
		t.Error("responded_at still NULL after an answer")
	}
}

func TestListInvitesForParty_RosterShape(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	host := seedTestUser(t, q)
	a := seedTestUser(t, q)
	b := seedTestUser(t, q)
	lib := seedTestLibrary(t, q, host)
	media := seedTestMediaItem(t, q, lib)
	party := seedTestParty(t, q, host, media)

	for _, id := range []int64{a, b} {
		if _, err := q.CreatePartyInvite(ctx, party.ID, host, id, ""); err != nil {
			t.Fatalf("create: %v", err)
		}
	}
	if _, _, _, err := q.SetInviteRSVP(ctx, mustInviteID(t, q, party.ID, a), a, "going"); err != nil {
		t.Fatalf("rsvp: %v", err)
	}

	roster, err := q.ListInvitesForParty(ctx, party.ID)
	if err != nil {
		t.Fatalf("roster: %v", err)
	}
	if len(roster) != 2 {
		t.Fatalf("roster size = %d; want 2", len(roster))
	}
	byUser := map[int64]string{}
	for _, e := range roster {
		if e.Username == "" {
			t.Errorf("roster entry for user %d missing username", e.UserID)
		}
		byUser[e.UserID] = e.RSVP
	}
	if byUser[a] != "going" || byUser[b] != "pending" {
		t.Errorf("rsvps = %v; want a=going b=pending", byUser)
	}
}

func TestListUpcomingInvitesForUser_DropsEndedParties(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	host := seedTestUser(t, q)
	invitee := seedTestUser(t, q)
	lib := seedTestLibrary(t, q, host)
	media := seedTestMediaItem(t, q, lib)

	live := seedTestParty(t, q, host, media)
	scheduled := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	if err := q.UpdatePartySchedule(ctx, live.ID, &scheduled); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	if _, err := q.CreatePartyInvite(ctx, live.ID, host, invitee, "see you there"); err != nil {
		t.Fatalf("create live invite: %v", err)
	}

	// A second party that ends before the read: its invite must vanish
	// from the feed (is_active=false is the only filter needed).
	host2 := seedTestUser(t, q)
	ended := seedTestParty(t, q, host2, media)
	if _, err := q.CreatePartyInvite(ctx, ended.ID, host2, invitee, ""); err != nil {
		t.Fatalf("create ended invite: %v", err)
	}
	if err := q.EndWatchParty(ctx, ended.ID); err != nil {
		t.Fatalf("end party: %v", err)
	}

	feed, err := q.ListUpcomingInvitesForUser(ctx, invitee, nil)
	if err != nil {
		t.Fatalf("feed: %v", err)
	}
	if len(feed) != 1 {
		t.Fatalf("feed size = %d; want 1 (ended party's invite must drop out)", len(feed))
	}
	got := feed[0]
	if got.PartyCode != live.PartyCode {
		t.Errorf("feed code = %q; want %q", got.PartyCode, live.PartyCode)
	}
	if got.RSVP != "pending" || got.Note != "see you there" {
		t.Errorf("feed row = %+v; want pending rsvp + note", got)
	}
	if got.ScheduledStartAt == nil || !got.ScheduledStartAt.Equal(scheduled) {
		t.Errorf("feed scheduled_start_at = %v; want %v", got.ScheduledStartAt, scheduled)
	}
	if got.HostUsername == "" {
		t.Error("feed missing host username")
	}
}

func TestListScheduledUnstartedParties_RehydrationSet(t *testing.T) {
	q := requireIntegrationDB(t)
	ctx := context.Background()

	host := seedTestUser(t, q)
	lib := seedTestLibrary(t, q, host)
	media := seedTestMediaItem(t, q, lib)

	// In: active + scheduled + unstarted.
	in := seedTestParty(t, q, host, media)
	at := time.Now().Add(90 * time.Minute).Truncate(time.Second)
	if err := q.UpdatePartySchedule(ctx, in.ID, &at); err != nil {
		t.Fatalf("schedule: %v", err)
	}

	// Out: scheduled but already started.
	host2 := seedTestUser(t, q)
	started := seedTestParty(t, q, host2, media)
	if err := q.UpdatePartySchedule(ctx, started.ID, &at); err != nil {
		t.Fatalf("schedule started: %v", err)
	}
	if err := q.MarkPartyStarted(ctx, started.ID, time.Now()); err != nil {
		t.Fatalf("mark started: %v", err)
	}

	// Out: never scheduled.
	host3 := seedTestUser(t, q)
	seedTestParty(t, q, host3, media)

	rows, persistent, err := q.ListScheduledUnstartedParties(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != len(persistent) {
		t.Fatalf("rows/persistent length mismatch: %d vs %d", len(rows), len(persistent))
	}
	var found bool
	for _, r := range rows {
		if r.ID == in.ID {
			found = true
			if r.ScheduledStartAt == nil || !r.ScheduledStartAt.Equal(at) {
				t.Errorf("scheduled_start_at = %v; want %v", r.ScheduledStartAt, at)
			}
		}
		if r.ID == started.ID {
			t.Error("started party included in rehydration set")
		}
	}
	if !found {
		t.Error("scheduled unstarted party missing from rehydration set")
	}
}
