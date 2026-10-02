package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/aurora-media/aurora/internal/auth"
	"github.com/aurora-media/aurora/internal/db"
	"github.com/aurora-media/aurora/internal/library"
	"github.com/aurora-media/aurora/internal/metadata"
	"github.com/aurora-media/aurora/internal/models"
	"github.com/aurora-media/aurora/internal/recap"
	"github.com/aurora-media/aurora/internal/streaming"
	ws "github.com/aurora-media/aurora/internal/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

// ============================================================
// FFmpeg/FFprobe Concurrency Gate (audit MED — fork-bomb guard)
// ============================================================
//
// The on-demand streaming handlers (GetStreamInfo, GetSubtitles, ServeSubtitle)
// each shell out to ffprobe/ffmpeg per request to probe subtitle tracks, probe
// seek keyframes, and extract/convert WebVTT. With no bound, a burst of
// concurrent requests (or a malicious client looping the endpoint) forks one
// ffprobe/ffmpeg per request and exhausts CPU/RAM. ffprobeGate caps how many of
// these subprocess-spawning operations run at once across the whole api package.
//
// Sized to runtime.NumCPU(): ffprobe/ffmpeg are CPU-bound, so allowing roughly
// one per core keeps the box responsive while still letting normal playback (a
// handful of probes per stream start) proceed without queueing. Distinct from
// the transcode session cap (long-lived HLS encodes) — these are short-lived
// metadata probes / one-shot extractions.
var ffprobeGate = make(chan struct{}, maxFFprobeConcurrency())

// maxFFprobeConcurrency returns the gate size: NumCPU, floored at 1 so the gate
// is never zero-capacity (which would deadlock every acquire).
func maxFFprobeConcurrency() int {
	if n := runtime.NumCPU(); n > 0 {
		return n
	}
	return 1
}

// acquireFFprobeSlot blocks until a gate slot is free or ctx is cancelled.
// On success it returns a release func that MUST be called (defer) to free the
// slot. On ctx cancellation it returns (nil, ctx.Err()) and no slot is held, so
// a client that disconnects while queued never ties up a subprocess slot.
func acquireFFprobeSlot(ctx context.Context) (release func(), err error) {
	select {
	case ffprobeGate <- struct{}{}:
		return func() { <-ffprobeGate }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// gatedProbeSubtitles runs streaming.ProbeSubtitles under the ffprobe
// concurrency gate so EVERY probe entry point — including the non-admin
// CreateSession path — is bounded. On gate-acquire failure (ctx cancelled) it
// returns the error and spawns no subprocess. deep-debug MED.
func gatedProbeSubtitles(ctx context.Context, filePath string) ([]models.SubtitleTrack, error) {
	release, err := acquireFFprobeSlot(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	return streaming.ProbeSubtitles(ctx, filePath)
}

// ============================================================
// TV Show Handlers
// ============================================================

type TVHandler struct {
	queries *db.Queries
}

func NewTVHandler(queries *db.Queries) *TVHandler {
	return &TVHandler{queries: queries}
}

// ratingCeilingBlocksMedia reports whether mediaID's content_rating exceeds
// claims' acting sub-profile's rating ceiling (issue #462). Returns
// blocked=false, err=nil when the media item doesn't exist at all — that's
// a "nothing to protect" case, not a bypass, and existing callers already
// degrade gracefully (empty seasons/episodes) for an unknown id. Fails
// CLOSED on a genuine lookup/resolve error, same rationale as
// StreamHandler.ratingCeilingBlocks: this is the security boundary.
func (h *TVHandler) ratingCeilingBlocksMedia(ctx context.Context, claims *auth.JWTClaims, mediaID int64) (bool, error) {
	item, err := h.queries.GetMediaItem(ctx, mediaID)
	if err != nil {
		return true, err
	}
	if item == nil {
		return false, nil
	}
	profile, err := h.queries.ResolveActingProfile(ctx, claims.UserID, claims.RefreshTokenID)
	if err != nil {
		return true, err
	}
	return !db.RatingAllowed(profile.MaxAgeRating, item.ContentRating), nil
}

// GetSeasons returns all seasons for a TV show.
func (h *TVHandler) GetSeasons(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	mediaID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return
	}
	if blocked, err := h.ratingCeilingBlocksMedia(r.Context(), claims, mediaID); err != nil || blocked {
		denyRatingCeiling(w, mediaID, err)
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
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
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
	if blocked, err := h.ratingCeilingBlocksMedia(r.Context(), claims, mediaID); err != nil || blocked {
		denyRatingCeiling(w, mediaID, err)
		return
	}

	profile, err := h.queries.ResolveActingProfile(r.Context(), claims.UserID, claims.RefreshTokenID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve acting profile")
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
			progress, _ := h.queries.GetWatchProgressForProfile(r.Context(), claims.UserID, profile.ID, mediaID, &episodes[i].ID)
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

	profile, err := h.queries.ResolveActingProfile(r.Context(), claims.UserID, claims.RefreshTokenID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve acting profile")
		return
	}
	ep, err := h.queries.GetNextEpisodeForProfile(r.Context(), claims.UserID, profile.ID, mediaID)
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
	epProgress, _ := h.queries.GetWatchProgressForProfile(r.Context(), claims.UserID, profile.ID, mediaID, &ep.ID)
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
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
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

	// Rating-ceiling enforcement (issue #462) — 404 (not distinguishable
	// from true not-found) rather than exposing metadata for a title the
	// acting profile can't see.
	profile, perr := h.queries.ResolveActingProfile(r.Context(), claims.UserID, claims.RefreshTokenID)
	if perr != nil {
		denyRatingCeiling(w, id, perr)
		return
	} else if !db.RatingAllowed(profile.MaxAgeRating, enriched.ContentRating) {
		denyRatingCeiling(w, id, nil)
		return
	}

	// Lazy trailer backfill (migration 034): items enriched before trailer
	// support have trailer_key = NULL. Resolve it once from TMDB on first
	// detail view and persist, so the "Watch Trailer" button appears without a
	// full re-enrich. Best-effort + bounded: on success store the key (or "" =
	// none) so we never re-fetch; on a TMDB error leave it NULL to retry on a
	// later view rather than mark it permanently trailer-less.
	if !enriched.TrailerChecked && enriched.TMDBID != nil && *enriched.TMDBID > 0 && h.enricher != nil {
		bctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
		key, ok := h.enricher.FetchTrailerKey(bctx, *enriched.TMDBID, enriched.Type == models.MediaShow)
		cancel()
		if ok {
			if serr := h.queries.SetTrailerKey(r.Context(), id, key); serr != nil {
				slog.Warn("trailer backfill: persist failed", "media_id", id, "error", serr)
			}
			enriched.TrailerKey = key
		}
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
	{
		progress, _ := h.queries.GetWatchProgressForProfile(r.Context(), claims.UserID, profile.ID, id, nil)
		// For TV shows, episode progress is stored with episode_id (never show-level),
		// so the above query returns nil. Fall back to the most recent in-progress episode.
		if progress == nil && enriched.Type == models.MediaShow {
			progress, _ = h.queries.GetLatestEpisodeProgressForProfile(r.Context(), claims.UserID, profile.ID, id)
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

	// Notices clients that keep pinging sessions the server has dropped.
	// Zero value is ready to use — see keepalive_watch.go.
	staleKeepalive staleKeepaliveWatcher
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

// resolveFileWithType is resolveFilePath plus the resolved "media"/"episode"
// type — needed wherever a caller must know which table matched (the
// rating-ceiling check and the direct-play registry both key on it) but
// only has an optional/ambiguous fileType hint, same media-then-episode
// fallback order as resolveFilePath.
func (h *StreamHandler) resolveFileWithType(ctx context.Context, fileID int64, fileType string) (path, resolvedType string, err error) {
	path, err = h.resolveFilePath(ctx, fileID, fileType)
	if err != nil {
		return "", "", err
	}
	resolvedType = fileType
	if resolvedType != "media" && resolvedType != "episode" {
		if _, ferr := h.queries.GetMediaFileByID(ctx, fileID); ferr == nil {
			resolvedType = "media"
		} else {
			resolvedType = "episode"
		}
	}
	return path, resolvedType, nil
}

// mediaRoots returns the configured library paths, EvalSymlinks-resolved, for the
// direct-play symlink-containment guard in streaming.ServeFile. Best-effort: on a
// libraries-lookup error it returns nil, which makes ServeFile skip containment
// (preserving the prior unguarded behavior rather than failing playback on a DB
// blip). Library roots are few and direct play is once-per-playback, so the query
// cost is negligible.
func (h *StreamHandler) mediaRoots(ctx context.Context) []string {
	libs, err := h.queries.GetLibraries(ctx)
	if err != nil {
		return nil
	}
	var roots []string
	for _, lib := range libs {
		for _, p := range lib.Paths {
			if rp, rerr := filepath.EvalSymlinks(p); rerr == nil {
				roots = append(roots, rp)
			} else {
				roots = append(roots, p)
			}
		}
	}
	return roots
}

// ratingCeilingBlocks reports whether fileID (fileType "media" or "episode")
// exceeds claims' acting sub-profile's rating ceiling (issue #462) — the
// read/playback enforcement point that replaced the client-elective
// max_rating/profile_id the discovery filter used to trust. claims must be
// non-nil; every caller sits behind RequireAuth.
//
// Fails CLOSED on a lookup error (blocked=true) — unlike ChangeMedia's
// fail-open existence check (a non-security convenience check where
// straying couldn't leak content), this IS the security boundary, so a
// transient DB hiccup must deny rather than silently fall back to
// unrestricted.
func (h *StreamHandler) ratingCeilingBlocks(ctx context.Context, claims *auth.JWTClaims, fileID int64, fileType string) (bool, error) {
	var rating string
	var err error
	if fileType == "episode" {
		rating, err = h.queries.GetContentRatingForEpisodeFile(ctx, fileID)
	} else {
		rating, err = h.queries.GetContentRatingForMediaFile(ctx, fileID)
	}
	if err != nil {
		return true, err
	}
	profile, err := h.queries.ResolveActingProfile(ctx, claims.UserID, claims.RefreshTokenID)
	if err != nil {
		return true, err
	}
	return !db.RatingAllowed(profile.MaxAgeRating, rating), nil
}

// denyRatingCeiling writes the uniform "not found" response for a
// rating-ceiling block or lookup failure — 404, not 403, so a restricted
// profile probing file ids can't distinguish "exceeds your ceiling" from
// "doesn't exist" (issue #462's suggested direction).
func denyRatingCeiling(w http.ResponseWriter, fileID int64, err error) {
	if err != nil {
		slog.Error("rating ceiling check failed, denying by default", "file_id", fileID, "error", err)
	}
	writeError(w, http.StatusNotFound, "file not found")
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
	h.serveDirectFile(w, r, fileID, r.URL.Query().Get("type"))
}

// directCastSessionID is the sentinel SessionID value a cast-scoped token is
// bound to for DIRECT-PLAY hand-offs (AirPlay of a file the browser plays
// natively — no transcode session exists to bind to). The "direct:" prefix
// can never collide with real transcode session IDs (32 hex chars), so a
// direct cast token fails every HLS handler's SessionID match and grants
// access to exactly one file through ServeDirectCastFile.
func directCastSessionID(fileType string, fileID int64) string {
	return "direct:" + fileType + ":" + strconv.FormatInt(fileID, 10)
}

// ServeDirectCastFile is the receiver-facing twin of ServeDirectFile,
// registered under RequireStreamAuth (sibling group of the HLS routes) so it
// accepts EITHER a regular access token/cookie OR a cast-scoped ?token=
// (promoted to Authorization by the router's cast-promotion middleware —
// AirPlay receivers cannot send the httpOnly auth cookie, which made every
// AirPlayed direct-play title 401 before this route existed; #317's
// direct-play twin, 2026-07 review).
//
// Cast tokens minted by CreateDirectCastToken are bound to exactly one
// (fileType, fileID); any mismatch is a uniform 403 regardless of file
// existence, mirroring requireSessionAccess's anti-probing posture.
func (h *StreamHandler) ServeDirectCastFile(w http.ResponseWriter, r *http.Request) {
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return
	}
	fileType := r.URL.Query().Get("type") // "media" or "episode"
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	if claims.Scope == auth.ScopeCast {
		if (fileType != "media" && fileType != "episode") ||
			claims.SessionID != directCastSessionID(fileType, fileID) {
			writeError(w, http.StatusForbidden, "cast token does not grant access to this file")
			return
		}
	}
	h.serveDirectFile(w, r, fileID, fileType)
}

// CreateDirectCastToken mints a cast-scoped token bound to a single FILE for
// the direct-play AirPlay hand-off (POST /api/stream/{fileID}/cast-token
// ?type=media|episode). The session-scoped equivalent is CreateCastToken;
// this exists because a direct-play title has no transcode session to bind
// to. Registered under RequireAuth — only a fully-authenticated browser
// session can mint, and the token inherits the cast TTL + token-version
// revocation exactly like session cast tokens.
func (h *StreamHandler) CreateDirectCastToken(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return
	}
	// The binding must be exact, so the type is required — no
	// resolveFilePath-style media→episode fallback probing here.
	fileType := r.URL.Query().Get("type")
	if fileType != "media" && fileType != "episode" {
		writeError(w, http.StatusBadRequest, "type must be media or episode")
		return
	}
	// Existence check against the exact table the token will be bound to.
	if fileType == "media" {
		if _, ferr := h.queries.GetMediaFileByID(r.Context(), fileID); ferr != nil {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
	} else {
		if _, ferr := h.queries.GetEpisodeFileByID(r.Context(), fileID); ferr != nil {
			writeError(w, http.StatusNotFound, "file not found")
			return
		}
	}

	// Rating-ceiling enforcement AT MINT time (issue #462): once issued,
	// this cast token is a bearer capability for exactly one file with no
	// further profile check (serveDirectFile skips its own live check for
	// ScopeCast tokens) — so the check has to happen here, using the
	// minting session's own acting profile, or it never happens at all.
	if blocked, err := h.ratingCeilingBlocks(r.Context(), claims, fileID, fileType); err != nil || blocked {
		denyRatingCeiling(w, fileID, err)
		return
	}

	tokenStr, expiresAt, err := h.authSvc.GenerateCastToken(
		claims.UserID, claims.Username, claims.Role, claims.TokenVersion,
		directCastSessionID(fileType, fileID),
	)
	if err != nil {
		slog.Error("generate direct cast token", "file_id", fileID, "user_id", claims.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to mint cast token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"token":      tokenStr,
		"expires_at": expiresAt.Unix(),
		"url":        fmt.Sprintf("/api/stream/direct/%d?type=%s&token=%s", fileID, fileType, tokenStr),
	})
}

// serveDirectFile is the shared byte-serving core behind ServeDirectFile
// (RequireAuth: browser cookies/bearer) and ServeDirectCastFile
// (RequireStreamAuth: also file-bound cast tokens).
func (h *StreamHandler) serveDirectFile(w http.ResponseWriter, r *http.Request, fileID int64, fileType string) {
	filePath, ft, resolveErr := h.resolveFileWithType(r.Context(), fileID, fileType)
	if resolveErr != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}

	claims := auth.GetClaims(r.Context())

	// Rating-ceiling enforcement (issue #462). Skipped for cast-scoped
	// tokens: ServeDirectCastFile's caller already validated the exact
	// (fileType, fileID) binding above us, and CreateDirectCastToken checks
	// the ceiling at MINT time using the minting session's acting profile —
	// a cast token has no "current profile" of its own to re-check against,
	// same trust model the existing SessionID binding already uses.
	if claims != nil && claims.Scope != auth.ScopeCast {
		if blocked, err := h.ratingCeilingBlocks(r.Context(), claims, fileID, ft); err != nil || blocked {
			denyRatingCeiling(w, fileID, err)
			return
		}
	}

	// Extend the write deadline for direct play: the default server WriteTimeout
	// (120s) is far too short for streaming a full movie. Each range-request chunk
	// should reset the deadline, but http.ServeContent sends the entire range in
	// one write, so we give it 4 hours — matching a typical feature-length film.
	extendWriteDeadline(w, r, 4*time.Hour, "direct file")

	// HEAD is a preflight, not playback: skip every side effect so probes
	// don't create phantom "now streaming" entries or activity rows. One
	// enclosing guard (2026-07 review) so future side effects can't forget
	// their own clause.
	if claims != nil && r.Method != http.MethodHead {
		if h.activity != nil {
			h.activity.LogStreamStarted(r.Context(), claims.UserID, filepath.Base(filePath), "direct_play")
		}
		// Register / extend a direct-play session entry so the admin
		// Active Streams view can show this stream alongside transcodes.
		// Range requests during playback keep calling this handler →
		// touching extends LastAccess. Idle gaps > TTL expire the entry.
		if h.directPlay != nil {
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
	}

	streaming.ServeFile(w, r, filePath, h.mediaRoots(r.Context()))
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

	// This route sits behind RequireAuth, so claims is always populated in
	// production; the nil check is defensive symmetry with the transcode
	// branch below.
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	// Rating-ceiling enforcement (issue #462), before either the direct-play
	// or transcode-fallback branch below can touch the file.
	if blocked, err := h.ratingCeilingBlocks(r.Context(), claims, fileID, "media"); err != nil || blocked {
		denyRatingCeiling(w, fileID, err)
		return
	}

	// Check if direct play is possible
	if streaming.CanDirectPlay(file.Container, file.VideoCodec, file.AudioCodec) {
		// Extend write deadline for direct play (default 120s is too short for movies)
		extendWriteDeadline(w, r, 4*time.Hour, "direct play media")
		// HEAD preflights (see the HEAD route registrations) skip every side
		// effect — no activity row, no registry entry, no now_playing
		// broadcast. ONE enclosing guard so the next side effect added here
		// can't forget its own clause and reintroduce phantom "now
		// streaming" entries for player preflights.
		if r.Method != http.MethodHead {
			// Log direct play stream start
			if h.activity != nil {
				h.activity.LogStreamStarted(r.Context(), claims.UserID, filepath.Base(file.Path), "direct_play")
			}
			// Register / extend a direct-play session entry (see comment
			// in ServeDirectFile for the rationale + heartbeat detail).
			if h.directPlay != nil {
				fileName := filepath.Base(file.Path)
				sid := h.directPlay.Touch(claims.UserID, claims.Username, "media", fileID, fileName, "direct_play")
				stopHB := make(chan struct{})
				go heartbeatRegistry(r.Context(), h.directPlay, sid, claims, "media", fileID, fileName, stopHB)
				defer close(stopHB)
			}
			// Broadcast now_playing for direct play
			mediaTitle := filepath.Base(file.Path)
			if item, err := h.queries.GetMediaItem(r.Context(), file.MediaItemID); err == nil && item != nil {
				mediaTitle = item.Title
			}
			h.broadcastNowPlaying(r.Context(), claims, mediaTitle, "movie", "", "direct_play")
		}
		streaming.ServeFile(w, r, file.Path, h.mediaRoots(r.Context()))
		return
	}

	// Fall back to adaptive HLS transcode.
	// HEAD preflight: this route answers JSON (the HLS redirect shape) for
	// non-direct-playable files. Report reachability without spawning a
	// transcode session as a side effect.
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		return
	}
	startSec, _ := strconv.Atoi(r.URL.Query().Get("start"))
	srcW, srcH := parseResolution(file.Resolution)
	// Source facts from the library's own probe data gate hardware decode
	// and HDR tonemapping in the session (2026-07 — this legacy path used
	// to pass none of them, so hw decode never engaged and HDR sources
	// transcoded washed-out here; CreateSession re-derives HDRTonemap from
	// SourceHDR for full transcodes).
	session, err := h.transcode.GetOrCreateSession(file.Path, startSec, claims.UserID, claims.Username, srcW, srcH,
		streaming.SessionOpts{
			SourceVideoCodec:  file.VideoCodec,
			SourceVideoPixFmt: file.VideoPixFmt,
			SourceFPS:         file.VideoFPS,
			SourceHDR:         streaming.IsHDRColorTransfer(file.ColorTransfer),
		})
	if err != nil {
		slog.Error("transcode session failed", "file_id", fileID, "error", err)
		writeSessionCreateError(w, claims.UserID, err)
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

	// This route sits behind RequireAuth, so claims is always populated in
	// production; the nil check is defensive symmetry with the transcode
	// branch below.
	claims := auth.GetClaims(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	// Rating-ceiling enforcement (issue #462), before either the direct-play
	// or transcode-fallback branch below can touch the file.
	if blocked, err := h.ratingCeilingBlocks(r.Context(), claims, fileID, "episode"); err != nil || blocked {
		denyRatingCeiling(w, fileID, err)
		return
	}

	if streaming.CanDirectPlay(file.Container, file.VideoCodec, file.AudioCodec) {
		// Extend write deadline for direct play (default 120s is too short for episodes)
		extendWriteDeadline(w, r, 4*time.Hour, "direct play episode")
		// HEAD preflights skip every side effect — one enclosing guard, same
		// rationale as StreamMediaFile.
		if r.Method != http.MethodHead {
			// Log direct play stream start
			if h.activity != nil {
				h.activity.LogStreamStarted(r.Context(), claims.UserID, filepath.Base(file.Path), "direct_play")
			}
			// Register / extend a direct-play session entry (see comment
			// in ServeDirectFile for the rationale + heartbeat detail).
			if h.directPlay != nil {
				fileName := filepath.Base(file.Path)
				sid := h.directPlay.Touch(claims.UserID, claims.Username, "episode", fileID, fileName, "direct_play")
				stopHB := make(chan struct{})
				go heartbeatRegistry(r.Context(), h.directPlay, sid, claims, "episode", fileID, fileName, stopHB)
				defer close(stopHB)
			}
			// Broadcast now_playing for direct play
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
		streaming.ServeFile(w, r, file.Path, h.mediaRoots(r.Context()))
		return
	}

	// HEAD preflight: this route answers JSON (the HLS redirect shape) for
	// non-direct-playable files. Report reachability without spawning a
	// transcode session as a side effect.
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		return
	}
	startSec, _ := strconv.Atoi(r.URL.Query().Get("start"))
	srcW, srcH := parseResolution(file.Resolution)
	// Source facts from the library's own probe data gate hardware decode
	// and HDR tonemapping in the session (2026-07 — this legacy path used
	// to pass none of them, so hw decode never engaged and HDR sources
	// transcoded washed-out here; CreateSession re-derives HDRTonemap from
	// SourceHDR for full transcodes).
	session, err := h.transcode.GetOrCreateSession(file.Path, startSec, claims.UserID, claims.Username, srcW, srcH,
		streaming.SessionOpts{
			SourceVideoCodec:  file.VideoCodec,
			SourceVideoPixFmt: file.VideoPixFmt,
			SourceFPS:         file.VideoFPS,
			SourceHDR:         streaming.IsHDRColorTransfer(file.ColorTransfer),
		})
	if err != nil {
		slog.Error("transcode session failed", "file_id", fileID, "error", err)
		writeSessionCreateError(w, claims.UserID, err)
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
		// A cast-scoped token fetching this session IS a receiver pulling
		// from it — the only first-hand evidence the server ever gets that
		// playback has left the browser. That is what puts the session on
		// the longer idle window (see streaming.castHeldTimeout), so the
		// lease is earned by a real fetch rather than granted at mint time.
		//
		// Minting is the wrong moment: the clone exists and is leased before
		// the response is written, so a response lost on the way back — a
		// flaky phone, which is exactly the population this feature is for —
		// left a 30-minute clone whose ID the client never learned and could
		// therefore never release. Two of those exhaust the per-user session
		// cap and ordinary playback starts failing. Leasing here means an
		// unreachable clone is simply never leased: it ages out on the normal
		// five-minute sweep like any abandoned session.
		//
		// Idempotent and cheap — a map lookup plus two writes under the same
		// tm.mu that GetSession takes for this request anyway.
		h.transcode.MarkCastHeld(sessionID)
		return true
	}

	// Regular access tokens: uniform 404 for both "doesn't exist" and
	// "exists but belongs to another user" (review 2026-06 finding S3 —
	// previously a 404/403 split let any token holder confirm whether a
	// session ID existed). Other users' sessions are simply not visible.
	// Admins still pass the ownership check below and reach any session.
	owner := h.transcode.GetSessionOwner(sessionID)
	if owner < 0 || (owner != claims.UserID && claims.Role != "admin") {
		writeError(w, http.StatusNotFound, "session not found")
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
//
// ?at=<seconds> is the sender's absolute source position — where the receiver
// is about to be asked to play from. It decides the cast clone's -ss anchor
// (see CloneForCast); omitting it keeps the pre-2026-09 behaviour of
// inheriting the source session's anchor. The response's start_sec reports the
// anchor the cast session ACTUALLY has, which is the only value the sender may
// use to convert an absolute position into a receiver-relative startTime: it
// is the source session's anchor on the shared-session path and the clone's
// own on the cloned path, and the two differ.
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
	// A malformed or absent ?at= is "no preference", not an error: this is a
	// positioning hint whose worst case is the behaviour that shipped before
	// it existed, and failing the mint over it would break casting for any
	// sender that hasn't been updated.
	atSec := -1
	if raw := r.URL.Query().Get("at"); raw != "" {
		if parsed, perr := strconv.Atoi(raw); perr == nil && parsed >= 0 {
			atSec = parsed
		} else {
			slog.Debug("cast: ignoring unusable ?at=", "session_id", sessionID, "raw", raw)
		}
	}
	// Uniform 404 for "doesn't exist" and "not yours" — same enumeration
	// hardening as requireSessionAccess (review finding S3).
	owner := h.transcode.GetSessionOwner(sessionID)
	if owner < 0 || (owner != claims.UserID && claims.Role != "admin") {
		writeError(w, http.StatusNotFound, "session not found")
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
	// Cast safety: the local session is negotiated for the browser's codec
	// capabilities, which may include HEVC/VP9/AV1 video or Dolby audio. The
	// Chromecast Default Media Receiver only reliably decodes H.264 + AAC over
	// HLS — other codecs cause an indefinite spinner (video) or silent playback
	// (Dolby audio) with no sender-side error. CloneForCast creates a cast-safe
	// H.264+AAC clone when needed; returns the original session when it's already
	// safe.
	//
	// Clone failure handling (2026-08 review fix): a QUOTA failure
	// (ErrSessionLimit / ErrUserSessionLimit) now surfaces to the sender as a
	// 429 instead of silently casting the original — a cast-safe-incompatible
	// original (Dolby audio, non-H.264 video) fails on the receiver in ways
	// the sender cannot detect (silent audio, indefinite spinner), so the
	// "no worse than pre-guard" fallback was actually worse than an honest,
	// actionable error. NON-quota clone failures keep the logged fallback:
	// those are transient/unexpected (disk, FFmpeg), the original session
	// may well be cast-safe anyway (clone not needed for H.264+AAC), and
	// failing the whole cast on an unexpected clone error would regress
	// sessions that previously worked.
	//
	// Exception — for_airplay=true: this is an AirPlay / native-HLS token
	// request (pre-baking a URL for vid.src so Apple TV can authenticate HLS
	// sub-resources without browser cookies, per #317). The browser's own
	// native HLS demuxer and Apple TV both tolerate master playlists that omit
	// the CODECS attribute (they probe segments), unlike the Chromecast Default
	// Media Receiver's shaka pipeline (which silently fails — hence #324).
	// Skipping the clone avoids spawning an empty-segment FFmpeg transcode that
	// makes vid.src point at an unready playlist (#326). This restores the
	// pre-#324 native-HLS behaviour where the original session was used directly.
	castSessionID := sessionID
	if r.URL.Query().Get("for_airplay") != "true" {
		// NOTE the cast lease is NOT applied here. It is granted on the first
		// cast-token-authenticated fetch (requireSessionAccess), so it lands
		// only on a session a receiver has actually pulled from. See the
		// comment there for why mint time is the wrong moment.
		//
		// It also means the for_airplay branch needs no special handling to
		// avoid over-leasing: that path is minted during ordinary native-HLS
		// setup for every Safari/iOS playback, receiver or not, and simply
		// never produces a cast-scoped fetch unless an Apple TV really is
		// pulling the stream — in which case the lease is deserved.
		if castSession, cloneErr := h.transcode.CloneForCast(claims.UserID, claims.Username, sessionID, atSec); cloneErr != nil {
			if errors.Is(cloneErr, streaming.ErrUserSessionLimit) || errors.Is(cloneErr, streaming.ErrSessionLimit) {
				slog.Warn("cast: clone hit session quota — refusing to silently cast the incompatible original",
					"session_id", sessionID, "user_id", claims.UserID, "error", cloneErr)
				writeSessionCreateError(w, claims.UserID, cloneErr)
				return
			}
			slog.Warn("cast: clone failed, casting original session",
				"session_id", sessionID, "user_id", claims.UserID, "error", cloneErr)
		} else {
			castSessionID = castSession.ID
		}
		// Pre-warm every quality variant so the Chromecast Default Media
		// Receiver's ABR bandwidth probe hits a ready FFmpeg process rather
		// than a cold start. Without this, the receiver probes 480p first,
		// the FFmpeg for that tier hasn't started yet (browser was watching
		// a different quality), and the ~2s readiness wait puts Shaka into
		// an error-recovery polling loop that prevents playback (#355).
		if cs, ok := h.transcode.GetSession(castSessionID); ok {
			for _, p := range cs.Profiles {
				p, cs := p, cs
				go func() {
					if _, err := h.transcode.EnsureVariant(cs, p.Name, cs.StartSec); err != nil {
						slog.Debug("cast: pre-warm variant", "session_id", castSessionID, "profile", p.Name, "error", err)
					}
				}()
			}
		}
	}

	tokenStr, expiresAt, err := h.authSvc.GenerateCastToken(
		claims.UserID, claims.Username, claims.Role, claims.TokenVersion, castSessionID,
	)
	if err != nil {
		slog.Error("generate cast token", "session_id", castSessionID, "user_id", claims.UserID, "error", err)
		// A clone we made and are now not returning is unreachable: its ID
		// only ever travels in the response body we are about to discard, so
		// nothing — not the sender, not a later request — can address it
		// again. Stop it here rather than let it hold a per-user session slot
		// until the idle sweep. Never the caller's own session, which local
		// playback is still using.
		if castSessionID != sessionID {
			h.transcode.StopSession(castSessionID)
		}
		writeError(w, http.StatusInternalServerError, "failed to mint cast token")
		return
	}
	// The anchor the cast session actually has. On the shared-session and
	// for_airplay paths this is the local player's own start_sec; on the
	// cloned path it is the clone's, which CloneForCast may have moved to sit
	// near the sender. The sender cannot infer which case it got, so report it
	// rather than let it assume (assuming is what made a midstream cast seek
	// 40 minutes into a playlist that had produced seconds).
	//
	// A miss means the session named by the token we just minted is gone: the
	// clone created microseconds ago, or — on the for_airplay and clone-failure
	// paths, where castSessionID IS sessionID — the source.
	//
	// OMIT the field rather than guess. 0 is the worst available answer,
	// because it is not a neutral "unknown": it is a real, common anchor, and a
	// sender that adopts it converts every receiver reading as if the clock
	// were absolute. For a host on a clone anchored 40 minutes in, the first
	// pause broadcast would rewind the entire room by 40 minutes. The source's
	// anchor is no better on the cloned path — it describes a different
	// session's timeline. Omitting leaves the client on its own local anchor,
	// which is what it assumed before this field existed.
	resp := map[string]interface{}{
		"token":      tokenStr,
		"expires_at": expiresAt.Unix(),
		"playlist":   fmt.Sprintf("/api/stream/hls/%s/master.m3u8?token=%s", castSessionID, tokenStr),
	}
	if cs, ok := h.transcode.GetSession(castSessionID); ok && cs != nil {
		resp["start_sec"] = cs.StartSec
	} else {
		slog.Warn("cast: session vanished before start_sec could be read; omitting it",
			"cast_session", castSessionID, "user_id", claims.UserID)
	}
	writeJSON(w, http.StatusOK, resp)
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
		AudioCodecOut    string `json:"audio_codec_out,omitempty"`   // re-encode target: "aac" (stereo) or "ac3" (5.1 surround)
		VideoCodecOut    string `json:"video_codec_out,omitempty"`   // transcode output: "h264" (default) or "hevc"; clamped server-side
		HDRTonemap       bool   `json:"hdr_tonemap,omitempty"`       // apply HDR-to-SDR tonemapping
		VideoCodec       string `json:"video_codec,omitempty"`       // source video codec for BSF selection in remux
		StartSec         int    `json:"start_sec,omitempty"`         // resume position: FFmpeg -ss seek offset in seconds
		MaxBPS           int64  `json:"max_bps,omitempty"`           // client bitrate ceiling (bits/sec): caps the ABR ladder; 0 = none
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.StartSec < 0 {
		req.StartSec = 0
	}

	var filePath, resolution, fileAudioCodec, fileColorTransfer string
	var fileVideoCodec, fileVideoPixFmt string
	var fileVideoFPS float64
	var fileAudioTracks []models.AudioTrack
	if req.FileType == "episode" {
		f, err := h.queries.GetEpisodeFileByID(r.Context(), req.FileID)
		if err != nil {
			writeError(w, http.StatusNotFound, "episode file not found")
			return
		}
		filePath = f.Path
		resolution = f.Resolution
		fileAudioCodec = f.AudioCodec
		fileAudioTracks = f.AudioTracks
		fileColorTransfer = f.ColorTransfer
		fileVideoCodec = f.VideoCodec
		fileVideoPixFmt = f.VideoPixFmt
		fileVideoFPS = f.VideoFPS
	} else {
		f, err := h.queries.GetMediaFileByID(r.Context(), req.FileID)
		if err != nil {
			writeError(w, http.StatusNotFound, "media file not found")
			return
		}
		filePath = f.Path
		resolution = f.Resolution
		fileAudioCodec = f.AudioCodec
		fileAudioTracks = f.AudioTracks
		fileColorTransfer = f.ColorTransfer
		fileVideoCodec = f.VideoCodec
		fileVideoPixFmt = f.VideoPixFmt
		fileVideoFPS = f.VideoFPS
	}

	// Rating-ceiling enforcement (issue #462) — this is the transcode-session
	// mint point; a session (and the HLS playlist URL it hands back) must
	// never be issued for content the acting profile can't see.
	if blocked, err := h.ratingCeilingBlocks(r.Context(), claims, req.FileID, req.FileType); err != nil || blocked {
		denyRatingCeiling(w, req.FileID, err)
		return
	}

	srcW, srcH := parseResolution(resolution)

	// Build session options
	audioTrackIdx := -1 // -1 = FFmpeg default (first audio stream)
	if req.AudioTrackIndex != nil {
		audioTrackIdx = *req.AudioTrackIndex
	}

	// Server-side trust boundary for the echoed audio fields. The request's
	// audio_passthrough / audio_codec_out are an ECHO of our own stream-info
	// decision (keeps old frontends and new servers in lockstep), but a stale
	// SPA build or crafted request could ask for combinations the pipeline
	// can't honor — copy a codec the segment container can't carry, or
	// advertise ec-3 while the encoder emits AAC. Resolve the chosen track's
	// codec from the library's OWN probe data and normalize.
	sourceAudioCodec := fileAudioCodec
	if audioTrackIdx >= 0 && audioTrackIdx < len(fileAudioTracks) {
		sourceAudioCodec = fileAudioTracks[audioTrackIdx].Codec
	} else if len(fileAudioTracks) > 0 {
		sourceAudioCodec = fileAudioTracks[0].Codec
	}
	audioCopy, audioCodecOut := streaming.NormalizeSessionAudio(
		req.Remux, req.AudioPassthrough, req.AudioCodecOut,
		sourceAudioCodec, h.transcode.FMP4Enabled(),
	)

	// Same trust boundary for the channel count. The stereo downmix matrix
	// is indexed by input channel, so it must describe the track FFmpeg will
	// actually read: `pan` silently drops the terms of an echoed channel the
	// track does not have (and silently discards channels the matrix never
	// names), so a wrong count is a quietly wrong mix. The library's
	// per-track probe is authoritative; the echo is only used for rows
	// scanned before channel counts were recorded.
	audioChannels := req.AudioChannels
	if audioTrackIdx >= 0 && audioTrackIdx < len(fileAudioTracks) {
		if ch := fileAudioTracks[audioTrackIdx].Channels; ch > 0 {
			audioChannels = ch
		}
	} else if len(fileAudioTracks) > 0 {
		if ch := fileAudioTracks[0].Channels; ch > 0 {
			audioChannels = ch
		}
	}

	opts := streaming.SessionOpts{
		Remux:            req.Remux,
		AudioPassthrough: !req.Remux && audioCopy,
		AudioTrackIndex:  audioTrackIdx,
		AudioChannels:    audioChannels,
		// Self-limiting, so an echo is fine here: the worst a wrong value
		// does is hand this client a smaller ladder.
		MaxBitrate:    clampMaxBPS(req.MaxBPS),
		AudioCodecOut: audioCodecOut,
		HDRTonemap:    req.HDRTonemap,
		// Resolved from the library's own probe data, NOT echoed from the
		// client: CreateSession uses it to force tonemapping whenever a
		// session re-encodes video that the stream-info decision expected to
		// copy (TS-mode remux promotion, forceTranscode retries, cast clones).
		SourceHDR:        streaming.IsHDRColorTransfer(fileColorTransfer),
		SourceVideoCodec: req.VideoCodec,
		// Same trust boundary for the video source facts the hardware-decode
		// gate needs: bit depth always comes from the library's probe, and
		// the DB's codec — when the scanner recorded one — overrides the
		// client echo (it describes the exact file FFmpeg will read; a stale
		// echo would mis-gate hw decode and remux BSF selection alike).
		SourceVideoPixFmt: fileVideoPixFmt,
		SourceFPS:         fileVideoFPS,
		VideoCodecOut:     req.VideoCodecOut, // echoed stream-info decision; CreateSession clamps it
		StartSec:          req.StartSec,
	}
	if fileVideoCodec != "" {
		opts.SourceVideoCodec = fileVideoCodec
	}

	if req.Remux {
		// Remux mode: the normalized copy flag drives RemuxAudioCopy (copy
		// vs AAC/AC-3 re-encode alongside the copied video).
		opts.RemuxAudioCopy = audioCopy
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
			RelIndex:     -1, // computed below from the probed tracks (embedded subs)
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

		// Auto-detect bitmap subtitles by probing the file's subtitle tracks,
		// and precompute the subtitle-relative burn-in index from the same
		// probe so the transcode pipeline doesn't re-run ffprobe while holding
		// the session lock (the `subtitles` filter wants a relative index).
		if req.BurnSubExternal == "" {
			tracks, _ := gatedProbeSubtitles(r.Context(), filePath)
			for _, t := range tracks {
				if t.Index == *req.BurnSubIndex {
					bi.IsBitmap = streaming.IsBitmapSubtitle(t.Codec)
					break
				}
			}
			if len(tracks) > 0 {
				bi.RelIndex = streaming.SubtitleRelativeIndex(tracks, *req.BurnSubIndex)
			}
		}

		opts.BurnIn = bi
	}

	// Probe subtitle tracks for inline HLS extraction (Emby-style).
	// Only text-based subs (subrip, ass, ssa, mov_text, webvtt) are included;
	// bitmap subs (PGS, VOBSUB, DVB) cannot be converted to WebVTT.
	// This adds zero overhead — the same file will be opened by FFmpeg for
	// video/audio anyway; subtitles piggyback on that I/O.
	if probedSubs, probeErr := gatedProbeSubtitles(r.Context(), filePath); probeErr == nil && len(probedSubs) > 0 {
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
		writeSessionCreateError(w, claims.UserID, err)
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
// distinctly. `count` is the combined RAW total.
//
// Not the same number as the admin dashboard's "Active Streams" tile, which
// is AdminHandler.Dashboard via activeStreamTileCount: that one folds a
// Chromecast's two sessions (paused local + receiver clone) into the one
// viewer they represent. This endpoint is a session inventory, so it counts
// sessions.
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
		// Resolved speed/quality policy for THIS host's encoder family, so the
		// admin surface shows what the encoders were actually asked for rather
		// than only what hardware was detected.
		"quality_policy": h.transcode.EncodingPolicy(),
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

	// Retrieve session info before stopping so we can log the file name.
	// Uniform 404 for missing vs not-owned (review finding S3).
	session, found := h.transcode.GetSession(sessionID)
	if !found || (session.UserID != claims.UserID && claims.Role != "admin") {
		writeError(w, http.StatusNotFound, "session not found")
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
	// Uniform 404 (review finding S3) — see requireSessionAccess. The two
	// causes stay separate on this side of the wire: only a session the
	// server genuinely does not have says anything about a stuck client.
	owner := h.transcode.GetSessionOwner(sessionID)
	if owner < 0 {
		h.noteStaleKeepalive(sessionID, claims.UserID)
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if owner != claims.UserID && claims.Role != "admin" {
		// The session exists, it just isn't theirs. Same 404 on the wire,
		// but not a stale client — it must not consume the watcher's budget
		// or raise a warning that names the wrong problem.
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if !h.transcode.KeepAlive(sessionID) {
		// Raced: reaped between the two lookups. Same signal as above.
		h.noteStaleKeepalive(sessionID, claims.UserID)
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	h.staleKeepalive.alive(sessionID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// noteStaleKeepalive records a keepalive for a session the server does not
// have, and warns the first time one client's pings cross the threshold.
func (h *StreamHandler) noteStaleKeepalive(sessionID string, userID int64) {
	misses, warn := h.staleKeepalive.miss(sessionID, time.Now())
	if !warn {
		return
	}
	slog.Warn("client keeps pinging a stream session that no longer exists — "+
		"its player is probably stuck on a frozen frame and needs a reload",
		"session_id", sessionID,
		"user_id", userID,
		"consecutive_404s", misses)
}

// hwAccelStatusResponse is the detected hardware capability plus the resolved
// encoding policy. HWAccelInfo is EMBEDDED so its fields stay at the top level
// of the JSON object — existing consumers of this endpoint keep reading exactly
// the shape they always have, with quality_policy added alongside.
type hwAccelStatusResponse struct {
	streaming.HWAccelInfo
	QualityPolicy string `json:"quality_policy"`
}

// HWAccelStatus returns detected hardware acceleration info plus the resolved
// speed/quality policy.
func (h *StreamHandler) HWAccelStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, hwAccelStatusResponse{
		HWAccelInfo:   h.transcode.HWAccelStatus(),
		QualityPolicy: h.transcode.EncodingPolicy(),
	})
}

// writeSessionCreateError maps a transcode session-creation failure onto the
// right HTTP response. Session-limit errors are user-relevant (they need to
// wait or close another stream) and return 429 with an actionable message;
// all other errors may contain filesystem paths and are not exposed. Typed
// sentinels first; the string check is kept as a safety net for any older
// wrapped form. Shared by the explicit CreateSession endpoint and the legacy
// auto-decision endpoints (StreamMediaFile/StreamEpisodeFile) so a quota hit
// is never reported as a generic 500.
func writeSessionCreateError(w http.ResponseWriter, userID int64, err error) {
	switch {
	case errors.Is(err, streaming.ErrUserSessionLimit):
		writeError(w, http.StatusTooManyRequests, "you have too many active streams — close one and try again")
	case errors.Is(err, streaming.ErrSessionLimit), strings.Contains(err.Error(), "maximum transcode sessions"):
		writeError(w, http.StatusTooManyRequests, "maximum transcode sessions reached, try again later")
	default:
		slog.Error("failed to create transcode session", "user_id", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to create transcode session")
	}
}

// maxBPSCeiling bounds the client bitrate ceiling. Anything above a gigabit is
// not a real delivery limit, and a number that large is either a unit mix-up
// (kbps typed as bps) or garbage; either way it must not reach the ladder.
const maxBPSCeiling = 1_000_000_000

// clampMaxBPS normalizes a client-declared bitrate ceiling: <= 0 (or absent)
// means none, and implausibly large values are treated as none rather than
// as a ceiling nothing exceeds.
func clampMaxBPS(v int64) int64 {
	if v <= 0 || v > maxBPSCeiling {
		return 0
	}
	return v
}

// parseMaxBPS reads the `max_bps` query parameter (bits per second) through
// the same normalization. Unparseable input means no ceiling.
func parseMaxBPS(raw string) int64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return clampMaxBPS(v)
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
		// Server-side delivery context, not a client capability: tells the
		// decision engine whether HLS segments are fMP4 (CMAF) — which
		// Apple requires for HEVC remux on native players — or legacy
		// MPEG-TS. See ClientCaps.FMP4.
		clientCaps.FMP4 = h.transcode.FMP4Enabled()
		// Same server-side delivery context for HEVC transcode OUTPUT
		// (2026-08 review item #5): the decision engine may only choose
		// "hevc" when this host actually has a working HEVC encoder.
		clientCaps.HEVCEncode = h.transcode.HEVCEncodeEnabled()
		// Client-declared delivery ceiling (bits/sec). A constraint the
		// viewer set, not a capability — see ClientCaps.MaxBitrate.
		clientCaps.MaxBitrate = parseMaxBPS(r.URL.Query().Get("max_bps"))
	}
	// Preferred spoken language, any ISO 639 form; "" = no preference.
	// Ignored on the no-caps static path, which has no track selection.
	preferredAudioLang := r.URL.Query().Get("audio_lang")

	var filePath, container, videoCodec, audioCodec, resolution, videoPixFmt string
	var colorTransfer, colorPrimaries string
	var durationMs, sourceBitrate int64
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
		sourceBitrate = f.Bitrate
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
		sourceBitrate = f.Bitrate
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
	pd := streaming.DecidePlaybackFor(streaming.DecisionInput{
		Container:          container,
		VideoCodec:         videoCodec,
		PixFmt:             videoPixFmt,
		AudioTracks:        audioTracks,
		Caps:               clientCaps,
		SourceBitrate:      sourceBitrate,
		PreferredAudioLang: preferredAudioLang,
	})

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

	// Probe subtitles. Bounded by ffprobeGate (audit MED) so a burst of
	// concurrent stream-info requests can't fork-bomb ffprobe. On context
	// cancellation (client gone) we skip probing and serve an empty list
	// rather than holding a slot.
	var subtitles []models.SubtitleTrack
	if release, gErr := acquireFFprobeSlot(r.Context()); gErr == nil {
		subtitles, _ = streaming.ProbeSubtitles(r.Context(), filePath)
		release()
	}
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
	// HDR10) or "arib-std-b67" (HLG) — see streaming.IsHDRColorTransfer.
	// color_primaries == "bt2020" is a less reliable secondary signal
	// (wide-gamut SDR also uses bt2020).
	//
	// For files scanned before the color-metadata migration (color_*
	// fields empty), we default to NO tonemap — washed-out SDR output
	// is a much milder failure than total transcode crash. Users with
	// real HDR content should re-scan to pick up the metadata, or
	// pass hdr_tonemap=true explicitly on the session create payload.
	isHDR := streaming.IsHDRColorTransfer(colorTransfer)
	hdrTonemap := isHDR && pd.Decision == "transcode"
	_ = videoPixFmt    // retained for future use (10-bit logging / metrics)
	_ = colorPrimaries // retained for future use (wide-gamut SDR detection)

	// Audio output codec — copied audio carries the source codec (truthful
	// CODECS + cast stereo-clone coverage for copied Dolby audio), re-encoded
	// audio uses the stereo-AAC / AC-3-surround choice. Resolved by the
	// decision engine (OutputAudioCodec) so every consumer agrees.
	audioCodecOut := streaming.OutputAudioCodec(pd, clientCaps, audioChannels)

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
		ReasonCode:       streaming.ReasonCode(pd),
		AudioTrackIndex:  pd.AudioTrackIndex,
		Remux:            pd.Remux,
		AudioPassthrough: pd.AudioPassthrough,
		AudioChannels:    audioChannels,
		AudioCodecOut:    audioCodecOut,
		VideoCodecOut:    pd.VideoCodecOut,
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

	// Smart Skip markers ride the call the player already makes —
	// no extra round-trip on playback start. Source-time offsets; the
	// player maps them onto the active timeline via the session's
	// start_sec, exactly like watch progress. Zero-length rows (admin
	// suppressions) are filtered here: they exist only to stop the
	// analyzer re-adding a marker, never to reach the player. Best-
	// effort — a marker lookup failure must not break playback.
	markers := []models.SkipMarker{}
	if all, mErr := h.queries.GetSkipMarkers(r.Context(), fileID, fileType == "episode"); mErr == nil {
		for _, m := range all {
			if m.EndMs > m.StartMs {
				markers = append(markers, m)
			}
		}
	} else {
		slog.Warn("stream info: skip-marker lookup failed", "file_id", fileID, "error", mErr)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"stream":       info,
		"subtitles":    subtitles,
		"audio_tracks": audioTracks,
		"markers":      markers,
	})
}

// GetSubtitles lists available subtitle tracks for a media file.
func (h *StreamHandler) GetSubtitles(w http.ResponseWriter, r *http.Request) {
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
	fileID, err := strconv.ParseInt(chi.URLParam(r, "fileID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file id")
		return
	}

	// Resolve file path using the type hint to avoid ID collisions
	// between media_files and episode_files (separate BIGSERIAL sequences)
	fileType := r.URL.Query().Get("type") // "media" or "episode"
	filePath, resolvedType, resolveErr := h.resolveFileWithType(r.Context(), fileID, fileType)
	if resolveErr != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	// Rating-ceiling enforcement (issue #462) — a subtitle track's dialogue
	// is as much "the content" as the video for this purpose (full
	// transcript of an over-ceiling title), same read-path gate as
	// StreamMediaFile/StreamEpisodeFile.
	if blocked, err := h.ratingCeilingBlocks(r.Context(), claims, fileID, resolvedType); err != nil || blocked {
		denyRatingCeiling(w, fileID, err)
		return
	}

	// Probe embedded subtitles. Bounded by ffprobeGate (audit MED) to stop a
	// burst of concurrent requests from fork-bombing ffprobe. On context
	// cancellation we skip the probe and fall back to external subs only.
	var tracks []models.SubtitleTrack
	if release, gErr := acquireFFprobeSlot(r.Context()); gErr == nil {
		tracks, _ = streaming.ProbeSubtitles(r.Context(), filePath)
		release()
	}
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
	claims, ok := requireClaims(w, r)
	if !ok {
		return
	}
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
	filePath, resolvedType, resolveErr := h.resolveFileWithType(r.Context(), fileID, fileType)
	if resolveErr != nil {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	// Rating-ceiling enforcement (issue #462) — see GetSubtitles.
	if blocked, err := h.ratingCeilingBlocks(r.Context(), claims, fileID, resolvedType); err != nil || blocked {
		denyRatingCeiling(w, fileID, err)
		return
	}

	// HEAD preflight (2026-07 review): answer with the content type only.
	// The GET path may run a full FFmpeg extraction that reads through the
	// entire container (minutes for large MKVs) while holding an
	// ffprobeGate slot — burning all of that to produce a body net/http
	// then discards would let a handful of preflights exhaust the gate.
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
		w.WriteHeader(http.StatusOK)
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
	//              startSec. Since #431 (-noaccurate_seek on the remux
	//              path) re-encoded audio ALSO starts at that keyframe
	//              (before the fix it was trimmed to ~startSec, which
	//              opened a GOP-sized A/V gap hls.js glued shut into a
	//              constant desync). hls.js anchors currentTime to the
	//              earliest PTS — now the audio packet a hair before
	//              the video keyframe (~1 audio frame, <100ms; within
	//              the skew already tolerated below). Shift cues by
	//              the keyframe.
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
				// Bounded by ffprobeGate (audit MED); if we can't get a
				// slot (ctx cancelled), fall back to startSec directly.
				shiftOffset = float64(startSec)
				if release, gErr := acquireFFprobeSlot(r.Context()); gErr == nil {
					shiftOffset = streaming.ProbeSeekKeyframe(r.Context(), filePath, float64(startSec))
					release()
				}
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
				// ASS, SSA, and other formats: convert to VTT via ffmpeg.
				// Bounded by ffprobeGate (audit MED) so concurrent
				// conversions can't fork-bomb ffmpeg.
				release, gErr := acquireFFprobeSlot(r.Context())
				if gErr != nil {
					writeError(w, http.StatusServiceUnavailable, "server busy, try again")
					return
				}
				vttPath, err := streaming.ConvertSubtitleToVTT(r.Context(), ext.Title, h.subCache)
				release()
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
	// Bounded by ffprobeGate (audit MED); on ctx cancellation we skip the probe
	// (the extraction below shares the same ctx and will fail fast anyway).
	if release, gErr := acquireFFprobeSlot(r.Context()); gErr == nil {
		tracks, _ := streaming.ProbeSubtitles(r.Context(), filePath)
		release()
		for _, t := range tracks {
			if t.Index == trackIdx && streaming.IsBitmapSubtitle(t.Codec) {
				writeError(w, http.StatusBadRequest, "bitmap subtitles (PGS/VOBSUB/DVB) cannot be converted to text; use burn-in instead")
				return
			}
		}
	}

	// Extend the HTTP write deadline for subtitle extraction on large files.
	// The default server WriteTimeout (120s) is too short for extracting
	// interleaved subtitle packets from multi-GB MKV files (FFmpeg must read
	// through the entire container). Go 1.20+ ResponseController lets us
	// extend the deadline per-handler without affecting other endpoints.
	extendWriteDeadline(w, r, 10*time.Minute, "subtitle extraction")

	// Text-based subtitle — extract with FFmpeg. Bounded by ffprobeGate
	// (audit MED) so concurrent extractions can't fork-bomb ffmpeg.
	release, gErr := acquireFFprobeSlot(r.Context())
	if gErr != nil {
		writeError(w, http.StatusServiceUnavailable, "server busy, try again")
		return
	}
	vttPath, err := streaming.ExtractSubtitleVTT(r.Context(), filePath, trackIdx, h.subCache)
	release()
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
	recap   *recap.Service      // optional — prebuilds "Previously" recaps on episode completion
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

// SetRecapService attaches the "Previously" recap service. When set, finishing
// an episode warms the spoiler-safe recap for the next resume (see
// prebuildRecapAsync). Optional; nil disables prebuilding (the on-demand GET
// /api/media/{id}/recap still works and generates lazily).
func (h *ProgressHandler) SetRecapService(s *recap.Service) {
	h.recap = s
}

// recapPrebuildTimeout bounds a background prebuild. Above the recap service's
// own 60s LLM budget so the inner timeout governs, not this one.
const recapPrebuildTimeout = 90 * time.Second

// prebuildRecapAsync warms the "Previously" recap cache after an episode
// completes. Finishing an episode makes it the viewer's new spoiler boundary,
// so the recap they'll want when they return — bounded to this episode — is
// exactly what Build produces now. Fire-and-forget on a context detached from
// the request (which returns immediately); every failure mode (LLM disabled,
// not enough history/overviews, transient) is swallowed at Debug because the
// on-demand GET will simply regenerate. Single-flight in the shared service
// collapses this with a near-simultaneous on-demand open.
func (h *ProgressHandler) prebuildRecapAsync(profileID, mediaItemID int64) {
	if h.recap == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), recapPrebuildTimeout)
		defer cancel()
		if _, err := h.recap.Build(ctx, profileID, mediaItemID); err != nil {
			slog.Debug("recap prebuild skipped",
				"profile_id", profileID, "media_item_id", mediaItemID, "error", err)
		}
	}()
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

	claims := auth.GetClaims(r.Context())
	var refreshTokenID int64
	if claims != nil && claims.UserID == userID {
		refreshTokenID = claims.RefreshTokenID
	}
	dp, err := h.queries.ResolveActingProfile(r.Context(), userID, refreshTokenID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve acting profile")
		return 0, false
	}
	if dp != nil && dp.ID > 0 {
		return dp.ID, true
	}

	// No default profile yet. This happens for an OAuth signup (the callback
	// never creates a profile) or a password Register whose profile-create was
	// swallowed as non-fatal — until the next restart's migrateDefaultProfiles
	// runs. Migration 029 made watch_progress.profile_id NOT NULL, so we MUST
	// resolve a real profile here or the first progress write 500s. Create the
	// default on demand. deep-debug carve-out B.
	name := "Default"
	if u, uerr := h.queries.GetUserByID(r.Context(), userID); uerr == nil && u != nil && u.Username != "" {
		name = u.Username
	}
	created, cerr := h.queries.CreateDefaultProfileForUser(r.Context(), userID, name)
	if cerr != nil {
		// Likely a race — a concurrent request created the default first (the
		// one-default-per-user partial unique index rejects the second). Re-read.
		if dp2, rerr := h.queries.GetDefaultProfile(r.Context(), userID); rerr == nil && dp2 != nil {
			return dp2.ID, true
		}
		writeError(w, http.StatusInternalServerError, "failed to create default profile")
		return 0, false
	}
	return created.ID, true
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

	newlyCompleted, err := h.queries.UpsertWatchProgress(r.Context(), wp)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update progress")
		return
	}

	// Notify other devices of the same user about the progress change.
	// `completed` mirrors what the upsert persisted (it auto-completes at the
	// >= threshold position), not a hardcoded false — so a heartbeat that
	// crosses the finish line broadcasts the completion to other devices.
	if h.hub != nil {
		h.hub.BroadcastToUser(claims.UserID, ws.EventProgressSync, map[string]interface{}{
			"media_item_id": mediaID,
			"episode_id":    req.EpisodeID,
			"position_ms":   req.PositionMs,
			"duration_ms":   req.DurationMs,
			"completed":     wp.Completed,
		})
	}

	// Phase 6 — Gamification. UpdateProgress that crosses the completion
	// threshold (>= 90% of duration) grants XP exactly once, implementing the
	// documented ">=90% on UpdateProgress grants XP" contract in the same
	// shared, idempotent place as MarkWatched. The newlyCompleted gate ensures
	// repeated heartbeats past the threshold don't re-award. Best-effort: an
	// engine error must not fail the progress write.
	var unlocks []AchievementDef
	if h.gamify != nil && newlyCompleted {
		unlocks = h.gamify.AwardForWatch(r.Context(), claims.UserID, time.Now().UTC())
	}

	// Warm the "Previously" recap for the next resume. Only for episodes
	// (wp.EpisodeID != nil) and only on the completion transition.
	if newlyCompleted && wp.EpisodeID != nil {
		h.prebuildRecapAsync(profileID, mediaID)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message":               "progress updated",
		"achievements_unlocked": unlocks,
	})
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

	var requested *int64
	if raw := r.URL.Query().Get("profile_id"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id < 0 {
			writeError(w, http.StatusBadRequest, "invalid profile_id")
			return
		}
		requested = &id
	}
	profileID, ok := h.resolveProgressProfileID(w, r, claims.UserID, requested)
	if !ok {
		return
	}
	progress, err := h.queries.GetWatchProgressForProfile(r.Context(), claims.UserID, profileID, mediaID, episodeID)
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
		profile, profileErr := h.queries.ResolveActingProfile(r.Context(), claims.UserID, claims.RefreshTokenID)
		if profileErr != nil {
			writeError(w, http.StatusInternalServerError, "failed to resolve acting profile")
			return
		}
		items, err = h.queries.GetContinueWatchingByProfile(r.Context(), profile.ID, limit)
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

	newlyCompleted, err := h.queries.UpsertWatchProgress(r.Context(), wp)
	if err != nil {
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
	//
	// Idempotency gate (security low) — only award when THIS call first
	// transitioned the row to completed. Without it, scripting repeated
	// POSTs (even on a never-streamed media id) farms +50 XP, levels,
	// total_watches, and count-based achievements per request.
	var unlocks []AchievementDef
	if h.gamify != nil && newlyCompleted {
		unlocks = h.gamify.AwardForWatch(r.Context(), claims.UserID, time.Now().UTC())
	}

	// Warm the "Previously" recap for the next resume (episodes only).
	if newlyCompleted && wp.EpisodeID != nil {
		h.prebuildRecapAsync(profileID, mediaID)
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
	var requestedProfile *int64
	if raw := r.URL.Query().Get("profile_id"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id < 0 {
			writeError(w, http.StatusBadRequest, "invalid profile_id")
			return
		}
		requestedProfile = &id
	}
	profileID, ok := h.resolveProgressProfileID(w, r, claims.UserID, requestedProfile)
	if !ok {
		return
	}

	var episodeID *int64
	if epStr := r.URL.Query().Get("episode_id"); epStr != "" {
		id, err := strconv.ParseInt(epStr, 10, 64)
		if err == nil {
			episodeID = &id
		}
	}

	if err := h.queries.DeleteWatchProgressForProfile(r.Context(), claims.UserID, profileID, mediaID, episodeID); err != nil {
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
