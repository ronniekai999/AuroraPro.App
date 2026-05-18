-- Rollback migration 010: Remove version_tag columns and indexes
DROP INDEX IF EXISTS idx_media_files_version;
DROP INDEX IF EXISTS idx_episode_files_version;
ALTER TABLE media_files DROP COLUMN IF EXISTS version_tag;
ALTER TABLE episode_files DROP COLUMN IF EXISTS version_tag;
