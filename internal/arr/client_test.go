package arr

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// newTestServer creates an httptest server with a mux for registering handlers.
// Returns the server and a mux for attaching handlers.
func newTestServer(t *testing.T) (*httptest.Server, *http.ServeMux) {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, mux
}

// mustJSON marshals v to JSON, failing the test on error.
func mustJSON(t *testing.T, v interface{}) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return b
}

// ============================================================
// Base Client Tests
// ============================================================

func TestNewClient_TrimsTrailingSlash(t *testing.T) {
	c := NewClient("http://localhost:7878/", "key")
	if strings.HasSuffix(c.baseURL, "/") {
		t.Errorf("baseURL should not end with slash, got %q", c.baseURL)
	}
}

func TestNewClient_AutoAddsScheme(t *testing.T) {
	c := NewClient("localhost:7878", "key")
	if !strings.HasPrefix(c.baseURL, "http://") {
		t.Errorf("baseURL should start with http://, got %q", c.baseURL)
	}
}

func TestIsConfigured(t *testing.T) {
	tests := []struct {
		name   string
		url    string
		key    string
		want   bool
	}{
		{"both set", "http://localhost:7878", "key123", true},
		{"no url", "", "key123", false},
		{"no key", "http://localhost:7878", "", false},
		{"both empty", "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewClient(tt.url, tt.key)
			got := c.IsConfigured()
			if got != tt.want {
				t.Errorf("IsConfigured() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestValidateURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{"valid http", "http://localhost:7878", false},
		{"valid https", "https://radarr.example.com", false},
		{"empty", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewClient(tt.url, "key")
			err := c.ValidateURL()
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateURL() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestDoRequest_SetsApiKeyHeader(t *testing.T) {
	srv, mux := newTestServer(t)
	apiKey := "test-api-key-12345"

	mux.HandleFunc("/api/v3/system/status", func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Api-Key")
		if got != apiKey {
			t.Errorf("X-Api-Key = %q, want %q", got, apiKey)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"version":"4.0.0"}`))
	})

	c := NewClient(srv.URL, apiKey)
	_, err := c.Get(context.Background(), "/api/v3/system/status")
	if err != nil {
		t.Fatalf("Get() error: %v", err)
	}
}

func TestDoRequest_ReturnsErrorForNon2xx(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/fail", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error": "something broke"}`))
	})

	c := NewClient(srv.URL, "key")
	_, err := c.Get(context.Background(), "/api/v3/fail")
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Errorf("error should contain status code 500, got: %v", err)
	}
}

// ============================================================
// Radarr Tests
// ============================================================

func TestRadarrTestConnection_Success(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/system/status", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, SystemStatus{Version: "5.2.0"}))
	})

	rc := NewRadarrClient(srv.URL, "key")
	err := rc.TestConnection(context.Background())
	if err != nil {
		t.Fatalf("TestConnection() error: %v", err)
	}
}

func TestRadarrTestConnection_NotConfigured(t *testing.T) {
	rc := NewRadarrClient("", "")
	err := rc.TestConnection(context.Background())
	if err == nil {
		t.Fatal("expected error for unconfigured client")
	}
}

func TestRadarrTestConnection_Failure(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/system/status", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error": "unauthorized"}`))
	})

	rc := NewRadarrClient(srv.URL, "bad-key")
	err := rc.TestConnection(context.Background())
	if err == nil {
		t.Fatal("expected error for failed connection")
	}
}

func TestRadarrAddMovie(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/movie", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var movie RadarrMovie
		if err := json.NewDecoder(r.Body).Decode(&movie); err != nil {
			t.Fatalf("decode body: %v", err)
		}

		if movie.TmdbID != 12345 {
			t.Errorf("TmdbID = %d, want 12345", movie.TmdbID)
		}
		if movie.Title != "Test Movie" {
			t.Errorf("Title = %q, want %q", movie.Title, "Test Movie")
		}
		if !movie.Monitored {
			t.Error("Monitored should be true")
		}
		if movie.AddOptions == nil || !movie.AddOptions.SearchForMovie {
			t.Error("SearchForMovie should be true")
		}

		movie.ID = 42
		w.WriteHeader(http.StatusCreated)
		w.Write(mustJSON(t, movie))
	})

	rc := NewRadarrClient(srv.URL, "key")
	result, err := rc.AddMovie(context.Background(), 12345, "Test Movie", 2024, 1, "/movies")
	if err != nil {
		t.Fatalf("AddMovie() error: %v", err)
	}
	if result.ID != 42 {
		t.Errorf("result.ID = %d, want 42", result.ID)
	}
}

func TestRadarrGetMovie_Found(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/movie", func(w http.ResponseWriter, r *http.Request) {
		tmdbID := r.URL.Query().Get("tmdbId")
		if tmdbID != "550" {
			t.Errorf("tmdbId = %q, want %q", tmdbID, "550")
		}
		w.Write(mustJSON(t, []RadarrMovie{
			{ID: 1, Title: "Fight Club", TmdbID: 550, HasFile: true},
		}))
	})

	rc := NewRadarrClient(srv.URL, "key")
	movie, err := rc.GetMovie(context.Background(), 550)
	if err != nil {
		t.Fatalf("GetMovie() error: %v", err)
	}
	if movie == nil {
		t.Fatal("expected movie, got nil")
	}
	if movie.Title != "Fight Club" {
		t.Errorf("Title = %q, want %q", movie.Title, "Fight Club")
	}
}

func TestRadarrGetMovie_NotFound(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/movie", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	})

	rc := NewRadarrClient(srv.URL, "key")
	movie, err := rc.GetMovie(context.Background(), 99999)
	if err != nil {
		t.Fatalf("GetMovie() error: %v", err)
	}
	if movie != nil {
		t.Errorf("expected nil movie, got %+v", movie)
	}
}

func TestRadarrMovieExists(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/movie", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, []RadarrMovie{
			{ID: 1, TmdbID: 550, HasFile: true},
		}))
	})

	rc := NewRadarrClient(srv.URL, "key")
	exists, hasFile, err := rc.MovieExists(context.Background(), 550)
	if err != nil {
		t.Fatalf("MovieExists() error: %v", err)
	}
	if !exists {
		t.Error("exists should be true")
	}
	if !hasFile {
		t.Error("hasFile should be true")
	}
}

func TestRadarrMovieExists_NotFound(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/movie", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	})

	rc := NewRadarrClient(srv.URL, "key")
	exists, hasFile, err := rc.MovieExists(context.Background(), 99999)
	if err != nil {
		t.Fatalf("MovieExists() error: %v", err)
	}
	if exists {
		t.Error("exists should be false")
	}
	if hasFile {
		t.Error("hasFile should be false")
	}
}

// ============================================================
// Sonarr Tests
// ============================================================

func TestSonarrTestConnection_Success(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/system/status", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, SystemStatus{Version: "4.0.0"}))
	})

	sc := NewSonarrClient(srv.URL, "key")
	err := sc.TestConnection(context.Background())
	if err != nil {
		t.Fatalf("TestConnection() error: %v", err)
	}
}

func TestSonarrTestConnection_NotConfigured(t *testing.T) {
	sc := NewSonarrClient("", "")
	err := sc.TestConnection(context.Background())
	if err == nil {
		t.Fatal("expected error for unconfigured client")
	}
}

func TestSonarrLookupSeriesByTmdbID_Found(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/series/lookup", func(w http.ResponseWriter, r *http.Request) {
		term := r.URL.Query().Get("term")
		if term != "tmdb:1396" {
			t.Errorf("term = %q, want %q", term, "tmdb:1396")
		}
		w.Write(mustJSON(t, []SonarrLookupResult{
			{TvdbID: 81189, TmdbID: 1396, Title: "Breaking Bad", Year: 2008},
		}))
	})

	sc := NewSonarrClient(srv.URL, "key")
	result, err := sc.LookupSeriesByTmdbID(context.Background(), 1396)
	if err != nil {
		t.Fatalf("LookupSeriesByTmdbID() error: %v", err)
	}
	if result.TvdbID != 81189 {
		t.Errorf("TvdbID = %d, want 81189", result.TvdbID)
	}
	if result.Title != "Breaking Bad" {
		t.Errorf("Title = %q, want %q", result.Title, "Breaking Bad")
	}
}

func TestSonarrLookupSeriesByTmdbID_NotFound(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/series/lookup", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	})

	sc := NewSonarrClient(srv.URL, "key")
	_, err := sc.LookupSeriesByTmdbID(context.Background(), 99999)
	if err == nil {
		t.Fatal("expected error for not found")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("error should mention 'not found', got: %v", err)
	}
}

func TestSonarrAddSeries(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/series", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var series SonarrSeries
		if err := json.NewDecoder(r.Body).Decode(&series); err != nil {
			t.Fatalf("decode body: %v", err)
		}

		if series.TvdbID != 81189 {
			t.Errorf("TvdbID = %d, want 81189", series.TvdbID)
		}
		if !series.Monitored {
			t.Error("Monitored should be true")
		}
		if !series.SeasonFolder {
			t.Error("SeasonFolder should be true")
		}
		if series.AddOptions == nil || !series.AddOptions.SearchForMissingEpisodes {
			t.Error("SearchForMissingEpisodes should be true")
		}

		series.ID = 7
		w.WriteHeader(http.StatusCreated)
		w.Write(mustJSON(t, series))
	})

	sc := NewSonarrClient(srv.URL, "key")
	result, err := sc.AddSeries(context.Background(), 81189, "Breaking Bad", 2008, 1, "/tv")
	if err != nil {
		t.Fatalf("AddSeries() error: %v", err)
	}
	if result.ID != 7 {
		t.Errorf("result.ID = %d, want 7", result.ID)
	}
}

func TestSonarrGetSeries_Found(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/series", func(w http.ResponseWriter, r *http.Request) {
		tvdbID := r.URL.Query().Get("tvdbId")
		if tvdbID != "81189" {
			t.Errorf("tvdbId = %q, want %q", tvdbID, "81189")
		}
		w.Write(mustJSON(t, []SonarrSeries{
			{
				ID:     7,
				Title:  "Breaking Bad",
				TvdbID: 81189,
				Statistics: &SonarrStatistics{
					EpisodeFileCount:  62,
					TotalEpisodeCount: 62,
					PercentOfEpisodes: 100,
				},
			},
		}))
	})

	sc := NewSonarrClient(srv.URL, "key")
	series, err := sc.GetSeries(context.Background(), 81189)
	if err != nil {
		t.Fatalf("GetSeries() error: %v", err)
	}
	if series == nil {
		t.Fatal("expected series, got nil")
	}
	if series.Title != "Breaking Bad" {
		t.Errorf("Title = %q, want %q", series.Title, "Breaking Bad")
	}
}

func TestSonarrGetSeries_NotFound(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/series", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	})

	sc := NewSonarrClient(srv.URL, "key")
	series, err := sc.GetSeries(context.Background(), 99999)
	if err != nil {
		t.Fatalf("GetSeries() error: %v", err)
	}
	if series != nil {
		t.Errorf("expected nil series, got %+v", series)
	}
}

func TestSonarrSeriesExists_WithEpisodes(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/series", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, []SonarrSeries{
			{
				ID:     7,
				TvdbID: 81189,
				Statistics: &SonarrStatistics{
					EpisodeFileCount: 62,
				},
			},
		}))
	})

	sc := NewSonarrClient(srv.URL, "key")
	exists, hasEps, err := sc.SeriesExists(context.Background(), 81189)
	if err != nil {
		t.Fatalf("SeriesExists() error: %v", err)
	}
	if !exists {
		t.Error("exists should be true")
	}
	if !hasEps {
		t.Error("hasEpisodes should be true")
	}
}

func TestSonarrSeriesExists_NoEpisodes(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/series", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, []SonarrSeries{
			{
				ID:     7,
				TvdbID: 81189,
				Statistics: &SonarrStatistics{
					EpisodeFileCount: 0,
				},
			},
		}))
	})

	sc := NewSonarrClient(srv.URL, "key")
	exists, hasEps, err := sc.SeriesExists(context.Background(), 81189)
	if err != nil {
		t.Fatalf("SeriesExists() error: %v", err)
	}
	if !exists {
		t.Error("exists should be true")
	}
	if hasEps {
		t.Error("hasEpisodes should be false")
	}
}

func TestSonarrSeriesExists_NotFound(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/series", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	})

	sc := NewSonarrClient(srv.URL, "key")
	exists, hasEps, err := sc.SeriesExists(context.Background(), 99999)
	if err != nil {
		t.Fatalf("SeriesExists() error: %v", err)
	}
	if exists {
		t.Error("exists should be false")
	}
	if hasEps {
		t.Error("hasEpisodes should be false")
	}
}

func TestRadarrGetRootFolders(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/rootfolder", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, []RootFolder{
			{ID: 1, Path: "/movies"},
			{ID: 2, Path: "/movies-4k"},
		}))
	})

	rc := NewRadarrClient(srv.URL, "key")
	folders, err := rc.GetRootFolders(context.Background())
	if err != nil {
		t.Fatalf("GetRootFolders() error: %v", err)
	}
	if len(folders) != 2 {
		t.Fatalf("len(folders) = %d, want 2", len(folders))
	}
	if folders[0].Path != "/movies" {
		t.Errorf("folders[0].Path = %q, want %q", folders[0].Path, "/movies")
	}
}

func TestRadarrGetQualityProfiles(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/qualityprofile", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, []QualityProfile{
			{ID: 1, Name: "HD-1080p"},
			{ID: 4, Name: "Ultra-HD"},
		}))
	})

	rc := NewRadarrClient(srv.URL, "key")
	profiles, err := rc.GetQualityProfiles(context.Background())
	if err != nil {
		t.Fatalf("GetQualityProfiles() error: %v", err)
	}
	if len(profiles) != 2 {
		t.Fatalf("len(profiles) = %d, want 2", len(profiles))
	}
	if profiles[1].Name != "Ultra-HD" {
		t.Errorf("profiles[1].Name = %q, want %q", profiles[1].Name, "Ultra-HD")
	}
}

// ============================================================
// Queue Tests
// ============================================================

func TestRadarrGetQueue(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/queue", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, QueueResponse{
			Page: 1, PageSize: 200, TotalRecords: 2,
			Records: []QueueItem{
				{ID: 10, MovieID: 42, Title: "Test.Movie.2024.1080p", Status: "downloading",
					TrackedDownloadState: "", Size: 5000000000, Sizeleft: 2500000000,
					Timeleft: "00:30:00", Protocol: "usenet"},
				{ID: 11, MovieID: 55, Title: "Another.Movie.2024.4K", Status: "queued",
					Size: 8000000000, Sizeleft: 8000000000, Protocol: "torrent"},
			},
		}))
	})

	rc := NewRadarrClient(srv.URL, "key")
	items, err := rc.GetQueue(context.Background())
	if err != nil {
		t.Fatalf("GetQueue() error: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(items))
	}
	if items[0].MovieID != 42 {
		t.Errorf("items[0].MovieID = %d, want 42", items[0].MovieID)
	}
	if items[0].Status != "downloading" {
		t.Errorf("items[0].Status = %q, want %q", items[0].Status, "downloading")
	}
	if items[0].Protocol != "usenet" {
		t.Errorf("items[0].Protocol = %q, want %q", items[0].Protocol, "usenet")
	}
	if items[1].Status != "queued" {
		t.Errorf("items[1].Status = %q, want %q", items[1].Status, "queued")
	}
}

func TestRadarrGetQueue_NotConfigured(t *testing.T) {
	rc := NewRadarrClient("", "")
	_, err := rc.GetQueue(context.Background())
	if err == nil {
		t.Fatal("expected error for unconfigured client")
	}
}

func TestRadarrGetQueue_Empty(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/queue", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, QueueResponse{Page: 1, PageSize: 200, TotalRecords: 0, Records: []QueueItem{}}))
	})

	rc := NewRadarrClient(srv.URL, "key")
	items, err := rc.GetQueue(context.Background())
	if err != nil {
		t.Fatalf("GetQueue() error: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("len(items) = %d, want 0", len(items))
	}
}

func TestSonarrGetQueue(t *testing.T) {
	srv, mux := newTestServer(t)

	mux.HandleFunc("/api/v3/queue", func(w http.ResponseWriter, r *http.Request) {
		w.Write(mustJSON(t, QueueResponse{
			Page: 1, PageSize: 200, TotalRecords: 1,
			Records: []QueueItem{
				{ID: 20, SeriesID: 7, Title: "Test.Show.S01E01", Status: "downloading",
					TrackedDownloadState: "", Size: 1500000000, Sizeleft: 750000000,
					Timeleft: "00:10:00", Protocol: "torrent"},
			},
		}))
	})

	sc := NewSonarrClient(srv.URL, "key")
	items, err := sc.GetQueue(context.Background())
	if err != nil {
		t.Fatalf("GetQueue() error: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].SeriesID != 7 {
		t.Errorf("items[0].SeriesID = %d, want 7", items[0].SeriesID)
	}
	if items[0].Timeleft != "00:10:00" {
		t.Errorf("items[0].Timeleft = %q, want %q", items[0].Timeleft, "00:10:00")
	}
}

func TestSonarrGetQueue_NotConfigured(t *testing.T) {
	sc := NewSonarrClient("", "")
	_, err := sc.GetQueue(context.Background())
	if err == nil {
		t.Fatal("expected error for unconfigured client")
	}
}
