-- Migration 010: Version tags for multi-quality file selection (4K, 1080p, 720p, SD)
-- Adds version_tag column to media_files and episode_files for quality tier tracking.

ALTER TABLE media_files ADD COLUMN IF NOT EXISTS version_tag VARCHAR(50) NOT NULL DEFAULT '';
ALTER TABLE episode_files ADD COLUMN IF NOT EXISTS version_tag VARCHAR(50) NOT NULL DEFAULT '';

-- Indexes for efficient quality-ordered file lookups
CREATE INDEX IF NOT EXISTS idx_media_files_version ON media_files(media_item_id, version_tag);
CREATE INDEX IF NOT EXISTS idx_episode_files_version ON episode_files(episode_id, version_tag);

-- Backfill version_tag from existing resolution values
UPDATE media_files SET version_tag = CASE
    WHEN resolution LIKE '3840x%' OR resolution LIKE '4096x%' OR resolution LIKE '%2160p%' OR resolution LIKE '%4K%' OR resolution LIKE '%4k%' OR resolution ILIKE '%uhd%' THEN '4K'
    WHEN resolution LIKE '1920x%' OR resolution LIKE '%1080p%' THEN '1080p'
    WHEN resolution LIKE '1280x%' OR resolution LIKE '%720p%' THEN '720p'
    WHEN resolution != '' AND resolution IS NOT NULL THEN 'SD'
    ELSE ''
END
WHERE version_tag = '';

UPDATE episode_files SET version_tag = CASE
    WHEN resolution LIKE '3840x%' OR resolution LIKE '4096x%' OR resolution LIKE '%2160p%' OR resolution LIKE '%4K%' OR resolution LIKE '%4k%' OR resolution ILIKE '%uhd%' THEN '4K'
    WHEN resolution LIKE '1920x%' OR resolution LIKE '%1080p%' THEN '1080p'
    WHEN resolution LIKE '1280x%' OR resolution LIKE '%720p%' THEN '720p'
    WHEN resolution != '' AND resolution IS NOT NULL THEN 'SD'
    ELSE ''
END
WHERE version_tag = '';
