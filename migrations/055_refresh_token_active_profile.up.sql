-- Issue #462 — server-authoritative acting sub-profile for parental-rating
-- enforcement. refresh_tokens is the only durable per-login row, so the
-- currently-active profile for a session is bound here (NOT trusted from a
-- client-supplied profile_id) and referenced from the access token via a new
-- "rtid" claim. NULL = no explicit switch yet; enforcement falls back to the
-- account's default profile, same as every other "no profile signal" path.
ALTER TABLE refresh_tokens
    ADD COLUMN IF NOT EXISTS active_profile_id BIGINT
        REFERENCES user_profiles(id) ON DELETE SET NULL;
