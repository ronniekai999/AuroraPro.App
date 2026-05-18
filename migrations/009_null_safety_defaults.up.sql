-- Migration 009: Add DEFAULT '' to nullable TEXT columns scanned into Go string fields.
-- Prevents pgx v5 NULL scan errors for columns that should never be NULL at the app level.

-- users.avatar_url: always scanned into Go string, never set to NULL by application code
ALTER TABLE users ALTER COLUMN avatar_url SET DEFAULT '';

-- refresh_tokens.device_info: always scanned into Go string, always provided as r.UserAgent()
ALTER TABLE refresh_tokens ALTER COLUMN device_info SET DEFAULT '';
