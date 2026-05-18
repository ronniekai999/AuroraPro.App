-- 021_persistent_party_rooms — M3 of the watch-party rewrite.
--
-- Splits the "party" concept into two: a long-lived ROOM (stable join
-- target, persistent across sessions) and an ephemeral PARTY (a specific
-- session inside a room). The room owns the join code; parties link to
-- their room via room_id.
--
-- TWO LIFECYCLE MODELS unified under one schema:
--   - Quick parties (current behavior): create a room with is_persistent=FALSE,
--     create a party inside it. When the party ends, the room is soft-
--     deleted. Externally indistinguishable from today's flow.
--   - Persistent rooms (NEW): create a room with is_persistent=TRUE. The
--     room stays alive across sessions; friends can bookmark its code
--     and rejoin whenever a new party starts. When a session ends, only
--     the party row is closed; the room stays alive (last_active_at
--     updated).
--
-- Compat: watch_parties.party_code is preserved for backwards-compat
-- with the share-image URL space (/api/parties/{code}/share-image.png).
-- For any active party, party_code mirrors room.code. The eventual
-- cleanup of party_code is a separate task.
--
-- Existing data: at migration time, every ACTIVE party gets a synthetic
-- non-persistent room created with the same code, and the party row is
-- linked to that room. Ended (historical) parties keep room_id=NULL
-- since nothing reads them. No data loss either way.

-- watch_party_rooms is the long-lived join target.
CREATE TABLE IF NOT EXISTS watch_party_rooms (
    id              BIGSERIAL PRIMARY KEY,
    code            VARCHAR(6) NOT NULL,
    name            VARCHAR(200) NOT NULL DEFAULT '',
    owner_user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_persistent   BOOLEAN NOT NULL DEFAULT FALSE,
    settings_json   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Soft-delete tombstone: NULL = live (code is reserved); non-NULL = deleted
    -- (code is reusable). Quick-party rooms get soft-deleted on session end;
    -- persistent rooms get soft-deleted only when the owner explicitly
    -- removes them via the (future) DELETE /api/rooms/{id} endpoint.
    deleted_at      TIMESTAMPTZ
);

-- A room's code must be unique among LIVE rooms. Soft-deleted rooms can
-- have their code reused once they're tombstoned — matches the existing
-- pattern on watch_parties.party_code (partial unique gated on is_active).
CREATE UNIQUE INDEX idx_watch_party_rooms_code_live
    ON watch_party_rooms (code) WHERE deleted_at IS NULL;

-- For listing a user's persistent rooms ("My Rooms" UI in M4-M5).
CREATE INDEX idx_watch_party_rooms_owner
    ON watch_party_rooms (owner_user_id) WHERE deleted_at IS NULL;

-- Backfill: each ACTIVE party gets a synthetic non-persistent room with
-- the same code so the room is internally consistent post-migration.
-- Ended (inactive) parties stay unmigrated — they're history rows.
INSERT INTO watch_party_rooms (code, name, owner_user_id, is_persistent, created_at, last_active_at)
SELECT party_code, party_name, host_user_id, FALSE, created_at, COALESCE(ended_at, created_at)
FROM watch_parties
WHERE is_active = TRUE
ON CONFLICT DO NOTHING;

-- Link each active party to its newly-created room.
ALTER TABLE watch_parties ADD COLUMN room_id BIGINT REFERENCES watch_party_rooms(id) ON DELETE CASCADE;

UPDATE watch_parties wp
SET room_id = wpr.id
FROM watch_party_rooms wpr
WHERE wp.is_active = TRUE
  AND wpr.code = wp.party_code
  AND wpr.deleted_at IS NULL;

-- Fast lookup: room → active party for this room (at most one due to
-- the existing partial unique on party_code).
CREATE INDEX idx_watch_parties_room_active
    ON watch_parties (room_id) WHERE is_active = TRUE;
