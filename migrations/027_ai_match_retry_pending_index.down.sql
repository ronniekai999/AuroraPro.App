-- Down migration for 027: drop the partial index. The retry pass keeps
-- working without it (seq scan + filter), just slower on large catalogs.

DROP INDEX IF EXISTS idx_media_items_ai_match_retry_pending;
