-- Migration 031: multi-provider OAuth identities (audit carve-out D).
--
-- Until now a user's OAuth link lived in two single-value columns on the
-- users table (oauth_provider, oauth_subject — migration 020), so a user
-- could hold exactly ONE identity. Linking a second provider (or re-linking
-- a different account on the same provider) overwrote the first — see the
-- LinkOAuthToUser conflict guard in internal/db/queries.go. This migration
-- introduces a dedicated oauth_identities table so a single Aurora user can
-- link MULTIPLE providers (e.g. Google + Discord) at once.
--
-- AUTHORITY: from this migration on, oauth_identities is the SOURCE OF TRUTH
-- for OAuth-identity → user resolution (GetUserByOAuthIdentity replaces the
-- column-based GetUserByOAuth in the callback flow). The legacy
-- users.oauth_provider / users.oauth_subject columns are KEPT but FROZEN:
--   * They are NOT dropped — back-compat (several queries still scan them
--     into models.User) and a trivial rollback story (this migration's .down
--     simply drops the new table; the columns were never touched).
--   * They are best-effort mirrored to the user's PRIMARY identity by the
--     queries layer (AddOAuthIdentity / CreateOAuthUserWithIdentity fill them
--     only when empty; RemoveOAuthIdentity clears them when the removed
--     provider matches), so the OAuth-only-user login gate that reads
--     oauth_provider keeps working. They are NOT authoritative for resolution.

CREATE TABLE IF NOT EXISTS oauth_identities (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider   VARCHAR(32) NOT NULL,
    subject    VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Global identity uniqueness: one Aurora user per (provider, subject). A
-- given Google/Discord/… account can be linked to at most one Aurora user.
-- Mirrors the intent of migration 020's idx_users_oauth_identity, now
-- enforced in the dedicated table. AddOAuthIdentity maps a violation here to
-- ErrOAuthIdentityConflict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_identities_provider_subject
    ON oauth_identities (provider, subject);

-- At most one linked account per provider per user: a user can link Google
-- AND Discord, but not two different Google accounts. AddOAuthIdentity maps a
-- violation here to ErrOAuthProviderAlreadyLinked ("unlink the existing one
-- first").
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_identities_user_provider
    ON oauth_identities (user_id, provider);

-- Supports ListOAuthIdentities / CountOAuthIdentities (the unlink lockout
-- guard) which filter by user_id.
CREATE INDEX IF NOT EXISTS idx_oauth_identities_user
    ON oauth_identities (user_id);

-- Backfill the new table from the existing single-value columns so users who
-- already linked a provider keep their fast-path sign-in after deploy.
-- Idempotent: ON CONFLICT DO NOTHING means re-running the migration (or
-- running it after a partial manual backfill) is safe.
INSERT INTO oauth_identities (user_id, provider, subject, created_at)
SELECT id, oauth_provider, oauth_subject, created_at
FROM users
WHERE oauth_provider IS NOT NULL AND oauth_provider <> ''
  AND oauth_subject  IS NOT NULL AND oauth_subject  <> ''
ON CONFLICT DO NOTHING;
