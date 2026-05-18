-- Migration 012: Add video_profile and video_pix_fmt columns to media_files and episode_files.
-- These columns store the H.264/HEVC profile name (e.g., "High 10") and pixel format
-- (e.g., "yuv420p10le") from FFprobe, enabling the decision engine to detect H.264 10-bit
-- files that browsers' MediaSource API universally rejects.

ALTER TABLE media_files ADD COLUMN IF NOT EXISTS video_profile VARCHAR(50) DEFAULT '' NOT NULL;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS video_pix_fmt VARCHAR(50) DEFAULT '' NOT NULL;

ALTER TABLE episode_files ADD COLUMN IF NOT EXISTS video_profile VARCHAR(50) DEFAULT '' NOT NULL;
ALTER TABLE episode_files ADD COLUMN IF NOT EXISTS video_pix_fmt VARCHAR(50) DEFAULT '' NOT NULL;
