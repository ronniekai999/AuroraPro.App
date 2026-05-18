package metadata

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/models"
)

// handleDuplicateMetadata merges a duplicate media item into the canonical one
// when UpdateMediaMetadata detects a unique constraint violation. Returns true
// if the error was a duplicate and was handled, false otherwise.
func (e *Enricher) handleDuplicateMetadata(ctx context.Context, err error, itemTitle string) bool {
	dme, ok := db.AsDuplicateMetadata(err)
	if !ok {
		return false
	}
	if dme.CanonicalID == 0 {
		slog.Warn("duplicate metadata but could not find canonical item",
			"constraint", dme.Constraint,
			"duplicate_id", dme.DuplicateID,
			"title", itemTitle)
		return true // still a duplicate, just can't auto-merge
	}
	slog.Info("merging duplicate media item into canonical",
		"canonical_id", dme.CanonicalID,
		"duplicate_id", dme.DuplicateID,
		"constraint", dme.Constraint,
		"title", itemTitle)
	if mergeErr := e.queries.MergeMediaItems(ctx, dme.CanonicalID, dme.DuplicateID); mergeErr != nil {
		slog.Warn("failed to merge duplicate media item",
			"canonical_id", dme.CanonicalID,
			"duplicate_id", dme.DuplicateID,
			"error", mergeErr)
	} else {
		// Mark the canonical item as "matched" so it leaves the flagged list
		if setErr := e.queries.SetMatchStatus(ctx, dme.CanonicalID, "matched"); setErr != nil {
			slog.Warn("failed to set match status on canonical after merge",
				"canonical_id", dme.CanonicalID, "error", setErr)
		}
	}
	return true
}

// Enricher coordinates TMDB/TVDB lookups and persists results to the database.
type Enricher struct {
	tmdb            *TMDBClient
	tvdb            *TVDBClient // optional — nil when TVDB is disabled
	queries         *db.Queries
	imgProxy        *ImageProxy // optional — nil means no eager caching
	autoThreshold   int        // confidence >= this → "matched" (default 85)
	reviewThreshold int        // confidence >= this → "needs_review" (default 50)
}

// NewEnricher creates a metadata enricher.
// tvdb may be nil if TVDB is not configured.
// imgProxy may be nil; if provided, images are eagerly cached during enrichment.
func NewEnricher(tmdb *TMDBClient, tvdb *TVDBClient, queries *db.Queries, imgProxy ...*ImageProxy) *Enricher {
	e := &Enricher{
		tmdb:            tmdb,
		tvdb:            tvdb,
		queries:         queries,
		autoThreshold:   85,
		reviewThreshold: 50,
	}
	if len(imgProxy) > 0 {
		e.imgProxy = imgProxy[0]
	}
	return e
}

// SetThresholds overrides the default confidence thresholds.
// autoThreshold: confidence >= this is auto-matched (env: MATCH_AUTO_THRESHOLD, default 85).
// reviewThreshold: confidence >= this is flagged for review (env: MATCH_REVIEW_THRESHOLD, default 50).
func (e *Enricher) SetThresholds(autoThreshold, reviewThreshold int) {
	e.autoThreshold = autoThreshold
	e.reviewThreshold = reviewThreshold
}

// GetTMDB returns the underlying TMDB client for direct searches.
func (e *Enricher) GetTMDB() *TMDBClient {
	return e.tmdb
}

// GetTVDB returns the underlying TVDB client (may be nil).
func (e *Enricher) GetTVDB() *TVDBClient {
	return e.tvdb
}

// TVDBEnabled returns true if TVDB fallback is available.
func (e *Enricher) TVDBEnabled() bool {
	return e.tvdb != nil
}

// EnrichMediaItem looks up a media item on TMDB and populates metadata, artwork, and cast.
// Returns the match confidence score (0-100), or 0 if no match was found.
// Also sets match_status to "needs_review" (50-84) or "matched" (>=85).
func (e *Enricher) EnrichMediaItem(ctx context.Context, item *models.MediaItem) (int, error) {
	cleanTitle := CleanTitle(item.Title)

	var confidence int
	var err error
	switch item.Type {
	case models.MediaMovie:
		confidence, err = e.enrichMovie(ctx, item, cleanTitle)
	case models.MediaShow:
		confidence, err = e.enrichShow(ctx, item, cleanTitle)
	default:
		return 0, fmt.Errorf("unknown media type: %s", item.Type)
	}

	// Set match status based on confidence (non-blocking)
	if confidence >= e.autoThreshold {
		if setErr := e.queries.SetMatchStatus(ctx, item.ID, "matched"); setErr != nil {
			slog.Warn("failed to set match status", "item_id", item.ID, "error", setErr)
		}
	} else if confidence >= e.reviewThreshold {
		if setErr := e.queries.SetMatchStatus(ctx, item.ID, "needs_review"); setErr != nil {
			slog.Warn("failed to set match status", "item_id", item.ID, "error", setErr)
		}
	}

	return confidence, err
}

func (e *Enricher) enrichMovie(ctx context.Context, item *models.MediaItem, title string) (int, error) {
	results, err := e.tmdb.SearchMovies(ctx, title, item.Year)
	if err != nil {
		return 0, fmt.Errorf("search movies: %w", err)
	}
	if len(results.Results) == 0 {
		// Retry without year constraint (year from filename might be wrong)
		if item.Year > 0 {
			results, err = e.tmdb.SearchMovies(ctx, title, 0)
			if err != nil {
				return 0, fmt.Errorf("search movies retry: %w", err)
			}
		}
		if len(results.Results) == 0 {
			return 0, nil
		}
	}

	match, confidence := BestMatch(title, item.Year, results.Results, e.reviewThreshold)
	if match == nil {
		return confidence, nil
	}

	// Fetch full details
	detail, err := e.tmdb.GetMovie(ctx, match.ID)
	if err != nil {
		return confidence, fmt.Errorf("get movie detail: %w", err)
	}

	// Update the media item with TMDB data
	update := &models.MetadataUpdate{
		MediaItemID:   item.ID,
		TMDBID:        &detail.ID,
		IMDbID:        nilIfEmpty(detail.IMDbID),
		Title:         nilIfEmpty(detail.DisplayTitle()),
		Overview:      nilIfEmpty(detail.Overview),
		Tagline:       nilIfEmpty(detail.Tagline),
		Status:        nilIfEmpty(detail.Status),
		OriginalLang:  nilIfEmpty(detail.OriginalLanguage),
		ContentRating: nilIfEmpty(detail.ContentRating),
		PosterPath:    ptrStr(detail.PosterPath),
		BackdropPath:  ptrStr(detail.BackdropPath),
		Popularity:    &detail.Popularity,
		VoteAverage:   &detail.VoteAverage,
		VoteCount:     &detail.VoteCount,
		RuntimeMin:    nilIfZero(detail.Runtime),
		Year:          nilIfZero(match.Year()),
		MetadataSrc:   strPtr("tmdb"),
	}

	if err := e.queries.UpdateMediaMetadata(ctx, update); err != nil {
		if e.handleDuplicateMetadata(ctx, err, item.Title) {
			return confidence, nil // merged or skipped; not a real error
		}
		return confidence, fmt.Errorf("update metadata: %w", err)
	}

	// Store genres
	if len(detail.Genres) > 0 {
		genreNames := make([]string, len(detail.Genres))
		for i, g := range detail.Genres {
			genreNames[i] = g.Name
		}
		if err := e.queries.SetMediaGenres(ctx, item.ID, genreNames); err != nil {
			slog.Warn("failed to set genres", "item_id", item.ID, "error", err)
		}
	}

	// Store artwork
	if detail.Images != nil {
		e.storeArtwork(ctx, item.ID, detail.Images)
	}

	// Store cast & crew
	if detail.Credits != nil {
		e.storeCast(ctx, item.ID, detail.Credits, nil)
	}

	return confidence, nil
}

func (e *Enricher) enrichShow(ctx context.Context, item *models.MediaItem, title string) (int, error) {
	results, err := e.tmdb.SearchTV(ctx, title, item.Year)
	if err != nil {
		return 0, fmt.Errorf("search tv: %w", err)
	}
	if len(results.Results) == 0 {
		if item.Year > 0 {
			results, err = e.tmdb.SearchTV(ctx, title, 0)
			if err != nil {
				return 0, fmt.Errorf("search tv retry: %w", err)
			}
		}
		if len(results.Results) == 0 {
			// TMDB found nothing — try TVDB as primary source
			if e.tvdb != nil {
				return e.enrichShowFromTVDB(ctx, item, title)
			}
			return 0, nil
		}
	}

	match, confidence := BestMatch(title, item.Year, results.Results, e.reviewThreshold)

	// TVDB fallback: if TMDB confidence is below threshold, also try TVDB
	// and use whichever source gives a better match.
	if e.tvdb != nil && confidence < e.autoThreshold {
		tvdbConf, tvdbID := e.tvdbMatchConfidence(ctx, title, item.Year)
		if tvdbConf > confidence && tvdbID > 0 {
			slog.Info("tvdb fallback preferred over tmdb",
				"title", title, "tmdb_confidence", confidence, "tvdb_confidence", tvdbConf, "tvdb_id", tvdbID)
			return e.enrichShowByTVDBID(ctx, item, tvdbID)
		}
	}

	if match == nil {
		return confidence, nil
	}

	// Proceed with TMDB enrichment as before
	return e.applyTMDBShowMatch(ctx, item, match, confidence)
}

// applyTMDBShowMatch fetches TMDB detail and stores metadata for a TV show.
func (e *Enricher) applyTMDBShowMatch(ctx context.Context, item *models.MediaItem, match *TMDBMovieTV, confidence int) (int, error) {
	detail, err := e.tmdb.GetTV(ctx, match.ID)
	if err != nil {
		return confidence, fmt.Errorf("get tv detail: %w", err)
	}

	// Extract content rating
	var contentRating string
	if detail.ContentRatings != nil {
		for _, cr := range detail.ContentRatings.Results {
			if cr.Country == "US" && cr.Rating != "" {
				contentRating = cr.Rating
				break
			}
		}
	}

	// Extract IMDB ID from external_ids
	var imdbID string
	if detail.ExternalIDs != nil {
		imdbID = detail.ExternalIDs.IMDB
	}

	// Compute runtime from episode_run_time array
	var runtime int
	if len(detail.EpisodeRuntime) > 0 {
		sum := 0
		for _, r := range detail.EpisodeRuntime {
			sum += r
		}
		runtime = sum / len(detail.EpisodeRuntime)
	}

	update := &models.MetadataUpdate{
		MediaItemID:   item.ID,
		TMDBID:        &detail.ID,
		IMDbID:        nilIfEmpty(imdbID),
		Title:         nilIfEmpty(detail.DisplayTitle()),
		Overview:      nilIfEmpty(detail.Overview),
		Tagline:       nilIfEmpty(detail.Tagline),
		Status:        nilIfEmpty(detail.Status),
		OriginalLang:  nilIfEmpty(detail.OriginalLanguage),
		ContentRating: nilIfEmpty(contentRating),
		PosterPath:    ptrStr(detail.PosterPath),
		BackdropPath:  ptrStr(detail.BackdropPath),
		Popularity:    &detail.Popularity,
		VoteAverage:   &detail.VoteAverage,
		VoteCount:     &detail.VoteCount,
		RuntimeMin:    nilIfZero(runtime),
		Year:          nilIfZero(match.Year()),
		MetadataSrc:   strPtr("tmdb"),
	}

	if err := e.queries.UpdateMediaMetadata(ctx, update); err != nil {
		if e.handleDuplicateMetadata(ctx, err, item.Title) {
			return confidence, nil
		}
		return confidence, fmt.Errorf("update metadata: %w", err)
	}

	// Genres
	if len(detail.Genres) > 0 {
		genreNames := make([]string, len(detail.Genres))
		for i, g := range detail.Genres {
			genreNames[i] = g.Name
		}
		if err := e.queries.SetMediaGenres(ctx, item.ID, genreNames); err != nil {
			slog.Warn("failed to set genres", "item_id", item.ID, "error", err)
		}
	}

	// Artwork
	if detail.Images != nil {
		e.storeArtwork(ctx, item.ID, detail.Images)
	}

	// Cast & crew (including creators)
	if detail.Credits != nil {
		e.storeCast(ctx, item.ID, detail.Credits, detail.CreatedBy)
	}

	// Enrich seasons and episodes with TMDB data
	e.enrichSeasons(ctx, item.ID, match.ID, detail.Seasons)

	return confidence, nil
}

func (e *Enricher) enrichSeasons(ctx context.Context, mediaItemID int64, tvTMDBID int, seasons []TMDBSeason) {
	for _, s := range seasons {
		// Skip specials (season 0) for now
		if s.SeasonNumber == 0 {
			continue
		}

		seasonDetail, err := e.tmdb.GetTVSeason(ctx, tvTMDBID, s.SeasonNumber)
		if err != nil {
			slog.Warn("failed to get season detail", "season", s.SeasonNumber, "error", err)
			continue
		}

		// Update each episode that exists in our DB
		for _, ep := range seasonDetail.Episodes {
			tmdbEp := &models.EpisodeMetadataUpdate{
				MediaItemID:   mediaItemID,
				SeasonNumber:  ep.SeasonNumber,
				EpisodeNumber: ep.EpisodeNumber,
				TMDBID:        &ep.ID,
				Title:         nilIfEmpty(ep.Name),
				Overview:      nilIfEmpty(ep.Overview),
				StillPath:     ptrStr(ep.StillPath),
				VoteAverage:   &ep.VoteAverage,
				VoteCount:     &ep.VoteCount,
				RuntimeMin:    nilIfZero(ep.Runtime),
				AirDate:       nilIfEmpty(ep.AirDate),
			}
			if err := e.queries.UpdateEpisodeMetadata(ctx, tmdbEp); err != nil {
				// Not an error — episode may not exist locally yet
				continue
			}
		}
	}
}

// --- TVDB Fallback Enrichment ---

// tvdbMatchConfidence searches TVDB and returns the best match confidence + TVDB ID.
func (e *Enricher) tvdbMatchConfidence(ctx context.Context, title string, year int) (int, int) {
	results, err := e.tvdb.SearchSeries(ctx, title, year)
	if err != nil {
		slog.Debug("tvdb search failed", "title", title, "error", err)
		return 0, 0
	}
	if len(results) == 0 && year > 0 {
		// Retry without year
		results, err = e.tvdb.SearchSeries(ctx, title, 0)
		if err != nil || len(results) == 0 {
			return 0, 0
		}
	}

	bestScore := 0
	bestID := 0
	for _, r := range results {
		if r.Type != "series" {
			continue
		}
		// Reuse the same scoring algorithm — construct a TMDBMovieTV shim for BestMatch
		shim := TMDBMovieTV{
			Name:         r.Name,
			FirstAirDate: r.Year + "-01-01",
		}
		score := MatchConfidence(title, year, shim)
		if score > bestScore {
			bestScore = score
			bestID = r.ParseID()
		}
	}
	return bestScore, bestID
}

// enrichShowFromTVDB is used when TMDB found zero results — TVDB is the primary source.
func (e *Enricher) enrichShowFromTVDB(ctx context.Context, item *models.MediaItem, title string) (int, error) {
	results, err := e.tvdb.SearchSeries(ctx, title, item.Year)
	if err != nil {
		return 0, fmt.Errorf("tvdb search: %w", err)
	}
	if len(results) == 0 && item.Year > 0 {
		results, err = e.tvdb.SearchSeries(ctx, title, 0)
		if err != nil {
			return 0, fmt.Errorf("tvdb search retry: %w", err)
		}
	}
	if len(results) == 0 {
		return 0, nil
	}

	// Find best series match
	bestScore := 0
	bestID := 0
	for _, r := range results {
		if r.Type != "series" {
			continue
		}
		shim := TMDBMovieTV{
			Name:         r.Name,
			FirstAirDate: r.Year + "-01-01",
		}
		score := MatchConfidence(title, item.Year, shim)
		if score > bestScore {
			bestScore = score
			bestID = r.ParseID()
		}
	}

	if bestID == 0 || bestScore < 50 {
		return bestScore, nil
	}

	return e.enrichShowByTVDBID(ctx, item, bestID)
}

// enrichShowByTVDBID fetches full detail from TVDB and stores metadata.
func (e *Enricher) enrichShowByTVDBID(ctx context.Context, item *models.MediaItem, tvdbID int) (int, error) {
	detail, err := e.tvdb.GetSeriesExtended(ctx, tvdbID)
	if err != nil {
		return 0, fmt.Errorf("tvdb get series: %w", err)
	}

	// Map TVDB data to our metadata model
	var tmdbID *int
	if tid := detail.GetTMDBID(); tid > 0 {
		tmdbID = &tid
	}

	update := &models.MetadataUpdate{
		MediaItemID:   item.ID,
		TMDBID:        tmdbID,
		IMDbID:        nilIfEmpty(detail.GetIMDbID()),
		Title:         nilIfEmpty(detail.Name),
		Overview:      nilIfEmpty(detail.Overview),
		Status:        nilIfEmpty(detail.StatusName()),
		OriginalLang:  nilIfEmpty(detail.OriginalLanguage),
		ContentRating: nilIfEmpty(detail.GetUSContentRating()),
		RuntimeMin:    nilIfZero(detail.AverageRuntime),
		Year:          nilIfZero(detail.ParseYear()),
		MetadataSrc:   strPtr("tvdb"),
	}

	// Set poster/backdrop from artwork
	for _, art := range detail.Artworks {
		if art.Image == "" {
			continue
		}
		switch art.Type {
		case TVDBArtPoster:
			if update.PosterPath == nil {
				p := art.Image
				update.PosterPath = &p
			}
		case TVDBArtBackground:
			if update.BackdropPath == nil {
				p := art.Image
				update.BackdropPath = &p
			}
		}
	}

	// Fallback to series main image for poster
	if update.PosterPath == nil && detail.Image != "" {
		update.PosterPath = &detail.Image
	}

	if err := e.queries.UpdateMediaMetadata(ctx, update); err != nil {
		if e.handleDuplicateMetadata(ctx, err, item.Title) {
			return 85, nil
		}
		return 0, fmt.Errorf("update metadata: %w", err)
	}

	// Store external IDs
	e.storeTVDBExternalIDs(ctx, item.ID, tvdbID, detail)

	// Genres
	genreNames := detail.GenreNames()
	if len(genreNames) > 0 {
		if err := e.queries.SetMediaGenres(ctx, item.ID, genreNames); err != nil {
			slog.Warn("failed to set genres", "item_id", item.ID, "error", err)
		}
	}

	// Artwork
	e.storeTVDBArtwork(ctx, item.ID, detail.Artworks)

	// Cast from characters
	e.storeTVDBCast(ctx, item.ID, detail.Characters)

	// Episodes
	e.enrichEpisodesFromTVDB(ctx, item.ID, tvdbID)

	return 85, nil // Fixed confidence for direct TVDB match
}

// EnrichByTVDBID applies metadata from a specific TVDB ID to a media item.
// Used for NFO files that provide a TVDB ID or manual matching.
func (e *Enricher) EnrichByTVDBID(ctx context.Context, item *models.MediaItem, tvdbID int) (int, error) {
	if e.tvdb == nil {
		return 0, fmt.Errorf("TVDB is not enabled")
	}
	confidence, err := e.enrichShowByTVDBID(ctx, item, tvdbID)
	if err != nil {
		return 0, err
	}
	// Explicit ID match (NFO/manual) → full confidence
	if confidence > 0 {
		// Mark as "matched" so it leaves the flagged/needs_review list
		if setErr := e.queries.SetMatchStatus(ctx, item.ID, "matched"); setErr != nil {
			slog.Warn("failed to set match status after manual tvdb match", "item_id", item.ID, "error", setErr)
		}
		return 100, nil
	}
	return 0, nil
}

// storeTVDBExternalIDs stores TVDB and cross-referenced external IDs.
func (e *Enricher) storeTVDBExternalIDs(ctx context.Context, mediaItemID int64, tvdbID int, detail *TVDBSeriesExtended) {
	ids := []models.ExternalID{
		{MediaItemID: mediaItemID, Provider: "tvdb", ExternalID: strconv.Itoa(tvdbID)},
	}
	if imdb := detail.GetIMDbID(); imdb != "" {
		ids = append(ids, models.ExternalID{MediaItemID: mediaItemID, Provider: "imdb", ExternalID: imdb})
	}
	if tmdb := detail.GetTMDBID(); tmdb > 0 {
		ids = append(ids, models.ExternalID{MediaItemID: mediaItemID, Provider: "tmdb", ExternalID: strconv.Itoa(tmdb)})
	}
	for _, eid := range ids {
		if err := e.queries.UpsertExternalID(ctx, eid); err != nil {
			slog.Debug("failed to store external id", "provider", eid.Provider, "error", err)
		}
	}
}

// storeTVDBArtwork maps TVDB artwork records to our Artwork model.
func (e *Enricher) storeTVDBArtwork(ctx context.Context, mediaItemID int64, artworks []TVDBArtwork) {
	var records []models.Artwork
	posterCount, backdropCount, logoCount := 0, 0, 0

	for _, art := range artworks {
		if art.Image == "" {
			continue
		}

		var artType string
		switch art.Type {
		case TVDBArtPoster, TVDBArtSeasonPoster:
			if posterCount >= 5 {
				continue
			}
			artType = "poster"
			posterCount++
		case TVDBArtBackground:
			if backdropCount >= 5 {
				continue
			}
			artType = "backdrop"
			backdropCount++
		case TVDBArtClearLogo:
			if logoCount >= 2 {
				continue
			}
			artType = "logo"
			logoCount++
		case TVDBArtBanner:
			artType = "banner"
		default:
			continue
		}

		isPrimary := false
		switch artType {
		case "poster":
			isPrimary = posterCount == 1
		case "backdrop":
			isPrimary = backdropCount == 1
		case "logo":
			isPrimary = logoCount == 1
		}

		records = append(records, models.Artwork{
			MediaItemID: mediaItemID,
			ArtType:     artType,
			Source:      "tvdb",
			RemotePath:  art.Image,
			Width:       art.Width,
			Height:      art.Height,
			Lang:        art.Language,
			IsPrimary:   isPrimary,
		})
	}

	if len(records) > 0 {
		if err := e.queries.UpsertArtwork(ctx, records); err != nil {
			slog.Warn("failed to store tvdb artwork", "item_id", mediaItemID, "error", err)
		}
		// Eagerly cache primary poster and backdrop (TVDB images are full URLs)
		e.eagerCacheArtwork(records)
	}
}

// storeTVDBCast maps TVDB character records to our CastEntry model.
func (e *Enricher) storeTVDBCast(ctx context.Context, mediaItemID int64, characters []tvdbCharacter) {
	var entries []models.CastEntry
	for i, ch := range characters {
		if i >= 20 {
			break
		}
		if ch.PersonName == "" {
			continue
		}

		roleType := "cast"
		if ch.PeopleType == "Director" {
			roleType = "director"
		} else if ch.PeopleType == "Writer" {
			roleType = "writer"
		} else if ch.PeopleType == "Producer" {
			roleType = "producer"
		}

		entries = append(entries, models.CastEntry{
			MediaItemID:  mediaItemID,
			TMDBPersonID: ch.PeopleID, // TVDB people ID stored here (generic field)
			Name:         ch.PersonName,
			ProfilePath:  nilIfEmpty(ch.PersonImgURL),
			RoleType:     roleType,
			Character:    ch.Name,
			DisplayOrder: ch.Sort,
		})
	}

	if len(entries) > 0 {
		if err := e.queries.UpsertCast(ctx, entries); err != nil {
			slog.Warn("failed to store tvdb cast", "item_id", mediaItemID, "error", err)
		}
	}
}

// enrichEpisodesFromTVDB fetches all episodes and updates local records.
func (e *Enricher) enrichEpisodesFromTVDB(ctx context.Context, mediaItemID int64, tvdbID int) {
	episodes, err := e.tvdb.GetSeriesEpisodes(ctx, tvdbID)
	if err != nil {
		slog.Warn("failed to get tvdb episodes", "tvdb_id", tvdbID, "error", err)
		return
	}

	for _, ep := range episodes {
		if ep.SeasonNumber == 0 {
			continue // skip specials
		}
		epUpdate := &models.EpisodeMetadataUpdate{
			MediaItemID:   mediaItemID,
			SeasonNumber:  ep.SeasonNumber,
			EpisodeNumber: ep.Number,
			Title:         nilIfEmpty(ep.Name),
			Overview:      nilIfEmpty(ep.Overview),
			StillPath:     nilIfEmpty(ep.Image),
			RuntimeMin:    nilIfZero(ep.Runtime),
			AirDate:       nilIfEmpty(ep.AiredDate),
		}
		if err := e.queries.UpdateEpisodeMetadata(ctx, epUpdate); err != nil {
			// Not an error — episode may not exist locally yet
			continue
		}
	}
}

func (e *Enricher) storeArtwork(ctx context.Context, mediaItemID int64, images *TMDBImages) {
	var artworks []models.Artwork

	addImages := func(imgs []TMDBImage, artType string, maxCount int) {
		for i, img := range imgs {
			if i >= maxCount {
				break
			}
			a := models.Artwork{
				MediaItemID: mediaItemID,
				ArtType:     artType,
				Source:      "tmdb",
				RemotePath:  img.FilePath,
				Width:       img.Width,
				Height:      img.Height,
				VoteAverage: img.VoteAverage,
				IsPrimary:   i == 0,
			}
			if img.Lang != nil {
				a.Lang = *img.Lang
			}
			artworks = append(artworks, a)
		}
	}

	addImages(images.Posters, "poster", 5)
	addImages(images.Backdrops, "backdrop", 5)
	addImages(images.Logos, "logo", 2)

	if len(artworks) > 0 {
		if err := e.queries.UpsertArtwork(ctx, artworks); err != nil {
			slog.Warn("failed to store artwork", "item_id", mediaItemID, "error", err)
		}
		// Eagerly cache primary poster and backdrop
		e.eagerCacheArtwork(artworks)
	}
}

// eagerCacheArtwork fetches primary poster and backdrop images in the background.
func (e *Enricher) eagerCacheArtwork(artworks []models.Artwork) {
	if e.imgProxy == nil {
		return
	}
	for _, a := range artworks {
		if !a.IsPrimary || a.RemotePath == "" {
			continue
		}
		switch a.ArtType {
		case "poster":
			if err := e.imgProxy.FetchAndCache(PosterMedium, a.RemotePath); err != nil {
				slog.Debug("eager poster cache failed", "path", a.RemotePath, "error", err)
			}
		case "backdrop":
			if err := e.imgProxy.FetchAndCache(BackdropMedium, a.RemotePath); err != nil {
				slog.Debug("eager backdrop cache failed", "path", a.RemotePath, "error", err)
			}
		}
	}
}

func (e *Enricher) storeCast(ctx context.Context, mediaItemID int64, credits *TMDBCredits, creators []TMDBCreator) {
	var entries []models.CastEntry

	// Cast (top 20)
	for i, c := range credits.Cast {
		if i >= 20 {
			break
		}
		entries = append(entries, models.CastEntry{
			MediaItemID:  mediaItemID,
			TMDBPersonID: c.ID,
			Name:         c.Name,
			ProfilePath:  ptrStr(c.ProfilePath),
			RoleType:     "cast",
			Character:    c.Character,
			DisplayOrder: c.Order,
			KnownFor:     c.KnownFor,
		})
	}

	// Key crew (directors, writers, producers)
	keepJobs := map[string]string{
		"Director":          "director",
		"Writer":            "writer",
		"Screenplay":        "writer",
		"Executive Producer": "producer",
	}
	for _, c := range credits.Crew {
		roleType, ok := keepJobs[c.Job]
		if !ok {
			continue
		}
		entries = append(entries, models.CastEntry{
			MediaItemID:  mediaItemID,
			TMDBPersonID: c.ID,
			Name:         c.Name,
			ProfilePath:  ptrStr(c.ProfilePath),
			RoleType:     roleType,
			Character:    c.Job,
			DisplayOrder: 0,
			KnownFor:     c.KnownFor,
		})
	}

	// Creators (TV shows)
	for i, c := range creators {
		entries = append(entries, models.CastEntry{
			MediaItemID:  mediaItemID,
			TMDBPersonID: c.ID,
			Name:         c.Name,
			ProfilePath:  ptrStr(c.ProfilePath),
			RoleType:     "creator",
			DisplayOrder: i,
		})
	}

	if len(entries) > 0 {
		if err := e.queries.UpsertCast(ctx, entries); err != nil {
			slog.Warn("failed to store cast", "item_id", mediaItemID, "error", err)
		}
	}
}

// BackfillBlurhashes finds primary artwork missing a blurhash and computes one.
// imgProxy is used to fetch/cache images from TMDB so we have a local file to hash.
func (e *Enricher) BackfillBlurhashes(ctx context.Context, imgProxy *ImageProxy, limit int) (int, error) {
	artworks, err := e.queries.GetArtworkMissingBlurhash(ctx, limit)
	if err != nil {
		return 0, fmt.Errorf("query missing blurhashes: %w", err)
	}

	filled := 0
	for _, a := range artworks {
		select {
		case <-ctx.Done():
			return filled, ctx.Err()
		default:
		}

		hash := imgProxy.GetBlurhash(PosterSmall, a.RemotePath)
		if hash == "" {
			continue
		}

		if err := e.queries.UpdateArtworkBlurhash(ctx, a.ID, hash); err != nil {
			slog.Warn("failed to store blurhash", "artwork_id", a.ID, "error", err)
			continue
		}
		filled++
	}
	return filled, nil
}

// --- Helpers ---

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func nilIfZero(n int) *int {
	if n == 0 {
		return nil
	}
	return &n
}

func ptrStr(p *string) *string {
	if p == nil || *p == "" {
		return nil
	}
	return p
}

func strPtr(s string) *string {
	return &s
}

// EnrichByTMDBID applies metadata from a specific TMDB ID to a media item.
// Used for manual matching when auto-match gets it wrong.
// Always sets match_status to "matched" on success since this is an explicit user match.
func (e *Enricher) EnrichByTMDBID(ctx context.Context, item *models.MediaItem, tmdbID int, mediaType string) (int, error) {
	switch {
	case mediaType == "show" || mediaType == "tv" || item.Type == models.MediaShow:
		detail, err := e.tmdb.GetTV(ctx, tmdbID)
		if err != nil {
			return 0, fmt.Errorf("get tv detail: %w", err)
		}

		var contentRating string
		if detail.ContentRatings != nil {
			for _, cr := range detail.ContentRatings.Results {
				if cr.Country == "US" && cr.Rating != "" {
					contentRating = cr.Rating
					break
				}
			}
		}
		var imdbID string
		if detail.ExternalIDs != nil {
			imdbID = detail.ExternalIDs.IMDB
		}
		var runtime int
		if len(detail.EpisodeRuntime) > 0 {
			sum := 0
			for _, r := range detail.EpisodeRuntime {
				sum += r
			}
			runtime = sum / len(detail.EpisodeRuntime)
		}

		update := &models.MetadataUpdate{
			MediaItemID:   item.ID,
			TMDBID:        &tmdbID,
			IMDbID:        nilIfEmpty(imdbID),
			Title:         nilIfEmpty(detail.DisplayTitle()),
			Overview:      nilIfEmpty(detail.Overview),
			Tagline:       nilIfEmpty(detail.Tagline),
			Status:        nilIfEmpty(detail.Status),
			OriginalLang:  nilIfEmpty(detail.OriginalLanguage),
			ContentRating: nilIfEmpty(contentRating),
			PosterPath:    ptrStr(detail.PosterPath),
			BackdropPath:  ptrStr(detail.BackdropPath),
			Popularity:    &detail.Popularity,
			VoteAverage:   &detail.VoteAverage,
			VoteCount:     &detail.VoteCount,
			RuntimeMin:    nilIfZero(runtime),
			Year:          nilIfZero(detail.Year()),
			MetadataSrc:   strPtr("tmdb"),
		}
		if err := e.queries.UpdateMediaMetadata(ctx, update); err != nil {
			if e.handleDuplicateMetadata(ctx, err, item.Title) {
				return 100, nil
			}
			return 0, fmt.Errorf("update metadata: %w", err)
		}
		if len(detail.Genres) > 0 {
			names := make([]string, len(detail.Genres))
			for i, g := range detail.Genres {
				names[i] = g.Name
			}
			e.queries.SetMediaGenres(ctx, item.ID, names)
		}
		if detail.Images != nil {
			e.storeArtwork(ctx, item.ID, detail.Images)
		}
		if detail.Credits != nil {
			e.storeCast(ctx, item.ID, detail.Credits, detail.CreatedBy)
		}
		e.enrichSeasons(ctx, item.ID, tmdbID, detail.Seasons)

		// Explicit manual match — mark as "matched" so it leaves the flagged/needs_review list
		if setErr := e.queries.SetMatchStatus(ctx, item.ID, "matched"); setErr != nil {
			slog.Warn("failed to set match status after manual tmdb match", "item_id", item.ID, "error", setErr)
		}
		return 100, nil

	default:
		detail, err := e.tmdb.GetMovie(ctx, tmdbID)
		if err != nil {
			return 0, fmt.Errorf("get movie detail: %w", err)
		}

		update := &models.MetadataUpdate{
			MediaItemID:   item.ID,
			TMDBID:        &tmdbID,
			IMDbID:        nilIfEmpty(detail.IMDbID),
			Title:         nilIfEmpty(detail.DisplayTitle()),
			Overview:      nilIfEmpty(detail.Overview),
			Tagline:       nilIfEmpty(detail.Tagline),
			Status:        nilIfEmpty(detail.Status),
			OriginalLang:  nilIfEmpty(detail.OriginalLanguage),
			ContentRating: nilIfEmpty(detail.ContentRating),
			PosterPath:    ptrStr(detail.PosterPath),
			BackdropPath:  ptrStr(detail.BackdropPath),
			Popularity:    &detail.Popularity,
			VoteAverage:   &detail.VoteAverage,
			VoteCount:     &detail.VoteCount,
			RuntimeMin:    nilIfZero(detail.Runtime),
			Year:          nilIfZero(detail.Year()),
			MetadataSrc:   strPtr("tmdb"),
		}
		if err := e.queries.UpdateMediaMetadata(ctx, update); err != nil {
			if e.handleDuplicateMetadata(ctx, err, item.Title) {
				return 100, nil
			}
			return 0, fmt.Errorf("update metadata: %w", err)
		}
		if len(detail.Genres) > 0 {
			names := make([]string, len(detail.Genres))
			for i, g := range detail.Genres {
				names[i] = g.Name
			}
			e.queries.SetMediaGenres(ctx, item.ID, names)
		}
		if detail.Images != nil {
			e.storeArtwork(ctx, item.ID, detail.Images)
		}
		if detail.Credits != nil {
			e.storeCast(ctx, item.ID, detail.Credits, nil)
		}

		// Explicit manual match — mark as "matched" so it leaves the flagged/needs_review list
		if setErr := e.queries.SetMatchStatus(ctx, item.ID, "matched"); setErr != nil {
			slog.Warn("failed to set match status after manual tmdb match", "item_id", item.ID, "error", setErr)
		}
		return 100, nil
	}
}

// RefreshStaleMetadata finds items whose metadata is older than maxAge and re-enriches them.
// Uses TMDB's changes API to skip items that haven't been updated upstream (smart diffing).
func (e *Enricher) RefreshStaleMetadata(ctx context.Context, maxAge time.Duration) error {
	items, err := e.queries.GetStaleMetadataItems(ctx, maxAge)
	if err != nil {
		return fmt.Errorf("get stale items: %w", err)
	}

	var refreshed, skipped int
	for _, item := range items {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Smart diffing: if the item already has a TMDB ID and was previously fetched,
		// check the TMDB changes API before doing a full re-fetch.
		if item.TMDBID != nil && *item.TMDBID > 0 && item.LastMetadata != nil {
			changed := true
			switch item.Type {
			case models.MediaMovie:
				changed = e.tmdb.HasMovieChanged(ctx, *item.TMDBID, *item.LastMetadata)
			case models.MediaShow:
				changed = e.tmdb.HasTVChanged(ctx, *item.TMDBID, *item.LastMetadata)
			}
			if !changed {
				// No upstream changes — just bump last_metadata timestamp to avoid re-checking
				if err := e.queries.TouchLastMetadata(ctx, item.ID); err != nil {
					slog.Warn("failed to touch last_metadata", "item_id", item.ID, "error", err)
				}
				skipped++
				continue
			}
		}

		score, err := e.EnrichMediaItem(ctx, &item.MediaItem)
		if err != nil {
			slog.Warn("failed to refresh metadata", "item_id", item.ID, "title", item.Title, "error", err)
			continue
		}
		if score > 0 {
			refreshed++
			slog.Info("refreshed metadata", "item_id", item.ID, "title", item.Title, "confidence", score)
		}
	}

	if skipped > 0 || refreshed > 0 {
		slog.Info("metadata refresh complete", "refreshed", refreshed, "skipped_unchanged", skipped, "total_checked", len(items))
	}

	return nil
}
