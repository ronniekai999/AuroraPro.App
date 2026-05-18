package db

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/aurora-media/aurora/internal/models"
)

// unmarshalTracks decodes the JSON column into v with a log at warn level on
// failure. A corrupt audio/subtitle JSON used to silently leave the tracks
// empty, which DecidePlayback then interpreted as "no audio" and could pick
// direct_play for an actually-incompatible file. Logging surfaces the bad
// row instead of letting it cause undebuggable playback decisions.
func unmarshalTracks(raw []byte, v any, fileID int64, kind string) {
	if raw == nil {
		return
	}
	if err := json.Unmarshal(raw, v); err != nil {
		slog.Warn("crosslib: corrupt track JSON; treating as empty",
			"file_id", fileID, "kind", kind, "error", err)
	}
}

// ============================================================
// Cross-Library Version Linking
//
// When the same movie or show exists in multiple libraries (e.g., "Movies"
// and "4K Movies"), both media_items share the same tmdb_id but have
// different library_id values. These queries aggregate files across all
// such sibling items so the user sees a unified version selector.
// ============================================================

// GetTMDBIDForItem returns the tmdb_id for a media item, or 0 if not enriched.
func (q *Queries) GetTMDBIDForItem(ctx context.Context, mediaItemID int64) (int, error) {
	var tmdbID *int
	err := q.pool.QueryRow(ctx,
		`SELECT tmdb_id FROM media_items WHERE id = $1`, mediaItemID,
	).Scan(&tmdbID)
	if err != nil {
		return 0, err
	}
	if tmdbID == nil {
		return 0, nil
	}
	return *tmdbID, nil
}

// GetCrossLibraryFiles returns all media_files for a given media item AND all
// sibling media_items that share the same tmdb_id (but in different libraries).
// Each file is annotated with the library name it belongs to.
// Returns nil if the item has no tmdb_id (not yet enriched).
func (q *Queries) GetCrossLibraryFiles(ctx context.Context, mediaItemID int64) ([]*models.MediaFile, map[int64]string, error) {
	// First, get the tmdb_id for this item
	var tmdbID *int
	err := q.pool.QueryRow(ctx,
		`SELECT tmdb_id FROM media_items WHERE id = $1`, mediaItemID,
	).Scan(&tmdbID)
	if err != nil {
		return nil, nil, fmt.Errorf("get item tmdb_id: %w", err)
	}
	if tmdbID == nil || *tmdbID == 0 {
		// Not enriched — no cross-library linking possible
		return nil, nil, nil
	}

	// Query files from ALL media_items with this tmdb_id, including the current one
	rows, err := q.pool.Query(ctx, `
		SELECT mf.id, mf.media_item_id, mf.path, mf.size_bytes, mf.container,
		       mf.video_codec, mf.audio_codec, mf.resolution, mf.bitrate,
		       mf.duration_ms, mf.file_hash, mf.scanned_at, mf.audio_tracks,
		       mf.subtitle_tracks, mf.version_tag, mf.video_profile, mf.video_pix_fmt,
		       l.name AS library_name
		FROM media_files mf
		JOIN media_items mi ON mi.id = mf.media_item_id
		JOIN libraries l ON l.id = mi.library_id
		WHERE mi.tmdb_id = $1 AND mi.tmdb_id > 0
		ORDER BY CASE mf.version_tag
			WHEN '4K' THEN 1 WHEN '1080p' THEN 2 WHEN '720p' THEN 3 ELSE 4
		END, mf.id`, *tmdbID)
	if err != nil {
		return nil, nil, fmt.Errorf("get cross-library files: %w", err)
	}
	defer rows.Close()

	var files []*models.MediaFile
	libraryNames := make(map[int64]string) // file_id -> library_name
	for rows.Next() {
		f := &models.MediaFile{}
		var audioJSON, subtitleJSON []byte
		var libName string
		if err := rows.Scan(&f.ID, &f.MediaItemID, &f.Path, &f.SizeBytes, &f.Container,
			&f.VideoCodec, &f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs,
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt,
			&libName); err != nil {
			return nil, nil, fmt.Errorf("scan cross-library file: %w", err)
		}
		unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
		unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
		files = append(files, f)
		libraryNames[f.ID] = libName
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate cross-library files: %w", err)
	}

	return files, libraryNames, nil
}

// GetCrossLibraryEpisodeFiles returns all episode_files for a given episode
// AND matching episodes (same season_number + episode_number) in sibling
// media_items that share the same tmdb_id.
func (q *Queries) GetCrossLibraryEpisodeFiles(ctx context.Context, episodeID int64, tmdbID int) ([]*models.EpisodeFile, map[int64]string, error) {
	if tmdbID == 0 {
		return nil, nil, nil
	}

	// Get the season_number and episode_number for this episode
	var seasonNum, episodeNum int
	err := q.pool.QueryRow(ctx, `
		SELECT s.season_number, e.episode_number
		FROM tv_episodes e
		JOIN tv_seasons s ON s.id = e.season_id
		WHERE e.id = $1`, episodeID,
	).Scan(&seasonNum, &episodeNum)
	if err != nil {
		return nil, nil, fmt.Errorf("get episode info: %w", err)
	}

	// Find all episode files matching this season/episode across all sibling items
	rows, err := q.pool.Query(ctx, `
		SELECT ef.id, ef.episode_id, ef.path, ef.size_bytes, ef.container,
		       ef.video_codec, ef.audio_codec, ef.resolution, ef.bitrate,
		       ef.duration_ms, ef.file_hash, ef.scanned_at, ef.audio_tracks,
		       ef.subtitle_tracks, ef.version_tag, ef.video_profile, ef.video_pix_fmt,
		       l.name AS library_name
		FROM episode_files ef
		JOIN tv_episodes e ON e.id = ef.episode_id
		JOIN tv_seasons s ON s.id = e.season_id
		JOIN media_items mi ON mi.id = e.media_item_id
		JOIN libraries l ON l.id = mi.library_id
		WHERE mi.tmdb_id = $1 AND mi.tmdb_id > 0
		  AND s.season_number = $2
		  AND e.episode_number = $3
		ORDER BY CASE ef.version_tag
			WHEN '4K' THEN 1 WHEN '1080p' THEN 2 WHEN '720p' THEN 3 ELSE 4
		END, ef.id`, tmdbID, seasonNum, episodeNum)
	if err != nil {
		return nil, nil, fmt.Errorf("get cross-library episode files: %w", err)
	}
	defer rows.Close()

	var files []*models.EpisodeFile
	libraryNames := make(map[int64]string)
	for rows.Next() {
		f := &models.EpisodeFile{}
		var audioJSON, subtitleJSON []byte
		var libName string
		if err := rows.Scan(&f.ID, &f.EpisodeID, &f.Path, &f.SizeBytes, &f.Container,
			&f.VideoCodec, &f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs,
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt,
			&libName); err != nil {
			return nil, nil, fmt.Errorf("scan cross-library episode file: %w", err)
		}
		unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
		unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
		files = append(files, f)
		libraryNames[f.ID] = libName
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate cross-library episode files: %w", err)
	}

	return files, libraryNames, nil
}

// GetCrossLibraryEpisodeFilesBatch fetches cross-library episode files for multiple
// episodes in a single query, avoiding the N+1 pattern. Returns a map of
// episode_id -> files and episode_id -> file_id -> library_name.
func (q *Queries) GetCrossLibraryEpisodeFilesBatch(ctx context.Context, episodeIDs []int64, tmdbID int) (map[int64][]*models.EpisodeFile, map[int64]string, error) {
	if tmdbID == 0 || len(episodeIDs) == 0 {
		return nil, nil, nil
	}

	// Single query: for each episode in the batch, find matching episodes across
	// all sibling shows (same tmdb_id) by season_number + episode_number
	rows, err := q.pool.Query(ctx, `
		SELECT ef.id, ef.episode_id, ef.path, ef.size_bytes, ef.container,
		       ef.video_codec, ef.audio_codec, ef.resolution, ef.bitrate,
		       ef.duration_ms, ef.file_hash, ef.scanned_at, ef.audio_tracks,
		       ef.subtitle_tracks, ef.version_tag, ef.video_profile, ef.video_pix_fmt,
		       l.name AS library_name,
		       src_ep.id AS src_episode_id
		FROM tv_episodes src_ep
		JOIN tv_seasons src_s ON src_s.id = src_ep.season_id
		JOIN media_items mi ON mi.tmdb_id = $1
		JOIN tv_seasons s ON s.media_item_id = mi.id AND s.season_number = src_s.season_number
		JOIN tv_episodes e ON e.season_id = s.id AND e.episode_number = src_ep.episode_number
		JOIN episode_files ef ON ef.episode_id = e.id
		JOIN libraries l ON l.id = mi.library_id
		WHERE src_ep.id = ANY($2)
		ORDER BY src_ep.id, CASE ef.version_tag
			WHEN '4K' THEN 1 WHEN '1080p' THEN 2 WHEN '720p' THEN 3 ELSE 4
		END, ef.id`, tmdbID, episodeIDs)
	if err != nil {
		return nil, nil, fmt.Errorf("batch cross-library episode files: %w", err)
	}
	defer rows.Close()

	result := make(map[int64][]*models.EpisodeFile)
	libraryNames := make(map[int64]string)
	for rows.Next() {
		f := &models.EpisodeFile{}
		var audioJSON, subtitleJSON []byte
		var libName string
		var srcEpID int64
		if err := rows.Scan(&f.ID, &f.EpisodeID, &f.Path, &f.SizeBytes, &f.Container,
			&f.VideoCodec, &f.AudioCodec, &f.Resolution, &f.Bitrate, &f.DurationMs,
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt,
			&libName, &srcEpID); err != nil {
			return nil, nil, fmt.Errorf("scan batch episode file: %w", err)
		}
		unmarshalTracks(audioJSON, &f.AudioTracks, f.ID, "audio")
		unmarshalTracks(subtitleJSON, &f.SubtitleTracks, f.ID, "subtitle")
		result[srcEpID] = append(result[srcEpID], f)
		libraryNames[f.ID] = libName
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate batch episode files: %w", err)
	}

	return result, libraryNames, nil
}

// GetMediaItemsWith4KCrossLibrary extends GetMediaItemsWith4K to also check
// sibling media_items that share the same tmdb_id. If "Inception" in library A
// has no 4K file, but "Inception" in library B does, both should show the 4K badge.
func (q *Queries) GetMediaItemsWith4KCrossLibrary(ctx context.Context, mediaItemIDs []int64) (map[int64]bool, error) {
	if len(mediaItemIDs) == 0 {
		return map[int64]bool{}, nil
	}

	// Step 1: Get the direct 4K results (same as before)
	directResult, err := q.GetMediaItemsWith4K(ctx, mediaItemIDs)
	if err != nil {
		return nil, err
	}

	// Step 2: For items that DON'T have 4K directly, check cross-library siblings
	// Collect tmdb_ids for items without direct 4K
	var needsCrossCheck []int64
	for _, id := range mediaItemIDs {
		if !directResult[id] {
			needsCrossCheck = append(needsCrossCheck, id)
		}
	}
	if len(needsCrossCheck) == 0 {
		return directResult, nil
	}

	// Find which of these items have siblings (via tmdb_id) that have 4K files
	rows, err := q.pool.Query(ctx, `
		SELECT DISTINCT src.id
		FROM media_items src
		JOIN media_items sibling ON sibling.tmdb_id = src.tmdb_id
		    AND sibling.id != src.id
		    AND sibling.tmdb_id IS NOT NULL
		WHERE src.id = ANY($1)
		  AND src.tmdb_id IS NOT NULL AND src.tmdb_id > 0
		  AND (
		    EXISTS (
		      SELECT 1 FROM media_files mf
		      WHERE mf.media_item_id = sibling.id AND mf.version_tag LIKE '4K%'
		    )
		    OR EXISTS (
		      SELECT 1 FROM episode_files ef
		      JOIN tv_episodes e ON e.id = ef.episode_id
		      WHERE e.media_item_id = sibling.id AND ef.version_tag LIKE '4K%'
		    )
		  )`, needsCrossCheck)
	if err != nil {
		return nil, fmt.Errorf("cross-library 4K check: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		directResult[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return directResult, nil
}

// DeduplicateByTMDBID takes a list of media items and deduplicates items that
// share the same tmdb_id across different libraries. For each group of duplicates,
// it keeps the item with the richest metadata (most non-empty fields) and annotates
// it with has_4k=true if any sibling has 4K files.
//
// Items without a tmdb_id are always kept (they can't be linked).
// Returns the deduplicated list.
func (q *Queries) DeduplicateByTMDBID(ctx context.Context, items []*models.MediaItem) ([]*models.MediaItem, error) {
	if len(items) == 0 {
		return items, nil
	}

	// Collect all item IDs to look up tmdb_ids in bulk
	ids := make([]int64, len(items))
	for i, item := range items {
		ids[i] = item.ID
	}

	// Fetch tmdb_ids for all items
	rows, err := q.pool.Query(ctx,
		`SELECT id, tmdb_id FROM media_items WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("fetch tmdb_ids for dedup: %w", err)
	}
	defer rows.Close()

	tmdbMap := make(map[int64]int) // media_item_id -> tmdb_id
	for rows.Next() {
		var id int64
		var tmdbID *int
		if err := rows.Scan(&id, &tmdbID); err != nil {
			return nil, err
		}
		if tmdbID != nil && *tmdbID > 0 {
			tmdbMap[id] = *tmdbID
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Group items by tmdb_id
	type group struct {
		tmdbID int
		items  []*models.MediaItem
	}
	seenTMDB := make(map[int]*group) // tmdb_id -> group
	var result []*models.MediaItem

	for _, item := range items {
		tmdbID, hasTMDB := tmdbMap[item.ID]
		if !hasTMDB {
			// No TMDB ID -- keep it as-is, no dedup possible
			result = append(result, item)
			continue
		}

		if g, exists := seenTMDB[tmdbID]; exists {
			// Already seen this TMDB ID -- add to group
			g.items = append(g.items, item)
		} else {
			// First time seeing this TMDB ID
			g := &group{tmdbID: tmdbID, items: []*models.MediaItem{item}}
			seenTMDB[tmdbID] = g
			// Reserve a slot in the result -- we'll fill it with the best item
			result = append(result, item)
		}
	}

	// For each group with multiple items, pick the best one
	for _, g := range seenTMDB {
		if len(g.items) <= 1 {
			continue
		}

		best := g.items[0]
		bestScore := metadataRichness(best)
		for _, item := range g.items[1:] {
			score := metadataRichness(item)
			if score > bestScore {
				best = item
				bestScore = score
			}
		}

		// Replace the slot in result with the best item
		for i, item := range result {
			tmdbID := tmdbMap[item.ID]
			if tmdbID == g.tmdbID {
				// Propagate has_4k from any sibling
				for _, sibling := range g.items {
					if sibling.Has4K {
						best.Has4K = true
						break
					}
				}
				result[i] = best
				break
			}
		}
	}

	return result, nil
}

// metadataRichness scores how complete a media item's metadata is.
// Higher = more complete. Used to pick the "best" item among cross-library dups.
func metadataRichness(item *models.MediaItem) int {
	score := 0
	if item.Overview != "" {
		score += 3
	}
	if item.PosterPath != "" {
		score += 3
	}
	if item.BackdropPath != "" {
		score += 2
	}
	if item.Rating > 0 {
		score += 2
	}
	if item.RuntimeMin > 0 {
		score += 1
	}
	if item.ContentRating != "" {
		score += 1
	}
	if item.Year > 0 {
		score += 1
	}
	if len(item.Genres) > 0 {
		score += 1
	}
	return score
}
