package metadata

import (
	"testing"
)

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
