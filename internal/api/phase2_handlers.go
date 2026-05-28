package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/metadata"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/streaming"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

// ============================================================
// TV Show Handlers
// ============================================================

type TVHandler struct {
	queries *db.Queries
}

func NewTVHandler(queries *db.Queries) *TVHandler {
	return &TVHandler{queries: queries}
}

// GetSeasons returns all seasons for a TV show.
func (h *TVHandler) GetSeasons(w http.ResponseWriter, r *http.Request) {
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	seasons, err := h.queries.GetSeasons(r.Context(), mediaID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get seasons")
		return
	}
	if seasons == nil {
		seasons = []models.Season{}
	}
	writeJSON(w, http.StatusOK, seasons)
}

// GetEpisodes returns all episodes for a specific season.
func (h *TVHandler) GetEpisodes(w http.ResponseWriter, r *http.Request) {
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}
	seasonNum, err := strconv.Atoi(chi.URLParam(r, "season"))
	if err != nil || seasonNum < 0 {
		writeError(w, http.StatusBadRequest, "invalid season number")
		return
	}

	episodes, err := h.queries.GetEpisodes(r.Context(), mediaID, seasonNum)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get episodes")
		return
	}
	if episodes == nil {
		episodes = []models.EpisodeDetail{}
	}

	// Get TMDB ID for cross-library episode file aggregation
	tmdbID, _ := h.queries.GetTMDBIDForItem(r.Context(), mediaID)

	// Batch-load cross-library episode files (single query for all episodes)
	var crossFileMap map[int64][]*models.EpisodeFile
	var crossLibNames map[int64]string
	if tmdbID > 0 {
		epIDs := make([]int64, len(episodes))
		for i := range episodes {
			epIDs[i] = episodes[i].ID
		}
		crossFileMap, crossLibNames, _ = h.queries.GetCrossLibraryEpisodeFilesBatch(r.Context(), epIDs, tmdbID)
	}

	// Attach files and user progress for each episode
	claims := auth.GetClaims(r.Context())
	for i := range episodes {
		if crossFiles, ok := crossFileMap[episodes[i].ID]; ok && len(crossFiles) > 0 {
			for _, f := range crossFiles {
				if name, found := crossLibNames[f.ID]; found {
					f.LibraryName = name
				}
			}
			episodes[i].Files = crossFiles
		} else {
			files, _ := h.queries.GetEpisodeFiles(r.Context(), episodes[i].ID)
			episodes[i].Files = files
		}

		if claims != nil {
			progress, _ := h.queries.GetWatchProgress(r.Context(), claims.UserID, mediaID, &episodes[i].ID)
			episodes[i].Progress = progress
		}

		// Build still URL if available
		if episodes[i].StillPath != "" {
			episodes[i].StillURL = metadata.ImageURL(episodes[i].StillPath, metadata.StillMedium)
		}
	}

	writeJSON(w, http.StatusOK, episodes)
}

// GetNextEpisode returns the next unwatched episode for the authenticated user.
func (h *TVHandler) GetNextEpisode(w http.ResponseWriter, r *http.Request) {
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	ep, err := h.queries.GetNextEpisode(r.Context(), claims.UserID, mediaID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "no next episode found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to get next episode")
		}
		return
	}

	// Attach files (including cross-library versions)
	tmdbID, _ := h.queries.GetTMDBIDForItem(r.Context(), mediaID)
	if tmdbID > 0 {
		crossFiles, libNames, crossErr := h.queries.GetCrossLibraryEpisodeFiles(r.Context(), ep.ID, tmdbID)
		if crossErr == nil && len(crossFiles) > 0 {
			for _, f := range crossFiles {
				if name, ok := libNames[f.ID]; ok {
					f.LibraryName = name
				}
			}
			ep.Files = crossFiles
		} else {
			files, _ := h.queries.GetEpisodeFiles(r.Context(), ep.ID)
			ep.Files = files
		}
	} else {
		files, _ := h.queries.GetEpisodeFiles(r.Context(), ep.ID)
		ep.Files = files
	}

	if ep.StillPath != "" {
		ep.StillURL = metadata.ImageURL(ep.StillPath, metadata.StillMedium)
	}

	// Attach episode-level watch progress so the frontend can auto-resume
	epProgress, _ := h.queries.GetWatchProgress(r.Context(), claims.UserID, mediaID, &ep.ID)
	if epProgress != nil {
		ep.Progress = epProgress
	}

	writeJSON(w, http.StatusOK, ep)
}

// GetEpisodeFiles returns files for a specific episode ID.
// Used by watch party auto-play to resolve episode files without per-user next-episode logic.
func (h *TVHandler) GetEpisodeFiles(w http.ResponseWriter, r *http.Request) {
	episodeID, err := strconv.ParseInt(chi.URLParam(r, "episodeId"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid episode id")
		return
	}

	files, err := h.queries.GetEpisodeFiles(r.Context(), episodeID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get episode files")
		return
	}
	if files == nil {
		files = []*models.EpisodeFile{}
	}

	writeJSON(w, http.StatusOK, files)
}

// ============================================================
// Metadata Handlers
// ============================================================

type MetadataHandler struct {
	queries  *db.Queries
	enricher *metadata.Enricher
	imgProxy *metadata.ImageProxy
}

func NewMetadataHandler(queries *db.Queries, enricher *metadata.Enricher, imgProxy *metadata.ImageProxy) *MetadataHandler {
	return &MetadataHandler{queries: queries, enricher: enricher, imgProxy: imgProxy}
}

// GetEnriched returns a media item with all TMDB-enriched data.
func (h *MetadataHandler) GetEnriched(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	enriched, err := h.queries.GetMediaItemEnriched(r.Context(), id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "media not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to get media item")
		}
		return
	}

	// Build image URLs
	if enriched.PosterPath != "" {
		enriched.PosterURL = metadata.ImageURL(enriched.PosterPath, metadata.PosterLarge)
	}
	if enriched.BackdropPath != "" {
		enriched.BackdropURL = metadata.ImageURL(enriched.BackdropPath, metadata.BackdropLarge)
	}

	// Load cast
	cast, _ := h.queries.GetCast(r.Context(), id)
	enriched.Cast = cast

	// Load artwork
	artwork, _ := h.queries.GetArtwork(r.Context(), id)
	enriched.Artwork = artwork

	// Load genres
	genres, _ := h.queries.GetMediaGenres(r.Context(), id)
	enriched.Genres = genres

	// Load files (ordered by quality: 4K first), including cross-library versions
	crossFiles, libNames, crossErr := h.queries.GetCrossLibraryFiles(r.Context(), id)
	if crossErr == nil && len(crossFiles) > 0 {
		// Annotate files with library names for the version selector
		for _, f := range crossFiles {
			if name, ok := libNames[f.ID]; ok {
				f.LibraryName = name
			}
		}
		enriched.Files = crossFiles
	} else {
		// Fallback: no TMDB ID or cross-library query failed — use local files only
		files, _ := h.queries.GetMediaFiles(r.Context(), id)
		enriched.Files = files
	}

	// Set has_4k flag from files (including cross-library)
	for _, f := range enriched.Files {
		if strings.HasPrefix(f.VersionTag, "4K") {
			enriched.Has4K = true
			break
		}
	}

	// For TV shows, files live in episode_files — use the cross-library 4K check
	if !enriched.Has4K && enriched.Type == models.MediaShow {
		if fourKMap, err := h.queries.GetMediaItemsWith4KCrossLibrary(r.Context(), []int64{id}); err == nil {
			enriched.Has4K = fourKMap[id]
		}
	}

	// Load TV metadata counts
	if enriched.Type == models.MediaShow {
		sc, ec, _ := h.queries.GetSeasonEpisodeCounts(r.Context(), id)
		enriched.SeasonCount = sc
		enriched.EpisodeCount = ec
	}

	// Load user progress
	claims := auth.GetClaims(r.Context())
	if claims != nil {
		progress, _ := h.queries.GetWatchProgress(r.Context(), claims.UserID, id, nil)
		// For TV shows, episode progress is stored with episode_id (never show-level),
		// so the above query returns nil. Fall back to the most recent in-progress episode.
		if progress == nil && enriched.Type == models.MediaShow {
			progress, _ = h.queries.GetLatestEpisodeProgress(r.Context(), claims.UserID, id)
		}
		enriched.UserProgress = progress
	}

	writeJSON(w, http.StatusOK, enriched)
}

// RefreshMetadata triggers a TMDB metadata refresh for a specific item (admin only).
func (h *MetadataHandler) RefreshMetadata(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	item, err := h.queries.GetMediaItem(r.Context(), id)
	if err != nil || item == nil {
		writeError(w, http.StatusNotFound, "media not found")
		return
	}

	// Re-parse title and year from the actual file path so that parser
	// fixes (e.g. numeric titles like "2012") take effect without a full rescan.
	filePath := h.queries.GetAnyFilePath(r.Context(), id)
	if filePath != "" {
		lib, libErr := h.queries.GetLibrary(r.Context(), item.LibraryID)
		if libErr != nil {
			slog.Warn("refresh: failed to get library", "media_id", id, "error", libErr)
		}
		if lib != nil {
			var parsed library.ParsedFile
			if lib.Type == models.LibraryShows {
				parsed = library.ParseTVPath(filePath)
			} else {
				parsed = library.ParseMoviePath(filePath)
			}
			if parsed.Title != "" && (parsed.Title != item.Title || parsed.Year != item.Year) {
				item.Title = parsed.Title
				item.Year = parsed.Year
				item.SortTitle = library.GenerateSortTitle(parsed.Title)
				slog.Info("refresh re-parsed title/year from file path",
					"media_id", id, "title", parsed.Title, "year", parsed.Year)
			}
		}
	}

	confidence, err := h.enricher.EnrichMediaItem(r.Context(), item)
	if err != nil {
		slog.Error("metadata refresh failed", "media_id", id, "error", err)
		writeError(w, http.StatusInternalServerError, "metadata refresh failed")
		return
	}

	// Update sort_title in DB to match the (possibly new) canonical title.
	// EnrichMediaItem persists title/year via MetadataUpdate but sort_title
	// needs a separate update since the enricher doesn't compute it.
	sortTitle := library.GenerateSortTitle(item.Title)
	st := sortTitle
	sortUpdate := &models.MetadataUpdate{
		MediaItemID: id,
		SortTitle:   &st,
	}
	if err := h.queries.UpdateMediaMetadata(r.Context(), sortUpdate); err != nil {
		slog.Warn("refresh: failed to update sort_title", "media_id", id, "error", err)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"message":    "metadata refreshed",
		"confidence": confidence,
	})
}

// SearchTMDB allows manually searching TMDB for a better match.
func (h *MetadataHandler) SearchTMDB(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	query := q.Get("q")
	if query == "" {
		writeError(w, http.StatusBadRequest, "search query required")
		return
	}

	mediaType := q.Get("type")
	year, _ := strconv.Atoi(q.Get("year"))

	tmdbClient := h.enricher.GetTMDB()
	var results *metadata.TMDBSearchResult

	switch mediaType {
	case "show", "tv":
		var err error
		results, err = tmdbClient.SearchTV(r.Context(), query, year)
		if err != nil {
			writeError(w, http.StatusBadGateway, "TMDB search failed")
			return
		}
	case "multi":
		var err error
		results, err = tmdbClient.SearchMulti(r.Context(), query)
		if err != nil {
			writeError(w, http.StatusBadGateway, "TMDB search failed")
			return
		}
	default:
		var err error
		results, err = tmdbClient.SearchMovies(r.Context(), query, year)
		if err != nil {
			writeError(w, http.StatusBadGateway, "TMDB search failed")
			return
		}
	}

	// Include TVDB results when available and requested for TV shows
	provider := q.Get("provider")
	if (provider == "tvdb" || provider == "") && (mediaType == "show" || mediaType == "tv") && h.enricher.TVDBEnabled() {
		tvdbClient := h.enricher.GetTVDB()
		tvdbResults, err := tvdbClient.SearchSeries(r.Context(), query, year)
		if err == nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"tmdb": results,
				"tvdb": tvdbResults, // may be empty slice, but shape is consistent
			})
			return
		}
		// TVDB search failed — fall through to TMDB-only response
	}

	writeJSON(w, http.StatusOK, results)
}

// ManualMatch links a media item to a specific TMDB or TVDB ID and re-enriches it.
func (h *MetadataHandler) ManualMatch(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	var req struct {
		TMDBID int    `json:"tmdb_id"`
		TVDBID int    `json:"tvdb_id"`
		Type   string `json:"type"` // "movie" or "show"
	}
	if err := decodeJSON(w, r, &req); err != nil || (req.TMDBID <= 0 && req.TVDBID <= 0) {
		writeError(w, http.StatusBadRequest, "tmdb_id or tvdb_id is required and must be positive")
		return
	}

	item, err := h.queries.GetMediaItem(r.Context(), id)
	if err != nil || item == nil {
		writeError(w, http.StatusNotFound, "media not found")
		return
	}

	var confidence int

	if req.TVDBID > 0 {
		// TVDB manual match
		if !h.enricher.TVDBEnabled() {
			writeError(w, http.StatusBadRequest, "TVDB is not enabled")
			return
		}
		confidence, err = h.enricher.EnrichByTVDBID(r.Context(), item, req.TVDBID)
		if err != nil {
			slog.Error("TVDB lookup failed", "media_id", id, "tvdb_id", req.TVDBID, "error", err)
			writeError(w, http.StatusBadGateway, "TVDB lookup failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":    "matched and enriched via tvdb",
			"tvdb_id":    req.TVDBID,
			"confidence": confidence,
		})
	} else {
		// TMDB manual match (existing behavior)
		confidence, err = h.enricher.EnrichByTMDBID(r.Context(), item, req.TMDBID, req.Type)
		if err != nil {
			slog.Error("TMDB lookup failed", "media_id", id, "tmdb_id", req.TMDBID, "error", err)
			writeError(w, http.StatusBadGateway, "TMDB lookup failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":    "matched and enriched",
			"tmdb_id":    req.TMDBID,
			"confidence": confidence,
		})
	}
}

// GetArtwork returns all artwork for a media item.
func (h *MetadataHandler) GetArtwork(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	artwork, err := h.queries.GetArtwork(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get artwork")
		return
	}
	if artwork == nil {
		artwork = []models.Artwork{}
	}
	writeJSON(w, http.StatusOK, artwork)
}

// GetCast returns cast and crew for a media item.
func (h *MetadataHandler) GetCast(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	cast, err := h.queries.GetCast(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get cast")
		return
	}
	if cast == nil {
		cast = []models.CastMember{}
	}
	writeJSON(w, http.StatusOK, cast)
}

// ProxyImage proxies an image through Aurora (TMDB or external sources like TVDB).
func (h *MetadataHandler) ProxyImage(w http.ResponseWriter, r *http.Request) {
	size := chi.URLParam(r, "size")
	imgPath := chi.URLParam(r, "*")

	// TMDB stores poster_path with a leading "/" (e.g. "/abc123.jpg").
	// When the frontend builds /api/images/w500/{poster_path}, the chi
	// wildcard captures the path with the leading slash intact.  Strip it
	// so the path-traversal validation in ServeImage doesn't reject the
	// bare filename.
	imgPath = strings.TrimLeft(imgPath, "/")

	// TVDB stores full URLs (e.g. "https://artworks.thetvdb.com/banners/...").
	// Go's net/http path cleaning collapses "https://" to "https:/" in the
	// request URL.  After stripping the leading slash above, we get
	// "https:/artworks..." — reconstruct the double-slash so url.Parse works.
	if strings.HasPrefix(imgPath, "https:/") && !strings.HasPrefix(imgPath, "https://") {
		imgPath = "https://" + imgPath[len("https:/"):]
	} else if strings.HasPrefix(imgPath, "http:/") && !strings.HasPrefix(imgPath, "http://") {
		imgPath = "http://" + imgPath[len("http:/"):]
	}

	if size == "" || imgPath == "" {
		writeError(w, http.StatusBadRequest, "size and path required")
		return
	}

	h.imgProxy.ServeImage(w, r, size, imgPath)
}

// ============================================================
// Streaming Handlers
// ============================================================

type StreamHandler struct {
	queries    *db.Queries
	transcode  *streaming.TranscodeManager
	directPlay *streaming.DirectPlayRegistry
	subCache   string
	hub        *ws.Hub
	activity   *ActivityLogger
	authSvc    *auth.Service // for minting cast-scoped tokens
}

func NewStreamHandler(queries *db.Queries, transcode *streaming.TranscodeManager, directPlay *streaming.DirectPlayRegistry, subCache string, hub *ws.Hub, activity *ActivityLogger, authSvc *auth.Service) *StreamHandler {
	return &StreamHandler{queries: queries, transcode: transcode, directPlay: directPlay, subCache: subCache, hub: hub, activity: activity, authSvc: authSvc}
}

// isNowPlayingEnabled checks whether the now_playing_enabled server setting is "true".
// Fails closed: returns false on any error or if the setting is not configured.
func (h *StreamHandler) isNowPlayingEnabled(ctx context.Context) bool {
	val, err := h.queries.GetSetting(ctx, "now_playing_enabled")
	if err != nil {
		return false
	}
	return val == "true"
}

// broadcastNowPlaying sends a now_playing event to admin WebSocket clients.
func (h *StreamHandler) broadcastNowPlaying(ctx context.Context, claims *auth.JWTClaims, mediaTitle, mediaType, episodeInfo, decision string) {
	if h.hub == nil || !h.isNowPlayingEnabled(ctx) {
		return
	}
	entry := models.NowPlayingEntry{
		UserID:      claims.UserID,
		Username:    claims.Username,
		MediaTitle:  mediaTitle,
		MediaType:   mediaType,
		EpisodeInfo: episodeInfo,
		Decision:    decision,
	}
	h.hub.BroadcastToAdmins(ws.EventNowPlaying, entry)
}

// resolveFilePath looks up a file's filesystem path by ID.
// When fileType is "episode", only episode_files is searched; when "media", only media_files.
// If fileType is empty (backwards compat), it tries media_files first, then episode_files.
func (h *StreamHandler) resolveFilePath(ctx context.Context, fileID int64, fileType string) (string, error) {
	switch fileType {
	case "episode":
		f, err := h.queries.GetEpisodeFileByID(ctx, fileID)
		if err != nil {
			return "", err
		}
		return f.Path, nil
	case "media":
		f, err := h.queries.GetMediaFileByID(ctx, fileID)
		if err != nil {
			return "", err
		}
		return f.Path, nil
	default:
		// Backwards compat: try media first, then episode
		if f, err := h.queries.GetMediaFileByID(ctx, fileID); err == nil {
			return f.Path, nil
		}
		f, err := h.queries.GetEpisodeFileByID(ctx, fileID)
		if err != nil {
			return "", err
		}
		return f.Path, nil
	}
}

// ServeDirectFile unconditionally serves a media file for direct playback.
// Unlike StreamMediaFile, this does NOT check CanDirectPlay or create transcode
// sessions. Used when the client-aware decision engine has already determined
// the file is directly playable (e.g., HEVC on Safari).
func (h *StreamHandler) ServeDirectFile(w http.ResponseWriter, r *http.Request) {
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return
	}

	fileType := r.URL.Query().Get("type") // "media" or "episode"
	filePath, resolveErr := h.resolveFilePath(r.Context(), fileID, fileType)
	if resolveErr != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	// Extend the write deadline for direct play: the default server WriteTimeout
	// (120s) is far too short for streaming a full movie. Each range-request chunk
	// should reset the deadline, but http.ServeContent sends the entire range in
	// one write, so we give it 4 hours — matching a typical feature-length film.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Now().Add(4 * time.Hour))
	}

	claims := auth.GetClaims(r.Context())
	if h.activity != nil && claims != nil {
		h.activity.LogStreamStarted(r.Context(), claims.UserID, filepath.Base(filePath), "direct_play")
	}
	// Register / extend a direct-play session entry so the admin
	// Active Streams view can show this stream alongside transcodes.
	// Range requests during playback keep calling this handler →
	// touching extends LastAccess. Idle gaps > TTL expire the entry.
	//
	// fileType is whitelisted to prevent a malicious client from
	// iterating arbitrary `?type=` strings against the same fileID
	// and creating unbounded registry entries before TTL sweeps them.
	if h.directPlay != nil && claims != nil {
		ft := fileType
		if ft != "media" && ft != "episode" {
			// Match the resolveFilePath fallback above: media first,
			// episode second. We use the same disambiguator (which
			// table the lookup succeeded against) by re-checking.
			if _, err := h.queries.GetMediaFileByID(r.Context(), fileID); err == nil {
				ft = "media"
			} else {
				ft = "episode"
			}
		}
		sid := h.directPlay.Touch(claims.UserID, claims.Username, ft, fileID, filepath.Base(filePath), "direct_play")
		// Heartbeat the registry while the response is being written
		// — http.ServeFile is synchronous and for single-range
		// requests (one Range: bytes=0-) won't re-enter this handler
		// for the duration of playback, so without a heartbeat the
		// entry would expire mid-stream and admin UI would show no
		// active stream.
		stopHB := make(chan struct{})
		go heartbeatRegistry(r.Context(), h.directPlay, sid, claims, ft, fileID, filepath.Base(filePath), stopHB)
		defer close(stopHB)
	}

	streaming.ServeFile(w, r, filePath)
}

// heartbeatRegistry pings the direct-play registry every 20s while
// either the request context is alive AND no stop signal has fired.
// The stop chan covers the "handler returned normally" case (defer
// close); the request ctx covers the "client disconnected" case.
// 20s gives plenty of buffer against the 60s TTL while not spinning
// the lock too often.
func heartbeatRegistry(ctx context.Context, reg *streaming.DirectPlayRegistry, sessionID string, claims *auth.JWTClaims, fileType string, fileID int64, fileName string, stop <-chan struct{}) {
	if reg == nil || claims == nil {
		return
	}
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-stop:
			return
		case <-t.C:
			// Touch is keyed by (userID, fileType, fileID), so re-
			// Touching with the same args extends the existing
			// entry's LastAccess (it does NOT create a duplicate).
			// sessionID is captured for symmetry with End() but
			// unused here.
			_ = sessionID
			reg.Touch(claims.UserID, claims.Username, fileType, fileID, fileName, "direct_play")
		}
	}
}

// StreamMediaFile serves a media file via direct play or initiates HLS transcoding.
func (h *StreamHandler) StreamMediaFile(w http.ResponseWriter, r *http.Request) {
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return
	}

	file, err := h.queries.GetMediaFileByID(r.Context(), fileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	// Check if direct play is possible
	if streaming.CanDirectPlay(file.Container, file.VideoCodec, file.AudioCodec) {
		// Extend write deadline for direct play (default 120s is too short for movies)
		if rc := http.NewResponseController(w); rc != nil {
			_ = rc.SetWriteDeadline(time.Now().Add(4 * time.Hour))
		}
		// Log direct play stream start
		claims := auth.GetClaims(r.Context())
		if h.activity != nil && claims != nil {
			h.activity.LogStreamStarted(r.Context(), claims.UserID, filepath.Base(file.Path), "direct_play")
		}
		// Register / extend a direct-play session entry (see comment
		// in ServeDirectFile for the rationale + heartbeat detail).
		if h.directPlay != nil && claims != nil {
			fileName := filepath.Base(file.Path)
			sid := h.directPlay.Touch(claims.UserID, claims.Username, "media", fileID, fileName, "direct_play")
			stopHB := make(chan struct{})
			go heartbeatRegistry(r.Context(), h.directPlay, sid, claims, "media", fileID, fileName, stopHB)
			defer close(stopHB)
		}
		// Broadcast now_playing for direct play
		if claims != nil {
			mediaTitle := filepath.Base(file.Path)
			if item, err := h.queries.GetMediaItem(r.Context(), file.MediaItemID); err == nil && item != nil {
				mediaTitle = item.Title
			}
			h.broadcastNowPlaying(r.Context(), claims, mediaTitle, "movie", "", "direct_play")
		}
		streaming.ServeFile(w, r, file.Path)
		return
	}

	// Fall back to adaptive HLS transcode
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	startSec, _ := strconv.Atoi(r.URL.Query().Get("start"))
	srcW, srcH := parseResolution(file.Resolution)
	session, err := h.transcode.GetOrCreateSession(file.Path, startSec, claims.UserID, claims.Username, srcW, srcH)
	if err != nil {
		slog.Error("transcode session failed", "file_id", fileID, "error", err)
		writeError(w, http.StatusInternalServerError, "transcode session failed")
		return
	}

	if h.activity != nil {
		h.activity.LogStreamStarted(r.Context(), claims.UserID, session.FileName, "transcode")
	}

	// Broadcast now_playing for transcode
	mediaTitle := session.FileName
	if item, err := h.queries.GetMediaItem(r.Context(), file.MediaItemID); err == nil && item != nil {
		mediaTitle = item.Title
	}
	h.broadcastNowPlaying(r.Context(), claims, mediaTitle, "movie", "", "transcode")

	writeJSON(w, http.StatusOK, map[string]string{
		"stream_type": "hls",
		"playlist":    fmt.Sprintf("/api/stream/hls/%s/master.m3u8", session.ID),
	})
}

// StreamEpisodeFile serves an episode file.
func (h *StreamHandler) StreamEpisodeFile(w http.ResponseWriter, r *http.Request) {
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return
	}

	file, err := h.queries.GetEpisodeFileByID(r.Context(), fileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	if streaming.CanDirectPlay(file.Container, file.VideoCodec, file.AudioCodec) {
		// Extend write deadline for direct play (default 120s is too short for episodes)
		if rc := http.NewResponseController(w); rc != nil {
			_ = rc.SetWriteDeadline(time.Now().Add(4 * time.Hour))
		}
		// Log direct play stream start
		claims := auth.GetClaims(r.Context())
		if h.activity != nil && claims != nil {
			h.activity.LogStreamStarted(r.Context(), claims.UserID, filepath.Base(file.Path), "direct_play")
		}
		// Register / extend a direct-play session entry (see comment
		// in ServeDirectFile for the rationale + heartbeat detail).
		if h.directPlay != nil && claims != nil {
			fileName := filepath.Base(file.Path)
			sid := h.directPlay.Touch(claims.UserID, claims.Username, "episode", fileID, fileName, "direct_play")
			stopHB := make(chan struct{})
			go heartbeatRegistry(r.Context(), h.directPlay, sid, claims, "episode", fileID, fileName, stopHB)
			defer close(stopHB)
		}
		// Broadcast now_playing for direct play
		if claims != nil {
			mediaTitle := filepath.Base(file.Path)
			episodeInfo := ""
			if showTitle, sNum, eNum, epTitle, err := h.queries.GetEpisodeNowPlayingInfo(r.Context(), file.EpisodeID); err == nil {
				mediaTitle = showTitle
				episodeInfo = fmt.Sprintf("S%02dE%02d", sNum, eNum)
				if epTitle != "" {
					episodeInfo += " - " + epTitle
				}
			}
			h.broadcastNowPlaying(r.Context(), claims, mediaTitle, "episode", episodeInfo, "direct_play")
		}
		streaming.ServeFile(w, r, file.Path)
		return
	}

	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	startSec, _ := strconv.Atoi(r.URL.Query().Get("start"))
	srcW, srcH := parseResolution(file.Resolution)
	session, err := h.transcode.GetOrCreateSession(file.Path, startSec, claims.UserID, claims.Username, srcW, srcH)
	if err != nil {
		slog.Error("transcode session failed", "file_id", fileID, "error", err)
		writeError(w, http.StatusInternalServerError, "transcode session failed")
		return
	}

	if h.activity != nil {
		h.activity.LogStreamStarted(r.Context(), claims.UserID, session.FileName, "transcode")
	}

	// Broadcast now_playing for transcode
	{
		mediaTitle := session.FileName
		episodeInfo := ""
		if showTitle, sNum, eNum, epTitle, lookupErr := h.queries.GetEpisodeNowPlayingInfo(r.Context(), file.EpisodeID); lookupErr == nil {
			mediaTitle = showTitle
			episodeInfo = fmt.Sprintf("S%02dE%02d", sNum, eNum)
			if epTitle != "" {
				episodeInfo += " - " + epTitle
			}
		}
		h.broadcastNowPlaying(r.Context(), claims, mediaTitle, "episode", episodeInfo, "transcode")
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"stream_type": "hls",
		"playlist":    fmt.Sprintf("/api/stream/hls/%s/master.m3u8", session.ID),
	})
}

// ============================================================
// Phase 3: Adaptive HLS Handlers
// ============================================================

// requireSessionAccess centralizes the auth check used by every HLS route:
// the caller must be authenticated (regular OR cast token), the session
// must exist, the session must belong to the caller (or the caller is
// admin), and if a cast token is presented its bound SessionID must
// match the URL's sessionID. Returns false (and writes the response) on
// any failure, so handlers should immediately return.
func (h *StreamHandler) requireSessionAccess(w http.ResponseWriter, r *http.Request, sessionID string) bool {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return false
	}

	// Cast-scoped tokens get a tighter, uniform-error check: a holder
	// of cast token X for session A probing other sessionIDs must not
	// be able to distinguish "B exists but isn't yours" (was 403) from
	// "B does not exist" (was 404) — both leak information. Collapse
	// to a single 403 regardless of session existence.
	//
	// Ownership is implicit: a cast token's SessionID was bound at
	// mint time to a session the minter owned, so SessionID match
	// alone is sufficient (and the TokenVersion check in middleware
	// catches password-change revocation).
	if claims.Scope == auth.ScopeCast {
		owner := h.transcode.GetSessionOwner(sessionID)
		if owner < 0 || claims.SessionID != sessionID {
			writeError(w, http.StatusForbidden, "cast token does not grant access to this session")
			return false
		}
		return true
	}

	// Regular access tokens: keep the existing 404 / 403 split. The
	// information leak here is less severe because access tokens are
	// account-scoped and short-lived (15min) — a logged-in user can
	// already see most of their own resources via the regular API.
	owner := h.transcode.GetSessionOwner(sessionID)
	if owner < 0 {
		writeError(w, http.StatusNotFound, "session not found")
		return false
	}
	if owner != claims.UserID && claims.Role != "admin" {
		writeError(w, http.StatusForbidden, "session belongs to another user")
		return false
	}
	return true
}

// ServeMasterPlaylist serves the adaptive master playlist listing all quality variants.
func (h *StreamHandler) ServeMasterPlaylist(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if !h.requireSessionAccess(w, r, sessionID) {
		return
	}
	h.transcode.ServeMasterPlaylist(w, r, sessionID, QueryParamToken(r))
}

// ServeVariantPlaylist serves the media playlist for a specific quality (e.g. "720p").
// If the variant hasn't started transcoding yet, it's started on-demand.
func (h *StreamHandler) ServeVariantPlaylist(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if !h.requireSessionAccess(w, r, sessionID) {
		return
	}
	profile := chi.URLParam(r, "profile")
	h.transcode.ServeVariantPlaylist(w, r, sessionID, profile, QueryParamToken(r))
}

// ServeHLSSegment serves a .ts segment from a specific quality variant.
func (h *StreamHandler) ServeHLSSegment(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if !h.requireSessionAccess(w, r, sessionID) {
		return
	}
	profile := chi.URLParam(r, "profile")
	segment := chi.URLParam(r, "segment")
	h.transcode.ServeHLSSegment(w, r, sessionID, profile, segment)
}

// ServeHLSSubtitleFile serves subtitle playlists (.m3u8) and segments (.vtt)
// from the inline HLS subtitle extraction pipeline (Emby-style). Both file
// types live in the session's root output directory.
func (h *StreamHandler) ServeHLSSubtitleFile(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	if !h.requireSessionAccess(w, r, sessionID) {
		return
	}
	subsFile := chi.URLParam(r, "subsFile")
	// Dispatch to playlist or segment handler based on file extension
	if strings.HasSuffix(subsFile, ".m3u8") {
		h.transcode.ServeSubtitlePlaylist(w, r, sessionID, subsFile, QueryParamToken(r))
	} else if strings.HasSuffix(subsFile, ".vtt") {
		h.transcode.ServeSubtitleSegment(w, r, sessionID, subsFile)
	} else {
		writeError(w, http.StatusBadRequest, "invalid subtitle file type")
	}
}

// CreateCastToken mints a cast-scoped JWT bound to a specific HLS session,
// then returns the playable master-playlist URL pre-signed with that token.
// The web sender hands the returned URL to Chromecast or AirPlay; receivers
// can fetch the master playlist, variant playlists, and segments without
// our Authorization header because the embedded token authenticates each
// sub-resource (via the existing ?token= promotion middleware).
//
// Requires a regular access token (this endpoint sits inside the RequireAuth
// group). The caller must own the session, or be an admin.
func (h *StreamHandler) CreateCastToken(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	sessionID := chi.URLParam(r, "sessionID")
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "missing sessionID")
		return
	}
	owner := h.transcode.GetSessionOwner(sessionID)
	if owner < 0 {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if owner != claims.UserID && claims.Role != "admin" {
		writeError(w, http.StatusForbidden, "session belongs to another user")
		return
	}
	if h.authSvc == nil {
		// Defensive: in tests the handler may be wired without an auth
		// service. Production wiring (NewStreamHandler in router.go)
		// always passes deps.AuthSvc, so this branch is unreachable in
		// the real binary.
		writeError(w, http.StatusInternalServerError, "auth service not configured")
		return
	}
	tokenStr, expiresAt, err := h.authSvc.GenerateCastToken(
		claims.UserID, claims.Username, claims.Role, claims.TokenVersion, sessionID,
	)
	if err != nil {
		slog.Error("generate cast token", "session_id", sessionID, "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to mint cast token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"token":      tokenStr,
		"expires_at": expiresAt.Unix(),
		"playlist":   fmt.Sprintf("/api/stream/hls/%s/master.m3u8?token=%s", sessionID, tokenStr),
	})
}

// CreateSession explicitly creates a new transcode session (Phase 3 API).
func (h *StreamHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req struct {
		FileID           int64  `json:"file_id"`
		FileType         string `json:"file_type"`                   // "media" or "episode"
		BurnSubIndex     *int   `json:"burn_sub_index,omitempty"`    // subtitle stream index to burn in
		BurnSubExternal  string `json:"burn_sub_external,omitempty"` // external subtitle path
		Remux            bool   `json:"remux,omitempty"`             // direct stream (copy codecs)
		AudioPassthrough bool   `json:"audio_passthrough,omitempty"` // copy audio instead of re-encoding
		AudioTrackIndex  *int   `json:"audio_track_index,omitempty"` // 0-based audio track; nil = FFmpeg default
		AudioChannels    int    `json:"audio_channels,omitempty"`    // source audio channel count for bitrate scaling
		HDRTonemap       bool   `json:"hdr_tonemap,omitempty"`       // apply HDR-to-SDR tonemapping
		VideoCodec       string `json:"video_codec,omitempty"`       // source video codec for BSF selection in remux
		StartSec         int    `json:"start_sec,omitempty"`         // resume position: FFmpeg -ss seek offset in seconds
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.StartSec < 0 {
		req.StartSec = 0
	}

	var filePath, resolution string
	if req.FileType == "episode" {
		f, err := h.queries.GetEpisodeFileByID(r.Context(), req.FileID)
		if err != nil {
			writeError(w, http.StatusNotFound, "episode file not found")
			return
		}
		filePath = f.Path
		resolution = f.Resolution
	} else {
		f, err := h.queries.GetMediaFileByID(r.Context(), req.FileID)
		if err != nil {
			writeError(w, http.StatusNotFound, "media file not found")
			return
		}
		filePath = f.Path
		resolution = f.Resolution
	}

	srcW, srcH := parseResolution(resolution)

	// Build session options
	audioTrackIdx := -1 // -1 = FFmpeg default (first audio stream)
	if req.AudioTrackIndex != nil {
		audioTrackIdx = *req.AudioTrackIndex
	}
	opts := streaming.SessionOpts{
		Remux:            req.Remux,
		AudioPassthrough: req.AudioPassthrough,
		AudioTrackIndex:  audioTrackIdx,
		AudioChannels:    req.AudioChannels,
		HDRTonemap:       req.HDRTonemap,
		SourceVideoCodec: req.VideoCodec,
		StartSec:         req.StartSec,
	}

	// In remux mode, determine whether audio can also be copied.
	// Use the audio_passthrough flag from the decision engine (forwarded by the
	// frontend) when available — it reflects client-specific codec support (e.g.,
	// Safari supports AC3/EAC3, Chrome does not). Fall back to the static
	// DirectPlayAudioCodecs list only when audio_passthrough is false, to avoid
	// copying audio the browser can't decode.
	if req.Remux {
		opts.RemuxAudioCopy = req.AudioPassthrough
		// Burn-in is incompatible with remux (can't apply filters with -c:v copy)
		if req.BurnSubIndex != nil && *req.BurnSubIndex >= 0 {
			writeError(w, http.StatusBadRequest, "subtitle burn-in requires transcoding, not remux")
			return
		}
	}

	// Build burn-in opts if requested, auto-detecting bitmap subtitle formats
	if req.BurnSubIndex != nil && *req.BurnSubIndex >= 0 {
		bi := &streaming.BurnInOpts{
			SubIndex:     *req.BurnSubIndex,
			ExternalPath: req.BurnSubExternal,
		}

		// Validate external subtitle path: must be adjacent to the media file
		// and have a recognized subtitle extension. This prevents arbitrary file
		// path injection into FFmpeg commands.
		if req.BurnSubExternal != "" {
			cleanExt := strings.ToLower(filepath.Ext(req.BurnSubExternal))
			validSubExt := map[string]bool{".srt": true, ".ass": true, ".ssa": true, ".vtt": true, ".sub": true}
			if !validSubExt[cleanExt] {
				writeError(w, http.StatusBadRequest, "invalid subtitle file extension")
				return
			}
			// Resolve to absolute and ensure it's in the same directory as the media file
			mediaDir := filepath.Dir(filePath)
			absExt, err := filepath.Abs(filepath.Join(mediaDir, filepath.Base(req.BurnSubExternal)))
			if err != nil || filepath.Dir(absExt) != mediaDir {
				writeError(w, http.StatusBadRequest, "external subtitle must be in the same directory as the media file")
				return
			}
			if _, err := os.Stat(absExt); err != nil {
				writeError(w, http.StatusNotFound, "external subtitle file not found")
				return
			}
			bi.ExternalPath = absExt // Use the validated absolute path
		}

		// Auto-detect bitmap subtitles by probing the file's subtitle tracks
		if req.BurnSubExternal == "" {
			tracks, _ := streaming.ProbeSubtitles(r.Context(), filePath)
			for _, t := range tracks {
				if t.Index == *req.BurnSubIndex {
					bi.IsBitmap = streaming.IsBitmapSubtitle(t.Codec)
					break
				}
			}
		}

		opts.BurnIn = bi
	}

	// Probe subtitle tracks for inline HLS extraction (Emby-style).
	// Only text-based subs (subrip, ass, ssa, mov_text, webvtt) are included;
	// bitmap subs (PGS, VOBSUB, DVB) cannot be converted to WebVTT.
	// This adds zero overhead — the same file will be opened by FFmpeg for
	// video/audio anyway; subtitles piggyback on that I/O.
	if probedSubs, probeErr := streaming.ProbeSubtitles(r.Context(), filePath); probeErr == nil && len(probedSubs) > 0 {
		for _, t := range probedSubs {
			if streaming.IsBitmapSubtitle(t.Codec) {
				continue
			}
			opts.SubtitleTracks = append(opts.SubtitleTracks, streaming.HLSSubtitleTrack{
				AbsoluteIndex: t.Index,
				Language:      t.Language,
				Title:         t.Title,
				Forced:        t.Forced,
				Default:       t.Default,
			})
		}
		if len(opts.SubtitleTracks) > 0 {
			slog.Info("probed text subtitle tracks for HLS inline extraction",
				"file", filepath.Base(filePath),
				"count", len(opts.SubtitleTracks),
			)
		}
	}

	session, err := h.transcode.CreateSession(claims.UserID, claims.Username, filePath, srcW, srcH, opts)
	if err != nil {
		// "maximum transcode sessions reached" is user-relevant (they need to wait);
		// all other errors may contain filesystem paths and should not be exposed.
		if strings.Contains(err.Error(), "maximum transcode sessions") {
			writeError(w, http.StatusTooManyRequests, "maximum transcode sessions reached, try again later")
		} else {
			slog.Error("failed to create transcode session", "user_id", claims.UserID, "error", err)
			writeError(w, http.StatusInternalServerError, "failed to create transcode session")
		}
		return
	}

	// Log stream start activity
	decision := "transcode"
	if session.Remux {
		decision = "direct_stream"
	}
	if h.activity != nil {
		h.activity.LogStreamStarted(r.Context(), claims.UserID, session.FileName, decision)
	}

	// Broadcast now_playing
	{
		mediaTitle := session.FileName
		mediaType := "movie"
		episodeInfo := ""
		if req.FileType == "episode" {
			mediaType = "episode"
			// Best-effort: look up via episode file -> episode -> show
			if ef, lookupErr := h.queries.GetEpisodeFileByID(r.Context(), req.FileID); lookupErr == nil {
				if showTitle, sNum, eNum, epTitle, infoErr := h.queries.GetEpisodeNowPlayingInfo(r.Context(), ef.EpisodeID); infoErr == nil {
					mediaTitle = showTitle
					episodeInfo = fmt.Sprintf("S%02dE%02d", sNum, eNum)
					if epTitle != "" {
						episodeInfo += " - " + epTitle
					}
				}
			}
		} else {
			if mf, lookupErr := h.queries.GetMediaFileByID(r.Context(), req.FileID); lookupErr == nil {
				if item, itemErr := h.queries.GetMediaItem(r.Context(), mf.MediaItemID); itemErr == nil && item != nil {
					mediaTitle = item.Title
				}
			}
		}
		h.broadcastNowPlaying(r.Context(), claims, mediaTitle, mediaType, episodeInfo, decision)
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"session_id":        session.ID,
		"master_playlist":   fmt.Sprintf("/api/stream/hls/%s/master.m3u8", session.ID),
		"profiles":          session.Profiles,
		"source_width":      session.SourceWidth,
		"source_height":     session.SourceHeight,
		"remux":             session.Remux,
		"audio_passthrough": session.AudioPassthrough,
		"start_sec":         session.StartSec,
	})
}

// ListSessions lists all active streams (admin). Returns transcode
// sessions (FFmpeg-backed) AND direct-play sessions (byte-range
// serves without transcode) as two arrays so the UI can render them
// distinctly. `count` is the combined total — what the admin
// dashboard's "Active Streams" tile expects.
func (h *StreamHandler) ListSessions(w http.ResponseWriter, r *http.Request) {
	sessions := h.transcode.ListSessions()
	var directPlays []streaming.DirectPlaySession
	if h.directPlay != nil {
		directPlays = h.directPlay.List()
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"sessions":     sessions,
		"direct_plays": directPlays,
		"count":        len(sessions) + len(directPlays),
		"hw_accel":     h.transcode.HWAccelStatus(),
	})
}

// DeleteSession kills a specific transcode session. Users can only delete their own sessions.
func (h *StreamHandler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	sessionID := chi.URLParam(r, "sessionID")

	// Retrieve session info before stopping so we can log the file name
	session, found := h.transcode.GetSession(sessionID)
	if !found {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if session.UserID != claims.UserID && claims.Role != "admin" {
		writeError(w, http.StatusForbidden, "cannot delete another user's session")
		return
	}

	fileName := session.FileName
	sessionOwner := session.UserID

	h.transcode.StopSession(sessionID)

	if h.activity != nil {
		h.activity.LogStreamStopped(r.Context(), sessionOwner, fileName)
	}

	// Broadcast now_playing_stopped so admin UIs can remove the entry
	if h.hub != nil && h.isNowPlayingEnabled(r.Context()) {
		h.hub.BroadcastToAdmins(ws.EventNowPlayingStopped, map[string]interface{}{
			"user_id":    sessionOwner,
			"session_id": sessionID,
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "stopped", "session_id": sessionID})
}

// KeepAlive refreshes a session's idle timeout.
func (h *StreamHandler) KeepAlive(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	sessionID := chi.URLParam(r, "sessionID")
	owner := h.transcode.GetSessionOwner(sessionID)
	if owner < 0 {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if owner != claims.UserID && claims.Role != "admin" {
		writeError(w, http.StatusForbidden, "cannot keepalive another user's session")
		return
	}
	if !h.transcode.KeepAlive(sessionID) {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// HWAccelStatus returns detected hardware acceleration info.
func (h *StreamHandler) HWAccelStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.transcode.HWAccelStatus())
}

// parseResolution parses "1920x1080" into width, height. Returns 1920x1080 as default.
func parseResolution(res string) (int, int) {
	parts := strings.SplitN(res, "x", 2)
	if len(parts) == 2 {
		w, errW := strconv.Atoi(parts[0])
		h, errH := strconv.Atoi(parts[1])
		if errW == nil && errH == nil && w > 0 && h > 0 {
			return w, h
		}
	}
	return 1920, 1080 // safe default
}

// GetStreamInfo returns stream decision info so the frontend knows how to play a file.
// Checks codec compatibility and returns either a direct play URL or an HLS transcode URL.
// If the client sends a "caps" query parameter with its codec capabilities, the decision
// engine uses per-client logic (e.g., HEVC direct play on Safari). Without caps, it falls
// back to static allowlists for backward compatibility.
func (h *StreamHandler) GetStreamInfo(w http.ResponseWriter, r *http.Request) {
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return
	}

	fileType := r.URL.Query().Get("type") // "media" or "episode"

	// Parse optional client capabilities
	var clientCaps *streaming.ClientCaps
	if capsRaw := r.URL.Query().Get("caps"); capsRaw != "" {
		clientCaps = streaming.ParseClientCaps(capsRaw)
	}

	var filePath, container, videoCodec, audioCodec, resolution, videoPixFmt string
	var colorTransfer, colorPrimaries string
	var durationMs int64
	var audioTracks []models.AudioTrack

	if fileType == "episode" {
		f, err := h.queries.GetEpisodeFileByID(r.Context(), fileID)
		if err != nil {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
		filePath = f.Path
		container = f.Container
		videoCodec = f.VideoCodec
		audioCodec = f.AudioCodec
		resolution = f.Resolution
		durationMs = f.DurationMs
		audioTracks = f.AudioTracks
		videoPixFmt = f.VideoPixFmt
		colorTransfer = f.ColorTransfer
		colorPrimaries = f.ColorPrimaries
	} else {
		f, err := h.queries.GetMediaFileByID(r.Context(), fileID)
		if err != nil {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
		filePath = f.Path
		container = f.Container
		videoCodec = f.VideoCodec
		audioCodec = f.AudioCodec
		resolution = f.Resolution
		durationMs = f.DurationMs
		audioTracks = f.AudioTracks
		videoPixFmt = f.VideoPixFmt
		colorTransfer = f.ColorTransfer
		colorPrimaries = f.ColorPrimaries
	}

	// Synthesize a single-track list if no multi-track info stored
	if len(audioTracks) == 0 && audioCodec != "" {
		audioTracks = []models.AudioTrack{{Codec: audioCodec, IsDefault: true}}
	}

	// Use the client-aware decision engine (falls back to static if no caps)
	pd := streaming.DecidePlayback(container, videoCodec, audioTracks, clientCaps, videoPixFmt)

	var streamURL string
	if pd.Decision == "direct_play" && clientCaps != nil {
		// When the decision engine confirmed direct play with client caps,
		// use the direct-serve endpoint which bypasses the static CanDirectPlay
		// gate. This prevents the legacy handler from creating a spurious
		// transcode session if the browser can't play the file after all.
		streamURL = fmt.Sprintf("/api/stream/%d/direct?type=%s", fileID, fileType)
	} else if fileType == "episode" {
		streamURL = "/api/stream/episode/" + strconv.FormatInt(fileID, 10)
	} else {
		streamURL = "/api/stream/media/" + strconv.FormatInt(fileID, 10)
	}

	// Probe subtitles
	subtitles, _ := streaming.ProbeSubtitles(r.Context(), filePath)
	if subtitles == nil {
		subtitles = []models.SubtitleTrack{}
	}
	external := streaming.FindExternalSubtitles(filePath)
	// Sanitize external paths for the response
	for i := range external {
		external[i].Title = filepath.Base(external[i].Title)
	}
	subtitles = append(subtitles, external...)
	// Mark bitmap subtitle formats so the frontend can filter them
	for i, t := range subtitles {
		if streaming.IsBitmapSubtitle(t.Codec) {
			subtitles[i].Bitmap = true
		}
	}

	// Determine audio channel count from the selected track for bitrate scaling
	audioChannels := 2 // default stereo
	if pd.AudioTrackIndex >= 0 && pd.AudioTrackIndex < len(audioTracks) {
		if ch := audioTracks[pd.AudioTrackIndex].Channels; ch > 0 {
			audioChannels = ch
		}
	} else if len(audioTracks) > 0 {
		if ch := audioTracks[0].Channels; ch > 0 {
			audioChannels = ch
		}
	}

	// Detect HDR content. The previous heuristic ("10-bit + transcode →
	// tonemap") was wrong: plenty of SDR content is encoded in 10-bit
	// (modern HEVC SDR remuxes, anime, etc.). Applying the zscale
	// tonemap chain to SDR sources crashes FFmpeg with "no path between
	// colorspaces" (zscale needs a known HDR transfer function as
	// input). 2026-05-24 fix.
	//
	// Canonical HDR signal: color_transfer is one of "smpte2084" (PQ /
	// HDR10) or "arib-std-b67" (HLG). color_primaries == "bt2020" is a
	// less reliable secondary signal (wide-gamut SDR also uses bt2020).
	//
	// For files scanned before the color-metadata migration (color_*
	// fields empty), we default to NO tonemap — washed-out SDR output
	// is a much milder failure than total transcode crash. Users with
	// real HDR content should re-scan to pick up the metadata, or
	// pass hdr_tonemap=true explicitly on the session create payload.
	isHDR := colorTransfer == "smpte2084" || colorTransfer == "arib-std-b67"
	hdrTonemap := isHDR && pd.Decision == "transcode"
	_ = videoPixFmt    // retained for future use (10-bit logging / metrics)
	_ = colorPrimaries // retained for future use (wide-gamut SDR detection)

	info := models.StreamInfo{
		FileID:           fileID,
		DirectPlay:       pd.Decision == "direct_play",
		DirectStream:     pd.Decision == "direct_stream",
		Decision:         pd.Decision,
		StreamURL:        streamURL,
		Container:        container,
		VideoCodec:       videoCodec,
		AudioCodec:       audioCodec,
		Resolution:       resolution,
		DurationMs:       durationMs,
		TranscodeReason:  pd.TranscodeReason,
		AudioTrackIndex:  pd.AudioTrackIndex,
		Remux:            pd.Remux,
		AudioPassthrough: pd.AudioPassthrough,
		AudioChannels:    audioChannels,
		HDRTonemap:       hdrTonemap,
	}

	// Log the playback decision for debugging codec issues
	slog.Info("stream info decision",
		"file_id", fileID,
		"decision", pd.Decision,
		"container", container,
		"video_codec", videoCodec,
		"audio_codec", audioCodec,
		"audio_track_index", pd.AudioTrackIndex,
		"remux", pd.Remux,
		"audio_passthrough", pd.AudioPassthrough,
		"transcode_reason", pd.TranscodeReason,
		"has_client_caps", clientCaps != nil,
	)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"stream":       info,
		"subtitles":    subtitles,
		"audio_tracks": audioTracks,
	})
}

// GetSubtitles lists available subtitle tracks for a media file.
func (h *StreamHandler) GetSubtitles(w http.ResponseWriter, r *http.Request) {
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return
	}

	// Resolve file path using the type hint to avoid ID collisions
	// between media_files and episode_files (separate BIGSERIAL sequences)
	fileType := r.URL.Query().Get("type") // "media" or "episode"
	filePath, resolveErr := h.resolveFilePath(r.Context(), fileID, fileType)
	if resolveErr != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	// Probe embedded subtitles
	tracks, _ := streaming.ProbeSubtitles(r.Context(), filePath)
	if tracks == nil {
		tracks = []models.SubtitleTrack{}
	}

	// Find external subtitles
	external := streaming.FindExternalSubtitles(filePath)
	tracks = append(tracks, external...)

	// Sanitize: strip full filesystem paths from external sub titles for the API response
	// (ServeSubtitle handler looks them up fresh via FindExternalSubtitles, so full paths aren't needed)
	sanitized := make([]models.SubtitleTrack, len(tracks))
	for i, t := range tracks {
		sanitized[i] = t
		if t.Index >= 1000 {
			// External sub — show only the filename, not the full path
			sanitized[i].Title = filepath.Base(t.Title)
		}
		// Mark bitmap subtitle formats so the frontend can skip or label them
		if streaming.IsBitmapSubtitle(t.Codec) {
			sanitized[i].Bitmap = true
		}
	}

	writeJSON(w, http.StatusOK, sanitized)
}

// ServeSubtitle extracts and serves a specific subtitle track as WebVTT.
//
// Query params:
//   - type=movie|episode|media — disambiguates ID collisions.
//   - start=<sec> — resume offset (Issue #131). When > 0, every cue
//     timestamp is shifted by -start seconds so the player's HLS
//     time domain (currentTime=0 corresponds to file-time=start)
//     matches the subtitle cue domain. Without this, cues fire
//     `start` seconds late or never (when past EOF). The shifted
//     VTT is cached separately from the raw extracted VTT keyed by
//     (fileID, trackIdx, start).
func (h *StreamHandler) ServeSubtitle(w http.ResponseWriter, r *http.Request) {
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return
	}
	trackIdx, err := strconv.Atoi(chi.URLParam(r, "trackIdx"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid track index")
		return
	}

	// Resolve file path using type hint to avoid ID collisions
	fileType := r.URL.Query().Get("type")
	filePath, resolveErr := h.resolveFilePath(r.Context(), fileID, fileType)
	if resolveErr != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	// Issue #131 — resume offset for cue-time shift. Clamp to a sane
	// range: negative = ignore (same as 0); insanely large = also
	// ignore (defensive; would just produce an empty VTT). 24 hours
	// is way longer than any media file.
	startSec, _ := strconv.Atoi(r.URL.Query().Get("start"))
	if startSec < 0 || startSec > 24*3600 {
		startSec = 0
	}

	// Issue #131 — small helper that applies the resume shift before
	// serving. Falls back to the raw VTT path on shift failure so a
	// disk-cache hiccup doesn't break subtitle playback entirely.
	//
	// Issue #135 — instrument every served subtitle with structured
	// logs so we can correlate frontend warnings with server-side
	// behavior in bug reports. The user's Elf subtitle "loaded"
	// (no <track> error) but produced no cues; this log answers:
	// what was the resolved codec? was a shift requested? what was
	// the size of the served VTT? did the shift fail silently? With
	// these in journalctl we can diagnose without redeploying.
	// Issue #141 — `remux=1` signals the active HLS session is REMUXING
	// (-c:v copy). This determines the subtitle cue-shift offset:
	//
	//   Remux:     input seek (-ss before -i) can't start mid-GOP, so
	//              the stream's t=0 is the KEYFRAME at-or-before
	//              startSec. The audio still begins ~startSec, but
	//              hls.js anchors currentTime to the earliest PTS (the
	//              video keyframe). Shift cues by that keyframe.
	//   Transcode: the decoder accurate-seeks and discards up to
	//              startSec, so t=0 ≈ startSec. Shift cues by startSec.
	//
	// Verified empirically by ffprobing seg_000 of both paths: remux
	// seg starts at the keyframe PTS, transcode seg starts at startSec.
	// Getting this wrong inverts the bug (cues land a GOP early OR
	// late), which is exactly the #141 regression risk.
	isRemux := r.URL.Query().Get("remux") == "1"
	serve := func(vttPath string) {
		served := vttPath
		shiftErr := error(nil)
		shiftOffset := 0.0
		if startSec > 0 {
			if isRemux {
				// Remux: shift by the keyframe the input seek lands on.
				// ProbeSeekKeyframe falls back to startSec on any probe
				// failure, so this never regresses below pre-#141.
				shiftOffset = streaming.ProbeSeekKeyframe(r.Context(), filePath, float64(startSec))
			} else {
				// Transcode (or unknown): accurate seek lands on
				// startSec; shift by it directly.
				shiftOffset = float64(startSec)
			}
			shifted, err := streaming.ShiftVTTCues(vttPath, shiftOffset, h.subCache)
			if err == nil {
				served = shifted
			} else {
				shiftErr = err
				slog.Warn("subtitle cue-shift failed; serving unshifted",
					"error", err, "vtt", vttPath, "start_sec", startSec, "shift_offset", shiftOffset)
			}
		}
		var byteSize int64
		if info, statErr := os.Stat(served); statErr == nil {
			byteSize = info.Size()
		}
		slog.Info("subtitle served",
			"file_id", fileID,
			"track_idx", trackIdx,
			"file_type", fileType,
			"start_sec", startSec,
			"is_remux", isRemux,
			"shift_offset", shiftOffset,
			"keyframe_gap", float64(startSec)-shiftOffset,
			"shifted", startSec > 0 && shiftErr == nil,
			"vtt_path", served,
			"vtt_bytes", byteSize,
		)
		streaming.ServeSubtitle(w, r, served)
	}

	// External subtitle (index >= 1000)
	if trackIdx >= 1000 {
		external := streaming.FindExternalSubtitles(filePath)
		for _, ext := range external {
			if ext.Index == trackIdx {
				// For SRT, convert to VTT (fast, pure Go)
				if ext.Codec == "srt" {
					vttPath, err := streaming.ConvertSRTtoVTT(ext.Title, h.subCache)
					if err != nil {
						writeError(w, http.StatusInternalServerError, "subtitle conversion failed")
						return
					}
					serve(vttPath)
					return
				}
				// VTT files can be served directly
				if ext.Codec == "vtt" {
					serve(ext.Title)
					return
				}
				// ASS, SSA, and other formats: convert to VTT via ffmpeg
				vttPath, err := streaming.ConvertSubtitleToVTT(r.Context(), ext.Title, h.subCache)
				if err != nil {
					writeError(w, http.StatusInternalServerError, "subtitle conversion failed")
					return
				}
				serve(vttPath)
				return
			}
		}
		writeError(w, http.StatusNotFound, "subtitle track not found")
		return
	}

	// Embedded subtitle — check if it's a bitmap format (PGS, VOBSUB, DVB) which
	// cannot be converted to WebVTT text. Without this check, FFmpeg hangs for the
	// full 2-minute timeout trying an impossible conversion.
	tracks, _ := streaming.ProbeSubtitles(r.Context(), filePath)
	for _, t := range tracks {
		if t.Index == trackIdx && streaming.IsBitmapSubtitle(t.Codec) {
			writeError(w, http.StatusBadRequest, "bitmap subtitles (PGS/VOBSUB/DVB) cannot be converted to text; use burn-in instead")
			return
		}
	}

	// Extend the HTTP write deadline for subtitle extraction on large files.
	// The default server WriteTimeout (120s) is too short for extracting
	// interleaved subtitle packets from multi-GB MKV files (FFmpeg must read
	// through the entire container). Go 1.20+ ResponseController lets us
	// extend the deadline per-handler without affecting other endpoints.
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Now().Add(10 * time.Minute)); err != nil {
		slog.Debug("could not extend write deadline for subtitle extraction", "error", err)
	}

	// Text-based subtitle — extract with FFmpeg
	vttPath, err := streaming.ExtractSubtitleVTT(r.Context(), filePath, trackIdx, h.subCache)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "subtitle extraction failed")
		return
	}

	serve(vttPath)
}

// ============================================================
// Watch Progress Handlers
// ============================================================

type ProgressHandler struct {
	queries *db.Queries
	hub     *ws.Hub
	hero    HeroProvider        // optional — invalidated on explicit MarkWatched
	gamify  *GamificationEngine // optional — awards XP on watch completion
}

func NewProgressHandler(queries *db.Queries, hub *ws.Hub) *ProgressHandler {
	return &ProgressHandler{queries: queries, hub: hub}
}

// SetHeroProvider attaches the recommender so MarkWatched can invalidate the
// hero cache for the affected profile. Optional; when nil the cache simply
// expires on its own 24h schedule.
func (h *ProgressHandler) SetHeroProvider(p HeroProvider) {
	h.hero = p
}

// SetGamificationEngine attaches the XP/streak/achievement engine.
// When set, completed watches (MarkWatched + reaching >= 90% on
// UpdateProgress) grant XP and may unlock achievements. Optional;
// nil disables gamification entirely.
func (h *ProgressHandler) SetGamificationEngine(g *GamificationEngine) {
	h.gamify = g
}

func (h *ProgressHandler) resolveProgressProfileID(w http.ResponseWriter, r *http.Request, userID int64, requested *int64) (int64, bool) {
	if requested != nil && *requested != 0 {
		if *requested < 0 {
			writeError(w, http.StatusBadRequest, "invalid profile_id")
			return 0, false
		}
		profile, err := h.queries.GetProfile(r.Context(), *requested)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to validate profile")
			return 0, false
		}
		if profile == nil {
			writeError(w, http.StatusNotFound, "profile not found")
			return 0, false
		}
		if profile.UserID != userID {
			writeError(w, http.StatusForbidden, "profile does not belong to this user")
			return 0, false
		}
		return profile.ID, true
	}

	dp, err := h.queries.GetDefaultProfile(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve default profile")
		return 0, false
	}
	if dp == nil {
		return 0, true
	}
	return dp.ID, true
}

// UpdateProgress reports playback position.
func (h *ProgressHandler) UpdateProgress(w http.ResponseWriter, r *http.Request) {
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req models.UpdateProgressRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.PositionMs < 0 || req.DurationMs < 0 {
		writeError(w, http.StatusBadRequest, "position and duration must be non-negative")
		return
	}

	profileID, ok := h.resolveProgressProfileID(w, r, claims.UserID, req.ProfileID)
	if !ok {
		return
	}

	wp := &models.WatchProgress{
		UserID:      claims.UserID,
		ProfileID:   profileID,
		MediaItemID: mediaID,
		EpisodeID:   req.EpisodeID,
		PositionMs:  req.PositionMs,
		DurationMs:  req.DurationMs,
	}

	if err := h.queries.UpsertWatchProgress(r.Context(), wp); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update progress")
		return
	}

	// Notify other devices of the same user about the progress change
	if h.hub != nil {
		h.hub.BroadcastToUser(claims.UserID, ws.EventProgressSync, map[string]interface{}{
			"media_item_id": mediaID,
			"episode_id":    req.EpisodeID,
			"position_ms":   req.PositionMs,
			"duration_ms":   req.DurationMs,
			"completed":     false,
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "progress updated"})
}

// GetProgress returns watch progress for a specific item.
func (h *ProgressHandler) GetProgress(w http.ResponseWriter, r *http.Request) {
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var episodeID *int64
	if epStr := r.URL.Query().Get("episode_id"); epStr != "" {
		id, err := strconv.ParseInt(epStr, 10, 64)
		if err == nil {
			episodeID = &id
		}
	}

	progress, err := h.queries.GetWatchProgress(r.Context(), claims.UserID, mediaID, episodeID)
	if err != nil {
		writeError(w, http.StatusNotFound, "no progress found")
		return
	}

	writeJSON(w, http.StatusOK, progress)
}

// ContinueWatching returns in-progress items for the current user.
// Accepts optional ?profile_id= to scope results to a specific profile.
// When profile_id is provided, the handler validates that the profile belongs
// to the authenticated user before returning results.
func (h *ProgressHandler) ContinueWatching(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	// Profile-scoped filtering: if profile_id is provided, validate ownership
	// and return only progress entries for that profile.
	var items []models.ContinueWatchingItem
	var err error

	if pidStr := r.URL.Query().Get("profile_id"); pidStr != "" {
		profileID, parseErr := strconv.ParseInt(pidStr, 10, 64)
		if parseErr != nil || profileID <= 0 {
			writeError(w, http.StatusBadRequest, "invalid profile_id")
			return
		}

		// Validate that the profile belongs to the authenticated user
		profile, profileErr := h.queries.GetProfile(r.Context(), profileID)
		if profileErr != nil || profile == nil {
			writeError(w, http.StatusNotFound, "profile not found")
			return
		}
		if profile.UserID != claims.UserID {
			writeError(w, http.StatusForbidden, "profile does not belong to this user")
			return
		}

		items, err = h.queries.GetContinueWatchingByProfile(r.Context(), profileID, limit)
	} else {
		items, err = h.queries.GetContinueWatching(r.Context(), claims.UserID, limit)
	}

	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get continue watching")
		return
	}
	if items == nil {
		items = []models.ContinueWatchingItem{}
	}

	// QA BUG-007 — attach the first genre per item so CW cards
	// show the same genre tag as the rest of the rails. Non-fatal:
	// genre lookup failure leaves Genre empty and the card just
	// omits the tag. Pattern mirrors RecentTasteAnchors genre
	// attach in queries_recommender.go.
	if len(items) > 0 {
		ids := make([]int64, len(items))
		for i := range items {
			ids[i] = items[i].MediaItemID
		}
		if byID, gerr := h.queries.GetMediaGenresBatch(r.Context(), ids); gerr == nil {
			for i := range items {
				if g, ok := byID[items[i].MediaItemID]; ok && len(g) > 0 {
					items[i].Genre = g[0]
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, items)
}

// MarkWatched manually marks an item as completed.
func (h *ProgressHandler) MarkWatched(w http.ResponseWriter, r *http.Request) {
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req struct {
		EpisodeID *int64 `json:"episode_id,omitempty"`
		ProfileID *int64 `json:"profile_id,omitempty"`
	}
	decodeJSON(w, r, &req) // Body is optional

	profileID, ok := h.resolveProgressProfileID(w, r, claims.UserID, req.ProfileID)
	if !ok {
		return
	}

	wp := &models.WatchProgress{
		UserID:      claims.UserID,
		ProfileID:   profileID,
		MediaItemID: mediaID,
		EpisodeID:   req.EpisodeID,
		PositionMs:  0,
		DurationMs:  0,
		Completed:   true,
	}

	if err := h.queries.UpsertWatchProgress(r.Context(), wp); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to mark watched")
		return
	}

	// Reshape tomorrow's hero immediately. We invalidate only on explicit
	// MarkWatched (not on every progress heartbeat) so the cache still does
	// its job during normal playback.
	if h.hero != nil && profileID > 0 {
		h.hero.Invalidate(profileID)
	}

	// Notify other devices of the same user
	if h.hub != nil {
		h.hub.BroadcastToUser(claims.UserID, ws.EventProgressSync, map[string]interface{}{
			"media_item_id": mediaID,
			"episode_id":    req.EpisodeID,
			"position_ms":   int64(0),
			"duration_ms":   int64(0),
			"completed":     true,
		})
	}

	// Phase 6 — Gamification. Grant XP for the completion and check
	// for newly-unlocked achievements. The list of newly-unlocked
	// keys flows back to the client so a level-up / unlock toast
	// can render. Engine errors are best-effort: a failed XP grant
	// shouldn't fail the user's "mark watched" action.
	// Audit M5 — AwardForWatch returns full defs (icon + title +
	// xp_reward) so the client can render a rich toast without a
	// second roundtrip.
	var unlocks []AchievementDef
	if h.gamify != nil {
		unlocks = h.gamify.AwardForWatch(r.Context(), claims.UserID, time.Now().UTC())
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message":               "marked as watched",
		"achievements_unlocked": unlocks,
	})
}

// DeleteProgress clears watch progress for a specific media item.
func (h *ProgressHandler) DeleteProgress(w http.ResponseWriter, r *http.Request) {
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}

	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var episodeID *int64
	if epStr := r.URL.Query().Get("episode_id"); epStr != "" {
		id, err := strconv.ParseInt(epStr, 10, 64)
		if err == nil {
			episodeID = &id
		}
	}

	if err := h.queries.DeleteWatchProgress(r.Context(), claims.UserID, mediaID, episodeID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete progress")
		return
	}

	// Notify other devices of the same user that progress was cleared
	if h.hub != nil {
		h.hub.BroadcastToUser(claims.UserID, ws.EventProgressSync, map[string]interface{}{
			"media_item_id": mediaID,
			"episode_id":    episodeID,
			"position_ms":   int64(0),
			"duration_ms":   int64(0),
			"completed":     false,
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "progress deleted"})
}

// RecentlyWatched returns recently watched items (both complete and in-progress).
func (h *ProgressHandler) RecentlyWatched(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	items, err := h.queries.GetRecentlyWatched(r.Context(), claims.UserID, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get recently watched")
		return
	}
	if items == nil {
		items = []models.ContinueWatchingItem{}
	}

	writeJSON(w, http.StatusOK, items)
}

// WatchHistory returns full paginated watch history.
func (h *ProgressHandler) WatchHistory(w http.ResponseWriter, r *http.Request) {
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	params := paginate(r)
	items, total, err := h.queries.GetWatchHistory(r.Context(), claims.UserID, params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get watch history")
		return
	}
	if items == nil {
		items = []models.ContinueWatchingItem{}
	}

	writeJSON(w, http.StatusOK, paginatedResponse(items, total, params))
}
