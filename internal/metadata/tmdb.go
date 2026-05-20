package metadata

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	tmdbBaseURL  = "https://api.themoviedb.org/3"
	tmdbImageURL = "https://image.tmdb.org/t/p"

	// tmdbMaxDecompressedBytes caps the gunzipped TMDB response size.
	// Real TMDB JSON responses are tens of KB; 16 MiB matches the
	// raw-body cap below and is two orders of magnitude over any
	// realistic payload. The gunzip helper detects overflow rather
	// than silently truncating — see defensiveGunzip.
	tmdbMaxDecompressedBytes = 16 << 20

	// Rate limiting: TMDB allows ~40 req/10s
	tmdbRateLimit    = 35
	tmdbRateInterval = 10 * time.Second
)

// Image size presets matching TMDB CDN paths
const (
	PosterSmall    = "w185"
	PosterMedium   = "w342"
	PosterLarge    = "w500"
	PosterOriginal = "original"

	BackdropSmall    = "w300"
	BackdropMedium   = "w780"
	BackdropLarge    = "w1280"
	BackdropOriginal = "original"

	ProfileMedium   = "w185"
	ProfileOriginal = "original"

	StillMedium   = "w300"
	StillOriginal = "original"
)

// TMDBClient wraps the TMDB v3 API.
type TMDBClient struct {
	apiKey     string
	language   string // ISO 639-1 language code, e.g. "en", "de", "ja"
	httpClient *http.Client

	// Token-bucket rate limiter
	mu        sync.Mutex
	tokens    int
	lastReset time.Time
}

// NewTMDBClient creates a client. apiKey is required (v3 API key, not a bearer token).
// language is the preferred metadata language (ISO 639-1), defaults to "en" if empty.
func NewTMDBClient(apiKey, language string) *TMDBClient {
	if language == "" {
		language = "en"
	}
	return &TMDBClient{
		apiKey:   apiKey,
		language: language,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
		tokens:    tmdbRateLimit,
		lastReset: time.Now(),
	}
}

// --- Rate Limiting ---

func (c *TMDBClient) waitForToken(ctx context.Context) error {
	for {
		c.mu.Lock()
		now := time.Now()
		if now.Sub(c.lastReset) >= tmdbRateInterval {
			c.tokens = tmdbRateLimit
			c.lastReset = now
		}
		if c.tokens > 0 {
			c.tokens--
			c.mu.Unlock()
			return nil
		}
		wait := tmdbRateInterval - now.Sub(c.lastReset)
		c.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

// --- HTTP Helpers ---

// maxRetries is the number of retries for transient TMDB failures.
const maxRetries = 3

func (c *TMDBClient) get(ctx context.Context, path string, params url.Values) ([]byte, error) {
	if params == nil {
		params = url.Values{}
	}
	params.Set("api_key", c.apiKey)

	// Inject language if not already set by caller
	if params.Get("language") == "" && c.language != "" {
		params.Set("language", c.language)
	}

	reqURL := fmt.Sprintf("%s%s?%s", tmdbBaseURL, path, params.Encode())

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			// Exponential backoff: 1s, 2s, 4s
			backoff := time.Duration(1<<(attempt-1)) * time.Second
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}

		if err := c.waitForToken(ctx); err != nil {
			return nil, fmt.Errorf("rate limit wait: %w", err)
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		req.Header.Set("Accept", "application/json")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("tmdb request: %w", err)
			slog.Debug("tmdb request failed, retrying", "attempt", attempt+1, "error", err)
			continue // network error — retry
		}

		// Read with a size cap (16MB) to prevent memory abuse from malformed responses
		body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if err != nil {
			lastErr = fmt.Errorf("read response: %w", err)
			continue
		}

		// Defensive gzip handling.
		//
		// 2026-05-20 — observed in production: TMDB occasionally
		// returns a gzip-compressed body WITHOUT the matching
		// `Content-Encoding: gzip` response header. Without that
		// header, Go's http.Transport doesn't auto-decompress, so
		// we read raw gzip bytes and json.Unmarshal chokes on the
		// `\x1f` magic byte ("invalid character '\\x1f' looking
		// for beginning of value"). One refresh in ~100 fails this
		// way; the next refresh of the same item usually succeeds.
		//
		// Strategy: when the body starts with the gzip magic
		// (0x1F 0x8B), gunzip ourselves with strict integrity
		// checks. If anything goes wrong, return a clean error
		// instead of feeding broken JSON to the caller — the
		// alternative was a confusing TWO-log-line incident (our
		// WARN + the caller's `invalid character '\x1f'` decode
		// error) per bad response.
		//
		// `body == nil` is safe: len(nil) == 0, so the >= 2 guard
		// short-circuits before any indexing.
		if bytes.HasPrefix(body, []byte{0x1F, 0x8B}) {
			gunzipped, ungzErr := defensiveGunzip(body, tmdbMaxDecompressedBytes)
			if ungzErr != nil {
				// Body was definitely gzip-prefixed and gunzip
				// failed — the bytes are not JSON either way.
				// Short-circuit with a clean error so the caller
				// doesn't try to json.Unmarshal random bytes.
				slog.Warn("tmdb: response started with gzip magic but gunzip failed",
					"path", path, "compressed_size", len(body), "error", ungzErr)
				lastErr = fmt.Errorf("tmdb: gunzip failed for missing-Content-Encoding response: %w", ungzErr)
				continue // retry — next attempt may get a clean body
			}
			slog.Debug("tmdb: gunzipped body missing Content-Encoding header",
				"path", path, "compressed_size", len(body), "decompressed_size", len(gunzipped))
			body = gunzipped
		}

		switch {
		case resp.StatusCode == http.StatusOK:
			return body, nil
		case resp.StatusCode == http.StatusUnauthorized:
			return nil, fmt.Errorf("tmdb: invalid API key")
		case resp.StatusCode == http.StatusNotFound:
			return nil, fmt.Errorf("tmdb: not found (404) for %s", path)
		case resp.StatusCode == http.StatusTooManyRequests:
			// TMDB sends Retry-After header on 429
			lastErr = fmt.Errorf("tmdb rate limited (429)")
			slog.Debug("tmdb 429, backing off", "attempt", attempt+1)
			continue
		case resp.StatusCode >= 500:
			lastErr = fmt.Errorf("tmdb: server error HTTP %d", resp.StatusCode)
			slog.Debug("tmdb server error, retrying", "status", resp.StatusCode, "attempt", attempt+1)
			continue
		default:
			return nil, fmt.Errorf("tmdb: HTTP %d: %s", resp.StatusCode, string(body))
		}
	}

	return nil, fmt.Errorf("tmdb: all %d retries exhausted: %w", maxRetries+1, lastErr)
}

// --- Response Types ---

type TMDBSearchResult struct {
	Page         int           `json:"page"`
	TotalResults int           `json:"total_results"`
	TotalPages   int           `json:"total_pages"`
	Results      []TMDBMovieTV `json:"results"`
}

type TMDBMovieTV struct {
	ID               int      `json:"id"`
	Title            string   `json:"title"`             // Movies
	Name             string   `json:"name"`              // TV
	OriginalTitle    string   `json:"original_title"`    // Movies
	OriginalName     string   `json:"original_name"`     // TV
	Overview         string   `json:"overview"`
	ReleaseDate      string   `json:"release_date"`      // Movies: "2024-01-15"
	FirstAirDate     string   `json:"first_air_date"`    // TV
	PosterPath       *string  `json:"poster_path"`
	BackdropPath     *string  `json:"backdrop_path"`
	VoteAverage      float64  `json:"vote_average"`
	VoteCount        int      `json:"vote_count"`
	Popularity       float64  `json:"popularity"`
	GenreIDs         []int    `json:"genre_ids"`
	OriginalLanguage string   `json:"original_language"`
	MediaType        string   `json:"media_type"`        // "movie" or "tv" (multi search only)
	Adult            bool     `json:"adult"`
}

// DisplayTitle returns Title for movies, Name for TV.
func (t TMDBMovieTV) DisplayTitle() string {
	if t.Title != "" {
		return t.Title
	}
	return t.Name
}

// Year extracts the 4-digit year from release_date or first_air_date.
func (t TMDBMovieTV) Year() int {
	dateStr := t.ReleaseDate
	if dateStr == "" {
		dateStr = t.FirstAirDate
	}
	if len(dateStr) >= 4 {
		y, _ := strconv.Atoi(dateStr[:4])
		return y
	}
	return 0
}

type TMDBMovieDetail struct {
	TMDBMovieTV
	IMDbID        string          `json:"imdb_id"`
	Tagline       string          `json:"tagline"`
	Status        string          `json:"status"`
	Runtime       int             `json:"runtime"`
	Budget        int64           `json:"budget"`
	Revenue       int64           `json:"revenue"`
	Genres        []TMDBGenre     `json:"genres"`
	Credits       *TMDBCredits    `json:"credits,omitempty"`
	Images        *TMDBImages     `json:"images,omitempty"`
	ContentRating string          `json:"-"` // filled from release_dates
	ReleaseDates  *TMDBRelDates   `json:"release_dates,omitempty"`
}

type TMDBTVDetail struct {
	TMDBMovieTV
	Tagline         string          `json:"tagline"`
	Status          string          `json:"status"`
	Type            string          `json:"type"`
	NumberSeasons   int             `json:"number_of_seasons"`
	NumberEpisodes  int             `json:"number_of_episodes"`
	EpisodeRuntime  []int           `json:"episode_run_time"`
	Genres          []TMDBGenre     `json:"genres"`
	CreatedBy       []TMDBCreator   `json:"created_by"`
	Seasons         []TMDBSeason    `json:"seasons"`
	Credits         *TMDBCredits    `json:"credits,omitempty"`
	Images          *TMDBImages     `json:"images,omitempty"`
	ContentRatings  *TMDBContentRat `json:"content_ratings,omitempty"`
	ExternalIDs     *TMDBExtIDs     `json:"external_ids,omitempty"`
}

type TMDBSeason struct {
	ID           int     `json:"id"`
	SeasonNumber int     `json:"season_number"`
	Name         string  `json:"name"`
	Overview     string  `json:"overview"`
	PosterPath   *string `json:"poster_path"`
	AirDate      string  `json:"air_date"`
	EpisodeCount int     `json:"episode_count"`
	VoteAverage  float64 `json:"vote_average"`
}

type TMDBSeasonDetail struct {
	TMDBSeason
	Episodes []TMDBEpisode `json:"episodes"`
}

type TMDBEpisode struct {
	ID            int     `json:"id"`
	EpisodeNumber int     `json:"episode_number"`
	SeasonNumber  int     `json:"season_number"`
	Name          string  `json:"name"`
	Overview      string  `json:"overview"`
	AirDate       string  `json:"air_date"`
	StillPath     *string `json:"still_path"`
	VoteAverage   float64 `json:"vote_average"`
	VoteCount     int     `json:"vote_count"`
	Runtime       int     `json:"runtime"`
}

type TMDBGenre struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type TMDBCreator struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	ProfilePath *string `json:"profile_path"`
}

type TMDBCredits struct {
	Cast []TMDBCastMember `json:"cast"`
	Crew []TMDBCrewMember `json:"crew"`
}

type TMDBCastMember struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	Character   string  `json:"character"`
	ProfilePath *string `json:"profile_path"`
	Order       int     `json:"order"`
	KnownFor    string  `json:"known_for_department"`
}

type TMDBCrewMember struct {
	ID          int     `json:"id"`
	Name        string  `json:"name"`
	Job         string  `json:"job"`
	Department  string  `json:"department"`
	ProfilePath *string `json:"profile_path"`
	KnownFor    string  `json:"known_for_department"`
}

type TMDBImages struct {
	Backdrops []TMDBImage `json:"backdrops"`
	Posters   []TMDBImage `json:"posters"`
	Logos     []TMDBImage `json:"logos"`
	Stills    []TMDBImage `json:"stills"`
}

type TMDBImage struct {
	FilePath    string  `json:"file_path"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	VoteAverage float64 `json:"vote_average"`
	VoteCount   int     `json:"vote_count"`
	Lang        *string `json:"iso_639_1"`
}

type TMDBRelDates struct {
	Results []struct {
		Country      string `json:"iso_3166_1"`
		ReleaseDates []struct {
			Certification string `json:"certification"`
			Type          int    `json:"type"`
		} `json:"release_dates"`
	} `json:"results"`
}

type TMDBContentRat struct {
	Results []struct {
		Country string `json:"iso_3166_1"`
		Rating  string `json:"rating"`
	} `json:"results"`
}

type TMDBExtIDs struct {
	IMDB string `json:"imdb_id"`
	TVDB int    `json:"tvdb_id"`
}

// --- Search ---

// SearchMovies searches TMDB for movies by title. Year is optional (pass 0 to skip).
func (c *TMDBClient) SearchMovies(ctx context.Context, query string, year int) (*TMDBSearchResult, error) {
	params := url.Values{"query": {query}}
	if year > 0 {
		params.Set("year", strconv.Itoa(year))
	}
	body, err := c.get(ctx, "/search/movie", params)
	if err != nil {
		return nil, err
	}
	var result TMDBSearchResult
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("decode search results: %w", err)
	}
	return &result, nil
}

// SearchMulti searches TMDB across movies, TV shows, and people.
// Returns results with media_type set ("movie", "tv", or "person").
func (c *TMDBClient) SearchMulti(ctx context.Context, query string) (*TMDBSearchResult, error) {
	params := url.Values{"query": {query}}
	body, err := c.get(ctx, "/search/multi", params)
	if err != nil {
		return nil, err
	}
	var result TMDBSearchResult
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("decode search results: %w", err)
	}
	// Filter out "person" results — only keep movie and tv
	filtered := result.Results[:0]
	for _, r := range result.Results {
		if r.MediaType == "movie" || r.MediaType == "tv" {
			filtered = append(filtered, r)
		}
	}
	result.Results = filtered
	return &result, nil
}

// SearchTV searches TMDB for TV shows by name. Year is optional.
func (c *TMDBClient) SearchTV(ctx context.Context, query string, year int) (*TMDBSearchResult, error) {
	params := url.Values{"query": {query}}
	if year > 0 {
		params.Set("first_air_date_year", strconv.Itoa(year))
	}
	body, err := c.get(ctx, "/search/tv", params)
	if err != nil {
		return nil, err
	}
	var result TMDBSearchResult
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("decode search results: %w", err)
	}
	return &result, nil
}

// --- Movie Details ---

// GetMovie fetches full movie details including credits, images, and release dates.
func (c *TMDBClient) GetMovie(ctx context.Context, tmdbID int) (*TMDBMovieDetail, error) {
	imgLangs := "en,null"
	if c.language != "" && c.language != "en" {
		imgLangs = c.language + "," + imgLangs
	}
	params := url.Values{
		"append_to_response":    {"credits,images,release_dates"},
		"include_image_language": {imgLangs},
	}
	body, err := c.get(ctx, fmt.Sprintf("/movie/%d", tmdbID), params)
	if err != nil {
		return nil, err
	}
	var detail TMDBMovieDetail
	if err := json.Unmarshal(body, &detail); err != nil {
		return nil, fmt.Errorf("decode movie detail: %w", err)
	}

	// Extract US content rating from release_dates
	if detail.ReleaseDates != nil {
		for _, country := range detail.ReleaseDates.Results {
			if country.Country == "US" {
				for _, rd := range country.ReleaseDates {
					if rd.Certification != "" {
						detail.ContentRating = rd.Certification
						break
					}
				}
				break
			}
		}
	}

	return &detail, nil
}

// --- TV Details ---

// GetTV fetches full TV show details including credits, images, content ratings, and external IDs.
func (c *TMDBClient) GetTV(ctx context.Context, tmdbID int) (*TMDBTVDetail, error) {
	imgLangs := "en,null"
	if c.language != "" && c.language != "en" {
		imgLangs = c.language + "," + imgLangs
	}
	params := url.Values{
		"append_to_response":    {"credits,images,content_ratings,external_ids"},
		"include_image_language": {imgLangs},
	}
	body, err := c.get(ctx, fmt.Sprintf("/tv/%d", tmdbID), params)
	if err != nil {
		return nil, err
	}
	var detail TMDBTVDetail
	if err := json.Unmarshal(body, &detail); err != nil {
		return nil, fmt.Errorf("decode tv detail: %w", err)
	}
	return &detail, nil
}

// GetTVExternalIDs fetches just the external IDs (IMDB, TVDB) for a TV show.
// Cheaper than GetTV when only the cross-database mapping is needed — used as
// a fallback path when Sonarr's Skyhook cache lacks the TMDB→TVDB mapping.
func (c *TMDBClient) GetTVExternalIDs(ctx context.Context, tmdbID int) (*TMDBExtIDs, error) {
	body, err := c.get(ctx, fmt.Sprintf("/tv/%d/external_ids", tmdbID), nil)
	if err != nil {
		return nil, err
	}
	var ids TMDBExtIDs
	if err := json.Unmarshal(body, &ids); err != nil {
		return nil, fmt.Errorf("decode external_ids: %w", err)
	}
	return &ids, nil
}

// GetTVSeason fetches season detail with full episode list.
func (c *TMDBClient) GetTVSeason(ctx context.Context, tvID, seasonNum int) (*TMDBSeasonDetail, error) {
	body, err := c.get(ctx, fmt.Sprintf("/tv/%d/season/%d", tvID, seasonNum), nil)
	if err != nil {
		return nil, err
	}
	var detail TMDBSeasonDetail
	if err := json.Unmarshal(body, &detail); err != nil {
		return nil, fmt.Errorf("decode season detail: %w", err)
	}
	return &detail, nil
}

// --- Image URL Helper ---

// ImageURL constructs a full TMDB image CDN URL.
// size should be one of the constants like PosterMedium, BackdropLarge, etc.
func ImageURL(path string, size string) string {
	if path == "" {
		return ""
	}
	return fmt.Sprintf("%s/%s%s", tmdbImageURL, size, path)
}

// --- Changes API (smart diffing) ---

// TMDBChanges is the response from /movie/{id}/changes or /tv/{id}/changes.
type TMDBChanges struct {
	Changes []struct {
		Key   string `json:"key"`
		Items []struct {
			ID     string `json:"id"`
			Action string `json:"action"`
		} `json:"items"`
	} `json:"changes"`
}

// HasMovieChanged checks if a movie has TMDB changes since the given date.
// Returns true if changes exist or if we can't determine (fail-open).
func (c *TMDBClient) HasMovieChanged(ctx context.Context, tmdbID int, since time.Time) bool {
	return c.hasChanged(ctx, fmt.Sprintf("/movie/%d/changes", tmdbID), since)
}

// HasTVChanged checks if a TV show has TMDB changes since the given date.
func (c *TMDBClient) HasTVChanged(ctx context.Context, tmdbID int, since time.Time) bool {
	return c.hasChanged(ctx, fmt.Sprintf("/tv/%d/changes", tmdbID), since)
}

func (c *TMDBClient) hasChanged(ctx context.Context, path string, since time.Time) bool {
	params := url.Values{
		"start_date": {since.Format("2006-01-02")},
		"end_date":   {time.Now().Format("2006-01-02")},
	}
	body, err := c.get(ctx, path, params)
	if err != nil {
		return true // fail-open: assume changed if we can't check
	}
	var changes TMDBChanges
	if err := json.Unmarshal(body, &changes); err != nil {
		return true
	}
	return len(changes.Changes) > 0
}

// --- Matching Logic ---

// MatchConfidence computes a simple confidence score (0-100) for whether
// a TMDB result matches a scanned media item.
func MatchConfidence(scannedTitle string, scannedYear int, result TMDBMovieTV) int {
	score := 0

	// Title matching: normalize both sides to strip articles/punctuation before scoring
	resultTitle := result.DisplayTitle()
	normScanned := normalizeForMatching(scannedTitle)
	normResult := normalizeForMatching(resultTitle)
	if normScanned == normResult {
		score += 60
	} else {
		sim := levenshteinSimilarity(normScanned, normResult)
		switch {
		case sim > 0.8:
			score += 50
		case sim > 0.6:
			score += 30
		case sim > 0.4:
			score += 15
		case strings.Contains(normResult, normScanned) || strings.Contains(normScanned, normResult):
			score += 15
		}
	}

	// Year match
	resultYear := result.Year()
	if scannedYear > 0 && resultYear > 0 {
		diff := scannedYear - resultYear
		if diff < 0 {
			diff = -diff
		}
		switch {
		case diff == 0:
			score += 30
		case diff == 1:
			score += 15
		case diff <= 3:
			score += 5
		}
	}

	// Popularity bonus (well-known titles are more likely correct)
	if result.Popularity > 50 {
		score += 5
	}
	if result.VoteCount > 100 {
		score += 5
	}

	if score > 100 {
		score = 100
	}
	return score
}

// BestMatch returns the highest-confidence result, or nil if no result
// meets minThreshold. Pass the configured review threshold as minThreshold.
func BestMatch(scannedTitle string, scannedYear int, results []TMDBMovieTV, minThreshold int) (*TMDBMovieTV, int) {
	var best *TMDBMovieTV
	bestScore := 0

	for i := range results {
		score := MatchConfidence(scannedTitle, scannedYear, results[i])
		if score > bestScore {
			bestScore = score
			r := results[i]
			best = &r
		}
	}

	if bestScore < minThreshold {
		return nil, bestScore
	}
	return best, bestScore
}

// defensiveGunzip decompresses body up to maxBytes, returning the
// decompressed bytes or an explicit error describing what went wrong.
//
// 2026-05-20 audit follow-up (a2fc538) — the original gunzip block
// used io.LimitReader, which silently truncates at the cap and lets
// json.Unmarshal fail mid-document with a confusing
// "unexpected end of JSON input" error. Worse, gzip.Reader.Close()
// was discarded — that's where Go validates the CRC-32 and size
// trailer. A truncated gzip whose body length happens to land at
// a JSON syntactic boundary would have slipped through as "valid".
//
// This helper:
//   - reads maxBytes+1 to detect overflow explicitly
//   - propagates io.ReadAll errors (decode mid-stream failures)
//   - propagates gz.Close() errors (CRC / size-trailer mismatch)
//
// Returns the decompressed bytes only if every layer passes.
func defensiveGunzip(body []byte, maxBytes int64) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("gzip.NewReader: %w", err)
	}
	// Read maxBytes+1 so we can detect overflow vs. clean EOF.
	out, readErr := io.ReadAll(io.LimitReader(gz, maxBytes+1))
	closeErr := gz.Close()
	if readErr != nil {
		return nil, fmt.Errorf("gzip read: %w", readErr)
	}
	if int64(len(out)) > maxBytes {
		return nil, fmt.Errorf("gzip output exceeds %d byte cap (decompression bomb or runaway response)", maxBytes)
	}
	// Close error surfaces CRC-32 / size-trailer mismatches that
	// io.ReadAll alone won't catch. Treating it as fatal means a
	// truncated gzip stream can't accidentally produce
	// "valid-looking" JSON that's missing fields.
	if closeErr != nil {
		return nil, fmt.Errorf("gzip close (corrupt stream): %w", closeErr)
	}
	return out, nil
}
