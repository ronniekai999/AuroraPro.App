-- Match v2 measurement foundation. A slate represents one successful API
-- delivery; its child rows preserve position, displayed estimate, evidence
-- confidence, and model version for time-forward calibration. These rows are
-- sensitive profile history and cascade on profile/media deletion.
CREATE TABLE recommendation_slates (
    id         BIGSERIAL PRIMARY KEY,
    profile_id BIGINT      NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    surface    VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (surface <> ''),
    UNIQUE (id, profile_id)
);

CREATE TABLE recommendation_impressions (
    id            BIGSERIAL PRIMARY KEY,
    slate_id      BIGINT       NOT NULL,
    profile_id    BIGINT       NOT NULL,
    media_item_id BIGINT       NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    position      INTEGER      NOT NULL CHECK (position >= 0),
    match         SMALLINT     NOT NULL CHECK (match BETWEEN 0 AND 100),
    confidence    DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    model_version VARCHAR(64)  NOT NULL,
    similarity    DOUBLE PRECISION NOT NULL CHECK (similarity BETWEEN -1 AND 1),
    evidence      INTEGER      NOT NULL CHECK (evidence >= 0),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (slate_id, position),
    FOREIGN KEY (slate_id, profile_id)
        REFERENCES recommendation_slates(id, profile_id) ON DELETE CASCADE
);

CREATE INDEX idx_recommendation_slates_profile_created
    ON recommendation_slates (profile_id, created_at DESC);
CREATE INDEX idx_recommendation_slates_retention
    ON recommendation_slates (created_at);
CREATE INDEX idx_recommendation_impressions_outcome
    ON recommendation_impressions (profile_id, media_item_id, created_at DESC);
