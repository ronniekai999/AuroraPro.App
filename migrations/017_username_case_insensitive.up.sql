-- Phase 8: prevent "Admin" vs "admin" registration collisions.
-- The existing UNIQUE constraint on users.username is case-sensitive, so an
-- attacker can register a homoglyph-y "Admin" while a real "admin" exists.
-- A functional unique index on LOWER(username) blocks that at insert time
-- without changing display case (the bare username column is still mixed-case
-- for UI rendering — only collision detection is case-folded).
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uniq
    ON users (LOWER(username));
