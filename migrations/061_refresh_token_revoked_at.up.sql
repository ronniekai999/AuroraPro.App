-- When a refresh token was revoked. The hourly purge used to delete revoked
-- rows at once, while access tokens minted from them stay valid for up to
-- their own lifetime and name the row in their "rtid" claim. With the row gone
-- the acting-profile lookup found no binding, so a kid's still-valid access
-- token acted as the account's default profile. Revoked rows are now kept until
-- revoked_at is older than the access-token lifetime.
ALTER TABLE refresh_tokens
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
