-- 051 — watch-party invites (member-to-member, "now or scheduled").
--
-- An invite is a durable row linking a party to an invited member, carrying
-- the invitee's RSVP. Delivery to the invitee rides the existing notifications
-- table (037/044: bell feed + link deep-link); this table is the source of
-- truth the lobby roster and the invitee's Calendar read, and what RSVP
-- mutates. Invites survive the party's in-memory state: a scheduled party's
-- roster must render before anyone has opened a WebSocket.
--
-- Design notes:
--   * party_id references watch_parties(id) — parties are soft-ended
--     (is_active=false), not deleted, so CASCADE only fires on manual admin
--     cleanup. Invite rows for ended parties stay for "recently hosted" UIs
--     but all read paths filter on the party's liveness themselves.
--   * rsvp is a constrained text state machine: pending → going|maybe|declined
--     (re-RSVP is allowed — latest wins; responded_at tracks the last change).
--   * One invite per (party, invitee): re-inviting the same member is an
--     upsert on the send path (ON CONFLICT DO NOTHING — the original invite,
--     and the invitee's RSVP, win) so hosts can "invite more people" without
--     resetting anyone's answer.
--   * inviter_user_id is recorded per-row: today only the host can send, but
--     the column keeps the model honest if co-host invites arrive later.
CREATE TABLE party_invites (
    id              BIGSERIAL PRIMARY KEY,
    party_id        BIGINT NOT NULL REFERENCES watch_parties(id) ON DELETE CASCADE,
    inviter_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rsvp            VARCHAR(10) NOT NULL DEFAULT 'pending'
                    CHECK (rsvp IN ('pending', 'going', 'maybe', 'declined')),
    note            TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at    TIMESTAMPTZ,
    CONSTRAINT party_invites_no_self CHECK (inviter_user_id <> invitee_user_id)
);

-- Send-path idempotency + roster lookups.
CREATE UNIQUE INDEX idx_party_invites_party_invitee
    ON party_invites(party_id, invitee_user_id);

-- "My invites" feed (invitee's Calendar + bell fallback): most recent first.
CREATE INDEX idx_party_invites_invitee_created
    ON party_invites(invitee_user_id, created_at DESC);
