// Package arr provides HTTP clients for interacting with Radarr and Sonarr APIs.
// These clients are used by the Requests feature to forward media requests
// to ARR services for automated downloading and library management.
package arr

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is a base HTTP client for ARR services (Radarr/Sonarr).
// It handles authentication via X-Api-Key header, JSON serialization,
// and provides convenience Get/Post methods.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// NewClient creates a new ARR base client.
// The baseURL has its trailing slash stripped and http:// is auto-added if no scheme is present.
// Timeout is 30 seconds — ARR services run on the local network and should respond quickly.
func NewClient(baseURL, apiKey string) *Client {
	baseURL = strings.TrimRight(baseURL, "/")

	if baseURL != "" && !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		baseURL = "http://" + baseURL
	}

	return &Client{
		baseURL: baseURL,
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// IsConfigured returns true if the client has both URL and API key set.
func (c *Client) IsConfigured() bool {
	return c.baseURL != "" && c.apiKey != ""
}

// ValidateURL checks that the configured URL is a valid http/https URL with a host.
func (c *Client) ValidateURL() error {
	if c.baseURL == "" {
		return fmt.Errorf("URL is not configured")
	}

	parsedURL, err := url.Parse(c.baseURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return fmt.Errorf("URL must use http or https scheme")
	}

	if parsedURL.Host == "" {
		return fmt.Errorf("URL must have a valid host")
	}

	return nil
}

// doRequest performs an HTTP request to the ARR API.
// It sets X-Api-Key, Content-Type, and Accept headers automatically.
// Returns the raw response body bytes or an error for non-2xx status codes.
func (c *Client) doRequest(ctx context.Context, method, path string, body interface{}) ([]byte, error) {
	reqURL := c.baseURL + path

	var reqBody io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		reqBody = bytes.NewBuffer(jsonBody)
	}

	req, err := http.NewRequestWithContext(ctx, method, reqURL, reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("X-Api-Key", c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	// Limit response body to 10MB to guard against unexpectedly large responses.
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("API error (status %d): %s", resp.StatusCode, string(respBody))
	}

	return respBody, nil
}

// Get performs a GET request to the given path on the ARR API.
func (c *Client) Get(ctx context.Context, path string) ([]byte, error) {
	return c.doRequest(ctx, http.MethodGet, path, nil)
}

// Post performs a POST request to the given path on the ARR API.
func (c *Client) Post(ctx context.Context, path string, body interface{}) ([]byte, error) {
	return c.doRequest(ctx, http.MethodPost, path, body)
}

// RootFolder represents a root folder configured in an ARR service.
type RootFolder struct {
	ID   int    `json:"id"`
	Path string `json:"path"`
}

// QualityProfile represents a quality profile configured in an ARR service.
type QualityProfile struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// SystemStatus represents the system status response from an ARR service.
type SystemStatus struct {
	Version string `json:"version"`
}

// QueueItem represents a single item in a Radarr/Sonarr download queue.
type QueueItem struct {
	ID                    int     `json:"id"`
	MovieID               int     `json:"movieId,omitempty"`
	SeriesID              int     `json:"seriesId,omitempty"`
	Title                 string  `json:"title"`
	Status                string  `json:"status"`
	TrackedDownloadStatus string  `json:"trackedDownloadStatus"`
	TrackedDownloadState  string  `json:"trackedDownloadState"`
	Protocol              string  `json:"protocol"`
	Size                  float64 `json:"size"`
	Sizeleft              float64 `json:"sizeleft"`
	Timeleft              string  `json:"timeleft"`
}

// QueueResponse is the paginated response from the /api/v3/queue endpoint.
type QueueResponse struct {
	Page         int         `json:"page"`
	PageSize     int         `json:"pageSize"`
	TotalRecords int         `json:"totalRecords"`
	Records      []QueueItem `json:"records"`
}
