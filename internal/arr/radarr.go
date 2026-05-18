package arr

import (
	"context"
	"encoding/json"
	"fmt"
)

// RadarrClient is a client for the Radarr v3 API.
// It embeds the base Client for shared HTTP functionality.
type RadarrClient struct {
	*Client
}

// NewRadarrClient creates a new Radarr API client.
func NewRadarrClient(baseURL, apiKey string) *RadarrClient {
	return &RadarrClient{
		Client: NewClient(baseURL, apiKey),
	}
}

// TestConnection tests the connection to Radarr by hitting /api/v3/system/status.
func (r *RadarrClient) TestConnection(ctx context.Context) error {
	if !r.IsConfigured() {
		return fmt.Errorf("Radarr is not configured")
	}

	if err := r.ValidateURL(); err != nil {
		return err
	}

	_, err := r.Get(ctx, "/api/v3/system/status")
	if err != nil {
		return fmt.Errorf("failed to connect to Radarr: %w", err)
	}

	return nil
}

// GetRootFolders returns the root folders configured in Radarr.
func (r *RadarrClient) GetRootFolders(ctx context.Context) ([]RootFolder, error) {
	if !r.IsConfigured() {
		return nil, fmt.Errorf("Radarr is not configured")
	}

	data, err := r.Get(ctx, "/api/v3/rootfolder")
	if err != nil {
		return nil, err
	}

	var folders []RootFolder
	if err := json.Unmarshal(data, &folders); err != nil {
		return nil, fmt.Errorf("failed to parse root folders: %w", err)
	}

	return folders, nil
}

// GetQualityProfiles returns the quality profiles configured in Radarr.
func (r *RadarrClient) GetQualityProfiles(ctx context.Context) ([]QualityProfile, error) {
	if !r.IsConfigured() {
		return nil, fmt.Errorf("Radarr is not configured")
	}

	data, err := r.Get(ctx, "/api/v3/qualityprofile")
	if err != nil {
		return nil, err
	}

	var profiles []QualityProfile
	if err := json.Unmarshal(data, &profiles); err != nil {
		return nil, fmt.Errorf("failed to parse quality profiles: %w", err)
	}

	return profiles, nil
}

// RadarrMovie represents a movie in Radarr's API.
type RadarrMovie struct {
	ID                  int               `json:"id,omitempty"`
	Title               string            `json:"title"`
	TmdbID              int               `json:"tmdbId"`
	Year                int               `json:"year,omitempty"`
	QualityProfileID    int               `json:"qualityProfileId"`
	RootFolderPath      string            `json:"rootFolderPath"`
	Path                string            `json:"path,omitempty"`
	Monitored           bool              `json:"monitored"`
	AddOptions          *RadarrAddOptions `json:"addOptions,omitempty"`
	HasFile             bool              `json:"hasFile,omitempty"`
	MinimumAvailability string            `json:"minimumAvailability,omitempty"`
}

// RadarrAddOptions represents options when adding a movie to Radarr.
type RadarrAddOptions struct {
	SearchForMovie bool `json:"searchForMovie"`
}

// AddMovie adds a movie to Radarr for automated downloading.
// It sets monitored=true, minimumAvailability="announced", and searchForMovie=true
// so Radarr immediately begins searching for the movie.
func (r *RadarrClient) AddMovie(ctx context.Context, tmdbID int, title string, year int, qualityProfileID int, rootFolderPath string) (*RadarrMovie, error) {
	if !r.IsConfigured() {
		return nil, fmt.Errorf("Radarr is not configured")
	}

	movie := RadarrMovie{
		Title:               title,
		TmdbID:              tmdbID,
		Year:                year,
		QualityProfileID:    qualityProfileID,
		RootFolderPath:      rootFolderPath,
		Monitored:           true,
		MinimumAvailability: "announced",
		AddOptions: &RadarrAddOptions{
			SearchForMovie: true,
		},
	}

	data, err := r.Post(ctx, "/api/v3/movie", movie)
	if err != nil {
		return nil, err
	}

	var result RadarrMovie
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse movie response: %w", err)
	}

	return &result, nil
}

// GetMovie retrieves a movie from Radarr by its TMDB ID.
// Returns nil if the movie is not found in Radarr.
func (r *RadarrClient) GetMovie(ctx context.Context, tmdbID int) (*RadarrMovie, error) {
	if !r.IsConfigured() {
		return nil, fmt.Errorf("Radarr is not configured")
	}

	data, err := r.Get(ctx, fmt.Sprintf("/api/v3/movie?tmdbId=%d", tmdbID))
	if err != nil {
		return nil, err
	}

	var movies []RadarrMovie
	if err := json.Unmarshal(data, &movies); err != nil {
		return nil, fmt.Errorf("failed to parse movie response: %w", err)
	}

	// Find the exact TMDB ID match — the API can return loosely related results.
	for i := range movies {
		if movies[i].TmdbID == tmdbID {
			return &movies[i], nil
		}
	}

	return nil, nil
}

// GetQueue fetches the current download queue from Radarr.
func (r *RadarrClient) GetQueue(ctx context.Context) ([]QueueItem, error) {
	if !r.IsConfigured() {
		return nil, fmt.Errorf("Radarr is not configured")
	}

	data, err := r.Get(ctx, "/api/v3/queue?page=1&pageSize=200&includeUnknownMovieItems=false")
	if err != nil {
		return nil, err
	}

	var resp QueueResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("failed to parse queue response: %w", err)
	}

	return resp.Records, nil
}

// MovieExists checks if a movie exists in Radarr and whether its file has been downloaded.
// Returns (exists, hasFile, error).
func (r *RadarrClient) MovieExists(ctx context.Context, tmdbID int) (exists bool, hasFile bool, err error) {
	movie, err := r.GetMovie(ctx, tmdbID)
	if err != nil {
		return false, false, err
	}
	if movie == nil {
		return false, false, nil
	}
	return true, movie.HasFile, nil
}
