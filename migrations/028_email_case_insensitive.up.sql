-- deep-debug H1 — enforce case-insensitive email identity.
--
-- Until now users.email had only a case-SENSITIVE UNIQUE constraint
-- (migration 001) and no LOWER(email) index, while the code matched email
-- case-sensitively. That let "Bob@Corp.com" and "bob@corp.com" become two
-- separate accounts and let a case variant slip past the OAuth email-collision
-- anti-hijack safety net. This canonicalizes existing emails to lowercase and
-- adds a case-insensitive unique index (mirroring migration 017 for username).

-- Fail loudly (listing the offenders) if case-variant duplicate emails already
-- exist, rather than aborting later with an opaque unique-violation. The
-- operator must merge/delete the duplicate accounts, then re-run.
DO $$
DECLARE
    dups TEXT;
BEGIN
    SELECT string_agg(le, ', ')
      INTO dups
      FROM (
          SELECT LOWER(email) AS le
            FROM users
           WHERE email IS NOT NULL AND email <> ''
           GROUP BY LOWER(email)
          HAVING COUNT(*) > 1
      ) d;
    IF dups IS NOT NULL THEN
        RAISE EXCEPTION 'migration 028: cannot enforce case-insensitive email uniqueness — these emails differ only by case and must be merged/deleted first: %', dups;
    END IF;
END
$$;

-- Canonicalize existing addresses to lowercase.
UPDATE users
   SET email = LOWER(email)
 WHERE email IS NOT NULL
   AND email <> ''
   AND email <> LOWER(email);

-- Case-insensitive uniqueness. Partial (email <> '') so the index itself never
-- collides empty-string rows; uniqueness for the degenerate empty-email case is
-- already enforced by migration 001's column-level NOT NULL + UNIQUE on email,
-- and the OAuth callback rejects empty provider emails before insert. The index
-- name matches the isEmailUniqueConstraint() check in internal/api/oauth_handlers.go.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
    ON users (LOWER(email))
 WHERE email IS NOT NULL AND email <> '';
