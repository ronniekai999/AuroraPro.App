-- Migration 020: OAuth provider identity columns on users.
--
-- Adds two nullable columns that together identify a user's OAuth login
-- identity (e.g. their Google account):
--   oauth_provider — short stable identifier like "google". Null for
--     legacy local-password users who have never linked an OAuth account.
--   oauth_subject  — the provider's stable user ID (Google's `sub` claim
--     in the ID token). Combined with oauth_provider this is unique
--     across the system. Null for legacy users.
--
-- A user can have at most one OAuth link at a time (per provider) — if
-- they want to switch from Google to GitHub later, we update the columns
-- in place. The partial unique index allows multiple users to have NULL
-- (which is the steady state for password-only users) while preventing
-- two distinct users from sharing the same (provider, subject) pair.
--
-- For OAuth-only users (no local password), password_hash is set to the
-- empty string by the OAuth callback handler. The login endpoint
-- explicitly rejects empty-hash users from the password path, so they
-- can only authenticate via OAuth until they set a password via the
-- change-password flow.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(32) NULL,
    ADD COLUMN IF NOT EXISTS oauth_subject  VARCHAR(255) NULL;

-- Partial unique index: enforces "no two users share the same OAuth
-- identity" while allowing many NULLs (the password-only users).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth_identity
    ON users (oauth_provider, oauth_subject)
    WHERE oauth_provider IS NOT NULL AND oauth_subject IS NOT NULL;
