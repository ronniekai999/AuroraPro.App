package db

// Watch-party invites (migration 051). An invite is a durable link between a
// party row and an invited member, carrying the invitee's RSVP. Durability is
// the point: a scheduled party's roster must render before anyone has opened
// a WebSocket and must survive server restarts, so none of this state lives
// in the in-memory watchparty Manager.
//
// Authorization contract mirrors the rest of the query layer: these functions
// enforce row *ownership* in SQL where the operation is per-user
// (SetInviteRSVP), but host/membership checks for party-level operations are
// the API layer's job — the handlers are the only entry points.

import (
	"context"
	"fmt"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// CreatePartyInvite inserts one invite. Returns created=false (no error) when
// the (party, invitee) pair already exists — re-inviting is a no-op and MUST
// NOT reset the invitee's existing RSVP or note (the original invite wins).
// Callers use created to decide whether to fan out a notification, which is
// what stands in for table-level notification dedup (party invites carry no
// request_id, so the notifications dedup index doesn't apply to them).
func (q *Queries) CreatePartyInvite(ctx context.Context, partyID, inviterUserID, inviteeUserID int64, note string) (created bool, err error) {
	tag, err := q.pool.Exec(ctx,
		`INSERT INTO party_invites (party_id, inviter_user_id, invitee_user_id, note)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (party_id, invitee_user_id) DO NOTHING`,
		partyID, inviterUserID, inviteeUserID, note,
	)
	if err != nil {
		return false, fmt.Errorf("create party invite: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// ListInvitesForParty returns the member-visible invite roster for a party,
// hosts first in creation order. Avatar resolution matches memberSummaryCols
// (default sub-profile avatar, NULLIF-guarded, falling back to the account
// avatar) so the lobby renders the same face as /members. The handler still
// runs avatars through memberSafeAvatar before serializing — this query
// returns whatever is stored.
func (q *Queries) ListInvitesForParty(ctx context.Context, partyID int64) ([]models.PartyInviteRosterEntry, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT pi.id, u.id, u.username, u.display_name,
		        COALESCE(
		          NULLIF((SELECT p.avatar_url FROM user_profiles p
		            WHERE p.user_id = u.id AND p.is_default = TRUE
		            LIMIT 1), ''),
		          u.avatar_url, '') AS avatar_url,
		        pi.rsvp, pi.responded_at
		 FROM party_invites pi
		 JOIN users u ON u.id = pi.invitee_user_id
		 WHERE pi.party_id = $1
		 ORDER BY pi.created_at ASC, pi.id ASC`,
		partyID,
	)
	if err != nil {
		return nil, fmt.Errorf("list invites for party: %w", err)
	}
	defer rows.Close()

	var out []models.PartyInviteRosterEntry
	for rows.Next() {
		var e models.PartyInviteRosterEntry
		if err := rows.Scan(&e.InviteID, &e.UserID, &e.Username, &e.DisplayName, &e.AvatarURL, &e.RSVP, &e.RespondedAt); err != nil {
			return nil, fmt.Errorf("scan invite roster row: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// SetInviteRSVP updates the caller's RSVP on an invite, ownership-scoped in
// SQL (a foreign invite id cleanly reports found=false rather than 403ing at
// this layer). Returns the previous RSVP plus enough party context for the
// handler to notify the host on the pending→going transition without a
// second round-trip.
//
// The self-join against `prev` reads the statement snapshot (Postgres
// evaluates the FROM clause against pre-update row versions), which is what
// makes prev.rsvp the OLD value even though the RETURNING clause sees the
// new row.
func (q *Queries) SetInviteRSVP(ctx context.Context, inviteID, inviteeUserID int64, rsvp string) (prevRSVP string, party *models.WatchParty, found bool, err error) {
	party = &models.WatchParty{}
	err = q.pool.QueryRow(ctx,
		`UPDATE party_invites pi
		 SET rsvp = $3, responded_at = NOW()
		 FROM party_invites prev
		 JOIN watch_parties wp ON wp.id = prev.party_id
		 WHERE pi.id = $1 AND pi.invitee_user_id = $2 AND prev.id = pi.id
		 RETURNING prev.rsvp, wp.id, wp.party_code, wp.host_user_id, wp.media_title, wp.party_name, wp.is_active`,
		inviteID, inviteeUserID, rsvp,
	).Scan(&prevRSVP, &party.ID, &party.PartyCode, &party.HostUserID, &party.MediaTitle, &party.PartyName, &party.IsActive)
	if err == pgx.ErrNoRows {
		return "", nil, false, nil
	}
	if err != nil {
		return "", nil, false, fmt.Errorf("set invite rsvp: %w", err)
	}
	return prevRSVP, party, true, nil
}

// ListUpcomingInvitesForUser returns the caller's invites whose party is
// still active (scheduled, in the lobby, or already playing) — the feed
// behind the bell's RSVP rows and the Calendar's party chips. Ended parties
// drop out via is_active=false, so no time-window math is needed here.
// Declined invites are included: the UI needs them to render "you declined"
// instead of re-asking.
func (q *Queries) ListUpcomingInvitesForUser(ctx context.Context, userID int64) ([]models.MyPartyInvite, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT pi.id, wp.party_code, wp.party_name, wp.media_title, wp.media_poster,
		        hu.username, pi.rsvp, pi.note, wp.scheduled_start_at, wp.started_at, pi.created_at
		 FROM party_invites pi
		 JOIN watch_parties wp ON wp.id = pi.party_id AND wp.is_active = TRUE
		 JOIN users hu ON hu.id = wp.host_user_id
		 WHERE pi.invitee_user_id = $1
		 ORDER BY COALESCE(wp.scheduled_start_at, wp.created_at) ASC, pi.id ASC
		 LIMIT 100`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list upcoming invites: %w", err)
	}
	defer rows.Close()

	var out []models.MyPartyInvite
	for rows.Next() {
		var m models.MyPartyInvite
		if err := rows.Scan(&m.InviteID, &m.PartyCode, &m.PartyName, &m.MediaTitle, &m.MediaPoster,
			&m.HostUsername, &m.RSVP, &m.Note, &m.ScheduledStartAt, &m.StartedAt, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan upcoming invite: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ListInviteeUserIDsForReminder returns the user ids that should receive the
// T-10-minute reminder for a party: every invitee who hasn't declined. The
// host is added by the caller (the manager), which also owns the "did the
// schedule change since this timer was armed" validation.
func (q *Queries) ListInviteeUserIDsForReminder(ctx context.Context, partyID int64) ([]int64, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT invitee_user_id FROM party_invites
		 WHERE party_id = $1 AND rsvp <> 'declined'`,
		partyID,
	)
	if err != nil {
		return nil, fmt.Errorf("list reminder invitees: %w", err)
	}
	defer rows.Close()

	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan reminder invitee: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ListScheduledUnstartedParties returns active parties with a schedule that
// have not started yet, plus each party's room persistence flag — the exact
// set the Manager rehydrates at boot so scheduled parties (and the invites
// pointing at their codes) survive a server restart. Served by migration
// 019's idx_watch_parties_scheduled partial index.
//
// Parties whose scheduled time passed during downtime ARE included: the
// caller re-arms their timers, which fire immediately and take the party
// live, so /p/{code} links from invites keep working instead of 404ing.
func (q *Queries) ListScheduledUnstartedParties(ctx context.Context) ([]models.WatchParty, []bool, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT wp.id, wp.party_code, wp.host_user_id, wp.media_item_id, wp.episode_id,
		        wp.party_name, wp.media_title, wp.media_poster, wp.max_participants,
		        wp.settings_json, wp.created_at, wp.scheduled_start_at, wp.room_id,
		        COALESCE(r.is_persistent, FALSE)
		 FROM watch_parties wp
		 LEFT JOIN watch_party_rooms r ON r.id = wp.room_id AND r.deleted_at IS NULL
		 WHERE wp.is_active = TRUE
		   AND wp.scheduled_start_at IS NOT NULL
		   AND wp.started_at IS NULL
		 ORDER BY wp.scheduled_start_at ASC`,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("list scheduled parties: %w", err)
	}
	defer rows.Close()

	var parties []models.WatchParty
	var persistent []bool
	for rows.Next() {
		var p models.WatchParty
		var isPersistent bool
		if err := rows.Scan(&p.ID, &p.PartyCode, &p.HostUserID, &p.MediaItemID, &p.EpisodeID,
			&p.PartyName, &p.MediaTitle, &p.MediaPoster, &p.MaxParticipants,
			&p.SettingsJSON, &p.CreatedAt, &p.ScheduledStartAt, &p.RoomID, &isPersistent); err != nil {
			return nil, nil, fmt.Errorf("scan scheduled party: %w", err)
		}
		parties = append(parties, p)
		persistent = append(persistent, isPersistent)
	}
	return parties, persistent, rows.Err()
}
