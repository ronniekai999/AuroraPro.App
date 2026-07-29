ALTER TABLE users
    DROP COLUMN IF EXISTS referral_status,
    DROP COLUMN IF EXISTS referral_source,
    DROP COLUMN IF EXISTS referral_detail,
    DROP COLUMN IF EXISTS referral_answered_at;
