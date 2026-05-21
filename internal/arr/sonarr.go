package arr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// ErrSeriesNotFound is returned by Sonarr lookup methods when Skyhook's cache
// doesn't have a matching series for the given external ID. Callers can use
// errors.Is to distinguish this from network/auth failures and trigger a
// fallback lookup path (TMDB external_ids, TVDB direct search).
var ErrSeriesNotFound = errors.New("series not found in Sonarr lookup")

// SonarrClient is a client for the Sonarr v3 API.
// It embeds the base Client for shared HTTP functionality.
type SonarrClient struct {
	*Client
}

// NewSonarrClient creates a new Sonarr API client.
func NewSonarrClient(baseURL, apiKey string) *SonarrClient {
	return &SonarrClient{
		Client: NewClient(baseURL, apiKey),
	}
}

// TestConnection tests the connection to Sonarr by hitting /api/v3/system/status.
func (s *SonarrClient) TestConnection(ctx context.Context) error {
	if !s.IsConfigured() {
		return fmt.Errorf("Sonarr is not configured")
	}

	if err := s.ValidateURL(); err != nil {
		return err
	}

	_, err := s.Get(ctx, "/api/v3/system/status")
	if err != nil {
		return fmt.Errorf("failed to connect to Sonarr: %w", err)
	}

	return nil
}

// GetRootFolders returns the root folders configured in Sonarr.
func (s *SonarrClient) GetRootFolders(ctx context.Context) ([]RootFolder, error) {
	if !s.IsConfigured() {
		return nil, fmt.Errorf("Sonarr is not configured")
	}

	data, err := s.Get(ctx, "/api/v3/rootfolder")
	if err != nil {
		return nil, err
	}

	var folders []RootFolder
	if err := json.Unmarshal(data, &folders); err != nil {
		return nil, fmt.Errorf("failed to parse root folders: %w", err)
	}

	return folders, nil
}

// GetQualityProfiles returns the quality profiles configured in Sonarr.
func (s *SonarrClient) GetQualityProfiles(ctx context.Context) ([]QualityProfile, error) {
	if !s.IsConfigured() {
		return nil, fmt.Errorf("Sonarr is not configured")
	}

	data, err := s.Get(ctx, "/api/v3/qualityprofile")
	if err != nil {
		return nil, err
	}

	var profiles []QualityProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, fmt.Errorf("failed to parse quality profiles: %w", err)
	}

	return profiles, nil
}

// SonarrSeries represents a TV series in Sonarr's API.
type SonarrSeries struct {
	ID               int               `json:"id,omitempty"`
	Title            string            `json:"title"`
	TvdbID           int               `json:"tvdbId"`
	TmdbID           int               `json:"tmdbId,omitempty"`
	Year             int               `json:"year,omitempty"`
	QualityProfileID int               `json:"qualityProfileId"`
	RootFolderPath   string            `json:"rootFolderPath"`
	Path             string            `json:"path,omitempty"`
	Monitored        bool              `json:"monitored"`
	SeasonFolder     bool              `json:"seasonFolder"`
	AddOptions       *SonarrAddOptions `json:"addOptions,omitempty"`
	SeriesType       string            `json:"seriesType,omitempty"`
	Statistics       *SonarrStatistics `json:"statistics,omitempty"`
}

// SonarrAddOptions represents options when adding a series to Sonarr.
type SonarrAddOptions struct {
	SearchForMissingEpisodes     bool   `json:"searchForMissingEpisodes"`
	SearchForCutoffUnmetEpisodes bool   `json:"searchForCutoffUnmetEpisodes"`
	Monitor                      string `json:"monitor"`
}

// SonarrStatistics represents download statistics about a series in Sonarr.
type SonarrStatistics struct {
	EpisodeFileCount  int     `json:"episodeFileCount"`
	TotalEpisodeCount int     `json:"totalEpisodeCount"`
	PercentOfEpisodes float64 `json:"percentOfEpisodes"`
}

// SonarrLookupResult represents a series lookup result from Sonarr.
// Used to resolve TMDB ID to TVDB ID (which Sonarr uses internally).
type SonarrLookupResult struct {
	TvdbID      int    `json:"tvdbId"`
	TmdbID      int    `json:"tmdbId"`
	Title       string `json:"title"`
	Year        int    `json:"year"`
	Overview    string `json:"overview"`
	Status      string `json:"status"`
	SeasonCount int    `json:"seasonCount"`
}

// LookupSeriesByTmdbID searches Sonarr for a series using TMDB ID.
// Sonarr's lookup endpoint supports `tmdb:{id}` format.
// Returns the lookup result which includes the TVDB ID needed for AddSeries.
func (s *SonarrClient) LookupSeriesByTmdbID(ctx context.Context, tmdbID int) (*SonarrLookupResult, error) {
	if !s.IsConfigured() {
		return nil, fmt.Errorf("Sonarr is not configured")
	}

	data, err := s.Get(ctx, fmt.Sprintf("/api/v3/series/lookup?term=tmdb:%d", tmdbID))
	if err != nil {
		return nil, fmt.Errorf("failed to lookup series: %w", err)
	}

	var results []SonarrLookupResult
	if err := json.Unmarshal(data, &results); err != nil {
		return nil, fmt.Errorf("failed to parse lookup response: %w", err)
	}

	// Sonarr may return multiple results. Find the exact TMDB ID match.
	for i := range results {
		if results[i].TmdbID == tmdbID {
			return &results[i], nil
		}
	}

	if len(results) == 0 {
		return nil, fmt.Errorf("%w for TMDB ID %d", ErrSeriesNotFound, tmdbID)
	}

	// Sonarr returned result(s) but none has an exact TMDB match. This
	// happens when Sonarr's Skyhook cache returns a series whose stored
	// `tmdbId` field is empty (TVDB has the show but not yet linked to
	// TMDB in Skyhook), or when Sonarr falls back to a name-search for
	// the literal "tmdb:N" string and picks an unrelated series.
	//
	// Treat this as ErrSeriesNotFound so the caller's fallback chain
	// (resolveTvdbID Layers B + C in request_handlers.go) fires: read
	// the TVDB ID from TMDB's own external_ids endpoint, or search TVDB
	// directly by title+year. Returning a generic error here would
	// short-circuit Layer A's `!errors.Is(err, ErrSeriesNotFound)` guard
	// and bail the entire request — even though a valid TVDB ID may be
	// one TMDB API call away.
	return nil, fmt.Errorf("%w: Sonarr returned %d result(s) for TMDB ID %d with no exact match (Skyhook cache likely missing TMDB linkage)", ErrSeriesNotFound, len(results), tmdbID)
}

// LookupSeriesByTvdbID searches Sonarr for a series using TVDB ID directly.
// Used as a fallback when TMDB-keyed lookup fails — once we've discovered the
// TVDB ID via TMDB external_ids or a TVDB search, this confirms Sonarr can
// resolve the series before we attempt AddSeries.
func (s *SonarrClient) LookupSeriesByTvdbID(ctx context.Context, tvdbID int) (*SonarrLookupResult, error) {
	if !s.IsConfigured() {
		return nil, fmt.Errorf("Sonarr is not configured")
	}

	data, err := s.Get(ctx, fmt.Sprintf("/api/v3/series/lookup?term=tvdb:%d", tvdbID))
	if err != nil {
		return nil, fmt.Errorf("failed to lookup series: %w", err)
	}

	var results []SonarrLookupResult
	if err := json.Unmarshal(data, &results); err != nil {
		return nil, fmt.Errorf("failed to parse lookup response: %w", err)
	}

	for i := range results {
		if results[i].TvdbID == tvdbID {
			return &results[i], nil
		}
	}

	if len(results) == 0 {
		return nil, fmt.Errorf("%w for TVDB ID %d", ErrSeriesNotFound, tvdbID)
	}

	// Same fallback rationale as LookupSeriesByTmdbID: Sonarr returned
	// something but no exact TVDB match. Treat as ErrSeriesNotFound so
	// the caller can fall through to TVDB-direct-search by title+year.
	return nil, fmt.Errorf("%w: Sonarr returned %d result(s) for TVDB ID %d with no exact match", ErrSeriesNotFound, len(results), tvdbID)
}

// AddSeries adds a TV series to Sonarr for automated downloading.
// It uses the TVDB ID (not TMDB), sets searchForMissingEpisodes=true,
// monitor="all", seasonFolder=true, seriesType="standard".
func (s *SonarrClient) AddSeries(ctx context.Context, tvdbID int, title string, year int, qualityProfileID int, rootFolderPath string) (*SonarrSeries, error) {
	if !s.IsConfigured() {
		return nil, fmt.Errorf("Sonarr is not configured")
	}

	series := SonarrSeries{
		Title:            title,
		TvdbID:           tvdbID,
		Year:             year,
		QualityProfileID: qualityProfileID,
		RootFolderPath:   rootFolderPath,
		Monitored:        true,
		SeasonFolder:     true,
		SeriesType:       "standard",
		AddOptions: &SonarrAddOptions{
			SearchForMissingEpisodes: true,
			Monitor:                  "all",
		},
	}

	data, err := s.Post(ctx, "/api/v3/series", series)
	if err != nil {
		return nil, err
	}

	var result SonarrSeries
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse series response: %w", err)
	}

	return &result, nil
}

// GetSeries retrieves a series from Sonarr by its TVDB ID.
// Returns nil if the series is not found.
func (s *SonarrClient) GetSeries(ctx context.Context, tvdbID int) (*SonarrSeries, error) {
	if !s.IsConfigured() {
		return nil, fmt.Errorf("Sonarr is not configured")
	}

	data, err := s.Get(ctx, fmt.Sprintf("/api/v3/series?tvdbId=%d", tvdbID))
	if err != nil {
		return nil, err
	}

	var seriesList []SonarrSeries
	if err := json.Unmarshal(data, &seriesList); err != nil {
		return nil, fmt.Errorf("failed to parse series response: %w", err)
	}

	if len(seriesList) == 0 {
		return nil, nil
	}

	return &seriesList[0], nil
}

// GetQueue fetches the current download queue from Sonarr.
func (s *SonarrClient) GetQueue(ctx context.Context) ([]QueueItem, error) {
	if !s.IsConfigured() {
		return nil, fmt.Errorf("Sonarr is not configured")
	}

	data, err := s.Get(ctx, "/api/v3/queue?page=1&pageSize=200&includeUnknownSeriesItems=false")
	if err != nil {
		return nil, err
	}

	var resp QueueResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("failed to parse queue response: %w", err)
	}

	return resp.Records, nil
}

// SeriesExists checks if a series exists in Sonarr and whether it has downloaded episodes.
// Returns (exists, hasEpisodes, error).
func (s *SonarrClient) SeriesExists(ctx context.Context, tvdbID int) (exists bool, hasEpisodes bool, err error) {
	series, err := s.GetSeries(ctx, tvdbID)
	if err != nil {
		return false, false, err
	}
	if series == nil {
		return false, false, nil
	}
	hasEps := series.Statistics != nil && series.Statistics.EpisodeFileCount > 0
	return true, hasEps, nil
}
