-- Drops the case-insensitive email index. The lowercase backfill in the .up
-- migration is intentionally NOT reversed (the original casing is not
-- recoverable, and lowercase emails remain valid). Operator-only.
DROP INDEX IF EXISTS idx_users_email_lower;
