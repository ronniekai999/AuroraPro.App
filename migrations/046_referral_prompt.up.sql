-- 046 — referral attribution for invite-free SSO signups.
--
-- When a provider's oauth_<p>_bypass_invite toggle is on, new-user creation
-- skips the invite code — and the invite code was the only record of where an
-- account came from. So the trusted providers, the ones an operator most wants
-- to grow through, are exactly the ones that produce zero attribution. These
-- columns carry a one-shot "How did you hear about Aurora?" answer for exactly
-- those signups.
--
--   referral_status: NULL = never eligible (password signup, invite redeemed,
--     bypass off). 'pending' = eligible and not yet resolved. 'answered' |
--     'skipped' = done. One column carries eligibility AND resolution, so
--     "ask once" is a single state test and there is no way to be
--     eligible-but-unmarked. Stamped atomically inside the tier-3 user INSERT
--     (CreateOAuthUserWithIdentity), never by a follow-up UPDATE.
--   referral_source: the chosen option's KEY, not its label. Labels are
--     admin-editable; storing the label would silently rewrite history every
--     time one is renamed, and a deleted option would orphan its answers.
--   referral_detail: free text, only alongside source = 'other'. The CHECK
--     enforces that pairing in the schema so it cannot drift from the API
--     validator.
--   referral_answered_at: when the prompt was resolved (answered or skipped).
--
-- Nullable and deliberately NOT backfilled: existing users predate the
-- question, and inventing an answer for them would be exactly the fabricated
-- attribution this feature exists to avoid. They read as "—" in the admin
-- Users table, which is accurate.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS referral_status TEXT
        CHECK (referral_status IN ('pending', 'answered', 'skipped')),
    ADD COLUMN IF NOT EXISTS referral_source TEXT,
    ADD COLUMN IF NOT EXISTS referral_detail TEXT
        CHECK (referral_detail IS NULL OR referral_source = 'other'),
    ADD COLUMN IF NOT EXISTS referral_answered_at TIMESTAMPTZ;

-- Partial: the aggregate panel only ever groups over rows that answered, and
-- the overwhelming majority of rows (password signups, invited users) are NULL.
CREATE INDEX IF NOT EXISTS idx_users_referral_source ON users (referral_source)
    WHERE referral_source IS NOT NULL;
