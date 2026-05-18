ALTER TABLE media_items ADD COLUMN IF NOT EXISTS match_status VARCHAR(30) DEFAULT 'matched';
CREATE INDEX IF NOT EXISTS idx_media_items_match_status ON media_items(match_status) WHERE match_status != 'matched';
