-- 021_persistent_party_rooms — DOWN migration.
--
-- Reversing the rooms-as-identity refactor. Drops the new table + index
-- + column. Data in watch_party_rooms is lost; that's OK because the
-- forward migration only created synthetic mirror rows for active
-- parties — the source-of-truth join code still lives on watch_parties
-- post-rollback. Any persistent-room user data created AFTER this
-- migration is data loss on rollback; this is documented and accepted.

DROP INDEX IF EXISTS idx_watch_parties_room_active;
ALTER TABLE watch_parties DROP COLUMN IF EXISTS room_id;

DROP INDEX IF EXISTS idx_watch_party_rooms_owner;
DROP INDEX IF EXISTS idx_watch_party_rooms_code_live;
DROP TABLE IF EXISTS watch_party_rooms;
