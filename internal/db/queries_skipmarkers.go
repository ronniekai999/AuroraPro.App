package db

import (
	"context"
	"fmt"

	"github.com/aurora-media/aurora/internal/models"
)

// ============================================================
// Smart Skip — intro / recap / credits markers
// ============================================================
//
// Markers belong to exactly one of episode_files / media_files; every
// method takes an `isEpisode` discriminator instead of duplicating the
// API surface per file family. See migration 043 for the schema and
// the manual-vs-auto precedence rules.

// fileColumn returns the marker FK column for the file family.
func skipMarkerFileColumn(isEpisode bool) string {
	if isEpisode {
		return "episode_file_id"
	}
	return "media_file_id"
}

// GetSkipMarkers returns all markers for a file, ordered by start time.
// Includes zero-length (admin-suppressed) rows — the API layer decides
// what to surface to the player vs the admin editor.
func (q *Queries) GetSkipMarkers(ctx context.Context, fileID int64, isEpisode bool) ([]models.SkipMarker, error) {
	col := skipMarkerFileColumn(isEpisode)
	rows, err := q.pool.Query(ctx, fmt.Sprintf(`
		SELECT kind, start_ms, end_ms, confidence, detector
		FROM skip_markers
		WHERE %s = $1
		ORDER BY start_ms, kind`, col), fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var markers []models.SkipMarker
	for rows.Next() {
		var m models.SkipMarker
		if err := rows.Scan(&m.Kind, &m.StartMs, &m.EndMs, &m.Confidence, &m.Detector); err != nil {
			return nil, err
		}
		markers = append(markers, m)
	}
	return markers, rows.Err()
}

// UpsertSkipMarker writes a single marker row. Used by the admin
// manual-correction endpoint (detector='manual'); manual rows replace
// whatever the analyzer produced for that (file, kind).
func (q *Queries) UpsertSkipMarker(ctx context.Context, fileID int64, isEpisode bool, m models.SkipMarker) error {
	col := skipMarkerFileColumn(isEpisode)
	_, err := q.pool.Exec(ctx, fmt.Sprintf(`
		INSERT INTO skip_markers (%s, kind, start_ms, end_ms, confidence, detector)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (%s, kind) WHERE %s IS NOT NULL
		DO UPDATE SET start_ms = EXCLUDED.start_ms,
		              end_ms = EXCLUDED.end_ms,
		              confidence = EXCLUDED.confidence,
		              detector = EXCLUDED.detector,
		              updated_at = NOW()`, col, col, col),
		fileID, m.Kind, m.StartMs, m.EndMs, m.Confidence, m.Detector)
	return err
}

// DeleteSkipMarker removes one (file, kind) marker. For a manual row
// this reverts the file to "whatever the analyzer said" — and since the
// analysis ledger row still exists, the auto markers do NOT come back
// until the file is re-analyzed (detector bump or ResetSkipAnalysis).
// Returns the number of rows deleted so the handler can 404 a no-op.
func (q *Queries) DeleteSkipMarker(ctx context.Context, fileID int64, isEpisode bool, kind string) (int64, error) {
	col := skipMarkerFileColumn(isEpisode)
	tag, err := q.pool.Exec(ctx, fmt.Sprintf(
		`DELETE FROM skip_markers WHERE %s = $1 AND kind = $2`, col), fileID, kind)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ResetSkipAnalysis drops the analysis-ledger row for a file so the next
// sweep re-detects it from scratch. Paired with DeleteSkipMarker in the
// admin "revert to auto" flow.
func (q *Queries) ResetSkipAnalysis(ctx context.Context, fileID int64, isEpisode bool) error {
	col := skipMarkerFileColumn(isEpisode)
	_, err := q.pool.Exec(ctx, fmt.Sprintf(
		`DELETE FROM skip_marker_analysis WHERE %s = $1`, col), fileID)
	return err
}

// ReplaceAutoSkipMarkers is the analyzer's single write path for one
// file: in a transaction it (1) deletes the file's previous NON-manual
// markers, (2) inserts the fresh detections — skipping any kind an
// admin has a manual row for, and (3) records the file as analyzed by
// `detector` in the ledger. Passing zero markers is the "analyzed,
// nothing found" case and still writes the ledger row.
func (q *Queries) ReplaceAutoSkipMarkers(ctx context.Context, fileID int64, isEpisode bool, markers []models.SkipMarker, detector string) error {
	col := skipMarkerFileColumn(isEpisode)

	tx, err := q.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck — no-op after commit

	if _, err := tx.Exec(ctx, fmt.Sprintf(
		`DELETE FROM skip_markers WHERE %s = $1 AND detector <> 'manual'`, col), fileID); err != nil {
		return fmt.Errorf("clear auto markers: %w", err)
	}
	for _, m := range markers {
		// DO NOTHING on conflict: the only row that can conflict after
		// the DELETE above is a manual one, and manual wins.
		if _, err := tx.Exec(ctx, fmt.Sprintf(`
			INSERT INTO skip_markers (%s, kind, start_ms, end_ms, confidence, detector)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (%s, kind) WHERE %s IS NOT NULL DO NOTHING`, col, col, col),
			fileID, m.Kind, m.StartMs, m.EndMs, m.Confidence, m.Detector); err != nil {
			return fmt.Errorf("insert marker %s: %w", m.Kind, err)
		}
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(`
		INSERT INTO skip_marker_analysis (%s, detector)
		VALUES ($1, $2)
		ON CONFLICT (%s) WHERE %s IS NOT NULL
		DO UPDATE SET detector = EXCLUDED.detector, analyzed_at = NOW()`, col, col, col),
		fileID, detector); err != nil {
		return fmt.Errorf("record analysis: %w", err)
	}
	return tx.Commit(ctx)
}

// SkipAnalysisFile is one episode file the season analyzer works on.
type SkipAnalysisFile struct {
	FileID        int64
	EpisodeID     int64
	EpisodeNumber int
	Path          string
	DurationMs    int64
	// Pending is false when the current detector already analyzed this
	// file — it then participates as alignment material for its
	// neighbors but doesn't get markers rewritten.
	Pending bool
}

// FetchPendingSkipSeasons returns season IDs that contain at least one
// episode file the current detector hasn't analyzed yet, oldest seasons
// first for stable progress. The analyzer works season-at-a-time
// because intros only recur within a season's shared theme.
func (q *Queries) FetchPendingSkipSeasons(ctx context.Context, detector string, limit int) ([]int64, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT DISTINCT e.season_id
		FROM episode_files ef
		JOIN tv_episodes e ON e.id = ef.episode_id
		LEFT JOIN skip_marker_analysis a
		       ON a.episode_file_id = ef.id AND a.detector = $1
		WHERE a.episode_file_id IS NULL
		ORDER BY e.season_id
		LIMIT $2`, detector, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// GetSeasonSkipAnalysisFiles returns every file in a season ordered by
// episode number, flagged with whether the current detector still owes
// it an analysis. Already-analyzed neighbors are included because the
// pairwise alignment needs their audio even when their markers are
// already stored.
func (q *Queries) GetSeasonSkipAnalysisFiles(ctx context.Context, seasonID int64, detector string) ([]SkipAnalysisFile, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT ef.id, e.id, e.episode_number, ef.path, COALESCE(ef.duration_ms, 0),
		       (a.episode_file_id IS NULL) AS pending
		FROM episode_files ef
		JOIN tv_episodes e ON e.id = ef.episode_id
		LEFT JOIN skip_marker_analysis a
		       ON a.episode_file_id = ef.id AND a.detector = $2
		WHERE e.season_id = $1
		ORDER BY e.episode_number, ef.id`, seasonID, detector)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []SkipAnalysisFile
	for rows.Next() {
		var f SkipAnalysisFile
		if err := rows.Scan(&f.FileID, &f.EpisodeID, &f.EpisodeNumber, &f.Path, &f.DurationMs, &f.Pending); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

// SkipMovieFile is one movie file pending credits detection.
type SkipMovieFile struct {
	FileID     int64
	Path       string
	DurationMs int64
}

// FetchPendingSkipMovieFiles returns movie files the current detector
// hasn't analyzed yet (movies only get credits detection — there is no
// cross-episode audio to correlate).
func (q *Queries) FetchPendingSkipMovieFiles(ctx context.Context, detector string, limit int) ([]SkipMovieFile, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT mf.id, mf.path, COALESCE(mf.duration_ms, 0)
		FROM media_files mf
		JOIN media_items mi ON mi.id = mf.media_item_id AND mi.type = 'movie'
		LEFT JOIN skip_marker_analysis a
		       ON a.media_file_id = mf.id AND a.detector = $1
		WHERE a.media_file_id IS NULL
		ORDER BY mf.id
		LIMIT $2`, detector, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []SkipMovieFile
	for rows.Next() {
		var f SkipMovieFile
		if err := rows.Scan(&f.FileID, &f.Path, &f.DurationMs); err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

// SkipMarkerStatus is the admin-dashboard coverage snapshot.
type SkipMarkerStatus struct {
	EpisodeTotal    int64 `json:"episode_files_total"`
	EpisodeAnalyzed int64 `json:"episode_files_analyzed"`
	MovieTotal      int64 `json:"movie_files_total"`
	MovieAnalyzed   int64 `json:"movie_files_analyzed"`
	IntroMarkers    int64 `json:"intro_markers"`
	RecapMarkers    int64 `json:"recap_markers"`
	CreditsMarkers  int64 `json:"credits_markers"`
	ManualMarkers   int64 `json:"manual_markers"`
}

// GetSkipMarkerStatus aggregates coverage counts for the admin status
// endpoint. A handful of COUNTs over indexed tables — safe to poll.
func (q *Queries) GetSkipMarkerStatus(ctx context.Context, detector string) (*SkipMarkerStatus, error) {
	s := &SkipMarkerStatus{}
	err := q.pool.QueryRow(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM episode_files),
		  (SELECT COUNT(*) FROM skip_marker_analysis WHERE episode_file_id IS NOT NULL AND detector = $1),
		  (SELECT COUNT(*) FROM media_files mf JOIN media_items mi ON mi.id = mf.media_item_id AND mi.type = 'movie'),
		  (SELECT COUNT(*) FROM skip_marker_analysis WHERE media_file_id IS NOT NULL AND detector = $1),
		  (SELECT COUNT(*) FROM skip_markers WHERE kind = 'intro' AND end_ms > start_ms),
		  (SELECT COUNT(*) FROM skip_markers WHERE kind = 'recap' AND end_ms > start_ms),
		  (SELECT COUNT(*) FROM skip_markers WHERE kind = 'credits' AND end_ms > start_ms),
		  (SELECT COUNT(*) FROM skip_markers WHERE detector = 'manual')`,
		detector).Scan(
		&s.EpisodeTotal, &s.EpisodeAnalyzed,
		&s.MovieTotal, &s.MovieAnalyzed,
		&s.IntroMarkers, &s.RecapMarkers, &s.CreditsMarkers, &s.ManualMarkers)
	if err != nil {
		return nil, err
	}
	return s, nil
}
