-- Migration 032 rollback: remove studio, network, release_date.

ALTER TABLE media_items DROP COLUMN IF EXISTS studio;
ALTER TABLE media_items DROP COLUMN IF EXISTS network;
ALTER TABLE media_items DROP COLUMN IF EXISTS release_date;
