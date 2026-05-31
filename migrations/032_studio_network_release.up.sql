-- Migration 032: Add studio, network, and release_date to media_items.
-- studio       = first TMDB production company (movies; some shows too)
-- network      = first TMDB network (TV)
-- release_date = full ISO date (movie release_date / TV first_air_date),
--                complementing the existing 4-digit `year` column.
-- Populated by the metadata enricher; surfaced on the details page.

ALTER TABLE media_items ADD COLUMN IF NOT EXISTS studio VARCHAR(255) DEFAULT '' NOT NULL;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS network VARCHAR(255) DEFAULT '' NOT NULL;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS release_date VARCHAR(20) DEFAULT '' NOT NULL;
