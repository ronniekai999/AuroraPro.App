-- Revert artwork art_type CHECK constraint to exclude 'banner'
ALTER TABLE artwork DROP CONSTRAINT IF EXISTS artwork_art_type_check;
ALTER TABLE artwork ADD CONSTRAINT artwork_art_type_check
    CHECK (art_type IN ('poster', 'backdrop', 'still', 'logo', 'thumb'));
