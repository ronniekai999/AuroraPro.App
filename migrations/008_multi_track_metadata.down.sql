ALTER TABLE media_files
    DROP COLUMN IF EXISTS audio_tracks,
    DROP COLUMN IF EXISTS subtitle_tracks;

ALTER TABLE episode_files
    DROP COLUMN IF EXISTS audio_tracks,
    DROP COLUMN IF EXISTS subtitle_tracks;
