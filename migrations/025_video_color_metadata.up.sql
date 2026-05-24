-- Migration 025: Capture color metadata (transfer + primaries) so the
-- transcode pipeline can distinguish HDR sources (PQ / HLG) from SDR
-- 10-bit sources. Without this, the previous "10-bit + transcode →
-- inject HDR tonemap" heuristic mis-fired on plain SDR 10-bit HEVC,
-- causing zscale to crash with "no path between colorspaces" and
-- killing playback for any modern remux that wasn't actually HDR.
--
-- Empty strings are the unset sentinel — scanner backfills on next
-- scan; the HDR detection treats empty as "not HDR" (safer).

ALTER TABLE media_files  ADD COLUMN IF NOT EXISTS color_transfer  VARCHAR(50) DEFAULT '' NOT NULL;
ALTER TABLE media_files  ADD COLUMN IF NOT EXISTS color_primaries VARCHAR(50) DEFAULT '' NOT NULL;

ALTER TABLE episode_files ADD COLUMN IF NOT EXISTS color_transfer  VARCHAR(50) DEFAULT '' NOT NULL;
ALTER TABLE episode_files ADD COLUMN IF NOT EXISTS color_primaries VARCHAR(50) DEFAULT '' NOT NULL;
