-- Dropping the columns removes every profile PIN: locked profiles become
-- switchable by any session on the account again. Roll the binary back too,
-- since the newer one reads these columns on every profile query.
ALTER TABLE user_profiles
    DROP COLUMN IF EXISTS pin_locked_until,
    DROP COLUMN IF EXISTS pin_failed_attempts,
    DROP COLUMN IF EXISTS pin_hash;
