-- Server-side OAuth transaction store.
--
-- Two OAuth cookies used to carry a CLIENT-SUPPLIED database id that the
-- callback then treated as authorization:
--
--   aurora_oauth_link_uid      the user id to attach the provider identity to
--   aurora_oauth_invite_claim  the invite_codes row id to finalize
--
-- HttpOnly stops page JavaScript from READING a cookie; it does nothing to
-- stop a caller from SETTING one on a request it crafts itself. Both ids are
-- sequential and guessable, so substituting a victim's uid during an
-- attacker's own provider round-trip attached the attacker's OAuth identity to
-- the victim's account (full takeover, administrators included), and
-- substituting an arbitrary invite id walked an uninvited signup past the
-- invite gate.
--
-- The fix is to stop round-tripping the ids at all. A transaction row is
-- created server-side at Start, the client receives only an opaque 256-bit
-- token, and the callback recovers the ids by consuming that row. The token is
-- stored as a SHA-256 hash so a database read does not yield usable tokens.
--
-- Every field the callback needs to re-verify lives here: `state` and
-- `provider` bind the transaction to the exact CSRF state and provider it was
-- minted for, `expires_at` bounds it to the OAuth window, and `consumed_at`
-- makes it single-use via an atomic conditional UPDATE.
CREATE TABLE IF NOT EXISTS oauth_transactions (
    id          BIGSERIAL PRIMARY KEY,
    -- SHA-256 of the opaque token handed to the client. UNIQUE both to enforce
    -- one row per token and to give the consume path an index to seek on.
    token_hash  BYTEA       NOT NULL UNIQUE,
    -- 'link' attaches a provider to user_id; 'login' carries an optional
    -- invite claim through a signup.
    mode        TEXT        NOT NULL CHECK (mode IN ('login', 'link')),
    provider    TEXT        NOT NULL,
    state       TEXT        NOT NULL,
    user_id     BIGINT      REFERENCES users(id) ON DELETE CASCADE,
    invite_id   BIGINT      REFERENCES invite_codes(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    -- A link transaction with no user_id would consume cleanly and then have
    -- nothing to attach to; reject it at write time rather than at use time.
    CONSTRAINT oauth_transactions_link_needs_user
        CHECK (mode <> 'link' OR user_id IS NOT NULL)
);

-- Supports the periodic sweep of expired/consumed rows.
CREATE INDEX IF NOT EXISTS idx_oauth_transactions_expires_at
    ON oauth_transactions (expires_at);
