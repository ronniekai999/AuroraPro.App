-- Dropping the column returns the refresh queue to ordering on `last_metadata`
-- alone, which re-introduces the unmatchable-item starvation described in the
-- up migration. No data needs folding back.
--
-- Roll the BINARY back too. Two queries read this column through
-- metadataProgressExpr: GetStaleMetadataItems (ordering only) and
-- FindMediaItemByTitle, which the scanner runs for EVERY TV file. Dropping the
-- column under the new binary makes that lookup error on every episode, so the
-- scanner falls back to warn-and-UpsertMediaItem — the duplicate-row-then-merge
-- path the per-show lock exists to avoid.
ALTER TABLE media_items
    DROP COLUMN IF EXISTS last_metadata_attempt;
