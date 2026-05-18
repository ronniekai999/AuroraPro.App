-- Aurora Phase 2 Gap 1: Expand artwork types and ensure external_ids support

-- Add 'banner' to artwork art_type CHECK constraint (needed for TVDB banners)
ALTER TABLE artwork DROP CONSTRAINT IF EXISTS artwork_art_type_check;
ALTER TABLE artwork ADD CONSTRAINT artwork_art_type_check
    CHECK (art_type IN ('poster', 'backdrop', 'still', 'logo', 'thumb', 'banner'));
