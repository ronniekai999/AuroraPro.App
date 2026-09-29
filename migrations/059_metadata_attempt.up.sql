-- Migration 059: record that a metadata enrichment ATTEMPT happened, as a
-- fact separate from whether that attempt produced any metadata.
--
-- `last_metadata` is written only by UpdateMediaMetadata, i.e. only when a
-- provider match was actually found and stored. An item the provider has no
-- entry for therefore keeps `last_metadata` NULL for ever, and
-- GetStaleMetadataItems selects `last_metadata IS NULL OR last_metadata < cutoff`
-- ordered `last_metadata ASC NULLS FIRST LIMIT 100`. So permanently
-- unmatchable items sit at the head of that queue in perpetuity: once 100 of
-- them exist the refresh pass re-reads the same 100 for ever and no other item
-- is ever refreshed again.
--
-- The queue needs to distinguish "never asked" from "asked, and the provider
-- said no", and `last_metadata` cannot carry both meanings — the smart-diff in
-- RefreshStaleMetadata reads it as the timestamp to hand TMDB's changes API,
-- which is only meaningful for an item that really was matched. Hence a second
-- column. Callers order and filter on GREATEST(last_metadata,
-- last_metadata_attempt), which Postgres evaluates to NULL only when BOTH are
-- NULL — exactly the "never made progress, go first" case — and otherwise to
-- whichever event was more recent.
--
-- Nullable with no default and no backfill: every existing row reads as "never
-- attempted", which is the correct starting state. Rows that were genuinely
-- enriched already carry `last_metadata`, so GREATEST still reports their real
-- progress and they are not dragged to the front of the queue by this change.

ALTER TABLE media_items
    ADD COLUMN IF NOT EXISTS last_metadata_attempt TIMESTAMPTZ;
