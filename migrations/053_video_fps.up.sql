-- Migration 053: Capture the source video frame rate (average fps) so the
-- transcode pipeline can stamp a TRUTHFUL H.264 level for high-frame-rate
-- content. The pre-053 level table keyed on resolution alone: 1080p always
-- declared level 4.0 and 2160p always 5.1, but 1080p60 needs 4.2 and 2160p60
-- needs 5.2 (macroblock-rate limits). Under-declaring worked in practice only
-- because no local player enforces the stamped level — but capability-filtering
-- receivers (Chromecast canDisplayType) make rung decisions from it, and
-- hls.js advertises it in the master playlist CODECS attribute.
--
-- 0 is the unset sentinel — the scanner backfills on next probe; the level
-- table treats 0 as "unknown" and keeps the pre-053 resolution-only choice
-- (never a regression for unscanned rows).

ALTER TABLE media_files   ADD COLUMN IF NOT EXISTS video_fps REAL DEFAULT 0 NOT NULL;
ALTER TABLE episode_files ADD COLUMN IF NOT EXISTS video_fps REAL DEFAULT 0 NOT NULL;
