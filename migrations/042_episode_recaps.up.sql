-- "Previously" — spoiler-safe AI series recaps (feature: catch-me-up).
--
-- Caches one generated recap per (show, boundary-episode). The recap depends
-- ONLY on which episodes have been watched up to the boundary, NOT on the
-- profile — two viewers resuming at the same point get the same recap, so we
-- cache by boundary and reuse across the whole account. The profile is used
-- only to LOOK UP each viewer's boundary (their last completed episode); it is
-- never stored here. Privacy-clean + high cache hit rate.
--
--   media_item_id    — the show
--   up_to_episode_id — the boundary: the last episode the viewer finished
--   source_hash      — hash of the input overviews; a TMDB metadata refresh that
--                      rewrites overviews changes the hash and transparently
--                      invalidates a stale recap on next request
--   model            — which chat model wrote it; an admin model switch busts the
--                      cache so recaps stay consistent with the active model
CREATE TABLE episode_recaps (
    media_item_id    BIGINT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    up_to_episode_id BIGINT NOT NULL REFERENCES tv_episodes(id) ON DELETE CASCADE,
    recap            TEXT        NOT NULL,
    model            TEXT        NOT NULL,
    source_hash      TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (media_item_id, up_to_episode_id)
);
