package metadata

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

// TVDB V4 API base URL and image CDN.
const (
	tvdbBaseURL  = "https://api4.thetvdb.com/v4"
	tvdbImageURL = "https://artworks.thetvdb.com"
)

// TVDBClient wraps the TVDB V4 API.
// It handles bearer token authentication with automatic refresh.
type TVDBClient struct {
	apiKey   string
	pin      string // optional subscriber PIN
	language string

	httpClient *http.Client

	mu          sync.Mutex
	bearerToken string
	tokenExpiry time.Time
}

// NewTVDBClient creates a TVDB V4 API client.
// apiKey is required. pin is optional (for subscriber-supported keys).
func NewTVDBClient(apiKey, pin, language string) *TVDBClient {
	if language == "" {
		language = "eng" // TVDB uses 3-letter language codes
	}
	return &TVDBClient{
		apiKey:   apiKey,
		pin:      pin,
		language: language,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

// --- Authentication ---

type tvdbLoginRequest struct {
	APIKey string `json:"apikey"`
	PIN    string `json:"pin,omitempty"`
}

type tvdbLoginResponse struct {
	Status string `json:"status"`
	Data   struct {
		Token string `json:"token"`
	} `json:"data"`
}

// authenticate obtains or refreshes a bearer token.
// Tokens are valid for 1 month; we refresh 24h before expiry.
func (c *TVDBClient) authenticate(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Token still valid (with 24h buffer)
	if c.bearerToken != "" && time.Now().Before(c.tokenExpiry.Add(-24*time.Hour)) {
		return nil
	}

	body := tvdbLoginRequest{APIKey: c.apiKey}
	if c.pin != "" {
		body.PIN = c.pin
	}

	jsonBody, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal login: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", tvdbBaseURL+"/login", bytes.NewReader(jsonBody))
	if err != nil {
		return fmt.Errorf("create login request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("login request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("tvdb login failed (HTTP %d): %s", resp.StatusCode, string(respBody))
	}

	var loginResp tvdbLoginResponse
	if err := json.NewDecoder(resp.Body).Decode(&loginResp); err != nil {
		return fmt.Errorf("decode login response: %w", err)
	}

	if loginResp.Data.Token == "" {
		return fmt.Errorf("tvdb login returned empty token")
	}

	c.bearerToken = loginResp.Data.Token
	c.tokenExpiry = time.Now().Add(28 * 24 * time.Hour) // ~1 month
	slog.Debug("tvdb authenticated", "expires", c.tokenExpiry.Format(time.RFC3339))

	return nil
}

// --- HTTP helpers ---

// get performs an authenticated GET request with retry on 401 (expired token).
func (c *TVDBClient) get(ctx context.Context, path string, params url.Values) ([]byte, error) {
	if err := c.authenticate(ctx); err != nil {
		return nil, fmt.Errorf("authenticate: %w", err)
	}

	fullURL := tvdbBaseURL + path
	if len(params) > 0 {
		fullURL += "?" + params.Encode()
	}

	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, "GET", fullURL, nil)
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}

		c.mu.Lock()
		token := c.bearerToken
		c.mu.Unlock()

		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("request %s: %w", path, err)
		}

		body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()

		switch resp.StatusCode {
		case http.StatusOK:
			return body, nil
		case http.StatusUnauthorized:
			// Token expired — force re-auth and retry once
			if attempt == 0 {
				c.mu.Lock()
				c.bearerToken = ""
				c.tokenExpiry = time.Time{}
				c.mu.Unlock()
				if err := c.authenticate(ctx); err != nil {
					return nil, fmt.Errorf("re-authenticate: %w", err)
				}
				continue
			}
			return nil, fmt.Errorf("tvdb unauthorized after re-auth")
		case http.StatusNotFound:
			return nil, fmt.Errorf("tvdb not found: %s", path)
		case http.StatusTooManyRequests:
			// Respect Retry-After header if present, otherwise default to 2s
			wait := 2 * time.Second
			if ra := resp.Header.Get("Retry-After"); ra != "" {
				if secs, err := strconv.Atoi(ra); err == nil && secs > 0 && secs <= 30 {
					wait = time.Duration(secs) * time.Second
				}
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
			continue
		default:
			return nil, fmt.Errorf("tvdb HTTP %d: %s", resp.StatusCode, string(body))
		}
	}
	return nil, fmt.Errorf("tvdb request failed after retries: %s", path)
}

// --- Response envelope ---

type tvdbResponse[T any] struct {
	Status string `json:"status"`
	Data   T      `json:"data"`
}

// --- Search ---

// TVDBSearchResult represents a single search result from TVDB's /search endpoint.
type TVDBSearchResult struct {
	ObjectID      string  `json:"objectID"`
	Name          string  `json:"name"`
	Slug          string  `json:"slug"`
	Overview      string  `json:"overview"`
	Type          string  `json:"type"` // "series", "movie", "person", "company"
	TVDBId        string  `json:"tvdb_id"`
	Year          string  `json:"year"`
	ImageURL      string  `json:"image_url"`
	PrimaryType   string  `json:"primary_type"`
	Status        string  `json:"status"`
	Country       string  `json:"country"`
	Network       string  `json:"network"`
	RemoteIDs     []tvdbRemoteID `json:"remote_ids,omitempty"`
	Translations  map[string]string `json:"translations,omitempty"`
}

type tvdbRemoteID struct {
	ID         string `json:"id"`
	Type       int    `json:"type"`
	SourceName string `json:"sourceName"`
}

// ParseID extracts the numeric TVDB ID from the search result.
func (r TVDBSearchResult) ParseID() int {
	id, _ := strconv.Atoi(r.TVDBId)
	return id
}

// ParseYear extracts the 4-digit year.
func (r TVDBSearchResult) ParseYear() int {
	if len(r.Year) >= 4 {
		y, _ := strconv.Atoi(r.Year[:4])
		return y
	}
	return 0
}

// GetIMDbID extracts the IMDB ID from remote_ids if present.
func (r TVDBSearchResult) GetIMDbID() string {
	for _, rid := range r.RemoteIDs {
		if rid.SourceName == "IMDB" || rid.SourceName == "imdb" {
			return rid.ID
		}
	}
	return ""
}

// SearchSeries searches TVDB for TV series matching the given query.
func (c *TVDBClient) SearchSeries(ctx context.Context, query string, year int) ([]TVDBSearchResult, error) {
	params := url.Values{
		"query": {query},
		"type":  {"series"},
		"limit": {"10"},
	}
	if year > 0 {
		params.Set("year", strconv.Itoa(year))
	}

	body, err := c.get(ctx, "/search", params)
	if err != nil {
		return nil, fmt.Errorf("search series: %w", err)
	}

	var resp tvdbResponse[[]TVDBSearchResult]
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode search: %w", err)
	}

	return resp.Data, nil
}

// --- Series Detail ---

// TVDBSeriesExtended represents the extended series record.
type TVDBSeriesExtended struct {
	ID               int               `json:"id"`
	Name             string            `json:"name"`
	Slug             string            `json:"slug"`
	Overview         string            `json:"overview"`
	Image            string            `json:"image"`
	FirstAired       string            `json:"firstAired"`
	LastAired        string            `json:"lastAired"`
	Status           *tvdbStatus       `json:"status"`
	OriginalLanguage string            `json:"originalLanguage"`
	Score            int               `json:"score"`
	Year             string            `json:"year"`
	AverageRuntime   int               `json:"averageRuntime"`
	Genres           []tvdbGenre       `json:"genres"`
	Seasons          []TVDBSeason      `json:"seasons"`
	Characters       []tvdbCharacter   `json:"characters"`
	Artworks         []TVDBArtwork     `json:"artworks"`
	RemoteIDs        []tvdbRemoteID    `json:"remoteIds"`
	ContentRatings   []tvdbContentRating `json:"contentRatings"`
	OriginalNetwork  *tvdbCompany      `json:"originalNetwork"`
}

type tvdbStatus struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type tvdbGenre struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type tvdbCharacter struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	PeopleID    int    `json:"peopleId"`
	PersonName  string `json:"personName"`
	PeopleType  string `json:"peopleType"`
	Image       string `json:"image"`
	Sort        int    `json:"sort"`
	Type        int    `json:"type"`
	URL         string `json:"url"`
	PersonImgURL string `json:"personImgURL"`
}

type tvdbContentRating struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	Country     string `json:"country"`
	ContentType string `json:"contentType"`
}

type tvdbCompany struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	Country string `json:"country"`
}

// TVDBSeason represents a season within an extended series record.
type TVDBSeason struct {
	ID           int       `json:"id"`
	Number       int       `json:"number"`
	Name         string    `json:"name"`
	Image        string    `json:"image"`
	Type         *tvdbSeasonType `json:"type"`
}

type tvdbSeasonType struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"` // "official", "dvd", "absolute", etc.
}

// TVDBArtwork represents a single artwork record.
type TVDBArtwork struct {
	ID         int    `json:"id"`
	Image      string `json:"image"`
	Thumbnail  string `json:"thumbnail"`
	Language   string `json:"language"`
	Type       int    `json:"type"`
	Score      int    `json:"score"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

// TVDB artwork type constants (from /artwork/types).
const (
	TVDBArtBanner        = 1
	TVDBArtPoster        = 2
	TVDBArtBackground    = 3
	TVDBArtIcon          = 5
	TVDBArtClearArt      = 6
	TVDBArtClearLogo     = 7
	TVDBArtSeasonPoster  = 8
	TVDBArtSeasonBanner  = 9
)

// TVDBEpisode represents an episode from the series episodes endpoint.
type TVDBEpisode struct {
	ID              int     `json:"id"`
	SeriesID        int     `json:"seriesId"`
	Name            string  `json:"name"`
	Overview        string  `json:"overview"`
	Image           string  `json:"image"`
	SeasonNumber    int     `json:"seasonNumber"`
	Number          int     `json:"number"` // episode number within season
	AiredDate       string  `json:"aired"`
	Runtime         int     `json:"runtime"`
	Year            string  `json:"year"`
	IsMovie         int     `json:"isMovie"`
}

// GetSeriesExtended fetches full series detail including seasons, characters, artwork.
func (c *TVDBClient) GetSeriesExtended(ctx context.Context, tvdbID int) (*TVDBSeriesExtended, error) {
	body, err := c.get(ctx, fmt.Sprintf("/series/%d/extended", tvdbID), nil)
	if err != nil {
		return nil, fmt.Errorf("get series extended: %w", err)
	}

	var resp tvdbResponse[TVDBSeriesExtended]
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode series: %w", err)
	}

	return &resp.Data, nil
}

// GetSeriesEpisodes fetches episodes for a series using the default season ordering.
// Returns all episodes across all pages.
func (c *TVDBClient) GetSeriesEpisodes(ctx context.Context, tvdbID int) ([]TVDBEpisode, error) {
	var allEpisodes []TVDBEpisode

	for page := 0; page < 50; page++ { // safety limit
		params := url.Values{"page": {strconv.Itoa(page)}}
		body, err := c.get(ctx, fmt.Sprintf("/series/%d/episodes/default", tvdbID), params)
		if err != nil {
			if page > 0 {
				break // we got some episodes, stop paginating
			}
			return nil, fmt.Errorf("get series episodes page %d: %w", page, err)
		}

		var resp struct {
			Status string `json:"status"`
			Data   struct {
				Episodes []TVDBEpisode `json:"episodes"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			return nil, fmt.Errorf("decode episodes page %d: %w", page, err)
		}

		if len(resp.Data.Episodes) == 0 {
			break
		}
		allEpisodes = append(allEpisodes, resp.Data.Episodes...)
	}

	return allEpisodes, nil
}

// --- Helper: extract fields for enricher ---

// ParseYear extracts 4-digit year from series.
func (s *TVDBSeriesExtended) ParseYear() int {
	if len(s.Year) >= 4 {
		y, _ := strconv.Atoi(s.Year[:4])
		return y
	}
	if len(s.FirstAired) >= 4 {
		y, _ := strconv.Atoi(s.FirstAired[:4])
		return y
	}
	return 0
}

// GetIMDbID extracts the IMDb ID from remote IDs.
func (s *TVDBSeriesExtended) GetIMDbID() string {
	for _, rid := range s.RemoteIDs {
		if rid.SourceName == "IMDB" || rid.SourceName == "imdb" {
			return rid.ID
		}
	}
	return ""
}

// GetTMDBID extracts the TMDB ID from remote IDs.
func (s *TVDBSeriesExtended) GetTMDBID() int {
	for _, rid := range s.RemoteIDs {
		if rid.SourceName == "TheMovieDB.com" || rid.SourceName == "TMDB" {
			id, _ := strconv.Atoi(rid.ID)
			return id
		}
	}
	return 0
}

// GetUSContentRating returns the US content rating (e.g., "TV-14", "TV-MA").
func (s *TVDBSeriesExtended) GetUSContentRating() string {
	for _, cr := range s.ContentRatings {
		if cr.Country == "usa" || cr.Country == "US" {
			return cr.Name
		}
	}
	return ""
}

// StatusName returns the series status as a string.
func (s *TVDBSeriesExtended) StatusName() string {
	if s.Status != nil {
		return s.Status.Name
	}
	return ""
}

// GenreNames returns genre names as a string slice.
func (s *TVDBSeriesExtended) GenreNames() []string {
	names := make([]string, len(s.Genres))
	for i, g := range s.Genres {
		names[i] = g.Name
	}
	return names
}

// AiredSeasons returns only "Aired Order" seasons, filtering out DVD/absolute/etc.
func (s *TVDBSeriesExtended) AiredSeasons() []TVDBSeason {
	var aired []TVDBSeason
	for _, season := range s.Seasons {
		if season.Type == nil || season.Type.Type == "official" || season.Type.Name == "Aired Order" {
			aired = append(aired, season)
		}
	}
	return aired
}
