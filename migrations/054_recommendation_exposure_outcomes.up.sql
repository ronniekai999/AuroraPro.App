-- Match v2 beta measurement: distinguish an API-selected slate from a hero the
-- browser actually kept visible. The opaque token is safe to expose to the
-- owning client and lets visibility events bind to the exact cached delivery.
ALTER TABLE recommendation_slates
    ADD COLUMN slate_token VARCHAR(32);

UPDATE recommendation_slates
SET slate_token = md5(id::text || ':' || profile_id::text || ':' || created_at::text)
WHERE slate_token IS NULL;

ALTER TABLE recommendation_slates
    ALTER COLUMN slate_token SET NOT NULL,
    ADD CONSTRAINT recommendation_slates_token_unique UNIQUE (slate_token);

ALTER TABLE recommendation_impressions
    ADD COLUMN visible_at TIMESTAMPTZ,
    ADD COLUMN visible_ms INTEGER,
    ADD CONSTRAINT recommendation_impressions_visible_ms_check
        CHECK (visible_ms IS NULL OR visible_ms >= 0);

CREATE INDEX idx_recommendation_impressions_visible_outcome
    ON recommendation_impressions (profile_id, visible_at DESC)
    WHERE visible_at IS NOT NULL;

-- Immutable, low-volume outcome events. watch_progress is a mutable snapshot;
-- without this ledger a later replay overwrites the timestamp/fraction needed
-- to attribute the original completion to the correct visible recommendation.
CREATE TABLE recommendation_watch_events (
    id            BIGSERIAL PRIMARY KEY,
    profile_id    BIGINT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    media_item_id BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    episode_id    BIGINT REFERENCES tv_episodes(id) ON DELETE CASCADE,
    event_type    VARCHAR(24) NOT NULL CHECK (event_type IN ('started','engaged','completed','rewatch_completed')),
    progress      DOUBLE PRECISION NOT NULL CHECK (progress BETWEEN 0 AND 1),
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recommendation_watch_events_attribution
    ON recommendation_watch_events (profile_id, media_item_id, occurred_at);
