-- Migration 060: an optional PIN per profile, so a parental rating ceiling is
-- a boundary rather than a filter. Without it, a session acting as a
-- restricted (kid) profile could switch itself to an unrestricted one, or edit
-- its own ceiling, and every server-side gate became advisory.
--
-- pin_hash is an argon2id hash (the same encoding as users.password_hash);
-- NULL means the profile is unlocked. Activating a locked profile requires the
-- PIN, or the account password in its place (recovery).
--
-- The attempt counter and lockout are persisted so a restart does not reset a
-- brute-force budget: a four-digit PIN has 10,000 values, so the limit is what
-- makes it a lock. pin_failed_attempts counts consecutive failures and resets
-- on success or on a PIN change; pin_locked_until refuses attempts until then.
ALTER TABLE user_profiles
    ADD COLUMN IF NOT EXISTS pin_hash TEXT,
    ADD COLUMN IF NOT EXISTS pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;
