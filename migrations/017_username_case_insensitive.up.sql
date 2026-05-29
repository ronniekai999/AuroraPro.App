-- Phase 8: prevent "Admin" vs "admin" registration collisions.
-- The existing UNIQUE constraint on users.username is case-sensitive, so an
-- attacker can register a homoglyph-y "Admin" while a real "admin" exists.
-- A functional unique index on LOWER(username) blocks that at insert time
-- without changing display case (the bare username column is still mixed-case
-- for UI rendering — only collision detection is case-folded).
--
-- deep-debug — fail loudly (listing the offenders) if pre-existing
-- case-duplicate usernames would make the unique index creation abort the
-- whole migration run (and therefore startup) with an opaque error. Mirrors
-- migration 028 for email. Only reachable for a DB that hadn't yet applied
-- this migration (e.g. restoring a pre-017 backup into a newer build); an
-- already-migrated deployment skips this migration entirely.
DO $$
DECLARE
    dups TEXT;
BEGIN
    SELECT string_agg(lu, ', ')
      INTO dups
      FROM (
          SELECT LOWER(username) AS lu
            FROM users
           GROUP BY LOWER(username)
          HAVING COUNT(*) > 1
      ) d;
    IF dups IS NOT NULL THEN
        RAISE EXCEPTION 'migration 017: cannot enforce case-insensitive usernames — these usernames differ only by case and must be renamed first: %', dups;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uniq
    ON users (LOWER(username));
