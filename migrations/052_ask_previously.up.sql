-- Ask Previously — persistent, spoiler-bounded conversations per profile/show.

ALTER TABLE episode_recaps
    ADD COLUMN suggested_questions JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE recap_conversations (
    id            BIGSERIAL PRIMARY KEY,
    profile_id    BIGINT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    -- Monotonic invalidation token. Full-history clears keep this row as a
    -- tombstone and advance the token so provider work that started before the
    -- clear can never publish into a newly recreated conversation.
    generation_epoch BIGINT NOT NULL DEFAULT 1 CHECK (generation_epoch > 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(profile_id, media_item_id)
);

CREATE TRIGGER trg_recap_conversations_updated_at
    BEFORE UPDATE ON recap_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE recap_conversation_turns (
    id                  BIGSERIAL PRIMARY KEY,
    conversation_id     BIGINT NOT NULL REFERENCES recap_conversations(id) ON DELETE CASCADE,
    request_id          UUID NOT NULL,
    question            TEXT NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
    answer              TEXT NOT NULL CHECK (char_length(answer) > 0),
    up_to_episode_id    BIGINT REFERENCES tv_episodes(id) ON DELETE SET NULL,
    boundary_season     INT NOT NULL CHECK (boundary_season >= 0),
    boundary_episode    INT NOT NULL CHECK (boundary_episode > 0),
    boundary_title      TEXT NOT NULL DEFAULT '',
    grounding_mode      TEXT NOT NULL CHECK (grounding_mode IN ('grounded', 'season-closure', 'caught-up')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(conversation_id, request_id)
);

-- A request reservation is deliberately separate from the immutable Q/A row:
-- it is created before provider work, contains no raw question/answer text,
-- and lets every Aurora process agree on one leader for an idempotency key.
-- Clearing history advances the conversation epoch and deletes these
-- reservations, invalidating provider work that was already in flight.
CREATE TABLE recap_conversation_requests (
    id                  BIGSERIAL PRIMARY KEY,
    conversation_id     BIGINT NOT NULL REFERENCES recap_conversations(id) ON DELETE CASCADE,
    request_id          UUID NOT NULL,
    question_hash       TEXT NOT NULL CHECK (char_length(question_hash) = 64),
    conversation_epoch  BIGINT NOT NULL CHECK (conversation_epoch > 0),
    status              TEXT NOT NULL CHECK (status IN ('pending', 'failed', 'completed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(conversation_id, request_id)
);

-- Durable, account-wide rolling-window events. These intentionally survive a
-- conversation clear so deleting history cannot refund AI quota. Expired rows
-- are pruned opportunistically whenever a new request is reserved.
CREATE TABLE recap_question_rate_events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recap_question_rate_events_user_created
    ON recap_question_rate_events(user_id, created_at);

CREATE INDEX idx_recap_question_rate_events_created
    ON recap_question_rate_events(created_at);

CREATE INDEX idx_recap_turns_conversation_id
    ON recap_conversation_turns(conversation_id, id DESC);

CREATE INDEX idx_recap_turns_boundary
    ON recap_conversation_turns(conversation_id, boundary_season, boundary_episode, id DESC);
