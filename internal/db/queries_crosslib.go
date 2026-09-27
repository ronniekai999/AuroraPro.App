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
//
// A sibling is matched on (tmdb_id, TYPE), never on tmdb_id alone: TMDB's
// movie and TV id spaces are INDEPENDENT, so movie 100 and tv 100 are
// unrelated titles. migrations/011_cross_library_linking.up.sql ships
// idx_media_items_tmdb_type for exactly this predicate.
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
// sibling media_items that share the same tmdb_id AND type (but in different
// libraries). Each file is annotated with the library name it belongs to.
// Returns nil if the item has no tmdb_id (not yet enriched).
//
// The type must match, not just the tmdb_id: TMDB's movie and TV id spaces are
// independent, so movie 100 and tv 100 are unrelated titles. Without it, a
// colliding movie's files were attached to a show's detail page as its own
// versions (this is called for show details from phase2_handlers.go), and the
// caller then derived has_4k from a movie's file.
func (q *Queries) GetCrossLibraryFiles(ctx context.Context, mediaItemID int64) ([]*models.MediaFile, map[int64]string, error) {
	// First, get the tmdb_id and type for this item
	var tmdbID *int
	var itemType string
	err := q.pool.QueryRow(ctx,
		`SELECT tmdb_id, type FROM media_items WHERE id = $1`, mediaItemID,
	).Scan(&tmdbID, &itemType)
	if err != nil {
		return nil, nil, fmt.Errorf("get item tmdb_id: %w", err)
	}
	if tmdbID == nil || *tmdbID == 0 {
		// Not enriched — no cross-library linking possible
		return nil, nil, nil
	}

	// Query files from ALL media_items with this tmdb_id and type, including the
	// current one
	rows, err := q.pool.Query(ctx, `
		SELECT mf.id, mf.media_item_id, mf.path, mf.size_bytes, COALESCE(mf.container, ''),
		       COALESCE(mf.video_codec, ''), COALESCE(mf.audio_codec, ''),
		       COALESCE(mf.resolution, ''), COALESCE(mf.bitrate, 0),
		       COALESCE(mf.duration_ms, 0), mf.file_hash, mf.scanned_at, mf.audio_tracks,
		       mf.subtitle_tracks, mf.version_tag, mf.video_profile, mf.video_pix_fmt, mf.color_transfer, mf.color_primaries, mf.video_fps,
		       l.name AS library_name
		FROM media_files mf
		JOIN media_items mi ON mi.id = mf.media_item_id
		JOIN libraries l ON l.id = mi.library_id
		WHERE mi.tmdb_id = $1 AND mi.tmdb_id > 0 AND mi.type = $2
		ORDER BY CASE mf.version_tag
			WHEN '4K' THEN 1 WHEN '1080p' THEN 2 WHEN '720p' THEN 3 ELSE 4
		END, mf.id`, *tmdbID, itemType)
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
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt, &f.ColorTransfer, &f.ColorPrimaries, &f.VideoFPS,
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
// media_items that share the same tmdb_id (and, necessarily, type — see the
// inert-predicate note in the query below).
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

	// Find all episode files matching this season/episode across all sibling items.
	//
	// The `mi.type = 'show'` predicate is INERT and deliberately kept: this query
	// reaches media_items only through tv_episodes, which solely the TV scan branch
	// ever writes, so no movie row can be reached here. It is stated for
	// explicitness and selectivity, not to fix a live defect (and not for index
	// eligibility — mi.tmdb_id = $1 already matches the leading column of
	// idx_media_items_tmdb_type).
	rows, err := q.pool.Query(ctx, `
		SELECT ef.id, ef.episode_id, ef.path, ef.size_bytes, COALESCE(ef.container, ''),
		       COALESCE(ef.video_codec, ''), COALESCE(ef.audio_codec, ''),
		       COALESCE(ef.resolution, ''), COALESCE(ef.bitrate, 0),
		       COALESCE(ef.duration_ms, 0), ef.file_hash, ef.scanned_at, ef.audio_tracks,
		       ef.subtitle_tracks, ef.version_tag, ef.video_profile, ef.video_pix_fmt, ef.color_transfer, ef.color_primaries, ef.video_fps,
		       l.name AS library_name
		FROM episode_files ef
		JOIN tv_episodes e ON e.id = ef.episode_id
		JOIN tv_seasons s ON s.id = e.season_id
		JOIN media_items mi ON mi.id = e.media_item_id
		JOIN libraries l ON l.id = mi.library_id
		WHERE mi.tmdb_id = $1 AND mi.tmdb_id > 0 AND mi.type = 'show'
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
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt, &f.ColorTransfer, &f.ColorPrimaries, &f.VideoFPS,
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
	// all sibling shows (same tmdb_id and type) by season_number + episode_number.
	//
	// The `mi.type = 'show'` predicate is INERT and deliberately kept: the
	// tv_seasons join below already restricts mi to rows that have seasons, which
	// only the TV scan branch writes. It is stated for explicitness and
	// selectivity, not for index eligibility (mi.tmdb_id = $1 already matches the
	// index's leading column).
	rows, err := q.pool.Query(ctx, `
		SELECT ef.id, ef.episode_id, ef.path, ef.size_bytes, COALESCE(ef.container, ''),
		       COALESCE(ef.video_codec, ''), COALESCE(ef.audio_codec, ''),
		       COALESCE(ef.resolution, ''), COALESCE(ef.bitrate, 0),
		       COALESCE(ef.duration_ms, 0), ef.file_hash, ef.scanned_at, ef.audio_tracks,
		       ef.subtitle_tracks, ef.version_tag, ef.video_profile, ef.video_pix_fmt, ef.color_transfer, ef.color_primaries, ef.video_fps,
		       l.name AS library_name,
		       src_ep.id AS src_episode_id
		FROM tv_episodes src_ep
		JOIN tv_seasons src_s ON src_s.id = src_ep.season_id
		JOIN media_items mi ON mi.tmdb_id = $1 AND mi.type = 'show'
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
			&f.FileHash, &f.ScannedAt, &audioJSON, &subtitleJSON, &f.VersionTag, &f.VideoProfile, &f.VideoPixFmt, &f.ColorTransfer, &f.ColorPrimaries, &f.VideoFPS,
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
// sibling media_items that share the same tmdb_id AND type. If "Inception" in
// library A has no 4K file, but "Inception" in library B does, both should show
// the 4K badge.
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

	// Find which of these items have siblings (via tmdb_id AND type) that have
	// 4K files. The type must match: TMDB's movie and TV id spaces are
	// independent, so without it a movie sharing a numeric id with a show lent
	// it a 4K badge it had not earned (and vice versa).
	rows, err := q.pool.Query(ctx, `
		SELECT DISTINCT src.id
		FROM media_items src
		JOIN media_items sibling ON sibling.tmdb_id = src.tmdb_id
		    AND sibling.type = src.type
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

// GetMediaItemsWithHDRCrossLibrary extends GetMediaItemsWithHDR to also
// check sibling media_items that share the same tmdb_id AND type, exactly like
// GetMediaItemsWith4KCrossLibrary does for 4K. If "Dune" in library A has
// no HDR file but "Dune" in library B does, both show the HDR badge. HDR
// is detected via color_transfer (hdrColorTransfers), not version_tag.
func (q *Queries) GetMediaItemsWithHDRCrossLibrary(ctx context.Context, mediaItemIDs []int64) (map[int64]bool, error) {
	if len(mediaItemIDs) == 0 {
		return map[int64]bool{}, nil
	}

	// Step 1: direct HDR results.
	directResult, err := q.GetMediaItemsWithHDR(ctx, mediaItemIDs)
	if err != nil {
		return nil, err
	}

	// Step 2: for items without direct HDR, check cross-library siblings.
	var needsCrossCheck []int64
	for _, id := range mediaItemIDs {
		if !directResult[id] {
			needsCrossCheck = append(needsCrossCheck, id)
		}
	}
	if len(needsCrossCheck) == 0 {
		return directResult, nil
	}

	// Siblings match on tmdb_id AND type, for the same reason as the 4K variant:
	// TMDB's movie and TV id spaces are independent.
	rows, err := q.pool.Query(ctx, `
		SELECT DISTINCT src.id
		FROM media_items src
		JOIN media_items sibling ON sibling.tmdb_id = src.tmdb_id
		    AND sibling.type = src.type
		    AND sibling.id != src.id
		    AND sibling.tmdb_id IS NOT NULL
		WHERE src.id = ANY($1)
		  AND src.tmdb_id IS NOT NULL AND src.tmdb_id > 0
		  AND (
		    EXISTS (
		      SELECT 1 FROM media_files mf
		      WHERE mf.media_item_id = sibling.id AND mf.color_transfer = ANY($2)
		    )
		    OR EXISTS (
		      SELECT 1 FROM episode_files ef
		      JOIN tv_episodes e ON e.id = ef.episode_id
		      WHERE e.media_item_id = sibling.id AND ef.color_transfer = ANY($2)
		    )
		  )`, needsCrossCheck, hdrColorTransfers)
	if err != nil {
		return nil, fmt.Errorf("cross-library HDR check: %w", err)
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
// share the same tmdb_id AND type across different libraries. For each group of
// duplicates, it keeps the item with the richest metadata (most non-empty
// fields) and annotates it with has_4k=true if any sibling has 4K files.
//
// The type is part of the grouping key, not just the tmdb_id: TMDB's movie and
// TV id spaces are INDEPENDENT, so movie 100 and tv 100 are unrelated titles.
// Grouping on the id alone collapsed a colliding movie and show into one
// search result, which made one of the two unreachable from search entirely.
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

	// Fetch tmdb_ids and types for all items. The type is read from the DB
	// rather than taken from item.Type so the grouping cannot be skewed by a
	// caller that left the field unpopulated.
	rows, err := q.pool.Query(ctx,
		`SELECT id, tmdb_id, type FROM media_items WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("fetch tmdb_ids for dedup: %w", err)
	}
	defer rows.Close()

	// siblingKey identifies one cross-library title: a tmdb_id within a type.
	type siblingKey struct {
		tmdbID int
		typ    string
	}

	keyMap := make(map[int64]siblingKey) // media_item_id -> (tmdb_id, type)
	for rows.Next() {
		var id int64
		var tmdbID *int
		var itemType string
		if err := rows.Scan(&id, &tmdbID, &itemType); err != nil {
			return nil, err
		}
		if tmdbID != nil && *tmdbID > 0 {
			keyMap[id] = siblingKey{tmdbID: *tmdbID, typ: itemType}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Group items by (tmdb_id, type)
	type group struct {
		key   siblingKey
		items []*models.MediaItem
	}
	seenTMDB := make(map[siblingKey]*group) // (tmdb_id, type) -> group
	var result []*models.MediaItem

	for _, item := range items {
		key, hasTMDB := keyMap[item.ID]
		if !hasTMDB {
			// No TMDB ID -- keep it as-is, no dedup possible
			result = append(result, item)
			continue
		}

		if g, exists := seenTMDB[key]; exists {
			// Already seen this (TMDB ID, type) -- add to group
			g.items = append(g.items, item)
		} else {
			// First time seeing this (TMDB ID, type)
			g := &group{key: key, items: []*models.MediaItem{item}}
			seenTMDB[key] = g
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

		// Replace the slot in result with the best item. The slot is matched on
		// the full (tmdb_id, type) key: matching on the tmdb_id alone would let
		// a show's winner overwrite a colliding movie's slot, which is the same
		// cross-type defect as the grouping itself, one step removed.
		for i, item := range result {
			if key, ok := keyMap[item.ID]; ok && key == g.key {
				// Propagate has_4k / has_hdr from any sibling so the
				// winning item carries the union of quality flags across
				// the dedup group (symmetry: both badges survive dedup).
				for _, sibling := range g.items {
					if sibling.Has4K {
						best.Has4K = true
						break
					}
				}
				for _, sibling := range g.items {
					if sibling.HasHDR {
						best.HasHDR = true
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
