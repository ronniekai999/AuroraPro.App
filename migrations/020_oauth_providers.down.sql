-- Rollback Migration 020.
DROP INDEX IF EXISTS idx_users_oauth_identity;
ALTER TABLE users
    DROP COLUMN IF EXISTS oauth_provider,
    DROP COLUMN IF EXISTS oauth_subject;
