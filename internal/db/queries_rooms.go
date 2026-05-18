package db

import (
	"context"
	"fmt"
	"time"

	"github.com/aurora-media/aurora/internal/models"
	"github.com/jackc/pgx/v5"
)

// ============================================================
// Watch Party Rooms (M3 — persistent rooms)
// ============================================================
//
// A "room" is the long-lived join target with a stable code. Quick parties
// create a non-persistent room (auto-soft-deleted on session end) so the
// existing "ephemeral party" mental model continues to work. Persistent
// rooms survive session ends, keeping their code stable so friends can
// bookmark and rejoin across many parties.
//
// All read queries gate on deleted_at IS NULL — soft-deleted rooms are
// invisible to lookup. The partial unique index on (code) WHERE deleted_at
// IS NULL enforces "one live room per code" matching the existing
// "one active party per code" semantic.

// InsertRoom creates a new room and populates room.ID from RETURNING.
// Caller is responsible for unique-code generation; this query relies
// on the partial unique index to reject collisions with live rooms.
func (q *Queries) InsertRoom(ctx context.Context, room *models.WatchPartyRoom) error {
	err := q.pool.QueryRow(ctx,
		// settings_json is JSONB. The COALESCE/NULLIF pair handles
		// empty-string → default-empty-object fallback, but the result
		// is text — Postgres rejects the implicit cast to jsonb under
		// strict checking. The explicit ::jsonb cast on the wrapped
		// expression is the surgical fix (vs. casting just $5, which
		// wouldn't help when $5 is an empty string).
		`INSERT INTO watch_party_rooms (
			code, name, owner_user_id, is_persistent, settings_json,
			created_at, last_active_at
		) VALUES ($1, $2, $3, $4, COALESCE(NULLIF($5, ''), '{}')::jsonb,
			COALESCE($6, NOW()), COALESCE($7, NOW()))
		RETURNING id`,
		room.Code,
		room.Name,
		room.OwnerUserID,
		room.IsPersistent,
		room.SettingsJSON,
		nullableTime(room.CreatedAt),
		nullableTime(room.LastActiveAt),
	).Scan(&room.ID)
	if err != nil {
		return fmt.Errorf("insert room: %w", err)
	}
	return nil
}

// GetRoomByCode returns the live room for the given code, or nil if no
// live room exists with that code. Soft-deleted rooms are NEVER returned —
// callers can rely on a nil return meaning "this code is available for
// reuse OR is occupied by a tombstoned room (effectively the same)".
func (q *Queries) GetRoomByCode(ctx context.Context, code string) (*models.WatchPartyRoom, error) {
	r := &models.WatchPartyRoom{}
	var settings *string
	var deletedAt *time.Time
	err := q.pool.QueryRow(ctx,
		`SELECT id, code, name, owner_user_id, is_persistent, settings_json,
		        created_at, last_active_at, deleted_at
		   FROM watch_party_rooms
		  WHERE code = $1 AND deleted_at IS NULL
		  LIMIT 1`,
		code,
	).Scan(
		&r.ID, &r.Code, &r.Name, &r.OwnerUserID, &r.IsPersistent,
		&settings, &r.CreatedAt, &r.LastActiveAt, &deletedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get room by code: %w", err)
	}
	if settings != nil {
		r.SettingsJSON = *settings
	}
	r.DeletedAt = deletedAt
	return r, nil
}

// GetRoomByID returns the room by primary key. Returns nil if not found
// or soft-deleted — callers should not act on tombstoned rooms.
func (q *Queries) GetRoomByID(ctx context.Context, id int64) (*models.WatchPartyRoom, error) {
	r := &models.WatchPartyRoom{}
	var settings *string
	var deletedAt *time.Time
	err := q.pool.QueryRow(ctx,
		`SELECT id, code, name, owner_user_id, is_persistent, settings_json,
		        created_at, last_active_at, deleted_at
		   FROM watch_party_rooms
		  WHERE id = $1 AND deleted_at IS NULL
		  LIMIT 1`,
		id,
	).Scan(
		&r.ID, &r.Code, &r.Name, &r.OwnerUserID, &r.IsPersistent,
		&settings, &r.CreatedAt, &r.LastActiveAt, &deletedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get room by id: %w", err)
	}
	if settings != nil {
		r.SettingsJSON = *settings
	}
	r.DeletedAt = deletedAt
	return r, nil
}

// ListRoomsForOwner returns all live rooms owned by the user, ordered
// by most-recently-active first. Used by the "My Rooms" UI in M4-M5.
// Includes both persistent rooms AND any in-flight quick-party rooms
// (the caller can filter by IsPersistent if it only wants the
// long-lived ones).
func (q *Queries) ListRoomsForOwner(ctx context.Context, ownerUserID int64) ([]*models.WatchPartyRoom, error) {
	rows, err := q.pool.Query(ctx,
		`SELECT id, code, name, owner_user_id, is_persistent, settings_json,
		        created_at, last_active_at, deleted_at
		   FROM watch_party_rooms
		  WHERE owner_user_id = $1 AND deleted_at IS NULL
		  ORDER BY last_active_at DESC`,
		ownerUserID,
	)
	if err != nil {
		return nil, fmt.Errorf("list rooms for owner: %w", err)
	}
	defer rows.Close()

	var out []*models.WatchPartyRoom
	for rows.Next() {
		r := &models.WatchPartyRoom{}
		var settings *string
		var deletedAt *time.Time
		if err := rows.Scan(
			&r.ID, &r.Code, &r.Name, &r.OwnerUserID, &r.IsPersistent,
			&settings, &r.CreatedAt, &r.LastActiveAt, &deletedAt,
		); err != nil {
			return nil, fmt.Errorf("scan room: %w", err)
		}
		if settings != nil {
			r.SettingsJSON = *settings
		}
		r.DeletedAt = deletedAt
		out = append(out, r)
	}
	return out, rows.Err()
}

// TouchRoom bumps last_active_at to NOW(). Called when a session starts
// or a participant joins so the "My Rooms" list orders by recent activity.
// Cheap UPDATE; failure is non-fatal (best-effort UX signal).
func (q *Queries) TouchRoom(ctx context.Context, id int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE watch_party_rooms SET last_active_at = NOW()
		  WHERE id = $1 AND deleted_at IS NULL`,
		id,
	)
	if err != nil {
		return fmt.Errorf("touch room: %w", err)
	}
	return nil
}

// SoftDeleteRoom tombstones a room by stamping deleted_at = NOW(). After
// this returns, the room's code is reusable (the partial unique index
// only covers live rooms) and the room disappears from ListRoomsForOwner.
//
// Quick-party rooms hit this when their session ends. Persistent rooms
// only hit this via the (future) DELETE /api/rooms/{id} endpoint when
// the owner explicitly removes them.
//
// Idempotent: deleting an already-deleted row is a no-op (zero rows
// affected). Callers don't need to pre-check.
func (q *Queries) SoftDeleteRoom(ctx context.Context, id int64) error {
	_, err := q.pool.Exec(ctx,
		`UPDATE watch_party_rooms SET deleted_at = NOW()
		  WHERE id = $1 AND deleted_at IS NULL`,
		id,
	)
	if err != nil {
		return fmt.Errorf("soft delete room: %w", err)
	}
	return nil
}

// nullableTime returns a pointer suitable for SQL NULL handling: zero
// time → nil → COALESCE in the INSERT falls back to NOW(); non-zero
// time → pointer to the value. Lets callers pass time.Time{} to mean
// "let the database set the timestamp" without juggling pointers
// themselves.
func nullableTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}
