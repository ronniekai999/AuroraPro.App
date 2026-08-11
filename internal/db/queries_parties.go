package db

import (
	"context"
	"fmt"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// ============================================================
// Watch Parties
// ============================================================

// InsertWatchParty creates a new watch party row. On success, the party's ID
// is populated from the RETURNING clause.
//
// scheduled_start_at and started_at are nullable; pass nil pointers in the
// model to leave them unset. Phase 1 of the countdown feature populates
// scheduled_start_at at insert time if the host provided a future start
// timestamp on CreatePartyRequest; started_at is always NULL on insert and
// is filled later by MarkPartyStarted when playback actually begins.
func (q *Queries) InsertWatchParty(ctx context.Context, party *models.WatchParty) error {
	err := q.pool.QueryRow(ctx,
		// settings_json is JSONB; pgx serializes Go string as text and
		// Postgres rejects the implicit cast under strict checking.
		// Same fix as InsertRoom — explicit ::jsonb on the parameter.
		// Empty string is normalized to the empty object so we never
		// send a literal `""` (invalid jsonb) into the column.
		`INSERT INTO watch_parties (
			party_code, host_user_id, media_item_id, episode_id,
			party_name, media_title, media_poster,
			max_participants, is_active, settings_json, created_at,
			scheduled_start_at, started_at, room_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE(NULLIF($10, ''), '{}')::jsonb, $11, $12, $13, $14)
		RETURNING id`,
		party.PartyCode,
		party.HostUserID,
		party.MediaItemID,
		party.EpisodeID,
		party.PartyName,
		party.MediaTitle,
		party.MediaPoster,
		party.MaxParticipants,
		party.IsActive,
		party.SettingsJSON,
		party.CreatedAt,
		party.ScheduledStartAt,
		party.StartedAt,
		party.RoomID, // nullable; pre-M3 callers can pass nil and rows
		// will still insert (NOT NULL is enforced in code,
		// not DB, since historical rows have NULL room_id)
	).Scan(&party.ID)
	if err != nil {
		return fmt.Errorf("insert watch party: %w", err)
	}
	return nil
}

// UpdatePartySchedule sets (or clears) the scheduled_start_at for an active
// party. Passing nil clears the schedule, reverting the party to "host plays
// manually". Returns sql.ErrNoRows-equivalent indirectly: if the UPDATE
// matches zero rows, the caller should treat as "party not found / inactive"
// and return a 404. Host-only; the API handler must enforce authorization
// before calling this.
func (q *Queries) UpdatePartySchedule(ctx context.Context, partyID int64, scheduledStartAt *time.Time) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE watch_parties SET scheduled_start_at = $1 WHERE id = $2 AND is_active = true`,
		scheduledStartAt, partyID,
	)
	if err != nil {
		return fmt.Errorf("update party schedule: %w", err)
	}
	return nil
}

// UpdatePartyMedia swaps the active party's media to a new item/episode.
// Used when the host triggers episode auto-advance (or a future "change
// what we're watching" host action). Update is gated by is_active=true so
// a race where the party ended just before this fires is a no-op rather
// than a corruption. Host-only; the API handler must enforce authorization
// before calling this.
func (q *Queries) UpdatePartyMedia(ctx context.Context, partyID int64, mediaItemID int64, episodeID *int64, mediaTitle, mediaPoster string) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE watch_parties
		    SET media_item_id = $1,
		        episode_id    = $2,
		        media_title   = $3,
		        media_poster  = $4
		  WHERE id = $5 AND is_active = true`,
		mediaItemID, episodeID, mediaTitle, mediaPoster, partyID,
	)
	if err != nil {
		return fmt.Errorf("update party media: %w", err)
	}
	return nil
}

// PartyMediaTargetExists reports whether a media item exists and, when
// episodeID is non-nil, whether that episode genuinely belongs to it.
//
// Issue #460 — the `change-media` room message takes both ids straight off
// the wire, and the only check before this was `media_item_id > 0`. An
// inconsistent pair passed the in-memory state mutation and then failed the
// FK inside UpdatePartyMedia's fire-and-forget goroutine, which only warns:
// the party would play one thing while the row said another, and a restart
// rehydrated the stale row. Validating before the swap keeps memory and disk
// agreeing.
//
// The episode check constrains media_item_id on BOTH the episode and its
// season, mirroring GetEpisodes' defense against a drifted season_id — an
// episode row pointing at another show's season must not validate.
func (q *Queries) PartyMediaTargetExists(ctx context.Context, mediaItemID int64, episodeID *int64) (bool, error) {
	var exists bool
	if episodeID == nil {
		if err := q.pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM media_items WHERE id = $1)`,
			mediaItemID,
		).Scan(&exists); err != nil {
			return false, fmt.Errorf("check party media target: %w", err)
		}
		return exists, nil
	}
	if err := q.pool.QueryRow(ctx,
		`SELECT EXISTS(
		     SELECT 1
		       FROM tv_episodes e
		       JOIN tv_seasons  s ON s.id = e.season_id
		      WHERE e.id            = $1
		        AND e.media_item_id = $2
		        AND s.media_item_id = $2
		 )`,
		*episodeID, mediaItemID,
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("check party episode target: %w", err)
	}
	return exists, nil
}

// UpdatePartyHost persists a host-succession handoff — the previous host
// left (or timed out of the disconnect grace) and a remaining participant
// inherited the party. Gated on is_active so a party that ended in the
// same instant is a no-op rather than a corruption. The in-memory
// PartyState is the live authority; this row feeds crash recovery and the
// share-image lookup.
func (q *Queries) UpdatePartyHost(ctx context.Context, partyID, hostUserID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE watch_parties SET host_user_id = $1 WHERE id = $2 AND is_active = true`,
		hostUserID, partyID,
	)
	if err != nil {
		return fmt.Errorf("update party host: %w", err)
	}
	return nil
}

// MarkPartyStarted stamps started_at to the given time. Called either when
// the scheduled-start timer fires, or when the host manually plays an
// unscheduled party for the first time. Idempotent at the DB layer — calling
// twice just overwrites with the new timestamp; the Manager guards against
// double-firing in memory.
func (q *Queries) MarkPartyStarted(ctx context.Context, partyID int64, startedAt time.Time) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE watch_parties SET started_at = $1 WHERE id = $2 AND is_active = true`,
		startedAt, partyID,
	)
	if err != nil {
		return fmt.Errorf("mark party started: %w", err)
	}
	return nil
}

// GetWatchPartyByCode retrieves an active watch party by its 6-character code.
// Returns nil if no active party with that code exists. RoomID is populated
// for parties created post-021 migration; pre-migration parties have NULL
// room_id (only relevant for historical inactive rows — active parties
// were backfilled during migration).
func (q *Queries) GetWatchPartyByCode(ctx context.Context, code string) (*models.WatchParty, error) {
	party := &models.WatchParty{}
	err := q.pool.QueryRow(ctx,
		`SELECT id, party_code, host_user_id, media_item_id, episode_id,
			party_name, media_title, media_poster,
			max_participants, is_active, COALESCE(settings_json, '{}'),
			created_at, ended_at, scheduled_start_at, started_at, room_id
		FROM watch_parties
		WHERE party_code = $1 AND is_active = true`,
		code,
	).Scan(
		&party.ID,
		&party.PartyCode,
		&party.HostUserID,
		&party.MediaItemID,
		&party.EpisodeID,
		&party.PartyName,
		&party.MediaTitle,
		&party.MediaPoster,
		&party.MaxParticipants,
		&party.IsActive,
		&party.SettingsJSON,
		&party.CreatedAt,
		&party.EndedAt,
		&party.ScheduledStartAt,
		&party.StartedAt,
		&party.RoomID,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get watch party by code: %w", err)
	}
	return party, nil
}

// GetWatchPartyByCodeAny retrieves a watch party by code regardless of active
// status. Used for viewing ended party info. Persistent rooms reuse their
// join code across sessions, so several rows can match — the ORDER BY pins
// the result to the newest session (previously QueryRow picked an arbitrary
// row from the multi-row result).
func (q *Queries) GetWatchPartyByCodeAny(ctx context.Context, code string) (*models.WatchParty, error) {
	party := &models.WatchParty{}
	err := q.pool.QueryRow(ctx,
		`SELECT id, party_code, host_user_id, media_item_id, episode_id,
			party_name, media_title, media_poster,
			max_participants, is_active, COALESCE(settings_json, '{}'),
			created_at, ended_at, scheduled_start_at, started_at
		FROM watch_parties
		WHERE party_code = $1
		ORDER BY created_at DESC
		LIMIT 1`,
		code,
	).Scan(
		&party.ID,
		&party.PartyCode,
		&party.HostUserID,
		&party.MediaItemID,
		&party.EpisodeID,
		&party.PartyName,
		&party.MediaTitle,
		&party.MediaPoster,
		&party.MaxParticipants,
		&party.IsActive,
		&party.SettingsJSON,
		&party.CreatedAt,
		&party.EndedAt,
		&party.ScheduledStartAt,
		&party.StartedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get watch party by code (any): %w", err)
	}
	return party, nil
}

// IsPartyMemberForCode reports whether userID hosted or participated in party
// partyDBID, additionally requiring that row to carry code — so a URL can't
// mix one session's code with another session's id. found=false when no such
// (id, code) row exists. Single round trip on purpose: the highlight-reel
// handler runs this per HTTP Range request during MP4 playback.
func (q *Queries) IsPartyMemberForCode(ctx context.Context, partyDBID int64, code string, userID int64) (found, member bool, err error) {
	err = q.pool.QueryRow(ctx, `
		SELECT host_user_id = $3 OR EXISTS (
			SELECT 1 FROM watch_party_participants
			WHERE party_id = $1 AND user_id = $3
		)
		FROM watch_parties
		WHERE id = $1 AND party_code = $2`,
		partyDBID, code, userID,
	).Scan(&member)
	if err != nil {
		if err == pgx.ErrNoRows {
			return false, false, nil
		}
		return false, false, fmt.Errorf("is party member: %w", err)
	}
	return true, member, nil
}

// EndWatchParty marks a watch party as inactive and records the end time.
func (q *Queries) EndWatchParty(ctx context.Context, id int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE watch_parties SET is_active = false, ended_at = $1 WHERE id = $2`,
		time.Now(), id,
	)
	if err != nil {
		return fmt.Errorf("end watch party: %w", err)
	}
	return nil
}

// ============================================================
// Watch Party Participants
// ============================================================

// InsertParticipant records a user joining a party. Uses ON CONFLICT to handle
// re-joins: if the user previously left and re-joins, the left_at timestamp is
// cleared and joined_at is updated.
func (q *Queries) InsertParticipant(ctx context.Context, partyID, userID int64) error {
	_, err := q.pool.Exec(ctx,
		`INSERT INTO watch_party_participants (party_id, user_id, joined_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (party_id, user_id) DO UPDATE SET
			joined_at = EXCLUDED.joined_at,
			left_at = NULL`,
		partyID, userID, time.Now(),
	)
	if err != nil {
		return fmt.Errorf("insert participant: %w", err)
	}
	return nil
}

// UpdateParticipantLeft records the time a user left a party.
func (q *Queries) UpdateParticipantLeft(ctx context.Context, partyID, userID int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE watch_party_participants SET left_at = $1
		WHERE party_id = $2 AND user_id = $3`,
		time.Now(), partyID, userID,
	)
	if err != nil {
		return fmt.Errorf("update participant left: %w", err)
	}
	return nil
}

// GetActivePartyCount returns the count of currently active watch parties.
func (q *Queries) GetActivePartyCount(ctx context.Context) (int64, error) {
	var count int64
	err := q.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM watch_parties WHERE is_active = true`,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("get active party count: %w", err)
	}
	return count, nil
}

// GetActivePartiesForUser returns active parties where the user is currently
// participating (left_at IS NULL) or all active public parties.
func (q *Queries) GetActivePartiesForUser(ctx context.Context, userID int64) ([]models.WatchParty, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT DISTINCT wp.id, wp.party_code, wp.host_user_id, wp.media_item_id,
			wp.episode_id, wp.party_name, wp.media_title, wp.media_poster,
			wp.max_participants, wp.is_active, COALESCE(wp.settings_json, '{}'),
			wp.created_at, wp.ended_at, wp.scheduled_start_at, wp.started_at
		FROM watch_parties wp
		LEFT JOIN watch_party_participants wpp ON wp.id = wpp.party_id AND wpp.user_id = $1 AND wpp.left_at IS NULL
		WHERE wp.is_active = true
			AND (wpp.user_id IS NOT NULL OR wp.host_user_id = $1)
		ORDER BY wp.created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("get active parties for user: %w", err)
	}
	defer rows.Close()

	var parties []models.WatchParty
	for rows.Next() {
		var p models.WatchParty
		if err := rows.Scan(
			&p.ID,
			&p.PartyCode,
			&p.HostUserID,
			&p.MediaItemID,
			&p.EpisodeID,
			&p.PartyName,
			&p.MediaTitle,
			&p.MediaPoster,
			&p.MaxParticipants,
			&p.IsActive,
			&p.SettingsJSON,
			&p.CreatedAt,
			&p.EndedAt,
			&p.ScheduledStartAt,
			&p.StartedAt,
		); err != nil {
			return nil, fmt.Errorf("scan active party: %w", err)
		}
		parties = append(parties, p)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}

	return parties, nil
}

// GetPartyParticipants returns all participants for a given party, including
// those who have left (with their left_at time).
func (q *Queries) GetPartyParticipants(ctx context.Context, partyID int64) ([]models.WatchPartyParticipant, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT wpp.id, wpp.party_id, wpp.user_id, wpp.joined_at, wpp.left_at,
			COALESCE(u.username, '')
		FROM watch_party_participants wpp
		LEFT JOIN users u ON u.id = wpp.user_id
		WHERE wpp.party_id = $1
		ORDER BY wpp.joined_at ASC`,
		partyID,
	)
	if err != nil {
		return nil, fmt.Errorf("get party participants: %w", err)
	}
	defer rows.Close()

	var participants []models.WatchPartyParticipant
	for rows.Next() {
		var p models.WatchPartyParticipant
		if err := rows.Scan(
			&p.ID,
			&p.PartyID,
			&p.UserID,
			&p.JoinedAt,
			&p.LeftAt,
			&p.Username,
		); err != nil {
			return nil, fmt.Errorf("scan participant: %w", err)
		}
		participants = append(participants, p)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}

	return participants, nil
}
