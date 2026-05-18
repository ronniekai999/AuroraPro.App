-- Migration 011: Cross-library version linking
-- Allows the same movie/show to exist in multiple libraries with the same TMDB ID.
-- Previously, idx_media_items_tmdb was UNIQUE, causing the enricher to merge cross-library
-- duplicates. Now it is a regular index, and cross-library items are linked at query time
-- via their shared tmdb_id.

-- Drop the unique tmdb_id index
DROP INDEX IF EXISTS idx_media_items_tmdb;

-- Create a non-unique index for fast lookups by tmdb_id
CREATE INDEX IF NOT EXISTS idx_media_items_tmdb ON media_items(tmdb_id) WHERE tmdb_id IS NOT NULL;

-- Composite index for cross-library file aggregation: given a tmdb_id and type,
-- quickly find all media_items across libraries
CREATE INDEX IF NOT EXISTS idx_media_items_tmdb_type ON media_items(tmdb_id, type) WHERE tmdb_id IS NOT NULL;
