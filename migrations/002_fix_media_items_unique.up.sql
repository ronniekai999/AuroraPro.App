-- Fix: Add unique constraint on media_items for proper upsert behavior
-- Prevents duplicate entries on library rescan
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_items_lib_type_title_year
    ON media_items (library_id, type, title, COALESCE(year, 0));
