package metadata

import (
	"bytes"
	"compress/gzip"
	"strings"
	"testing"
)

// TestDefensiveGunzip — regression coverage for the gunzip-without-
// Content-Encoding defense (commit a2fc538). The TMDB API
// occasionally returns gzip-compressed JSON without the matching
// `Content-Encoding: gzip` response header, so Go's auto-decompression
// doesn't fire and json.Unmarshal chokes on the `\x1f` magic byte.
//
// Without this test the regression risk is high — the defensive code
// only fires on a rare upstream bug, which means a future refactor
// could break it silently and we'd only notice when the WARN/error
// reappeared in production logs.
//
// Cases:
//   - valid gzip round-trips cleanly
//   - truncated gzip header → error (catches mid-stream corruption)
//   - bad CRC-32 trailer → error (catches stream-completes-but-corrupt)
//   - decompression overflow → error (no silent truncation)
//   - empty or non-gzip body → gzip.NewReader fails cleanly
func TestDefensiveGunzip(t *testing.T) {
	t.Run("valid gzip round-trips", func(t *testing.T) {
		original := []byte(`{"results":[{"id":1,"title":"Test"}]}`)
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		if _, err := gw.Write(original); err != nil {
			t.Fatalf("gzip write: %v", err)
		}
		if err := gw.Close(); err != nil {
			t.Fatalf("gzip close: %v", err)
		}
		got, err := defensiveGunzip(buf.Bytes(), 16<<20)
		if err != nil {
			t.Fatalf("defensiveGunzip: %v", err)
		}
		if !bytes.Equal(got, original) {
			t.Errorf("round-trip mismatch:\n  want: %q\n  got:  %q", original, got)
		}
	})

	t.Run("truncated gzip header errors out", func(t *testing.T) {
		// Just the magic bytes — no flags, mtime, etc.
		truncated := []byte{0x1F, 0x8B}
		_, err := defensiveGunzip(truncated, 16<<20)
		if err == nil {
			t.Fatal("expected error for truncated header, got nil")
		}
		if !strings.Contains(err.Error(), "gzip.NewReader") {
			t.Errorf("expected NewReader error context, got: %v", err)
		}
	})

	t.Run("corrupted CRC-32 trailer is rejected via Close", func(t *testing.T) {
		// Build a valid gzip then flip the last byte of the
		// 8-byte trailer (CRC + size). gz.Close() catches it
		// because io.ReadAll completes before the trailer check.
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		_, _ = gw.Write([]byte("hello"))
		_ = gw.Close()
		corrupted := buf.Bytes()
		// Flip a bit in the trailer (last 8 bytes are CRC32 + ISIZE).
		corrupted[len(corrupted)-4] ^= 0xFF
		_, err := defensiveGunzip(corrupted, 16<<20)
		if err == nil {
			t.Fatal("expected error for corrupted trailer, got nil — Close() error must be surfaced")
		}
	})

	t.Run("decompression overflow returns explicit error not silent truncation", func(t *testing.T) {
		// 64 KB of `A` compresses to a tiny gzip stream. Set the
		// cap below the decompressed size and verify we get a
		// clear error instead of a truncated body.
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		_, _ = gw.Write(bytes.Repeat([]byte("A"), 64*1024))
		_ = gw.Close()
		_, err := defensiveGunzip(buf.Bytes(), 1024) // cap < decompressed size
		if err == nil {
			t.Fatal("expected overflow error, got nil — would have silently truncated under io.LimitReader")
		}
		if !strings.Contains(err.Error(), "exceeds") {
			t.Errorf("expected overflow error message, got: %v", err)
		}
	})

	t.Run("non-gzip body fails at NewReader", func(t *testing.T) {
		// Defensive — defensiveGunzip is only called when the
		// caller already verified the gzip magic prefix, but
		// confirm it fails cleanly if invoked on non-gzip bytes.
		_, err := defensiveGunzip([]byte("not gzip"), 16<<20)
		if err == nil {
			t.Fatal("expected error for non-gzip body, got nil")
		}
	})
}

func TestMatchConfidence(t *testing.T) {
	tests := []struct {
		name         string
		scannedTitle string
		scannedYear  int
		result       TMDBMovieTV
		wantMin      int
		wantMax      int
	}{
		{
			name:         "exact title exact year",
			scannedTitle: "The Dark Knight",
			scannedYear:  2008,
			result: TMDBMovieTV{
				Title:       "The Dark Knight",
				ReleaseDate: "2008-07-18",
				Popularity:  100,
				VoteCount:   200,
			},
			wantMin: 85,
			wantMax: 100,
		},
		{
			name:         "exact title year off by 1",
			scannedTitle: "Inception",
			scannedYear:  2011,
			result: TMDBMovieTV{
				Title:       "Inception",
				ReleaseDate: "2010-07-16",
			},
			wantMin: 70,
			wantMax: 85,
		},
		{
			name:         "similar title exact year (levenshtein close)",
			scannedTitle: "The Dark Knigh",
			scannedYear:  2008,
			result: TMDBMovieTV{
				Title:       "The Dark Knight",
				ReleaseDate: "2008-07-18",
			},
			wantMin: 70,
			wantMax: 95,
		},
		{
			name:         "completely wrong title",
			scannedTitle: "Frozen",
			scannedYear:  2013,
			result: TMDBMovieTV{
				Title:       "The Dark Knight",
				ReleaseDate: "2008-07-18",
			},
			wantMin: 0,
			wantMax: 20,
		},
		{
			name:         "missing year still scores on title",
			scannedTitle: "The Matrix",
			scannedYear:  0,
			result: TMDBMovieTV{
				Title:       "The Matrix",
				ReleaseDate: "1999-03-31",
			},
			wantMin: 55,
			wantMax: 75,
		},
		{
			name:         "TV show by name field",
			scannedTitle: "Breaking Bad",
			scannedYear:  2008,
			result: TMDBMovieTV{
				Name:         "Breaking Bad",
				FirstAirDate: "2008-01-20",
				Popularity:   80,
				VoteCount:    500,
			},
			wantMin: 85,
			wantMax: 100,
		},
		{
			name:         "year off by 2",
			scannedTitle: "Avatar",
			scannedYear:  2007,
			result: TMDBMovieTV{
				Title:       "Avatar",
				ReleaseDate: "2009-12-18",
			},
			wantMin: 60,
			wantMax: 75,
		},
		{
			name:         "year off by 4 (no year bonus)",
			scannedTitle: "Avatar",
			scannedYear:  2005,
			result: TMDBMovieTV{
				Title:       "Avatar",
				ReleaseDate: "2009-12-18",
			},
			wantMin: 55,
			wantMax: 70,
		},
		{
			name:         "popularity and vote bonus",
			scannedTitle: "Avengers",
			scannedYear:  0,
			result: TMDBMovieTV{
				Title:      "Avengers",
				Popularity: 100,
				VoteCount:  500,
			},
			wantMin: 65,
			wantMax: 80,
		},
		{
			name:         "contains but not exact match",
			scannedTitle: "Batman",
			scannedYear:  0,
			result: TMDBMovieTV{
				Title: "The Batman Begins",
			},
			wantMin: 10,
			wantMax: 50,
		},
		{
			name:         "score capped at 100",
			scannedTitle: "Test",
			scannedYear:  2020,
			result: TMDBMovieTV{
				Title:       "Test",
				ReleaseDate: "2020-01-01",
				Popularity:  200,
				VoteCount:   5000,
			},
			wantMin: 90,
			wantMax: 100,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := MatchConfidence(tt.scannedTitle, tt.scannedYear, tt.result)
			if got < tt.wantMin || got > tt.wantMax {
				t.Errorf("MatchConfidence(%q, %d, %q) = %d, want in [%d, %d]",
					tt.scannedTitle, tt.scannedYear, tt.result.DisplayTitle(),
					got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestBestMatch(t *testing.T) {
	tests := []struct {
		name         string
		scannedTitle string
		scannedYear  int
		results      []TMDBMovieTV
		wantTitle    string
		wantNil      bool
	}{
		{
			name:         "picks highest scoring result",
			scannedTitle: "The Dark Knight",
			scannedYear:  2008,
			results: []TMDBMovieTV{
				{Title: "The Dark Knight Rises", ReleaseDate: "2012-07-20"},
				{Title: "The Dark Knight", ReleaseDate: "2008-07-18", Popularity: 80, VoteCount: 200},
				{Title: "Dark Knight", ReleaseDate: "2001-01-01"},
			},
			wantTitle: "The Dark Knight",
			wantNil:   false,
		},
		{
			name:         "returns nil below threshold 50",
			scannedTitle: "Completely Random Title",
			scannedYear:  2023,
			results: []TMDBMovieTV{
				{Title: "ZZZZZZZ", ReleaseDate: "1950-01-01"},
				{Title: "YYYYYYY", ReleaseDate: "1960-01-01"},
			},
			wantTitle: "",
			wantNil:   true,
		},
		{
			name:         "empty results",
			scannedTitle: "Anything",
			scannedYear:  2020,
			results:      []TMDBMovieTV{},
			wantTitle:    "",
			wantNil:      true,
		},
		{
			name:         "nil results",
			scannedTitle: "Anything",
			scannedYear:  2020,
			results:      nil,
			wantTitle:    "",
			wantNil:      true,
		},
		{
			name:         "single result above threshold",
			scannedTitle: "Inception",
			scannedYear:  2010,
			results: []TMDBMovieTV{
				{Title: "Inception", ReleaseDate: "2010-07-16", Popularity: 80, VoteCount: 200},
			},
			wantTitle: "Inception",
			wantNil:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, score := BestMatch(tt.scannedTitle, tt.scannedYear, tt.results, 50)
			if tt.wantNil {
				if got != nil {
					t.Errorf("BestMatch() returned non-nil result %q (score %d), want nil",
						got.DisplayTitle(), score)
				}
			} else {
				if got == nil {
					t.Fatalf("BestMatch() returned nil, want %q", tt.wantTitle)
				}
				if got.DisplayTitle() != tt.wantTitle {
					t.Errorf("BestMatch() title = %q, want %q (score %d)",
						got.DisplayTitle(), tt.wantTitle, score)
				}
				if score < 50 {
					t.Errorf("BestMatch() score = %d, want >= 50", score)
				}
			}
		})
	}
}

func TestTMDBMovieTV_DisplayTitle(t *testing.T) {
	tests := []struct {
		name   string
		result TMDBMovieTV
		want   string
	}{
		{name: "movie title", result: TMDBMovieTV{Title: "Inception"}, want: "Inception"},
		{name: "tv name", result: TMDBMovieTV{Name: "Breaking Bad"}, want: "Breaking Bad"},
		{name: "title takes precedence", result: TMDBMovieTV{Title: "Movie", Name: "TV"}, want: "Movie"},
		{name: "both empty", result: TMDBMovieTV{}, want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.result.DisplayTitle()
			if got != tt.want {
				t.Errorf("DisplayTitle() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTMDBMovieTV_Year(t *testing.T) {
	tests := []struct {
		name   string
		result TMDBMovieTV
		want   int
	}{
		{name: "release date", result: TMDBMovieTV{ReleaseDate: "2008-07-18"}, want: 2008},
		{name: "first air date", result: TMDBMovieTV{FirstAirDate: "2019-11-12"}, want: 2019},
		{name: "release date takes precedence", result: TMDBMovieTV{ReleaseDate: "2020-01-01", FirstAirDate: "2019-01-01"}, want: 2020},
		{name: "empty dates", result: TMDBMovieTV{}, want: 0},
		{name: "short date string", result: TMDBMovieTV{ReleaseDate: "20"}, want: 0},
		{name: "just year", result: TMDBMovieTV{ReleaseDate: "2024"}, want: 2024},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.result.Year()
			if got != tt.want {
				t.Errorf("Year() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestImageURL(t *testing.T) {
	tests := []struct {
		name string
		path string
		size string
		want string
	}{
		{
			name: "poster medium",
			path: "/abcdef.jpg",
			size: PosterMedium,
			want: "https://image.tmdb.org/t/p/w342/abcdef.jpg",
		},
		{
			name: "backdrop large",
			path: "/backdrop.jpg",
			size: BackdropLarge,
			want: "https://image.tmdb.org/t/p/w1280/backdrop.jpg",
		},
		{
			name: "empty path",
			path: "",
			size: PosterMedium,
			want: "",
		},
		{
			name: "original size",
			path: "/image.jpg",
			size: PosterOriginal,
			want: "https://image.tmdb.org/t/p/original/image.jpg",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ImageURL(tt.path, tt.size)
			if got != tt.want {
				t.Errorf("ImageURL(%q, %q) = %q, want %q", tt.path, tt.size, got, tt.want)
			}
		})
	}
}
