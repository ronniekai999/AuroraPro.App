-- Phase 8: token-version column for immediate session invalidation on
-- password change. The JWT carries the version at issue-time; the auth
-- middleware compares it to users.token_version and rejects on mismatch.
-- ChangePassword bumps token_version, atomically logging out all sessions.
--
-- DEFAULT 0 + NOT NULL keeps existing tokens valid (they have no
-- token_version claim → treated as version 0, matches the column default).
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
