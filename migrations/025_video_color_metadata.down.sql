ALTER TABLE media_files  DROP COLUMN IF EXISTS color_transfer;
ALTER TABLE media_files  DROP COLUMN IF EXISTS color_primaries;
ALTER TABLE episode_files DROP COLUMN IF EXISTS color_transfer;
ALTER TABLE episode_files DROP COLUMN IF EXISTS color_primaries;
