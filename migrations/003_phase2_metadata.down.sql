-- Reverse Phase 2 migration

DROP TABLE IF EXISTS transcode_sessions;
DROP TABLE IF EXISTS watch_progress;
DROP TABLE IF EXISTS media_cast;
DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS artwork;

ALTER TABLE tv_episodes
    DROP COLUMN IF EXISTS tmdb_id,
    DROP COLUMN IF EXISTS still_path,
    DROP COLUMN IF EXISTS vote_average,
    DROP COLUMN IF EXISTS vote_count;

ALTER TABLE media_items
    DROP COLUMN IF EXISTS tmdb_id,
    DROP COLUMN IF EXISTS imdb_id,
    DROP COLUMN IF EXISTS tagline,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS original_lang,
    DROP COLUMN IF EXISTS popularity,
    DROP COLUMN IF EXISTS vote_count,
    DROP COLUMN IF EXISTS backdrop_path,
    DROP COLUMN IF EXISTS poster_path,
    DROP COLUMN IF EXISTS metadata_src,
    DROP COLUMN IF EXISTS last_metadata;
