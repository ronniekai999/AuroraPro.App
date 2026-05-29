-- Reverse migration 031: drop the multi-provider OAuth identities table.
--
-- The legacy users.oauth_provider / users.oauth_subject columns were never
-- touched by the .up migration (only read for the backfill), so dropping this
-- table fully restores the pre-031 single-identity model — the columns still
-- hold each user's primary identity and GetUserByOAuth resumes as the
-- resolution path. No column changes to reverse. Operator-only.
DROP TABLE IF EXISTS oauth_identities;
