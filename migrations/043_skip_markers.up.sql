-- ============================================================
-- Smart Skip — intro / recap / credits markers (proposal:
-- docs/proposals/smart-skip/IMPLEMENTATION_PLAN.md)
-- ============================================================

-- One row per (file, kind). A marker belongs to EXACTLY ONE of
-- episode_files / media_files (movies only ever get 'credits' rows;
-- the CHECK on kind doesn't encode that — the analyzer does — so an
-- admin can still hand-tag a movie intro if they want to).
--
-- detector versions the producing algorithm ('xcorr-v1' today,
-- 'manual' for admin corrections) so a future algorithm bump can
-- reprocess without a schema change — same pattern as the embedding
-- version column (migration 016/040). Manual rows are never
-- overwritten by the background analyzer.
--
-- A zero-length manual row (start_ms = end_ms = 0) means "admin
-- suppressed this marker": the analyzer won't re-add it and the
-- player filters zero-length windows out of the UI.
CREATE TABLE skip_markers (
    id              BIGSERIAL PRIMARY KEY,
    episode_file_id BIGINT REFERENCES episode_files(id) ON DELETE CASCADE,
    media_file_id   BIGINT REFERENCES media_files(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('recap', 'intro', 'credits')),
    start_ms        BIGINT NOT NULL,
    end_ms          BIGINT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0,
    detector        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((episode_file_id IS NULL) <> (media_file_id IS NULL)),
    CHECK (start_ms >= 0 AND end_ms >= start_ms)
);

-- Partial unique indexes give ON CONFLICT targets per file family.
CREATE UNIQUE INDEX uq_skip_markers_episode_kind
    ON skip_markers(episode_file_id, kind) WHERE episode_file_id IS NOT NULL;
CREATE UNIQUE INDEX uq_skip_markers_media_kind
    ON skip_markers(media_file_id, kind) WHERE media_file_id IS NOT NULL;

-- Analysis ledger: which files the CURRENT detector has already
-- looked at — including files where it found nothing (no intro
-- detected is a valid, sticky result). Without this, "no markers"
-- and "never analyzed" are indistinguishable and the sweep would
-- re-decode marker-less files forever. Bumping the detector string
-- in code makes every ledger row stale, which is exactly the
-- reprocess-on-upgrade behavior we want.
CREATE TABLE skip_marker_analysis (
    episode_file_id BIGINT REFERENCES episode_files(id) ON DELETE CASCADE,
    media_file_id   BIGINT REFERENCES media_files(id) ON DELETE CASCADE,
    detector        TEXT NOT NULL,
    analyzed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((episode_file_id IS NULL) <> (media_file_id IS NULL))
);

CREATE UNIQUE INDEX uq_skip_analysis_episode
    ON skip_marker_analysis(episode_file_id) WHERE episode_file_id IS NOT NULL;
CREATE UNIQUE INDEX uq_skip_analysis_media
    ON skip_marker_analysis(media_file_id) WHERE media_file_id IS NOT NULL;
