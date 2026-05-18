-- Migration 012 rollback: Remove video_profile and video_pix_fmt columns.

ALTER TABLE media_files DROP COLUMN IF EXISTS video_profile;
ALTER TABLE media_files DROP COLUMN IF EXISTS video_pix_fmt;

ALTER TABLE episode_files DROP COLUMN IF EXISTS video_profile;
ALTER TABLE episode_files DROP COLUMN IF EXISTS video_pix_fmt;
