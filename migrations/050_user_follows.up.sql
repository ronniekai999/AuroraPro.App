-- Member follows (social phase 2): the directed follow graph.
--
-- follower follows followee — "your feed shows people YOU follow", so the
-- home rail reads WHERE follower_id = viewer. Open follow (no
-- request/approval flow): this is an invite-only box and the only thing
-- following unlocks is a feed of what the followee ALREADY opted into
-- sharing via users.share_watch_history (049) — the privacy gate lives
-- there, not here.
--
-- ON DELETE CASCADE both ways: deleting either side of the edge deletes
-- the edge (also recorded in DeleteUser's cascade-audit comment,
-- internal/db/queries.go).

CREATE TABLE user_follows (
    follower_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
);

-- The PK covers follower-side lookups (my following list, the feed join);
-- this covers the reverse direction (who follows X, follower counts).
CREATE INDEX idx_user_follows_followee ON user_follows(followee_id);
