-- Revert migration 009: Remove DEFAULT '' from nullable TEXT columns
ALTER TABLE users ALTER COLUMN avatar_url DROP DEFAULT;
ALTER TABLE refresh_tokens ALTER COLUMN device_info DROP DEFAULT;
